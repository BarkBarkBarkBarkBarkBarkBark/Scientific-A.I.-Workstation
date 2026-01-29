from __future__ import annotations

import ast
from dataclasses import dataclass
from datetime import datetime, timedelta
import fnmatch
import json
import os
import re
import subprocess
import tempfile
import threading
from typing import Any, Iterable

import psycopg

from ..db import jsonb, sha256_text
from ..settings import Settings
from .config import RepoIntelConfig, config_to_json, load_repo_intel_config


LANG_PY = "py"
LANG_TS = "ts"
LANG_TSX = "tsx"
LANG_JS = "js"
LANG_JSX = "jsx"
LANG_OTHER = "other"


@dataclass(frozen=True)
class SubprocessResult:
    ok: bool
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool


def _now() -> datetime:
    return datetime.utcnow()


def _run_subprocess(cmd: list[str], cwd: str, timeout_seconds: int = 300, env: dict[str, str] | None = None) -> SubprocessResult:
    try:
        p = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        return SubprocessResult(ok=p.returncode == 0, stdout=p.stdout or "", stderr=p.stderr or "", returncode=p.returncode, timed_out=False)
    except subprocess.TimeoutExpired as e:
        return SubprocessResult(ok=False, stdout=getattr(e, "stdout", "") or "", stderr=getattr(e, "stderr", "") or "", returncode=124, timed_out=True)


def _git_commit(repo_root: str) -> str:
    r = _run_subprocess(["git", "rev-parse", "HEAD"], cwd=repo_root, timeout_seconds=15)
    if not r.ok:
        return "unknown"
    return (r.stdout.strip() or "unknown")


def _git_branch(repo_root: str) -> str | None:
    r = _run_subprocess(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_root, timeout_seconds=15)
    if not r.ok:
        return None
    b = r.stdout.strip()
    return b or None


def _matches_any_glob(rel_path: str, patterns: Iterable[str]) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(rel_path, pat):
            return True
    return False


def _language_for_path(rel_path: str) -> str:
    lp = rel_path.lower()
    if lp.endswith(".py"):
        return LANG_PY
    if lp.endswith(".tsx"):
        return LANG_TSX
    if lp.endswith(".ts"):
        return LANG_TS
    if lp.endswith(".jsx"):
        return LANG_JSX
    if lp.endswith(".js"):
        return LANG_JS
    return LANG_OTHER


def _is_test_path(rel_path: str) -> bool:
    lp = rel_path.lower()
    return (
        "/tests/" in lp
        or "/__tests__/" in lp
        or lp.endswith("_test.py")
        or lp.endswith(".spec.ts")
        or lp.endswith(".spec.tsx")
        or lp.endswith(".test.ts")
        or lp.endswith(".test.tsx")
    )


def _iter_repo_files(repo_root: str, excludes: list[str]) -> Iterable[str]:
    for root, dirs, files in os.walk(repo_root):
        rel_root = os.path.relpath(root, repo_root)
        if rel_root == ".":
            rel_root = ""
        # Prune obvious excludes early
        pruned: list[str] = []
        for d in list(dirs):
            d_rel = os.path.join(rel_root, d) if rel_root else d
            d_rel_slash = d_rel.replace("\\", "/") + "/"
            if _matches_any_glob(d_rel_slash, excludes):
                pruned.append(d)
        for d in pruned:
            if d in dirs:
                dirs.remove(d)

        for f in files:
            rel_path = os.path.join(rel_root, f) if rel_root else f
            rel_path = rel_path.replace("\\", "/")
            if _matches_any_glob(rel_path, excludes):
                continue
            yield rel_path


def _read_text(repo_root: str, rel_path: str) -> str:
    abs_path = os.path.join(repo_root, rel_path)
    try:
        return open(abs_path, "r", encoding="utf-8", errors="ignore").read()
    except Exception:
        return ""


def _file_loc(text: str) -> int:
    if not text:
        return 0
    return len(text.splitlines())


def register_repo(conn: psycopg.Connection, name: str, root_path: str) -> str:
    row = conn.execute("SELECT repo_id FROM repo_intel.repos WHERE root_path=%s", (root_path,)).fetchone()
    if row:
        return str(row[0])
    row2 = conn.execute(
        "INSERT INTO repo_intel.repos(name, root_path) VALUES (%s, %s) RETURNING repo_id",
        (name, root_path),
    ).fetchone()
    return str(row2[0])


def _upsert_file(conn: psycopg.Connection, repo_id: str, rel_path: str, language: str, sha256: str, loc: int, is_generated: bool, is_test: bool) -> str:
    row = conn.execute(
        "SELECT file_id FROM repo_intel.files WHERE repo_id=%s AND rel_path=%s",
        (repo_id, rel_path),
    ).fetchone()
    if row:
        file_id = str(row[0])
        conn.execute(
            "UPDATE repo_intel.files SET language=%s, sha256=%s, loc=%s, is_generated=%s, is_test=%s WHERE file_id=%s",
            (language, sha256, loc, is_generated, is_test, file_id),
        )
        return file_id

    row2 = conn.execute(
        "INSERT INTO repo_intel.files(repo_id, rel_path, language, sha256, loc, is_generated, is_test) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING file_id",
        (repo_id, rel_path, language, sha256, loc, is_generated, is_test),
    ).fetchone()
    return str(row2[0])


def _ensure_external_file(conn: psycopg.Connection, repo_id: str, key: str) -> str:
    rel_path = f"<external>:{key}"
    return _upsert_file(conn, repo_id, rel_path, LANG_OTHER, sha256_text(rel_path), 0, True, False)


def _create_scan(conn: psycopg.Connection, repo_id: str, scan_type: str, config: dict[str, Any], repo_root: str) -> str:
    git_commit = _git_commit(repo_root)
    git_branch = _git_branch(repo_root)
    analyzers = []
    if scan_type == "static_scan":
        analyzers = [
            {"name": "python_import_graph", "status": "pending"},
            {"name": "js_ts_import_graph", "status": "pending"},
        ]
    else:
        analyzers = [
            {"name": "python_coverage", "status": "pending"},
            {"name": "python_call_counts", "status": "pending"},
        ]
    config_full = dict(config or {})
    config_full["scan_type"] = scan_type
    config_full["analyzers"] = analyzers

    row = conn.execute(
        "INSERT INTO repo_intel.scans(repo_id, git_commit, git_branch, status, config) VALUES (%s,%s,%s,%s,%s) RETURNING scan_id",
        (repo_id, git_commit, git_branch, "running", jsonb(config_full)),
    ).fetchone()
    return str(row[0])


