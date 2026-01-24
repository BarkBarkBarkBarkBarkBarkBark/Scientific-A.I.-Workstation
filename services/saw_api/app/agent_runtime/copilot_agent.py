from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any, Optional

from copilot import CopilotClient, CopilotSession
from copilot.generated.session_events import SessionEvent, SessionEventType
from copilot.types import PermissionRequest, PermissionRequestResult, Tool, ToolInvocation, ToolResult

from ..agent_log import append_agent_event, maybe_log_text
from ..settings import get_settings
from .tools import READ_TOOLS, TOOLS as OPENAI_TOOL_DEFS, WRITE_TOOLS, run_tool


def _agent_provider() -> str:
    return (os.environ.get("SAW_AGENT_PROVIDER") or "openai").strip().lower()


def copilot_enabled() -> bool:
    return _agent_provider() == "copilot"


def _tool_defs_from_openai_tools() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t in OPENAI_TOOL_DEFS:
        fn = (t or {}).get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        out.append(
            {
                "name": str(name),
                "description": str(fn.get("description") or ""),
                "parameters": fn.get("parameters"),
            }
        )
    return out


def _normalize_tool_result(result: Any) -> ToolResult:
    if isinstance(result, dict) and "resultType" in result and "textResultForLlm" in result:
        return result  # type: ignore
    try:
        text = json.dumps(result, ensure_ascii=False)
    except Exception:
        text = str(result)
    return ToolResult(textResultForLlm=text, resultType="success")


def _saw_event(conversation_id: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"conversation_id": conversation_id, "type": type_, "payload": payload}


@dataclass
class _CopilotConversation:
    conversation_id: str
    session: CopilotSession
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    queue: Optional[asyncio.Queue[dict[str, Any]]] = None
    pending: dict[str, asyncio.Future[bool]] = field(default_factory=dict)

    def emit(self, event: dict[str, Any]) -> None:
        q = self.queue
        if q is None:
            return
        try:
            q.put_nowait(event)
        except Exception:
            pass


