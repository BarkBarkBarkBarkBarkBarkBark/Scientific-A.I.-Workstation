from __future__ import annotations

import hashlib
import json
import os
import platform as _platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from .settings import Settings


DepsKind = Literal["lockfile", "requirements", "pip", "none"]


@dataclass(frozen=True)
class DepsSource:
    kind: DepsKind
    # Prefer relative paths for human readability; abs_path is for runtime use.
    rel_path: str | None
    abs_path: str | None
    # For lock/requirements sources, sha256 is the file content sha256.
    # For pip sources, sha256 is sha256 of normalized pip strings bytes.
    sha256: str
    size_bytes: int
    mtime_ns: int | None
    pip: list[str] | None = None


@dataclass(frozen=True)
class EnvResolution:
    env_key: str
    payload: dict[str, Any]
    deps: DepsSource
    manifest_path: str


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _platform_tag() -> str:
    # ex: darwin-arm64, linux-x86_64, win32-AMD64
    return f"{sys.platform}-{_platform.machine()}"


def _python_major_minor() -> str:
    return f"{sys.version_info.major}.{sys.version_info.minor}"


def _sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256()
    h.update(b)
    return h.hexdigest()


def _read_file_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _safe_relpath(abs_path: str, base_dir: str) -> str:
    try:
        return os.path.relpath(abs_path, base_dir).replace("\\", "/")
    except Exception:
        return abs_path.replace("\\", "/")


def _normalize_pip_list(pip: list[str]) -> list[str]:
    # Order-insensitive: sort; keep exact strings otherwise.
    cleaned = [str(x).strip() for x in (pip or []) if str(x).strip()]
    cleaned.sort()
    return cleaned


def resolve_deps_source(
    *,
    plugin_dir: str,
    env_lockfile: str | None,
    env_requirements: str | None,
    env_pip: list[str] | None,
) -> DepsSource:
    """
    Resolve deps source by precedence (env-hash MR doc):
      1) plugin manifest environment.lockfile (relative to plugin_dir)
      2) <plugin_dir>/uv.lock
      3) <plugin_dir>/requirements.lock
      4) plugin manifest environment.requirements (relative to plugin_dir)
      5) plugin manifest environment.pip (list)
    """
    plugin_dir = os.path.abspath(plugin_dir)

    def as_abs(rel: str) -> str:
        return os.path.abspath(os.path.join(plugin_dir, rel))

    # 1) manifest lockfile
    if env_lockfile:
        p = as_abs(env_lockfile)
        if os.path.isfile(p):
            b = _read_file_bytes(p)
            st = os.stat(p)
            return DepsSource(
                kind="lockfile",
                rel_path=_safe_relpath(p, plugin_dir),
                abs_path=p,
                sha256=_sha256_bytes(b),
                size_bytes=len(b),
                mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
            )

    # 2) plugin uv.lock
    p = os.path.join(plugin_dir, "uv.lock")
    if os.path.isfile(p):
        b = _read_file_bytes(p)
        st = os.stat(p)
        return DepsSource(
            kind="lockfile",
            rel_path=_safe_relpath(p, plugin_dir),
            abs_path=p,
            sha256=_sha256_bytes(b),
            size_bytes=len(b),
            mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
        )

    # 3) plugin requirements.lock
    p = os.path.join(plugin_dir, "requirements.lock")
    if os.path.isfile(p):
        b = _read_file_bytes(p)
        st = os.stat(p)
        return DepsSource(
            kind="lockfile",
            rel_path=_safe_relpath(p, plugin_dir),
            abs_path=p,
            sha256=_sha256_bytes(b),
            size_bytes=len(b),
            mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
        )

    # 4) manifest requirements
    if env_requirements:
        p = as_abs(env_requirements)
        if os.path.isfile(p):
            b = _read_file_bytes(p)
            st = os.stat(p)
            return DepsSource(
                kind="requirements",
                rel_path=_safe_relpath(p, plugin_dir),
                abs_path=p,
                sha256=_sha256_bytes(b),
                size_bytes=len(b),
                mtime_ns=getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)),
            )

    # 5) manifest pip list
    pip_norm = _normalize_pip_list(env_pip or [])
    if pip_norm:
        b = ("\n".join(pip_norm) + "\n").encode("utf-8")
        return DepsSource(
            kind="pip",
            rel_path=None,
            abs_path=None,
            sha256=_sha256_bytes(b),
            size_bytes=len(b),
            mtime_ns=None,
            pip=pip_norm,
        )

    # none
    return DepsSource(
        kind="none",
        rel_path=None,
        abs_path=None,
        sha256=_sha256_bytes(b""),
        size_bytes=0,
        mtime_ns=None,
        pip=None,
    )


def compute_env_key_payload(
    *,
    python_major_minor: str,
    platform_tag: str,
    deps_sha256: str,
    extras: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "python": str(python_major_minor),
        "platform": str(platform_tag),
        "deps_sha256": str(deps_sha256),
        "extras": dict(extras or {"cuda": "none"}),
    }


