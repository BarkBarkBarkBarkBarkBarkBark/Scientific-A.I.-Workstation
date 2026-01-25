# API Health Checker (api_endpoints.json)

This SAW plugin probes API endpoints defined in `machine-context/api_endpoints.json` and produces a structured report.

## Defaults

- **Input** `endpoints_json` defaults to: `machine-context/api_endpoints.json` (workspace-relative)
- Skips potentially expensive or side-effectful endpoints unless enabled:
  - AI endpoints (`allow_ai`)
  - write endpoints (`allow_writes`)
  - plugin-execution endpoints (`allow_plugins`)

## Output

- `report` (object)
  - `totals`: pass/warn/fail/skipped
  - `results`: list of per-endpoint checks with status and latency

## Notes

This plugin uses only the Python standard library (`urllib`) and performs **read-only disk access**.
Network access is required to reach the local services.
