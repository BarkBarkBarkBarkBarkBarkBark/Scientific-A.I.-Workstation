from __future__ import annotations

import asyncio
from datetime import datetime
import json
import os
import re
import subprocess
import sys
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.responses import Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pgvector.psycopg import Vector
import yaml

from .db import db_conn, jsonable, jsonb, sha256_text
from .embeddings import chunk_text, embed_texts
from .migrations import migrate
from .plugins_runtime import discover_plugins, execute_plugin
from .run_manager import get_run as get_run_info
from .run_manager import spawn_run
from .settings import get_settings
from .bootstrap import bootstrap
from .service_manager import startup_recover, stop_service
from .agent import agent_chat, agent_approve
from .agent_runtime.core import agent_model
from .agent_runtime.health_state import get_last_agent_error

from .repo_intel.router import router as repo_intel_router

try:
    from .agent_runtime.copilot_agent import copilot_enabled, copilot_manager

    _COPILOT_AVAILABLE = True
except Exception:
    # Copilot is optional; allow SAW API to boot and run the OpenAI agent even
    # if the Copilot SDK is not installed or fails to import.
    _COPILOT_AVAILABLE = False

    def copilot_enabled() -> bool:  # type: ignore
        return False

    def copilot_manager() -> Any:  # type: ignore
        raise RuntimeError("copilot_unavailable")
from .agent_log import agent_log_path
from . import env_manager
from .stock_plugins_catalog import (
    compute_dir_digest_sha256,
    load_stock_catalog,
    sync_stock_plugin_dir,
    sync_stock_plugins,
)


settings = get_settings()
app = FastAPI(title="SAW API", version="0.1.0")

app.include_router(repo_intel_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    # Best-effort: write db.json and auto-init schema (idempotent).
    try:
        bootstrap(settings)
        sync_stock_plugins(settings)
        startup_recover(settings)
    except Exception:
        # Don't fail API startup in dev; endpoints can still be used to debug.
        pass

    # Optional: eagerly start the Copilot CLI transport so failures show up
    # immediately (instead of during the first user request).
    try:
        if _COPILOT_AVAILABLE:
            eager = (os.environ.get("SAW_COPILOT_EAGER_START") or "0").strip().lower() in ("1", "true", "yes", "on")
            if eager:
                asyncio.create_task(copilot_manager().warmup())
    except Exception:
        # Best-effort warmup; never block API startup.
        pass


class HealthResponse(BaseModel):
    ok: bool
    db_ok: bool
    db_error: str | None = None
    openai_enabled: bool
    copilot_available: bool
    copilot_ok: bool
    copilot: dict[str, Any]
    at: datetime
    workspace_root: str


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    db_ok = False
    db_error = None
    try:
        with db_conn(settings) as conn:
            conn.execute("SELECT 1")
            db_ok = True
    except Exception:
        db_ok = False
        db_error = "connect_failed"
    copilot_available = bool(_COPILOT_AVAILABLE)
    copilot_detail: dict[str, Any] = {}
    copilot_ok = False
    if copilot_available:
        try:
            copilot_detail = copilot_manager().health_status()
            # Green-light behavior:
            # - If eager start is enabled, require warmup_ok.
            # - Otherwise, consider it ok if the SDK imported (available).
            eager = (os.environ.get("SAW_COPILOT_EAGER_START") or "0").strip().lower() in ("1", "true", "yes", "on")
            if eager:
                copilot_ok = bool((copilot_detail or {}).get("warmup_ok"))
            else:
                copilot_ok = True
        except Exception as e:
            copilot_detail = {"warmup_started": False, "warmup_ok": False, "warmup_error": str(e), "client_config": {}}
            copilot_ok = False

    return HealthResponse(
        ok=True,
        db_ok=db_ok,
        db_error=db_error,
        openai_enabled=bool(settings.openai_api_key),
        copilot_available=copilot_available,
        copilot_ok=bool(copilot_ok),
        copilot=copilot_detail,
        at=datetime.utcnow(),
        workspace_root=settings.workspace_root,
    )


class AgentChatRequest(BaseModel):
    conversation_id: str | None = None
    message: str


class AgentApproveRequest(BaseModel):
    conversation_id: str
    tool_call_id: str
    approved: bool


class AgentHealthResponse(BaseModel):
    llm_available: bool
    agent_chat_route_ok: bool
    last_error: str


@app.get("/agent/health", response_model=AgentHealthResponse)
def agent_health() -> AgentHealthResponse:
    # Cheap checks only: no network calls to OpenAI.
    llm_available = bool(settings.openai_api_key) or bool(copilot_enabled())
    agent_chat_route_ok = callable(agent_chat)
    last_error = get_last_agent_error()
    if not llm_available and not last_error:
        last_error = "llm_not_configured"
    return AgentHealthResponse(
        llm_available=llm_available,
        agent_chat_route_ok=agent_chat_route_ok,
        last_error=str(last_error or ""),
    )


@app.post("/agent/chat")
async def agent_chat_post(req: AgentChatRequest, stream: bool = Query(False), provider: str | None = Query(None)) -> Any:
    provider_norm = (provider or "").strip().lower()
    if provider_norm not in ("copilot", "openai"):
        provider_norm = ""

    use_copilot = provider_norm == "copilot" or (not provider_norm and copilot_enabled())

    # JSON mode
    if not stream:
        if use_copilot:
            if not _COPILOT_AVAILABLE:
                return {"status": "error", "conversation_id": req.conversation_id, "error": "copilot_unavailable"}
            return await copilot_manager().chat_once(conversation_id=req.conversation_id, message=req.message)
        return agent_chat(conversation_id=req.conversation_id, message=req.message)

    # Streaming SSE mode (required for Copilot tool approval gating)
    async def gen_openai_once() -> Any:
        # Wrap the existing sync agent in a single-shot SSE stream.
        # If something goes wrong, emit a structured error instead of crashing the stream.
        cid = (req.conversation_id or "")
        yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.started', 'payload': {'provider': 'openai', 'model': agent_model()}})}\n\n"

        try:
            r = agent_chat(conversation_id=req.conversation_id, message=req.message)
        except Exception as e:
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.error', 'payload': {'message': str(e)}})}\n\n"
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.idle', 'payload': {}})}\n\n"
            return

        cid = (r or {}).get("conversation_id") or cid
        if (r or {}).get("status") == "needs_approval":
            tc = (r or {}).get("tool_call") or {}
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'permission.request', 'payload': {'kind': 'write', 'toolCallId': tc.get('id'), 'details': tc}})}\n\n"
            # In JSON mode, the UI will call /agent/approve; in SSE mode we just go idle.
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.idle', 'payload': {}})}\n\n"
            return
        msg = (r or {}).get("message") or (r or {}).get("error") or ""
        yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'assistant.message', 'payload': {'content': msg}})}\n\n"
        yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.idle', 'payload': {}})}\n\n"

    if not use_copilot:
        return StreamingResponse(gen_openai_once(), media_type="text/event-stream")

    if not _COPILOT_AVAILABLE:
        async def gen_unavailable() -> Any:
            cid = (req.conversation_id or "")
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.started', 'payload': {'provider': 'copilot'}})}\n\n"
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.error', 'payload': {'message': 'copilot_unavailable'}})}\n\n"
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.idle', 'payload': {}})}\n\n"

        return StreamingResponse(gen_unavailable(), media_type="text/event-stream")

    mgr = copilot_manager()
    try:
        conv, q = await mgr.stream_chat(conversation_id=req.conversation_id, message=req.message)
    except Exception as e:
        async def gen_err() -> Any:
            cid = (req.conversation_id or "")
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.started', 'payload': {'provider': 'copilot'}})}\n\n"
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.error', 'payload': {'message': str(e)}})}\n\n"
            yield f"event: saw.agent.event\ndata: {json.dumps({'conversation_id': cid, 'type': 'session.idle', 'payload': {}})}\n\n"
        return StreamingResponse(gen_err(), media_type="text/event-stream")

    async def gen() -> Any:
        # Drain queue until idle or error.
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Keep the SSE connection alive during long-running turns
                    # (e.g., Copilot CLI retries on network/TLS issues).
                    # Comment frames are ignored by standard SSE clients.
                    yield ": keepalive\n\n"
                    continue

                yield f"event: saw.agent.event\ndata: {json.dumps(ev)}\n\n"
                if ev.get("type") in ("session.idle", "session.error"):
                    break
        finally:
            # Ensure stream closes cleanly.
            pass

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/agent/approve")
def agent_approve_post(req: AgentApproveRequest, provider: str | None = Query(None)) -> dict[str, Any]:
    provider_norm = (provider or "").strip().lower()
    if provider_norm not in ("copilot", "openai"):
        provider_norm = ""

    use_copilot = provider_norm == "copilot" or (not provider_norm and copilot_enabled())

    # If Copilot is selected, first try to resolve a pending Copilot-gated tool call.
    if use_copilot and _COPILOT_AVAILABLE:
        ok = copilot_manager().approve(req.conversation_id, req.tool_call_id, bool(req.approved))
        if ok:
            return {"status": "ok", "conversation_id": req.conversation_id, "message": "ack", "model": "copilot"}
    # Fallback to existing OpenAI approval flow.
    return agent_approve(conversation_id=req.conversation_id, tool_call_id=req.tool_call_id, approved=req.approved)


