# SAW (Scientific A.I. Workstation) — Study Checklist

Use this as a “physical notes” guide: print it, check things off, and annotate as you read code.

---

### 0) Get oriented (what runs)

- [ ] **Frontend UI**: Vite + React + TS (browser app)
- [ ] **Patch Engine**: FastAPI service for safe file ops + safe patch apply (wraps `git apply`)
- [ ] **SAW API**: FastAPI service for DB, embeddings, plugins, runs, audit
- [ ] **Postgres**: `pgvector/pgvector` container for persistence

---

### 1) Ports + routes (memorize)

- [ ] **Frontend**: `127.0.0.1:5173`
- [ ] **SAW API**: `127.0.0.1:5127`
- [ ] **Patch Engine**: `127.0.0.1:5128`
- [ ] **Postgres**: `127.0.0.1:54329` (docker maps to container `5432`)
- [ ] **Plugin spawned services**: dynamic `49152–65535` (allocated per run)

**Frontend proxy routes (same-origin):**
- [ ] `/api/saw/*` → SAW API (proxy + rewrite)
- [ ] `/api/dev/*` → Patch Engine

---

### 2) “First read” file order (fastest comprehension)

**Specs (intent + invariants):**
- [ ] `saw-workspace/machine-specs/SAW_MR_HARMONIZED_MIN_v0.1.yaml`

**Bring up dev stack (what starts, env vars, ports):**
- [ ] `scripts/dev_all.sh`
- [ ] `docker-compose.yml`

**Frontend proxy + safety middleware (how API calls are routed):**
- [ ] `vite.config.ts` (proxy config + dev endpoints)

**Patch Engine (safe apply + rollback + caps):**
- [ ] `services/patch_engine/app/main.py`
- [ ] `.saw/caps.json` (runtime permissions)
- [ ] `.saw/recovery.json` and `.saw/session.ndjson` (crash recovery + event logs)

**SAW API (endpoints + DB + embeddings + plugins + runs/services):**
- [ ] `services/saw_api/app/main.py`
- [ ] `services/saw_api/app/settings.py`
- [ ] `services/saw_api/app/db.py`
- [ ] `services/saw_api/app/migrations.py` + `services/saw_api/migrations/*.sql`
- [ ] `services/saw_api/app/embeddings.py`
- [ ] `services/saw_api/app/plugins_runtime.py`
- [ ] `services/saw_api/app/run_manager.py`
- [ ] `services/saw_api/app/service_manager.py`

**Plugins (manifest + wrapper contract):**
- [ ] `saw-workspace/plugins/**/plugin.yaml`
- [ ] `saw-workspace/plugins/**/wrapper.py`

---

### 3) Key libraries (know what to google)

**Frontend**
- [ ] `vite`, `react`, `typescript`
- [ ] `reactflow` (node graph UI)
- [ ] `zustand` (state)
- [ ] `@monaco-editor/react` (diff/editor UI)
- [ ] `tailwindcss` (styling)

**Backend**
- [ ] `fastapi`, `uvicorn`
- [ ] `pydantic` (request/response models)
- [ ] `psycopg` (Postgres driver)
- [ ] `pgvector` (vector column + distance operator)
- [ ] `openai` (embeddings)
- [ ] `PyYAML` (plugin manifests)

---

### 4) Processes to understand (high leverage)

**A) Frontend → backend call path**
- [ ] Find where UI calls `/api/saw/*` and `/api/dev/*`
- [ ] Trace: UI → Vite proxy → SAW API / Patch Engine → response → UI state

**B) Patch Engine “safe apply”**
- [ ] Caps gate: read/write/delete rules in `.saw/caps.json`
- [ ] Allowlist gate: env `SAW_PATCH_APPLY_ALLOWLIST`
- [ ] Git flow: `git apply --check` → `git apply`
- [ ] Validation: sometimes runs `npm run build` (auto/strict)
- [ ] Rollback: `git reset --hard <preHead>` on failure + recovery on startup

**C) DB boot + migrations**
- [ ] Docker starts Postgres + init SQL in `services/db/init/*`
- [ ] SAW API can run migrations (`/db/migrate` and `/db/init`)
- [ ] Learn table purposes:
  - `saw_meta.instance`
  - `saw_ingest.document`
  - `saw_ingest.embedding`
  - `saw_ops.audit_event`
  - `saw_ops.patch_proposal`
  - `saw_runs`, `saw_services`

**D) Embeddings + vector search**
- [ ] Chunking: `max_chars=4000`, overlap `300`
- [ ] Idempotency: “skip if already embedded”
- [ ] Query path: embed query → `pgvector` distance query → top-k docs

**E) Plugin lifecycle**
- [ ] Discovery: scan `saw-workspace/plugins/**/plugin.yaml`
- [ ] Validation: manifest schema + entrypoint exists
- [ ] Execution:
  - Sync: `/plugins/execute`
  - Async: `/api/plugins/{plugin_id}/run` → poll `/api/runs/{plugin_id}/{run_id}`
- [ ] Service lifecycle: services spawned by plugins tracked + stoppable via `/api/services/{service_id}/stop`

---

### 5) Practical “debug drills” (do these once)

- [ ] Hit health endpoints in browser:
  - [ ] `http://127.0.0.1:5173/api/saw/health`
  - [ ] `http://127.0.0.1:5173/api/dev/health`
- [ ] Open `.saw/session.ndjson` while using UI; identify events for:
  - [ ] `safe.patch.start` / `safe.patch.ok` / rollback events
  - [ ] subprocess logs (`proc.start` / `proc.end`)
- [ ] Run one plugin end-to-end:
  - [ ] list plugins → execute → run async → poll status → inspect run dir under `.saw/runs/...`

---

### 6) Environment variables (note these)

- [ ] `FRONTEND_PORT` (default 5173)
- [ ] `API_HOST`, `API_PORT` (default 127.0.0.1:5127)
- [ ] `PATCH_ENGINE_HOST`, `PATCH_ENGINE_PORT` (default 127.0.0.1:5128)
- [ ] `SAW_API_URL` (frontend proxy target)
- [ ] `SAW_PATCH_ENGINE_URL` (frontend proxy target)
- [ ] `SAW_ENABLE_DB`, `SAW_ENABLE_PLUGINS`
- [ ] `SAW_PATCH_APPLY_ALLOWLIST` (dev-only broadening of patch targets)
- [ ] `OPENAI_API_KEY`, `OPENAI_MODEL`