def create_scan_for_repo(settings: Settings, conn: psycopg.Connection, repo_id: str, repo_root: str, scan_type: str, config: dict[str, Any]) -> str:
    cfg = load_repo_intel_config(repo_root)
    cfg_json = config_to_json(cfg)
    scan_cfg = dict(config or {})
    scan_cfg.update(cfg_json)
    return _create_scan(conn, repo_id, scan_type, scan_cfg, repo_root)


def _update_scan(conn: psycopg.Connection, scan_id: str, *, status: str | None = None, finished: bool = False, error: str | None = None, config_patch: dict[str, Any] | None = None, tool_versions: dict[str, Any] | None = None) -> None:
    if config_patch is not None:
        row = conn.execute("SELECT config FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
        cfg = (row[0] if row and row[0] is not None else {}) or {}
        if isinstance(cfg, str):
            try:
                cfg = json.loads(cfg)
            except Exception:
                cfg = {}
        if not isinstance(cfg, dict):
            cfg = {}
        for k, v in (config_patch or {}).items():
            cfg[k] = v
        conn.execute("UPDATE repo_intel.scans SET config=%s WHERE scan_id=%s", (jsonb(cfg), scan_id))

    if tool_versions is not None:
        conn.execute("UPDATE repo_intel.scans SET tool_versions=%s WHERE scan_id=%s", (jsonb(tool_versions), scan_id))

    if error is not None:
        conn.execute("UPDATE repo_intel.scans SET error=%s WHERE scan_id=%s", (str(error), scan_id))

    if status is not None:
        conn.execute("UPDATE repo_intel.scans SET status=%s WHERE scan_id=%s", (status, scan_id))

    if finished:
        conn.execute("UPDATE repo_intel.scans SET finished_at=now() WHERE scan_id=%s", (scan_id,))


def _set_analyzer_status(cfg: dict[str, Any], name: str, status: str, error: str | None = None) -> dict[str, Any]:
    analyzers = cfg.get("analyzers")
    if not isinstance(analyzers, list):
        analyzers = []
    out: list[dict[str, Any]] = []
    found = False
    for a in analyzers:
        if not isinstance(a, dict):
            continue
        if a.get("name") == name:
            na = dict(a)
            na["status"] = status
            if error:
                na["error"] = error
            out.append(na)
            found = True
        else:
            out.append(a)
    if not found:
        out.append({"name": name, "status": status, "error": error})
    cfg2 = dict(cfg)
    cfg2["analyzers"] = out
    return cfg2


def _read_scan_config(conn: psycopg.Connection, scan_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT config FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
    cfg = (row[0] if row else None) or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    return cfg


def _reset_scan_artifacts(conn: psycopg.Connection, scan_id: str) -> None:
    conn.execute("DELETE FROM repo_intel.import_edges WHERE scan_id=%s", (scan_id,))
    conn.execute("DELETE FROM repo_intel.symbols WHERE scan_id=%s", (scan_id,))
    conn.execute("DELETE FROM repo_intel.scan_files WHERE scan_id=%s", (scan_id,))


def _discover_and_upsert_files(conn: psycopg.Connection, repo_id: str, repo_root: str, cfg: RepoIntelConfig) -> dict[str, str]:
    file_id_by_rel: dict[str, str] = {}
    for rel_path in _iter_repo_files(repo_root, cfg.excludes):
        lang = _language_for_path(rel_path)
        if lang not in (LANG_PY, LANG_TS, LANG_TSX, LANG_JS, LANG_JSX):
            continue
        text = _read_text(repo_root, rel_path)
        sha = sha256_text(text)
        fid = _upsert_file(
            conn,
            repo_id,
            rel_path,
            lang,
            sha,
            _file_loc(text),
            False,
            _is_test_path(rel_path),
        )
        file_id_by_rel[rel_path] = fid
    return file_id_by_rel


def _write_scan_files(conn: psycopg.Connection, scan_id: str, file_ids: Iterable[str]) -> None:
    for fid in file_ids:
        conn.execute(
            "INSERT INTO repo_intel.scan_files(scan_id, file_id, present) VALUES (%s,%s,true) ON CONFLICT (scan_id,file_id) DO UPDATE SET present=EXCLUDED.present",
            (scan_id, fid),
        )


def _python_module_map(py_rel_paths: Iterable[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for rel_path in py_rel_paths:
        if not rel_path.endswith(".py"):
            continue
        parts = rel_path.split("/")
        if parts and parts[-1] == "__init__.py":
            mod = ".".join([p for p in parts[:-1] if p])
        else:
            mod = ".".join([p for p in parts if p]).removesuffix(".py")
        if mod:
            out[mod] = rel_path
    return out


def _python_extract_symbols(repo_root: str, rel_path: str, module_name: str) -> list[dict[str, Any]]:
    text = _read_text(repo_root, rel_path)
    if not text.strip():
        return []
    try:
        tree = ast.parse(text)
    except Exception:
        return []

    symbols: list[dict[str, Any]] = []

    class Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: list[str] = []

        def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
            name = node.name
            fq = ".".join([module_name] + self.stack + [name])
            symbols.append({"fqname": fq, "kind": "function", "start_line": getattr(node, "lineno", None), "end_line": getattr(node, "end_lineno", None)})
            self.stack.append(name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
            name = node.name
            fq = ".".join([module_name] + self.stack + [name])
            symbols.append({"fqname": fq, "kind": "function", "start_line": getattr(node, "lineno", None), "end_line": getattr(node, "end_lineno", None)})
            self.stack.append(name)
            self.generic_visit(node)
            self.stack.pop()

        def visit_ClassDef(self, node: ast.ClassDef) -> Any:
            name = node.name
            fq = ".".join([module_name] + self.stack + [name])
            symbols.append({"fqname": fq, "kind": "class", "start_line": getattr(node, "lineno", None), "end_line": getattr(node, "end_lineno", None)})
            self.stack.append(name)
            self.generic_visit(node)
            self.stack.pop()

    Visitor().visit(tree)
    # module symbol
    symbols.append({"fqname": module_name, "kind": "module", "start_line": 1, "end_line": _file_loc(text)})
    return symbols


def _python_import_edges(repo_root: str, rel_path: str, module_name: str, module_map: dict[str, str]) -> list[dict[str, Any]]:
    text = _read_text(repo_root, rel_path)
    if not text.strip():
        return []
    try:
        tree = ast.parse(text)
    except Exception:
        return []

    edges: list[dict[str, Any]] = []

    def resolve_abs(mod: str) -> str | None:
        if mod in module_map:
            return module_map[mod]
        if (mod + ".__init__") in module_map:
            return module_map[mod + ".__init__"]
        # best-effort: match longest prefix
        parts = mod.split(".")
        for i in range(len(parts), 0, -1):
            cand = ".".join(parts[:i])
            if cand in module_map:
                return module_map[cand]
            if (cand + ".__init__") in module_map:
                return module_map[cand + ".__init__"]
        return None

    def resolve_from(level: int, mod: str | None) -> str | None:
        base = module_name
        base_parts = base.split(".")
        if level > 0:
            base_parts = base_parts[: max(0, len(base_parts) - level)]
        prefix = ".".join([p for p in base_parts if p])
        full = ""
        if mod:
            full = f"{prefix}.{mod}" if prefix else mod
        else:
            full = prefix
        if not full:
            return None
        return resolve_abs(full)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                name = a.name
                dst = resolve_abs(name)
                edges.append({"kind": "import" if dst else "dynamic_import", "raw": name, "dst_rel": dst})
        elif isinstance(node, ast.ImportFrom):
            mod = node.module
            level = int(getattr(node, "level", 0) or 0)
            dst = resolve_from(level, mod)
            raw = ("." * level) + (mod or "")
            edges.append({"kind": "import" if dst else "dynamic_import", "raw": raw, "dst_rel": dst})

    return edges


def _run_ts_import_graph(repo_root: str, timeout_seconds: int = 300) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    script = os.path.join(repo_root, "tools", "repo_intel", "depcruise_graph.mjs")
    if not os.path.isfile(script):
        return {"tool": "dependency-cruiser", "ok": False, "error": "missing_tool_script"}, []
    r = _run_subprocess(["node", script, "--root", repo_root, "--scope", "src"], cwd=repo_root, timeout_seconds=timeout_seconds)
    if not r.ok:
        return {"tool": "dependency-cruiser", "ok": False, "error": "depcruise_failed", "stderr": r.stderr[:4000]}, []
    try:
        payload = json.loads(r.stdout)
    except Exception:
        return {"tool": "dependency-cruiser", "ok": False, "error": "depcruise_bad_json"}, []
    edges = payload.get("edges")
    if not isinstance(edges, list):
        edges = []
    return {"tool": "dependency-cruiser", "ok": True, "version": payload.get("tool_version")}, [e for e in edges if isinstance(e, dict)]


def _store_import_edges(conn: psycopg.Connection, scan_id: str, repo_id: str, file_id_by_rel: dict[str, str], edges: list[tuple[str, str, str, str | None]]) -> None:
    # edges items: (src_rel, dst_key_or_rel, kind, raw)
    for src_rel, dst_key, kind, raw in edges:
        src_id = file_id_by_rel.get(src_rel)
        if not src_id:
            continue
        if dst_key.startswith("<external>:"):
            dst_id = _ensure_external_file(conn, repo_id, dst_key[len("<external>:") :])
            file_id_by_rel.setdefault(dst_key, dst_id)
        else:
            dst_id = file_id_by_rel.get(dst_key)
            if not dst_id:
                # treat as external if missing
                dst_id = _ensure_external_file(conn, repo_id, dst_key)
                file_id_by_rel.setdefault(f"<external>:{dst_key}", dst_id)
        conn.execute(
            "INSERT INTO repo_intel.import_edges(scan_id, src_file_id, dst_file_id, kind, raw) VALUES (%s,%s,%s,%s,%s)",
            (scan_id, src_id, dst_id, kind, raw),
        )


def _store_symbols(conn: psycopg.Connection, scan_id: str, file_id: str, symbols: list[dict[str, Any]]) -> None:
    for s in symbols:
        conn.execute(
            "INSERT INTO repo_intel.symbols(scan_id, file_id, fqname, kind, start_line, end_line) VALUES (%s,%s,%s,%s,%s,%s)",
            (
                scan_id,
                file_id,
                str(s.get("fqname") or ""),
                str(s.get("kind") or ""),
                s.get("start_line"),
                s.get("end_line"),
            ),
        )


def _scan_static(settings: Settings, repo_id: str, scan_id: str, repo_root: str, cfg: RepoIntelConfig) -> None:
    with psycopg.connect(settings.db_url, autocommit=True) as conn:
        _reset_scan_artifacts(conn, scan_id)

        scan_cfg = _read_scan_config(conn, scan_id)
        scan_cfg = _set_analyzer_status(scan_cfg, "python_import_graph", "running")
        scan_cfg = _set_analyzer_status(scan_cfg, "js_ts_import_graph", "pending")
        _update_scan(conn, scan_id, config_patch=scan_cfg)

        file_id_by_rel = _discover_and_upsert_files(conn, repo_id, repo_root, cfg)
        _write_scan_files(conn, scan_id, file_id_by_rel.values())

        py_paths = [p for p, fid in file_id_by_rel.items() if p.endswith(".py")]
        module_map = _python_module_map(py_paths)
        module_by_path: dict[str, str] = {}
        for mod, path in module_map.items():
            module_by_path[path] = mod

        py_edges_tuples: list[tuple[str, str, str, str | None]] = []
        try:
            for rel_path in py_paths:
                module_name = module_by_path.get(rel_path) or rel_path.replace("/", ".").removesuffix(".py")
                symbols = _python_extract_symbols(repo_root, rel_path, module_name)
                fid = file_id_by_rel.get(rel_path)
                if fid:
                    _store_symbols(conn, scan_id, fid, symbols)

                edges = _python_import_edges(repo_root, rel_path, module_name, module_map)
                for e in edges:
                    dst_rel = e.get("dst_rel")
                    raw = str(e.get("raw") or "")
                    if dst_rel:
                        py_edges_tuples.append((rel_path, str(dst_rel), str(e.get("kind") or "import"), raw))
                    else:
                        py_edges_tuples.append((rel_path, f"<external>:{raw}", str(e.get("kind") or "dynamic_import"), raw))

            _store_import_edges(conn, scan_id, repo_id, file_id_by_rel, py_edges_tuples)
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_import_graph", "ok")
            _update_scan(conn, scan_id, config_patch=scan_cfg)
        except Exception as e:
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_import_graph", "failed", error=str(e))
            _update_scan(conn, scan_id, status="partial", error=f"python_import_graph_failed: {e}", config_patch=scan_cfg)

        # TS analyzer
        scan_cfg = _read_scan_config(conn, scan_id)
        scan_cfg = _set_analyzer_status(scan_cfg, "js_ts_import_graph", "running")
        _update_scan(conn, scan_id, config_patch=scan_cfg)
        try:
            tv, ts_edges = _run_ts_import_graph(repo_root)
            # Convert edges into (src_rel, dst_rel_or_external, kind, raw)
            edge_tuples: list[tuple[str, str, str, str | None]] = []
            for e in ts_edges:
                src = str(e.get("src") or "")
                dst = str(e.get("dst") or "")
                kind = str(e.get("kind") or "import")
                raw = e.get("raw")
                if not src or not dst:
                    continue
                if dst.startswith("<external>:"):
                    edge_tuples.append((src, dst, kind, str(raw) if raw is not None else None))
                elif dst.startswith(".") or dst.startswith("/"):
                    # normalize relative to repo
                    dst2 = dst.lstrip("/")
                    edge_tuples.append((src, dst2, kind, str(raw) if raw is not None else None))
                else:
                    edge_tuples.append((src, dst, kind, str(raw) if raw is not None else None))
            _store_import_edges(conn, scan_id, repo_id, file_id_by_rel, edge_tuples)
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "js_ts_import_graph", "ok")
            _update_scan(conn, scan_id, config_patch=scan_cfg, tool_versions={"js_ts_import_graph": tv})
        except Exception as e:
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "js_ts_import_graph", "failed", error=str(e))
            _update_scan(conn, scan_id, status="partial", error=f"js_ts_import_graph_failed: {e}", config_patch=scan_cfg)

        # Mark scan done if not already partial
        row = conn.execute("SELECT status FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
        st = str(row[0]) if row else ""
        if st == "running":
            _update_scan(conn, scan_id, status="ok")

        # Recommendations (best-effort)
        try:
            compute_and_persist_recommendations(conn, repo_id, scan_id)
        except Exception:
            pass
        _update_scan(conn, scan_id, finished=True)


def _coverage_and_profile(settings: Settings, repo_id: str, scan_id: str, repo_root: str, cfg: RepoIntelConfig) -> None:
    with psycopg.connect(settings.db_url, autocommit=True) as conn:
        scan_cfg = _read_scan_config(conn, scan_id)
        entrypoint = str(scan_cfg.get("entrypoint_command") or "")
        args = scan_cfg.get("args")
        if not isinstance(args, list):
            args = []
        args = [str(a) for a in args]

        if not entrypoint:
            _update_scan(conn, scan_id, status="failed", finished=True, error="runtime_run_requires_entrypoint_command")
            return

        # Ensure file catalog exists (needed for evidence mapping)
        file_id_by_rel = _discover_and_upsert_files(conn, repo_id, repo_root, cfg)
        _write_scan_files(conn, scan_id, file_id_by_rel.values())

        git_commit = _git_commit(repo_root)

        # coverage
        scan_cfg = _set_analyzer_status(scan_cfg, "python_coverage", "running")
        _update_scan(conn, scan_id, config_patch=scan_cfg)
        try:
            run_row = conn.execute(
                "INSERT INTO repo_intel.runs(repo_id, git_commit, entrypoint, args, status) VALUES (%s,%s,%s,%s,%s) RETURNING run_id",
                (repo_id, git_commit, entrypoint, jsonb(args), "running"),
            ).fetchone()
            run_id = str(run_row[0])

            with tempfile.TemporaryDirectory(prefix="saw_repo_intel_") as td:
                cov_file = os.path.join(td, ".coverage")
                env = dict(os.environ)
                env["COVERAGE_FILE"] = cov_file

                cmd = _build_python_wrapped_command(["coverage", "run"], entrypoint, args)
                r = _run_subprocess(cmd, cwd=repo_root, timeout_seconds=300, env=env)

                conn.execute(
                    "UPDATE repo_intel.runs SET status=%s, finished_at=now(), stdout=%s, stderr=%s, error=%s WHERE run_id=%s",
                    ("ok" if r.ok else ("timeout" if r.timed_out else "failed"), r.stdout, r.stderr, None if r.ok else "coverage_run_failed", run_id),
                )

                if r.ok:
                    report_json = os.path.join(td, "coverage.json")
                    r2 = _run_subprocess(["python", "-m", "coverage", "json", "-o", report_json, "--pretty-print"], cwd=repo_root, timeout_seconds=60, env=env)
                    if r2.ok and os.path.isfile(report_json):
                        cov = json.loads(open(report_json, "r", encoding="utf-8").read())
                        files = (cov.get("files") or {}) if isinstance(cov, dict) else {}
                        for abs_path, fobj in files.items():
                            if not isinstance(fobj, dict):
                                continue
                            rel = str(fobj.get("relative_filename") or "")
                            if not rel:
                                # fallback: try make relative
                                try:
                                    rel = os.path.relpath(str(abs_path), repo_root).replace("\\", "/")
                                except Exception:
                                    rel = ""
                            if not rel or rel.startswith(".."):
                                continue
                            fid = file_id_by_rel.get(rel)
                            if not fid:
                                continue
                            exec_lines = fobj.get("executed_lines")
                            if not isinstance(exec_lines, list):
                                exec_lines = []
                            summary = fobj.get("summary") if isinstance(fobj.get("summary"), dict) else {}
                            executed_lines = len(exec_lines)
                            total_lines = int((summary or {}).get("num_statements") or 0)
                            conn.execute(
                                "INSERT INTO repo_intel.evidence_file_exec(run_id, file_id, executed_lines, total_lines, exec_hits, source) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id,file_id,source) DO UPDATE SET executed_lines=EXCLUDED.executed_lines, total_lines=EXCLUDED.total_lines",
                                (run_id, fid, executed_lines, total_lines, None, "coverage"),
                            )

            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_coverage", "ok")
            _update_scan(conn, scan_id, config_patch=scan_cfg)
        except Exception as e:
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_coverage", "failed", error=str(e))
            _update_scan(conn, scan_id, status="partial", error=f"python_coverage_failed: {e}", config_patch=scan_cfg)

        # cProfile
        scan_cfg = _read_scan_config(conn, scan_id)
        scan_cfg = _set_analyzer_status(scan_cfg, "python_call_counts", "running")
        _update_scan(conn, scan_id, config_patch=scan_cfg)
        try:
            # build symbols for best-effort mapping
            py_paths = [p for p in file_id_by_rel.keys() if p.endswith(".py")]
            module_map = _python_module_map(py_paths)
            module_by_path: dict[str, str] = {}
            for mod, path in module_map.items():
                module_by_path[path] = mod
            for rel in py_paths:
                fid = file_id_by_rel.get(rel)
                if not fid:
                    continue
                module_name = module_by_path.get(rel) or rel.replace("/", ".").removesuffix(".py")
                syms = _python_extract_symbols(repo_root, rel, module_name)
                _store_symbols(conn, scan_id, fid, syms)

            run_row = conn.execute(
                "INSERT INTO repo_intel.runs(repo_id, git_commit, entrypoint, args, status) VALUES (%s,%s,%s,%s,%s) RETURNING run_id",
                (repo_id, git_commit, entrypoint, jsonb(args), "running"),
            ).fetchone()
            run_id = str(run_row[0])

            with tempfile.TemporaryDirectory(prefix="saw_repo_intel_") as td:
                prof = os.path.join(td, "cprofile.prof")
                cmd = _build_python_wrapped_command(["python", "-m", "cProfile", "-o", prof], entrypoint, args)
                r = _run_subprocess(cmd, cwd=repo_root, timeout_seconds=300)
                conn.execute(
                    "UPDATE repo_intel.runs SET status=%s, finished_at=now(), stdout=%s, stderr=%s, error=%s WHERE run_id=%s",
                    ("ok" if r.ok else ("timeout" if r.timed_out else "failed"), r.stdout, r.stderr, None if r.ok else "cprofile_run_failed", run_id),
                )
                if r.ok and os.path.isfile(prof):
                    _ingest_cprofile(conn, scan_id, run_id, repo_root, prof)

            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_call_counts", "ok")
            _update_scan(conn, scan_id, config_patch=scan_cfg)
        except Exception as e:
            scan_cfg = _read_scan_config(conn, scan_id)
            scan_cfg = _set_analyzer_status(scan_cfg, "python_call_counts", "failed", error=str(e))
            _update_scan(conn, scan_id, status="partial", error=f"python_call_counts_failed: {e}", config_patch=scan_cfg)

        row = conn.execute("SELECT status FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
        st = str(row[0]) if row else ""
        if st == "running":
            _update_scan(conn, scan_id, status="ok")

        # Recommendations (best-effort)
        try:
            compute_and_persist_recommendations(conn, repo_id, scan_id)
        except Exception:
            pass
        _update_scan(conn, scan_id, finished=True)


def _build_python_wrapped_command(prefix: list[str], entrypoint_command: str, args: list[str]) -> list[str]:
    # Accept entrypoint_command as:
    #   "python -m module" | "python script.py" | "-m module" | "script.py"
    parts = entrypoint_command.strip().split()
    if not parts:
        return prefix + args

    if parts[0] == "python":
        parts = parts[1:]

    # For coverage, prefix usually already includes "coverage run".
    # For cProfile, prefix includes "python -m cProfile ...".
    cmd = list(prefix)
    cmd.extend(parts)
    cmd.extend(args)
    return cmd


def _ingest_cprofile(conn: psycopg.Connection, scan_id: str, run_id: str, repo_root: str, prof_path: str) -> None:
    import pstats

    st = pstats.Stats(prof_path)
    # stats: { (filename, line, funcname): (cc, nc, tt, ct, callers) }
    stats = getattr(st, "stats", {}) or {}

    # Build lookup: (file_id, start_line, funcname) -> symbol_id
    rows = conn.execute(
        "SELECT symbol_id, file_id, fqname, start_line FROM repo_intel.symbols WHERE scan_id=%s",
        (scan_id,),
    ).fetchall()
    symbol_by_key: dict[tuple[str, int, str], str] = {}
    for sym_id, file_id, fqname, start_line in rows:
        if start_line is None:
            continue
        name = str(fqname).split(".")[-1]
        symbol_by_key[(str(file_id), int(start_line), name)] = str(sym_id)

    # file rel_path -> file_id
    file_rows = conn.execute(
        "SELECT file_id, rel_path FROM repo_intel.files WHERE repo_id=(SELECT repo_id FROM repo_intel.scans WHERE scan_id=%s)",
        (scan_id,),
    ).fetchall()
    file_id_by_rel: dict[str, str] = {str(rel): str(fid) for fid, rel in file_rows}

    for (filename, line, funcname), (cc, _nc, _tt, ct, _callers) in stats.items():
        try:
            rel = os.path.relpath(str(filename), repo_root).replace("\\", "/")
        except Exception:
            continue
        if rel.startswith(".."):
            continue
        fid = file_id_by_rel.get(rel)
        if not fid:
            continue
        key = (fid, int(line), str(funcname))
        sym_id = symbol_by_key.get(key)
        if not sym_id:
            # best-effort: try match by funcname only within file
            alt = None
            for (ffid, sline, name), sid in symbol_by_key.items():
                if ffid == fid and name == str(funcname):
                    alt = sid
                    break
            sym_id = alt
        if not sym_id:
            continue

        conn.execute(
            "INSERT INTO repo_intel.evidence_symbol_calls(run_id, symbol_id, call_count, cumulative_time_ms, source) VALUES (%s,%s,%s,%s,%s) ON CONFLICT (run_id,symbol_id,source) DO UPDATE SET call_count=EXCLUDED.call_count, cumulative_time_ms=EXCLUDED.cumulative_time_ms",
            (run_id, sym_id, int(cc), float(ct) * 1000.0, "cprofile"),
        )


def start_scan_background(settings: Settings, repo_id: str, repo_root: str, scan_id: str, scan_type: str) -> None:
    cfg = load_repo_intel_config(repo_root)

    def worker() -> None:
        try:
            if scan_type == "static_scan":
                _scan_static(settings, repo_id, scan_id, repo_root, cfg)
            else:
                _coverage_and_profile(settings, repo_id, scan_id, repo_root, cfg)
        except Exception as e:
            try:
                with psycopg.connect(settings.db_url, autocommit=True) as conn:
                    _update_scan(conn, scan_id, status="failed", finished=True, error=str(e))
            except Exception:
                pass

    t = threading.Thread(target=worker, name=f"repo_intel_scan_{scan_id}", daemon=True)
    t.start()


def get_scan(conn: psycopg.Connection, scan_id: str) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT scan_id, repo_id, git_commit, git_branch, started_at, finished_at, status, tool_versions, config, error FROM repo_intel.scans WHERE scan_id=%s",
        (scan_id,),
    ).fetchone()
    if not row:
        return None
    (
        scan_id,
        repo_id,
        git_commit,
        git_branch,
        started_at,
        finished_at,
        status,
        tool_versions,
        config,
        error,
    ) = row

    cfg = config or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}

    tv = tool_versions or {}
    if isinstance(tv, str):
        try:
            tv = json.loads(tv)
        except Exception:
            tv = {}
    if not isinstance(tv, dict):
        tv = {}

    analyzers = cfg.get("analyzers")
    if not isinstance(analyzers, list):
        analyzers = []

    return {
        "scan_id": str(scan_id),
        "repo_id": str(repo_id),
        "git_commit": str(git_commit),
        "git_branch": str(git_branch) if git_branch is not None else None,
        "started_at": started_at.isoformat() if started_at else None,
        "finished_at": finished_at.isoformat() if finished_at else None,
        "status": str(status),
        "tool_versions": tv,
        "config": cfg,
        "error": str(error) if error else None,
        "progress": {"analyzers": analyzers},
    }


def get_graph(conn: psycopg.Connection, repo_id: str, scan_id: str, scope_prefix: str | None, include_tests: bool) -> dict[str, Any]:
    where = "WHERE f.repo_id=%s"
    params: list[Any] = [repo_id]
    if scope_prefix:
        where += " AND f.rel_path LIKE %s"
        params.append(scope_prefix.replace("%", "") + "%")
    if not include_tests:
        where += " AND NOT f.is_test"

    nodes = conn.execute(
        f"SELECT f.file_id, f.rel_path, f.language FROM repo_intel.files f {where} ORDER BY f.rel_path LIMIT 5000",
        tuple(params),
    ).fetchall()
    file_ids = [str(r[0]) for r in nodes]
    id_to_node = {str(r[0]): {"file_id": str(r[0]), "rel_path": str(r[1]), "language": str(r[2])} for r in nodes}

    if not file_ids:
        return {"nodes": [], "edges": []}

    edges = conn.execute(
        "SELECT e.src_file_id, e.dst_file_id, e.kind FROM repo_intel.import_edges e WHERE e.scan_id=%s AND e.src_file_id = ANY(%s::uuid[]) LIMIT 20000",
        (scan_id, file_ids),
    ).fetchall()

    out_edges = []
    for src_id, dst_id, kind in edges:
        src = str(src_id)
        dst = str(dst_id)
        if src not in id_to_node:
            continue
        # allow dst outside filtered scope
        out_edges.append({"src_file_id": src, "dst_file_id": dst, "kind": str(kind)})

    return {"nodes": list(id_to_node.values()), "edges": out_edges}


def evidence_summary(conn: psycopg.Connection, repo_id: str, git_commit: str | None, time_window_days: int | None) -> dict[str, Any]:
    params: list[Any] = [repo_id]
    where = "WHERE r.repo_id=%s"
    if git_commit:
        where += " AND r.git_commit=%s"
        params.append(git_commit)
    if time_window_days and time_window_days > 0:
        where += " AND r.started_at >= now() - (%s || ' days')::interval"
        params.append(int(time_window_days))

    hot = conn.execute(
        f"""
        SELECT f.rel_path,
               COALESCE(SUM(e.exec_hits), 0) AS exec_hits,
               COUNT(DISTINCT r.run_id) AS runs_seen,
               MAX(r.started_at) AS last_seen_at
        FROM repo_intel.runs r
        JOIN repo_intel.evidence_file_exec e ON e.run_id=r.run_id
        JOIN repo_intel.files f ON f.file_id=e.file_id
        {where}
        GROUP BY f.rel_path
        ORDER BY exec_hits DESC NULLS LAST, runs_seen DESC
        LIMIT 200
        """,
        tuple(params),
    ).fetchall()

    file_hotness = [
        {
            "rel_path": str(rel),
            "exec_hits": int(hits) if hits is not None else 0,
            "runs_seen": int(rs) if rs is not None else 0,
            "last_seen_at": last.isoformat() if last else None,
        }
        for (rel, hits, rs, last) in hot
    ]

    # cold files: files never seen in evidence window
    cold_params: list[Any] = [repo_id]
    cold_where = "WHERE f.repo_id=%s"
    if not git_commit:
        # use latest commit window; still fine
        pass

    cutoff_expr = "now() - interval '30 days'"
    if time_window_days and time_window_days > 0:
        cutoff_expr = "now() - (%s || ' days')::interval"
        cold_params.append(int(time_window_days))

    cold = conn.execute(
        f"""
        SELECT f.rel_path
        FROM repo_intel.files f
        {cold_where}
          AND NOT EXISTS (
            SELECT 1
            FROM repo_intel.evidence_file_exec e
            JOIN repo_intel.runs r ON r.run_id=e.run_id
            WHERE e.file_id=f.file_id
              AND r.repo_id=%s
              AND r.started_at >= {cutoff_expr}
          )
        ORDER BY f.rel_path
        LIMIT 500
        """,
        tuple(cold_params + [repo_id]),
    ).fetchall()

    cold_files = [{"rel_path": str(rel), "reason": "never_seen_in_runs"} for (rel,) in cold]

    return {"file_hotness": file_hotness, "cold_files": cold_files}


def list_recommendations(conn: psycopg.Connection, repo_id: str, scan_id: str, min_severity: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT rec_id, type, severity, rationale, payload, suggested_actions FROM repo_intel.recommendations WHERE repo_id=%s AND scan_id=%s AND severity >= %s ORDER BY severity DESC, created_at DESC LIMIT 200",
        (repo_id, scan_id, int(min_severity)),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for rec_id, typ, sev, rationale, payload, actions in rows:
        out.append(
            {
                "rec_id": str(rec_id),
                "type": str(typ),
                "severity": int(sev),
                "rationale": str(rationale) if rationale else "",
                "payload": payload or {},
                "suggested_actions": actions or {},
            }
        )
    return out


def propose_patch_diff(settings: Settings, repo_id: str, scan_id: str, rec_id: str, action: str) -> str:
    with psycopg.connect(settings.db_url, autocommit=True) as conn:
        root_row = conn.execute("SELECT root_path FROM repo_intel.repos WHERE repo_id=%s", (repo_id,)).fetchone()
        if not root_row:
            raise ValueError("repo_not_found")
        repo_root = str(root_row[0])
        row = conn.execute(
            "SELECT type, payload FROM repo_intel.recommendations WHERE rec_id=%s AND repo_id=%s AND scan_id=%s",
            (rec_id, repo_id, scan_id),
        ).fetchone()
        if not row:
            raise ValueError("rec_not_found")
        _typ, payload = row
        payload = payload or {}

    if action == "delete_file":
        rel_path = str((payload or {}).get("rel_path") or "")
        if not rel_path or rel_path.startswith("<external>:"):
            raise ValueError("invalid_rel_path")
        abs_path = os.path.join(repo_root, rel_path)
        before = ""
        try:
            before = open(abs_path, "r", encoding="utf-8", errors="ignore").read()
        except Exception:
            before = ""
        return _unified_delete_diff(rel_path, before)

    if action == "add_ignore_rule":
        # diff that adds a line to .saw/repo_intel.yaml under dynamic_import_allowlist
        cfg_path = os.path.join(repo_root, ".saw", "repo_intel.yaml")
        old = ""
        if os.path.isfile(cfg_path):
            old = open(cfg_path, "r", encoding="utf-8").read()
        rule = str((payload or {}).get("rule") or "")
        if not rule:
            rule = str((payload or {}).get("raw") or "")
        if not rule:
            raise ValueError("missing_rule")
        new = _add_allowlist_rule_yaml(old, rule)
        return _unified_replace_diff(".saw/repo_intel.yaml", old, new)

    if action == "delete_symbol":
        symbol_id = (payload or {}).get("symbol_id")
        fqname = str((payload or {}).get("fqname") or "")
        if not symbol_id and not fqname:
            raise ValueError("missing_symbol_selector")
        with psycopg.connect(settings.db_url, autocommit=True) as conn:
            if symbol_id:
                srow = conn.execute(
                    """
                    SELECT f.rel_path, s.start_line, s.end_line
                    FROM repo_intel.symbols s
                    JOIN repo_intel.files f ON f.file_id=s.file_id
                    WHERE s.symbol_id=%s AND s.scan_id=%s
                    """,
                    (str(symbol_id), scan_id),
                ).fetchone()
            else:
                srow = conn.execute(
                    """
                    SELECT f.rel_path, s.start_line, s.end_line
                    FROM repo_intel.symbols s
                    JOIN repo_intel.files f ON f.file_id=s.file_id
                    WHERE s.scan_id=%s AND s.fqname=%s
                    ORDER BY s.start_line NULLS LAST
                    LIMIT 1
                    """,
                    (scan_id, fqname),
                ).fetchone()

        if not srow:
            raise ValueError("symbol_not_found")
        rel_path, start_line, end_line = srow
        rel_path = str(rel_path)
        if not rel_path or rel_path.startswith("<external>:"):
            raise ValueError("invalid_symbol_file")
        if not start_line or not end_line:
            raise ValueError("symbol_missing_line_range")

        abs_path = os.path.join(repo_root, rel_path)
        before = open(abs_path, "r", encoding="utf-8", errors="ignore").read() if os.path.isfile(abs_path) else ""
        after = _remove_line_range(before, int(start_line), int(end_line))
        return _unified_replace_diff(rel_path, before, after)

    raise ValueError("unsupported_action")


def _remove_line_range(text: str, start_line: int, end_line: int) -> str:
    if start_line <= 0 or end_line <= 0 or end_line < start_line:
        return text
    lines = text.splitlines(keepends=True)
    s = max(1, start_line)
    e = min(len(lines), end_line)
    # Remove inclusive range [s,e]
    out = lines[: s - 1] + lines[e:]
    return "".join(out)


def _unified_delete_diff(rel_path: str, before: str) -> str:
    a = f"a/{rel_path}"
    b = "/dev/null"
    before_lines = before.splitlines(keepends=True)
    out = []
    out.append(f"diff --git {a} {b}\n")
    out.append(f"deleted file mode 100644\n")
    out.append(f"--- {a}\n")
    out.append(f"+++ {b}\n")
    out.append(f"@@ -1,{len(before_lines)} +0,0 @@\n")
    for line in before_lines:
        if not line.endswith("\n"):
            line = line + "\n"
        out.append("-" + line)
    return "".join(out)


def _unified_replace_diff(rel_path: str, before: str, after: str) -> str:
    a = f"a/{rel_path}"
    b = f"b/{rel_path}"
    before_lines = before.splitlines(keepends=True)
    after_lines = after.splitlines(keepends=True)
    out = []
    out.append(f"diff --git {a} {b}\n")
    out.append(f"--- {a}\n")
    out.append(f"+++ {b}\n")
    out.append(f"@@ -1,{len(before_lines)} +1,{len(after_lines)} @@\n")
    for line in before_lines:
        if not line.endswith("\n"):
            line = line + "\n"
        out.append("-" + line)
    for line in after_lines:
        if not line.endswith("\n"):
            line = line + "\n"
        out.append("+" + line)
    return "".join(out)


def _add_allowlist_rule_yaml(existing: str, rule: str) -> str:
    try:
        import yaml

        doc = yaml.safe_load(existing) if existing.strip() else {}
        if not isinstance(doc, dict):
            doc = {}
    except Exception:
        doc = {}

    allow = doc.get("dynamic_import_allowlist")
    if not isinstance(allow, list):
        allow = []
    if rule not in allow:
        allow.append(rule)
    doc["dynamic_import_allowlist"] = allow

    # Keep excludes/entrypoints if present; otherwise ensure excludes exists.
    if "excludes" not in doc:
        doc["excludes"] = []

    try:
        return yaml.safe_dump(doc, sort_keys=False)
    except Exception:
        # fallback naive
        return existing + ("\n" if not existing.endswith("\n") else "") + f"dynamic_import_allowlist:\n  - {rule}\n"


# --- Recommendations ---

_EXCLUDE_REC_PATTERNS = ["**/__init__.py", "**/migrations/**", "**/plugins/**"]


def compute_and_persist_recommendations(conn: psycopg.Connection, repo_id: str, scan_id: str) -> None:
    # Idempotent per scan: delete previous
    conn.execute("DELETE FROM repo_intel.recommendations WHERE repo_id=%s AND scan_id=%s", (repo_id, scan_id))

    # fan-in/out + cycles
    edges = conn.execute(
        "SELECT src_file_id, dst_file_id FROM repo_intel.import_edges WHERE scan_id=%s",
        (scan_id,),
    ).fetchall()
    nodes = conn.execute(
        "SELECT file_id, rel_path, is_generated, is_test FROM repo_intel.files WHERE repo_id=%s",
        (repo_id,),
    ).fetchall()
    rel_by_id = {str(fid): str(rel) for fid, rel, _ig, _it in nodes}
    meta_by_id = {str(fid): {"rel_path": str(rel), "is_generated": bool(ig), "is_test": bool(it)} for fid, rel, ig, it in nodes}

    indeg: dict[str, int] = {}
    outdeg: dict[str, int] = {}
    adj: dict[str, list[str]] = {}
    for src, dst in edges:
        s = str(src)
        d = str(dst)
        outdeg[s] = outdeg.get(s, 0) + 1
        indeg[d] = indeg.get(d, 0) + 1
        adj.setdefault(s, []).append(d)

    # High fan-in/out
    for fid, deg in sorted(indeg.items(), key=lambda x: x[1], reverse=True)[:20]:
        if deg < 15:
            break
        rel = rel_by_id.get(fid)
        if not rel:
            continue
        _insert_rec(
            conn,
            repo_id,
            scan_id,
            "high_fan_in",
            2,
            {"rel_path": rel, "degree": deg},
            f"High fan-in: {deg} inbound imports.",
            {"actions": []},
        )

    for fid, deg in sorted(outdeg.items(), key=lambda x: x[1], reverse=True)[:20]:
        if deg < 20:
            break
        rel = rel_by_id.get(fid)
        if not rel:
            continue
        _insert_rec(
            conn,
            repo_id,
            scan_id,
            "high_fan_out",
            2,
            {"rel_path": rel, "degree": deg},
            f"High fan-out: {deg} outbound imports.",
            {"actions": []},
        )

    # Cycles (Tarjan SCC)
    cycles = _tarjan_scc(list(meta_by_id.keys()), adj)
    for comp in cycles:
        if len(comp) <= 1:
            continue
        rels = [rel_by_id.get(fid, fid) for fid in comp]
        _insert_rec(
            conn,
            repo_id,
            scan_id,
            "cycle",
            3,
            {"files": rels},
            "Import cycle detected.",
            {"actions": []},
        )

    # Dead file candidates (best-effort; evidence required)
    _dead_file_candidates(conn, repo_id, scan_id)


def _insert_rec(conn: psycopg.Connection, repo_id: str, scan_id: str, typ: str, severity: int, payload: dict[str, Any], rationale: str, actions: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO repo_intel.recommendations(repo_id, scan_id, type, severity, payload, rationale, suggested_actions) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (repo_id, scan_id, typ, int(severity), jsonb(payload), rationale, jsonb(actions)),
    )


def _tarjan_scc(nodes: list[str], adj: dict[str, list[str]]) -> list[list[str]]:
    index = 0
    stack: list[str] = []
    onstack: set[str] = set()
    idx: dict[str, int] = {}
    low: dict[str, int] = {}
    out: list[list[str]] = []

    def strong(v: str) -> None:
        nonlocal index
        idx[v] = index
        low[v] = index
        index += 1
        stack.append(v)
        onstack.add(v)
        for w in adj.get(v, []):
            if w not in idx:
                strong(w)
                low[v] = min(low[v], low.get(w, low[v]))
            elif w in onstack:
                low[v] = min(low[v], idx[w])
        if low[v] == idx[v]:
            comp: list[str] = []
            while True:
                w = stack.pop()
                onstack.remove(w)
                comp.append(w)
                if w == v:
                    break
            out.append(comp)

    for n in nodes:
        if n not in idx:
            strong(n)
    return out


def _dead_file_candidates(conn: psycopg.Connection, repo_id: str, scan_id: str) -> None:
    # Determine evidence over last N runs on same commit if possible
    scan_row = conn.execute("SELECT git_commit FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
    git_commit = str(scan_row[0]) if scan_row else ""

    # counts per file
    rows = conn.execute(
        """
        SELECT f.file_id, f.rel_path, f.is_generated, f.is_test,
               COALESCE(SUM(CASE WHEN e.executed_lines IS NULL THEN 0 ELSE e.executed_lines END), 0) AS executed_lines_sum,
               COUNT(DISTINCT r.run_id) AS runs_seen
        FROM repo_intel.files f
        LEFT JOIN repo_intel.evidence_file_exec e ON e.file_id=f.file_id
        LEFT JOIN repo_intel.runs r ON r.run_id=e.run_id AND r.repo_id=%s
        WHERE f.repo_id=%s
        GROUP BY f.file_id, f.rel_path, f.is_generated, f.is_test
        """,
        (repo_id, repo_id),
    ).fetchall()

    # Reachability from configured entrypoints (optional)
    cfg_row = conn.execute("SELECT config FROM repo_intel.scans WHERE scan_id=%s", (scan_id,)).fetchone()
    cfg = (cfg_row[0] if cfg_row else {}) or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}
    entrypoints = []
    for e in (cfg.get("entrypoints") or []):
        if isinstance(e, dict) and e.get("command"):
            entrypoints.append(str(e.get("command")))

    # Map entrypoint -> likely file rel_path (very best-effort)
    ep_files: list[str] = []
    for cmd in entrypoints:
        # npm or python -m can't be resolved reliably; accept explicit paths
        for tok in cmd.split():
            if tok.endswith(('.py', '.ts', '.tsx', '.js', '.jsx')) and not tok.startswith('-'):
                ep_files.append(tok.lstrip('./'))

    # Build adjacency on rel_path (internal only)
    edge_rows = conn.execute(
        """
        SELECT fs.rel_path AS src_rel, fd.rel_path AS dst_rel
        FROM repo_intel.import_edges e
        JOIN repo_intel.files fs ON fs.file_id=e.src_file_id
        JOIN repo_intel.files fd ON fd.file_id=e.dst_file_id
        WHERE e.scan_id=%s
        """,
        (scan_id,),
    ).fetchall()
    adj_rel: dict[str, list[str]] = {}
    for s, d in edge_rows:
        adj_rel.setdefault(str(s), []).append(str(d))

    reachable: set[str] = set()
    if ep_files:
        stack = list(ep_files)
        while stack:
            cur = stack.pop()
            if cur in reachable:
                continue
            reachable.add(cur)
            for nxt in adj_rel.get(cur, []):
                if nxt not in reachable:
                    stack.append(nxt)

    # Tests referencing file: inbound edge from test file
    inbound_from_test: set[str] = set()
    test_inbound_rows = conn.execute(
        """
        SELECT fd.rel_path
        FROM repo_intel.import_edges e
        JOIN repo_intel.files fs ON fs.file_id=e.src_file_id
        JOIN repo_intel.files fd ON fd.file_id=e.dst_file_id
        WHERE e.scan_id=%s AND fs.is_test=true
        """,
        (scan_id,),
    ).fetchall()
    for (rel,) in test_inbound_rows:
        inbound_from_test.add(str(rel))

    for file_id, rel_path, is_generated, is_test, executed_lines_sum, runs_seen in rows:
        rel = str(rel_path)
        if _matches_any_glob(rel, _EXCLUDE_REC_PATTERNS):
            continue
        if is_test:
            continue

        score = 0
        if ep_files:
            if rel not in reachable:
                score += 2
        # runtime evidence
        if int(executed_lines_sum) == 0:
            score += 3
        if rel not in inbound_from_test:
            score += 1
        if not bool(is_generated):
            score += 1

        sev = 0
        if score >= 6 and int(runs_seen) >= 20:
            sev = 5
        elif score >= 4 and int(runs_seen) >= 10:
            sev = 3
        elif score >= 4:
            sev = 2
        else:
            continue

        _insert_rec(
            conn,
            repo_id,
            scan_id,
            "dead_file_candidate",
            sev,
            {"rel_path": rel, "score": score, "runs_seen": int(runs_seen)},
            f"Dead file heuristic score={score} (runs_seen={int(runs_seen)}).",
            {"actions": ["delete_file", "add_ignore_rule"]},
        )
