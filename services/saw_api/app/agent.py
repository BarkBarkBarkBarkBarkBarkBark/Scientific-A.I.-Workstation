from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from openai import OpenAI

from .settings import get_settings


AgentStatus = Literal["ok", "needs_approval", "error"]


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


def _now_ms() -> int:
    return int(time.time() * 1000)


def _agent_model() -> str:
    # Prefer a dedicated agent model override; fall back to OPENAI_MODEL; then a sane default.
    return (os.environ.get("SAW_AGENT_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip()


def _patch_engine_base_url() -> str:
    return (os.environ.get("SAW_PATCH_ENGINE_URL") or "http://127.0.0.1:5128").rstrip("/")


def _http_json(method: str, url: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | None, str]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, method=method.upper(), data=data, headers=headers)
    try:
        with urlopen(req, timeout=30) as resp:  # nosec - local dev endpoints
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return int(resp.status), (json.loads(raw) if raw else None), raw
            except Exception:
                return int(resp.status), None, raw
    except Exception as e:
        return 0, None, str(e)


def _pe_get(path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
    q = ("?" + urlencode({k: str(v) for k, v in (query or {}).items()})) if query else ""
    url = _patch_engine_base_url() + path + q
    status, j, raw = _http_json("GET", url)
    if status and 200 <= status < 300 and isinstance(j, dict):
        return j
    raise RuntimeError(f"patch_engine_get_failed status={status} raw={raw[:2000]}")


def _pe_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = _patch_engine_base_url() + path
    status, j, raw = _http_json("POST", url, body=body)
    if status and 200 <= status < 300 and isinstance(j, dict):
        return j
    raise RuntimeError(f"patch_engine_post_failed status={status} raw={raw[:2000]}")


def tool_dev_tree(root: str = ".", depth: int = 3) -> dict[str, Any]:
    return _pe_get("/api/dev/tree", {"root": root, "depth": depth, "max": 2000})


def tool_dev_file(path: str) -> dict[str, Any]:
    return _pe_get("/api/dev/file", {"path": path})


def tool_git_status(path: str | None = None) -> dict[str, Any]:
    q = {"path": path} if path else {}
    return _pe_get("/api/dev/git/status", q)


def tool_set_caps(path: str, r: bool, w: bool, d: bool) -> dict[str, Any]:
    return _pe_post("/api/dev/caps", {"path": path, "caps": {"r": bool(r), "w": bool(w), "d": bool(d)}})


def tool_apply_patch(patch: str) -> dict[str, Any]:
    return _pe_post("/api/dev/safe/applyPatch", {"patch": patch})


def tool_git_commit(message: str) -> dict[str, Any]:
    return _pe_post("/api/dev/git/commit", {"message": message})


READ_TOOLS = {"dev_tree", "dev_file", "git_status"}
WRITE_TOOLS = {"apply_patch", "git_commit", "set_caps"}


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "dev_tree",
            "description": "List repo filesystem tree (dev-only).",
            "parameters": {
                "type": "object",
                "properties": {"root": {"type": "string"}, "depth": {"type": "integer"}},
                "required": ["root", "depth"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dev_file",
            "description": "Read a repo file (dev-only). Always use this before proposing edits to a file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_status",
            "description": "Get git status/diff (dev-only).",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_caps",
            "description": "Set Patch Engine caps for a path (requires user approval). Use to enable writes for a specific file/dir before apply_patch.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "r": {"type": "boolean"}, "w": {"type": "boolean"}, "d": {"type": "boolean"}},
                "required": ["path", "r", "w", "d"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_patch",
            "description": "Apply a unified diff via Patch Engine safe-apply (requires user approval).",
            "parameters": {
                "type": "object",
                "properties": {"patch": {"type": "string"}},
                "required": ["patch"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "git_commit",
            "description": "Commit staged changes via Patch Engine (requires user approval).",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
        },
    },
]


def _system_prompt() -> str:
    return (
        "You are SAW, a repo-aware coding agent.\n"
        "Rules:\n"
        "- Before proposing or applying edits to a file, read it with dev_file().\n"
        "- Prefer tools over guessing.\n"
        "- If Patch Engine forbids a write, request set_caps(path, r=true, w=true, d=false) for the specific file or directory, then retry.\n"
        "- For write operations, request apply_patch() or git_commit(); the user will approve.\n"
        "- If a patch fails to apply, re-read the file and generate a correct patch.\n"
    )


def _get_conv(conversation_id: str | None) -> ConversationState:
    cid = (conversation_id or "").strip()
    if not cid:
        cid = f"conv_{uuid.uuid4().hex[:12]}"
    st = _CONV.get(cid)
    if not st:
        st = ConversationState(id=cid, messages=[], pending=None, updated_at_ms=_now_ms())
        _CONV[cid] = st
    return st


def _run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "dev_tree":
        return tool_dev_tree(root=str(args.get("root") or "."), depth=int(args.get("depth") or 3))
    if name == "dev_file":
        return tool_dev_file(path=str(args.get("path") or ""))
    if name == "git_status":
        p = args.get("path")
        return tool_git_status(path=str(p) if isinstance(p, str) and p.strip() else None)
    if name == "set_caps":
        return tool_set_caps(
            path=str(args.get("path") or ""),
            r=bool(args.get("r")),
            w=bool(args.get("w")),
            d=bool(args.get("d")),
        )
    if name == "apply_patch":
        return tool_apply_patch(patch=str(args.get("patch") or ""))
    if name == "git_commit":
        return tool_git_commit(message=str(args.get("message") or ""))
    raise RuntimeError("unknown_tool")


def agent_chat(*, conversation_id: str | None, message: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        return {"status": "error", "error": "OPENAI_API_KEY missing", "conversation_id": conversation_id}

    st = _get_conv(conversation_id)
    if st.pending is not None:
        return {
            "status": "needs_approval",
            "conversation_id": st.id,
            "tool_call": {"id": st.pending.id, "name": st.pending.name, "arguments": st.pending.arguments},
        }

    user_text = str(message or "").strip()
    if not user_text:
        return {"status": "error", "error": "missing_message", "conversation_id": st.id}

    st.messages.append({"role": "user", "content": user_text})

    client = OpenAI(api_key=settings.openai_api_key)
    model = _agent_model()

    # Tool loop: execute read tools automatically; stop + request approval on write tools.
    max_steps = 10
    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": _system_prompt()}, *st.messages],
            tools=TOOLS,
            tool_choice="auto",
        )
        msg = resp.choices[0].message
        tool_calls = getattr(msg, "tool_calls", None) or []

        if tool_calls:
            # Append the assistant tool-call message so tool results have context.
            st.messages.append(
                {
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        }
                        for tc in tool_calls
                    ],
                }
            )

            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except Exception:
                    args = {}

                if name in WRITE_TOOLS:
                    pending = PendingToolCall(id=str(tc.id), name=name, arguments=dict(args or {}), created_at_ms=_now_ms())
                    st.pending = pending
                    st.updated_at_ms = _now_ms()
                    return {
                        "status": "needs_approval",
                        "conversation_id": st.id,
                        "tool_call": {"id": pending.id, "name": pending.name, "arguments": pending.arguments},
                    }

                if name not in READ_TOOLS:
                    # Unknown tool: return an assistant message and stop.
                    err = f"Unknown tool requested: {name}"
                    st.messages.append({"role": "assistant", "content": err})
                    st.updated_at_ms = _now_ms()
                    return {"status": "ok", "conversation_id": st.id, "message": err, "model": model}

                try:
                    out = _run_tool(name, dict(args or {}))
                    st.messages.append(
                        {"role": "tool", "tool_call_id": tc.id, "content": json.dumps(out, ensure_ascii=False)[:200000]}
                    )
                except Exception as e:
                    st.messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps({"error": str(e)})})
            continue

        # Normal assistant response
        content = str(msg.content or "")
        st.messages.append({"role": "assistant", "content": content})
        st.updated_at_ms = _now_ms()
        return {"status": "ok", "conversation_id": st.id, "message": content, "model": model}

    st.updated_at_ms = _now_ms()
    return {"status": "error", "error": "tool_loop_exceeded", "conversation_id": st.id}


