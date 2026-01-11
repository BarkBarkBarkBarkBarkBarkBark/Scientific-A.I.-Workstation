"""SAW Plugin: Template Plugin (Copy Me)

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - Each input/output value is: {"data": <value>, "metadata": <dict>}
  - Return value is: {<output_name>: {"data": ..., "metadata": {...}}, ...}

Notes:
  - Use SAW_WORKSPACE_ROOT to safely resolve workspace-relative paths.
  - Use SAW_RUN_DIR if you want to write run artifacts (respect manifest side_effects.disk).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _workspace_root() -> str:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    # fallback: <repo>/saw-workspace/plugins/<this-plugin> -> <repo>/saw-workspace
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


def _truthy(s: str) -> bool:
    return str(s or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _write_run_output_json(filename: str, payload: dict[str, Any]) -> str | None:
    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    if not run_dir:
        return None
    out_dir = Path(run_dir) / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / filename
    p.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return str(p.name)  # relative to output/


def main(inputs: dict, params: dict, context) -> dict:
    in_obj = ((inputs or {}).get("in_obj") or {}).get("data")
    in_path = str(((inputs or {}).get("in_path") or {}).get("data") or "").strip()

    message = str((params or {}).get("message") or "").strip()
    preview_bytes = int(float((params or {}).get("preview_bytes") or 256))
    preview_bytes = max(0, min(10_000, preview_bytes))
    write_run_output = _truthy(str((params or {}).get("write_run_output") or "false"))

    context.log(
        "info",
        "template:start",
        inputs=list((inputs or {}).keys()),
        params=list((params or {}).keys()),
        write_run_output=write_run_output,
    )

    ws_root = _workspace_root()
    preview: dict[str, Any] | None = None
    if in_path:
        abs_path = _safe_join_under(ws_root, in_path)
        if os.path.isfile(abs_path) and preview_bytes > 0:
            with open(abs_path, "rb") as f:
                b = f.read(preview_bytes)
            preview = {
                "path": in_path,
                "bytes": len(b),
                "head_hex": b.hex(),
            }
        else:
            preview = {"path": in_path, "bytes": 0, "head_hex": ""}

    result: dict[str, Any] = {
        "message": message,
        "echo": {"in_obj": in_obj, "in_path": in_path},
        "file_preview": preview,
    }

    if write_run_output:
        out_name = _write_run_output_json("template_output.json", result)
        if out_name:
            result["run_output_file"] = out_name

    context.log("info", "template:done")
    return {"result": {"data": result, "metadata": {"plugin": "saw.template.plugin"}}}


