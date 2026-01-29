# repo_dep_graph_app.py
# Streamlit app: scan a repo, build import dependency graph, visualize, list "not imported" files.
#
# Run (later you can wrap this in a plugin launcher):
#   streamlit run repo_dep_graph_app.py
#
# Notes:
# - Python imports: AST-based (best-effort resolution within repo).
# - TS/JS imports: regex-based, relative-imports only (best-effort resolution within repo).
# - "Not imported" = nodes with in-degree == 0 (within scanned graph), excluding the repo root node set.

from __future__ import annotations

import ast
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

import streamlit as st

try:
    import networkx as nx
except Exception as e:
    st.error(f"Missing dependency: networkx. Install it to use this app. Error: {e}")
    raise

# Plotly is nicer for interactive display; fallback to matplotlib if missing
PLOTLY_OK = True
try:
    import plotly.graph_objects as go
except Exception:
    PLOTLY_OK = False

MPL_OK = True
try:
    import matplotlib.pyplot as plt
except Exception:
    MPL_OK = False


# ----------------------------
# Utilities
# ----------------------------

DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
}


PY_EXTS = {".py"}
TS_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}


@dataclass(frozen=True)
class ScanConfig:
    repo_root: str
    include_python: bool
    include_ts: bool
    scope_prefix: str
    include_tests: bool
    max_files: int


def is_test_path(p: Path) -> bool:
    s = str(p).lower()
    return (
        "/test/" in s
        or "/tests/" in s
        or s.endswith("_test.py")
        or s.endswith(".spec.ts")
        or s.endswith(".test.ts")
        or s.endswith(".spec.tsx")
        or s.endswith(".test.tsx")
        or s.endswith(".spec.js")
        or s.endswith(".test.js")
        or s.endswith(".spec.jsx")
        or s.endswith(".test.jsx")
    )


def should_exclude(path: Path, excludes: Set[str]) -> bool:
    parts = set(path.parts)
    return any(ex in parts for ex in excludes)


def normalize_repo_root(repo_root: str) -> Path:
    p = Path(repo_root).expanduser().resolve()
    return p


def relpath(repo_root: Path, p: Path) -> str:
    try:
        return p.resolve().relative_to(repo_root).as_posix()
    except Exception:
        return p.as_posix()


def safe_read_text(path: Path, max_bytes: int = 2_000_000) -> str:
    try:
        data = path.read_bytes()
        if len(data) > max_bytes:
            data = data[:max_bytes]
        return data.decode("utf-8", errors="ignore")
    except Exception:
        return ""


# ----------------------------
# Python import resolution
# ----------------------------

def dotted_from_rel(rel: str) -> str:
    # "pkg/mod.py" -> "pkg.mod"; "pkg/__init__.py" -> "pkg"
    if not rel.endswith(".py"):
        return rel.replace("/", ".")
    no_ext = rel[:-3]
    if no_ext.endswith("/__init__"):
        no_ext = no_ext[: -len("/__init__")]
    return no_ext.replace("/", ".")


def build_python_module_index(repo_root: Path, py_files: List[Path]) -> Dict[str, str]:
    # module_name -> rel_path
    idx: Dict[str, str] = {}
    for f in py_files:
        r = relpath(repo_root, f)
        mod = dotted_from_rel(r)
        idx[mod] = r
    return idx