class CopilotAgentManager:
    """In-process Copilot agent runtime for SAW API.

    - One CopilotSession per SAW conversation_id
    - Emits events via an asyncio.Queue that the SSE endpoint drains
    - Gates write-like tools by pausing tool execution until /agent/approve resolves
    """

    def __init__(self) -> None:
        self._client: Optional[CopilotClient] = None
        self._client_opts: dict[str, Any] = {}
        self._convs: dict[str, _CopilotConversation] = {}
        self._tools = self._build_tools()

        # Warmup diagnostics (used for /health).
        self._warmup_started: bool = False
        self._warmup_ok: bool = False
        self._warmup_error: str | None = None
        self._warmup_models_ok: bool = False
        self._warmup_models_error: str | None = None
        self._warmup_models_count: int | None = None

    async def warmup(self) -> None:
        """Eagerly start/connect the Copilot CLI transport.

        By default SAW starts Copilot lazily on first Copilot request.
        In dev or managed environments it's useful to fail fast at startup
        (missing CLI, TLS issues, auth issues, port conflicts).
        """
        self._warmup_started = True
        try:
            client = await self._ensure_client()
            # Verify the transport is actually usable (auth/network/TLS), not just connected.
            # A common failure mode behind corporate TLS is models.list failing.
            models = await asyncio.wait_for(client.list_models(), timeout=15.0)
            self._warmup_models_ok = True
            self._warmup_models_error = None
            self._warmup_models_count = len(models or [])
            self._warmup_ok = True
            self._warmup_error = None
        except Exception as exc:
            self._warmup_ok = False
            self._warmup_error = str(exc)
            self._warmup_models_ok = False
            self._warmup_models_error = str(exc)
            self._warmup_models_count = None
            raise

    def health_status(self) -> dict[str, Any]:
        """Best-effort Copilot transport status for /health."""
        opts = dict(self._client_opts or {})
        # Avoid dumping the full env into health responses.
        if "env" in opts:
            opts["env"] = "<redacted>"
        return {
            "warmup_started": bool(self._warmup_started),
            "warmup_ok": bool(self._warmup_ok),
            "warmup_error": self._warmup_error,
            "models_ok": bool(self._warmup_models_ok),
            "models_error": self._warmup_models_error,
            "models_count": self._warmup_models_count,
            "client_config": opts,
        }

    async def _ensure_client(self) -> CopilotClient:
        if self._client:
            return self._client

        # Copilot CLI is implemented on Node. In some environments (notably macOS
        # with SSL interception/corporate roots), Node may not trust the relevant
        # certificate roots by default.
        #
        # We pass an explicit env to the Copilot CLI subprocess to ensure these
        # variables are applied even under reloaders/process managers.
        env = os.environ.copy()

        # Default: try Node system CAs (opt-out via SAW_COPILOT_USE_SYSTEM_CA=0).
        if (env.get("SAW_COPILOT_USE_SYSTEM_CA") or "1").strip() not in ("0", "false", "False"):
            existing = env.get("NODE_OPTIONS") or ""
            if "--use-system-ca" not in existing:
                env["NODE_OPTIONS"] = (existing + " --use-system-ca").strip()

        # Optional: explicitly provide a CA bundle file for Node.
        # This is often required when the relevant root is in the login keychain
        # (or corporate-managed) and Node still fails with "unable to get issuer certificate".
        extra_ca = (env.get("SAW_COPILOT_EXTRA_CA_CERTS") or "").strip()
        if extra_ca:
            env["NODE_EXTRA_CA_CERTS"] = extra_ca

        # Transport selection
        # - Default: stdio server mode (fast + avoids port management)
        # - Optional: TCP server mode on an explicit port (closer to docs/examples)
        # - Optional: connect to an externally managed Copilot CLI server
        cli_url = (env.get("SAW_COPILOT_CLI_URL") or "").strip()
        port_raw = (env.get("SAW_COPILOT_SERVER_PORT") or "").strip()
        port: int = 0
        if port_raw:
            try:
                port = int(port_raw)
            except Exception:
                port = 0

        if cli_url:
            # External server: SAW will not spawn the Copilot CLI process.
            opts: dict[str, Any] = {"cli_url": cli_url}
            self._client_opts = dict(opts)
            self._client = CopilotClient(opts)
        else:
            cli_path = (env.get("COPILOT_CLI_PATH") or "copilot").strip()
            # If a port is provided, run in TCP server mode; else use stdio.
            use_stdio = port <= 0
            opts: dict[str, Any] = {"cli_path": cli_path, "auto_start": True, "use_stdio": bool(use_stdio), "env": env}
            log_level = (env.get("SAW_COPILOT_LOG_LEVEL") or "").strip().lower()
            if log_level in ("none", "error", "warning", "info", "debug", "all"):
                opts["log_level"] = log_level
            if port > 0:
                opts["port"] = port
            self._client_opts = dict(opts)
            self._client = CopilotClient(opts)
        await self._client.start()
        return self._client

    def _build_tools(self) -> list[Tool]:
        defs = _tool_defs_from_openai_tools()
        tools: list[Tool] = []
        for d in defs:
            name = d["name"]
            desc = d.get("description") or ""
            params = d.get("parameters")

            async def handler(invocation: ToolInvocation, *, _tool_name: str = name) -> ToolResult:
                settings = get_settings()
                args = invocation.get("arguments") or {}
                tool_call_id = invocation.get("tool_call_id")
                session_id = invocation.get("session_id")

                conv = self._find_conv_by_session_id(str(session_id or ""))
                if conv is None:
                    return ToolResult(
                        textResultForLlm="Invoking this tool produced an error. Detailed information is not available.",
                        resultType="failure",
                        error="unknown_conversation",
                        toolTelemetry={},
                    )

                conv.emit(_saw_event(conv.conversation_id, "tool.call", {"id": tool_call_id, "name": _tool_name, "arguments": args}))

                # Gate write tools behind explicit approval.
                if _tool_name in WRITE_TOOLS:
                    fut = asyncio.get_running_loop().create_future()
                    conv.pending[str(tool_call_id)] = fut
                    conv.emit(
                        _saw_event(
                            conv.conversation_id,
                            "permission.request",
                            {
                                "kind": "write",
                                "toolCallId": str(tool_call_id),
                                "details": {"name": _tool_name, "arguments": args},
                            },
                        )
                    )

                    append_agent_event(
                        settings,
                        {
                            "type": "copilot.permission.request",
                            "conversation_id": conv.conversation_id,
                            "tool": {"id": str(tool_call_id), "name": _tool_name},
                        },
                    )

                    approved = False
                    try:
                        approved = bool(await fut)
                    finally:
                        conv.pending.pop(str(tool_call_id), None)

                    conv.emit(
                        _saw_event(
                            conv.conversation_id,
                            "permission.resolved",
                            {"kind": "write", "toolCallId": str(tool_call_id), "approved": bool(approved)},
                        )
                    )

                    if not approved:
                        result: ToolResult = ToolResult(
                            textResultForLlm=f"Denied: {_tool_name}",
                            resultType="denied",
                            toolTelemetry={},
                        )
                        conv.emit(_saw_event(conv.conversation_id, "tool.result", {"id": tool_call_id, "name": _tool_name, **result}))
                        return result

                # Execute tool (run in thread to avoid blocking the event loop).
                try:
                    out = await asyncio.to_thread(run_tool, _tool_name, dict(args) if isinstance(args, dict) else {})
                    result = _normalize_tool_result(out)
                    conv.emit(_saw_event(conv.conversation_id, "tool.result", {"id": tool_call_id, "name": _tool_name, **result}))
                    return result
                except Exception as exc:
                    # Keep the LLM-facing error opaque; stash details for debugging.
                    result = ToolResult(
                        textResultForLlm="Invoking this tool produced an error. Detailed information is not available.",
                        resultType="failure",
                        error=str(exc)[:2000],
                        toolTelemetry={},
                    )
                    conv.emit(_saw_event(conv.conversation_id, "tool.result", {"id": tool_call_id, "name": _tool_name, **result}))
                    append_agent_event(
                        settings,
                        {
                            "type": "copilot.tool.error",
                            "conversation_id": conv.conversation_id,
                            "tool": {"id": str(tool_call_id), "name": _tool_name},
                            "error": str(exc)[:2000],
                        },
                    )
                    return result

            tools.append(Tool(name=name, description=desc, handler=handler, parameters=params))
        return tools

    def _find_conv_by_session_id(self, session_id: str) -> Optional[_CopilotConversation]:
        if not session_id:
            return None
        for conv in self._convs.values():
            if conv.session.session_id == session_id:
                return conv
        return None

    async def get_or_create(self, conversation_id: Optional[str]) -> _CopilotConversation:
        client = await self._ensure_client()
        cid = (conversation_id or "").strip() or None
        if cid and cid in self._convs:
            return self._convs[cid]

        # Create a new session.
        settings = get_settings()
        # Keep system message append-only; do not remove SDK guardrails.
        system_message = {
            "mode": "append",
            "content": (
                "You are SAW, a repo-aware coding agent.\n"
                "Rules:\n"
                "- Prefer tools over guessing.\n"
                "- Before proposing or applying edits to a file, read it with dev_file().\n"
                "- All write tools require explicit approval and go through Patch Engine.\n"
            ),
        }

        session_cfg: dict[str, Any] = {
            "tools": self._tools,
            "available_tools": [t.name for t in self._tools],
            "system_message": system_message,
            "streaming": True,
            # Permission requests from the Copilot CLI runtime itself.
            "on_permission_request": self._on_permission_request,
        }

        # Model selection (optional).
        # This is distinct from SAW_AGENT_MODEL (OpenAI provider) and only affects Copilot sessions.
        # Note: Copilot CLI supports a limited set of model identifiers.
        # Default to a Copilot-CLI-supported model id.
        copilot_model = (os.environ.get("SAW_COPILOT_MODEL") or "gpt-5.2").strip()
        if copilot_model:
            session_cfg["model"] = copilot_model

        session = await client.create_session(session_cfg)

        # Use Copilot session id as stable conversation id if not provided.
        cid2 = cid or session.session_id
        conv = _CopilotConversation(conversation_id=cid2, session=session)
        self._convs[cid2] = conv

        append_agent_event(settings, {"type": "copilot.session.created", "conversation_id": cid2, "session_id": session.session_id})
        return conv

    async def _on_permission_request(self, request: PermissionRequest, ctx: dict[str, str]) -> PermissionRequestResult:
        """Handle Copilot CLI permission requests (not SAW tool approvals).

        Default: deny anything non-read. This keeps SAW safe-by-default.
        """

        session_id = (ctx or {}).get("session_id") or ""
        conv = self._find_conv_by_session_id(session_id)
        kind = (request or {}).get("kind") or ""
        tool_call_id = (request or {}).get("toolCallId") or ""
        if conv is not None:
            conv.emit(_saw_event(conv.conversation_id, "permission.request", {"kind": kind, "toolCallId": tool_call_id, "details": dict(request)}))

        # Allow read by default, deny everything else.
        if kind == "read":
            return {"kind": "approved", "rules": []}
        return {"kind": "denied-by-rules", "rules": []}

    def approve(self, conversation_id: str, tool_call_id: str, approved: bool) -> bool:
        conv = self._convs.get((conversation_id or "").strip() or "")
        if not conv:
            return False
        fut = conv.pending.get(str(tool_call_id))
        if not fut or fut.done():
            return False
        fut.set_result(bool(approved))
        return True

    async def stream_chat(self, *, conversation_id: Optional[str], message: str) -> tuple[_CopilotConversation, asyncio.Queue[dict[str, Any]]]:
        conv = await self.get_or_create(conversation_id)

        # Only one active SSE queue at a time per conversation.
        if conv.queue is not None:
            raise RuntimeError("stream_already_active")

        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        conv.queue = q

        done = asyncio.Event()

        def on_event(evt: SessionEvent) -> None:
            # Translate a subset of Copilot session events into SAW events.
            try:
                if evt.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                    delta = evt.data.delta_content or ""
                    if delta:
                        conv.emit(_saw_event(conv.conversation_id, "assistant.message_delta", {"delta": delta}))
                elif evt.type == SessionEventType.ASSISTANT_MESSAGE:
                    content = evt.data.content or ""
                    conv.emit(_saw_event(conv.conversation_id, "assistant.message", {"content": content}))
                elif evt.type == SessionEventType.SESSION_IDLE:
                    conv.emit(_saw_event(conv.conversation_id, "session.idle", {}))
                    done.set()
                elif evt.type == SessionEventType.SESSION_ERROR:
                    msg = evt.data.message or str(evt.data.error or "session_error")
                    conv.emit(_saw_event(conv.conversation_id, "session.error", {"message": msg}))
                    done.set()
            except Exception:
                pass

        unsubscribe = conv.session.on(on_event)
        conv.emit(_saw_event(conv.conversation_id, "session.started", {"provider": "copilot"}))

        # Serialize sends per conversation.
        async def run_send() -> None:
            settings = get_settings()
            try:
                async with conv.lock:
                    # IMPORTANT:
                    # `send()` returns as soon as the message is accepted and may return
                    # before any streaming events are delivered. Using `send_and_wait()`
                    # keeps the subscription alive until the session reaches idle/error.
                    await conv.session.send_and_wait({"prompt": str(message or "")}, timeout=120.0)
            except Exception as exc:
                append_agent_event(
                    settings,
                    {
                        "type": "copilot.send.error",
                        "conversation_id": conv.conversation_id,
                        "error": maybe_log_text(str(exc)),
                    },
                )
                conv.emit(_saw_event(conv.conversation_id, "session.error", {"message": str(exc)}))
            finally:
                try:
                    unsubscribe()
                except Exception:
                    pass
                # Keep the queue attached only for the lifetime of this stream.
                conv.queue = None

        asyncio.create_task(run_send())
        return conv, q

    async def chat_once(self, *, conversation_id: Optional[str], message: str, timeout_s: float = 120.0) -> dict[str, Any]:
        """Run a single Copilot turn and return a legacy JSON response.

        This enables switching providers without requiring SSE in callers.
        """

        conv, q = await self.stream_chat(conversation_id=conversation_id, message=message)
        content: str = ""
        while True:
            ev = await asyncio.wait_for(q.get(), timeout=timeout_s)
            t = str(ev.get("type") or "")
            payload = ev.get("payload") or {}

            if t == "assistant.message_delta":
                delta = str((payload or {}).get("delta") or "")
                if delta:
                    content += delta
                continue

            if t == "assistant.message":
                content = str((payload or {}).get("content") or "")
                continue

            if t == "permission.request":
                details = (payload or {}).get("details") or {}
                tool_call_id = str((payload or {}).get("toolCallId") or details.get("id") or "")
                name = str(details.get("name") or "tool")
                args = (
                    details.get("arguments")
                    or (details.get("details") or {}).get("arguments")
                    or (details.get("function") or {}).get("arguments")
                    or {}
                )
                return {
                    "status": "needs_approval",
                    "conversation_id": conv.conversation_id,
                    "tool_call": {"id": tool_call_id, "name": name, "arguments": args},
                    "model": "copilot",
                }

            if t == "session.error":
                msg = str((payload or {}).get("message") or "session_error")
                return {
                    "status": "error",
                    "conversation_id": conv.conversation_id,
                    "error": msg,
                    "model": "copilot",
                }

            if t == "session.idle":
                break

        return {"status": "ok", "conversation_id": conv.conversation_id, "message": content, "model": "copilot"}


_MANAGER: Optional[CopilotAgentManager] = None


def copilot_manager() -> CopilotAgentManager:
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = CopilotAgentManager()
    return _MANAGER
