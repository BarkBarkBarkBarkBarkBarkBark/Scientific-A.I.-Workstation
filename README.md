# Scientific AI Workstation (SAW) — Frontend MVP

Desktop-style UI (Ableton-for-science vibe) to assemble pipelines from plugins, inspect nodes, and use AI-assisted debugging/editing.

**What this is:** a local-first dev environment (frontend + API + Patch Engine) where an agent can propose file changes, and you explicitly approve any writes.

**What this is not:** a hosted SaaS or a production-hardened runtime (yet). This repo is intentionally “safe-by-default” for local experimentation.

## Architecture (what talks to what)

The “agent can edit files” because the UI talks to a **tool-calling agent** (SAW API), which proxies safe filesystem operations through the **Patch Engine**.

```mermaid
flowchart LR
  UI[Frontend_UI] -->|"POST /api/saw/agent/chat"| SAWAPI[SAW_API_agent]
  UI -->|"POST /api/saw/agent/approve"| SAWAPI
  SAWAPI -->|"HTTP /api/dev/file"| PatchEngine[Patch_Engine]
  SAWAPI -->|"HTTP /api/dev/safe/write"| PatchEngine
  SAWAPI -->|"HTTP /api/dev/safe/applyPatch"| PatchEngine
  PatchEngine --> FS[Repo_filesystem]
```

### Editing model (why it is safe-by-default)

- **Approvals**: any write operation is surfaced in the UI as “Approval required”.
- **Caps**: Patch Engine enforces read/write/delete capabilities from `.saw/caps.json`.
- **Safe operations**:
  - `safe_write`: replace a whole file (great for `saw-workspace/todo.md`)
  - `applyPatch`: apply unified diffs (for multi-file edits)
  - both can run validation and auto-rollback on failure (Patch Engine feature)
- **Workspace sandbox**: `saw-workspace/` is the intended “agent-writable” area. `todo.md` lives there.

In practice this means:
- The agent can *read* most repo files.
- The agent can only *write* paths you’ve allowed via Patch Engine caps, and each write is gated by an approval in the UI.

### Key code paths

- **Frontend**
  - `src/ai/client.ts`: calls `/api/saw/agent/chat` + `/api/saw/agent/approve`
  - `src/store/useSawStore.ts`: UI state + “Approve + run” wiring
  - `src/components/TodoPanel.tsx`: reads (and will edit) the todo markdown
- **SAW API (agent + tool loop)**: `services/saw_api/app/agent.py` (will be refactored into a package)
- **Patch Engine (safe file ops + caps)**: `services/patch_engine/app/main.py`
- **Workspace docs**
  - `saw-workspace/todo.md`: human + agent task tracking
  - `saw-workspace/agent/agent_workspace.md`: agent scratchpad (planning/notes)

## Run

### Prerequisites

- Node.js (recommended: current LTS)
- Python 3.11+ (for the SAW API)
- Docker (for Postgres + pgvector if you enable DB features)

If you don’t need the DB, you can still run the frontend + API without Docker.

Create a `.env` file in the project root:

```bash
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o-mini"  # or another supported model
```

```bash
cd "/Scientific-AI-Workstation"
npm install
npm run dev
```

### Default local URLs

- Frontend (Vite): `http://127.0.0.1:5173/` (unless you override the port)
- SAW API (uvicorn): `http://127.0.0.1:5127/` (in the recommended script below)
- Postgres (docker compose): `127.0.0.1:54329`

## Package Index

### Initial Install

### One command (recommended)

Starts: Postgres (pgvector) + SAW API + frontend.

**Linux/macOS:**
```bash
./scripts/dev_all_mac.sh --frontend-port 7176 --api-port 5127
```

Then open: `http://127.0.0.1:7176/`

**Windows (PowerShell):**
```powershell
.\scripts\dev_all_windows.ps1 -FrontendPort 7176 -ApiPort 5127
```

### Manual (3 terminals)

```bash
docker compose up -d
```

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r services/saw_api/requirements.txt
python -m uvicorn services.saw_api.app.main:app --host 127.0.0.1 --port 5127 --reload
```

```bash
# Optional
export SAW_ENABLE_DB=1
export SAW_ENABLE_PLUGINS=1
npm run dev
```

If you run the API on a non-default port, make sure the frontend proxy (see `vite.config.ts`) points at the same port.



### Scripts

```bash
npm run dev
npm run build
npm run preview
```

### Key Dependencies

- **React + TypeScript + Vite**
- **Tailwind CSS** (dark DAW theme)
- **Zustand** (single store for app state)
- **React Flow** (Graph layout)
- **Monaco Editor** (code editor + developer panel)

### Project Structure

- `src/components/`
  - `PluginBrowser.tsx`: left plugin list (drag source)
  - `PipelineBuilder.tsx`: Pipeline layout (drop zones + reorder + remove)
  - `NodeCanvas.tsx`: Graph layout (React Flow)
  - `Inspector.tsx`: node inspector + audio waveform UI
  - `BottomPanel.tsx`: Logs / Errors / AI / Dev tabs
- `src/store/useSawStore.ts`: Zustand store (nodes/edges/selection/layout/logs/AI/audio runtime)
- `src/ai/planFallback.ts`: local heuristic plan fallback (used when AI endpoints are unavailable)
- `src/ai/client.ts`: frontend calls to dev-server AI proxy
- `src/audio/webaudio.ts`: decode MP3 + lowpass render (Web Audio)
- `vite.config.ts`: Vite dev-server proxy for OpenAI

## Database (local Postgres + pgvector)

- **Postgres port**: `127.0.0.1:54329` (docker compose)
- **SAW API**: `127.0.0.1:5127` (uvicorn)
- **Default URLs** (SAW API reads `.env` if present):
  - `SAW_DB_URL=postgresql://saw_app:saw_app@127.0.0.1:54329/saw`
  - `SAW_DB_ADMIN_URL=postgresql://saw_admin:saw_admin@127.0.0.1:54329/saw`

