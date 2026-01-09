from __future__ import annotations

import json
import os
from typing import Any, Literal

from openai import OpenAI

from ..agent_log import append_agent_event, maybe_log_text
from ..settings import get_settings
from .prompt import system_prompt
from .state import PendingToolCall, get_conv, now_ms
from .tools import READ_TOOLS, TOOLS, WRITE_TOOLS, run_tool


AgentStatus = Literal["ok", "needs_approval", "error"]


def agent_model() -> str:
    # Prefer a dedicated agent model override; fall back to OPENAI_MODEL; then a sane default.
    return (os.environ.get("SAW_AGENT_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini").strip()


def agent_chat(*, conversation_id: str | None, message: str) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        return {"status": "error", "error": "OPENAI_API_KEY missing", "conversation_id": conversation_id}

    st = get_conv(conversation_id)
    append_agent_event(
        settings,
        {
            "type": "agent.chat.request",
            "conversation_id": st.id,
            "message_len": len(str(message or "")),
            "message": maybe_log_text(str(message or "")),
        },
    )
    if st.pending is not None:
        append_agent_event(
            settings,
            {
                "type": "agent.chat.blocked_pending",
                "conversation_id": st.id,
                "pending": {"id": st.pending.id, "name": st.pending.name},
            },
        )
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
    model = agent_model()

    # Tool loop: execute read tools automatically; stop + request approval on write tools.
    max_steps = 10
    for _ in range(max_steps):
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system_prompt()}, *st.messages],
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
                    pending = PendingToolCall(id=str(tc.id), name=name, arguments=dict(args or {}), created_at_ms=now_ms())
                    st.pending = pending
                    st.updated_at_ms = now_ms()
                    append_agent_event(
                        settings,
                        {
                            "type": "agent.tool.needs_approval",
                            "conversation_id": st.id,
                            "tool": {"id": pending.id, "name": pending.name, "arguments": pending.arguments},
                        },
                    )
                    return {
                        "status": "needs_approval",
                        "conversation_id": st.id,
                        "tool_call": {"id": pending.id, "name": pending.name, "arguments": pending.arguments},
                    }

                if name not in READ_TOOLS:
                    # Unknown tool: return an assistant message and stop.
                    err = f"Unknown tool requested: {name}"
                    st.messages.append({"role": "assistant", "content": err})
                    st.updated_at_ms = now_ms()
                    return {"status": "ok", "conversation_id": st.id, "message": err, "model": model}

                try:
                    out = run_tool(name, dict(args or {}))
                    st.messages.append(
                        {"role": "tool", "tool_call_id": tc.id, "content": json.dumps(out, ensure_ascii=False)[:200000]}
                    )
                    append_agent_event(
                        settings,
                        {
                            "type": "agent.tool.auto_read",
                            "conversation_id": st.id,
                            "tool": {"id": str(tc.id), "name": name},
                        },
                    )
                except Exception as e:
                    st.messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps({"error": str(e)})})
                    append_agent_event(
                        settings,
                        {
                            "type": "agent.tool.auto_read_error",
                            "conversation_id": st.id,
                            "tool": {"id": str(tc.id), "name": name},
                            "error": str(e)[:2000],
                        },
                    )
            continue

        # Normal assistant response
        content = str(msg.content or "")
        st.messages.append({"role": "assistant", "content": content})
        st.updated_at_ms = now_ms()
        append_agent_event(
            settings,
            {
                "type": "agent.chat.response",
                "conversation_id": st.id,
                "model": model,
                "message_len": len(content),
                "message": maybe_log_text(content),
            },
        )
        return {"status": "ok", "conversation_id": st.id, "message": content, "model": model}

    st.updated_at_ms = now_ms()
    append_agent_event(settings, {"type": "agent.error", "conversation_id": st.id, "error": "tool_loop_exceeded"})
    return {"status": "error", "error": "tool_loop_exceeded", "conversation_id": st.id}


def agent_approve(*, conversation_id: str, tool_call_id: str, approved: bool) -> dict[str, Any]:
    settings = get_settings()
    if not settings.openai_api_key:
        return {"status": "error", "error": "OPENAI_API_KEY missing", "conversation_id": conversation_id}

    st = get_conv(conversation_id)
    if not st.pending or st.pending.id != str(tool_call_id):
        return {"status": "error", "error": "no_pending_tool", "conversation_id": st.id}

    pending = st.pending
    st.pending = None
    append_agent_event(
        settings,
        {
            "type": "agent.approve.request",
            "conversation_id": st.id,
            "tool": {"id": pending.id, "name": pending.name, "arguments": pending.arguments},
            "approved": bool(approved),
        },
    )

    if not approved:
        st.messages.append({"role": "assistant", "content": f"Cancelled: {pending.name}"})
        st.updated_at_ms = now_ms()
        append_agent_event(settings, {"type": "agent.approve.rejected", "conversation_id": st.id, "tool": {"id": pending.id, "name": pending.name}})
        return {"status": "ok", "conversation_id": st.id, "message": f"Cancelled: {pending.name}", "model": agent_model()}

    # Execute the approved write tool, then resume the model once.
    try:
        out = run_tool(pending.name, pending.arguments)
        st.messages.append({"role": "tool", "tool_call_id": pending.id, "content": json.dumps(out, ensure_ascii=False)[:200000]})
        append_agent_event(
            settings,
            {
                "type": "agent.tool.write_result",
                "conversation_id": st.id,
                "tool": {"id": pending.id, "name": pending.name},
                "result": maybe_log_text(json.dumps(out, ensure_ascii=False)),
            },
        )
    except Exception as e:
        st.messages.append({"role": "tool", "tool_call_id": pending.id, "content": json.dumps({"error": str(e)})})
        append_agent_event(
            settings,
            {
                "type": "agent.tool.write_error",
                "conversation_id": st.id,
                "tool": {"id": pending.id, "name": pending.name},
                "error": str(e)[:2000],
            },
        )

    client = OpenAI(api_key=settings.openai_api_key)
    model = agent_model()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system_prompt()}, *st.messages],
        tools=TOOLS,
        tool_choice="auto",
    )
    msg = resp.choices[0].message
    content = str(msg.content or "")
    st.messages.append({"role": "assistant", "content": content})
    st.updated_at_ms = now_ms()
    append_agent_event(
        settings,
        {
            "type": "agent.chat.response",
            "conversation_id": st.id,
            "model": model,
            "message_len": len(content),
            "message": maybe_log_text(content),
        },
    )
    return {"status": "ok", "conversation_id": st.id, "message": content, "model": model}