@app.get("/agent/log")
def agent_log_get(tail: int = Query(200, ge=10, le=5000)) -> dict[str, Any]:
    """
    Read the SAW API agent log tail (dev-only).
    Note: message bodies are only logged when SAW_AGENT_LOG_CONTENT=1.
    """
    try:
        path = agent_log_path(settings)
        raw = open(path, "r", encoding="utf-8").read()
        lines = raw.splitlines() if raw else []
        tail_n = max(10, min(5000, int(tail)))
        return {"path": path, "tail": tail_n, "ndjson": "\n".join(lines[-tail_n:])}
    except Exception as e:
        return {"path": agent_log_path(settings), "tail": int(tail), "ndjson": "", "error": str(e)}


class MigrateResponse(BaseModel):
    ok: bool
    applied: list[str]
    already_applied: list[str]


@app.post("/db/migrate", response_model=MigrateResponse)
def db_migrate() -> MigrateResponse:
    try:
        r = migrate(settings)
        return MigrateResponse(ok=True, applied=r.applied, already_applied=r.already_applied)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"migrate_failed: {e}")


class InitResponse(BaseModel):
    ok: bool
    migrated: bool
    applied: list[str]
    already_applied: list[str]
    seeded_instance: bool


@app.post("/db/init", response_model=InitResponse)
def db_init() -> InitResponse:
    # Run migrations (admin URL), then seed a single instance row if none exists.
    try:
        mr = migrate(settings)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"init_migrate_failed: {e}")

    seeded = False
    try:
        with db_conn(settings) as conn:
            row = conn.execute("SELECT 1 FROM saw_meta.instance LIMIT 1").fetchone()
            if not row:
                conn.execute(
                    "INSERT INTO saw_meta.instance(saw_version, workspace_root) VALUES (%s, %s)",
                    ("0.1.0", settings.workspace_root),
                )
                seeded = True
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"init_seed_failed: {e}")

    return InitResponse(
        ok=True,
        migrated=True,
        applied=mr.applied,
        already_applied=mr.already_applied,
        seeded_instance=seeded,
    )


