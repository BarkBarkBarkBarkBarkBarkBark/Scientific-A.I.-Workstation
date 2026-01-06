from __future__ import annotations

from datetime import datetime
import os
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pgvector.psycopg import Vector

from .db import db_conn, jsonable, jsonb, sha256_text
from .embeddings import chunk_text, embed_texts
from .migrations import migrate
from .plugins_runtime import discover_plugins, execute_plugin
from .settings import get_settings
from .bootstrap import bootstrap


settings = get_settings()
app = FastAPI(title="SAW API", version="0.1.0")

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
    except Exception:
        # Don't fail API startup in dev; endpoints can still be used to debug.
        pass


class HealthResponse(BaseModel):
    ok: bool
    db_ok: bool
    db_error: str | None = None
    openai_enabled: bool
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
    return HealthResponse(
        ok=True,
        db_ok=db_ok,
        db_error=db_error,
        openai_enabled=bool(settings.openai_api_key),
        at=datetime.utcnow(),
        workspace_root=settings.workspace_root,
    )


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
        for p in discover_plugins(settings):
            m = p.manifest
            parts = [x for x in (m.id or "").split(".") if x]
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

            items.append(
                PluginListItem(
                    id=m.id,
                    name=m.name,
                    version=m.version,
                    description=m.description,
                    category_path=category_path,
                    plugin_dir_rel=plugin_dir_rel,
                    inputs=inputs,
                    outputs=outputs,
                    parameters=parameters,
                )
            )
        return PluginListResponse(ok=True, plugins=items)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugins_list_failed: {e}")


class PluginExecuteRequest(BaseModel):
    plugin_id: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


class PluginExecuteResponse(BaseModel):
    ok: bool
    plugin_id: str
    outputs: dict[str, Any]
    logs: list[dict[str, Any]]


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
        r = execute_plugin(settings, plugin, inputs=req.inputs, params=req.params)
        return PluginExecuteResponse(
            ok=bool(r.get("ok", True)),
            plugin_id=pid,
            outputs=r.get("outputs") or {},
            logs=r.get("logs") or [],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"plugin_execute_failed: {e}")


