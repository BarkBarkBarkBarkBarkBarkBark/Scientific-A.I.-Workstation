from __future__ import annotations

import json
import os
import secrets
import subprocess
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from .db import db_conn, jsonb
from .env_manager import compute_env_resolution, ensure_env
from .service_manager import record_service
from .settings import Settings


RunStatus = Literal["queued", "running", "succeeded", "failed"]


@dataclass(frozen=True)
class RunStart:
    run_id: str
    status: RunStatus
    env_key: str
    run_dir: str


@dataclass(frozen=True)
class RunInfo:
    plugin_id: str
    run_id: str
    status: RunStatus
    env_key: str | None
    run_dir: str
    created_at: str | None
    started_at: str | None
    finished_at: str | None
    outputs: dict[str, Any]
    services: list[dict[str, Any]]
    error_text: str | None
    logs_path: str


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _utc_iso_compact() -> str:
    # 2026-01-07T12:34:56Z -> 20260107T123456Z
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def generate_run_id() -> str:
    return f"{_utc_iso_compact()}_{secrets.token_hex(4)}"


def _safe_dir_name(s: str) -> str:
    # allow a-zA-Z0-9._- only; replace others with '_'
    out = []
    for ch in (s or ""):
        if ch.isalnum() or ch in (".", "_", "-"):
            out.append(ch)
        else:
            out.append("_")
    return "".join(out) or "unknown"


def run_root(settings: Settings) -> str:
    repo_root = _repo_root_from_workspace(settings.workspace_root)
    return os.path.join(repo_root, ".saw", "runs")


def run_dir(settings: Settings, plugin_id: str, run_id: str) -> str:
    return os.path.join(run_root(settings), _safe_dir_name(plugin_id), _safe_dir_name(run_id))


def ensure_run_dir_layout(settings: Settings, plugin_id: str, run_id: str) -> str:
    rd = run_dir(settings, plugin_id, run_id)
    for child in ("input", "work", "output", "logs"):
        os.makedirs(os.path.join(rd, child), exist_ok=True)
    return rd