After SAW API starts it writes local connection info (gitignored):

- `.saw/runtime/db.json`

Initialize schema + seed instance row:

```bash
curl -X POST http://127.0.0.1:5127/db/init
```

## Workspace Plugins (real runtime)

Workspace plugins live under:

- `saw-workspace/plugins/**/plugin.yaml`
- `saw-workspace/plugins/**/wrapper.py`

Minimal `plugin.yaml`:

```yaml
id: "saw.example.plugin"
name: "Example Plugin"
version: "0.1.0"
description: "What it does."
entrypoint: { file: "wrapper.py", callable: "main" }
environment: { python: ">=3.11,<3.13" }
inputs: { x: { type: "text" } }
params: { k: { type: "number", default: 1 } }
outputs: { y: { type: "text" } }
execution: { deterministic: true, cacheable: true }
side_effects: { network: "none", disk: "read_only", subprocess: "forbidden" }
resources: { gpu: "forbidden", threads: 1 }
```

Wrapper contract (`wrapper.py`):

```python
def main(inputs: dict, params: dict, context) -> dict:
  # inputs/outputs values are {data, metadata}
  return {"y": {"data": "ok", "metadata": {}}}
```

### Creating a new plugin (two paths)

1) **Via the SAW API helper (recommended for quick iteration):**

- POST `http://127.0.0.1:5127/plugins/create_from_python`
- This endpoint generates:
  - `saw-workspace/plugins/<plugin_id>/plugin.yaml`
  - `saw-workspace/plugins/<plugin_id>/wrapper.py`

2) **Via the agent tool loop (approval-gated):**

- The agent will request approval to write the same files.
- This is useful when you want the agent to scaffold/refactor the plugin while keeping every write explicitly approved.

## Core UX

### Layout Modes

Top bar → **Layout**
- **Pipeline**: list/rows, super reliable drag/drop (drop zones), supports **reorder** + **remove**
- **Graph**: freeform React Flow canvas

### Delete / Remove Steps

- **Pipeline**: click **Remove** on a step
- **Keyboard**: select a step/node then press **Delete** or **Backspace**

### Audio Lowpass Plugin (real)

Plugin: **Audio Lowpass**
- upload MP3
- adjust cutoff slider
- view original/filtered waveform
- play original/filtered (WebAudio)

## OpenAI (optional, local dev)

The browser calls a local dev proxy (`/api/ai/*`) so the API key is **not exposed to the frontend bundle**.

See `ENV_SETUP.md`.

## Troubleshooting

- **`npm run build` fails with “Merge conflict marker encountered”**
  - One or more files still contain `<<<<<<<` / `=======` / `>>>>>>>` markers.
  - Fix those conflicts, then rerun `npm run build`.

- **Copilot provider “stalls” / no response (TLS issuer certificate)**
  - Symptom: the chat shows “Thinking…” and the API SSE stream only emits `session.started` + keepalives.
  - Check Copilot CLI logs:
    ```bash
    bash scripts/copilot_cli_diag.sh
    ```
  - If you see: `unable to get issuer certificate`, it’s a TLS trust issue (often corporate SSL interception).
    SAW defaults to starting Copilot with `NODE_OPTIONS=--use-system-ca`, but some environments still need an explicit CA bundle.
  - Generate a PEM bundle from macOS keychains:
    ```bash
    bash scripts/export_macos_keychain_certs_pem.sh
    ```
  - Export it for SAW before starting the services:
    ```bash
    export SAW_COPILOT_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/macos-keychain.pem"
    ```
  - Restart the SAW API (and therefore the Copilot CLI subprocess).
    If you’re using the one-command runner:
    ```bash
    ./scripts/dev_all_mac.sh --frontend-port 7176 --api-port 5127
    ```

- **Agent says “Approval required” and nothing happens**
  - That’s expected: approve the tool call in the UI.
  - If approval succeeds but the write still fails, check Patch Engine caps (`.saw/caps.json`).

- **Plugin creation fails with “directory not found”**
  - The plugin folder must exist (or the writer must create it). Newer Patch Engine writes create parent dirs automatically; if you’re on an older version, update/restart services.

