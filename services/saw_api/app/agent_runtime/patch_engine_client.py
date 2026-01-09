from __future__ import annotations

import json
import os
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def patch_engine_base_url() -> str:
    return (os.environ.get("SAW_PATCH_ENGINE_URL") or "http://127.0.0.1:5128").rstrip("/")


def http_json(method: str, url: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | None, str]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, method=method.upper(), data=data, headers=headers)
    try:
        with urlopen(req, timeout=30) as resp:  # nosec - local dev endpoints
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return int(resp.status), (json.loads(raw) if raw else None), raw
            except Exception:
                return int(resp.status), None, raw
    except HTTPError as e:
        # Preserve status + body for error responses (e.g. 409 target_dirty) so the agent can react.
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            raw = str(e)
        try:
            j = json.loads(raw) if raw else None
        except Exception:
            j = None
        return int(getattr(e, "code", 0) or 0), (j if isinstance(j, dict) else None), raw
    except Exception as e:
        return 0, None, str(e)


def pe_get(path: str, query: dict[str, Any] | None = None) -> dict[str, Any]:
    q = ("?" + urlencode({k: str(v) for k, v in (query or {}).items()})) if query else ""
    url = patch_engine_base_url() + path + q
    status, j, raw = http_json("GET", url)
    if status and 200 <= status < 300 and isinstance(j, dict):
        return j
    raise RuntimeError(f"patch_engine_get_failed status={status} raw={raw[:2000]}")


def pe_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = patch_engine_base_url() + path
    status, j, raw = http_json("POST", url, body=body)
    if status and 200 <= status < 300 and isinstance(j, dict):
        return j
    raise RuntimeError(f"patch_engine_post_failed status={status} raw={raw[:2000]}")


