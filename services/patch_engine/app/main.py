from __future__ import annotations

import contextvars
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import pty
import queue
import select
import signal
import struct
import subprocess
import termios
import threading
import time
import urllib.error
import urllib.request
import uuid
from functools import lru_cache
from dataclasses import dataclass
from typing import Any, Literal

from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


# -----------------------
# Settings / paths
# -----------------------


def _truthy(v: Any) -> bool:
    s = str(v or "").strip().lower()
    return s in ("1", "true", "yes", "on")


def _parse_allowlist(env_value: Any, fallback: list[str]) -> list[str]:
    raw = str(env_value or "").strip()
    if not raw:
        return [p.replace("\\", "/") for p in fallback]
    return [p.strip().replace("\\", "/") for p in raw.split(",") if p.strip()]


ROOT = os.path.abspath(os.environ.get("SAW_REPO_ROOT") or os.getcwd())
SAW_DIR = os.path.join(ROOT, ".saw")

PATCH_APPLY_ALLOWLIST = _parse_allowlist(os.environ.get("SAW_PATCH_APPLY_ALLOWLIST"), ["saw-workspace/"])
CAPS_PATH = os.path.join(SAW_DIR, "caps.json")
SESSION_LOG = os.path.join(SAW_DIR, "session.ndjson")
RECOVERY_PATH = os.path.join(SAW_DIR, "recovery.json")


@lru_cache(maxsize=1)
def _stock_plugin_ids() -> set[str]:
    """
    Detect stock (locked) plugin ids by scanning the SAW API canonical directory:
      services/saw_api/app/stock_plugins/<plugin_id>/plugin.yaml

    Note: Patch Engine is intentionally YAML-free; we treat folder names as ids.
    """
    root = os.path.join(ROOT, "services", "saw_api", "app", "stock_plugins")
    out: set[str] = set()
    try:
        for ent in os.listdir(root):
            if ent.startswith("."):
                continue
            pdir = os.path.join(root, ent)
            if not os.path.isdir(pdir):
                continue
            if os.path.isfile(os.path.join(pdir, "plugin.yaml")):
                out.add(ent)
    except Exception:
        return set()
    return out


def _locked_plugin_id_for_rel_path(rel_path: str) -> str | None:
    p = str(rel_path or "").replace("\\", "/")
    if not p.startswith("saw-workspace/plugins/"):
        return None
    parts = [x for x in p.split("/") if x]
    # saw-workspace/plugins/<plugin_id>/...
    if len(parts) < 3:
        return None
    pid = parts[2]
    return pid if pid in _stock_plugin_ids() else None


def _guard_locked_plugin_write(rel_path: str, op: str) -> None:
    if _truthy(os.environ.get("SAW_ALLOW_WRITE_LOCKED_PLUGINS", "0")):
        return
    pid = _locked_plugin_id_for_rel_path(rel_path)
    if not pid:
        return
    append_session({"type": "locked_plugin.block", "path": rel_path, "plugin_id": pid, "op": op})
    raise HTTPException(
        status_code=403,
        detail={
            "error": "locked_plugin",
            "op": op,
            "path": rel_path,
            "plugin_id": pid,
            "hint": "Set SAW_ALLOW_WRITE_LOCKED_PLUGINS=1 to override (power users only).",
        },
    )

# Debug-mode forensic log.
# IMPORTANT: default to a gitignored location under .saw/ so we don't dirty the repo and break stashing.
DEBUG_LOG_PATH = os.environ.get("SAW_PATCH_ENGINE_DEBUG_LOG_PATH") or os.path.join(SAW_DIR, "debug.ndjson")
_REQ_ID: contextvars.ContextVar[str] = contextvars.ContextVar("saw_req_id", default="")

SAW_PATCH_ENGINE_USE_STASH = _truthy(os.environ.get("SAW_PATCH_ENGINE_USE_STASH", "0"))

SAW_ENABLE_TERMINAL = _truthy(os.environ.get("SAW_ENABLE_TERMINAL", "0"))
SAW_TERMINAL_ROOT = str(os.environ.get("SAW_TERMINAL_ROOT") or "saw-workspace/sandbox").replace("\\", "/")

# Safety: avoid loading huge files into memory via dev_file.
DEV_FILE_MAX_BYTES = int(os.environ.get("SAW_DEV_FILE_MAX_BYTES") or 2_000_000)
DEV_FILE_HEAD_MAX_LINES = 40

_PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


def _ts_pacific(ms: int) -> str:
    # ISO-8601 with numeric offset, in America/Los_Angeles (PST/PDT).
    return datetime.fromtimestamp(ms / 1000.0, tz=_PACIFIC_TZ).isoformat(timespec="seconds")

