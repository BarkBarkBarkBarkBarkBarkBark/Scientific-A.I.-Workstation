from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from . import env_manager
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
    requirements: str | None = None


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
    category_path: str | None = None
    # Optional: allows future manifests to declare intent. Lock enforcement is still server-side.
    locked: bool | None = None
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


def execute_plugin(
    settings: Settings,
    plugin: DiscoveredPlugin,
    inputs: dict[str, Any],
    params: dict[str, Any],
) -> dict[str, Any]:
    # Compute env_key + write env manifest (repo_root/.saw/env/manifests/<env_key>.json)
    # The returned env_key becomes the stable identifier we use for caching.
    er = env_manager.compute_env_resolution(
        settings=settings,
        plugin_dir=plugin.plugin_dir,
        plugin_id=plugin.manifest.id,
        plugin_version=plugin.manifest.version,
        env_python=plugin.manifest.environment.python,
        env_lockfile=plugin.manifest.environment.lockfile,
        env_requirements=getattr(plugin.manifest.environment, "requirements", None),
        env_pip=plugin.manifest.environment.pip,
        extras={"cuda": "none"},
    )

    py = env_manager.ensure_env(settings, er.env_key, er.deps, plugin_dir=plugin.plugin_dir)
    _ = er

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
    
    # Set up environment with SAW_RUN_DIR for plugins that need to write files
    env = dict(os.environ)
    if settings.openai_api_key and not env.get("OPENAI_API_KEY"):
        env["OPENAI_API_KEY"] = settings.openai_api_key
    # Create a temporary run directory for synchronous execution
    import tempfile
    import time
    run_id = f"sync_{int(time.time() * 1000)}"
    temp_run_dir = os.path.join(settings.workspace_root, ".saw", "runs", plugin.manifest.id, run_id)
    os.makedirs(temp_run_dir, exist_ok=True)
    os.makedirs(os.path.join(temp_run_dir, "output"), exist_ok=True)
    os.makedirs(os.path.join(temp_run_dir, "logs"), exist_ok=True)
    env["SAW_RUN_DIR"] = temp_run_dir
    
    p = subprocess.run(
        [py, runner],
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )
    stdout = p.stdout.decode("utf-8", errors="replace").strip()
    stderr = p.stderr.decode("utf-8", errors="replace").strip()

    # Persist raw outputs for debugging (even when the process is killed mid-run).
    try:
        logs_dir = os.path.join(temp_run_dir, "logs")
        os.makedirs(logs_dir, exist_ok=True)
        # Limit stored size to keep logs readable.
        max_chars = 200_000
        open(os.path.join(logs_dir, "stdout.txt"), "w", encoding="utf-8").write(stdout[-max_chars:])
        open(os.path.join(logs_dir, "stderr.txt"), "w", encoding="utf-8").write(stderr[-max_chars:])
    except Exception:
        pass

    # plugin_runner prints JSON result on stdout even on failure.
    out: dict[str, Any] = {}
    parsed_ok = False
    if stdout:
        try:
            parsed = json.loads(stdout)
            if isinstance(parsed, dict):
                out = parsed
                parsed_ok = True
        except Exception:
            out = {}

    # If the runner failed and did not provide a structured payload, raise with best details we have.
    if p.returncode != 0 and not parsed_ok:
        # stderr is often dominated by progress bars; show a tail snippet and point to log files.
        tail = (stderr or stdout)[-4000:]
        raise RuntimeError(
            f"plugin_failed rc={p.returncode}: {tail}\n"
            f"logs: {os.path.join(temp_run_dir, 'logs')}"
        )

    out["raw_stdout"] = stdout
    out["raw_stderr"] = stderr

    return out