class IngestIndexRequest(BaseModel):
    uri: str
    doc_type: str = "note"
    content_text: str
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class IngestIndexResponse(BaseModel):
    ok: bool
    doc_id: str
    uri: str
    content_hash: str


@app.post("/ingest/index", response_model=IngestIndexResponse)
def ingest_index(req: IngestIndexRequest) -> IngestIndexResponse:
    uri = req.uri.strip()
    if not uri:
        raise HTTPException(status_code=400, detail="missing_uri")
    content_hash = sha256_text(req.content_text or "")
    with db_conn(settings) as conn:
        row = conn.execute(
            """
            INSERT INTO saw_ingest.document(uri, doc_type, content_hash, content_text, metadata_json)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (uri) DO UPDATE
              SET doc_type=EXCLUDED.doc_type,
                  content_hash=EXCLUDED.content_hash,
                  content_text=EXCLUDED.content_text,
                  metadata_json=EXCLUDED.metadata_json
            RETURNING doc_id
            """,
            (uri, req.doc_type, content_hash, req.content_text, jsonb(req.metadata_json)),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="ingest_failed")
        doc_id = str(row[0])
    return IngestIndexResponse(ok=True, doc_id=doc_id, uri=uri, content_hash=content_hash)


class EmbedUpsertRequest(BaseModel):
    uri: str
    doc_type: str = "file"
    content_text: str
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None
    chunk_max_chars: int = 4000
    chunk_overlap_chars: int = 300


class EmbedUpsertResponse(BaseModel):
    ok: bool
    model: str
    chunks_indexed: int
    chunks_skipped: int


@app.post("/embed/upsert", response_model=EmbedUpsertResponse)
def embed_upsert(req: EmbedUpsertRequest) -> EmbedUpsertResponse:
    try:
        uri = req.uri.strip()
        if not uri:
            raise HTTPException(status_code=400, detail="missing_uri")
        model = (req.model or settings.embed_model).strip()
        chunks = chunk_text(req.content_text or "", max_chars=req.chunk_max_chars, overlap=req.chunk_overlap_chars)
        if not chunks:
            return EmbedUpsertResponse(ok=True, model=model, chunks_indexed=0, chunks_skipped=0)

        indexed = 0
        skipped = 0
        with db_conn(settings) as conn:
            # Ensure base doc exists
            base_hash = sha256_text(req.content_text or "")
            conn.execute(
                """
                INSERT INTO saw_ingest.document(uri, doc_type, content_hash, content_text, metadata_json)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (uri) DO UPDATE
                  SET doc_type=EXCLUDED.doc_type,
                      content_hash=EXCLUDED.content_hash,
                      content_text=EXCLUDED.content_text,
                      metadata_json=EXCLUDED.metadata_json
                """,
                (uri, req.doc_type, base_hash, req.content_text, jsonb(req.metadata_json)),
            )

            # Upsert chunk docs and collect doc_ids
            chunk_rows: list[tuple[Any, str]] = []
            for i, chunk in enumerate(chunks):
                chunk_uri = f"{uri}#chunk={i}"
                chash = sha256_text(chunk)
                row = conn.execute(
                    """
                    INSERT INTO saw_ingest.document(uri, doc_type, content_hash, content_text, metadata_json)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (uri) DO UPDATE
                      SET doc_type=EXCLUDED.doc_type,
                          content_hash=EXCLUDED.content_hash,
                          content_text=EXCLUDED.content_text,
                          metadata_json=EXCLUDED.metadata_json
                    RETURNING doc_id
                    """,
                    (
                        chunk_uri,
                        f"{req.doc_type}_chunk",
                        chash,
                        chunk,
                        jsonb({**(req.metadata_json or {}), "parent_uri": uri, "chunk_index": i}),
                    ),
                ).fetchone()
                if not row:
                    raise HTTPException(status_code=500, detail="chunk_doc_upsert_failed")
                chunk_rows.append((row[0], chunk))

            doc_ids = [r[0] for r in chunk_rows]
            if not doc_ids:
                return EmbedUpsertResponse(ok=True, model=model, chunks_indexed=0, chunks_skipped=0)

            existing = conn.execute(
                "SELECT doc_id FROM saw_ingest.embedding WHERE model=%s AND doc_id = ANY(%s::uuid[])",
                (model, doc_ids),
            ).fetchall()
            existing_ids = {r[0] for r in existing}

            missing = [(doc_id, chunk) for (doc_id, chunk) in chunk_rows if doc_id not in existing_ids]
            skipped = len(chunk_rows) - len(missing)
            if not missing:
                return EmbedUpsertResponse(ok=True, model=model, chunks_indexed=0, chunks_skipped=skipped)

            # Embed only the missing chunks
            try:
                er = embed_texts(settings, [c for (_doc_id, c) in missing], model=model)
            except Exception as e:
                raise HTTPException(status_code=503, detail=f"embed_failed: {e}")

            for (doc_id, _chunk), vec in zip(missing, er.vectors):
                dims = len(vec)
                conn.execute(
                    "INSERT INTO saw_ingest.embedding(doc_id, model, dims, embedding) VALUES (%s, %s, %s, %s)",
                    (doc_id, model, dims, Vector(vec)),
                )
                indexed += 1

        return EmbedUpsertResponse(ok=True, model=model, chunks_indexed=indexed, chunks_skipped=skipped)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"embed_upsert_failed: {type(e).__name__}: {e}")


