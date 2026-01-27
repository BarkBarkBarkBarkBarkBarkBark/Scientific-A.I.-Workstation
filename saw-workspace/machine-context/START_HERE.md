
# SAW machine-context: deterministic entrypoint

This folder is the canonical, machine-readable context bundle for SAW agents and tooling.

## What lives here

- `context.json`: high-level runtime context snapshot (inputs for agents)
- `api_endpoints.json`: API surface snapshot used by tools/clients
- `files.json`: file inventory snapshot
- `A2UI_DEPLOYMENT.md`: how to deploy A2UI plugin UIs (`ui/a2ui.yaml`)
- `introspection/IntrospectionPacket_v1_1.schema.json`: JSON Schema for the audit-grade introspection packet
- `tools/tools.catalog.v1.json`: tool catalog snapshot (generated from `/api/dev/tools/list` when available)
- `attestation/default_probes.v1.json`: deterministic probe plan for one-button attestation
- `security/CAPS_RULES.md`: capability (caps) normalization + precedence rules
- `LOGGING.md`: where to find audit logs (`.saw/agent.ndjson`, `.saw/session.ndjson`) and how to enable content logging

## Current recommended workflow (dev)

1. Start the stack: `./scripts/dev_all_mac.sh --frontend-port 7176 --api-port 5127`
2. Use Patch Engine read tools:
	- `GET /api/dev/file?path=<rel>` returns `content` plus deterministic metadata (`bytes`, `sha256`, `head_40_lines`, `error`).
	- `GET /api/dev/tree?root=<rel>&depth=<n>&max=<n>` returns `tree` plus `truncated`.

## Attestation (planned)

The long-term goal is a single endpoint:

- `GET /api/dev/introspection/run` (or `POST`) → returns `IntrospectionPacket_v1_1`.

Evidence kinds are standardized as:

- `tool_call`
- `file_read`
- `shell_command`

Until that exists, `attestation/default_probes.v1.json` is the source-of-truth for which probes/files must be included.

