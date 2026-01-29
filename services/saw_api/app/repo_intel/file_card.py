from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from ..db import db_conn
from ..settings import get_settings

settings = get_settings()
file_card_router = APIRouter()

class FileCardGetResponse(BaseModel):
    rel_path: str
    description_md: str | None
    updated_at: str | None
    deps_out: list[str]
    deps_in: list[str]

class FileCardUpsertRequest(BaseModel):
    repo_id: str
    scan_id: str
    rel_path: str
    description_md: str
    author: str | None = None

class FileCardUpsertResponse(BaseModel):
    ok: bool
    updated_at: str

@file_card_router.get("/repo-intel/file-card", response_model=FileCardGetResponse)
def file_card_get(repo_id: str, scan_id: str, rel_path: str):
    with db_conn(settings) as conn:
        # Get description
        row = conn.execute(
            "SELECT description_md, updated_at FROM repo_intel.file_cards WHERE repo_id=%s AND scan_id=%s AND rel_path=%s",
            (repo_id, scan_id, rel_path),
        ).fetchone()
        desc, updated_at = (row or (None, None))
        # Outbound deps
        out_rows = conn.execute(
            """
            SELECT fd.rel_path FROM repo_intel.import_edges e
            JOIN repo_intel.files fs ON fs.file_id=e.src_file_id
            JOIN repo_intel.files fd ON fd.file_id=e.dst_file_id
            WHERE e.scan_id=%s AND fs.rel_path=%s
            """,
            (scan_id, rel_path),
        ).fetchall()
        deps_out = [r[0] for r in out_rows]
        # Inbound deps
        in_rows = conn.execute(
            """
            SELECT fs.rel_path FROM repo_intel.import_edges e
            JOIN repo_intel.files fs ON fs.file_id=e.src_file_id
            JOIN repo_intel.files fd ON fd.file_id=e.dst_file_id
            WHERE e.scan_id=%s AND fd.rel_path=%s
            """,
            (scan_id, rel_path),
        ).fetchall()
        deps_in = [r[0] for r in in_rows]
        return FileCardGetResponse(
            rel_path=rel_path,
            description_md=desc,
            updated_at=updated_at.isoformat() if updated_at else None,
            deps_out=deps_out,
            deps_in=deps_in,
        )

@file_card_router.post("/repo-intel/file-card", response_model=FileCardUpsertResponse)
def file_card_upsert(req: FileCardUpsertRequest):
    with db_conn(settings) as conn:
        conn.execute(
            """
            INSERT INTO repo_intel.file_cards (repo_id, scan_id, rel_path, description_md, author, updated_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (repo_id, scan_id, rel_path)
            DO UPDATE SET description_md=EXCLUDED.description_md, author=EXCLUDED.author, updated_at=now()
            """,
            (req.repo_id, req.scan_id, req.rel_path, req.description_md, req.author),
        )
        return FileCardUpsertResponse(ok=True, updated_at="now")
