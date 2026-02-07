from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

import streamlit as st


def _resolve_root() -> Path:
    workspace_root = Path(os.environ.get("SAW_WORKSPACE_ROOT") or Path.cwd()).resolve()
    root = os.environ.get("SAW_FILE_BROWSER_ROOT") or str(workspace_root)
    try:
        return Path(root).resolve()
    except Exception:
        return workspace_root


def _is_text_file(path: Path) -> bool:
    return path.suffix.lower() in {".txt", ".md", ".json", ".yaml", ".yml", ".py", ".csv", ".log"}


def _is_image_file(path: Path) -> bool:
    return path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}


def _read_preview(path: Path, max_bytes: int = 200_000) -> str:
    data = path.read_bytes()
    if len(data) > max_bytes:
        data = data[:max_bytes]
    return data.decode("utf-8", errors="replace")


def _rel_path(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except Exception:
        return str(path)


st.set_page_config(page_title="SAW File Browser", layout="wide")

root = _resolve_root()
query = st.query_params
current_rel = str(query.get("path", ""))

if "current_rel" not in st.session_state:
    st.session_state.current_rel = current_rel

st.sidebar.header("Workspace")
root_input = st.sidebar.text_input("Root path", value=str(root))

try:
    root = Path(root_input).resolve()
except Exception:
    root = _resolve_root()

current_dir = root / st.session_state.current_rel if st.session_state.current_rel else root
if not current_dir.exists() or not current_dir.is_dir():
    current_dir = root
    st.session_state.current_rel = ""

st.sidebar.markdown(f"**Current:** `{_rel_path(root, current_dir)}`")
if st.sidebar.button("Up one level") and current_dir != root:
    st.session_state.current_rel = _rel_path(root, current_dir.parent)
    st.rerun()

st.title("File Browser")

cols = st.columns([2, 3])
with cols[0]:
    st.subheader("Files & Folders")
    entries = sorted(current_dir.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    for entry in entries:
        rel = _rel_path(root, entry)
        label = f"📄 {entry.name}" if entry.is_file() else f"📁 {entry.name}"
        if st.button(label, key=f"nav-{rel}"):
            if entry.is_dir():
                st.session_state.current_rel = rel
                st.rerun()
            else:
                st.session_state.current_rel = _rel_path(root, entry.parent)
                st.session_state.selected_file = rel
                st.rerun()

selected_rel = st.session_state.get("selected_file")
selected_path = root / selected_rel if selected_rel else None

with cols[1]:
    st.subheader("Preview")
    if not selected_path or not selected_path.exists():
        st.info("Select a file to preview.")
    else:
        st.write(f"**{selected_rel}**")
        preview_url = f"?path={quote(selected_rel)}"
        st.markdown(
            f"<a href=\"{preview_url}\" target=\"_blank\">Open preview in new tab</a>",
            unsafe_allow_html=True,
        )

        if _is_image_file(selected_path):
            st.image(str(selected_path))
        elif _is_text_file(selected_path):
            st.code(_read_preview(selected_path), language="")
        else:
            st.write("Preview not supported. Use download below.")

        with open(selected_path, "rb") as f:
            st.download_button(
                label="Download file",
                data=f,
                file_name=selected_path.name,
                mime="application/octet-stream",
            )
