"""SAW workspace plugin wrapper for zlab_sorting_script.

This wraps the logic from the notebook `notebooks/z-sort_notebook.ipynb` into a single callable:
  main(inputs: dict, params: dict, context) -> dict
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _ensure_src_on_path() -> None:
    here = Path(__file__).resolve().parent
    # Prefer the workspace-shared source layout:
    # 1) <repo_root>/saw-workspace/sources/zlab_sorting_script/src
    # 2) <repo_root>/saw_template/sources/zlab_sorting_script/src
    # 3) fallback to plugin-local src/
    repo_root = here
    for _ in range(6):
        if (repo_root / "saw-workspace").exists() or (repo_root / ".git").exists():
            break
        repo_root = repo_root.parent

    ws_shared_src = repo_root / "saw-workspace" / "sources" / "zlab_sorting_script" / "src"
    template_shared_src = repo_root / "saw_template" / "sources" / "zlab_sorting_script" / "src"

    if ws_shared_src.exists():
        src_path = str(ws_shared_src)
    elif template_shared_src.exists():
        src_path = str(template_shared_src)
    else:
        # Fallback to plugin-local src for backwards compatibility
        src_path = str(here / "src")

    if src_path not in sys.path:
        sys.path.insert(0, src_path)


def _write_output_json(name: str, payload: dict[str, Any]) -> str | None:
    run_dir = os.environ.get("SAW_RUN_DIR") or ""
    if not run_dir:
        return None
    out_dir = Path(run_dir) / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / name
    p.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return str(p.name)  # relative to output/


def main(inputs: dict, params: dict, context) -> dict:
    _ensure_src_on_path()

    from sorting_scripts import zsort  # noqa: WPS433
    import spikeinterface.full as si  # noqa: WPS433

    patient = str((params or {}).get("patient") or "raw_intan")
    session = str((params or {}).get("session") or "Session1")
    recording_path = str((params or {}).get("recording_path") or "").strip()
    stream_id = str((params or {}).get("stream_id") or "0")
    probe_json = str((params or {}).get("probe_json") or "").strip()
    step = str((params or {}).get("step") or "sort_analyze").strip().lower()

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
        curated = zsort.save_curated_data(patient, session, analyzer, path_dict)
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