def agent_approve(*, conversation_id: str, tool_call_id: str, approved: bool) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        return {"status": "error", "error": "OPENAI_API_KEY missing", "conversation_id": conversation_id}

    st = _get_conv(conversation_id)
    if not st.pending or st.pending.id != str(tool_call_id):
        return {"status": "error", "error": "no_pending_tool", "conversation_id": st.id}

    pending = st.pending
    st.pending = None

    if not approved:
        st.messages.append({"role": "assistant", "content": f"Cancelled: {pending.name}"})
        st.updated_at_ms = _now_ms()
        return {"status": "ok", "conversation_id": st.id, "message": f"Cancelled: {pending.name}", "model": _agent_model()}

    # Execute the approved write tool, then resume the model once.
    try:
        out = _run_tool(pending.name, pending.arguments)
        st.messages.append({"role": "tool", "tool_call_id": pending.id, "content": json.dumps(out, ensure_ascii=False)[:200000]})
    except Exception as e:
        st.messages.append({"role": "tool", "tool_call_id": pending.id, "content": json.dumps({"error": str(e)})})

    client = OpenAI(api_key=settings.openai_api_key)
    model = _agent_model()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": _system_prompt()}, *st.messages],
        tools=TOOLS,
        tool_choice="auto",
    )
    msg = resp.choices[0].message
    content = str(msg.content or "")
    st.messages.append({"role": "assistant", "content": content})
    st.updated_at_ms = _now_ms()
    return {"status": "ok", "conversation_id": st.id, "message": content, "model": model}


