"""SAW Utility: Streamlit RAG Explorer."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def _workspace_root(plugin_dir: Path) -> Path:
    return Path(os.environ.get("SAW_WORKSPACE_ROOT") or plugin_dir.parents[2]).resolve()


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


def _healthcheck(url: str, timeout_s: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout_s) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _state_path(workspace_root: Path, plugin_id: str) -> Path:
    return workspace_root / ".saw" / "utilities" / f"{plugin_id}.json"


def _load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _launch_streamlit(app_file: Path, host: str, port: int, env: dict) -> None:
    cmd = [
        sys.executable,
        "-m",
        "streamlit",
        "run",
        str(app_file),
        "--server.headless",
        "true",
        "--server.address",
        host,
        "--server.port",
        str(port),
        "--server.fileWatcherType",
        "none",
    ]
    subprocess.Popen(
        cmd,
        cwd=str(app_file.parent),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def main(inputs: dict, params: dict, context) -> dict:
    plugin_dir = Path(__file__).resolve().parent
    workspace_root = _workspace_root(plugin_dir)
    host = "127.0.0.1"
    port_range = (8690, 8779)

    params = params or {}
    api_url = str(params.get("api_url") or "").strip() or os.environ.get("SAW_API_URL") or "http://127.0.0.1:5127"

    state_path = _state_path(workspace_root, "saw.utility.rag_explorer")
    state = _load_state(state_path)
    url = str(state.get("url") or "")

    if url and _healthcheck(url + "/_stcore/health"):
        context.log("info", "rag_explorer:reuse", url=url)
    else:
        port = _choose_free_port(host, port_range)
        url = f"http://{host}:{port}"
        env = dict(os.environ)
        env["SAW_WORKSPACE_ROOT"] = str(workspace_root)
        env["SAW_API_URL"] = api_url

        app_file = plugin_dir / "streamlit_app.py"
        _launch_streamlit(app_file, host, port, env)

        time.sleep(0.2)
        _save_state(state_path, {"url": url, "port": port, "api_url": api_url})
        context.log("info", "rag_explorer:launched", url=url, port=port, api_url=api_url)

    return {
        "result": {
            "data": {
                "url": url,
            },
            "metadata": {},
        }
    }