def resolve_python_imports_for_file(
    repo_root: Path,
    file_path: Path,
    file_rel: str,
    module_index: Dict[str, str],
) -> Set[str]:
    """
    Return a set of destination rel_paths that this file imports (best effort, in-repo only).
    """
    text = safe_read_text(file_path)
    if not text.strip():
        return set()

    try:
        tree = ast.parse(text, filename=file_rel)
    except Exception:
        return set()

    # Current module dotted path (for relative imports)
    current_mod = dotted_from_rel(file_rel)  # e.g. a.b.c
    current_pkg = current_mod.rsplit(".", 1)[0] if "." in current_mod else ""

    deps: Set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name  # e.g. "numpy", "a.b"
                # Only map if it's in-repo
                target_rel = module_index.get(name)
                if target_rel:
                    deps.add(target_rel)

        elif isinstance(node, ast.ImportFrom):
            level = getattr(node, "level", 0) or 0
            mod = node.module  # may be None for "from . import x"
            # Compute base package for relative imports
            base_pkg = current_pkg
            if level > 0:
                # Go up (level-1) from current_pkg (because "from .x" refers to current_pkg)
                parts = base_pkg.split(".") if base_pkg else []
                up = max(0, len(parts) - (level - 1))
                base_pkg = ".".join(parts[:up]) if up > 0 else ""

            # Candidate module path from "from X import ..."
            if mod:
                cand_mod = f"{base_pkg}.{mod}" if base_pkg else mod
                target_rel = module_index.get(cand_mod)
                if target_rel:
                    deps.add(target_rel)

            # Also attempt to resolve imported names as submodules:
            # from pkg import sub -> pkg.sub
            if node.names:
                for alias in node.names:
                    name = alias.name
                    if name == "*":
                        continue
                    # If module is None: "from . import x" -> base_pkg + x
                    if mod is None:
                        cand = f"{base_pkg}.{name}" if base_pkg else name
                    else:
                        parent = f"{base_pkg}.{mod}" if base_pkg else mod
                        cand = f"{parent}.{name}"
                    target_rel = module_index.get(cand)
                    if target_rel:
                        deps.add(target_rel)

    # Filter self-import
    deps.discard(file_rel)
    return deps


# ----------------------------
# TS/JS import resolution (relative imports only)
# ----------------------------

TS_IMPORT_RE = re.compile(
    r"""(?mx)
    ^\s*import\s+.*?\s+from\s+["'](?P<path>[^"']+)["']\s*;?
    |^\s*import\s*\(\s*["'](?P<dyn>[^"']+)["']\s*\)
    |^\s*require\s*\(\s*["'](?P<req>[^"']+)["']\s*\)
    """
)

def resolve_ts_relative_target(repo_root: Path, src_file: Path, spec: str) -> Optional[Path]:
    if not spec.startswith("."):
        return None
    base = src_file.parent
    raw = (base / spec).resolve()

    # Try direct file
    if raw.is_file():
        return raw

    # Try with extensions
    for ext in TS_EXTS:
        p = Path(str(raw) + ext)
        if p.is_file():
            return p

    # Try index files in a directory
    if raw.is_dir():
        for ext in TS_EXTS:
            p = raw / f"index{ext}"
            if p.is_file():
                return p

    return None


def resolve_ts_imports_for_file(repo_root: Path, file_path: Path) -> Set[Path]:
    text = safe_read_text(file_path)
    if not text.strip():
        return set()

    deps: Set[Path] = set()
    for m in TS_IMPORT_RE.finditer(text):
        spec = m.group("path") or m.group("dyn") or m.group("req")
        if not spec:
            continue
        target = resolve_ts_relative_target(repo_root, file_path, spec)
        if target:
            deps.add(target)
    return deps


# ----------------------------
# Graph building / aggregation
# ----------------------------

def node_group(rel_path: str, depth: int) -> str:
    # depth=0 => "<root>"
    # depth=1 => top dir or file at root
    # depth=2 => first/second dirs...
    if depth <= 0:
        return "<root>"
    parts = rel_path.split("/")
    if len(parts) == 1:
        return parts[0]
    return "/".join(parts[: min(depth, len(parts) - 1)])


