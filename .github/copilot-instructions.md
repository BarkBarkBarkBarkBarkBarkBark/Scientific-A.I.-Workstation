# Scientific AI Workstation (SAW) — Copilot Instructions

## Big picture (what talks to what)
- Local-first “safe-by-default” dev stack: **Frontend (Vite/React)** → **SAW API (FastAPI agent + plugins)** → **Patch Engine (FastAPI safe FS ops)** → repo filesystem.
- The browser never sees secrets: `OPENAI_API_KEY` is read by the **Vite dev server** and used in dev-only proxy endpoints (see `vite.config.ts`).
- HTTP routing in dev:
  - `/api/ai/*` → Vite dev proxy (OpenAI + local fallbacks)
  - `/api/saw/*` → SAW API (see `services/saw_api/app/main.py`)
  - `/api/dev/*` → Patch Engine (see `services/patch_engine/app/main.py`)

## Critical workflows
- Recommended “one command” dev (macOS): `./scripts/dev_all_mac.sh --frontend-port 7176 --api-port 5127`
  - Starts Postgres via `docker compose` (if Docker is present)
  - Creates/uses `.venv`, installs `services/saw_api/requirements.txt` + `services/patch_engine/requirements.txt`
  - Runs `uvicorn` for SAW API (default `127.0.0.1:5127`) and Patch Engine (default `127.0.0.1:5128`)
  - Starts Vite on the chosen frontend port
- Manual run (3 terminals) is documented in `README.md`.
- Python note: SAW API expects Python `>=3.11` and currently **<=3.13** (see `services/saw_api/README.md`).

## Safety model (agent writes)
- Treat writes as approval-gated operations. Patch Engine enforces capabilities via `.saw/caps.json` and blocks sensitive paths (`.env`, `.git`, `node_modules/`, `dist/`).
- Default intended agent-writable area: `saw-workspace/` (e.g. `saw-workspace/todo.md`, `saw-workspace/agent/agent_workspace.md`).
- File ops style:
  - Use `POST /api/dev/safe/write` for whole-file replacements (see `src/components/TodoPanel.tsx`).
  - Use `POST /api/dev/safe/applyPatch` for multi-file diffs (Patch Engine can optionally validate and recover).
- Stock plugin protection: writes under `saw-workspace/plugins/<plugin_id>/…` may be blocked when `<plugin_id>` matches a “stock” plugin in `services/saw_api/app/stock_plugins/` unless `SAW_ALLOW_WRITE_LOCKED_PLUGINS=1`.

## Where to change things (source of truth)
- App state + core actions live in `src/store/useSawStore.ts` (Zustand): planning, chat approval flow, patch review/apply, dev caps/grants.
- Agent loop client calls:
  - `src/ai/client.ts` → `/api/saw/agent/chat` and `/api/saw/agent/approve`
- Backend entrypoints:
  - SAW API: `services/saw_api/app/main.py`
  - Patch Engine: `services/patch_engine/app/main.py`

## Workspace plugins (runtime contract)
- Workspace plugins live under `saw-workspace/plugins/**/plugin.yaml` + `wrapper.py`.
- Wrapper callable shape: `main(inputs: dict, params: dict, context) -> dict` (values are `{data, metadata}` objects; return the same shape).