@app.post("/files/upload_audio_wav")
async def files_upload_audio_wav(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Upload a WAV file into:
      <saw-workspace>/.saw/uploads/

    Returns:
      { ok, path } where path is workspace-relative (e.g. ".saw/uploads/xyz.wav").
    """
    try:
        name = str(file.filename or "audio.wav")
        # keep only the basename, avoid traversal
        name = name.replace("\\", "/").split("/")[-1]
        if not name.lower().endswith(".wav"):
            name = name + ".wav"
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
        if not safe:
            safe = "audio.wav"
        out_dir = os.path.join(settings.workspace_root, ".saw", "uploads")
        os.makedirs(out_dir, exist_ok=True)
        # include timestamp to avoid collisions
        out_name = f"{int(datetime.utcnow().timestamp() * 1000)}_{safe}"
        abs_path = os.path.join(out_dir, out_name)
        data = await file.read()
        with open(abs_path, "wb") as f:
            f.write(data)
        rel_path = os.path.relpath(abs_path, settings.workspace_root).replace("\\", "/")
        return {"ok": True, "path": rel_path, "bytes": len(data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"upload_failed: {e}")


class VectorSearchRequest(BaseModel):
    query: str
    top_k: int = 8
    model: str | None = None


class VectorSearchHit(BaseModel):
    uri: str
    doc_type: str | None
    distance: float
    content_text: str | None
    metadata_json: dict[str, Any] | None


class VectorSearchResponse(BaseModel):
    ok: bool
    model: str
    hits: list[VectorSearchHit]


@app.post("/search/vector", response_model=VectorSearchResponse)
def search_vector(req: VectorSearchRequest) -> VectorSearchResponse:
    q = (req.query or "").strip()
    if not q:
        return VectorSearchResponse(ok=True, model=req.model or settings.embed_model, hits=[])
    model = (req.model or settings.embed_model).strip()
    try:
        er = embed_texts(settings, [q], model=model)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"embed_failed: {e}")
    if not er.vectors:
        return VectorSearchResponse(ok=True, model=model, hits=[])
    qv = Vector(er.vectors[0])
    top_k = max(1, min(50, int(req.top_k)))

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
            (qv, model, qv, top_k),
        ).fetchall()

    hits: list[VectorSearchHit] = []
    for (uri, doc_type, content_text, metadata_json, distance) in rows:
        hits.append(
            VectorSearchHit(
                uri=str(uri),
                doc_type=str(doc_type) if doc_type is not None else None,
                distance=float(distance),
                content_text=str(content_text) if content_text is not None else None,
                metadata_json=metadata_json if isinstance(metadata_json, dict) else None,
            )
        )
    return VectorSearchResponse(ok=True, model=model, hits=hits)


class AuditEventRequest(BaseModel):
    actor: str = "user"
    event_type: str
    details_json: dict[str, Any] = Field(default_factory=dict)


class AuditEventResponse(BaseModel):
    ok: bool
    event_id: str


@app.post("/audit/event", response_model=AuditEventResponse)
def audit_event(req: AuditEventRequest) -> AuditEventResponse:
    with db_conn(settings) as conn:
        row = conn.execute(
            """
            INSERT INTO saw_ops.audit_event(actor, event_type, details_json)
            VALUES (%s, %s, %s)
            RETURNING event_id
            """,
            (req.actor, req.event_type, jsonb(req.details_json)),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="audit_insert_failed")
        event_id = str(row[0])
    return AuditEventResponse(ok=True, event_id=event_id)


class PatchStoreProposalRequest(BaseModel):
    author: str = "agent"
    diff_unified: str
    target_paths: list[str] = Field(default_factory=list)
    validation_status: Literal["pending", "passed", "failed"] = "pending"
    validation_log: str = ""


class PatchStoreProposalResponse(BaseModel):
    ok: bool
    proposal_id: str


@app.post("/patch/store_proposal", response_model=PatchStoreProposalResponse)
def patch_store_proposal(req: PatchStoreProposalRequest) -> PatchStoreProposalResponse:
    if not (req.diff_unified or "").strip():
        raise HTTPException(status_code=400, detail="missing_diff_unified")
    with db_conn(settings) as conn:
        row = conn.execute(
            """
            INSERT INTO saw_ops.patch_proposal(author, diff_unified, target_paths, validation_status, validation_log)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING proposal_id
            """,
            (req.author, req.diff_unified, req.target_paths, req.validation_status, req.validation_log),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=500, detail="patch_proposal_insert_failed")
        proposal_id = str(row[0])
    return PatchStoreProposalResponse(ok=True, proposal_id=proposal_id)


class PatchMarkAppliedRequest(BaseModel):
    proposal_id: str
    applied_commit: str
    validation_status: Literal["pending", "passed", "failed"] = "passed"
    validation_log: str = ""


class PatchMarkAppliedResponse(BaseModel):
    ok: bool


@app.post("/patch/mark_applied", response_model=PatchMarkAppliedResponse)
def patch_mark_applied(req: PatchMarkAppliedRequest) -> PatchMarkAppliedResponse:
    with db_conn(settings) as conn:
        conn.execute(
            """
            UPDATE saw_ops.patch_proposal
            SET applied_commit=%s, validation_status=%s, validation_log=%s
            WHERE proposal_id=%s::uuid
            """,
            (req.applied_commit, req.validation_status, req.validation_log, req.proposal_id),
        )
    return PatchMarkAppliedResponse(ok=True)


class PluginListItem(BaseModel):
    id: str
    name: str
    version: str
    description: str
    category_path: str
    plugin_dir_rel: str
    locked: bool = False
    origin: Literal["stock", "dev"] = "dev"
    integrity: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None
    utility: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    inputs: list[dict[str, Any]] = Field(default_factory=list)
    outputs: list[dict[str, Any]] = Field(default_factory=list)
    parameters: list[dict[str, Any]] = Field(default_factory=list)


class PluginListResponse(BaseModel):
    ok: bool
    plugins: list[PluginListItem]


@app.get("/plugins/list", response_model=PluginListResponse)
def plugins_list() -> PluginListResponse:
    try:
        items = []
        repo_root = os.path.abspath(os.path.join(settings.workspace_root, ".."))
        stock = load_stock_catalog()
        for p in discover_plugins(settings):
            m = p.manifest
            parts = [x for x in (m.id or "").split(".") if x]
            category_path = str(m.category_path or "").strip()
            if not category_path:
                category_path = "workspace/runtime"
                if len(parts) >= 2:
                    category_path = f"workspace/{parts[0]}/{parts[1]}"
                elif len(parts) == 1:
                    category_path = f"workspace/{parts[0]}"

            plugin_dir_rel = os.path.relpath(p.plugin_dir, repo_root).replace("\\", "/")
            inputs = [{"id": k, "name": k, "type": v.type} for (k, v) in (m.inputs or {}).items()]
            outputs = [{"id": k, "name": k, "type": v.type} for (k, v) in (m.outputs or {}).items()]

            parameters: list[dict[str, Any]] = []
            for (pid, spec) in (m.params or {}).items():
                ptype = (spec.type or "").lower()
                kind = "text"
                if ptype in ("number", "float", "int", "integer"):
                    kind = "number"
                label = pid
                if isinstance(spec.ui, dict) and isinstance(spec.ui.get("label"), str):
                    label = str(spec.ui.get("label"))
                parameters.append(
                    {
                        "id": pid,
                        "label": label,
                        "kind": kind,
                        "default": spec.default,
                    }
                )

            locked = bool(m.id in stock)
            origin: Literal["stock", "dev"] = "stock" if locked else "dev"
            integrity: dict[str, Any] | None = None
            if locked:
                expected = stock[m.id].digest_sha256
                actual = ""
                restored = False
                try:
                    actual = compute_dir_digest_sha256(p.plugin_dir)
                except Exception:
                    actual = ""
                if actual != expected:
                    # Self-heal: restore the canonical stock plugin.
                    sync_stock_plugin_dir(stock[m.id].canonical_dir, p.plugin_dir)
                    restored = True
                    try:
                        actual = compute_dir_digest_sha256(p.plugin_dir)
                    except Exception:
                        actual = ""
                integrity = {"expected": expected, "actual": actual, "restored": restored}

            items.append(
                PluginListItem(
                    id=m.id,
                    name=m.name,
                    version=m.version,
                    description=m.description,
                    category_path=category_path,
                    plugin_dir_rel=plugin_dir_rel,
                    locked=locked,
                    origin=origin,
                    integrity=integrity,
                    ui=(m.ui.model_dump() if getattr(m, "ui", None) is not None else None),
                    utility=(m.utility.model_dump() if getattr(m, "utility", None) is not None else None),
                    meta=(m.meta.model_dump() if getattr(m, "meta", None) is not None else None),
                    inputs=inputs,
                    outputs=outputs,
                    parameters=parameters,
                )
            )
        return PluginListResponse(ok=True, plugins=items)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugins_list_failed: {e}")


def _safe_join_under_dir(root_dir: str, rel_path: str) -> str:
    # Prevent traversal attacks; only allow files under plugin_dir.
    root = os.path.abspath(root_dir)
    rel = str(rel_path or "").lstrip("/\\")
    full = os.path.abspath(os.path.join(root, rel))
    if full == root or not full.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="invalid_path")
    return full


@app.get("/plugins/ui/schema/{plugin_id}")
def plugins_ui_schema(plugin_id: str) -> dict[str, Any]:
    pid = (plugin_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing_plugin_id")

    plugins = {p.manifest.id: p for p in discover_plugins(settings)}
    plugin = plugins.get(pid)
    if not plugin:
        raise HTTPException(status_code=404, detail="unknown_plugin_id")

    ui = getattr(plugin.manifest, "ui", None)
    if ui is None:
        raise HTTPException(status_code=404, detail="missing_ui_config")
    # NOTE: We allow serving schema YAML even when ui.mode is not "schema".
    # This enables incremental migration (e.g., ship ui/declarative_ui.yaml alongside a legacy bundle).

    # Declarative UI discovery (incremental migration):
    # Prefer plugins/<pluginId>/ui/declarative_ui.yaml when present.
    # Otherwise fall back to the manifest-declared schema_file (default ui.yaml).
    declarative_ui_candidates = ["ui/declarative_ui.yaml", "ui/declarative_ui.yml"]
    schema_file = str(getattr(ui, "schema_file", "ui.yaml") or "ui.yaml")

    chosen_rel = schema_file
    chosen_kind = "schema"
    for rel in declarative_ui_candidates:
        try:
            p = _safe_join_under_dir(plugin.plugin_dir, rel)
            if os.path.isfile(p):
                chosen_rel = rel
                chosen_kind = "declarativeUi"
                break
        except HTTPException:
            # Ignore invalid paths; we only probe fixed internal candidates.
            pass

    schema_path = _safe_join_under_dir(plugin.plugin_dir, chosen_rel)
    if not os.path.isfile(schema_path):
        # Back-compat: if callers defaulted to Declarative UI but a plugin still only ships legacy ui.yaml,
        # transparently fall back.
        if chosen_rel in {"ui/declarative_ui.yaml", "ui/declarative_ui.yml"}:
            legacy_rel = "ui.yaml"
            legacy_path = _safe_join_under_dir(plugin.plugin_dir, legacy_rel)
            if os.path.isfile(legacy_path):
                schema_path = legacy_path
                chosen_rel = legacy_rel
                chosen_kind = "schema"
        if not os.path.isfile(schema_path):
            raise HTTPException(status_code=404, detail="schema_file_not_found")

    try:
        raw = yaml.safe_load(open(schema_path, "r", encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"schema_parse_failed: {e}")

    # Ensure JSON-serializable shape (yaml returns dict/list/scalars).
    return {
        "ok": True,
        "plugin_id": pid,
        "schema_file": chosen_rel,
        "schema_kind": chosen_kind,
        "schema": raw,
    }


@app.get("/plugins/ui/bundle/{plugin_id}")
def plugins_ui_bundle(plugin_id: str) -> Response:
    pid = (plugin_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing_plugin_id")

    plugins = {p.manifest.id: p for p in discover_plugins(settings)}
    plugin = plugins.get(pid)
    if not plugin:
        raise HTTPException(status_code=404, detail="unknown_plugin_id")

    ui = getattr(plugin.manifest, "ui", None)
    if ui is None:
        raise HTTPException(status_code=404, detail="missing_ui_config")
    # NOTE: We allow serving bundle JS even when ui.mode is not "bundle".
    # This enables incremental migration (schema is the default; bundle remains as a gated fallback).

    stock = load_stock_catalog()
    locked = bool(pid in stock)
    sandbox = bool(getattr(ui, "sandbox", True))

    # Policy:
    # - For dev/workspace plugins: require sandbox=true.
    # - For stock/locked plugins: allow bundle only when sandbox=false (treat as "approved prebuilt bundle").
    if locked and sandbox:
        raise HTTPException(status_code=403, detail="bundle_forbidden_locked_plugin")
    if (not locked) and (not sandbox):
        raise HTTPException(status_code=403, detail="bundle_requires_sandbox_true")

    bundle_file = str(getattr(ui, "bundle_file", "ui/ui.bundle.js") or "ui/ui.bundle.js")
    bundle_path = _safe_join_under_dir(plugin.plugin_dir, bundle_file)
    if not os.path.isfile(bundle_path):
        raise HTTPException(status_code=404, detail="bundle_file_not_found")

    try:
        js = open(bundle_path, "r", encoding="utf-8").read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"bundle_read_failed: {e}")

    return Response(content=js, media_type="application/javascript")


class PluginExecuteRequest(BaseModel):
    plugin_id: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


class PluginExecuteResponse(BaseModel):
    ok: bool
    plugin_id: str
    outputs: dict[str, Any]
    logs: list[dict[str, Any]]
    raw_stdout: str = ""
    raw_stderr: str = ""


class PluginForkRequest(BaseModel):
    from_plugin_id: str
    new_plugin_id: str
    new_name: str | None = None


class PluginForkResponse(BaseModel):
    ok: bool
    from_plugin_id: str
    new_plugin_id: str
    plugin_dir: str


@app.post("/plugins/fork", response_model=PluginForkResponse)
def plugins_fork(req: PluginForkRequest) -> PluginForkResponse:
    src_id = (req.from_plugin_id or "").strip()
    new_id = (req.new_plugin_id or "").strip()
    if not src_id or not new_id:
        raise HTTPException(status_code=400, detail="missing_plugin_id")

    # Reject path separators / traversal; keep ids filename-safe.
    if not re.match(r"^[A-Za-z0-9_.-]+$", new_id):
        raise HTTPException(status_code=400, detail="invalid_new_plugin_id")

    stock = load_stock_catalog()
    src = stock.get(src_id)
    if not src:
        raise HTTPException(status_code=404, detail="unknown_stock_plugin_id")
    if new_id in stock:
        raise HTTPException(status_code=409, detail="new_plugin_id_is_locked")

    dest_dir = os.path.join(settings.workspace_root, "plugins", new_id)
    if os.path.exists(dest_dir):
        raise HTTPException(status_code=409, detail="new_plugin_id_already_exists")

    try:
        sync_stock_plugin_dir(src.canonical_dir, dest_dir)
        # Rewrite id/name in plugin.yaml
        manifest_path = os.path.join(dest_dir, "plugin.yaml")
        raw = yaml.safe_load(open(manifest_path, "r", encoding="utf-8"))
        if not isinstance(raw, dict):
            raw = {}
        old_name = str(raw.get("name") or src_id)
        raw["id"] = new_id
        raw["name"] = str(req.new_name).strip() if isinstance(req.new_name, str) and req.new_name.strip() else f"{old_name} (Fork)"
        with open(manifest_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(raw, f, sort_keys=False)
        return PluginForkResponse(ok=True, from_plugin_id=src_id, new_plugin_id=new_id, plugin_dir=dest_dir)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugin_fork_failed: {e}")


class PluginCreateFromPythonRequest(BaseModel):
    plugin_id: str
    name: str
    description: str = ""
    category_path: str | None = None
    version: str = "0.1.0"

    # Code: raw python file content (will be placed into wrapper.py template)
    python_code: str

    # Minimal IO defaults: one file/path input and one result output.
    input_id: str = "file"
    input_type: str = "path"
    output_id: str = "result"
    output_type: str = "object"

    # Environment (optional)
    pip: list[str] = Field(default_factory=list)

    # Safety policies (defaults are conservative)
    side_effects_network: Literal["none", "restricted", "allowed"] = "none"
    side_effects_disk: Literal["read_only", "read_write"] = "read_only"
    side_effects_subprocess: Literal["forbidden", "allowed"] = "forbidden"
    threads: int = 1

    # Optional: probe after writing files (may install deps if ensure_env=true)
    probe: bool = True
    probe_ensure_env: bool = True


class PluginProbeResponse(BaseModel):
    ok: bool
    plugin_id: str
    env_key: str | None = None
    error: str | None = None


class PluginCreateFromPythonResponse(BaseModel):
    ok: bool
    plugin_id: str
    plugin_dir: str
    probed: bool
    probe: PluginProbeResponse | None = None


def _write_text(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _probe_plugin_dir(
    *,
    plugin_id: str,
    plugin_dir: str,
    entry_file: str,
    callable_name: str,
    env_pip: list[str],
    ensure_env: bool,
) -> PluginProbeResponse:
    try:
        env_key = None
        py = sys.executable
        if ensure_env:
            er = env_manager.compute_env_resolution(
                settings=settings,
                plugin_dir=plugin_dir,
                plugin_id=plugin_id,
                plugin_version="0.0.0",
                env_python=">=3.11,<3.13",
                env_lockfile=None,
                env_requirements=None,
                env_pip=env_pip or [],
                extras={"cuda": "none"},
            )
            env_key = er.env_key
            py = env_manager.ensure_env(settings, er.env_key, er.deps, plugin_dir=plugin_dir)

        probe_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "plugin_probe.py"))
        p = subprocess.run(
            [py, probe_script, "--plugin-dir", plugin_dir, "--entry-file", entry_file, "--callable", callable_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=dict(os.environ),
        )
        if p.returncode == 0:
            return PluginProbeResponse(ok=True, plugin_id=plugin_id, env_key=env_key)
        raw = (p.stdout.decode("utf-8", errors="ignore") or "").strip()
        err = raw
        try:
            j = json.loads(raw or "{}")
            if isinstance(j, dict) and isinstance(j.get("error"), str):
                err = str(j.get("error"))
        except Exception:
            pass
        if not err:
            err = (p.stderr.decode("utf-8", errors="ignore") or "").strip()[:2000] or "probe_failed"
        return PluginProbeResponse(ok=False, plugin_id=plugin_id, env_key=env_key, error=err[:4000])
    except Exception as e:
        return PluginProbeResponse(ok=False, plugin_id=plugin_id, error=f"{type(e).__name__}: {e}")


@app.post("/plugins/create_from_python", response_model=PluginCreateFromPythonResponse)
def plugins_create_from_python(req: PluginCreateFromPythonRequest) -> PluginCreateFromPythonResponse:
    pid = (req.plugin_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing_plugin_id")
    if not re.match(r"^[A-Za-z0-9_.-]+$", pid):
        raise HTTPException(status_code=400, detail="invalid_plugin_id")

    stock = load_stock_catalog()
    if pid in stock:
        raise HTTPException(status_code=409, detail="plugin_id_is_locked")

    plugin_dir = os.path.join(settings.workspace_root, "plugins", pid)
    if os.path.exists(plugin_dir):
        raise HTTPException(status_code=409, detail="plugin_id_already_exists")

    name = (req.name or pid).strip()
    if not name:
        name = pid

    desc = str(req.description or "").strip()
    cat = (req.category_path or "").strip() or None

    input_id = (req.input_id or "file").strip() or "file"
    output_id = (req.output_id or "result").strip() or "result"
    input_type = (req.input_type or "path").strip() or "path"
    output_type = (req.output_type or "object").strip() or "object"

    # Keep ids filename/key safe-ish
    if not re.match(r"^[A-Za-z0-9_.-]+$", input_id):
        raise HTTPException(status_code=400, detail="invalid_input_id")
    if not re.match(r"^[A-Za-z0-9_.-]+$", output_id):
        raise HTTPException(status_code=400, detail="invalid_output_id")

    pip = [str(x).strip() for x in (req.pip or []) if str(x).strip()]

    wrapper_user_code = (req.python_code or "").rstrip() + "\n"
    if not wrapper_user_code.strip():
        raise HTTPException(status_code=400, detail="missing_python_code")

    wrapper = (
        '"""SAW Workspace Plugin (generated)\n\n'
        "Edit this file to integrate your lab code.\n\n"
        "You can provide either:\n"
        "  - def main(inputs: dict, params: dict, context) -> dict\n"
        "or\n"
        "  - def run(file_path: str, params: dict, context) -> dict\n\n"
        f'Default input key: "{input_id}" (expects inputs["{input_id}"]["data"])\n'
        f'Default output key: "{output_id}"\n'
        '"""\n\n'
        "from __future__ import annotations\n\n"
        "from typing import Any\n\n"
        "# --- user code (start) ---\n"
        f"{wrapper_user_code}"
        "# --- user code (end) ---\n\n"
        "_USER_MAIN = globals().get('main')\n"
        "_USER_RUN = globals().get('run')\n\n"
        "def main(inputs: dict, params: dict, context) -> dict:\n"
        "    # Prefer user-defined main() if present.\n"
        "    if callable(_USER_MAIN):\n"
        "        return _USER_MAIN(inputs, params, context)\n"
        "    # Fallback: call user-defined run(file_path, params, context)\n"
        "    if callable(_USER_RUN):\n"
        f"        x = (inputs or {{}}).get('{input_id}') or {{}}\n"
        "        file_path = x.get('data')\n"
        "        return {"
        f"'{output_id}': {{'data': _USER_RUN(file_path, params or {{}}, context), 'metadata': {{}}}}"
        "}\n"
        "    raise RuntimeError('missing_entrypoint: define main(inputs, params, context) or run(file_path, params, context)')\n"
    )

    manifest: dict[str, Any] = {
        "id": pid,
        "name": name,
        "version": str(req.version or "0.1.0"),
        "description": desc,
        "category_path": cat,
        "entrypoint": {"file": "wrapper.py", "callable": "main"},
        "environment": {"python": ">=3.11,<3.13", "pip": pip},
        "inputs": {input_id: {"type": input_type}},
        "params": {},
        "outputs": {output_id: {"type": output_type}},
        "execution": {"deterministic": False, "cacheable": False},
        "side_effects": {
            "network": req.side_effects_network,
            "disk": req.side_effects_disk,
            "subprocess": req.side_effects_subprocess,
        },
        "resources": {"gpu": "forbidden", "threads": int(req.threads or 1)},
        "ui": {
            "mode": "schema",
            "schema_file": "ui/declarative_ui.yaml",
            "bundle_file": "ui/ui.bundle.js",
            "sandbox": True,
        },
    }

    ui_schema = (
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
    )

    try:
        os.makedirs(plugin_dir, exist_ok=False)
        os.makedirs(os.path.join(plugin_dir, "ui"), exist_ok=True)
        _write_text(os.path.join(plugin_dir, "wrapper.py"), wrapper)
        _write_text(os.path.join(plugin_dir, "ui", "declarative_ui.yaml"), ui_schema)
        with open(os.path.join(plugin_dir, "plugin.yaml"), "w", encoding="utf-8") as f:
            yaml.safe_dump(manifest, f, sort_keys=False)
    except FileExistsError:
        raise HTTPException(status_code=409, detail="plugin_id_already_exists")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugin_create_failed: {e}")

    probe: PluginProbeResponse | None = None
    probed = False
    if bool(req.probe):
        probed = True
        probe = _probe_plugin_dir(
            plugin_id=pid,
            plugin_dir=plugin_dir,
            entry_file="wrapper.py",
            callable_name="main",
            env_pip=pip,
            ensure_env=bool(req.probe_ensure_env),
        )

    return PluginCreateFromPythonResponse(ok=True, plugin_id=pid, plugin_dir=plugin_dir, probed=probed, probe=probe)