def _dbg(hypothesisId: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    # Keep tiny + never log secrets.
    try:
        os.makedirs(SAW_DIR, exist_ok=True)
        ts = int(time.time() * 1000)
        payload = {
            "sessionId": "debug-session",
            "runId": "pre-fix",
            "hypothesisId": hypothesisId,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": ts,
            "timestamp_pacific": _ts_pacific(ts),
        }
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass

# Validation policy:
# - strict: always run npm build on any safe op
# - auto: run npm build only if patch touches "shell" paths (e.g. src/); skip for workspace-only ops
VALIDATION_MODE: Literal["strict", "auto"] = str(os.environ.get("SAW_PATCH_ENGINE_VALIDATION_MODE") or "auto").strip().lower()  # type: ignore[assignment]
SHELL_PATH_PREFIXES = _parse_allowlist(os.environ.get("SAW_PATCH_ENGINE_SHELL_PREFIXES"), ["src/", "services/", "vite.config.ts", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.*", "tailwind.config.ts", "postcss.config.cjs"])


# -----------------------
# Models
# -----------------------


class CapsRule(BaseModel):
    path: str
    r: bool
    w: bool
    d: bool


class CapsManifest(BaseModel):
    version: Literal[1] = 1
    updatedAt: int
    rules: list[CapsRule] = Field(default_factory=list)


class DevTreeNode(BaseModel):
    type: Literal["dir", "file"]
    name: str
    path: str
    children: list["DevTreeNode"] = Field(default_factory=list)


DevTreeNode.model_rebuild()


class SafeWriteRequest(BaseModel):
    path: str
    content: str


class SafeDeleteRequest(BaseModel):
    path: str


class ApplyPatchRequest(BaseModel):
    patch: str


class GitCommitRequest(BaseModel):
    message: str


# Avoid committing runtime artifacts that can change during safe operations.
GIT_COMMIT_EXCLUDE_PATHSPECS: list[str] = [
    ":(exclude).cursor/debug.log",
    ":(exclude).saw/**",
    ":(exclude)**/__pycache__/**",
    ":(exclude)**/*.pyc",
    ":(exclude)**/*.pyo",
]


# -----------------------
# Helpers: session + recovery + caps
# -----------------------


def _ensure_saw_dir() -> None:
    os.makedirs(SAW_DIR, exist_ok=True)


def append_session(event: dict[str, Any]) -> None:
    try:
        _ensure_saw_dir()
        ts = int(time.time() * 1000)
        line = json.dumps({"ts": ts, "ts_pacific": _ts_pacific(ts), **(event or {})}, ensure_ascii=False) + "\n"
        with open(SESSION_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def read_session_tail(max_lines: int) -> str:
    try:
        raw = open(SESSION_LOG, "r", encoding="utf-8").read()
        lines = raw.strip().split("\n") if raw.strip() else []
        return "\n".join(lines[max(0, len(lines) - max_lines) :])
    except Exception:
        return ""


def write_recovery(data: dict[str, Any]) -> None:
    _ensure_saw_dir()
    with open(RECOVERY_PATH, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False))


def clear_recovery() -> None:
    try:
        _ensure_saw_dir()
        with open(RECOVERY_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps({"inProgress": False, "updatedAt": int(time.time() * 1000)}, ensure_ascii=False))
    except Exception:
        pass


def load_caps() -> CapsManifest:
    try:
        raw = open(CAPS_PATH, "r", encoding="utf-8").read()
        j = json.loads(raw or "{}")
        m = CapsManifest.model_validate(j)
        if m.version == 1:
            return m
    except Exception:
        pass
    return CapsManifest(updatedAt=int(time.time() * 1000), rules=[])


def save_caps(m: CapsManifest) -> None:
    _ensure_saw_dir()
    with open(CAPS_PATH, "w", encoding="utf-8") as f:
        f.write(m.model_dump_json())


def _norm_caps_path(p: str) -> str:
    s = str(p or "").replace("\\", "/").strip()
    if s in (".", "./"):
        return "."
    # Normalize leading ./ to keep rules deterministic.
    if s.startswith("./"):
        s = s[2:]
    # Collapse duplicate slashes.
    while "//" in s:
        s = s.replace("//", "/")
    return s


def get_caps_for_path(m: CapsManifest, rel: str) -> CapsRule:
    # Default: readable, not writable/deletable.
    default = CapsRule(path="*", r=True, w=False, d=False)
    p = _norm_caps_path(rel)
    best: CapsRule | None = None
    best_len = -1
    best_idx = -1
    for i, rule in enumerate(m.rules):
        rp = _norm_caps_path(rule.path)
        if not rp:
            continue

        # Root rule matches everything but should lose to more specific rules.
        if rp == ".":
            match_len = 0
            if (match_len > best_len) or (match_len == best_len and i > best_idx):
                best = rule
                best_len = match_len
                best_idx = i
            continue

        # Directory prefixes.
        if rp.endswith("/"):
            if p.startswith(rp):
                match_len = len(rp)
                if (match_len > best_len) or (match_len == best_len and i > best_idx):
                    best = rule
                    best_len = match_len
                    best_idx = i
            continue

        # Exact file/path match.
        if p == rp:
            match_len = len(rp)
            if (match_len > best_len) or (match_len == best_len and i > best_idx):
                best = rule
                best_len = match_len
                best_idx = i

    return best or default


def _caps_conflicts(m: CapsManifest) -> list[dict[str, Any]]:
    """Best-effort overlap/conflict detector for caps rules."""
    conflicts: list[dict[str, Any]] = []
    by_norm: dict[str, list[CapsRule]] = {}
    for r in m.rules:
        by_norm.setdefault(_norm_caps_path(r.path), []).append(r)

    # Duplicate normalized paths with different perms.
    for k, rules in by_norm.items():
        if len(rules) <= 1:
            continue
        perms = {(bool(r.r), bool(r.w), bool(r.d)) for r in rules}
        if len(perms) > 1:
            conflicts.append(
                {
                    "type": "duplicate_path",
                    "path": k,
                    "rules": [rr.model_dump() for rr in rules],
                    "message": "Multiple rules normalize to the same path with different permissions",
                }
            )

    # Specific ambiguity: both '.' and './' present (even if perms match).
    raw_paths = {str(r.path or "") for r in m.rules}
    if ("." in raw_paths) and ("./" in raw_paths):
        conflicts.append(
            {
                "type": "dot_vs_dot_slash",
                "paths": [".", "./"],
                "message": "Both '.' and './' exist; normalization removes this ambiguity",
            }
        )

    return conflicts


# -----------------------
# Helpers: FS safety
# -----------------------


@dataclass(frozen=True)
class ResolveOk:
    ok: Literal[True] = True
    abs: str = ""


@dataclass(frozen=True)
class ResolveErr:
    ok: Literal[False] = False
    reason: str = ""


def safe_resolve(root: str, rel_path: str) -> ResolveOk | ResolveErr:
    p = str(rel_path or "").replace("\\", "/")
    if (not p) or ("\0" in p) or p.startswith("..") or "/../" in p:
        return ResolveErr(reason="bad_path")
    if p.startswith(".git/") or "/.git/" in p:
        return ResolveErr(reason="blocked_git")
    if p.startswith("node_modules/") or "/node_modules/" in p:
        return ResolveErr(reason="blocked_node_modules")
    if p.startswith("dist/") or "/dist/" in p:
        return ResolveErr(reason="blocked_dist")
    if p == ".env" or p.startswith(".env."):
        return ResolveErr(reason="blocked_env")
    if p.startswith(".npm-cache/") or "/.npm-cache/" in p:
        return ResolveErr(reason="blocked_cache")

    abs_path = os.path.abspath(os.path.join(root, p))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        return ResolveErr(reason="outside_root")
    return ResolveOk(abs=abs_path)


def is_blocked_for_tree(rel_path: str) -> bool:
    p = (rel_path or "").replace("\\", "/")
    return (
        p == ".git"
        or p.startswith(".git/")
        or p == "node_modules"
        or p.startswith("node_modules/")
        or p == "dist"
        or p.startswith("dist/")
        or p == ".npm-cache"
        or p.startswith(".npm-cache/")
        or p == ".env"
        or p.startswith(".env.")
    )


def is_allowed_by_prefixes(rel_path: str, allowlist: list[str]) -> bool:
    p = (rel_path or "").replace("\\", "/")
    for prefix in allowlist:
        pr = (prefix or "").replace("\\", "/")
        if pr in (".", "./"):
            return True
        if pr.endswith("/"):
            if p.startswith(pr):
                return True
            continue
        if p == pr or p.startswith(pr + "/"):
            return True
    return False


def read_tree(root_abs: str, rel: str, depth: int, max_entries: int) -> DevTreeNode:
    abs_dir = os.path.abspath(os.path.join(root_abs, rel or "."))
    root_resolved = os.path.abspath(root_abs)
    if not abs_dir.startswith(root_resolved):
        return DevTreeNode(type="dir", name=".", path=rel or ".", children=[])

    name = os.path.basename((rel or ".").replace("\\", "/")) if rel and rel != "." else "."
    node = DevTreeNode(type="dir", name=name, path=rel or ".", children=[])
    if depth <= 0:
        return node

    try:
        entries = list(os.scandir(abs_dir))
    except Exception:
        return node

    children: list[DevTreeNode] = []
    count = 0
    for e in entries:
        if count >= max_entries:
            break
        try:
            child_rel = (rel + "/" + e.name) if rel and rel != "." else e.name
            child_rel = child_rel.replace("\\", "/")
            if e.is_dir(follow_symlinks=False):
                if is_blocked_for_tree(child_rel):
                    continue
                children.append(read_tree(root_abs, child_rel, depth - 1, max_entries))
            else:
                children.append(DevTreeNode(type="file", name=e.name, path=child_rel, children=[]))
            count += 1
        except Exception:
            continue

    # Stable sort: dirs first then name.
    children.sort(key=lambda c: (0 if c.type == "dir" else 1, c.name))
    node.children = children
    return node


def read_tree_with_meta(root_abs: str, rel: str, depth: int, max_entries: int) -> tuple[DevTreeNode, bool]:
    """Return (tree, truncated) where truncated means we hit max_entries in any scanned directory."""
    abs_dir = os.path.abspath(os.path.join(root_abs, rel or "."))
    root_resolved = os.path.abspath(root_abs)
    if not abs_dir.startswith(root_resolved):
        return DevTreeNode(type="dir", name=".", path=rel or ".", children=[]), False

    name = os.path.basename((rel or ".").replace("\\", "/")) if rel and rel != "." else "."
    node = DevTreeNode(type="dir", name=name, path=rel or ".", children=[])
    if depth <= 0:
        return node, False

    try:
        entries = list(os.scandir(abs_dir))
    except Exception:
        return node, False

    children: list[DevTreeNode] = []
    count = 0
    truncated_here = False
    truncated_any = False
    for e in entries:
        if count >= max_entries:
            truncated_here = True
            break
        try:
            child_rel = (rel + "/" + e.name) if rel and rel != "." else e.name
            child_rel = child_rel.replace("\\", "/")
            if e.is_dir(follow_symlinks=False):
                if is_blocked_for_tree(child_rel):
                    continue
                child_node, child_truncated = read_tree_with_meta(root_abs, child_rel, depth - 1, max_entries)
                children.append(child_node)
                truncated_any = truncated_any or child_truncated
            else:
                children.append(DevTreeNode(type="file", name=e.name, path=child_rel, children=[]))
            count += 1
        except Exception:
            continue

    # Stable sort: dirs first then name.
    children.sort(key=lambda c: (0 if c.type == "dir" else 1, c.name))
    node.children = children
    return node, (truncated_here or truncated_any)


def _head_40_lines(text: str) -> str:
    # Preserve newlines (splitlines(True) keeps line endings).
    if not text:
        return ""
    lines = text.splitlines(True)
    return "".join(lines[:DEV_FILE_HEAD_MAX_LINES])


def _dev_error(code: str, message: str, detail: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"code": code, "message": message}
    if detail:
        out["detail"] = detail
    return out


# -----------------------
# Helpers: git + validation
# -----------------------


def _run_cmd(cmd: list[str], *, cwd: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    started = time.time()
    req_id = _REQ_ID.get() or ""
    # #region agent log
    _dbg("H_route", "services/patch_engine/app/main.py:_run_cmd", "proc.start", {"req_id": req_id, "cmd": cmd, "cwd": cwd})
    # #endregion
    try:
        append_session({"type": "proc.start", "req_id": req_id, "cmd": cmd, "cwd": cwd})
    except Exception:
        pass
    r = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    dur_ms = int(max(0.0, (time.time() - started) * 1000.0))
    # Best-effort: log every subprocess (trim outputs)
    try:
        append_session(
            {
                "type": "proc.end",
                "req_id": req_id,
                "cmd": cmd,
                "cwd": cwd,
                "rc": int(r.returncode),
                "duration_ms": dur_ms,
                "stdout": (r.stdout or "")[:2000],
                "stderr": (r.stderr or "")[:2000],
            }
        )
    except Exception:
        pass
    # #region agent log
    _dbg(
        "H_route",
        "services/patch_engine/app/main.py:_run_cmd",
        "proc.end",
        {"req_id": req_id, "rc": int(r.returncode), "duration_ms": dur_ms, "cmd0": (cmd[0] if cmd else ""), "stderr_head": (r.stderr or "")[:200]},
    )
    # #endregion
    return r


def run_git(args: list[str]) -> dict[str, str]:
    r = _run_cmd(["git", *args], cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or f"git_failed rc={r.returncode}").strip())
    return {"stdout": r.stdout or "", "stderr": r.stderr or ""}


def run_git_allow_fail(args: list[str]) -> dict[str, Any]:
    r = _run_cmd(["git", *args], cwd=ROOT)
    if r.returncode == 0:
        return {"ok": True, "stdout": r.stdout or "", "stderr": r.stderr or ""}
    return {
        "ok": False,
        "stdout": r.stdout or "",
        "stderr": r.stderr or "",
        "message": (r.stderr or r.stdout or f"git_failed rc={r.returncode}").strip(),
    }


def git_head() -> str:
    return run_git(["rev-parse", "HEAD"])["stdout"].strip()


def git_branch() -> str:
    # Empty string in detached HEAD is expected.
    return run_git_allow_fail(["branch", "--show-current"]).get("stdout", "").strip()


def git_dirty() -> str:
    return run_git(["status", "--porcelain"])["stdout"].strip()


def git_dirty_paths() -> list[str]:
    """
    Parse `git status --porcelain` into relative paths.
    We use this to avoid stashing when dirtiness doesn't overlap the patch/write target.
    """
    out = run_git(["status", "--porcelain"])["stdout"]
    paths: list[str] = []
    for ln in (out or "").splitlines():
        s = ln.strip("\n")
        if not s:
            continue
        # Format: XY <path>  OR  XY <old> -> <new>
        if " -> " in s:
            s = s.split(" -> ", 1)[1]
        # Strip leading status columns (best-effort).
        if len(s) >= 3 and s[1] in (" ", "M", "A", "D", "R", "C", "U", "?") and s[2] == " ":
            s = s[3:]
        elif len(s) >= 2 and s[0] in ("M", "A", "D", "R", "C", "U", "?") and s[1] == " ":
            s = s[2:]
        s = s.strip().replace("\\", "/")
        if s:
            paths.append(s)
    return paths


def _dirty_overlaps_targets(*, dirty_paths: list[str], targets: list[str]) -> bool:
    tp = {str(t or "").replace("\\", "/") for t in (targets or []) if str(t or "").strip()}
    if not tp:
        return False
    for dp in dirty_paths:
        p = str(dp or "").replace("\\", "/")
        if not p:
            continue
        if p in tp:
            return True
        # If a dir is dirty and patch touches inside (or vice versa)
        for t in tp:
            if t.endswith("/") and p.startswith(t):
                return True
            if p.endswith("/") and t.startswith(p):
                return True
            if (p + "/") and t.startswith(p + "/"):
                return True
            if (t + "/") and p.startswith(t + "/"):
                return True
    return False


def _dirty_overlap_list(*, dirty_paths: list[str], targets: list[str]) -> list[str]:
    tp = {str(t or "").replace("\\", "/") for t in (targets or []) if str(t or "").strip()}
    overlaps: list[str] = []
    if not tp:
        return overlaps
    for dp in dirty_paths:
        p = str(dp or "").replace("\\", "/")
        if not p:
            continue
        if p in tp:
            overlaps.append(p)
            continue
        for t in tp:
            if t and (p.startswith(t + "/") or t.startswith(p + "/")):
                overlaps.append(p)
                break
    # stable unique
    seen: set[str] = set()
    out: list[str] = []
    for p in overlaps:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out

def git_stash_push() -> str:
    # IMPORTANT: do NOT stash untracked files (-u). Untracked workspace files (like saw-workspace/todo.md)
    # may be exactly what the patch is about, and stashing them will make `git apply --check` fail with
    # "No such file or directory".
    run_git(["stash", "push", "-m", "saw:auto-pre"])
    return run_git(["rev-parse", "refs/stash"])["stdout"].strip()


def git_stash_pop() -> dict[str, str]:
    return run_git(["stash", "pop"])


def rollback_to(head: str) -> None:
    run_git(["reset", "--hard", head])
    # IMPORTANT: do NOT run `git clean -fd` here.
    # It can delete untracked workspace files (e.g. saw-workspace/todo.md) and cause confusing regressions.
    # If a patch creates untracked files and later fails validation, those may remain; that's preferable to
    # deleting user workspace content in dev.


def validate_project() -> tuple[bool, str]:
    env = dict(os.environ)
    env["npm_config_cache"] = os.path.join(ROOT, ".npm-cache")
    r = _run_cmd(["npm", "run", "build"], cwd=ROOT, env=env)
    if r.returncode == 0:
        return True, ""
    out = (r.stdout or "") + "\n" + (r.stderr or "")
    return False, out.strip()


def _should_validate(*, touched_paths: list[str]) -> bool:
    if VALIDATION_MODE == "strict":
        return True
    # auto: only validate if we touched likely shell paths
    for p in touched_paths:
        if is_allowed_by_prefixes(p, SHELL_PATH_PREFIXES):
            return True
    return False


def parse_patch_touched(patch: str) -> dict[str, list[str]]:
    touched: set[str] = set()
    deleted: set[str] = set()
    added: set[str] = set()
    lines = (patch or "").split("\n")

    for ln in lines:
        m1 = _re_match(r"^\+\+\+\s+b\/(.+)$", ln)
        m2 = _re_match(r"^---\s+a\/(.+)$", ln)
        m3 = _re_match(r"^diff --git a\/(.+)\s+b\/(.+)$", ln)
        if m3:
            touched.add(m3[2])
        if m1 and m1[1] != "/dev/null":
            touched.add(m1[1])
        if m2 and m2[1] != "/dev/null":
            touched.add(m2[1])

    # Heuristic: detect /dev/null markers near diff headers
    for i in range(len(lines)):
        dm = _re_match(r"^diff --git a\/(.+)\s+b\/(.+)$", lines[i])
        if not dm:
            continue
        a = dm[1]
        b = dm[2]
        next1 = lines[i + 1] if i + 1 < len(lines) else ""
        next2 = lines[i + 2] if i + 2 < len(lines) else ""
        header = next1 + "\n" + next2
        if ("--- a/" in header) and ("+++ /dev/null" in header):
            deleted.add(a)
        if ("--- /dev/null" in header) and ("+++ b/" in header):
            added.add(b)

    return {"touched": sorted(touched), "deleted": sorted(deleted), "added": sorted(added)}


def _normalize_new_file_blocks(patch: str) -> str:
    """
    Best-effort fix for diffs that *intend* to create a new file but don't use /dev/null headers.

    Common model output:
      diff --git a/foo b/foo
      index e69de29..abcd 100644
      --- a/foo
      +++ b/foo

    If foo doesn't exist on disk, git apply will reject it unless it's expressed as a new-file diff.
    """
    if not patch.strip():
        return patch

    lines = patch.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if not ln.startswith("diff --git "):
            out.append(ln)
            i += 1
            continue

        # Collect one diff block.
        block: list[str] = [ln]
        i += 1
        while i < len(lines) and not lines[i].startswith("diff --git "):
            block.append(lines[i])
            i += 1

        # Parse path from header.
        import re

        m = re.match(r"^diff --git a/(.+)\s+b/(.+)$", block[0])
        rel_path = m.group(2) if m else ""
        rel_path = rel_path.replace("\\", "/")
        abs_path = os.path.join(ROOT, rel_path) if rel_path else ""
        exists = bool(rel_path) and os.path.exists(abs_path)

        has_new_file_mode = any(b.startswith("new file mode ") for b in block)
        has_dev_null = any(b.strip() == "--- /dev/null" for b in block) and any(b.strip().startswith("+++ b/") for b in block)
        looks_like_empty_base = any(b.startswith("index e69de29..") for b in block)

        if (not exists) and (not has_new_file_mode) and (not has_dev_null) and rel_path:
            # Rewrite to proper new-file semantics.
            rewritten: list[str] = []
            for b in block:
                if b.startswith("index "):
                    mm = re.match(r"^index\s+([0-9a-f]+)\.\.([0-9a-f]+)(\s+\d+)?$", b.strip())
                    if mm:
                        new_hash = mm.group(2)
                        mode = mm.group(3) or ""
                        rewritten.append(f"index 0000000..{new_hash}{mode}".rstrip())
                        continue
                if b.startswith("--- a/"):
                    rewritten.append("--- /dev/null")
                    continue
                rewritten.append(b)

            # Ensure new file mode exists right after diff --git
            if not any(x.startswith("new file mode ") for x in rewritten):
                rewritten.insert(1, "new file mode 100644")

            # Ensure +++ b/<path> is present (keep existing if any)
            # (No-op if already present.)
            out.extend(rewritten)
            append_session(
                {
                    "type": "patch.normalize_new_file",
                    "path": rel_path,
                    "reason": "missing_dev_null_headers",
                    "hint": "rewrote --- a/<path> to --- /dev/null and added new file mode",
                }
            )
        else:
            out.extend(block)

    return "\n".join(out)


def _strip_index_lines(patch: str) -> str:
    """
    Strip `index <old>..<new> <mode>` lines.

    Models often hallucinate index hashes (e.g. e69de29..d95f3a3) which are not required for `git apply`
    and can contribute to confusing failures/debugging. `git apply` does not need them.
    """
    if not patch:
        return patch
    out: list[str] = []
    for ln in patch.split("\n"):
        if ln.startswith("index ") and ".." in ln:
            continue
        out.append(ln)
    return "\n".join(out)


def _re_match(pattern: str, text: str) -> dict[int, str] | None:
    # micro regex helper to avoid importing re at module scope in huge services
    import re

    m = re.match(pattern, text)
    if not m:
        return None
    # 1-indexed groups so callers can use m[1], m[2], ...
    return {i: (g or "") for i, g in enumerate(m.groups(), start=1)}


# -----------------------
# App
# -----------------------


app = FastAPI(title="SAW Patch Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _request_log_middleware(request: Request, call_next):
    started = time.time()
    req_id = uuid.uuid4().hex[:12]
    token = _REQ_ID.set(req_id)
    try:
        response = await call_next(request)
        return response
    finally:
        _REQ_ID.reset(token)
        dur_ms = int(max(0.0, (time.time() - started) * 1000.0))
        try:
            append_session(
                {
                    "type": "http",
                    "req_id": req_id,
                    "method": request.method,
                    "path": request.url.path,
                    "query": str(request.url.query),
                    "duration_ms": dur_ms,
                }
            )
        except Exception:
            pass
        # #region agent log
        _dbg(
            "H_route",
            "services/patch_engine/app/main.py:_request_log_middleware",
            "http",
            {"req_id": req_id, "method": request.method, "path": request.url.path, "query": str(request.url.query), "duration_ms": dur_ms},
        )
        # #endregion


@app.on_event("startup")
def _startup() -> None:
    # Crash recovery: if a previous safe-apply crashed mid-flight, restore last-good.
    try:
        raw = open(RECOVERY_PATH, "r", encoding="utf-8").read()
        j = json.loads(raw or "{}")
        if j.get("inProgress") and isinstance(j.get("preHead"), str) and j["preHead"]:
            rollback_to(str(j["preHead"]))
            append_session({"type": "recovery.rollback", "preHead": str(j["preHead"]), "op": j.get("op") or "unknown"})
            if j.get("hadStash") and isinstance(j.get("stashRef"), str) and j["stashRef"]:
                try:
                    git_stash_pop()
                    append_session({"type": "recovery.stash.pop", "stashRef": str(j["stashRef"])})
                except Exception as e:
                    append_session({"type": "recovery.stash.pop_failed", "error": str(e)[:2000]})
        clear_recovery()
    except Exception:
        pass


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "repo_root": ROOT, "allowlist": PATCH_APPLY_ALLOWLIST}


@app.get("/api/dev/flags")
def dev_flags() -> dict[str, Any]:
    return {
        "SAW_ENABLE_PATCH_ENGINE": _truthy(os.environ.get("SAW_ENABLE_PATCH_ENGINE", "1")),
        "SAW_ENABLE_DB": _truthy(os.environ.get("SAW_ENABLE_DB", "1")),
        "SAW_ENABLE_PLUGINS": _truthy(os.environ.get("SAW_ENABLE_PLUGINS", "1")),
        "SAW_ENABLE_TERMINAL": SAW_ENABLE_TERMINAL,
    }


# -----------------------
# Dev: terminal (local sandbox)
# -----------------------


@dataclass
class _TerminalSession:
    session_id: str
    pid: int
    master_fd: int
    cwd_rel: str
    created_at_ms: int
    q: "queue.Queue[dict[str, Any]]"
    closed: bool = False


_TERMINAL_SESSIONS: dict[str, _TerminalSession] = {}
_TERMINAL_LOCK = threading.Lock()


def _term_require_enabled() -> None:
    if not SAW_ENABLE_TERMINAL:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "terminal_disabled",
                "hint": "Set SAW_ENABLE_TERMINAL=1 and restart Patch Engine.",
            },
        )


def _term_root_abs() -> str:
    resolved = safe_resolve(ROOT, SAW_TERMINAL_ROOT)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_terminal_root", "reason": resolved.reason})
    return resolved.abs


def _term_cwd_abs(cwd_rel: str | None) -> tuple[str, str]:
    root_abs = _term_root_abs()
    root_abs_norm = os.path.abspath(root_abs)

    requested_rel = str(cwd_rel or SAW_TERMINAL_ROOT).replace("\\", "/")
    resolved = safe_resolve(ROOT, requested_rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_cwd", "reason": resolved.reason})

    cwd_abs = os.path.abspath(resolved.abs)
    try:
        common = os.path.commonpath([root_abs_norm, cwd_abs])
    except Exception:
        common = ""
    if common != root_abs_norm:
        raise HTTPException(status_code=403, detail={"error": "cwd_outside_terminal_root", "cwd": requested_rel, "root": SAW_TERMINAL_ROOT})
    return requested_rel, cwd_abs


def _term_set_winsize(fd: int, cols: int, rows: int) -> None:
    cols_n = max(20, min(400, int(cols)))
    rows_n = max(5, min(200, int(rows)))
    buf = struct.pack("HHHH", rows_n, cols_n, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, buf)


def _term_reader_thread(sess: _TerminalSession) -> None:
    pid = sess.pid
    fd = sess.master_fd
    q = sess.q
    append_session({"type": "term.open", "session_id": sess.session_id, "cwd": sess.cwd_rel})

    exit_code: int | None = None
    try:
        while True:
            if sess.closed:
                break

            # Prefer reading from PTY when data is available.
            try:
                r, _, _ = select.select([fd], [], [], 0.25)
            except Exception:
                r = []
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    q.put({"type": "stdout", "data": chunk.decode("utf-8", errors="ignore")})

            # Poll for process exit.
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    if os.WIFEXITED(status):
                        exit_code = int(os.WEXITSTATUS(status))
                    elif os.WIFSIGNALED(status):
                        exit_code = 128 + int(os.WTERMSIG(status))
                    else:
                        exit_code = 0
                    break
            except ChildProcessError:
                exit_code = exit_code if exit_code is not None else 0
                break
            except Exception:
                pass
    finally:
        q.put({"type": "exit", "code": exit_code})
        append_session({"type": "term.exit", "session_id": sess.session_id, "code": exit_code})


@app.post("/api/dev/term/open")
async def dev_term_open(req: Request) -> dict[str, Any]:
    _term_require_enabled()
    body = await req.json()
    cwd_rel_in = (body or {}).get("cwd_rel")
    shell = str((body or {}).get("shell") or os.environ.get("SHELL") or "/bin/zsh")
    cols = int((body or {}).get("cols") or 120)
    rows = int((body or {}).get("rows") or 30)

    cwd_rel, cwd_abs = _term_cwd_abs(str(cwd_rel_in) if cwd_rel_in is not None else None)
    os.makedirs(cwd_abs, exist_ok=True)

    sid = str(uuid.uuid4())
    q: "queue.Queue[dict[str, Any]]" = queue.Queue()

    pid, fd = pty.fork()
    if pid == 0:
        # Child: exec shell inside the sandbox cwd.
        try:
            os.chdir(cwd_abs)
        except Exception:
            pass

        os.environ["TERM"] = "xterm-256color"
        os.environ["SAW_TERMINAL"] = "1"
        os.environ["SAW_TERMINAL_ROOT"] = SAW_TERMINAL_ROOT

        try:
            os.execv(shell, [shell])
        except Exception:
            os.execv("/bin/sh", ["/bin/sh"])
        raise SystemExit(0)

    # Parent
    try:
        _term_set_winsize(fd, cols=cols, rows=rows)
        try:
            os.kill(pid, signal.SIGWINCH)
        except Exception:
            pass
    except Exception:
        pass

    sess = _TerminalSession(
        session_id=sid,
        pid=pid,
        master_fd=fd,
        cwd_rel=cwd_rel,
        created_at_ms=int(time.time() * 1000),
        q=q,
    )

    with _TERMINAL_LOCK:
        _TERMINAL_SESSIONS[sid] = sess

    t = threading.Thread(target=_term_reader_thread, args=(sess,), daemon=True)
    t.start()

    return {"session_id": sid, "cwd_rel": cwd_rel}


@app.get("/api/dev/term/stream")
def dev_term_stream(session_id: str) -> Any:
    _term_require_enabled()
    sid = str(session_id or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail={"error": "missing_session_id"})

    with _TERMINAL_LOCK:
        sess = _TERMINAL_SESSIONS.get(sid)
    if not sess:
        raise HTTPException(status_code=404, detail={"error": "unknown_session"})

    def gen():
        # Minimal SSE: forward queued events; emit keepalives.
        last_keepalive = time.time()
        while True:
            if sess.closed:
                break
            try:
                ev = sess.q.get(timeout=0.5)
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if isinstance(ev, dict) and ev.get("type") == "exit":
                    break
            except queue.Empty:
                if time.time() - last_keepalive > 10:
                    last_keepalive = time.time()
                    yield ": keepalive\n\n"
                continue

    from starlette.responses import StreamingResponse

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/dev/term/write")
async def dev_term_write(req: Request) -> dict[str, Any]:
    _term_require_enabled()
    body = await req.json()
    sid = str((body or {}).get("session_id") or "").strip()
    data = str((body or {}).get("data") or "")
    if not sid:
        raise HTTPException(status_code=400, detail={"error": "missing_session_id"})

    with _TERMINAL_LOCK:
        sess = _TERMINAL_SESSIONS.get(sid)
    if not sess or sess.closed:
        raise HTTPException(status_code=404, detail={"error": "unknown_session"})

    try:
        os.write(sess.master_fd, data.encode("utf-8", errors="ignore"))
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "term_write_failed", "details": str(e)[:2000]})


