from __future__ import annotations

# Shared state for agent health reporting.
# Kept in a separate module to avoid circular imports between core.py and tools.py.

_LAST_AGENT_ERROR: str = ""


def set_last_agent_error(msg: str) -> None:
    global _LAST_AGENT_ERROR
    _LAST_AGENT_ERROR = str(msg or "")[:2000]


def get_last_agent_error() -> str:
    return str(_LAST_AGENT_ERROR or "")
