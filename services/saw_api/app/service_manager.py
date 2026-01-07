from __future__ import annotations

import json
import os
import secrets
import signal
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from .db import db_conn, jsonb
from .settings import Settings


ServiceStatus = Literal["running", "stale", "stopped", "unknown"]


@dataclass(frozen=True)
class ServiceRecord:
    service_id: str
    plugin_id: str
    run_id: str
    name: str
    pid: int | None
    port: int | None
    url: str | None
    status: ServiceStatus
    created_at: str
    updated_at: str


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def services_dir(settings: Settings) -> str:
    repo_root = _repo_root_from_workspace(settings.workspace_root)
    return os.path.join(repo_root, ".saw", "services")


def generate_service_id() -> str:
    return f"svc_{secrets.token_hex(4)}"


def allocate_free_local_port(
    *,
    host: str = "127.0.0.1",
    port_min: int = 49152,
    port_max: int = 65535,
    retries: int = 50,
) -> int:
    if port_min <= 0 or port_max <= 0 or port_max < port_min:
        raise ValueError("invalid_port_range")
    for _ in range(max(1, int(retries))):
        port = secrets.randbelow(port_max - port_min + 1) + port_min
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            return port
        except OSError:
            continue
        finally:
            try:
                s.close()
            except Exception:
                pass
    raise RuntimeError("port_allocation_failed")


def _record_path(settings: Settings, service_id: str) -> str:
    return os.path.join(services_dir(settings), f"{service_id}.json")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pid_is_running(pid: int) -> bool:
    try:
        if pid <= 0:
            return False
        if os.name == "nt":
            # Best-effort; no kill(0). Treat as unknown -> True.
            return True
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def write_service_record(settings: Settings, rec: ServiceRecord) -> None:
    os.makedirs(services_dir(settings), exist_ok=True)
    path = _record_path(settings, rec.service_id)
    payload = {
        "service_id": rec.service_id,
        "plugin_id": rec.plugin_id,
        "run_id": rec.run_id,
        "name": rec.name,
        "pid": rec.pid,
        "port": rec.port,
        "url": rec.url,
        "status": rec.status,
        "created_at": rec.created_at,
        "updated_at": rec.updated_at,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)


def read_service_record(settings: Settings, service_id: str) -> ServiceRecord | None:
    path = _record_path(settings, service_id)
    try:
        raw = json.loads(open(path, "r", encoding="utf-8").read() or "{}")
        if not isinstance(raw, dict):
            return None
        return ServiceRecord(
            service_id=str(raw.get("service_id") or service_id),
            plugin_id=str(raw.get("plugin_id") or ""),
            run_id=str(raw.get("run_id") or ""),
            name=str(raw.get("name") or ""),
            pid=int(raw["pid"]) if raw.get("pid") is not None else None,
            port=int(raw["port"]) if raw.get("port") is not None else None,
            url=str(raw.get("url")) if raw.get("url") else None,
            status=str(raw.get("status") or "unknown"),
            created_at=str(raw.get("created_at") or ""),
            updated_at=str(raw.get("updated_at") or ""),
        )
    except Exception:
        return None


def db_upsert_service(settings: Settings, rec: ServiceRecord) -> None:
    try:
        with db_conn(settings) as conn:
            conn.execute(
                """
                INSERT INTO saw_services(service_id, plugin_id, run_id, name, pid, port, url, status, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (service_id) DO UPDATE
                  SET pid=EXCLUDED.pid,
                      port=EXCLUDED.port,
                      url=EXCLUDED.url,
                      status=EXCLUDED.status,
                      updated_at=now()
                """,
                (rec.service_id, rec.plugin_id, rec.run_id, rec.name, rec.pid, rec.port, rec.url, rec.status),
            )
    except Exception:
        pass


def record_service(
    settings: Settings,
    *,
    plugin_id: str,
    run_id: str,
    name: str,
    pid: int | None,
    port: int | None,
    url: str | None,
    status: ServiceStatus,
    service_id: str | None = None,
) -> ServiceRecord:
    sid = (service_id or "").strip() or generate_service_id()
    now = _now_iso()
    rec = ServiceRecord(
        service_id=sid,
        plugin_id=plugin_id,
        run_id=run_id,
        name=name,
        pid=pid,
        port=port,
        url=url,
        status=status,
        created_at=now,
        updated_at=now,
    )
    write_service_record(settings, rec)
    db_upsert_service(settings, rec)
    return rec


def startup_recover(settings: Settings) -> dict[str, int]:
    os.makedirs(services_dir(settings), exist_ok=True)
    total = 0
    stale = 0
    running = 0
    for fn in os.listdir(services_dir(settings)):
        if not fn.endswith(".json"):
            continue
        sid = fn[: -len(".json")]
        rec = read_service_record(settings, sid)
        if not rec:
            continue
        total += 1
        new_status: ServiceStatus = rec.status
        if rec.pid is not None:
            new_status = "running" if _pid_is_running(rec.pid) else "stale"
        if new_status != rec.status:
            updated = ServiceRecord(
                **{**rec.__dict__, "status": new_status, "updated_at": _now_iso()},
            )
            write_service_record(settings, updated)
            db_upsert_service(settings, updated)
            rec = updated
        if rec.status == "running":
            running += 1
        elif rec.status == "stale":
            stale += 1
    return {"total": total, "running": running, "stale": stale}


def stop_service(settings: Settings, service_id: str) -> tuple[bool, str]:
    sid = (service_id or "").strip()
    if not sid:
        return False, "missing_service_id"

    rec = read_service_record(settings, sid)
    prior = rec.status if rec else "unknown"
    pid = rec.pid if rec else None

    stopped = False
    if pid is not None and os.name != "nt":
        try:
            os.kill(pid, signal.SIGTERM)
            stopped = True
        except Exception:
            stopped = False
    elif pid is not None and os.name == "nt":
        # MVP: no process-tree termination on Windows; mark stopped only.
        stopped = True

    if rec:
        updated = ServiceRecord(
            **{**rec.__dict__, "status": "stopped", "updated_at": _now_iso()},
        )
        write_service_record(settings, updated)
        db_upsert_service(settings, updated)
    return stopped, str(prior)


