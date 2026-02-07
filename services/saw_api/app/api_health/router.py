from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import sha256_text
from ..settings import get_settings


router = APIRouter(prefix="/api-health", tags=["api-health"])


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_loopback(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return u
    return u.replace("http://127.0.0.1", "http://localhost").replace(
        "http://0.0.0.0", "http://localhost"
    ).replace("https://127.0.0.1", "https://localhost").replace(
        "https://0.0.0.0", "https://localhost"
    )


def _join_url(base_url: str, path: str) -> str:
    b = (base_url or "").rstrip("/")
    p = (path or "")
    if not p.startswith("/"):
        p = "/" + p
    return b + p


def _looks_templated(path: str) -> bool:
    return "{" in (path or "") and "}" in (path or "")


def _is_ai_endpoint(service_id: str, path: str) -> bool:
    p = path or ""
    if service_id == "vite_openai_proxy":
        return p != "/api/ai/status"
    if p.startswith("/agent/chat"):
        return True
    if p.startswith("/embed/") or p.startswith("/search/"):
        return True
    return False


def _is_plugin_exec_endpoint(path: str) -> bool:
    p = path or ""
    return p.endswith("/plugins/execute") or (
        p.startswith("/api/plugins/") and p.endswith("/run")
    )


def _is_writey_endpoint(path: str, method: str) -> bool:
    p = path or ""
    m = (method or "").upper()
    if m in ("GET", "HEAD"):
        return False
    if p.startswith("/db/"):
        return True
    if p.startswith("/ingest/"):
        return True
    if p.startswith("/embed/upsert"):
        return True
    if p.startswith("/audit/"):
        return True
    if p.startswith("/patch/"):
        return True
    if "/plugins/create_from_python" in p or p.endswith("/plugins/fork"):
        return True
    if _is_plugin_exec_endpoint(p):
        return True
    if p.startswith("/api/services/") and p.endswith("/stop"):
        return True
    if p.startswith("/api/dev/") and m in ("POST", "PUT", "DELETE", "PATCH"):
        return True
    return False


def _is_benign_write_endpoint(path: str, method: str) -> bool:
    p = path or ""
    m = (method or "").upper()
    if m != "POST":
        return False
    return p == "/audit/event"


def _http_request(
    method: str, url: str, body: dict[str, Any] | None, timeout_sec: float
) -> tuple[int | None, int, str | None]:
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
            dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
            return status, dur_ms, None
    except urllib.error.HTTPError as e:
        status = int(getattr(e, "code", 0) or 0)
        dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
        return status, dur_ms, None
    except Exception as e:
        dur_ms = int(max(0.0, (time.time() - start) * 1000.0))
        return None, dur_ms, f"{type(e).__name__}: {e}"


@dataclass(frozen=True)
class _CachePaths:
    report_path: Path
    spec_path: Path


def _cache_paths() -> _CachePaths:
    settings = get_settings()
    ws_root = Path(settings.workspace_root)
    mc = ws_root / "machine-context"
    return _CachePaths(
        report_path=mc / "api_health_report.json",
        spec_path=mc / "api_endpoints.json",
    )


def _load_spec() -> dict[str, Any]:
    paths = _cache_paths()
    if not paths.spec_path.exists():
        return {}
    try:
        return json.loads(paths.spec_path.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {}


class ApiHealthReportRequest(BaseModel):
    mode: Literal["spec", "probe"] = "probe"

    include_services: list[str] | None = None

    allow_ai: bool = False
    allow_writes: bool = False
    allow_plugins: bool = False
    allow_benign_writes: bool = True

    timeout_sec: float = Field(default=3.0, ge=0.5, le=60.0)

    prefer_localhost: bool = True

    use_cache: bool = True
    max_age_sec: int = Field(default=30, ge=0, le=3600)
    write_cache: bool = True


class ApiHealthProbeResult(BaseModel):
    service_id: str
    method: str
    path: str
    url: str

    status: Literal["pass", "fail", "skipped"]
    skip_reason: str | None = None

    http_status: int | None = None
    latency_ms: int | None = None
    error: str | None = None


class ApiHealthReportResponse(BaseModel):
    ok: bool
    at: datetime
    mode: Literal["spec", "probe"]

    spec_sha256: str
    spec_path_rel: str

    services: list[dict[str, Any]]
    results: list[ApiHealthProbeResult]

    summary: dict[str, Any]
    cache: dict[str, Any]


def _summarize(results: list[ApiHealthProbeResult]) -> dict[str, Any]:
    counts = {"pass": 0, "fail": 0, "skipped": 0}
    for r in results:
        counts[r.status] = int(counts.get(r.status, 0)) + 1
    return {
        "counts": counts,
        "total": sum(counts.values()),
        "ok": counts["fail"] == 0,
    }


def _read_cache_if_valid(
    *, spec_sha256: str, req: ApiHealthReportRequest
) -> tuple[dict[str, Any] | None, str | None]:
    paths = _cache_paths()
    if not paths.report_path.exists():
        return None, "missing"
    if req.max_age_sec <= 0:
        return None, "disabled"

    try:
        raw = json.loads(paths.report_path.read_text(encoding="utf-8") or "{}")
    except Exception:
        return None, "unreadable"

    if str(raw.get("spec_sha256") or "") != spec_sha256:
        return None, "spec_changed"

    # Ensure cache was generated for the same mode.
    if str(raw.get("mode") or "") != req.mode:
        return None, "mode_changed"

    # Age check.
    try:
        at = raw.get("at")
        if isinstance(at, str):
            # datetime.fromisoformat can parse offsets; assume UTC if missing.
            parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        elif isinstance(at, datetime):
            parsed = at
        else:
            return None, "missing_at"
        age = (_utc_now() - parsed).total_seconds()
        if age > float(req.max_age_sec):
            return None, "stale"
    except Exception:
        return None, "bad_at"

    return raw, None


def _write_cache(payload: dict[str, Any]) -> tuple[bool, str | None]:
    paths = _cache_paths()
    try:
        paths.report_path.parent.mkdir(parents=True, exist_ok=True)
        paths.report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return True, None
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


@router.post("/report", response_model=ApiHealthReportResponse)
def api_health_report(req: ApiHealthReportRequest) -> ApiHealthReportResponse:
    paths = _cache_paths()
    spec = _load_spec()
    spec_text = json.dumps(spec, sort_keys=True, ensure_ascii=False)
    spec_sha = sha256_text(spec_text)

    if not spec.get("services"):
        raise HTTPException(status_code=500, detail="api_endpoints_spec_missing")

    if req.use_cache and req.write_cache:
        cached, cache_reason = _read_cache_if_valid(spec_sha256=spec_sha, req=req)
        if cached is not None:
            # Return cached payload as-is (Pydantic will validate/convert).
            cached.setdefault("cache", {})
            cached["cache"].update({"hit": True, "hit_reason": None})
            return ApiHealthReportResponse.model_validate(cached)
        # fallthrough; will regenerate

    services: list[dict[str, Any]] = list(spec.get("services") or [])
    if req.include_services:
        allow = set([s.strip() for s in req.include_services if str(s or "").strip()])
        services = [s for s in services if str(s.get("id") or "") in allow]

    results: list[ApiHealthProbeResult] = []

    if req.mode == "probe":
        for svc in services:
            service_id = str(svc.get("id") or "").strip()
            if not service_id:
                continue

            base_url = (
                os.environ.get(str(svc.get("base_url_env") or "").strip() or "")
                or str(svc.get("default_base_url") or "").strip()
                or str(svc.get("base_url") or "").strip()
            )
            if not base_url or base_url == "same-origin":
                continue

            if req.prefer_localhost:
                base_url = _normalize_loopback(base_url)

            for ep in list(svc.get("endpoints") or []):
                method = str(ep.get("method") or "GET").upper()
                path = str(ep.get("path") or "").strip()
                if not path:
                    continue

                url = _join_url(base_url, path)

                if _looks_templated(path):
                    results.append(
                        ApiHealthProbeResult(
                            service_id=service_id,
                            method=method,
                            path=path,
                            url=url,
                            status="skipped",
                            skip_reason="templated_path",
                        )
                    )
                    continue

                if path == "/files/upload_audio_wav":
                    results.append(
                        ApiHealthProbeResult(
                            service_id=service_id,
                            method=method,
                            path=path,
                            url=url,
                            status="skipped",
                            skip_reason="multipart",
                        )
                    )
                    continue

                if _is_ai_endpoint(service_id, path) and not req.allow_ai:
                    results.append(
                        ApiHealthProbeResult(
                            service_id=service_id,
                            method=method,
                            path=path,
                            url=url,
                            status="skipped",
                            skip_reason="ai_disabled",
                        )
                    )
                    continue

                if _is_plugin_exec_endpoint(path) and not req.allow_plugins:
                    results.append(
                        ApiHealthProbeResult(
                            service_id=service_id,
                            method=method,
                            path=path,
                            url=url,
                            status="skipped",
                            skip_reason="plugin_exec_disabled",
                        )
                    )
                    continue

                if _is_writey_endpoint(path, method) and not req.allow_writes:
                    if _is_benign_write_endpoint(path, method) and req.allow_benign_writes:
                        pass
                    else:
                        results.append(
                            ApiHealthProbeResult(
                                service_id=service_id,
                                method=method,
                                path=path,
                                url=url,
                                status="skipped",
                                skip_reason="writes_disabled",
                            )
                        )
                        continue

                body: dict[str, Any] | None = None
                if method not in ("GET", "HEAD"):
                    body_spec = ep.get("body")
                    if path == "/audit/event":
                        body = {
                            "actor": "api_health",
                            "event_type": "health_probe",
                            "details_json": {"nonce": str(int(time.time() * 1000))},
                        }
                    elif isinstance(body_spec, dict):
                        # Very conservative: only include explicit empty object.
                        body = {}
                    else:
                        body = {}

                http_status, dur_ms, err = _http_request(
                    method=method, url=url, body=body, timeout_sec=req.timeout_sec
                )

                status: Literal["pass", "fail", "skipped"]
                if err is not None:
                    status = "fail"
                elif http_status is None:
                    status = "fail"
                elif 200 <= http_status < 400:
                    status = "pass"
                else:
                    status = "fail"

                results.append(
                    ApiHealthProbeResult(
                        service_id=service_id,
                        method=method,
                        path=path,
                        url=url,
                        status=status,
                        http_status=http_status,
                        latency_ms=dur_ms,
                        error=err,
                    )
                )

    summary = _summarize(results)
    ok = bool(summary.get("ok"))

    payload: dict[str, Any] = {
        "ok": ok,
        "at": _utc_now().isoformat(),
        "mode": req.mode,
        "spec_sha256": spec_sha,
        "spec_path_rel": "machine-context/api_endpoints.json",
        "services": services,
        "results": [r.model_dump() for r in results],
        "summary": summary,
        "cache": {
            "hit": False,
            "hit_reason": None,
            "write_requested": req.write_cache,
            "written": False,
            "path_rel": "machine-context/api_health_report.json",
            "error": None,
        },
    }

    if req.write_cache:
        written, cache_err = _write_cache(payload)
        payload["cache"]["written"] = written
        payload["cache"]["error"] = cache_err

    # Ensure response_model validation
    return ApiHealthReportResponse.model_validate(payload)