def build_graph(
    repo_root: Path,
    include_python: bool,
    include_ts: bool,
    scope_prefix: str,
    include_tests: bool,
    max_files: int,
    excludes: Set[str],
) -> Tuple[nx.DiGraph, Dict[str, str]]:
    """
    Returns:
      - DiGraph with nodes = rel_path (string), edges src->dst
      - node_lang: rel_path -> "py"|"ts"|"other"
    """
    scope_prefix = scope_prefix.strip().lstrip("/")

    all_files: List[Path] = []
    for p in repo_root.rglob("*"):
        if not p.is_file():
            continue
        if should_exclude(p, excludes):
            continue
        r = relpath(repo_root, p)
        if scope_prefix and not r.startswith(scope_prefix):
            continue
        if not include_tests and is_test_path(p):
            continue

        ext = p.suffix.lower()
        if ext in PY_EXTS and include_python:
            all_files.append(p)
        elif ext in TS_EXTS and include_ts:
            all_files.append(p)

        if len(all_files) >= max_files:
            break

    py_files = [p for p in all_files if p.suffix.lower() == ".py"]
    ts_files = [p for p in all_files if p.suffix.lower() in TS_EXTS]

    module_index = build_python_module_index(repo_root, py_files) if include_python else {}

    g = nx.DiGraph()
    node_lang: Dict[str, str] = {}

    # Add nodes
    for f in all_files:
        r = relpath(repo_root, f)
        g.add_node(r)
        ext = f.suffix.lower()
        if ext == ".py":
            node_lang[r] = "py"
        elif ext in TS_EXTS:
            node_lang[r] = "ts"
        else:
            node_lang[r] = "other"

    # Python edges
    if include_python:
        for f in py_files:
            src = relpath(repo_root, f)
            deps = resolve_python_imports_for_file(repo_root, f, src, module_index)
            for dst in deps:
                if dst in g.nodes:
                    g.add_edge(src, dst, kind="import")

    # TS/JS edges (relative only)
    if include_ts:
        for f in ts_files:
            src = relpath(repo_root, f)
            deps = resolve_ts_imports_for_file(repo_root, f)
            for d in deps:
                dst = relpath(repo_root, d)
                if dst in g.nodes:
                    g.add_edge(src, dst, kind="import")

    return g, node_lang


def aggregate_graph_by_directory(g: nx.DiGraph, depth: int) -> nx.DiGraph:
    ag = nx.DiGraph()
    edge_weights: Dict[Tuple[str, str], int] = {}

    for src, dst in g.edges():
        gs = node_group(src, depth)
        gd = node_group(dst, depth)
        if gs == gd:
            continue
        edge_weights[(gs, gd)] = edge_weights.get((gs, gd), 0) + 1

    for node in {node_group(n, depth) for n in g.nodes()}:
        ag.add_node(node)

    for (gs, gd), w in edge_weights.items():
        ag.add_edge(gs, gd, weight=w)

    return ag


# ----------------------------
# Visualization
# ----------------------------

def draw_plotly_graph(g: nx.DiGraph, title: str) -> None:
    # layout
    n = g.number_of_nodes()
    if n == 0:
        st.info("Graph is empty for the selected scope/options.")
        return

    # spring_layout can be slow on huge graphs; reduce iterations
    iters = 50 if n < 400 else 20
    pos = nx.spring_layout(g, seed=7, k=None, iterations=iters)

    # edges
    edge_x = []
    edge_y = []
    widths = []
    for u, v, data in g.edges(data=True):
        x0, y0 = pos[u]
        x1, y1 = pos[v]
        edge_x += [x0, x1, None]
        edge_y += [y0, y1, None]
        w = data.get("weight", 1)
        widths.append(w)

    edge_trace = go.Scatter(
        x=edge_x,
        y=edge_y,
        mode="lines",
        line=dict(width=1),
        hoverinfo="none",
    )

    # nodes
    node_x = []
    node_y = []
    node_text = []
    for node in g.nodes():
        x, y = pos[node]
        node_x.append(x)
        node_y.append(y)
        node_text.append(node)

    node_trace = go.Scatter(
        x=node_x,
        y=node_y,
        mode="markers",
        hovertext=node_text,
        hoverinfo="text",
        marker=dict(size=8),
    )

    fig = go.Figure(data=[edge_trace, node_trace])
    fig.update_layout(
        title=title,
        showlegend=False,
        margin=dict(l=10, r=10, t=40, b=10),
        height=700,
    )
    st.plotly_chart(fig, use_container_width=True)


