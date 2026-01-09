from __future__ import annotations

import hashlib
import os
import shutil
from dataclasses import dataclass


_IGNORE_DIRS = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "node_modules",
    ".git",
}

_IGNORE_FILE_SUFFIXES = {
    ".pyc",
    ".pyo",
}


@dataclass(frozen=True)
class StockPluginInfo:
    plugin_id: str
    canonical_dir: str
    digest_sha256: str


def stock_plugins_root() -> str:
    return os.path.join(os.path.dirname(__file__), "stock_plugins")


def _should_ignore_file(name: str) -> bool:
    n = name.lower()
    return any(n.endswith(sfx) for sfx in _IGNORE_FILE_SUFFIXES)


def compute_dir_digest_sha256(dir_path: str) -> str:
    """
    Deterministic digest for a plugin directory.
    Includes relative path + size + file bytes for all non-ignored files.
    """
    root = os.path.abspath(dir_path)
    h = hashlib.sha256()

    files: list[tuple[str, str]] = []
    for dp, dirnames, filenames in os.walk(root):
        # prune ignored dirs
        dirnames[:] = [d for d in dirnames if d not in _IGNORE_DIRS]
        for fn in filenames:
            if _should_ignore_file(fn):
                continue
            abs_path = os.path.join(dp, fn)
            rel = os.path.relpath(abs_path, root).replace("\\", "/")
            files.append((rel, abs_path))

    files.sort(key=lambda x: x[0])
    for rel, abs_path in files:
        try:
            st = os.stat(abs_path)
        except Exception:
            continue
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(int(st.st_size)).encode("utf-8"))
        h.update(b"\0")
        try:
            with open(abs_path, "rb") as f:
                while True:
                    chunk = f.read(1024 * 128)
                    if not chunk:
                        break
                    h.update(chunk)
        except Exception:
            # best-effort: still deterministic given missing file bytes are absent
            h.update(b"<unreadable>")
        h.update(b"\0")

    return h.hexdigest()


def load_stock_catalog() -> dict[str, StockPluginInfo]:
    root = stock_plugins_root()
    out: dict[str, StockPluginInfo] = {}
    if not os.path.isdir(root):
        return out
    for ent in sorted(os.listdir(root)):
        if ent.startswith("."):
            continue
        pdir = os.path.join(root, ent)
        if not os.path.isdir(pdir):
            continue
        # Require plugin.yaml for stock entries
        if not os.path.isfile(os.path.join(pdir, "plugin.yaml")):
            continue
        pid = ent
        digest = compute_dir_digest_sha256(pdir)
        out[pid] = StockPluginInfo(plugin_id=pid, canonical_dir=pdir, digest_sha256=digest)
    return out


def sync_stock_plugins(settings: object) -> list[dict[str, str]]:
    """
    Ensure all canonical stock plugins exist unmodified under:
      <settings.workspace_root>/plugins/<plugin_id>/

    Returns a list of events like:
      {plugin_id, action, expected, actual}
    """
    workspace_root = str(getattr(settings, "workspace_root"))
    plugins_root = os.path.join(workspace_root, "plugins")
    catalog = load_stock_catalog()
    events: list[dict[str, str]] = []

    for pid, info in catalog.items():
        target_dir = os.path.join(plugins_root, pid)
        actual = ""
        if os.path.isdir(target_dir):
            try:
                actual = compute_dir_digest_sha256(target_dir)
            except Exception:
                actual = ""

        if (not os.path.isdir(target_dir)) or (actual != info.digest_sha256):
            sync_stock_plugin_dir(info.canonical_dir, target_dir)
            events.append(
                {
                    "plugin_id": pid,
                    "action": "restored" if actual else "installed",
                    "expected": info.digest_sha256,
                    "actual": actual,
                }
            )

    return events


def sync_stock_plugin_dir(canonical_dir: str, workspace_plugin_dir: str) -> None:
    """
    Replace workspace_plugin_dir with canonical_dir (directory copy).
    """
    if os.path.isdir(workspace_plugin_dir):
        shutil.rmtree(workspace_plugin_dir)
    os.makedirs(os.path.dirname(workspace_plugin_dir), exist_ok=True)
    shutil.copytree(canonical_dir, workspace_plugin_dir)