@app.post("/api/dev/term/resize")
async def dev_term_resize(req: Request) -> dict[str, Any]:
    _term_require_enabled()
    body = await req.json()
    sid = str((body or {}).get("session_id") or "").strip()
    cols = int((body or {}).get("cols") or 120)
    rows = int((body or {}).get("rows") or 30)
    if not sid:
        raise HTTPException(status_code=400, detail={"error": "missing_session_id"})

    with _TERMINAL_LOCK:
        sess = _TERMINAL_SESSIONS.get(sid)
    if not sess or sess.closed:
        raise HTTPException(status_code=404, detail={"error": "unknown_session"})

    try:
        _term_set_winsize(sess.master_fd, cols=cols, rows=rows)
        try:
            os.kill(sess.pid, signal.SIGWINCH)
        except Exception:
            pass
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "term_resize_failed", "details": str(e)[:2000]})


@app.post("/api/dev/term/close")
async def dev_term_close(req: Request) -> dict[str, Any]:
    _term_require_enabled()
    body = await req.json()
    sid = str((body or {}).get("session_id") or "").strip()
    if not sid:
        raise HTTPException(status_code=400, detail={"error": "missing_session_id"})

    with _TERMINAL_LOCK:
        sess = _TERMINAL_SESSIONS.get(sid)
        if sess:
            sess.closed = True

    if not sess:
        return {"ok": True}

    try:
        try:
            os.kill(sess.pid, signal.SIGTERM)
        except Exception:
            pass
        try:
            os.close(sess.master_fd)
        except Exception:
            pass
    finally:
        with _TERMINAL_LOCK:
            _TERMINAL_SESSIONS.pop(sid, None)

    append_session({"type": "term.close", "session_id": sid})
    return {"ok": True}