def draw_matplotlib_graph(g: nx.DiGraph, title: str) -> None:
    if not MPL_OK:
        st.warning("Plotly not installed and matplotlib not available; cannot render graph.")
        return
    n = g.number_of_nodes()
    if n == 0:
        st.info("Graph is empty for the selected scope/options.")
        return

    iters = 50 if n < 400 else 20
    pos = nx.spring_layout(g, seed=7, iterations=iters)

    fig = plt.figure(figsize=(12, 8))
    plt.title(title)
    nx.draw_networkx_edges(g, pos, alpha=0.25, arrows=False)
    nx.draw_networkx_nodes(g, pos, node_size=30)
    plt.axis("off")
    st.pyplot(fig)


# ----------------------------
# Streamlit App
# ----------------------------

st.set_page_config(page_title="Repo Dependency Graph (MVP)", layout="wide")
st.title("Repo Dependency Graph (MVP)")
st.caption("Static scan (best-effort): Python AST imports + optional TS/JS relative imports. Review-only.")

with st.sidebar:
    st.header("Scan Settings")

    default_root = str(Path.cwd().resolve())
    repo_root_in = st.text_input("Repo root path", value=default_root)

    include_python = st.toggle("Include Python (.py)", value=True)
    include_ts = st.toggle("Include TS/JS (.ts/.tsx/.js/…)", value=False)

    scope_prefix = st.text_input("Scope prefix (optional)", value="")
    include_tests = st.toggle("Include tests", value=False)

    max_files = st.slider("Max files to scan", min_value=200, max_value=20000, value=6000, step=200)

    st.divider()
    st.header("View")
    aggregate = st.toggle("Aggregate by directory", value=True)
    depth = st.slider("Directory depth", min_value=1, max_value=6, value=2, step=1, disabled=not aggregate)

    st.divider()
    excludes_in = st.text_area(
        "Exclude dirs (one per line)",
        value="\n".join(sorted(DEFAULT_EXCLUDES)),
        height=220,
    )
    excludes = {x.strip() for x in excludes_in.splitlines() if x.strip()}

scan_btn = st.button("Scan repo", type="primary")

if "last_scan_cfg" not in st.session_state:
    st.session_state.last_scan_cfg = None
if "graph" not in st.session_state:
    st.session_state.graph = None
if "node_lang" not in st.session_state:
    st.session_state.node_lang = None

def cfg() -> ScanConfig:
    return ScanConfig(
        repo_root=repo_root_in.strip(),
        include_python=include_python,
        include_ts=include_ts,
        scope_prefix=scope_prefix.strip(),
        include_tests=include_tests,
        max_files=max_files,
    )

@st.cache_data(show_spinner=False)
def cached_build_graph(cfg_obj: ScanConfig, excludes_tuple: Tuple[str, ...]) -> Tuple[dict, dict]:
    repo_root = normalize_repo_root(cfg_obj.repo_root)
    g, node_lang = build_graph(
        repo_root=repo_root,
        include_python=cfg_obj.include_python,
        include_ts=cfg_obj.include_ts,
        scope_prefix=cfg_obj.scope_prefix,
        include_tests=cfg_obj.include_tests,
        max_files=cfg_obj.max_files,
        excludes=set(excludes_tuple),
    )
    # cache_data requires hashable returns; convert to adjacency dict-like
    # We'll store edges list and nodes list, then reconstruct graph outside cache.
    data = {
        "nodes": list(g.nodes()),
        "edges": [(u, v, dict(g.edges[u, v])) for u, v in g.edges()],
    }
    return data, node_lang

