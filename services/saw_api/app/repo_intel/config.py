from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

import yaml


@dataclass(frozen=True)
class RepoIntelEntrypoint:
    name: str
    command: str
    args: list[str]


@dataclass(frozen=True)
class RepoIntelConfig:
    entrypoints: list[RepoIntelEntrypoint]
    excludes: list[str]
    dynamic_import_allowlist: list[str]


DEFAULT_EXCLUDES = [
    "**/.venv/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
]


def load_repo_intel_config(repo_root: str) -> RepoIntelConfig:
    cfg_path = os.path.join(repo_root, ".saw", "repo_intel.yaml")
    if not os.path.isfile(cfg_path):
        return RepoIntelConfig(entrypoints=[], excludes=list(DEFAULT_EXCLUDES), dynamic_import_allowlist=[])

    raw = yaml.safe_load(open(cfg_path, "r", encoding="utf-8")) or {}
    eps: list[RepoIntelEntrypoint] = []
    for e in (raw.get("entrypoints") or []):
        if not isinstance(e, dict):
            continue
        name = str(e.get("name") or "")
        command = str(e.get("command") or "")
        args = e.get("args") or []
        if not name or not command:
            continue
        if not isinstance(args, list):
            args = []
        eps.append(RepoIntelEntrypoint(name=name, command=command, args=[str(a) for a in args]))

    excludes = raw.get("excludes")
    if not isinstance(excludes, list) or not excludes:
        excludes = list(DEFAULT_EXCLUDES)

    allow = raw.get("dynamic_import_allowlist")
    if not isinstance(allow, list):
        allow = []

    return RepoIntelConfig(
        entrypoints=eps,
        excludes=[str(x) for x in excludes],
        dynamic_import_allowlist=[str(x) for x in allow],
    )


def config_to_json(cfg: RepoIntelConfig) -> dict[str, Any]:
    return {
        "entrypoints": [{"name": e.name, "command": e.command, "args": e.args} for e in cfg.entrypoints],
        "excludes": list(cfg.excludes),
        "dynamic_import_allowlist": list(cfg.dynamic_import_allowlist),
    }
