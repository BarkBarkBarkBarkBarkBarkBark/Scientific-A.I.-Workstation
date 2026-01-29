def find_free_port(start=5210, end=5299):
    for port in range(start, end+1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("No free port found in range")
def main(inputs, params, context):
    port = find_free_port()
    cwd = os.path.dirname(os.path.abspath(__file__))
    app_path = os.path.join(cwd, "viewer_app.py")
    url = f"http://127.0.0.1:{port}/"
    proc = subprocess.Popen([
        sys.executable, "-m", "uvicorn", f"viewer_app:app", "--host", "127.0.0.1", "--port", str(port)
    ], cwd=cwd)
    # Optionally open browser (non-blocking)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    return {"url": url, "pid": proc.pid}
"""SAW Plugin: Repo Intel Viewer

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - Each input/output value is: {"data": <value>, "metadata": <dict>}
  - Return value is: {<output_name>: {"data": ..., "metadata": {...}}, ...}

Notes:
  - Use SAW_WORKSPACE_ROOT to safely resolve workspace-relative paths.
  - Use SAW_RUN_DIR if you want to write run artifacts (respect manifest side_effects.disk).
"""

import os
import sys
import socket
import subprocess
import webbrowser
from pathlib import Path

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
        raise ValueError("path escapes workspace root")
    return abs_path

def find_free_port(start=5210, end=5299):
    for port in range(start, end+1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("No free port found in range")

def main(inputs, params, context):
    port = find_free_port()
    cwd = os.path.dirname(os.path.abspath(__file__))
    app_path = os.path.join(cwd, "viewer_app.py")
    url = f"http://127.0.0.1:{port}/"
    proc = subprocess.Popen([
        sys.executable, "-m", "uvicorn", f"viewer_app:app", "--host", "127.0.0.1", "--port", str(port)
    ], cwd=cwd)
    # Optionally open browser (non-blocking)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    return {"url": {"data": url, "metadata": {}}, "pid": {"data": proc.pid, "metadata": {}}}