@app.get("/api/dev/caps")
def dev_caps_get() -> dict[str, Any]:
    return load_caps().model_dump()


@app.post("/api/dev/caps")
async def dev_caps_post(req: Request) -> dict[str, Any]:
    body = await req.json()
    rel = str((body or {}).get("path") or "").replace("\\", "/")
    resolved = safe_resolve(ROOT, rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})

    caps_obj = (body or {}).get("caps") or {}
    next_rule = CapsRule(
        path=rel,
        r=bool(caps_obj.get("r")),
        w=bool(caps_obj.get("w")),
        d=bool(caps_obj.get("d")),
    )
    m = load_caps()
    idx = next((i for i, r in enumerate(m.rules) if r.path == rel), -1)
    if idx >= 0:
        m.rules[idx] = next_rule
    else:
        m.rules.append(next_rule)
    m.updatedAt = int(time.time() * 1000)
    save_caps(m)
    append_session({"type": "caps.set", "path": rel, "caps": next_rule.model_dump()})
    return m.model_dump()


@app.get("/api/dev/caps/validate")
def dev_caps_validate() -> dict[str, Any]:
    m = load_caps()
    conflicts = _caps_conflicts(m)
    return {"ok": len(conflicts) == 0, "conflicts": conflicts, "updatedAt": m.updatedAt}


