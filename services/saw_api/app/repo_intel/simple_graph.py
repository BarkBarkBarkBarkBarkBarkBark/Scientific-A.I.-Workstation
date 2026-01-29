from __future__ import annotations

import ast
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


PY_EXTS = {".py"}
TS_EXTS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}

DEFAULT_EXCLUDES = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "node_modules",
    "dist",
    "build",
    ".cache",
}

TS_IMPORT_RE = re.compile(
    r"""(?mx)
    ^\s*import\s+.*?\s+from\s+["'](?P<path>[^"']+)["']\s*;?
    |^\s*import\s*\(\s*["'](?P<dyn>[^"']+)["']\s*\)
    |^\s*require\s*\(\s*["'](?P<req>[^"']+)["']\s*\)
    """
)


@dataclass(frozen=True)
class SimpleGraphConfig:
    repo_root: Path
    include_python: bool
    include_ts: bool
    include_tests: bool
    scope_prefix: str
    max_files: int


def _is_test_path(path: Path) -> bool:
    s = path.as_posix().lower()
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


def _git_list_files(repo_root: Path) -> list[str] | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "-co", "--exclude-standard"],
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    files = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]
    return files


def _iter_repo_files(cfg: SimpleGraphConfig) -> Iterator[Path]:
    scope_prefix = cfg.scope_prefix.strip().lstrip("/")
    git_files = _git_list_files(cfg.repo_root)
    if git_files is not None:
        for rel in git_files:
            if scope_prefix and not rel.startswith(scope_prefix):
                continue
            path = cfg.repo_root / rel
            if not path.is_file():
                continue
            if not cfg.include_tests and _is_test_path(path):
                continue
            yield path
        return

    for root, dirs, files in os.walk(cfg.repo_root):
        dirs[:] = [d for d in dirs if d not in DEFAULT_EXCLUDES]
        for name in files:
            path = Path(root) / name
            rel = path.relative_to(cfg.repo_root).as_posix()
            if scope_prefix and not rel.startswith(scope_prefix):
                continue
            if not cfg.include_tests and _is_test_path(path):
                continue
            yield path


def _safe_read_text(path: Path, max_bytes: int = 2_000_000) -> str:
    try:
        data = path.read_bytes()
        if len(data) > max_bytes:
            data = data[:max_bytes]
        return data.decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _dotted_from_rel(rel: str) -> str:
    if not rel.endswith(".py"):
        return rel.replace("/", ".")
    no_ext = rel[:-3]
    if no_ext.endswith("/__init__"):
        no_ext = no_ext[: -len("/__init__")]
    return no_ext.replace("/", ".")


def _build_python_module_index(repo_root: Path, py_files: Iterable[Path]) -> dict[str, str]:
    out: dict[str, str] = {}
    for f in py_files:
        rel = f.relative_to(repo_root).as_posix()
        out[_dotted_from_rel(rel)] = rel
    return out


def _resolve_python_imports(
    repo_root: Path,
    file_path: Path,
    module_index: dict[str, str],
) -> set[str]:
    rel = file_path.relative_to(repo_root).as_posix()
    text = _safe_read_text(file_path)
    if not text.strip():
        return set()
    try:
        tree = ast.parse(text, filename=rel)
    except Exception:
        return set()

    current_mod = _dotted_from_rel(rel)
    current_pkg = current_mod.rsplit(".", 1)[0] if "." in current_mod else ""
    deps: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                target = module_index.get(alias.name)
                if target:
                    deps.add(target)
        elif isinstance(node, ast.ImportFrom):
            level = int(getattr(node, "level", 0) or 0)
            mod = node.module
            base_pkg = current_pkg
            if level > 0:
                parts = base_pkg.split(".") if base_pkg else []
                up = max(0, len(parts) - (level - 1))
                base_pkg = ".".join(parts[:up]) if up > 0 else ""

            if mod:
                cand = f"{base_pkg}.{mod}" if base_pkg else mod
                target = module_index.get(cand)
                if target:
                    deps.add(target)

            for alias in node.names or []:
                if alias.name == "*":
                    continue
                if mod is None:
                    cand = f"{base_pkg}.{alias.name}" if base_pkg else alias.name
                else:
                    parent = f"{base_pkg}.{mod}" if base_pkg else mod
                    cand = f"{parent}.{alias.name}"
                target = module_index.get(cand)
                if target:
                    deps.add(target)

    deps.discard(rel)
    return deps


