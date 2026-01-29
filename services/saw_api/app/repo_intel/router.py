from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from .simple_graph import build_simple_graph


router = APIRouter(prefix="/repo-intel", tags=["repo-intel"])


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
