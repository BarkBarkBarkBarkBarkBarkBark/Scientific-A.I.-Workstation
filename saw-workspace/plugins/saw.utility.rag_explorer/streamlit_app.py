from __future__ import annotations

import os
from pathlib import Path

import requests
import streamlit as st


def _api_url() -> str:
    return os.environ.get("SAW_API_URL") or "http://127.0.0.1:5127"


def _workspace_root() -> Path:
    return Path(os.environ.get("SAW_WORKSPACE_ROOT") or Path.cwd()).resolve()


def _read_file(rel_path: str) -> str:
    root = _workspace_root()
    path = (root / rel_path).resolve()
    if not str(path).startswith(str(root)):
        raise ValueError("Path outside workspace")
    return path.read_text(encoding="utf-8", errors="replace")


st.set_page_config(page_title="SAW RAG Explorer", layout="wide")
st.title("RAG Explorer")

api_url = st.sidebar.text_input("SAW API URL", value=_api_url())
model = st.sidebar.text_input("Embedding model", value="")
chunk_max = st.sidebar.number_input("Chunk max chars", min_value=500, max_value=8000, value=4000, step=250)
chunk_overlap = st.sidebar.number_input("Chunk overlap", min_value=0, max_value=2000, value=300, step=50)

st.subheader("Index content")
uri = st.text_input("Document URI", value="")
source_mode = st.radio("Content source", ["Text", "Workspace file"], horizontal=True)
content_text = ""

if source_mode == "Workspace file":
    rel_path = st.text_input("Workspace-relative file path", value="")
    if rel_path:
        try:
            content_text = _read_file(rel_path)
            st.caption(f"Loaded {len(content_text)} characters from {rel_path}")
        except Exception as exc:
            st.error(f"Failed to read file: {exc}")
else:
    content_text = st.text_area("Content", height=200)

if st.button("Index document"):
    if not uri.strip():
        st.error("Provide a document URI.")
    elif not content_text.strip():
        st.error("Provide document content.")
    else:
        payload = {
            "uri": uri.strip(),
            "doc_type": "rag_doc",
            "content_text": content_text,
            "metadata_json": {},
            "model": model or None,
            "chunk_max_chars": int(chunk_max),
            "chunk_overlap_chars": int(chunk_overlap),
        }
        try:
            resp = requests.post(f"{api_url.rstrip('/')}/embed/upsert", json=payload, timeout=60)
            if resp.ok:
                st.success(resp.json())
            else:
                st.error(resp.text)
        except Exception as exc:
            st.error(f"Request failed: {exc}")

st.markdown("---")

st.subheader("Search embeddings")
query = st.text_input("Query")
top_k = st.number_input("Top K", min_value=1, max_value=25, value=8, step=1)

if st.button("Search"):
    if not query.strip():
        st.error("Provide a query.")
    else:
        payload = {"query": query.strip(), "top_k": int(top_k), "model": model or None}
        try:
            resp = requests.post(f"{api_url.rstrip('/')}/search/vector", json=payload, timeout=60)
            if resp.ok:
                data = resp.json()
                hits = data.get("hits") or []
                st.caption(f"Model: {data.get('model')} • Hits: {len(hits)}")
                for hit in hits:
                    st.markdown(f"**{hit.get('uri')}** (distance: {hit.get('distance')})")
                    if hit.get("content_text"):
                        st.code(hit.get("content_text"), language="")
                    if hit.get("metadata_json"):
                        st.json(hit.get("metadata_json"))
                    st.markdown("---")
            else:
                st.error(resp.text)
        except Exception as exc:
            st.error(f"Request failed: {exc}")
