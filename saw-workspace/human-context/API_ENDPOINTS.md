# SAW API Endpoints (Human Reference)

This is a human-oriented reference of API endpoints in this repo, grouped by service.

## Service map (dev)

- **Frontend (Vite)**: `http://127.0.0.1:5173` (default)
  - Proxies:
    - `/api/saw/*` → SAW API (prefix stripped)
    - `/api/dev/*` → Patch Engine (no rewrite)
  - Dev-only OpenAI proxy endpoints: `/api/ai/*`
- **SAW API (FastAPI)**: `http://127.0.0.1:5127` (default)
  - Browser calls typically go via Vite as `/api/saw/...`.
- **Patch Engine (FastAPI)**: `http://127.0.0.1:5128` (default)
  - Browser calls typically go via Vite as `/api/dev/...`.
  - Note: Patch Engine health is **not** proxied at `/api/dev/health`; use `http://127.0.0.1:5128/health` (or add a proxy rewrite if you want it same-origin).
- **Copilot CLI server (optional)**: `SAW_COPILOT_CLI_URL` (dev script usually chooses a free port ~4321–4360)

## SAW API (FastAPI, port 5127)

### Health

- `GET /health`
  - Returns a “green light” payload including:
    - `db_ok` / `db_error` (currently `SELECT 1` connectivity check)
    - `openai_enabled`
    - `copilot_available`, `copilot_ok`, and a detailed `copilot` block

When called from the browser (via Vite): `GET /api/saw/health`.

### Agent / Chat

- `POST /agent/chat?stream={0|1}&provider={copilot|openai}`
  - **JSON mode** (`stream=0`): returns a single response.
  - **SSE streaming mode** (`stream=1`): returns Server-Sent Events `event: saw.agent.event`.
  - Used for Copilot tool-approval gating and for live token deltas.

Typical SSE event `type` values:
- `session.started`
- `assistant.message_delta`
- `assistant.message`
- `permission.request`
- `session.error`
- `session.idle`

- `POST /agent/approve?provider={copilot|openai}`
  - Used by the UI to approve/deny tool calls.
  - Body: `{ conversation_id, tool_call_id, approved }`.

- `GET /agent/log?tail=200`
  - Dev-only tail of the SAW agent ndjson log.

### Database / Migrations

- `POST /db/migrate`
  - Applies migrations. Returns `{ ok, applied, already_applied }`.

- `POST /db/init`
  - Runs migrations and seeds a single `saw_meta.instance` row if missing.

### Ingest / Embeddings / Search

- `POST /ingest/index`
  - Upserts a document by `uri` into `saw_ingest.document`.

- `POST /embed/upsert`
  - Chunks `content_text`, ensures docs exist, and inserts missing embeddings into `saw_ingest.embedding`.

- `POST /search/vector`
  - Embeds the query and performs pgvector search against stored embeddings.

### Files

- `POST /files/upload_audio_wav` (multipart)
  - Uploads a `.wav` into `<saw-workspace>/.saw/uploads/` and returns a workspace-relative path.

### Audit + Patch proposal store

- `POST /audit/event`
  - Writes an audit row to `saw_ops.audit_event`. Returns `{ ok, event_id }`.

- `POST /patch/store_proposal`
  - Stores a unified diff proposal in `saw_ops.patch_proposal`.

- `POST /patch/mark_applied`
  - Marks a proposal applied (commit SHA + status/log).

### Plugins

- `GET /plugins/list`
  - Lists workspace + stock plugins with IO schemas and (for stock plugins) integrity info.

- `GET /plugins/ui/schema/{plugin_id}`
  - Returns parsed YAML schema for `ui.mode=schema` plugins.

- `GET /plugins/ui/bundle/{plugin_id}`
  - Returns JS bundle for `ui.mode=bundle` plugins, with sandbox/locked policy checks.

- `POST /plugins/fork`
  - Forks a **stock plugin** to a new workspace plugin id.

- `POST /plugins/create_from_python`
  - Creates a new plugin directory from raw python code + manifest template; optionally probes the plugin.

- `POST /plugins/execute`
  - Executes a plugin synchronously and returns `{ outputs, logs, raw_stdout, raw_stderr }`.

### Runs / Services

- `POST /api/plugins/{plugin_id}/run`
  - Spawns an async run and returns `{ run_id, status, env_key, run_dir }`.

- `GET /api/runs/{plugin_id}/{run_id}`
  - Fetches run status, outputs, and any spawned services.

- `POST /api/services/{service_id}/stop`
  - Stops a spawned service.

## Patch Engine (FastAPI, port 5128)

These endpoints power approval-gated, “safe-by-default” filesystem and git operations.

- `GET /health`
  - Returns `{ ok, repo_root, allowlist }`.

- `GET /api/dev/flags`
  - Returns feature flags: `SAW_ENABLE_PATCH_ENGINE`, `SAW_ENABLE_DB`, `SAW_ENABLE_PLUGINS`.

- `GET /api/dev/caps`
  - Reads `.saw/caps.json` (capabilities manifest).

- `POST /api/dev/caps`
  - Updates caps for a path.

- `GET /api/dev/session/log?tail=200`
  - Returns ndjson tail for `.saw/session.ndjson`.

- `GET /api/dev/tree?root=.&depth=6&max=4000`
  - Directory tree, blocked paths filtered.

- `GET /api/dev/file?path=...`
  - Read a file (subject to caps).

- `POST /api/dev/file`
  - Write a file (subject to caps).

- `POST /api/dev/safe/write`
  - Whole-file write with validation + rollback.

- `POST /api/dev/safe/delete`
  - Delete with validation + rollback.

- `POST /api/dev/safe/applyPatch`
  - Apply a unified diff patch with allowlist + caps + validation + rollback.

- `GET /api/dev/git/status?path=...`
  - Returns `git status --porcelain` and `git diff` (optionally scoped to one path).

- `POST /api/dev/git/commit`
  - Commits all changes (with exclude pathspecs) using a provided commit message.

## Vite dev-only OpenAI proxy (same-origin)

These exist only in dev when `OPENAI_API_KEY` is present in the Vite dev server environment.

- `GET /api/ai/status`
  - Returns `{ enabled, model }`.

- `POST /api/ai/plan`
  - Given `{ goal, plugins[] }`, returns a JSON plan for a plugin pipeline.

- `POST /api/ai/chat`
  - Minimal chat endpoint (no SSE) for dev.

## Health panel notes (ports + DB probes)

Recommended checks for a “health panel”:

- **SAW API**: `GET /api/saw/health` (green-light status includes DB + Copilot)
- **Patch Engine**:
  - Direct: `GET http://127.0.0.1:5128/health`
  - Or add a proxy rewrite later if you want `GET /api/dev/health`.
- **Copilot server**:
  - Prefer displaying `SAW_COPILOT_CLI_URL` + the `copilot` block from SAW API `/health`.

DB read/write:
- **Read/connectivity** is already covered by `GET /health` (`SELECT 1`).
- **Write probe** can use `POST /audit/event` with `event_type="health_probe"`.
- **Read-after-write probe** currently has no dedicated GET endpoint; if you want an explicit read-back check, add a small `GET /audit/event/{event_id}` or `POST /db/probe` endpoint later.
