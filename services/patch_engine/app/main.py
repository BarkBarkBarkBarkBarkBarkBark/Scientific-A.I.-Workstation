from __future__ import annotations

import contextvars
import json
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

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

# Debug-mode forensic log.
# IMPORTANT: default to a gitignored location under .saw/ so we don't dirty the repo and break stashing.
DEBUG_LOG_PATH = os.environ.get("SAW_PATCH_ENGINE_DEBUG_LOG_PATH") or os.path.join(SAW_DIR, "debug.ndjson")
_REQ_ID: contextvars.ContextVar[str] = contextvars.ContextVar("saw_req_id", default="")

SAW_PATCH_ENGINE_USE_STASH = _truthy(os.environ.get("SAW_PATCH_ENGINE_USE_STASH", "0"))

def _dbg(hypothesisId: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    # Keep tiny + never log secrets.
    try:
        os.makedirs(SAW_DIR, exist_ok=True)
        payload = {
            "sessionId": "debug-session",
            "runId": "pre-fix",
            "hypothesisId": hypothesisId,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": int(time.time() * 1000),
        }
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass

# region cursor debug log
# NOTE: Debug-mode runtime evidence path (do not log secrets).
_CURSOR_DEBUG_LOG_PATH = "/Users/marco/Cursor_Folder/Cursor_Codespace/Scientific A.I. Workstation/.cursor/debug.log"

def _cdbg(hypothesisId: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    try:
        run_id = str(os.environ.get("SAW_DEBUG_RUN_ID") or "pre-fix")
        payload = {
            "sessionId": "debug-session",
            "runId": run_id,
            "hypothesisId": hypothesisId,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": int(time.time() * 1000),
        }
        with open(_CURSOR_DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass
# endregion

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
        line = json.dumps({"ts": int(time.time() * 1000), **(event or {})}, ensure_ascii=False) + "\n"
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


def get_caps_for_path(m: CapsManifest, rel: str) -> CapsRule:
    # Default: readable, not writable/deletable.
    default = CapsRule(path="*", r=True, w=False, d=False)
    p = (rel or "").replace("\\", "/")
    best: CapsRule | None = None
    best_len = -1
    for rule in m.rules:
        rp = str(rule.path or "").replace("\\", "/")
        if not rp:
            continue
        # Root rule "." or "./" applies to everything.
        if rp in (".", "./"):
            if 1 > best_len:
                best = rule
                best_len = 1
            continue
        if rp.endswith("/"):
            if p.startswith(rp) and len(rp) > best_len:
                best = rule
                best_len = len(rp)
        else:
            if p == rp and len(rp) > best_len:
                best = rule
                best_len = len(rp)
    return best or default


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
    }


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
    t = read_tree(ROOT, root_rel, depth_n, max_entries)
    return {"root": root_rel, "depth": depth_n, "tree": t.model_dump()}


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
        content = open(resolved.abs, "r", encoding="utf-8").read()
        return {"path": rel, "content": content}
    except Exception as e:
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

    pre_head = git_head()
    dirty_paths = git_dirty_paths()
    overlap = _dirty_overlap_list(dirty_paths=dirty_paths, targets=[rel])
    # region cursor debug log
    _cdbg(
        "H_dirty_gate",
        "services/patch_engine/app/main.py:safe_write",
        "dirty_check",
        {"path": rel, "use_stash": bool(SAW_PATCH_ENGINE_USE_STASH), "preHead": pre_head, "dirtyCount": len(dirty_paths), "overlap": overlap},
    )
    # endregion
    # Allow workspace files (e.g. saw-workspace/todo.md) to be edited even if git-dirty.
    allow_dirty_workspace = rel.startswith("saw-workspace/")
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH) and allow_dirty_workspace:
        append_session({"type": "safe.write.bypass", "reason": "target_dirty_workspace", "paths": overlap})
        # region cursor debug log
        _cdbg(
            "H_dirty_gate",
            "services/patch_engine/app/main.py:safe_write",
            "bypass_target_dirty_workspace",
            {"path": rel, "overlap": overlap},
        )
        # endregion
        overlap = []
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH):
        append_session({"type": "safe.write.reject", "reason": "target_dirty", "paths": overlap})
        # region cursor debug log
        _cdbg(
            "H_dirty_gate",
            "services/patch_engine/app/main.py:safe_write",
            "reject_target_dirty",
            {"path": rel, "overlap": overlap},
        )
        # endregion
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
        # region cursor debug log
        _cdbg(
            "H_dirty_gate",
            "services/patch_engine/app/main.py:safe_write",
            "ok",
            {"path": rel},
        )
        # endregion
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
    # region cursor debug log
    _cdbg(
        "H_dirty_gate",
        "services/patch_engine/app/main.py:safe_apply_patch",
        "dirty_check",
        {"use_stash": bool(SAW_PATCH_ENGINE_USE_STASH), "preHead": pre_head, "dirtyCount": len(dirty_paths), "targets": targets, "overlap": overlap},
    )
    # endregion
    # Allow workspace-only patches to apply even if those workspace files are git-dirty.
    workspace_only = bool(targets) and all(t.startswith("saw-workspace/") for t in targets)
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH) and workspace_only:
        append_session({"type": "safe.patch.bypass", "reason": "target_dirty_workspace", "paths": overlap, "targets": targets})
        # region cursor debug log
        _cdbg(
            "H_dirty_gate",
            "services/patch_engine/app/main.py:safe_apply_patch",
            "bypass_target_dirty_workspace",
            {"overlap": overlap, "targets": targets},
        )
        # endregion
        overlap = []
    if overlap and (not SAW_PATCH_ENGINE_USE_STASH):
        append_session({"type": "safe.patch.reject", "reason": "target_dirty", "paths": overlap, "touched": parsed["touched"], "deleted": parsed["deleted"]})
        # region cursor debug log
        _cdbg(
            "H_dirty_gate",
            "services/patch_engine/app/main.py:safe_apply_patch",
            "reject_target_dirty",
            {"overlap": overlap, "touched": parsed["touched"], "deleted": parsed["deleted"]},
        )
        # endregion
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