def reconstruct_graph(data: dict) -> nx.DiGraph:
    g = nx.DiGraph()
    for n in data.get("nodes", []):
        g.add_node(n)
    for u, v, attrs in data.get("edges", []):
        g.add_edge(u, v, **(attrs or {}))
    return g

if scan_btn:
    try:
        repo_root = normalize_repo_root(repo_root_in)
        if not repo_root.exists() or not repo_root.is_dir():
            st.error("Repo root must be an existing directory.")
        else:
            with st.spinner("Scanning repo (static)…"):
                data, node_lang = cached_build_graph(cfg(), tuple(sorted(excludes)))
                g = reconstruct_graph(data)
                st.session_state.graph = g
                st.session_state.node_lang = node_lang
                st.session_state.last_scan_cfg = cfg()
            st.success(f"Scan complete: {g.number_of_nodes()} files, {g.number_of_edges()} import edges.")
    except Exception as e:
        st.error(f"Scan failed: {e}")

g: Optional[nx.DiGraph] = st.session_state.graph
node_lang: Optional[Dict[str, str]] = st.session_state.node_lang

if g is None:
    st.info("Set your repo root and click **Scan repo**.")
    st.stop()

# Metrics + lists
colA, colB, colC, colD = st.columns(4)
with colA:
    st.metric("Files (nodes)", g.number_of_nodes())
with colB:
    st.metric("Import edges", g.number_of_edges())
with colC:
    st.metric("Not imported (in-degree=0)", sum(1 for n in g.nodes() if g.in_degree(n) == 0))
with colD:
    st.metric("Isolated (no in/out)", sum(1 for n in g.nodes() if g.in_degree(n) == 0 and g.out_degree(n) == 0))

# Build view graph
view_g = g
view_title = "File-level import graph"

if aggregate:
    view_g = aggregate_graph_by_directory(g, depth)
    view_title = f"Directory-level import graph (depth={depth})"

st.subheader("Graph")
too_big = view_g.number_of_nodes() > 2500 or view_g.number_of_edges() > 8000
if too_big:
    st.warning(
        f"Graph is large ({view_g.number_of_nodes()} nodes / {view_g.number_of_edges()} edges). "
        f"Consider increasing aggregation or narrowing scope."
    )

if PLOTLY_OK:
    draw_plotly_graph(view_g, view_title)
else:
    draw_matplotlib_graph(view_g, view_title)

st.subheader("Files not imported by any other scanned file")
st.caption("These have **in-degree = 0** within the scanned graph. They may be entrypoints, scripts, or genuinely unused.")

not_imported = sorted([n for n in g.nodes() if g.in_degree(n) == 0])
isolated = sorted([n for n in g.nodes() if g.in_degree(n) == 0 and g.out_degree(n) == 0])

c1, c2 = st.columns(2)
with c1:
    st.markdown("#### Not imported (in-degree=0)")
    st.write(not_imported[:2000] if len(not_imported) > 0 else "—")
    if len(not_imported) > 2000:
        st.info(f"Showing first 2000 of {len(not_imported)}")
with c2:
    st.markdown("#### Isolated (no imports, not imported)")
    st.write(isolated[:2000] if len(isolated) > 0 else "—")
    if len(isolated) > 2000:
        st.info(f"Showing first 2000 of {len(isolated)}")

st.subheader("Quick inspector (click a file)")
selected = st.selectbox("Pick a file", options=sorted(g.nodes()))
deps_out = sorted(list(g.successors(selected)))
deps_in = sorted(list(g.predecessors(selected)))

i1, i2 = st.columns(2)
with i1:
    st.markdown("#### Imports (outbound)")
    st.write(deps_out if deps_out else "—")
with i2:
    st.markdown("#### Imported by (inbound)")
    st.write(deps_in if deps_in else "—")

st.caption(
    "Tip: Start with **Directory aggregation** (depth 2–3) to understand structure, "
    "then switch to file-level for a specific scope_prefix."
)
