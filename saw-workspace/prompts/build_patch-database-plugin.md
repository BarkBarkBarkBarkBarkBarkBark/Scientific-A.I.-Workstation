Here’s an **ideal “paste-into-Cursor” prompt** that’s optimized for **keeping the current library working** while adding the 3 MVP features. It’s written to force *small, safe, reversible* changes, and to avoid refactors.

---

## Cursor YOLO Prompt (safe + incremental)

You are a senior engineer working inside an existing repo. **Top priority is preserving current functionality**. You must implement **only the minimal viable code** for:

1. **Standardized patch procedure** (agent proposes unified diffs; UI shows diff like VS Code/Cursor; user approves; safe apply + rollback)
2. **Local database service** (Postgres + pgvector) with a small API service over a port that can ingest documents and store OpenAI embeddings
3. **Standardized plugin architecture** (plugin.yaml + wrapper.py contract; registry; uv-based env install; executor)

### Non-negotiable constraints

* **Do not break existing app behavior.** Prefer additive changes and feature flags.
* **No “big refactors.”** If you feel tempted, stop and do the smallest integration adapter.
* **All writes happen via explicit patch review.** No silent file writes.
* **Git is the source of truth.** Every apply is a commit; rollback is easy.
* **Keep MVP minimal:** build the thin “spine,” not a full platform.

---

# Step 0 — Repo reconnaissance (required before coding)

1. Search the repo for any existing implementations or partial work:

   * patch/apply, unified diff, git apply, monaco diff editor
   * postgres/pgvector, migrations, embedding, ingest, OpenAI calls
   * plugin loader/registry, manifests, uv/venv management
2. If something exists, **reuse it**. Do not duplicate systems.
3. Identify the current frontend framework + existing state/store patterns; follow them.

Deliver a short note in comments about what you found and what you’re reusing.

---

# Step 1 — Patch Engine (MVP)

## Goal

The agent outputs a **PatchProposal** containing **per-file unified diffs**. The UI shows a diff viewer like VS Code/Cursor. The user can **Accept/Reject**. On accept, the system:

* validates scope (workspace vs shell)
* dry-runs apply (`git apply --check`)
* applies in a safe way (temp branch or working tree + commit)
* runs minimal validations
* commits + tags “known-good”
* rolls back automatically on any failure

## Deliverables

### A) Types + schema

Create a simple PatchProposal schema (JSON schema or TS type + runtime validation) with fields:

* id, summary, rationale
* scope: domain (“workspace” | “shell_app”), editable_mode_required, allowlist_paths
* files: [{path, diff, optional base_hash}]
* validation_steps: string[]
* risk: low|medium|high

### B) Backend apply endpoint

Add an internal backend endpoint that accepts PatchProposal and performs:

* path allowlist/denylist checks
* editable-mode check for workspace changes
* `git apply --check` then apply
* commit changes
* if any step fails: `git reset --hard` back to last known good (or revert commit)
* record audit event to DB (if DB online; otherwise log to local file)

Implementation guidance:

* Use **simple child_process calls** to git (or existing utilities).
* Keep code small and explicit.
* Do NOT attempt “fuzzy patching” if apply fails; instead request fresh context.

### C) Frontend diff review UI

Add a patch review modal with:

* file list
* per-file Monaco diff view (or existing diff component if already present)
* summary + rationale + validation results area
* buttons: Accept Apply / Reject / Copy Diff

Important: integrate without disrupting existing UI. If there’s no agent chat UI yet, create the smallest component that can be invoked from a dev/test route.

### D) Minimal validations

* If plugin manifests changed: validate plugin.yaml schema + wrapper import smoke test
* If shell/TS changed: run existing build command (or smallest “tsc -p” equivalent)

---

# Step 2 — Database service (Postgres + pgvector + embeddings) (MVP)

## Goal

A local DB service persists independently of the frontend. Expose:

* Postgres on a port (localhost only)
* A small API service (localhost only) that the frontend can call
* Document ingest + OpenAI embedding + vector search

## Deliverables

### A) Docker compose (or native runner)

If the repo already uses docker compose, extend it; otherwise add minimal:

