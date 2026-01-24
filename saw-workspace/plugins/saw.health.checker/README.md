# API Health Checker (SAW workspace plugin)

This plugin reads `saw-workspace/machine-context/api_endpoints.json` and probes each listed endpoint.

## Defaults (permissive)

By default it will attempt **all** checks, including:
- AI endpoints (`allow_ai=true`)
- write/mutation endpoints (`allow_writes=true`)
- plugin execution endpoints (`allow_plugins=true`)

You can disable any category by setting the corresponding param to `false`.

## Outputs

- `report` (object): full structured JSON
- `table` (text): TSV table you can sort/filter easily

The TSV is ordered with failures first, then warnings, then passes, then skipped.

## Notes

- 2xx/3xx => pass
- 4xx => warn (endpoint reachable but request may be invalid/unauthorized)
- 5xx or network error => fail
- Multipart upload endpoints are skipped.
