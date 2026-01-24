"""SAW Workspace Plugin (generated)

Edit this file to integrate your lab code.

You can provide either:
  - def main(inputs: dict, params: dict, context) -> dict
or
  - def run(file_path: str, params: dict, context) -> dict

Default input key: "file" (expects inputs["file"]["data"])
Default output key: "result"
"""

from __future__ import annotations

from typing import Any

# --- user code (start) ---
health_check
# --- user code (end) ---

_USER_MAIN = globals().get('main')
_USER_RUN = globals().get('run')

def main(inputs: dict, params: dict, context) -> dict:
    # Prefer user-defined main() if present.
    if callable(_USER_MAIN):
        return _USER_MAIN(inputs, params, context)
    # Fallback: call user-defined run(file_path, params, context)
    if callable(_USER_RUN):
        x = (inputs or {}).get('file') or {}
        file_path = x.get('data')
        return {'result': {'data': _USER_RUN(file_path, params or {}, context), 'metadata': {}}}
    raise RuntimeError('missing_entrypoint: define main(inputs, params, context) or run(file_path, params, context)')