@app.get("/api/dev/session/log")
def dev_session_log(tail: int = 200) -> dict[str, Any]:
    tail_n = max(10, min(2000, int(tail)))
    ndjson = read_session_tail(tail_n)
    return {"tail": tail_n, "ndjson": ndjson}


@app.get("/api/dev/tree")
def dev_tree(
    root: str = ".",
    depth: int = 6,
    max_entries_q: int = Query(4000, alias="max"),
) -> dict[str, Any]:
    root_rel = (root or ".").replace("\\", "/")
    depth_n = max(1, min(10, int(depth)))
    max_entries = max(200, min(10000, int(max_entries_q)))
    if root_rel != "." and is_blocked_for_tree(root_rel):
        raise HTTPException(status_code=400, detail={"error": "invalid_root"})
    t, truncated = read_tree_with_meta(ROOT, root_rel, depth_n, max_entries)
    return {"root": root_rel, "depth": depth_n, "tree": t.model_dump(), "truncated": truncated}


@app.get("/api/dev/file")
def dev_file_get(path: str) -> dict[str, Any]:  # noqa: A002
    rel = str(path or "")
    resolved = safe_resolve(ROOT, rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})
    caps = get_caps_for_path(load_caps(), rel)
    if not caps.r:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "read", "path": rel})
    try:
        if not os.path.exists(resolved.abs):
            return {
                "path": rel,
                "content": "",
                "bytes": None,
                "sha256": None,
                "head_40_lines": "",
                "error": _dev_error("NOT_FOUND", "File does not exist"),
            }

        size = None
        try:
            size = int(os.path.getsize(resolved.abs))
        except Exception:
            size = None

        if size is not None and size > DEV_FILE_MAX_BYTES:
            return {
                "path": rel,
                "content": "",
                "bytes": size,
                "sha256": None,
                "head_40_lines": "",
                "error": _dev_error("TOO_LARGE", "File exceeds size limit", f"max_bytes={DEV_FILE_MAX_BYTES}"),
            }

        raw = open(resolved.abs, "rb").read()
        sha256 = hashlib.sha256(raw).hexdigest()
        bytes_n = len(raw)
        try:
            content = raw.decode("utf-8")
            return {
                "path": rel,
                "content": content,
                "bytes": bytes_n,
                "sha256": sha256,
                "head_40_lines": _head_40_lines(content),
                "error": None,
            }
        except UnicodeDecodeError as e:
            return {
                "path": rel,
                "content": "",
                "bytes": bytes_n,
                "sha256": sha256,
                "head_40_lines": "",
                "error": _dev_error("DECODE_ERROR", "File is not valid UTF-8", str(e)[:500]),
            }
    except Exception as e:
        # Keep error object machine-readable (older callers still treat non-2xx as failure).
        raise HTTPException(status_code=404, detail={"error": "read_failed", "details": str(e)})


@app.post("/api/dev/file")
async def dev_file_post(req: Request) -> dict[str, Any]:
    body = await req.json()
    rel = str((body or {}).get("path") or "").replace("\\", "/")
    resolved = safe_resolve(ROOT, rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})
    caps = get_caps_for_path(load_caps(), rel)
    if not caps.w:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "write", "path": rel})
    try:
        with open(resolved.abs, "w", encoding="utf-8") as f:
            f.write(str((body or {}).get("content") or ""))
        append_session({"type": "file.write", "path": rel, "bytes": len(str((body or {}).get("content") or ""))})
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "write_failed", "details": str(e)})