def compute_env_key(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return _sha256_bytes(canonical)[:16]


def compute_env_resolution(
    *,
    settings: Settings,
    plugin_dir: str,
    plugin_id: str | None,
    plugin_version: str | None,
    env_python: str | None,
    env_lockfile: str | None,
    env_requirements: str | None,
    env_pip: list[str] | None,
    extras: dict[str, Any] | None = None,
) -> EnvResolution:
    """
    Compute env_key and write `.saw/env/manifests/<env_key>.json`.

    Note: For MVP we use the running interpreter major.minor for hashing,
    not the python constraint string from the plugin manifest.
    """
    repo_root = _repo_root_from_workspace(settings.workspace_root)
    saw_root = os.path.join(repo_root, ".saw")
    manifests_dir = os.path.join(saw_root, "env", "manifests")
    os.makedirs(manifests_dir, exist_ok=True)

    deps = resolve_deps_source(
        plugin_dir=plugin_dir,
        env_lockfile=env_lockfile,
        env_requirements=env_requirements,
        env_pip=env_pip,
    )
    payload = compute_env_key_payload(
        python_major_minor=_python_major_minor(),
        platform_tag=_platform_tag(),
        deps_sha256=deps.sha256,
        extras=extras,
    )
    env_key = compute_env_key(payload)

    manifest_path = os.path.join(manifests_dir, f"{env_key}.json")
    record = {
        "env_key": env_key,
        "payload": payload,
        "resolved": {
            "plugin_id": plugin_id,
            "plugin_version": plugin_version,
            "manifest_env_python": env_python,
            "deps": {
                "kind": deps.kind,
                "rel_path": deps.rel_path,
                "abs_path": deps.abs_path,
                "sha256": deps.sha256,
                "size_bytes": deps.size_bytes,
                "mtime_ns": deps.mtime_ns,
                "pip": deps.pip,
            },
        },
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=True)

    return EnvResolution(env_key=env_key, payload=payload, deps=deps, manifest_path=manifest_path)


def _venv_python(venv_dir: str) -> str:
    if os.name == "nt":
        return os.path.join(venv_dir, "Scripts", "python.exe")
    return os.path.join(venv_dir, "bin", "python")


def _append_log(log_path: str, text: str) -> None:
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(text)
            if not text.endswith("\n"):
                f.write("\n")
    except Exception:
        # Best-effort logging.
        pass


def ensure_env(settings: Settings, env_key: str, deps: DepsSource, *, plugin_dir: str | None = None) -> str:
    """
    Ensure a cached venv exists at repo_root/.saw/venvs/<env_key>/ and return its python path.
    Uses uv for venv creation + dependency install.
    """
    env_key = (env_key or "").strip()
    if not env_key:
        raise ValueError("missing_env_key")

    repo_root = _repo_root_from_workspace(settings.workspace_root)
    saw_root = os.path.join(repo_root, ".saw")
    venvs_root = os.path.join(saw_root, "venvs")
    logs_root = os.path.join(saw_root, "logs")
    os.makedirs(venvs_root, exist_ok=True)
    os.makedirs(logs_root, exist_ok=True)

    venv_dir = os.path.join(venvs_root, env_key)
    py = _venv_python(venv_dir)
    log_path = os.path.join(logs_root, f"env_{env_key}.log")

    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv_not_found")

    # Create venv if needed
    if not os.path.isfile(py):
        _append_log(log_path, f"[env] creating venv: {venv_dir}")
        p = subprocess.run(
            [uv, "venv", venv_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        _append_log(log_path, p.stdout.decode("utf-8", errors="replace"))
        if p.returncode != 0:
            raise RuntimeError(f"uv_venv_failed rc={p.returncode}")

    # Install deps (best-effort per MR doc; strict when deps were declared)
    if deps.kind in ("requirements", "lockfile"):
        if not deps.abs_path:
            raise RuntimeError("deps_path_missing")
        req_path = deps.abs_path
        base = os.path.basename(req_path)
        if base == "uv.lock":
            # Only supported when plugin is a uv project (pyproject.toml present).
            if not plugin_dir:
                raise RuntimeError("uv_lock_requires_plugin_dir")
            pyproject = os.path.join(os.path.abspath(plugin_dir), "pyproject.toml")
            if not os.path.isfile(pyproject):
                raise RuntimeError("uv_lock_requires_pyproject")
            _append_log(log_path, f"[env] installing via uv sync (locked) plugin_dir={plugin_dir}")
            env = dict(os.environ)
            # Ensure uv installs into our cached environment, not a project-local .venv
            env["UV_PROJECT_ENVIRONMENT"] = venv_dir
            p = subprocess.run(
                [uv, "sync", "--locked"],
                cwd=os.path.abspath(plugin_dir),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            _append_log(log_path, p.stdout.decode("utf-8", errors="replace"))
            if p.returncode != 0:
                raise RuntimeError(f"uv_sync_failed rc={p.returncode}")
        else:
            _append_log(log_path, f"[env] installing via uv pip -r {req_path}")
            p = subprocess.run(
                [uv, "pip", "install", "--python", py, "-r", req_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            _append_log(log_path, p.stdout.decode("utf-8", errors="replace"))
            if p.returncode != 0:
                raise RuntimeError(f"uv_pip_install_failed rc={p.returncode}")
    elif deps.kind == "pip":
        pkgs = [x for x in (deps.pip or []) if str(x).strip()]
        if pkgs:
            _append_log(log_path, f"[env] installing via uv pip: {len(pkgs)} deps")
            p = subprocess.run(
                [uv, "pip", "install", "--python", py, *pkgs],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            _append_log(log_path, p.stdout.decode("utf-8", errors="replace"))
            if p.returncode != 0:
                raise RuntimeError(f"uv_pip_install_failed rc={p.returncode}")

    return py


