from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import httpx
import os
import jinja2
import StaticFiles

app = FastAPI()

# Jinja2 template setup
TEMPLATES = jinja2.Environment(
    loader=jinja2.FileSystemLoader(os.path.dirname(__file__)),
    autoescape=jinja2.select_autoescape(["html", "xml"]),
)

SAW_API = os.environ.get("SAW_API_URL", "http://127.0.0.1:5127")

@app.get("/", response_class=HTMLResponse)
async def index():
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{SAW_API}/repo-intel/repos")
        repos = r.json().get("repos", [])
    tpl = TEMPLATES.get_template("index.html")
    return tpl.render(repos=repos)

@app.get("/repo/{repo_id}/scan/{scan_id}", response_class=HTMLResponse)
async def repo_scan(repo_id: str, scan_id: str):
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{SAW_API}/repo-intel/graph", params={"repo_id": repo_id, "scan_id": scan_id})
        graph = r.json()
    tpl = TEMPLATES.get_template("graph.html")
    return tpl.render(repo_id=repo_id, scan_id=scan_id, graph=graph)

@app.get("/repo/{repo_id}/scan/{scan_id}/file")
async def file_detail(repo_id: str, scan_id: str, rel_path: str):
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{SAW_API}/repo-intel/file-card", params={"repo_id": repo_id, "scan_id": scan_id, "rel_path": rel_path})
        card = r.json()
    tpl = TEMPLATES.get_template("file_detail.html")
    return tpl.render(card=card)

@app.post("/repo/{repo_id}/scan/{scan_id}/file")
async def save_description(repo_id: str, scan_id: str, rel_path: str = Form(...), description_md: str = Form(...)):
    async with httpx.AsyncClient() as client:
        await client.post(f"{SAW_API}/repo-intel/file-card", json={"repo_id": repo_id, "scan_id": scan_id, "rel_path": rel_path, "description_md": description_md})
    return RedirectResponse(f"/repo/{repo_id}/scan/{scan_id}/file?rel_path={rel_path}", status_code=303)

# Static files for JS/CSS (if needed)
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
