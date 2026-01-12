"""SAW workspace plugin wrapper for zlab_sorting_script.

This wraps the logic from the notebook `notebooks/z-sort_notebook.ipynb` into a single callable:
  main(inputs: dict, params: dict, context) -> dict
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

class ContextLogHandler(logging.Handler):
    def __init__(self, saw_context: Any) -> None:
        super().__init__(logging.INFO)
        self.saw_context = saw_context
        self.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        self.saw_context.log("info", "zsort", message=self.format(record))

def _configure_logging(context: Any) -> None:
    handler = ContextLogHandler(context)
    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)

def _find_repo_root(seed: Path) -> Path | None:
    cur = seed.resolve()
    for _ in range(12):
        if (cur / "saw-workspace").exists() or (cur / ".git").exists():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent
    return None


def _ensure_src_on_path(context: Any | None = None) -> None:
    """
    Make `sorting_scripts` importable in both:
    - local dev layout
    - SAW sandbox runs (where `__file__` may be copied under `.saw/runs/...`)
    """
    here = Path(__file__).resolve().parent

    candidates: list[Path] = []
    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    if run_dir:
        candidates.append(Path(run_dir))
    candidates.append(Path.cwd())
    candidates.append(here)

    repo_roots: list[Path] = []
    for seed in candidates:
        rr = _find_repo_root(seed)
        if rr and rr not in repo_roots:
            repo_roots.append(rr)

    # Known possible source roots (first match wins)
    src_roots: list[Path] = []
    for repo_root in repo_roots:
        src_roots.extend(
            [
                repo_root / "saw-workspace" / "sources" / "zlab_sorting_script" / "src",
                repo_root / "saw_template" / "sources" / "zlab_sorting_script" / "src",
                # Common dev layout in this codespace: /home/marco/codespace/sorting_script/src
                repo_root.parent / "sorting_script" / "src",
                repo_root / "sorting_script" / "src",
            ]
        )
    # Plugin-local fallback
    src_roots.append(here / "src")

    chosen: Path | None = None
    for p in src_roots:
        if (p / "sorting_scripts").exists():
            chosen = p
            break

    if not chosen:
        msg = "Could not locate sorting_scripts; checked: " + ", ".join(str(p) for p in src_roots)
        if context is not None:
            context.log("error", "zsort:path_error", message=msg, saw_run_dir=run_dir, cwd=str(Path.cwd()))
        raise ModuleNotFoundError(msg)

    src_path = str(chosen)
    if src_path not in sys.path:
        sys.path.insert(0, src_path)
    if context is not None:
        context.log("info", "zsort:src_path", src_path=src_path, saw_run_dir=run_dir, cwd=str(Path.cwd()))


def _write_output_json(name: str, payload: dict[str, Any]) -> str | None:
    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    if not run_dir:
        return None
    out_dir = Path(run_dir) / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return str(p.name)  # relative to output/


def _allocate_free_port(host: str = "127.0.0.1") -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, 0))
        return int(s.getsockname()[1])
    finally:
        try:
            s.close()
        except Exception:
            pass


def _wait_for_tcp(host: str, port: int, timeout_s: float = 10.0) -> bool:
    """
    Return True once TCP connect succeeds to host:port (within timeout), else False.
    """
    deadline = time.time() + float(timeout_s)
    while time.time() < deadline:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        try:
            s.connect((host, int(port)))
            return True
        except Exception:
            time.sleep(0.2)
        finally:
            try:
                s.close()
            except Exception:
                pass
    return False


def _launch_sigui_web(
    *,
    context: Any,
    analyzer_folder: Path,
    address: str = "0.0.0.0",
    port: int | None = None,
    name: str = "SpikeInterface GUI",
) -> dict[str, Any]:
    """
    Launch SpikeInterface GUI (web mode) as a detached subprocess.
    Returns a service dict compatible with SAW's service recorder.
    """
    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    logs_dir = Path(run_dir) / "logs" if run_dir else Path.cwd()
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / "sigui.log"

    port_i = int(port) if port else _allocate_free_port(host=address if address != "0.0.0.0" else "127.0.0.1")

    # Use the venv's console script directly for reliability.
    #
    # IMPORTANT: don't use Path(sys.executable).resolve() here — in some setups
    # the venv python is a symlink to a conda base interpreter, and resolve()
    # would incorrectly point us at conda's bin/ (missing `sigui`).
    venv_bin = Path(sys.executable).parent
    candidates = [venv_bin / "sigui", venv_bin / "sigui.exe"]
    sigui = next((p for p in candidates if p.exists()), None)
    if not sigui:
        which = shutil.which("sigui")
        if which:
            sigui = Path(which)
    if not sigui:
        raise FileNotFoundError(
            f"Could not find `sigui` executable. Tried: {', '.join(str(p) for p in candidates)}"
        )

    cmd = [
        str(sigui),
        str(analyzer_folder),
        "--mode",
        "web",
        "--curation",
        "--address",
        str(address),
        "--port",
        str(port_i),
    ]

    with open(log_path, "a", encoding="utf-8") as f:
        p = subprocess.Popen(  # noqa: S603,S607
            cmd,
            stdout=f,
            stderr=subprocess.STDOUT,
            cwd=str(analyzer_folder),
            start_new_session=True,
        )

    # Wait briefly for the server to bind, otherwise surface the reason from logs.
    ok = _wait_for_tcp("127.0.0.1", port_i, timeout_s=10.0)
    if not ok:
        rc = p.poll()
        tail = ""
        try:
            tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-80:])
        except Exception:
            tail = ""
        if rc is not None:
            raise RuntimeError(f"SIGUI exited immediately (rc={rc}). Last log lines:\n{tail}")
        raise TimeoutError(f"SIGUI did not open port {port_i} within 10s. Last log lines:\n{tail}")

    # "url" is best-effort; in remote setups you'll likely port-forward.
    service = {
        "name": name,
        "pid": int(p.pid) if p.pid else None,
        "port": int(port_i),
        "url": f"http://127.0.0.1:{port_i}",
        "status": "running",
    }
    # Newer runner supports context.service(); fallback to a log-only record.
    if hasattr(context, "service") and callable(getattr(context, "service")):
        try:
            context.service(**service)
        except Exception:
            pass
    context.log("info", "zsort:sigui_launched", **service, cmd=" ".join(cmd), log_path=str(log_path))
    return service


def main(inputs: dict, params: dict, context) -> dict:
    _configure_logging(context)
    context.log(
        "info",
        "zsort:python",
        executable=sys.executable,
        version=sys.version,
        virtual_env=os.environ.get("VIRTUAL_ENV") or "",
    )
    try:
        _ensure_src_on_path(context)

        from sorting_scripts import zsort  # noqa: WPS433
        import spikeinterface.full as si  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        context.log("error", "zsort:import_error", error=str(e), traceback=tb)
        _write_output_json("error.json", {"stage": "import", "error": str(e), "traceback": tb})
        raise

    try:
        patient = str((params or {}).get("patient") or "raw_intan")
        session = str((params or {}).get("session") or "Session1")
        recording_path = str((params or {}).get("recording_path") or "").strip()
        stream_id = str((params or {}).get("stream_id") or "0")
        probe_json = str((params or {}).get("probe_json") or "").strip()
        step = str((params or {}).get("step") or "sort_analyze").strip().lower()
        sigui_address = str((params or {}).get("sigui_address") or "0.0.0.0").strip()
        sigui_port_raw = (params or {}).get("sigui_port")
        sigui_port = int(sigui_port_raw) if str(sigui_port_raw or "").strip() else None

        context.log(
            "info",
            "zsort:start",
            patient=patient,
            session=session,
            recording_path=recording_path,
            stream_id=stream_id,
            probe_json=probe_json,
            step=step,
        )

        path_dict = zsort.set_paths(patient, session)

        # GUI-only mode: do not run sorting/analyzing/curation, just launch SIGUI for an existing analyzer folder.
        if step in ("gui", "launch_gui", "sigui"):
            analyzer_folder = Path(path_dict["analyzer_folder"])
            if not analyzer_folder.exists():
                raise FileNotFoundError(
                    f"Analyzer folder does not exist: {analyzer_folder}\n"
                    'Run step="analyze" (or "sort_analyze") first.'
                )
            service = _launch_sigui_web(
                context=context,
                analyzer_folder=analyzer_folder,
                address=sigui_address,
                port=sigui_port,
                name=f"SIGUI curation: {patient}/{session}",
            )
            return {
                "summary": {
                    "data": {
                        "patient": patient,
                        "session": session,
                        "step": step,
                        "analyzer_folder": str(analyzer_folder),
                        "sigui": service,
                    },
                    "metadata": {},
                }
            }

        # Load recording
        if recording_path:
            rec = si.read_intan(recording_path, stream_id=stream_id)
            path_dict["intan_file"] = recording_path
        else:
            intan_file = path_dict.get("intan_file")
            if not intan_file:
                raise FileNotFoundError(
                    "No recording_path provided and no .rhd found under "
                    f"{path_dict.get('session_location')}. Set params.recording_path."
                )
            rec = si.read_intan(str(intan_file), stream_id=stream_id)

        # Attach probe
        if probe_json:
            rec = zsort.set_probe(rec, path_dict, probe_json)

        sorting = None
        analyzer = None
        curated = None

        def need_sort() -> bool:
            return step in ("sort", "sort_analyze", "analyze", "curate", "figures", "all")

        def need_analyze() -> bool:
            return step in ("analyze", "sort_analyze", "curate", "figures", "all")

        def need_curate() -> bool:
            return step in ("curate", "figures", "all")

        def need_figures() -> bool:
            return step in ("figures", "all")

        if need_sort():
            sorting = zsort.sort_stuff(rec, path_dict)
        if need_analyze():
            if sorting is None:
                sorting = zsort.sort_stuff(rec, path_dict)
            analyzer = zsort.analyze_stuff(rec, sorting, path_dict)
        if need_curate():
            if analyzer is None:
                if sorting is None:
                    sorting = zsort.sort_stuff(rec, path_dict)
                analyzer = zsort.analyze_stuff(rec, sorting, path_dict)
            try:
                curated = zsort.save_curated_data(patient, session, analyzer, path_dict)
            except FileNotFoundError as e:
                # If the user hasn't saved curation yet, launch the GUI instead of failing.
                analyzer_folder = Path(path_dict["analyzer_folder"])
                service = _launch_sigui_web(
                    context=context,
                    analyzer_folder=analyzer_folder,
                    address=sigui_address,
                    port=sigui_port,
                    name=f"SIGUI curation: {patient}/{session}",
                )
                return {
                    "summary": {
                        "data": {
                            "patient": patient,
                            "session": session,
                            "step": step,
                            "message": str(e),
                            "analyzer_folder": str(analyzer_folder),
                            "sigui": service,
                        },
                        "metadata": {},
                    }
                }
        if need_figures():
            if curated is None:
                raise RuntimeError('figures requires "curate" step first (needs curated analyzer).')
            zsort.generate_figures(curated, path_dict)

        summary = {
            "patient": patient,
            "session": session,
            "step": step,
            "paths": {k: str(v) for (k, v) in (path_dict or {}).items()},
        }
        summary_json = _write_output_json("summary.json", summary)
        if summary_json:
            summary["outputs_dir_file"] = summary_json

        return {"summary": {"data": summary, "metadata": {}}}
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        context.log("error", "zsort:runtime_error", error=str(e), traceback=tb)
        _write_output_json("error.json", {"stage": "runtime", "error": str(e), "traceback": tb})
        raise