* postgres image
* enable pgvector extension (init script)
* bind to `127.0.0.1:<port>` (pick a default like 54329 but keep configurable via env)

### B) API service

Implement a minimal service in the repo’s existing backend language (prefer what already exists; if none, use Python FastAPI or Node Express—choose whatever matches current tooling best).

Endpoints (MVP):

* GET /health
* POST /db/migrate
* POST /ingest/index      (store raw doc + metadata)
* POST /embed/upsert      (chunk -> embed -> store doc+vector idempotently)
* POST /search/vector     (embedding query -> topK)
* POST /audit/event       (record actions)
* POST /patch/store_proposal
* POST /patch/mark_applied

### C) Schema + migrations

Minimal tables:

* document(doc_id, uri unique, doc_type, content_hash, content_text, metadata_json, created_at)
* embedding(doc_id fk, model, dims, embedding vector, created_at)
* audit_event(event_id, at, actor, event_type, details_json)
* patch_proposal(proposal_id, created_at, author, diff_unified, target_paths, validation_status, validation_log, applied_commit)

### D) Embeddings

Use OpenAI embeddings with:

* env var OPENAI_API_KEY
* env var SAW_EMBED_MODEL default “text-embedding-3-small” (or repo default if already set)
* chunking: ~4000 chars with overlap ~300
* idempotency: content_hash + model

No fancy ingest pipeline; just enough to prove it works.

### E) DB discovery for “connect to DB plugin”

Implement discovery logic in the API service and/or plugin:

1. read `.saw/runtime/db.json`
2. env SAW_DB_URL
3. try localhost default port
4. optionally scan *localhost only* allowlist ports (5432, 54329, 55432)
   Verify by checking for a known table.

---

# Step 3 — Plugin architecture (MVP)

## Goal

Plugins live under workspace/plugins/** and are defined by:

* `plugin.yaml` (metadata + IO schema + deps + policies)
* `wrapper.py` (imports the real library and exposes `main(inputs, params, context)`)

## Deliverables

### A) plugin.yaml schema + validator

Define a strict schema with required fields:

* id, name, version, description
* entrypoint: {file, callable}
* environment: {python, pip[], optional lockfile}
* inputs: map of input specs
* params: map of param specs (+ defaults, ui hints)
* outputs: map of output specs
* execution: deterministic/cacheable flags
* side_effects: network/disk/subprocess policies
* resources: gpu + threads

### B) Registry + loader

Implement:

* scan workspace/plugins/**/plugin.yaml
* validate schema
* ensure entrypoint file exists
* load wrapper module safely
* resolve callable

### C) uv env manager (minimal)

Implement an environment cache:

* env_id = hash(python constraint + deps + lockfile contents)
* create venv at workspace/.saw/plugin_store/envs/<env_id>
* install deps with uv (or pip if uv not available, but prefer uv)
* do not install during plugin execution; install at “register/prepare” time

### D) Executor

* validate inputs/params against manifest
* enforce side_effects defaults (deny network unless explicitly allowed)
* call wrapper.main
* validate outputs against manifest
* emit audit events

---

# Integration strategy (keep app working)

* Put new features behind flags:

  * SAW_ENABLE_PATCH_ENGINE
  * SAW_ENABLE_DB
  * SAW_ENABLE_PLUGINS
* Default flags OFF unless in dev mode.
* Add **smoke tests**:

  1. start db + api, run migration
  2. ingest a sample doc, embed, vector search returns results
  3. register a sample plugin and execute it
  4. generate a PatchProposal against a test file, show diff UI, apply and rollback works

---

# Implementation rules

* Prefer **small PR-like commits** even if you’re working locally.
* Do not change existing public APIs unless absolutely required.
* If you must touch existing code paths, add tests around them first.

---

# Definition of Done

* Existing app runs exactly as before with flags OFF.
* With flags ON:

  * Patch review modal shows unified diff; apply works; rollback works.
  * DB starts on localhost, API responds, embeddings stored, vector search works.
  * Plugin registry loads plugin.yaml + wrapper.py and executes a demo plugin.
* Minimal docs added: a README section “How to run DB / Patch Engine / Plugins”.

Now implement this MVP in the repo. Start by scanning what already exists and reuse components wherever possible.
