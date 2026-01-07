from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any


@dataclass
class Context:
    logs: list[dict[str, Any]]
    log_file: str | None = None

    def log(self, level: str, event: str, **fields: Any) -> None:
        item = {"level": str(level), "event": str(event), "fields": fields}
        self.logs.append(item)
        if self.log_file:
            try:
                os.makedirs(os.path.dirname(self.log_file), exist_ok=True)
                with open(self.log_file, "a", encoding="utf-8") as f:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
            except Exception:
                pass


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


def _jsonable(x: Any) -> Any:
    if x is None:
        return None
    if isinstance(x, (str, int, float, bool)):
        return x
    if isinstance(x, dict):
        return {str(k): _jsonable(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_jsonable(v) for v in x]
    # numpy arrays, pandas, etc.
    tolist = getattr(x, "tolist", None)
    if callable(tolist):
        try:
            return _jsonable(tolist())
        except Exception:
            pass
    return str(x)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("--run-dir", default="")
    p.add_argument("--run-json", default="")
    p.add_argument("--plugin-dir", default="")
    p.add_argument("--entry-file", default="wrapper.py")
    p.add_argument("--callable", dest="callable_name", default="main")
    return p.parse_args(argv)


def _load_payload(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    """
    Returns (payload, is_run_mode).
    Run mode: any of --run-dir or --run-json provided.
    Legacy mode: read stdin JSON.
    """
    is_run_mode = bool((args.run_dir or "").strip() or (args.run_json or "").strip())
    if not is_run_mode:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
        return payload if isinstance(payload, dict) else {}, False

    payload: dict[str, Any] = {}
    if (args.run_json or "").strip() and os.path.isfile(args.run_json):
        try:
            payload = json.loads(open(args.run_json, "r", encoding="utf-8").read() or "{}")
            if not isinstance(payload, dict):
                payload = {}
        except Exception:
            payload = {}

    # CLI args override run.json
    if (args.plugin_dir or "").strip():
        payload["plugin_dir"] = args.plugin_dir
    payload["entry_file"] = args.entry_file
    payload["callable"] = args.callable_name
    if (args.run_dir or "").strip():
        payload["run_dir"] = args.run_dir
    if (args.run_json or "").strip():
        payload["run_json"] = args.run_json
    return payload, True


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(argv or sys.argv[1:]))
    payload, is_run_mode = _load_payload(args)

    plugin_dir = str(payload.get("plugin_dir") or "")
    entry_file = str(payload.get("entry_file") or "wrapper.py")
    callable_name = str(payload.get("callable") or "main")
    inputs = payload.get("inputs") or {}
    params = payload.get("params") or {}
    run_dir = str(payload.get("run_dir") or "")

    # Ensure plugin dir is importable (for relative imports inside wrappers)
    if plugin_dir and plugin_dir not in sys.path:
        sys.path.insert(0, plugin_dir)

    log_file = None
    if is_run_mode and run_dir:
        log_file = os.path.join(run_dir, "logs", "context.ndjson")

    ctx = Context(logs=[], log_file=log_file)
    started = time.time()
    try:
        fn = load_callable(plugin_dir, entry_file, callable_name)
        out = fn(inputs, params, ctx)
        ok = True
        err = None
    except Exception as e:
        ok = False
        out = {}
        err = f"{type(e).__name__}: {e}"

    finished = time.time()
    result = {
        "ok": ok,
        "outputs": _jsonable(out),
        "services": [],
        "metrics": {
            "started_at": started,
            "finished_at": finished,
            "duration_ms": int(max(0.0, (finished - started) * 1000.0)),
        },
        "logs": _jsonable(ctx.logs),
        "error": err,
    }

    # Legacy callers expect stdout JSON.
    sys.stdout.write(json.dumps(result))
    sys.stdout.write("\n")

    # Run mode: also materialize output/results.json for the manager.
    if is_run_mode and run_dir:
        out_dir = os.path.join(run_dir, "output")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "results.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "outputs": result.get("outputs") or {},
                    "services": result.get("services") or [],
                    "metrics": result.get("metrics") or {},
                },
                f,
                indent=2,
                sort_keys=True,
            )
        # Optional one-line protocol for future streaming parsers.
        sys.stdout.write("SAW_RESULT:" + json.dumps({"outputs": result.get("outputs") or {}}) + "\n")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())


