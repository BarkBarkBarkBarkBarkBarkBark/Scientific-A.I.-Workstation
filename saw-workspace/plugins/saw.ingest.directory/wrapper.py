"""SAW Plugin: Ingest Directory

Reads text-like files under saw-workspace/ and indexes them into the SAW DB by calling:
  POST /embed/upsert

Security:
  - Only allows paths within saw-workspace/ (rejects ../ or absolute paths).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


EXCLUDED_DIRS = {".saw", ".venv", "node_modules", "dist", ".git"}


def _workspace_root() -> str:
    # Prefer explicit override from API process env, else derive from plugin location:
    # saw-workspace/plugins/<this_plugin>/
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(__file__)
    return os.path.abspath(os.path.join(here, "..", ".."))


def _safe_join_under(root: str, rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        rel = "."
    # Block absolute paths / traversal
    if rel.startswith("/") or rel.startswith("~"):
        raise ValueError("directory must be relative to saw-workspace/")
    if rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("directory traversal is not allowed")
    abs_path = os.path.abspath(os.path.join(root, rel))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        raise ValueError("directory must be inside saw-workspace/")
    return abs_path


def _parse_ext_list(s: str) -> set[str]:
    out: set[str] = set()
    for part in (s or "").split(","):
        p = part.strip().lower()
        if not p:
            continue
        if not p.startswith("."):
            p = "." + p
        out.add(p)
    return out


def _is_text_like(path: str, include_ext: set[str]) -> bool:
    ext = os.path.splitext(path)[1].lower()
    return ext in include_ext


def _read_text_best_effort(path: str, max_bytes: int) -> str | None:
    try:
        st = os.stat(path)
        if max_bytes > 0 and st.st_size > max_bytes:
            return None
    except Exception:
        return None
    try:
        with open(path, "rb") as f:
            raw = f.read(max_bytes if max_bytes > 0 else None)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return None


def _post_json(url: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"http_error {e.code}: {msg[:2000]}")
    except Exception as e:
        raise RuntimeError(str(e))


def main(inputs: dict, params: dict, context) -> dict:
    ws_root = _workspace_root()
    rel_dir = (inputs or {}).get("directory", {}).get("data", ".")
    target_dir = _safe_join_under(ws_root, str(rel_dir))

    api_url = str((params or {}).get("api_url") or "http://127.0.0.1:5127").rstrip("/")
    include_ext = _parse_ext_list(str((params or {}).get("include_ext") or ".md,.txt,.py,.ts,.tsx,.json,.yaml,.yml"))
    max_bytes = int(float((params or {}).get("max_bytes") or 200000))
    chunk_max_chars = int(float((params or {}).get("chunk_max_chars") or 4000))
    chunk_overlap_chars = int(float((params or {}).get("chunk_overlap_chars") or 300))
    query = str((params or {}).get("query") or "").strip()
    top_k = int(float((params or {}).get("top_k") or 8))

    context.log("info", "ingest_dir:start", workspace_root=ws_root, directory=str(rel_dir))

    total_files = 0
    indexed_files = 0
    skipped_files = 0
    errors: list[dict] = []

    # Use os.walk so we can prune excluded directories (rglob cannot easily prune)
    for dirpath, dirnames, filenames in os.walk(target_dir):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for fn in filenames:
            total_files += 1
            abs_path = os.path.join(dirpath, fn)
            rel_path = os.path.relpath(abs_path, ws_root).replace("\\", "/")

            if not _is_text_like(abs_path, include_ext):
                skipped_files += 1
                continue

            text = _read_text_best_effort(abs_path, max_bytes=max_bytes)
            if text is None or not text.strip():
                skipped_files += 1
                continue

            uri = f"saw://workspace/{rel_path}"
            meta = {
                "rel_path": rel_path,
                "abs_path": abs_path,
                "workspace_root": ws_root,
            }

            try:
                r = _post_json(
                    f"{api_url}/embed/upsert",
                    {
                        "uri": uri,
                        "doc_type": "file",
                        "content_text": text,
                        "metadata_json": meta,
                        "chunk_max_chars": chunk_max_chars,
                        "chunk_overlap_chars": chunk_overlap_chars,
                    },
                )
                indexed_files += 1
                if indexed_files % 10 == 0:
                    context.log("info", "ingest_dir:progress", indexed=indexed_files, total_seen=total_files)
                _ = r
            except Exception as e:
                errors.append({"path": rel_path, "error": str(e)[:2000]})
                context.log("error", "ingest_dir:file_failed", path=rel_path, error=str(e)[:2000])

    report = {
        "directory": str(rel_dir),
        "workspace_root": ws_root,
        "api_url": api_url,
        "total_files_seen": total_files,
        "indexed_files": indexed_files,
        "skipped_files": skipped_files,
        "errors": errors,
    }
    if query:
        try:
            report["search"] = _post_json(f"{api_url}/search/vector", {"query": query, "top_k": top_k})
        except Exception as e:
            report["search_error"] = str(e)[:2000]
    context.log("info", "ingest_dir:done", **{k: report[k] for k in ("total_files_seen", "indexed_files", "skipped_files")})
    return {"report": {"data": report, "metadata": {}}}


