from __future__ import annotations

import os
import json
from typing import Any

import yaml
from pydantic import ValidationError

from .patch_engine_client import pe_get, pe_post

from ..db import db_conn
from ..embeddings import embed_texts

from ..plugins_runtime import PluginManifest
from ..settings import get_settings
from .health_state import get_last_agent_error

try:
    from pgvector.psycopg import Vector

    _PGVECTOR_AVAILABLE = True
except Exception:
    _PGVECTOR_AVAILABLE = False

try:
    from .copilot_agent import copilot_enabled  # type: ignore

    _COPILOT_AVAILABLE = True
except Exception:
    _COPILOT_AVAILABLE = False

    def copilot_enabled() -> bool:  # type: ignore
        return False

TODO_PATH = "saw-workspace/todo.md"
AGENT_WORKSPACE_PATH = "saw-workspace/agent/agent_workspace.md"


def tool_dev_tree(root: str = ".", depth: int = 3) -> dict[str, Any]:
    return pe_get("/api/dev/tree", {"root": root, "depth": depth, "max": 2000})


def tool_dev_file(path: str) -> dict[str, Any]:
    return pe_get("/api/dev/file", {"path": path})


def tool_git_status(path: str | None = None) -> dict[str, Any]:
    q = {"path": path} if path else {}
    return pe_get("/api/dev/git/status", q)


def tool_git_info() -> dict[str, Any]:
    return pe_get("/api/dev/git/info", {})


def tool_tools_list() -> dict[str, Any]:
    return pe_get("/api/dev/tools/list", {})


def tool_introspection_run() -> dict[str, Any]:
    return pe_get("/api/dev/introspection/run", {})


def tool_saw_agent_health() -> dict[str, Any]:
    # Mirror SAW API /agent/health without requiring HTTP.
    settings = get_settings()
    llm_available = bool(settings.openai_api_key) or bool(copilot_enabled())
    agent_chat_route_ok = True
    last_error = get_last_agent_error()
    if not llm_available and not last_error:
        last_error = "llm_not_configured"
    return {
        "llm_available": bool(llm_available),
        "agent_chat_route_ok": bool(agent_chat_route_ok),
        "last_error": str(last_error or ""),
    }


def tool_vector_store_stats(model: str | None = None) -> dict[str, Any]:
    """Read-only vector store stats from Postgres (pgvector).

    Safe: does not call embedding APIs.
    """

    settings = get_settings()
    m = (model or "").strip()
    with db_conn(settings) as conn:
        doc_count = conn.execute("SELECT COUNT(*) FROM saw_ingest.document").fetchone()[0]
        if m:
            emb_rows = conn.execute(
                "SELECT model, COUNT(*) FROM saw_ingest.embedding WHERE model=%s GROUP BY model ORDER BY model",
                (m,),
            ).fetchall()
        else:
            emb_rows = conn.execute(
                "SELECT model, COUNT(*) FROM saw_ingest.embedding GROUP BY model ORDER BY model"
            ).fetchall()
    return {
        "ok": True,
        "document_count": int(doc_count or 0),
        "embeddings_by_model": [{"model": str(r[0]), "count": int(r[1] or 0)} for r in (emb_rows or [])],
    }


def tool_vector_search(query: str, top_k: int = 8, model: str | None = None) -> dict[str, Any]:
    """Semantic vector search against saw_ingest.embedding using pgvector.

    This may call the embedding provider (OpenAI) and therefore can incur cost.
    Treat as approval-gated by listing it as a WRITE_TOOL.
    """

    if not _PGVECTOR_AVAILABLE:
        return {"ok": False, "error": "pgvector_not_available"}

    settings = get_settings()
    q = (query or "").strip()
    if not q:
        return {"ok": True, "model": (model or settings.embed_model).strip(), "hits": []}

    m = (model or settings.embed_model).strip()
    try:
        er = embed_texts(settings, [q], model=m)
    except Exception as exc:
        return {"ok": False, "error": f"embed_failed: {type(exc).__name__}: {exc}"}
    if not getattr(er, "vectors", None):
        return {"ok": True, "model": m, "hits": []}

    qv = Vector(er.vectors[0])
    k = max(1, min(50, int(top_k or 8)))

    with db_conn(settings) as conn:
        rows = conn.execute(
            """
            SELECT d.uri, d.doc_type, d.content_text, d.metadata_json, (e.embedding <=> %s) AS distance
            FROM saw_ingest.embedding e
            JOIN saw_ingest.document d ON d.doc_id = e.doc_id
            WHERE e.model = %s
            ORDER BY e.embedding <=> %s
            LIMIT %s
            """,
            (qv, m, qv, k),
        ).fetchall()

    hits: list[dict[str, Any]] = []
    for (uri, doc_type, content_text, metadata_json, distance) in rows:
        hits.append(
            {
                "uri": str(uri),
                "doc_type": str(doc_type) if doc_type is not None else None,
                "distance": float(distance),
                "content_text": str(content_text) if content_text is not None else None,
                "metadata_json": metadata_json if isinstance(metadata_json, dict) else None,
            }
        )

    return {"ok": True, "model": m, "hits": hits}


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


