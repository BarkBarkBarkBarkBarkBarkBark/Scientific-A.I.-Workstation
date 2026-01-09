"""SAW Plugin: Load CSV

Output table format:
  {
    "columns": [str, ...],
    "rows": [ {col: value, ...}, ... ],
    "n_rows": int
  }
"""

from __future__ import annotations

import csv
import os


def _workspace_root() -> str:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(__file__)
    return os.path.abspath(os.path.join(here, "..", ".."))


def _safe_join_under(root: str, rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        raise ValueError("missing_path")
    if rel.startswith("/") or rel.startswith("~"):
        raise ValueError("path must be workspace-relative")
    if rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("path traversal is not allowed")
    abs_path = os.path.abspath(os.path.join(root, rel))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        raise ValueError("path must be inside saw-workspace/")
    return abs_path


def _maybe_number(x: str):
    s = (x or "").strip()
    if s == "":
        return ""
    try:
        if any(c in s for c in (".", "e", "E")):
            return float(s)
        return int(s)
    except Exception:
        return s


def main(inputs: dict, params: dict, context) -> dict:
    _ = inputs
    ws_root = _workspace_root()
    rel_path = str((params or {}).get("path") or "").strip()
    delim = str((params or {}).get("delimiter") or ",")
    if delim == "\\t":
        delim = "\t"

    abs_path = _safe_join_under(ws_root, rel_path)
    context.log("info", "load_csv:start", path=rel_path, delimiter=delim)

    with open(abs_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter=delim)
        cols = list(reader.fieldnames or [])
        rows = []
        for row in reader:
            rows.append({k: _maybe_number(row.get(k, "")) for k in cols})

    out = {"columns": cols, "rows": rows, "n_rows": len(rows), "path": rel_path}
    return {"df": {"data": out, "metadata": {}}}


