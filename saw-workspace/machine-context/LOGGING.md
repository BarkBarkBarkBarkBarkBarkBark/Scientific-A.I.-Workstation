# Logging & audit trail (machine-context)

This document describes the **audit trail artifacts** produced by SAW during development.

## Files (local)

### `.saw/agent.ndjson`

- Purpose: **SAW agent action log** (chat lifecycle + tool calls).
- Format: NDJSON (one JSON object per line).
- Producer: SAW API.
- Access:
  - On disk: `.saw/agent.ndjson`
  - HTTP: `GET /api/saw/agent/log` (proxied to SAW API `GET /agent/log`)

Typical event types include:

- `agent.chat.request` / `agent.chat.response`
- `agent.tool.auto_read` / `agent.tool.needs_approval`
- `agent.tool.write_result` / `agent.tool.write_error`
- `agent.http.patch_engine` (Patch Engine HTTP call metadata)

Notes:

- Tool arguments are **sanitized** to avoid logging large payloads (e.g. `content`/`patch`).
- If content logging is enabled, message/tool bodies are **redacted + truncated**.

### `.saw/session.ndjson`

- Purpose: **Patch Engine session log** for filesystem + subprocess activity.
- Format: NDJSON.
- Producer: Patch Engine.
- Access:
  - On disk: `.saw/session.ndjson`
  - HTTP (tail): `GET /api/dev/session/log?tail=<n>`

Typical event types include:

- `proc.start` / `proc.end` (captures `cmd`, `cwd`, `rc`, `duration_ms`, stdout/stderr head)
- `caps.set`, `safe.write.*`, `safe.patch.*`, etc.

## Environment controls

### SAW API (agent log)

- `SAW_AGENT_LOG=1|0`
  - Enable/disable writing `.saw/agent.ndjson`.
- `SAW_AGENT_LOG_CONTENT=1|0`
  - If enabled, log message/tool/http bodies (redacted + truncated).
  - Default is `0` to reduce accidental logging.
- `SAW_AGENT_LOG_MAX_CHARS=<int>`
  - Maximum characters logged for any text field when content logging is enabled.

### Patch Engine

- Patch Engine always appends to `.saw/session.ndjson` best-effort.
- Patch Engine subprocess logging is always **truncated** to keep logs small.

## Security / privacy notes

- Never rely on logs as the only security boundary.
- Logs intentionally avoid storing secrets; any token-like strings are redacted when content logging is enabled.
- Prefer storing only **action metadata** + stable summaries in machine-context; keep raw logs in `.saw/` (gitignored).