READ_TOOLS = {
    "dev_tree",
    "dev_file",
    "git_status",
    "git_info",
    "tools_list",
    "introspection_run",
    "saw_agent_health",
    "get_todo",
    "get_agent_workspace",
    "validate_plugin_manifest",
    "vector_store_stats",
}
WRITE_TOOLS = {
    "apply_patch",
    "git_commit",
    "set_caps",
    "safe_write",
    "write_todo",
    "write_agent_workspace",
    "create_plugin",
    # Approval-gated because it can incur embedding cost.
    "vector_search",
}


def tool_validate_plugin_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Validate a SAW plugin manifest dict against the backend schema.

    This is read-only and intended to be called before create_plugin().
    """

    try:
        PluginManifest.model_validate(manifest or {})
        return {"ok": True, "errors": []}
    except ValidationError as e:
        errs = []
        for err in (e.errors() or []):
            errs.append(
                {
                    "loc": [str(x) for x in (err.get("loc") or [])],
                    "msg": str(err.get("msg") or ""),
                    "type": str(err.get("type") or ""),
                }
            )
        return {"ok": False, "errors": errs}


def tool_create_plugin(*, manifest: dict[str, Any], wrapper_code: str, readme: str) -> dict[str, Any]:
    """Create a new workspace plugin under saw-workspace/plugins/<id>/.

    This tool validates the manifest before writing.
    """

    m = PluginManifest.model_validate(manifest or {})
    plugin_id = str(m.id)
    plugin_dir = os.path.join("saw-workspace", "plugins", plugin_id)

    plugin_yaml = yaml.safe_dump(manifest or {}, sort_keys=False, allow_unicode=True)
    out1 = tool_safe_write(os.path.join(plugin_dir, "plugin.yaml"), plugin_yaml)
    out2 = tool_safe_write(os.path.join(plugin_dir, "wrapper.py"), str(wrapper_code or ""))
    out3 = tool_safe_write(os.path.join(plugin_dir, "README.md"), str(readme or ""))
    out_ui: dict[str, Any] | None = None

    # Default to the Declarative UI workflow for newly created plugins.
    # This is intentionally minimal: it includes host-builtins for inputs/params/run.
    ui_spec = (manifest or {}).get("ui") if isinstance(manifest, dict) else None
    ui_mode = ""
    schema_file = "ui/declarative_ui.yaml"
    try:
        if isinstance(ui_spec, dict):
            ui_mode = str(ui_spec.get("mode") or "").strip()
            raw_schema_file = str(ui_spec.get("schema_file") or "").strip()
            if raw_schema_file:
                schema_file = raw_schema_file
        elif ui_spec is None:
            # If the caller omitted ui entirely, still scaffold the default Declarative UI schema.
            ui_mode = "schema"
    except Exception:
        ui_mode = ""

    schema_file = str(schema_file or "").strip()
    safe_schema_path = bool(
        schema_file
        and schema_file.startswith("ui/")
        and ".." not in schema_file.split("/")
        and schema_file in {"ui/declarative_ui.yaml", "ui/declarative_ui.yml"}
    )

    if ui_mode == "schema" and safe_schema_path:
        out_ui = tool_safe_write(
            os.path.join(plugin_dir, schema_file),
            (
                "declarative_ui_spec_version: '0.1'\n"
                "context:\n"
                "  defaults:\n"
                "    uiState: {}\n"
                "computed: {}\n"
                "queries: {}\n"
                "actions: {}\n"
                "lifecycle: {}\n"
                "view:\n"
                "  type: Stack\n"
                "  props: { gap: md }\n"
                "  children:\n"
                "    - type: Panel\n"
                "      props: { title: 'Plugin', variant: default }\n"
                "      children:\n"
                "        - type: Text\n"
                "          props: { variant: muted }\n"
                "          text: 'Edit ui/declarative_ui.yaml to customize this UI.'\n"
                "    - type: NodeInputs\n"
                "    - type: NodeParameters\n"
                "    - type: NodeRunPanel\n"
            ),
        )

    return {
        "ok": True,
        "plugin_id": plugin_id,
        "paths": {
            "manifest": os.path.join(plugin_dir, "plugin.yaml"),
            "wrapper": os.path.join(plugin_dir, "wrapper.py"),
            "readme": os.path.join(plugin_dir, "README.md"),
            "ui_schema": os.path.join(plugin_dir, schema_file) if (ui_mode == "schema" and safe_schema_path) else "",
        },
        "results": {"plugin.yaml": out1, "wrapper.py": out2, "README.md": out3, "ui_schema": out_ui},
    }


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
            "name": "git_info",
            "description": "Read-only git info for attestations (dev-only).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "tools_list",
            "description": "List Patch Engine tool catalog (dev-only).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "introspection_run",
            "description": "Run the deterministic attestation/introspection packet generator (dev-only).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "saw_agent_health",
            "description": "Check SAW agent health (no network).",
            "parameters": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "vector_store_stats",
            "description": "Read-only stats about the vector store (Postgres/pgvector): document count + embeddings by model.",
            "parameters": {
                "type": "object",
                "properties": {"model": {"type": "string"}},
                "required": [],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "vector_search",
            "description": "Semantic vector search (may call embedding provider and incur cost). Approval-gated by default; can be auto-approved via SAW_AUTO_APPROVE_VECTOR_SEARCH=1.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer"},
                    "model": {"type": "string"},
                },
                "required": ["query"],
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

    #
    # SAW plugin tools
    #
    {
        "type": "function",
        "function": {
            "name": "validate_plugin_manifest",
            "description": "Validate a SAW plugin manifest dict against the backend schema (read-only). Call this before create_plugin.",
            "parameters": {
                "type": "object",
                "properties": {"manifest": {"type": "object"}},
                "required": ["manifest"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_plugin",
            "description": "Create a new SAW workspace plugin under saw-workspace/plugins/<id>/ by writing plugin.yaml, wrapper.py, and README.md (requires approval).",
            "parameters": {
                "type": "object",
                "properties": {
                    "manifest": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "version": {"type": "string"},
                            "description": {"type": "string"},
                            "category_path": {"type": "string"},
                            "entrypoint": {"type": "object"},
                            "environment": {"type": "object"},
                            "inputs": {"type": "object"},
                            "params": {"type": "object"},
                            "outputs": {"type": "object"},
                            "execution": {"type": "object"},
                            "side_effects": {
                                "type": "object",
                                "properties": {
                                    "network": {"type": "string", "enum": ["none", "restricted", "allowed"]},
                                    "disk": {"type": "string", "enum": ["read_only", "read_write"]},
                                    "subprocess": {"type": "string", "enum": ["forbidden", "allowed"]},
                                },
                                "required": ["network", "disk", "subprocess"],
                                "additionalProperties": True,
                            },
                            "resources": {
                                "type": "object",
                                "properties": {
                                    "gpu": {"type": "string", "enum": ["forbidden", "optional", "required"]},
                                    "threads": {"type": "integer"},
                                },
                                "required": ["gpu"],
                                "additionalProperties": True,
                            },
                        },
                        "required": [
                            "id",
                            "name",
                            "version",
                            "description",
                            "entrypoint",
                            "environment",
                            "inputs",
                            "params",
                            "outputs",
                            "execution",
                            "side_effects",
                            "resources",
                        ],
                        "additionalProperties": True,
                    },
                    "wrapper_code": {"type": "string"},
                    "readme": {"type": "string"},
                },
                "required": ["manifest", "wrapper_code", "readme"],
                "additionalProperties": False,
            },
        },
    },
]


def _coerce_manifest(arg: Any) -> dict[str, Any]:
    """Accept dict or YAML/JSON string; return dict or {}."""

    if isinstance(arg, dict):
        return arg
    if isinstance(arg, str) and arg.strip():
        s = arg.strip()
        # Try JSON first for speed/clarity; fall back to YAML.
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
        try:
            parsed = yaml.safe_load(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {}


def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "dev_tree":
        return tool_dev_tree(root=str(args.get("root") or "."), depth=int(args.get("depth") or 3))
    if name == "dev_file":
        return tool_dev_file(path=str(args.get("path") or ""))
    if name == "git_status":
        p = args.get("path")
        return tool_git_status(path=str(p) if isinstance(p, str) and p.strip() else None)
    if name == "git_info":
        return tool_git_info()
    if name == "tools_list":
        return tool_tools_list()
    if name == "introspection_run":
        return tool_introspection_run()
    if name == "saw_agent_health":
        return tool_saw_agent_health()
    if name == "vector_store_stats":
        m = args.get("model")
        return tool_vector_store_stats(model=str(m) if isinstance(m, str) and m.strip() else None)
    if name == "vector_search":
        return tool_vector_search(
            query=str(args.get("query") or ""),
            top_k=int(args.get("top_k") or 8),
            model=str(args.get("model") or "").strip() or None,
        )
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
    if name == "validate_plugin_manifest":
        return tool_validate_plugin_manifest(manifest=_coerce_manifest(args.get("manifest")))
    if name == "create_plugin":
        return tool_create_plugin(
            manifest=_coerce_manifest(args.get("manifest")),
            wrapper_code=str(args.get("wrapper_code") or ""),
            readme=str(args.get("readme") or ""),
        )
    raise RuntimeError("unknown_tool")


