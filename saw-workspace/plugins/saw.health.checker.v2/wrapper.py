"""SAW Plugin: API Health Checker

Reads saw-workspace/machine-context/api_endpoints.json (by default) and probes each listed endpoint.

This is a "safe by default" health checker: it will skip endpoints that are likely to incur
costs or side effects (AI calls, writes, plugin execution) unless enabled via params.

Outputs a structured report with per-endpoint status and latency.
"""

from __future__ import annotations

import json
import os
import time
import uuid
import urllib.error
import urllib.request
from typing import Any


def _workspace_root() -> str:
    env = os.environ.get("SAW_WORKSPACE_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(__file__)
    # wrapper.py is at saw-workspace/plugins/<id>/wrapper.py
    return os.path.abspath(os.path.join(here, "..", ".."))


def _safe_join_under(root: str, rel: str) -> str:
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        raise ValueError("missing_path")
    if rel.startswith("/") or rel.startswith("~"):
        raise ValueError("path must be workspace-relative")
    if rel.startswith("..") or "/../" in f"/{rel}/":
        raise ValueError("path traversal is not allowed")
    abs_path = os.path.abspath(os.path.join(root, rel))
    root_abs = os.path.abspath(root)
    if not abs_path.startswith(root_abs):
        raise ValueError("path must be inside saw-workspace/")
    return abs_path


def _truthy(s: Any) -> bool:
    return str(s or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _join_url(base_url: str, path: str) -> str:
    b = (base_url or "").rstrip("/")
    p = (path or "")
    if not p.startswith("/"):
        p = "/" + p
    return b + p


def _substitute_path(path: str, mapping: dict[str, str]) -> str:
    out = path
    for k, v in mapping.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _sample_value(type_str: str) -> Any:
    t = (type_str or "").strip()
    if t.endswith("?"):
        return None
    if t == "string":
        return "health_check"
    if t == "boolean":
        return False
    if t in ("integer", "number"):
        return 1
    if t == "object":
        return {}
    if t == "string[]":
        return ["health_check"]
    return "health_check"


def _sample_body(body_spec: dict[str, Any] | None) -> dict[str, Any] | None:
    if not body_spec:
        return {}
    out: dict[str, Any] = {}
    for k, v in body_spec.items():
        if isinstance(v, str):
            val = _sample_value(v)
            if val is not None:
                out[str(k)] = val
        elif isinstance(v, dict):
            t = str(v.get("type") or "object")
            val = _sample_value(t)
            if val is not None:
                out[str(k)] = val
        else:
            out[str(k)] = "health_check"
    if "nonce" in out and isinstance(out.get("nonce"), str):
        out["nonce"] = str(uuid.uuid4())
    return out


def _http_request(
    method: str, url: str, body: dict[str, Any] | None, timeout_sec: float
) -> tuple[int | None, str, int, str | None]:
    headers = {"Accept": "application/json"}
    data = None
    if body is not None and method.upper() not in ("GET", "HEAD"):
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            status = int(getattr(resp, "status", 0) or 0)
            raw = resp.read(64 * 1024)
            text = raw.decode("utf-8", errors="replace")
            dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
            return status, text, dur_ms, None
    except urllib.error.HTTPError as e:
        status = int(getattr(e, "code", 0) or 0)
        raw = b""
        try:
            raw = e.read(64 * 1024) or b""
        except Exception:
            pass
        text = raw.decode("utf-8", errors="replace")
        dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
        return status, text, dur_ms, None
    except Exception as e:
        dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
        return None, "", dur_ms, f"{type(e).__name__}: {e}"


def _is_ai_endpoint(service_id: str, path: str) -> bool:
    if service_id == "vite_openai_proxy":
        return path != "/api/ai/status"
    if path.startswith("/agent/chat"):
        return True
    if path.startswith("/embed/") or path.startswith("/search/"):
        return True
    return False


def _is_writey_endpoint(path: str, method: str) -> bool:
    m = method.upper()
    if m == "GET":
        return False
    if path.startswith("/db/"):
        return True
    if path.startswith("/ingest/"):
        return True
    if path.startswith("/embed/upsert"):
        return True
    if path.startswith("/audit/"):
        return True
    if path.startswith("/patch/"):
        return True
    if "/plugins/create_from_python" in path or path.endswith("/plugins/fork"):
        return True
    if path.endswith("/plugins/execute"):
        return True
    if path.startswith("/api/plugins/") and path.endswith("/run"):
        return True
    if path.startswith("/api/services/") and path.endswith("/stop"):
        return True
    if path.startswith("/api/dev/") and m in ("POST", "PUT", "DELETE", "PATCH"):
        return True
    return False


def _is_plugin_exec_endpoint(path: str) -> bool:
    return path.endswith("/plugins/execute") or (
        path.startswith("/api/plugins/") and path.endswith("/run")
    )


def main(inputs: dict, params: dict, context) -> dict:
    started = time.time()

    endpoints_rel = str(
        ((inputs or {}).get("endpoints_json") or {}).get("data")
        or "machine-context/api_endpoints.json"
    ).strip()

    timeout_sec = float((params or {}).get("timeout_sec") or 3)
    timeout_sec = max(0.5, min(60.0, timeout_sec))

    frontend_url = str((params or {}).get("frontend_url") or "http://127.0.0.1:5173").strip()

    allow_ai = _truthy((params or {}).get("allow_ai"))
    allow_writes = _truthy((params or {}).get("allow_writes"))
    allow_plugins = _truthy((params or {}).get("allow_plugins"))

    sample_plugin_id = str((params or {}).get("sample_plugin_id") or "saw.template.plugin").strip()
    sample_run_id = str((params or {}).get("sample_run_id") or "does_not_exist").strip()
    sample_service_id = str((params or {}).get("sample_service_id") or "does_not_exist").strip()

    ws_root = _workspace_root()
    endpoints_path = _safe_join_under(ws_root, endpoints_rel)

    spec = json.loads(open(endpoints_path, "r", encoding="utf-8").read() or "{}")
    services = spec.get("services") or []

    subs = {
        "plugin_id": sample_plugin_id,
        "run_id": sample_run_id,
        "service_id": sample_service_id,
    }

    context.log(
        "info",
        "health_checker:start",
        endpoints_json=endpoints_rel,
        services=len(services),
        allow_ai=allow_ai,
        allow_writes=allow_writes,
        allow_plugins=allow_plugins,
        timeout_sec=timeout_sec,
    )

    results: list[dict[str, Any]] = []
    totals = {"pass": 0, "warn": 0, "fail": 0, "skipped": 0}

    for svc in services:
        service_id = str(svc.get("id") or "")
        base_env = str(svc.get("base_url_env") or "").strip()
        base_url = str(svc.get("default_base_url") or svc.get("base_url") or "").strip()

        if base_env and os.environ.get(base_env):
            base_url = str(os.environ.get(base_env) or "").strip()

        if service_id == "vite_openai_proxy":
            base_url = frontend_url

        endpoints = svc.get("endpoints") or []
        for ep in endpoints:
            method = str(ep.get("method") or "GET").upper()
            raw_path = str(ep.get("path") or "")
            path = _substitute_path(raw_path, subs)

            url = _join_url(base_url, path) if base_url else path

            item: dict[str, Any] = {
                "service_id": service_id,
                "method": method,
                "path": raw_path,
                "resolved_path": path,
                "url": url,
            }

            if _is_ai_endpoint(service_id, path) and not allow_ai:
                item.update({"level": "skipped", "reason": "ai_disabled"})
                totals["skipped"] += 1
                results.append(item)
                continue

            if _is_plugin_exec_endpoint(path) and not allow_plugins:
                item.update({"level": "skipped", "reason": "plugins_disabled"})
                totals["skipped"] += 1
                results.append(item)
                continue

            if _is_writey_endpoint(path, method) and not allow_writes:
                item.update({"level": "skipped", "reason": "writes_disabled"})
                totals["skipped"] += 1
                results.append(item)
                continue

            if path.endswith("/files/upload_audio_wav"):
                item.update({"level": "skipped", "reason": "requires_multipart_upload"})
                totals["skipped"] += 1
                results.append(item)
                continue

            body = None
            if method != "GET":
                body = _sample_body(ep.get("body"))

            status, text, dur_ms, err = _http_request(method, url, body, timeout_sec)

            item.update({"status": status, "duration_ms": dur_ms, "error": err})

            if text:
                item["response_snippet"] = text[:1000]

            if err is not None:
                item["level"] = "fail"
                totals["fail"] += 1
            elif status is None:
                item["level"] = "fail"
                totals["fail"] += 1
            elif 200 <= status < 400:
                item["level"] = "pass"
                totals["pass"] += 1
            elif 400 <= status < 500:
                item["level"] = "warn"
                totals["warn"] += 1
            else:
                item["level"] = "fail"
                totals["fail"] += 1

            results.append(item)

    report = {
        "generated_at": time.time(),
        "duration_ms": int((time.time() - started) * 1000),
        "endpoints_json": endpoints_rel,
        "totals": totals,
        "results": results,
    }

    context.log("info", "health_checker:done", totals=totals)
    return {"report": {"data": report, "metadata": {"plugin": "saw.health.checker.v2"}}}
