from __future__ import annotations

from typing import Any

from .patch_engine_client import pe_get, pe_post

TODO_PATH = "saw-workspace/todo.md"
AGENT_WORKSPACE_PATH = "saw-workspace/agent/agent_workspace.md"


def tool_dev_tree(root: str = ".", depth: int = 3) -> dict[str, Any]:
    return pe_get("/api/dev/tree", {"root": root, "depth": depth, "max": 2000})


def tool_dev_file(path: str) -> dict[str, Any]:
    return pe_get("/api/dev/file", {"path": path})


def tool_git_status(path: str | None = None) -> dict[str, Any]:
    q = {"path": path} if path else {}
    return pe_get("/api/dev/git/status", q)


def tool_set_caps(path: str, r: bool, w: bool, d: bool) -> dict[str, Any]:
    return pe_post("/api/dev/caps", {"path": path, "caps": {"r": bool(r), "w": bool(w), "d": bool(d)}})


def tool_safe_write(path: str, content: str) -> dict[str, Any]:
    return pe_post("/api/dev/safe/write", {"path": path, "content": content})


def tool_apply_patch(patch: str) -> dict[str, Any]:
    return pe_post("/api/dev/safe/applyPatch", {"patch": patch})


def tool_git_commit(message: str) -> dict[str, Any]:
    return pe_post("/api/dev/git/commit", {"message": message})

#
# First-class docs (no path needed)
#


def tool_get_todo() -> dict[str, Any]:
    return tool_dev_file(TODO_PATH)


def tool_write_todo(content: str) -> dict[str, Any]:
    return tool_safe_write(TODO_PATH, content)


def tool_get_agent_workspace() -> dict[str, Any]:
    return tool_dev_file(AGENT_WORKSPACE_PATH)


def tool_write_agent_workspace(content: str) -> dict[str, Any]:
    return tool_safe_write(AGENT_WORKSPACE_PATH, content)


READ_TOOLS = {"dev_tree", "dev_file", "git_status", "get_todo", "get_agent_workspace"}
WRITE_TOOLS = {"apply_patch", "git_commit", "set_caps", "safe_write", "write_todo", "write_agent_workspace"}


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
            "name": "get_todo",
            "description": "Read the canonical todo document (no path needed).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_todo",
            "description": "Overwrite the canonical todo document (no path needed).",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_agent_workspace",
            "description": "Read the agent scratchpad (no path needed).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_agent_workspace",
            "description": "Overwrite the agent scratchpad (no path needed).",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
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
            "name": "safe_write",
            "description": "Write full file contents via Patch Engine safe-write (requires user approval). Prefer this for simple files like saw-workspace/todo.md.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
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


def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "dev_tree":
        return tool_dev_tree(root=str(args.get("root") or "."), depth=int(args.get("depth") or 3))
    if name == "dev_file":
        return tool_dev_file(path=str(args.get("path") or ""))
    if name == "git_status":
        p = args.get("path")
        return tool_git_status(path=str(p) if isinstance(p, str) and p.strip() else None)
    if name == "get_todo":
        return tool_get_todo()
    if name == "get_agent_workspace":
        return tool_get_agent_workspace()
    if name == "set_caps":
        return tool_set_caps(
            path=str(args.get("path") or ""),
            r=bool(args.get("r")),
            w=bool(args.get("w")),
            d=bool(args.get("d")),
        )
    if name == "safe_write":
        return tool_safe_write(path=str(args.get("path") or ""), content=str(args.get("content") or ""))
    if name == "write_todo":
        return tool_write_todo(content=str(args.get("content") or ""))
    if name == "write_agent_workspace":
        return tool_write_agent_workspace(content=str(args.get("content") or ""))
    if name == "apply_patch":
        return tool_apply_patch(patch=str(args.get("patch") or ""))
    if name == "git_commit":
        return tool_git_commit(message=str(args.get("message") or ""))
    raise RuntimeError("unknown_tool")


