from __future__ import annotations

import os
from pathlib import Path

import httpx
import jinja2
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.responses import HTMLResponse

app = FastAPI()

# Jinja2 template setup
TEMPLATES = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.dirname(__file__)),
    autoescape=jinja2.select_autoescape(["html", "xml"]),
)

SAW_API = os.environ.get("SAW_API_URL", "http://127.0.0.1:5127")
DEFAULT_REPO_ROOT = os.environ.get("SAW_REPO_ROOT") or os.environ.get("SAW_WORKSPACE_ROOT") or str(Path.cwd())


async def _fetch_graph(
    *,
    repo_root: str,
    include_python: bool,
    include_ts: bool,
    include_tests: bool,
    scope_prefix: str,
    max_files: int,
) -> dict:
    async with httpx.AsyncClient() as client:
        params = {
            "repo_root": repo_root,
            "include_python": include_python,
            "include_ts": include_ts,
            "include_tests": include_tests,
            "scope_prefix": scope_prefix,
            "max_files": max_files,
        }
        r = await client.get(f"{SAW_API}/repo-intel/simple-graph", params=params)
        r.raise_for_status()
        return r.json()


@app.get("/", response_class=HTMLResponse)
async def index(
    repo_root: str = DEFAULT_REPO_ROOT,
    include_python: bool = True,
    include_ts: bool = True,
    include_tests: bool = True,
    scope_prefix: str = "",
    max_files: int = 6000,
):
    graph = await _fetch_graph(
        repo_root=repo_root,
        include_python=include_python,
        include_ts=include_ts,
        include_tests=include_tests,
        scope_prefix=scope_prefix,
        max_files=max_files,
    )

    tpl = TEMPLATES.get_template("graph.html")
    return tpl.render(repo_root=repo_root, graph=graph)


@app.get("/graph.json", response_class=JSONResponse)
async def graph_json(
    repo_root: str = DEFAULT_REPO_ROOT,
    include_python: bool = True,
    include_ts: bool = True,
    include_tests: bool = True,
    scope_prefix: str = "",
    max_files: int = 6000,
):
    graph = await _fetch_graph(
        repo_root=repo_root,
        include_python=include_python,
        include_ts=include_ts,
        include_tests=include_tests,
        scope_prefix=scope_prefix,
        max_files=max_files,
    )
    return JSONResponse(graph)