@app.post("/api/dev/safe/write")
def safe_write(body: SafeWriteRequest) -> dict[str, Any]:
    rel = str(body.path or "").replace("\\", "/")
    resolved = safe_resolve(ROOT, rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})
    caps = get_caps_for_path(load_caps(), rel)
    if not caps.w:
        append_session({"type": "safe.write.forbidden", "path": rel})
        raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "safe_write", "path": rel})

    _guard_locked_plugin_write(rel, op="safe_write")

    pre_head = git_head()
    dirty_paths = git_dirty_paths()
    overlap = _dirty_overlap_list(dirty_paths=dirty_paths, targets=[rel])
    # Allow workspace files (e.g. saw-workspace/todo.md) to be edited even if git-dirty.
    allow_dirty_workspace = rel.startswith("saw-workspace/")
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH) and allow_dirty_workspace:
        append_session({"type": "safe.write.bypass", "reason": "target_dirty_workspace", "paths": overlap})
        overlap = []
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH):
        append_session({"type": "safe.write.reject", "reason": "target_dirty", "paths": overlap})
        raise HTTPException(
            status_code=409,
            detail={"error": "target_dirty", "paths": overlap, "hint": "commit/stash these paths (or set SAW_PATCH_ENGINE_USE_STASH=1)"},
        )
    had_stash = bool(overlap) and SAW_PATCH_ENGINE_USE_STASH
    stash_ref: str | None = None
    if had_stash:
        stash_ref = git_stash_push()

    write_recovery({"inProgress": True, "startedAt": int(time.time() * 1000), "preHead": pre_head, "hadStash": had_stash, "stashRef": stash_ref, "op": "write", "path": rel})
    append_session({"type": "safe.write.start", "path": rel, "preHead": pre_head})
    try:
        # Ensure parent directories exist for new files (e.g. creating a new plugin folder).
        parent = os.path.dirname(resolved.abs)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(resolved.abs, "w", encoding="utf-8") as f:
            f.write(str(body.content or ""))

        if _should_validate(touched_paths=[rel]):
            ok, output = validate_project()
            if not ok:
                rollback_to(pre_head)
                if had_stash:
                    try:
                        git_stash_pop()
                    except Exception:
                        pass
                clear_recovery()
                append_session(
                    {"type": "safe.write.rollback", "path": rel, "reason": "validation_failed", "output": output[:4000]}
                )
                raise HTTPException(status_code=400, detail={"error": "validation_failed", "output": output})

        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.write.ok", "path": rel})
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        try:
            rollback_to(pre_head)
        except Exception:
            pass
        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.write.rollback", "path": rel, "reason": "exception", "details": str(e)[:2000]})
        raise HTTPException(status_code=500, detail={"error": "safe_write_failed", "details": str(e)})


@app.post("/api/dev/safe/delete")
def safe_delete(body: SafeDeleteRequest) -> dict[str, Any]:
    rel = str(body.path or "").replace("\\", "/")
    resolved = safe_resolve(ROOT, rel)
    if not resolved.ok:
        raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})
    caps = get_caps_for_path(load_caps(), rel)
    if not caps.d:
        append_session({"type": "safe.delete.forbidden", "path": rel})
        raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "safe_delete", "path": rel})

    _guard_locked_plugin_write(rel, op="safe_delete")

    pre_head = git_head()
    dirty_paths = git_dirty_paths()
    overlap = _dirty_overlap_list(dirty_paths=dirty_paths, targets=[rel])
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH):
        append_session({"type": "safe.delete.reject", "reason": "target_dirty", "paths": overlap})
        raise HTTPException(
            status_code=409,
            detail={"error": "target_dirty", "paths": overlap, "hint": "commit/stash these paths (or set SAW_PATCH_ENGINE_USE_STASH=1)"},
        )
    had_stash = bool(overlap) and SAW_PATCH_ENGINE_USE_STASH
    stash_ref: str | None = None
    if had_stash:
        stash_ref = git_stash_push()
    write_recovery({"inProgress": True, "startedAt": int(time.time() * 1000), "preHead": pre_head, "hadStash": had_stash, "stashRef": stash_ref, "op": "delete", "path": rel})
    append_session({"type": "safe.delete.start", "path": rel, "preHead": pre_head})

    try:
        try:
            os.remove(resolved.abs)
        except FileNotFoundError:
            pass

        if _should_validate(touched_paths=[rel]):
            ok, output = validate_project()
            if not ok:
                rollback_to(pre_head)
                if had_stash:
                    try:
                        git_stash_pop()
                    except Exception:
                        pass
                clear_recovery()
                append_session(
                    {"type": "safe.delete.rollback", "path": rel, "reason": "validation_failed", "output": output[:4000]}
                )
                raise HTTPException(status_code=400, detail={"error": "validation_failed", "output": output})

        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.delete.ok", "path": rel})
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        try:
            rollback_to(pre_head)
        except Exception:
            pass
        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.delete.rollback", "path": rel, "reason": "exception", "details": str(e)[:2000]})
        raise HTTPException(status_code=500, detail={"error": "safe_delete_failed", "details": str(e)})


@app.post("/api/dev/safe/applyPatch")
def safe_apply_patch(body: ApplyPatchRequest) -> dict[str, Any]:
    patch = str(body.patch or "")
    if not patch.strip():
        raise HTTPException(status_code=400, detail={"error": "empty_patch"})
    if ("--- " not in patch) or ("+++ " not in patch):
        append_session({"type": "safe.patch.reject", "reason": "invalid_diff_missing_headers"})
        raise HTTPException(status_code=400, detail={"error": "invalid_diff", "details": "Patch must include --- / +++ headers (unified diff)."})

    patch = _strip_index_lines(patch)
    patch = _normalize_new_file_blocks(patch)
    parsed = parse_patch_touched(patch)
    for p in parsed["touched"]:
        if not is_allowed_by_prefixes(p, PATCH_APPLY_ALLOWLIST):
            append_session({"type": "safe.patch.reject", "reason": "path_not_allowed", "path": p, "allowlist": PATCH_APPLY_ALLOWLIST})
            raise HTTPException(status_code=403, detail={"error": "path_not_allowed", "path": p, "allowlist": PATCH_APPLY_ALLOWLIST})
    for p in parsed["deleted"]:
        if not is_allowed_by_prefixes(p, PATCH_APPLY_ALLOWLIST):
            append_session({"type": "safe.patch.reject", "reason": "path_not_allowed", "path": p, "allowlist": PATCH_APPLY_ALLOWLIST})
            raise HTTPException(status_code=403, detail={"error": "path_not_allowed", "path": p, "allowlist": PATCH_APPLY_ALLOWLIST})

    for p in parsed["touched"]:
        _guard_locked_plugin_write(p, op="safe_apply_patch_write")
    for p in parsed["deleted"]:
        _guard_locked_plugin_write(p, op="safe_apply_patch_delete")

    manifest = load_caps()
    for p in parsed["touched"]:
        resolved = safe_resolve(ROOT, p)
        if not resolved.ok:
            raise HTTPException(status_code=400, detail={"error": "invalid_path", "path": p, "reason": resolved.reason})
        caps = get_caps_for_path(manifest, p)
        if not caps.w:
            append_session({"type": "safe.patch.forbidden", "op": "write", "path": p})
            raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "safe_patch_write", "path": p})
    for p in parsed["deleted"]:
        resolved = safe_resolve(ROOT, p)
        if not resolved.ok:
            raise HTTPException(status_code=400, detail={"error": "invalid_path", "path": p, "reason": resolved.reason})
        caps = get_caps_for_path(manifest, p)
        if not caps.d:
            append_session({"type": "safe.patch.forbidden", "op": "delete", "path": p})
            raise HTTPException(status_code=403, detail={"error": "forbidden", "op": "safe_patch_delete", "path": p})

    pre_head = git_head()
    dirty_paths = git_dirty_paths()
    targets = list(parsed["touched"]) + list(parsed["deleted"])
    overlap = _dirty_overlap_list(dirty_paths=dirty_paths, targets=targets)
    # Allow workspace-only patches to apply even if those workspace files are git-dirty.
    workspace_only = bool(targets) and all(t.startswith("saw-workspace/") for t in targets)
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH) and workspace_only:
        append_session({"type": "safe.patch.bypass", "reason": "target_dirty_workspace", "paths": overlap, "targets": targets})
        overlap = []
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH):
        append_session({"type": "safe.patch.reject", "reason": "target_dirty", "paths": overlap, "touched": parsed["touched"], "deleted": parsed["deleted"]})
        raise HTTPException(
            status_code=409,
            detail={"error": "target_dirty", "paths": overlap, "hint": "commit/stash these paths (or set SAW_PATCH_ENGINE_USE_STASH=1)"},
        )
    had_stash = bool(overlap) and SAW_PATCH_ENGINE_USE_STASH
    stash_ref: str | None = None
    if had_stash:
        stash_ref = git_stash_push()

    write_recovery({"inProgress": True, "startedAt": int(time.time() * 1000), "preHead": pre_head, "hadStash": had_stash, "stashRef": stash_ref, "op": "applyPatch", "touched": parsed})
    append_session({"type": "safe.patch.start", "preHead": pre_head, "touched": parsed["touched"], "deleted": parsed["deleted"]})

    tmp_patch = os.path.join(SAW_DIR, f"tmp_{int(time.time() * 1000)}.patch")
    try:
        _ensure_saw_dir()
        with open(tmp_patch, "w", encoding="utf-8") as f:
            f.write(patch)

        chk = run_git_allow_fail(["apply", "--check", "--recount", "--whitespace=nowarn", tmp_patch])
        if not chk.get("ok"):
            preview = "\n".join(patch.split("\n")[:24])
            append_session(
                {
                    "type": "safe.patch.reject",
                    "reason": "apply_check_failed",
                    "message": str(chk.get("message") or "")[:2000],
                    "stderr": str(chk.get("stderr") or "")[:2000],
                    "preview": preview,
                }
            )
            if had_stash:
                try:
                    git_stash_pop()
                except Exception:
                    pass
            clear_recovery()
            raise HTTPException(status_code=400, detail={"error": "patch_check_failed", "details": chk.get("stderr") or chk.get("message")})

        ap = run_git_allow_fail(["apply", "--recount", "--whitespace=nowarn", tmp_patch])
        if not ap.get("ok"):
            preview = "\n".join(patch.split("\n")[:24])
            append_session(
                {
                    "type": "safe.patch.reject",
                    "reason": "apply_failed",
                    "message": str(ap.get("message") or "")[:2000],
                    "stderr": str(ap.get("stderr") or "")[:2000],
                    "preview": preview,
                }
            )
            try:
                rollback_to(pre_head)
            except Exception:
                pass
            if had_stash:
                try:
                    git_stash_pop()
                except Exception:
                    pass
            clear_recovery()
            raise HTTPException(status_code=400, detail={"error": "patch_apply_failed", "details": ap.get("stderr") or ap.get("message")})

        if _should_validate(touched_paths=parsed["touched"]):
            ok, output = validate_project()
            if not ok:
                rollback_to(pre_head)
                if had_stash:
                    try:
                        git_stash_pop()
                    except Exception:
                        pass
                clear_recovery()
                append_session({"type": "safe.patch.rollback", "reason": "validation_failed", "output": output[:4000]})
                raise HTTPException(status_code=400, detail={"error": "validation_failed", "output": output})

        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.patch.ok", "touched": parsed["touched"]})
        return {"ok": True, "touched": parsed["touched"]}
    except HTTPException:
        raise
    except Exception as e:
        try:
            rollback_to(pre_head)
        except Exception:
            pass
        if had_stash:
            try:
                git_stash_pop()
            except Exception:
                pass
        clear_recovery()
        append_session({"type": "safe.patch.rollback", "reason": "exception", "details": str(e)[:2000]})
        raise HTTPException(status_code=500, detail={"error": "safe_patch_failed", "details": str(e)})
    finally:
        try:
            os.remove(tmp_patch)
        except Exception:
            pass