def _resolve_ts_relative_target(repo_root: Path, src_file: Path, spec: str) -> Path | None:
    if not spec.startswith("."):
        return None
    base = src_file.parent
    raw = (base / spec).resolve()

    if raw.is_file():
        return raw
    for ext in TS_EXTS:
        cand = Path(str(raw) + ext)
        if cand.is_file():
            return cand
    if raw.is_dir():
        for ext in TS_EXTS:
            cand = raw / f"index{ext}"
            if cand.is_file():
                return cand
    return None


def _resolve_ts_imports(repo_root: Path, file_path: Path) -> set[str]:
    text = _safe_read_text(file_path)
    if not text.strip():
        return set()
    deps: set[str] = set()
    for match in TS_IMPORT_RE.finditer(text):
        spec = match.group("path") or match.group("dyn") or match.group("req")
        if not spec:
            continue
        target = _resolve_ts_relative_target(repo_root, file_path, spec)
        if target:
            deps.add(target.relative_to(repo_root).as_posix())
    return deps


def build_simple_graph(
    repo_root: Path,
    include_python: bool = True,
    include_ts: bool = False,
    include_tests: bool = False,
    scope_prefix: str = "",
    max_files: int = 6000,
) -> dict:
    cfg = SimpleGraphConfig(
        repo_root=repo_root,
        include_python=include_python,
        include_ts=include_ts,
        include_tests=include_tests,
        scope_prefix=scope_prefix,
        max_files=max_files,
    )
    files: list[Path] = []
    for p in _iter_repo_files(cfg):
        ext = p.suffix.lower()
        if ext in PY_EXTS and include_python:
            files.append(p)
        elif ext in TS_EXTS and include_ts:
            files.append(p)
        if len(files) >= max_files:
            break

    py_files = [p for p in files if p.suffix.lower() == ".py"]
    ts_files = [p for p in files if p.suffix.lower() in TS_EXTS]

    module_index = _build_python_module_index(repo_root, py_files) if include_python else {}

    nodes = [p.relative_to(repo_root).as_posix() for p in files]
    node_set = set(nodes)
    edges: list[dict[str, str]] = []
    in_degree: dict[str, int] = {n: 0 for n in nodes}
    out_degree: dict[str, int] = {n: 0 for n in nodes}

    if include_python:
        for f in py_files:
            src = f.relative_to(repo_root).as_posix()
            deps = _resolve_python_imports(repo_root, f, module_index)
            for dst in deps:
                if dst not in node_set:
                    continue
                edges.append({"src": src, "dst": dst, "kind": "import"})
                in_degree[dst] = in_degree.get(dst, 0) + 1
                out_degree[src] = out_degree.get(src, 0) + 1

    if include_ts:
        for f in ts_files:
            src = f.relative_to(repo_root).as_posix()
            deps = _resolve_ts_imports(repo_root, f)
            for dst in deps:
                if dst not in node_set:
                    continue
                edges.append({"src": src, "dst": dst, "kind": "import"})
                in_degree[dst] = in_degree.get(dst, 0) + 1
                out_degree[src] = out_degree.get(src, 0) + 1

    not_imported = sorted([n for n in nodes if in_degree.get(n, 0) == 0])
    isolated = sorted([n for n in nodes if in_degree.get(n, 0) == 0 and out_degree.get(n, 0) == 0])

    return {
        "nodes": [{"id": n, "rel_path": n} for n in nodes],
        "edges": edges,
        "not_imported": not_imported,
        "isolated": isolated,
        "stats": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "not_imported_count": len(not_imported),
            "isolated_count": len(isolated),
        },
    }
