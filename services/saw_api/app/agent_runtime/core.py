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


def _looks_like_plugin_creation_request(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t:
        return False

    # Strong phrases
    strong_triggers = (
        "create a plugin",
        "make a plugin",
        "build a plugin",
        "generate a plugin",
        "new plugin",
        "plugin.yaml",
        "wrapper.py",
        "saw-workspace/plugins",
    )
    if any(x in t for x in strong_triggers):
        return True

    # Keyword routing: if the user says "plugin" plus a creation verb, treat it as plugin creation.
    has_plugin = "plugin" in t or "plugins" in t
    if not has_plugin:
        return False
    creation_verbs = ("build", "make", "create", "generate", "add", "scaffold")
    return any(v in t for v in creation_verbs)


def _mentions_plugin_ambiguous(text: str) -> bool:
    """Return True if the user mentions 'plugin' but intent is ambiguous.

    We only ask a clarifying question when they didn't clearly request creation AND the text doesn't
    look like a run/debug/list request.
    """

    t = (text or "").strip().lower()
    if not t:
        return False
    if "plugin" not in t and "plugins" not in t:
        return False
    if _looks_like_plugin_creation_request(t):
        return False
    # If they clearly want to run/execute/list/fix an existing plugin, don't interrupt.
    non_creation_intents = (
        "run",
        "execute",
        "invoke",
        "index",
        "list",
        "discover",
        "load",
        "refresh",
        "debug",
        "fix",
        "broken",
        "error",
        "failed",
        "500",
        "/plugins",
    )
    return not any(k in t for k in non_creation_intents)


def agent_model() -> str:
    # Prefer a dedicated agent model override; fall back to OPENAI_MODEL; then a sane default.
    return (os.environ.get("SAW_AGENT_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o").strip()


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

    # If the user says "plugin" but doesn't specify whether they want a new plugin vs. something else,
    # ask a quick clarifying question (reduces adoption friction).
    if _mentions_plugin_ambiguous(user_text):
        q = (
            "When you say ‘plugin’, do you want me to build a NEW SAW plugin? "
            "If yes, tell me what it should do (1–2 sentences) and optionally an id/name. "
            "If no, tell me what plugin task you meant (run/list/fix/etc.)."
        )
        st.messages.append({"role": "user", "content": user_text})
        st.messages.append({"role": "assistant", "content": q})
        st.updated_at_ms = now_ms()
        append_agent_event(
            settings,
            {
                "type": "agent.chat.response",
                "conversation_id": st.id,
                "model": "router",
                "message_len": len(q),
                "message": maybe_log_text(q),
            },
        )
        return {"status": "ok", "conversation_id": st.id, "message": q, "model": model}

    st.messages.append({"role": "user", "content": user_text})

    client = OpenAI(api_key=settings.openai_api_key)
    model = agent_model()

    # Tool loop: execute read tools automatically; stop + request approval on write tools.
    max_steps = 10
    nudged_for_plugin_tools = False
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

        # Lightweight routing: if user clearly asked to create a plugin but the model didn't use tools,
        # reprompt once to encourage validate_plugin_manifest -> create_plugin.
        if (not nudged_for_plugin_tools) and _looks_like_plugin_creation_request(user_text):
            nudged_for_plugin_tools = True
            st.messages.append({"role": "assistant", "content": content})
            st.messages.append(
                {
                    "role": "user",
                    "content": (
                        "Reminder: This request is SAW plugin creation. "
                        "Use tools (validate_plugin_manifest then create_plugin) to create the plugin under "
                        "saw-workspace/plugins/<id>/. Do not write files in the repo root. Proceed with tool calls now."
                    ),
                }
            )
            continue

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