@app.get("/api/dev/git/status")
def dev_git_status(path: str | None = None) -> dict[str, Any]:  # noqa: A002
    try:
        rel = (path or "").strip()
        s = run_git(["status", "--porcelain"])
        if rel:
            resolved = safe_resolve(ROOT, rel)
            if not resolved.ok:
                raise HTTPException(status_code=400, detail={"error": "invalid_path", "reason": resolved.reason})
            d = run_git(["diff", "--", rel])
            return {"status": s["stdout"], "diff": d["stdout"], "path": rel}
        d = run_git(["diff"])
        return {"status": s["stdout"], "diff": d["stdout"], "path": None}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "git_failed", "details": str(e)})


@app.get("/api/dev/git/info")
def dev_git_info() -> dict[str, Any]:
    """Read-only git info for attestations (no direct .git reads required)."""
    try:
        status_porcelain = git_dirty()
        return {
            "repo_root": ROOT,
            "head": git_head(),
            "branch": git_branch(),
            "is_dirty": bool(status_porcelain.strip()),
            "status_porcelain": status_porcelain,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "git_info_failed", "details": str(e)})


def _claim(value: Any, *, status: Literal["proven", "unproven"], evidence_ref: list[int]) -> dict[str, Any]:
    return {"value": value, "status": status, "evidence_ref": list(evidence_ref or [])}


def _safe_localhost_get_json(url: str, *, timeout_s: float = 1.5) -> dict[str, Any]:
    # SSRF safety: only allow localhost.
    u = str(url or "").strip()
    if not u:
        raise ValueError("missing_url")
    if not (u.startswith("http://127.0.0.1") or u.startswith("http://localhost") or u.startswith("http://[::1]") or u.startswith("http://::1")):
        raise ValueError("non_localhost_url")
    req = urllib.request.Request(u, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310
        raw = resp.read()
        return json.loads(raw.decode("utf-8") or "{}")


def _file_read_evidence(path: str) -> dict[str, Any]:
    rel = str(path or "").replace("\\", "/")
    try:
        r = dev_file_get(rel)
        return {
            "kind": "file_read",
            "path": rel,
            "bytes": r.get("bytes"),
            "sha256": r.get("sha256"),
            "head_40_lines": r.get("head_40_lines") or "",
            "error": r.get("error"),
        }
    except HTTPException as e:
        detail = e.detail if isinstance(e.detail, dict) else {"message": str(e.detail)}
        return {
            "kind": "file_read",
            "path": rel,
            "bytes": None,
            "sha256": None,
            "head_40_lines": "",
            "error": _dev_error(str(detail.get("error") or "HTTP_ERROR"), "file_read_failed", json.dumps(detail)[:500]),
        }
    except Exception as e:
        return {
            "kind": "file_read",
            "path": rel,
            "bytes": None,
            "sha256": None,
            "head_40_lines": "",
            "error": _dev_error("EXCEPTION", "file_read_failed", str(e)[:500]),
        }


def _build_introspection_packet() -> dict[str, Any]:
    # Evidence indices referenced by claims.
    evidence: list[dict[str, Any]] = []

    def add_tool_ev(tool_id: str) -> int:
        evidence.append({"kind": "tool_call", "tool_id": str(tool_id or "")})
        return len(evidence) - 1

    def add_file_ev(path: str) -> int:
        evidence.append(_file_read_evidence(path))
        return len(evidence) - 1

    ev_introspection = add_tool_ev("dev.introspection.run")
    ev_git = add_tool_ev("dev.git.info")
    ev_tools = add_tool_ev("dev.tools.list")

    # Canonical file reads (helpful for downstream attestations).
    ev_start_here = add_file_ev("saw-workspace/machine-context/START_HERE.md")
    ev_caps = add_file_ev(".saw/caps.json")
    ev_caps_rules = add_file_ev("saw-workspace/machine-context/security/CAPS_RULES.md")

    # Git state
    git = {}
    try:
        git = dev_git_info()
    except Exception:
        git = {"head": "", "branch": "", "is_dirty": "unknown", "status_porcelain": ""}

    # Tool surface
    tool_surface: list[dict[str, Any]] = []
    try:
        tool_surface = list((dev_tools_list() or {}).get("tools") or [])
    except Exception:
        tool_surface = []

    # SAW agent health (best-effort, localhost-only)
    saw_health: dict[str, Any] | None = None
    saw_health_err = ""
    ev_saw_health: int | None = None
    try:
        base = str(os.environ.get("SAW_API_URL") or "http://127.0.0.1:5127").rstrip("/")
        saw_health = _safe_localhost_get_json(base + "/agent/health")
        ev_saw_health = add_tool_ev("saw.agent.health")
    except Exception as e:
        saw_health = None
        saw_health_err = str(e)

    llm_available: Any = "unknown"
    agent_chat_ok: Any = "unknown"
    last_error: str = ""
    if isinstance(saw_health, dict):
        llm_available = bool(saw_health.get("llm_available"))
        agent_chat_ok = bool(saw_health.get("agent_chat_route_ok"))
        last_error = str(saw_health.get("last_error") or "")

    # Lightweight embedded probe summary for UI.
    results: list[dict[str, Any]] = []
    def add_result(pid: str, status: str, why: str) -> None:
        results.append({"id": pid, "status": status, "why": why})

    add_result("P0_INTROSPECTION_RUN", "pass", "packet_generated")
    add_result("P1_TOOL_CATALOG", "pass" if len(tool_surface) > 0 else "fail", "tools_list_ok" if tool_surface else "empty_tools")
    add_result(
        "P2_GIT_INFO",
        "pass" if str(git.get("head") or "").strip() and str(git.get("branch") or "").strip() else "fail",
        "git_info_ok" if str(git.get("head") or "").strip() else "missing_head_or_branch",
    )
    add_result(
        "P3_SAW_AGENT_HEALTH",
        "pass" if isinstance(saw_health, dict) else "unavailable",
        "ok" if isinstance(saw_health, dict) else (saw_health_err or "unavailable"),
    )
    summary = {
        "passes": sum(1 for r in results if r.get("status") == "pass"),
        "fails": sum(1 for r in results if r.get("status") == "fail"),
        "unavailable": sum(1 for r in results if r.get("status") == "unavailable"),
    }

    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "schema_version": "1.1",
        "timestamp_utc": ts,
        "agent_identity": {
            "name": _claim("patch_engine", status="proven", evidence_ref=[ev_introspection]),
            "agent_kind": _claim("service", status="proven", evidence_ref=[ev_introspection]),
            "version": _claim("0.1", status="proven", evidence_ref=[ev_introspection]),
            "build_hash": _claim(str(git.get("head") or "unknown"), status="proven", evidence_ref=[ev_git]),
        },
        "runtime": {
            "cwd": _claim(os.getcwd(), status="proven", evidence_ref=[ev_introspection]),
            "repo_root": _claim(ROOT, status="proven", evidence_ref=[ev_introspection]),
            "workspace_root_guess": _claim("saw-workspace", status="proven", evidence_ref=[ev_introspection]),
        },
        "git_state": {
            "head": _claim(str(git.get("head") or ""), status="proven", evidence_ref=[ev_git]),
            "branch": _claim(str(git.get("branch") or ""), status="proven", evidence_ref=[ev_git]),
            "is_dirty": _claim(bool(git.get("is_dirty")) if str(git.get("status_porcelain") or "").strip() else False, status="proven", evidence_ref=[ev_git]),
            "status_porcelain": _claim(str(git.get("status_porcelain") or ""), status="proven", evidence_ref=[ev_git]),
        },
        "capabilities": {
            "patch_apply_allowlist": PATCH_APPLY_ALLOWLIST,
            "terminal_enabled": bool(SAW_ENABLE_TERMINAL),
        },
        "policies_claimed": {
            "validation_mode": VALIDATION_MODE,
        },
        "tool_surface": tool_surface,
        "health": {
            "llm_available": _claim(llm_available, status="proven" if isinstance(saw_health, dict) else "unproven", evidence_ref=[ev_saw_health] if ev_saw_health is not None else []),
            "agent_chat_route_ok": _claim(agent_chat_ok, status="proven" if isinstance(saw_health, dict) else "unproven", evidence_ref=[ev_saw_health] if ev_saw_health is not None else []),
            "last_error": _claim(last_error, status="proven" if isinstance(saw_health, dict) else "unproven", evidence_ref=[ev_saw_health] if ev_saw_health is not None else []),
        },
        "evidence": evidence,
        "notes": {
            "embedded_probe_results": results,
            "embedded_probe_summary": summary,
            "evidence_indices": {
                "introspection": ev_introspection,
                "git": ev_git,
                "tools": ev_tools,
                "start_here": ev_start_here,
                "caps": ev_caps,
                "caps_rules": ev_caps_rules,
            },
        },
    }


