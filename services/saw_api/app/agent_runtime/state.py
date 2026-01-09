from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class PendingToolCall:
    id: str
    name: str
    arguments: dict[str, Any]
    created_at_ms: int


@dataclass
class ConversationState:
    id: str
    messages: list[dict[str, Any]]  # OpenAI chat messages (excluding system)
    pending: PendingToolCall | None = None
    updated_at_ms: int = 0


_CONV: dict[str, ConversationState] = {}


def get_conv(conversation_id: str | None) -> ConversationState:
    cid = (conversation_id or "").strip()
    if not cid:
        cid = f"conv_{uuid.uuid4().hex[:12]}"
    st = _CONV.get(cid)
    if not st:
        st = ConversationState(id=cid, messages=[], pending=None, updated_at_ms=now_ms())
        _CONV[cid] = st
    return st


