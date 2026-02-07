"""SAW Plugin: API Health Checker (v2)

This v2 checker is intentionally thin: it delegates to the SAW API's single canonical
endpoint at POST /api-health/report.

The SAW API endpoint implements safe-by-default probing and can also write a cached
machine-context report artifact.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any


def _truthy(s: Any) -> bool:
    return str(s or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _post_json(url: str, payload: dict[str, Any], timeout_sec: float) -> tuple[int | None, Any, str | None]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            status = int(getattr(resp, "status", 0) or 0)
            raw = resp.read(2 * 1024 * 1024)
            text = raw.decode("utf-8", errors="replace")
            try:
                return status, json.loads(text or "null"), None
            except Exception:
                return status, {"error": "non_json_response", "text": text}, None
    except urllib.error.HTTPError as e:
        status = int(getattr(e, "code", 0) or 0)
        raw = b""
        try:
            raw = e.read(2 * 1024 * 1024) or b""
        except Exception:
            pass
        text = raw.decode("utf-8", errors="replace")
        try:
            return status, json.loads(text or "null"), None
        except Exception:
            return status, {"error": "http_error", "status_code": status, "text": text}, None
    except Exception as exc:
        return None, None, f"{type(exc).__name__}: {exc}"


def main(inputs: dict, params: dict, context) -> dict:
    started = time.time()

    timeout_sec = float((params or {}).get("timeout_sec") or 3)
    timeout_sec = max(0.5, min(60.0, timeout_sec))

    allow_ai = _truthy((params or {}).get("allow_ai"))
    allow_writes = _truthy((params or {}).get("allow_writes"))
    allow_plugins = _truthy((params or {}).get("allow_plugins"))
    allow_benign_writes = _truthy((params or {}).get("allow_benign_writes"))
    # default: benign writes are allowed
    if "allow_benign_writes" not in (params or {}):
        allow_benign_writes = True

    use_cache = _truthy((params or {}).get("use_cache"))
    if "use_cache" not in (params or {}):
        use_cache = True
    max_age_sec = int((params or {}).get("max_age_sec") or 30)
    max_age_sec = max(0, min(3600, max_age_sec))

    write_cache = _truthy((params or {}).get("write_cache"))
    if "write_cache" not in (params or {}):
        write_cache = True

    saw_api_url = str((params or {}).get("saw_api_url") or os.environ.get("SAW_API_URL") or "http://localhost:5127").strip()

    payload = {
        "mode": "probe",
        "allow_ai": allow_ai,
        "allow_writes": allow_writes,
        "allow_plugins": allow_plugins,
        "allow_benign_writes": allow_benign_writes,
        "timeout_sec": timeout_sec,
        "use_cache": use_cache,
        "max_age_sec": max_age_sec,
        "write_cache": write_cache,
    }

    context.log(
        "info",
        "health_checker_v2:start",
        saw_api_url=saw_api_url,
        payload=payload,
    )

    report_url = saw_api_url.rstrip("/") + "/api-health/report"
    status, data, err = _post_json(report_url, payload, timeout_sec=float(timeout_sec) + 10.0)
    dur_ms = int(max(0.0, (time.time() - started) * 1000.0))
    if err is not None:
        context.log("error", "health_checker_v2:failed", error=err)
        return {
            "ok": {"data": False, "metadata": {"duration_ms": dur_ms}},
            "error": {"data": err, "metadata": {"duration_ms": dur_ms}},
        }

    ok = bool(data.get("ok")) if isinstance(data, dict) else False
    return {
        "ok": {"data": ok, "metadata": {"duration_ms": dur_ms, "http_status": status}},
        "report": {"data": data, "metadata": {"duration_ms": dur_ms, "http_status": status}},
    }

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
