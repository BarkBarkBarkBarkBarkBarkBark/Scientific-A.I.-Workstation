from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from .settings import Settings


SideEffectNetwork = Literal["none", "restricted", "allowed"]
SideEffectDisk = Literal["read_only", "read_write"]
SideEffectSubprocess = Literal["forbidden", "allowed"]

GpuPolicy = Literal["forbidden", "optional", "required"]


class Entrypoint(BaseModel):
    file: str
    callable: str


class EnvironmentSpec(BaseModel):
    python: str
    pip: list[str] = Field(default_factory=list)
    lockfile: str | None = None


class IoSpec(BaseModel):
    type: str
    dtype: str | None = None
    shape: list[str] | None = None
    ui: dict[str, Any] | None = None
    default: Any | None = None


class ExecutionSpec(BaseModel):
    deterministic: bool = True
    cacheable: bool = True


class SideEffectsSpec(BaseModel):
    network: SideEffectNetwork
    disk: SideEffectDisk
    subprocess: SideEffectSubprocess


class ResourcesSpec(BaseModel):
    gpu: GpuPolicy
    threads: int | None = None


class PluginManifest(BaseModel):
    id: str
    name: str
    version: str
    description: str
    entrypoint: Entrypoint
    environment: EnvironmentSpec
    inputs: dict[str, IoSpec]
    params: dict[str, IoSpec]
    outputs: dict[str, IoSpec]
    execution: ExecutionSpec
    side_effects: SideEffectsSpec
    resources: ResourcesSpec


@dataclass(frozen=True)
class DiscoveredPlugin:
    manifest: PluginManifest
    plugin_dir: str


def _hash_env(env: EnvironmentSpec) -> str:
    h = hashlib.sha256()
    h.update((env.python or "").encode("utf-8"))
    h.update(b"\n")
    for d in env.pip or []:
        h.update(str(d).encode("utf-8"))
        h.update(b"\n")
    if env.lockfile:
        h.update(str(env.lockfile).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()[:24]


def _repo_root_from_workspace(workspace_root: str) -> str:
    return os.path.abspath(os.path.join(workspace_root, ".."))


def _venv_python(venv_dir: str) -> str:
    if os.name == "nt":
        return os.path.join(venv_dir, "Scripts", "python.exe")
    return os.path.join(venv_dir, "bin", "python")


def discover_plugins(settings: Settings) -> list[DiscoveredPlugin]:
    root = settings.workspace_root
    plugins_dir = os.path.join(root, "plugins")
    out: list[DiscoveredPlugin] = []
    if not os.path.isdir(plugins_dir):
        return out
    for dirpath, dirnames, filenames in os.walk(plugins_dir):
        if "plugin.yaml" not in filenames:
            continue
        manifest_path = os.path.join(dirpath, "plugin.yaml")
        raw = yaml.safe_load(open(manifest_path, "r", encoding="utf-8"))
        # Pydantic v2: model_validate
        m = PluginManifest.model_validate(raw)
        out.append(DiscoveredPlugin(manifest=m, plugin_dir=dirpath))
        # don't recurse deeper once a plugin root found
        dirnames[:] = []
    out.sort(key=lambda p: p.manifest.id)
    return out


def ensure_env(settings: Settings, env: EnvironmentSpec) -> tuple[str, str]:
    repo_root = _repo_root_from_workspace(settings.workspace_root)
    store_root = os.path.join(repo_root, ".saw", "plugin_store", "envs")
    os.makedirs(store_root, exist_ok=True)
    env_id = _hash_env(env)
    venv_dir = os.path.join(store_root, env_id)
    py = _venv_python(venv_dir)

    if not os.path.exists(py):
        subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True)

    deps = [d for d in (env.pip or []) if str(d).strip()]
    if deps:
        uv = shutil.which("uv")
        if uv:
            subprocess.run([uv, "pip", "install", "--python", py, *deps], check=True)
        else:
            subprocess.run([py, "-m", "pip", "install", *deps], check=True)

    return env_id, py


def execute_plugin(
    settings: Settings,
    plugin: DiscoveredPlugin,
    inputs: dict[str, Any],
    params: dict[str, Any],
) -> dict[str, Any]:
    _env_id, py = ensure_env(settings, plugin.manifest.environment)

    entry_file = plugin.manifest.entrypoint.file
    entry_callable = plugin.manifest.entrypoint.callable

    runner = os.path.abspath(os.path.join(os.path.dirname(__file__), "plugin_runner.py"))
    payload = {
        "plugin_dir": plugin.plugin_dir,
        "entry_file": entry_file,
        "callable": entry_callable,
        "inputs": inputs or {},
        "params": params or {},
    }
    p = subprocess.run(
        [py, runner],
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if p.returncode != 0:
        raise RuntimeError(f"plugin_failed: {p.stderr.decode('utf-8', errors='ignore')[:4000]}")
    out = json.loads(p.stdout.decode("utf-8"))
    return out


