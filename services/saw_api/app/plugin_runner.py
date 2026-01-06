from __future__ import annotations

import importlib.util
import json
import os
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class Context:
    logs: list[dict[str, Any]]

    def log(self, level: str, event: str, **fields: Any) -> None:
        self.logs.append({"level": str(level), "event": str(event), "fields": fields})


def load_callable(plugin_dir: str, entry_file: str, callable_name: str):
    path = os.path.abspath(os.path.join(plugin_dir, entry_file))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"entry_file_not_found: {path}")
    mod_name = f"saw_plugin_{abs(hash(path))}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if not spec or not spec.loader:
        raise RuntimeError("import_spec_failed")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    fn = getattr(mod, callable_name, None)
    if not callable(fn):
        raise RuntimeError(f"callable_not_found: {callable_name}")
    return fn


def main() -> int:
    raw = sys.stdin.read()
    payload = json.loads(raw or "{}")
    plugin_dir = str(payload.get("plugin_dir") or "")
    entry_file = str(payload.get("entry_file") or "wrapper.py")
    callable_name = str(payload.get("callable") or "main")
    inputs = payload.get("inputs") or {}
    params = payload.get("params") or {}

    # Ensure plugin dir is importable (for relative imports inside wrappers)
    if plugin_dir and plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)

    ctx = Context(logs=[])
    fn = load_callable(plugin_dir, entry_file, callable_name)
    out = fn(inputs, params, ctx)
    sys.stdout.write(json.dumps({"ok": True, "outputs": out, "logs": ctx.logs}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


