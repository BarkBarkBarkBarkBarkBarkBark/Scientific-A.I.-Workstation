from __future__ import annotations

import os
from pathlib import Path

import httpx
import jinja2
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

# Jinja2 template setup
TEMPLATES = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.dirname(__file__)),
    autoescape=jinja2.select_autoescape(["html", "xml"]),
)

SAW_API = os.environ.get("SAW_API_URL", "http://127.0.0.1:5127")
DEFAULT_REPO_ROOT = os.environ.get("SAW_REPO_ROOT") or os.environ.get("SAW_WORKSPACE_ROOT") or str(Path.cwd())


@app.get("/", response_class=HTMLResponse)
async def index():
    async with httpx.AsyncClient() as client:
        params = {"repo_root": DEFAULT_REPO_ROOT}
        r = await client.get(f"{SAW_API}/repo-intel/simple-graph", params=params)
        r.raise_for_status()
        graph = r.json()

    tpl = TEMPLATES.get_template("graph.html")
    return tpl.render(
        repo_root=DEFAULT_REPO_ROOT,
        graph=graph,
    )
