from __future__ import annotations

import json
import os
from urllib.parse import urlparse

from .migrations import migrate
from .settings import Settings


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _write_runtime_db_json(settings: Settings) -> None:
    repo_root = _repo_root_from_workspace(settings.workspace_root)
    runtime_dir = os.path.join(repo_root, ".saw", "runtime")
    os.makedirs(runtime_dir, exist_ok=True)

    def parse(url: str):
        u = urlparse(url)
        return {
            "scheme": u.scheme,
            "host": u.hostname,
            "port": u.port,
            "database": (u.path or "").lstrip("/"),
            "username": u.username,
            # password intentionally omitted unless explicitly enabled
            "password": u.password if os.environ.get("SAW_WRITE_DB_PASSWORD") == "1" else None,
        }

    payload = {
        "db_url": settings.db_url,
        "db_admin_url": settings.db_admin_url,
        "db": parse(settings.db_url),
        "db_admin": parse(settings.db_admin_url),
        "workspace_root": settings.workspace_root,
        "note": "Set SAW_WRITE_DB_PASSWORD=1 to write passwords into this file (local-only; .saw is gitignored).",
    }
    path = os.path.join(runtime_dir, "db.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def bootstrap(settings: Settings) -> dict:
    # Write local connection info for convenience (under .saw/ which is gitignored).
    _write_runtime_db_json(settings)

    # Optional auto-init (safe/idempotent)
    auto = os.environ.get("SAW_AUTO_INIT_DB", "1").lower() in ("1", "true", "yes", "on")
    if not auto:
        return {"auto_init": False}

    mr = migrate(settings)
    return {"auto_init": True, "applied": mr.applied, "already_applied": mr.already_applied}


