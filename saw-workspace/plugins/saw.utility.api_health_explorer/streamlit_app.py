from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import requests
import streamlit as st


def _workspace_root() -> Path:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return Path(env).resolve()
    # Fallback: streamlit runs with cwd=plugin dir; go up to saw-workspace.
    here = Path(__file__).resolve().parent
    return (here / ".." / "..").resolve()


def _api_url() -> str:
    return os.environ.get("SAW_API_URL") or "http://localhost:5127"


def _load_endpoints_from_api(api_url: str) -> dict[str, Any]:
    url = api_url.rstrip("/") + "/api-health/report"
    try:
        resp = requests.post(url, json={"mode": "spec", "use_cache": True}, timeout=15)
        if resp.status_code >= 400:
            return {"error": f"http_{resp.status_code}", "text": resp.text}
        return resp.json() or {}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


st.set_page_config(page_title="SAW API Health Explorer", layout="wide")
st.title("API Health Explorer")

api_url = st.sidebar.text_input("SAW API URL", value=_api_url())
endpoints_doc = _load_endpoints_from_api(api_url)
services = endpoints_doc.get("services") or []

if not services:
    err = endpoints_doc.get("error")
    if err:
        st.error(f"Failed to load API endpoints via /api-health/report: {err}")
        if endpoints_doc.get("text"):
            st.text(endpoints_doc.get("text"))
    else:
        st.warning("No API endpoints found via /api-health/report")
    st.stop()

service_ids = [s.get("id") for s in services]
service_id = st.selectbox("Service", options=service_ids, index=0)
service = next((s for s in services if s.get("id") == service_id), {})

st.caption(service.get("description") or "")

query = st.text_input("Filter endpoints")
endpoints = service.get("endpoints") or []
if query:
    endpoints = [e for e in endpoints if query.lower() in (e.get("path") or "").lower()]

selected = st.selectbox(
    "Endpoint",
    options=endpoints,
    format_func=lambda e: f"{e.get('method')} {e.get('path')}",
)

method = selected.get("method") or "GET"
path = selected.get("path") or ""
browser_path = selected.get("browser_path") or path

st.markdown(f"**Description:** {selected.get('description') or '—'}")

col1, col2 = st.columns(2)
with col1:
    params_json = st.text_area("Query params (JSON)", value="{}", height=120)
with col2:
    body_json = st.text_area("JSON body", value="{}", height=120)

if st.button("Send request"):
    try:
        params = json.loads(params_json or "{}")
        body = json.loads(body_json or "{}")
    except Exception as exc:
        st.error(f"Invalid JSON: {exc}")
        st.stop()

    url = api_url.rstrip("/") + path
    try:
        resp = requests.request(method=method, url=url, params=params, json=body, timeout=30)
        st.write(f"Status: {resp.status_code}")
        content_type = resp.headers.get("Content-Type", "")
        if "application/json" in content_type:
            st.json(resp.json())
        else:
            st.text(resp.text)
    except Exception as exc:
        st.error(f"Request failed: {exc}")

st.markdown("---")

st.subheader("Quick links")
link_base = api_url.rstrip("/")
if browser_path:
    href = browser_path
    if isinstance(browser_path, str) and browser_path.startswith("/"):
        href = f"{link_base}{browser_path}"
    st.markdown(f"[Open in browser]({href})")
    st.code(f"curl -X {method} '{link_base}{path}'", language="bash")
