"""SAW Plugin: Repo Intel Viewer

Launches a small local FastAPI server that renders a repo import graph.

Contract:
  - main(inputs: dict, params: dict, context) -> dict
  - Each input/output value is: {"data": <value>, "metadata": <dict>}
  - Return value is: {<output_name>: {"data": ..., "metadata": {...}}, ...}
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path


def _choose_free_port(host: str, port_range: tuple[int, int]) -> int:
  start, end = port_range
  for port in range(start, end + 1):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
      s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
      try:
        s.bind((host, port))
        return port
      except OSError:
        continue
  raise RuntimeError(f"No free port found in range {start}-{end}")


def main(inputs, params, context):
  plugin_dir = Path(__file__).resolve().parent

  host = "127.0.0.1"
  port = _choose_free_port(host, (5210, 5299))
  url = f"http://{host}:{port}/"

  # Prefer SAW-provided workspace root; fall back to current working directory.
  repo_root = os.environ.get("SAW_WORKSPACE_ROOT") or str(Path.cwd())

  env = dict(os.environ)
  env.setdefault("SAW_REPO_ROOT", repo_root)
  env.setdefault("SAW_API_URL", "http://127.0.0.1:5127")

  cmd = [
    sys.executable,
    "-m",
    "uvicorn",
    "viewer_app:app",
    "--host",
    host,
    "--port",
    str(port),
    "--log-level",
    "warning",
  ]

  # Detach so the server keeps running after the plugin call returns.
  subprocess.Popen(
    cmd,
    cwd=str(plugin_dir),
    env=env,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
  )

  # Best-effort: open browser to the viewer URL.
  try:
    webbrowser.open(url, new=2)
  except Exception:
    pass

  return {
    "status": {
      "data": f"Repo Intel Viewer started: {url} (repo_root={repo_root})",
      "metadata": {"url": url, "host": host, "port": port, "repo_root": repo_root},
    }
  }
