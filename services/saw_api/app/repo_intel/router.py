from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..db import db_conn
from ..settings import get_settings
from .service import (
    create_scan_for_repo,
    evidence_summary,
    get_graph,
    get_scan,
    list_recommendations,
    propose_patch_diff,
    register_repo,
    start_scan_background,
)
from .file_card import file_card_router
from .simple_graph import build_simple_graph


settings = get_settings()
router = APIRouter(prefix="/repo-intel", tags=["repo-intel"])
router.include_router(file_card_router)


class RegisterRepoRequest(BaseModel):
    name: str = Field(...)
    root_path: str = Field(...)


class RegisterRepoResponse(BaseModel):
    repo_id: str


@router.post("/repos/register", response_model=RegisterRepoResponse)
def repos_register(req: RegisterRepoRequest) -> RegisterRepoResponse:
    try:
        with db_conn(settings) as conn:
            repo_id = register_repo(conn, req.name, req.root_path)
        return RegisterRepoResponse(repo_id=repo_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"repo_register_failed: {e}")


@router.get("/repos")
def repos_list() -> Any:
    with db_conn(settings) as conn:
        rows = conn.execute(
            "SELECT repo_id, name, root_path FROM repo_intel.repos ORDER BY name",
        ).fetchall()
        return {
            "repos": [
                {"repo_id": str(repo_id), "name": str(name), "root_path": str(root_path)}
                for repo_id, name, root_path in rows
            ]
        }


class StartScanRequest(BaseModel):
    repo_id: str
    scan_type: Literal["static_scan", "runtime_run"]
    config: dict[str, Any] = Field(default_factory=dict)


class StartScanResponse(BaseModel):
    scan_id: str
    status: Literal["running"]


@router.post("/scans/start", response_model=StartScanResponse)
def scans_start(req: StartScanRequest) -> StartScanResponse:
    try:
        with db_conn(settings) as conn:
            # repo_id must exist
            row = conn.execute("SELECT repo_id, root_path, name FROM repo_intel.repos WHERE repo_id=%s", (req.repo_id,)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="repo_not_found")
            repo_id, root_path, _name = str(row[0]), str(row[1]), str(row[2])
            scan_id = create_scan_for_repo(settings, conn, repo_id, root_path, req.scan_type, req.config or {})

        start_scan_background(settings, repo_id, root_path, scan_id, req.scan_type)
        return StartScanResponse(scan_id=scan_id, status="running")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"scan_start_failed: {e}")


@router.get("/scans/{scan_id}")
def scans_get(scan_id: str) -> Any:
    with db_conn(settings) as conn:
        scan = get_scan(conn, scan_id)
        if not scan:
            raise HTTPException(status_code=404, detail="scan_not_found")
        progress = scan.pop("progress")
        return {"scan": scan, "progress": progress}


@router.get("/graph")
def graph_get(
    repo_id: str,
    scan_id: str,
    scope_prefix: str | None = Query(None),
    include_tests: bool = Query(False),
) -> Any:
    with db_conn(settings) as conn:
        try:
            return get_graph(conn, repo_id, scan_id, scope_prefix, include_tests)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"graph_failed: {e}")


@router.get("/simple-graph")
def simple_graph_get(
    repo_root: str,
    include_python: bool = True,
    include_ts: bool = False,
    include_tests: bool = False,
    scope_prefix: str | None = Query(None),
    max_files: int = 6000,
) -> Any:
    repo_root_path = repo_root.strip()
    if not repo_root_path:
        raise HTTPException(status_code=400, detail="repo_root_required")
    repo_root_abs = os.path.abspath(repo_root_path)
    if not os.path.isdir(repo_root_abs):
        raise HTTPException(status_code=400, detail="repo_root_not_found")
    return build_simple_graph(
        repo_root=Path(repo_root_abs),
        include_python=include_python,
        include_ts=include_ts,
        include_tests=include_tests,
        scope_prefix=scope_prefix or "",
        max_files=max_files,
    )


@router.get("/evidence/summary")
def evidence_summary_get(
    repo_id: str,
    git_commit: str | None = Query(None),
    time_window_days: int | None = Query(None),
) -> Any:
    with db_conn(settings) as conn:
        try:
            return evidence_summary(conn, repo_id, git_commit, time_window_days)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"evidence_summary_failed: {e}")


@router.get("/recommendations")
def recommendations_get(
    repo_id: str,
    scan_id: str,
    min_severity: int = Query(2),
) -> Any:
    with db_conn(settings) as conn:
        try:
            return {"recommendations": list_recommendations(conn, repo_id, scan_id, min_severity)}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"recommendations_failed: {e}")


class ProposePatchRequest(BaseModel):
    repo_id: str
    scan_id: str
    rec_id: str
    action: Literal["delete_file", "delete_symbol", "refactor_split", "add_ignore_rule"]


class ProposePatchResponse(BaseModel):
    patch_unified_diff: str


@router.post("/recommendations/propose_patch", response_model=ProposePatchResponse)
def propose_patch(req: ProposePatchRequest) -> ProposePatchResponse:
    try:
        diff = propose_patch_diff(settings, req.repo_id, req.scan_id, req.rec_id, req.action)
        return ProposePatchResponse(patch_unified_diff=diff)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"propose_patch_failed: {e}")