@app.get("/api/dev/introspection/run")
def dev_introspection_run_get() -> dict[str, Any]:
    return _build_introspection_packet()


@app.post("/api/dev/introspection/run")
async def dev_introspection_run_post(_: Request) -> dict[str, Any]:
    return _build_introspection_packet()


@app.get("/api/dev/tools/list")
def dev_tools_list() -> dict[str, Any]:
    """Canonical Patch Engine tool registry (used by attestation + agents)."""

    terminal_available = bool(SAW_ENABLE_TERMINAL)

    def tool(
        tool_id: str,
        *,
        backend: Literal["saw_api", "patch_engine", "mcp"] = "patch_engine",
        args_schema: dict[str, Any],
        returns_schema: dict[str, Any],
        side_effects: list[str],
        approval_required: bool,
        availability: str = "available",
        notes: str = "",
    ) -> dict[str, Any]:
        return {
            "tool_id": tool_id,
            "backend": backend,
            "args_schema": args_schema,
            "returns_schema": returns_schema,
            "side_effects": side_effects,
            "approval_required": approval_required,
            "availability": availability,
            "notes": notes,
        }

    tools: list[dict[str, Any]] = [
        # Aliases: underscore-style tool ids (used by some test prompts)
        tool(
            "dev_tree",
            args_schema={"type": "object", "properties": {"root": {"type": "string"}, "depth": {"type": "integer"}, "max": {"type": "integer"}}},
            returns_schema={"type": "object"},
            side_effects=["disk_read"],
            approval_required=False,
            notes="Alias for dev.tree (GET /api/dev/tree)",
        ),
        tool(
            "dev_file",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            returns_schema={"type": "object"},
            side_effects=["disk_read"],
            approval_required=False,
            notes="Alias for dev.file.read (GET /api/dev/file)",
        ),
        tool(
            "git_info",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["disk_read", "subprocess"],
            approval_required=False,
            notes="Alias for dev.git.info (GET /api/dev/git/info)",
        ),
        tool(
            "introspection_run",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["disk_read", "subprocess", "network"],
            approval_required=False,
            notes="Alias for dev.introspection.run (GET/POST /api/dev/introspection/run)",
        ),
        tool(
            "saw_agent_health",
            backend="saw_api",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["network"],
            approval_required=False,
            notes="GET /api/saw/agent/health (proxied to SAW API /agent/health)",
        ),

        tool(
            "dev.tree",
            args_schema={"type": "object", "properties": {"root": {"type": "string"}, "depth": {"type": "integer"}, "max": {"type": "integer"}}},
            returns_schema={"type": "object", "properties": {"root": {"type": "string"}, "depth": {"type": "integer"}, "tree": {"type": "object"}, "truncated": {"type": "boolean"}}},
            side_effects=["disk_read"],
            approval_required=False,
            notes="GET /api/dev/tree",
        ),
        tool(
            "dev.file.read",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            returns_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "bytes": {"type": ["integer", "null"]},
                    "sha256": {"type": ["string", "null"]},
                    "head_40_lines": {"type": "string"},
                    "error": {"type": ["object", "null"]},
                },
            },
            side_effects=["disk_read"],
            approval_required=False,
            notes="GET /api/dev/file",
        ),
        tool(
            "dev.caps.get",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["disk_read"],
            approval_required=False,
            notes="GET /api/dev/caps",
        ),
        tool(
            "dev.caps.set",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}, "caps": {"type": "object"}}, "required": ["path", "caps"]},
            returns_schema={"type": "object"},
            side_effects=["disk_write"],
            approval_required=False,
            notes="POST /api/dev/caps",
        ),
        tool(
            "dev.caps.validate",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object", "properties": {"ok": {"type": "boolean"}, "conflicts": {"type": "array"}}},
            side_effects=["disk_read"],
            approval_required=False,
            notes="GET /api/dev/caps/validate",
        ),
        tool(
            "dev.safe.write",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
            returns_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            side_effects=["disk_write", "subprocess"],
            approval_required=True,
            notes="POST /api/dev/safe/write (approval-gated; may run validation + git subprocess)",
        ),
        tool(
            "dev.safe.delete",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            returns_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            side_effects=["disk_write", "subprocess"],
            approval_required=True,
            notes="POST /api/dev/safe/delete (approval-gated; may run validation + git subprocess)",
        ),
        tool(
            "dev.safe.applyPatch",
            args_schema={"type": "object", "properties": {"patch": {"type": "string"}}, "required": ["patch"]},
            returns_schema={"type": "object", "properties": {"ok": {"type": "boolean"}, "touched": {"type": "array"}}},
            side_effects=["disk_write", "subprocess"],
            approval_required=True,
            notes="POST /api/dev/safe/applyPatch (approval-gated; may run validation + git subprocess)",
        ),
        tool(
            "dev.git.info",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object", "properties": {"repo_root": {"type": "string"}, "head": {"type": "string"}}},
            side_effects=["disk_read", "subprocess"],
            approval_required=False,
            notes="GET /api/dev/git/info",
        ),
        tool(
            "dev.git.status",
            args_schema={"type": "object", "properties": {"path": {"type": "string"}}},
            returns_schema={"type": "object"},
            side_effects=["disk_read", "subprocess"],
            approval_required=False,
            notes="GET /api/dev/git/status",
        ),
        tool(
            "dev.tools.list",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object", "properties": {"tools": {"type": "array"}}},
            side_effects=["disk_read"],
            approval_required=False,
            notes="GET /api/dev/tools/list",
        ),
        tool(
            "dev.introspection.run",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["disk_read", "subprocess", "network"],
            approval_required=False,
            notes="GET/POST /api/dev/introspection/run",
        ),
        tool(
            "dev.git.commit",
            args_schema={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]},
            returns_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
            side_effects=["subprocess", "disk_write"],
            approval_required=True,
            notes="POST /api/dev/git/commit (mutates repo)",
        ),
        tool(
            "dev.term",
            args_schema={"type": "object", "properties": {}},
            returns_schema={"type": "object"},
            side_effects=["subprocess"],
            approval_required=True,
            availability="available" if terminal_available else "unavailable",
            notes="/api/dev/term/* (availability gated by SAW_ENABLE_TERMINAL)",
        ),
    ]

    return {"tools": tools}


@app.post("/api/dev/git/commit")
def dev_git_commit(body: GitCommitRequest) -> dict[str, Any]:
    msg = str(body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail={"error": "missing_commit_message"})
    try:
        # Use exclude pathspecs so agent commits don't accidentally include runtime junk.
        add = run_git_allow_fail(["add", "-A", "--", ".", *GIT_COMMIT_EXCLUDE_PATHSPECS])
        if not add.get("ok"):
            # Fallback for older git pathspec behavior.
            run_git(["add", "-A"])
        r = run_git(["commit", "-m", msg, "--no-gpg-sign"])
        append_session({"type": "git.commit", "message": msg})
        return {"ok": True, "stdout": r["stdout"], "stderr": r["stderr"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail={"error": "git_commit_failed", "details": str(e)})



