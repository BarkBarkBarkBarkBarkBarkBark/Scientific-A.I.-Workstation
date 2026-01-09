from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from .settings import Settings


def _now_ms() -> int:
    return int(time.time() * 1000)


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _saw_dir(settings: Settings) -> str:
    return os.path.join(_repo_root_from_workspace(settings.workspace_root), ".saw")


def agent_log_path(settings: Settings) -> str:
    return os.path.join(_saw_dir(settings), "agent.ndjson")


def _truthy(v: Any) -> bool:
    s = str(v or "").strip().lower()
    return s in ("1", "true", "yes", "on")


def agent_log_enabled() -> bool:
    return _truthy(os.environ.get("SAW_AGENT_LOG", "1"))


def agent_log_content_enabled() -> bool:
    # Off by default; enables logging of message/tool contents (redacted + truncated).
    return _truthy(os.environ.get("SAW_AGENT_LOG_CONTENT", "0"))


def agent_log_max_chars() -> int:
    try:
        return max(200, min(20000, int(os.environ.get("SAW_AGENT_LOG_MAX_CHARS", "2000"))))
    except Exception:
        return 2000


_RE_SK = re.compile(r"\bsk-[A-Za-z0-9]{10,}\b")


def _redact(text: str) -> str:
    t = str(text or "")
    t = _RE_SK.sub("sk-REDACTED", t)
    return t


def _truncate(text: str, max_chars: int) -> str:
    t = str(text or "")
    if len(t) <= max_chars:
        return t
    return t[:max_chars] + f"\n... (truncated, {len(t)} chars total)"


def append_agent_event(settings: Settings, event: dict[str, Any]) -> None:
    if not agent_log_enabled():
        return
    try:
        os.makedirs(_saw_dir(settings), exist_ok=True)
        payload = {"ts": _now_ms(), **(event or {})}
        with open(agent_log_path(settings), "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        # Best-effort logging; never crash agent flow.
        return


def maybe_log_text(text: str) -> str | None:
    if not agent_log_content_enabled():
        return None
    return _truncate(_redact(text), agent_log_max_chars())


