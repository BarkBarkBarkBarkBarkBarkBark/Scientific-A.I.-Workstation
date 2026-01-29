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

import httpx


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


def _as_bool(value, default: bool = False) -> bool:
  if value is None:
    return default
  if isinstance(value, bool):
    return value
  if isinstance(value, (int, float)):
    return bool(value)
  s = str(value).strip().lower()
  if s in {"1", "true", "t", "yes", "y", "on"}:
    return True
  if s in {"0", "false", "f", "no", "n", "off"}:
    return False
  return default


def _fetch_simple_graph(
  *,
  api_base_url: str,
  repo_root: str,
  include_python: bool,
  include_ts: bool,
  include_tests: bool,
  scope_prefix: str,
  max_files: int,
) -> dict:
  base = (api_base_url or "").rstrip("/")
  url = f"{base}/repo-intel/simple-graph"
  with httpx.Client(timeout=60) as client:
    resp = client.get(
      url,
      params={
        "repo_root": repo_root,
        "include_python": include_python,
        "include_ts": include_ts,
        "include_tests": include_tests,
        "scope_prefix": scope_prefix,
        "max_files": max_files,
      },
    )
    resp.raise_for_status()
    return resp.json()


def main(inputs, params, context):
  plugin_dir = Path(__file__).resolve().parent

  host = "127.0.0.1"

  # Default to the repo root. This plugin lives at:
  #   ./saw-workspace/plugins/<id>/
  # so repo root is parents[2] (repo_intel_viewer -> plugins -> saw-workspace -> <repo root>).
  default_repo_root = str(plugin_dir.parents[2])

  params = params or {}
  repo_root = (
    str(params.get("repo_root") or "").strip()
    or os.environ.get("SAW_REPO_ROOT")
    or default_repo_root
  )

  # Per UX: scan all supported files, all the time.
  include_python = True
  include_ts = True
  include_tests = True
  scope_prefix = ""
  try:
    max_files = int(params.get("max_files") or 6000)
  except Exception:
    max_files = 6000
  launch_viewer = _as_bool(params.get("launch_viewer"), False)

  env = dict(os.environ)
  env.setdefault("SAW_REPO_ROOT", repo_root)
  env.setdefault("SAW_API_URL", "http://127.0.0.1:5127")
  api_url = env.get("SAW_API_URL") or "http://127.0.0.1:5127"

  url = ""
  port = None

  # Always do a scan so the default Run button is useful.
  try:
    graph = _fetch_simple_graph(
      api_base_url=api_url,
      repo_root=repo_root,
      include_python=include_python,
      include_ts=include_ts,
      include_tests=include_tests,
      scope_prefix=scope_prefix,
      max_files=max_files,
    )
    stats = graph.get("stats") or {}
  except Exception as e:
    return {
      "status": {
        "data": f"Repo Intel scan failed: {e}",
        "metadata": {
          "repo_root": repo_root,
          "api_url": api_url,
          "node_count": 0,
          "edge_count": 0,
          "not_imported_count": 0,
          "isolated_count": 0,
          "url": "",
        },
      }
    }

  if launch_viewer:
    port = _choose_free_port(host, (5210, 5299))
    url = f"http://{host}:{port}/"
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

  node_count = int(stats.get("node_count") or 0)
  edge_count = int(stats.get("edge_count") or 0)
  not_imported_count = int(stats.get("not_imported_count") or 0)
  isolated_count = int(stats.get("isolated_count") or 0)

  if launch_viewer:
    msg = f"Scan complete: {node_count} files, {edge_count} edges. Viewer: {url}"
  else:
    msg = f"Scan complete: {node_count} files, {edge_count} edges. (Click 'Launch Viewer' to open graph)"

  return {
    "status": {
      "data": msg,
      "metadata": {
        "repo_root": repo_root,
        "api_url": api_url,
        "node_count": node_count,
        "edge_count": edge_count,
        "not_imported_count": not_imported_count,
        "isolated_count": isolated_count,
        "url": url,
        "host": host,
        "port": port,
      },
    }
  }
