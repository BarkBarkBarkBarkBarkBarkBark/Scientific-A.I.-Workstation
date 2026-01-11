from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from typing import Any


def _load_callable(plugin_dir: str, entry_file: str, callable_name: str):
    path = os.path.abspath(os.path.join(plugin_dir, entry_file))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"entry_file_not_found: {path}")
    mod_name = f"saw_plugin_probe_{abs(hash(path))}"
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


def _json(res: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(res, ensure_ascii=False))
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("--plugin-dir", required=True)
    p.add_argument("--entry-file", default="wrapper.py")
    p.add_argument("--callable", dest="callable_name", default="main")
    args = p.parse_args(list(argv or sys.argv[1:]))

    plugin_dir = str(args.plugin_dir or "").strip()
    entry_file = str(args.entry_file or "wrapper.py").strip()
    callable_name = str(args.callable_name or "main").strip()

    if plugin_dir and plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)

    try:
        _ = _load_callable(plugin_dir, entry_file, callable_name)
        _json({"ok": True})
        return 0
    except Exception as e:
        _json({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