@app.post("/plugins/execute", response_model=PluginExecuteResponse)
def plugins_execute(req: PluginExecuteRequest) -> PluginExecuteResponse:
    pid = (req.plugin_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing_plugin_id")
    plugins = {p.manifest.id: p for p in discover_plugins(settings)}
    plugin = plugins.get(pid)
    if not plugin:
        raise HTTPException(status_code=404, detail="unknown_plugin_id")
    try:
        stock = load_stock_catalog()
        if pid in stock:
            expected = stock[pid].digest_sha256
            actual = ""
            try:
                actual = compute_dir_digest_sha256(plugin.plugin_dir)
            except Exception:
                actual = ""
            if actual != expected:
                sync_stock_plugin_dir(stock[pid].canonical_dir, plugin.plugin_dir)
        r = execute_plugin(settings, plugin, inputs=req.inputs, params=req.params)
        return PluginExecuteResponse(
            ok=bool(r.get("ok", True)),
            plugin_id=pid,
            outputs=r.get("outputs") or {},
            logs=r.get("logs") or [],
            raw_stdout=str(r.get("raw_stdout") or ""),
            raw_stderr=str(r.get("raw_stderr") or ""),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugin_execute_failed: {e}")


class PluginRunRequest(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


class PluginRunResponse(BaseModel):
    ok: bool
    plugin_id: str
    run_id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    env_key: str
    run_dir: str


@app.post("/api/plugins/{plugin_id}/run", response_model=PluginRunResponse)
def api_plugin_run(plugin_id: str, req: PluginRunRequest) -> PluginRunResponse:
    pid = (plugin_id or "").strip()
    if not pid:
        raise HTTPException(status_code=400, detail="missing_plugin_id")
    plugins = {p.manifest.id: p for p in discover_plugins(settings)}
    plugin = plugins.get(pid)
    if not plugin:
        raise HTTPException(status_code=404, detail="unknown_plugin_id")

    try:
        stock = load_stock_catalog()
        if pid in stock:
            expected = stock[pid].digest_sha256
            actual = ""
            try:
                actual = compute_dir_digest_sha256(plugin.plugin_dir)
            except Exception:
                actual = ""
            if actual != expected:
                sync_stock_plugin_dir(stock[pid].canonical_dir, plugin.plugin_dir)
        rs = spawn_run(
            settings,
            plugin_id=plugin.manifest.id,
            plugin_version=plugin.manifest.version,
            plugin_dir=plugin.plugin_dir,
            entry_file=plugin.manifest.entrypoint.file,
            entry_callable=plugin.manifest.entrypoint.callable,
            env_python=plugin.manifest.environment.python,
            env_lockfile=plugin.manifest.environment.lockfile,
            env_requirements=getattr(plugin.manifest.environment, "requirements", None),
            env_pip=plugin.manifest.environment.pip,
            inputs=req.inputs,
            params=req.params,
        )
        return PluginRunResponse(
            ok=True,
            plugin_id=plugin.manifest.id,
            run_id=rs.run_id,
            status=rs.status,
            env_key=rs.env_key,
            run_dir=rs.run_dir,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugin_run_failed: {e}")


class RunGetResponse(BaseModel):
    ok: bool
    plugin_id: str
    run_id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    env_key: str | None = None
    run_dir: str
    outputs: dict[str, Any] = Field(default_factory=dict)
    logs_path: str
    services: list[dict[str, Any]] = Field(default_factory=list)
    error_text: str | None = None


@app.get("/api/runs/{plugin_id}/{run_id}", response_model=RunGetResponse)
def api_get_run(plugin_id: str, run_id: str) -> RunGetResponse:
    info = get_run_info(settings, plugin_id=plugin_id, run_id=run_id)
    if not info:
        raise HTTPException(status_code=404, detail="run_not_found")
    return RunGetResponse(
        ok=True,
        plugin_id=info.plugin_id,
        run_id=info.run_id,
        status=info.status,
        env_key=info.env_key,
        run_dir=info.run_dir,
        outputs=info.outputs or {},
        logs_path=info.logs_path,
        services=info.services or [],
        error_text=info.error_text,
    )


class ServiceStopResponse(BaseModel):
    ok: bool
    stopped: bool
    prior_status: str


@app.post("/api/services/{service_id}/stop", response_model=ServiceStopResponse)
def api_stop_service(service_id: str) -> ServiceStopResponse:
    stopped, prior = stop_service(settings, service_id)
    return ServiceStopResponse(ok=True, stopped=bool(stopped), prior_status=str(prior))
