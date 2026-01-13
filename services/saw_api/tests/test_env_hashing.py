from __future__ import annotations

import os

from services.saw_api.app.env_manager import compute_env_key, compute_env_key_payload, compute_env_resolution, resolve_deps_source
from services.saw_api.app.settings import Settings


def _settings_for_tmp(repo_root: str) -> Settings:
    ws = os.path.join(repo_root, "saw-workspace")
    os.makedirs(ws, exist_ok=True)
    return Settings(
        db_url="postgresql://saw_app:saw_app@127.0.0.1:54329/saw",
        db_admin_url="postgresql://saw_admin:saw_admin@127.0.0.1:54329/saw",
        embed_model="text-embedding-3-small",
        openai_api_key=None,
        workspace_root=ws,
        allowed_origins=["http://localhost:5173"],
    )


def test_env_key_is_stable_and_order_insensitive_for_pip(tmp_path) -> None:
    settings = _settings_for_tmp(str(tmp_path))
    plugin_dir = os.path.join(settings.workspace_root, "plugins", "p1")
    os.makedirs(plugin_dir, exist_ok=True)

    r1 = compute_env_resolution(
        settings=settings,
        plugin_dir=plugin_dir,
        plugin_id="p1",
        plugin_version="0.0.0",
        env_python=">=3.11,<3.13",
        env_lockfile=None,
        env_requirements=None,
        env_pip=["numpy>=1.26", "scipy>=1.11"],
        extras={"cuda": "none"},
    )
    r2 = compute_env_resolution(
        settings=settings,
        plugin_dir=plugin_dir,
        plugin_id="p1",
        plugin_version="0.0.0",
        env_python=">=3.11,<3.13",
        env_lockfile=None,
        env_requirements=None,
        env_pip=["scipy>=1.11", "numpy>=1.26"],
        extras={"cuda": "none"},
    )
    assert r1.env_key == r2.env_key
    assert os.path.isfile(r1.manifest_path)
    assert os.path.isfile(r2.manifest_path)


def test_resolve_deps_source_precedence_manifest_lockfile(tmp_path) -> None:
    settings = _settings_for_tmp(str(tmp_path))
    plugin_dir = os.path.join(settings.workspace_root, "plugins", "p2")
    os.makedirs(plugin_dir, exist_ok=True)

    # Both exist; manifest lockfile must win.
    custom = os.path.join(plugin_dir, "custom.lock")
    uvlock = os.path.join(plugin_dir, "uv.lock")
    open(custom, "w", encoding="utf-8").write("CUSTOM\n")
    open(uvlock, "w", encoding="utf-8").write("UV\n")

    deps = resolve_deps_source(plugin_dir=plugin_dir, env_lockfile="custom.lock", env_requirements=None, env_pip=None)
    assert deps.kind == "lockfile"
    assert deps.rel_path == "custom.lock"


def test_compute_env_key_matches_spec_example_shape() -> None:
    payload = compute_env_key_payload(
        python_major_minor="3.11",
        platform_tag="darwin-arm64",
        deps_sha256="0" * 64,
        extras={"cuda": "none"},
    )
    key = compute_env_key(payload)
    assert isinstance(key, str)
    assert len(key) == 16