def write_run_json(run_dir: str, payload: dict[str, Any]) -> str:
    path = os.path.join(run_dir, "run.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
    return path


def _read_json(path: str) -> dict[str, Any]:
    try:
        raw = open(path, "r", encoding="utf-8").read()
        obj = json.loads(raw or "{}")
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _write_json(path: str, payload: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)


def update_run_json(run_dir: str, patch: dict[str, Any]) -> None:
    path = os.path.join(run_dir, "run.json")
    cur = _read_json(path)
    cur.update(patch or {})
    _write_json(path, cur)


def _log_path(run_dir: str) -> str:
    return os.path.join(run_dir, "logs", "plugin.log")


def _results_path(run_dir: str) -> str:
    return os.path.join(run_dir, "output", "results.json")


def _append_log(path: str, line: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
        if not line.endswith("\n"):
            f.write("\n")


def _validate_output_paths(outputs: Any, output_dir: str) -> None:
    """
    MVP policy: any value in outputs where the key suggests a path must be under output_dir.
    Keys checked: 'path', '*_path', '*Path', 'file', '*_file'
    """
    out_root = os.path.abspath(output_dir)

    def is_path_key(k: str) -> bool:
        kl = (k or "").lower()
        return kl == "path" or kl.endswith("_path") or kl.endswith("path") or kl == "file" or kl.endswith("_file")

    def check_value(val: Any) -> None:
        if not isinstance(val, str):
            return
        s = val.strip()
        if not s:
            return
        # Interpret relative paths as relative to output_dir (so wrappers can return "foo.txt").
        abs_p = s if os.path.isabs(s) else os.path.abspath(os.path.join(out_root, s))
        if not abs_p.startswith(out_root):
            raise RuntimeError(f"output_path_outside_run_output: {s}")

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k, v in x.items():
                if is_path_key(str(k)):
                    check_value(v)
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(outputs)


def _db_try_insert_run(settings: Settings, payload: dict[str, Any]) -> None:
    try:
        with db_conn(settings) as conn:
            conn.execute(
                """
                INSERT INTO saw_runs(plugin_id, plugin_version, run_id, env_key, run_dir, status, created_at, inputs_json, params_json)
                VALUES (%s, %s, %s, %s, %s, %s, now(), %s, %s)
                ON CONFLICT (run_id) DO NOTHING
                """,
                (
                    payload.get("plugin_id"),
                    payload.get("plugin_version"),
                    payload.get("run_id"),
                    payload.get("env_key"),
                    payload.get("run_dir"),
                    payload.get("status"),
                    jsonb(payload.get("inputs") or {}),
                    jsonb(payload.get("params") or {}),
                ),
            )
    except Exception:
        # Pre-migration or DB down -> best-effort
        pass


def _db_try_update_run(
    settings: Settings,
    *,
    run_id: str,
    status: RunStatus,
    outputs_json: dict[str, Any] | None = None,
    error_text: str | None = None,
    started: bool = False,
    finished: bool = False,
) -> None:
    try:
        with db_conn(settings) as conn:
            if started:
                conn.execute(
                    "UPDATE saw_runs SET status=%s, started_at=now() WHERE run_id=%s",
                    (status, run_id),
                )
                return
            if finished:
                conn.execute(
                    "UPDATE saw_runs SET status=%s, finished_at=now(), outputs_json=%s, error_text=%s WHERE run_id=%s",
                    (status, jsonb(outputs_json or {}), error_text, run_id),
                )
                return
            conn.execute("UPDATE saw_runs SET status=%s WHERE run_id=%s", (status, run_id))
    except Exception:
        pass


def spawn_run(
    settings: Settings,
    *,
    plugin_id: str,
    plugin_version: str,
    plugin_dir: str,
    entry_file: str,
    entry_callable: str,
    env_python: str | None,
    env_lockfile: str | None,
    env_requirements: str | None,
    env_pip: list[str] | None,
    inputs: dict[str, Any],
    params: dict[str, Any],
) -> RunStart:
    """
    Create run_dir + run.json, insert DB row (best-effort), and start a background thread.
    """
    run_id = generate_run_id()
    rd = ensure_run_dir_layout(settings, plugin_id, run_id)
    log_path = _log_path(rd)

    # Compute env_key and ensure cached environment exists.
    er = compute_env_resolution(
        settings=settings,
        plugin_dir=plugin_dir,
        plugin_id=plugin_id,
        plugin_version=plugin_version,
        env_python=env_python,
        env_lockfile=env_lockfile,
        env_requirements=env_requirements,
        env_pip=env_pip or [],
        extras={"cuda": "none"},
    )

    run_payload = {
        "plugin_id": plugin_id,
        "plugin_version": plugin_version,
        "run_id": run_id,
        "env_key": er.env_key,
        "run_dir": rd,
        "inputs": inputs or {},
        "params": params or {},
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "queued",
        "entrypoint": {"file": entry_file, "callable": entry_callable},
        "plugin_dir": plugin_dir,
    }
    run_json_path = write_run_json(rd, run_payload)
    _db_try_insert_run(settings, run_payload)

    def worker() -> None:
        try:
            _append_log(log_path, f"[run] start run_id={run_id} plugin_id={plugin_id} env_key={er.env_key}")
            update_run_json(rd, {"status": "running", "started_at": datetime.now(timezone.utc).isoformat()})
            _db_try_update_run(settings, run_id=run_id, status="running", started=True)

            # Ensure cached environment exists (may take time); do it in the background thread
            py = ensure_env(settings, er.env_key, er.deps, plugin_dir=plugin_dir)

            runner = os.path.abspath(os.path.join(os.path.dirname(__file__), "plugin_runner.py"))
            env = dict(os.environ)
            env["SAW_RUN_DIR"] = rd
            env["SAW_PLUGIN_ID"] = plugin_id
            env["SAW_ENV_KEY"] = er.env_key
            env["SAW_SERVICE_PORTS_JSON"] = "{}"

            cmd = [
                py,
                runner,
                "--run-dir",
                rd,
                "--run-json",
                run_json_path,
                "--plugin-dir",
                plugin_dir,
                "--entry-file",
                entry_file,
                "--callable",
                entry_callable,
            ]
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                cwd=plugin_dir,
                text=True,
                bufsize=1,
            )
            assert p.stdout is not None
            for line in p.stdout:
                _append_log(log_path, line.rstrip("\n"))
            rc = p.wait()
            if rc != 0:
                raise RuntimeError(f"plugin_failed rc={rc}")

            # Runner should write output/results.json
            res_path = _results_path(rd)
            if not os.path.isfile(res_path):
                raise RuntimeError("missing_results_json")
            raw = json.loads(open(res_path, "r", encoding="utf-8").read() or "{}")
            outputs = raw.get("outputs") if isinstance(raw, dict) else {}
            _validate_output_paths(outputs, os.path.join(rd, "output"))

            # Best-effort: persist any declared services (if present).
            try:
                services = raw.get("services") if isinstance(raw, dict) else None
                if isinstance(services, list):
                    for s in services:
                        if not isinstance(s, dict):
                            continue
                        _ = record_service(
                            settings,
                            plugin_id=plugin_id,
                            run_id=run_id,
                            name=str(s.get("name") or ""),
                            pid=int(s["pid"]) if s.get("pid") is not None else None,
                            port=int(s["port"]) if s.get("port") is not None else None,
                            url=str(s.get("url")) if s.get("url") else None,
                            status=str(s.get("status") or "running"),
                            service_id=str(s.get("service_id")) if s.get("service_id") else None,
                        )
            except Exception:
                pass

            _db_try_update_run(settings, run_id=run_id, status="succeeded", outputs_json=raw, finished=True)
            update_run_json(
                rd,
                {"status": "succeeded", "finished_at": datetime.now(timezone.utc).isoformat(), "error_text": None},
            )
            _append_log(log_path, "[run] succeeded")
        except Exception as e:
            _append_log(log_path, f"[run] failed error={type(e).__name__}: {e}")
            _db_try_update_run(settings, run_id=run_id, status="failed", outputs_json={}, error_text=str(e)[:4000], finished=True)
            update_run_json(
                rd,
                {"status": "failed", "finished_at": datetime.now(timezone.utc).isoformat(), "error_text": str(e)[:4000]},
            )

    t = threading.Thread(target=worker, name=f"saw_run_{plugin_id}_{run_id}", daemon=True)
    t.start()
    return RunStart(run_id=run_id, status="queued", env_key=er.env_key, run_dir=rd)


def get_run(settings: Settings, plugin_id: str, run_id: str) -> RunInfo | None:
    """
    Best-effort fetch: prefer DB if available, else fall back to run.json/results.json.
    """
    pid = _safe_dir_name(plugin_id)
    rid = _safe_dir_name(run_id)
    rd = run_dir(settings, pid, rid)
    logs_path = _log_path(rd)

    # Try DB first
    try:
        with db_conn(settings) as conn:
            row = conn.execute(
                """
                SELECT plugin_id, run_id, status, env_key, run_dir,
                       created_at::text, started_at::text, finished_at::text,
                       outputs_json, error_text
                FROM saw_runs
                WHERE plugin_id=%s AND run_id=%s
                """,
                (plugin_id, run_id),
            ).fetchone()
            if row:
                (p_id, r_id, status, env_key, run_dir_db, created_at, started_at, finished_at, outputs_json, error_text) = row
                outputs_obj = outputs_json if isinstance(outputs_json, dict) else {}
                services: list[dict[str, Any]] = []
                try:
                    srows = conn.execute(
                        """
                        SELECT service_id, name, pid, port, url, status, created_at::text, updated_at::text
                        FROM saw_services
                        WHERE plugin_id=%s AND run_id=%s
                        ORDER BY created_at ASC
                        """,
                        (plugin_id, run_id),
                    ).fetchall()
                    for (service_id, name, pidv, port, url, sstatus, cat, uat) in srows:
                        services.append(
                            {
                                "service_id": service_id,
                                "name": name,
                                "pid": pidv,
                                "port": port,
                                "url": url,
                                "status": sstatus,
                                "created_at": cat,
                                "updated_at": uat,
                            }
                        )
                except Exception:
                    services = []

                return RunInfo(
                    plugin_id=str(p_id),
                    run_id=str(r_id),
                    status=str(status),
                    env_key=str(env_key) if env_key else None,
                    run_dir=str(run_dir_db),
                    created_at=str(created_at) if created_at else None,
                    started_at=str(started_at) if started_at else None,
                    finished_at=str(finished_at) if finished_at else None,
                    outputs=outputs_obj if isinstance(outputs_obj, dict) else {},
                    services=services,
                    error_text=str(error_text) if error_text else None,
                    logs_path=logs_path,
                )
    except Exception:
        pass

    # Filesystem fallback
    rj = _read_json(os.path.join(rd, "run.json"))
    if not rj:
        return None
    status = str(rj.get("status") or "queued")
    res = _read_json(_results_path(rd))
    outputs_obj = res.get("outputs") if isinstance(res.get("outputs"), dict) else {}
    services_obj = res.get("services") if isinstance(res.get("services"), list) else []
    return RunInfo(
        plugin_id=str(rj.get("plugin_id") or plugin_id),
        run_id=str(rj.get("run_id") or run_id),
        status=status if status in ("queued", "running", "succeeded", "failed") else "queued",
        env_key=str(rj.get("env_key")) if rj.get("env_key") else None,
        run_dir=str(rj.get("run_dir") or rd),
        created_at=str(rj.get("created_at")) if rj.get("created_at") else None,
        started_at=str(rj.get("started_at")) if rj.get("started_at") else None,
        finished_at=str(rj.get("finished_at")) if rj.get("finished_at") else None,
        outputs=outputs_obj,
        services=[s for s in services_obj if isinstance(s, dict)],
        error_text=str(rj.get("error_text")) if rj.get("error_text") else None,
        logs_path=logs_path,
    )


