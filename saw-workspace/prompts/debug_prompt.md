You are helping debug SAW (Scientific AI Workstation) dev runtime instability.

GOAL
- Stop the GUI (Vite) from restarting/reloading unexpectedly during patch apply/commit.
- Produce robust “zero hidden processes” logs: every HTTP request and every subprocess (git/npm) with exit code, stderr/stdout (trimmed), duration, and correlation IDs.

CURRENT ARCH
- Frontend: Vite + React (port: 7177)
- SAW API: FastAPI/uvicorn (port: 5127)
- Patch Engine: FastAPI/uvicorn (port: 5128)
- Vite proxies:
  - /api/dev/* -> Patch Engine (5128)
  - /api/saw/* -> SAW API (5127)
  - /api/ai/* -> OpenAI proxy inside Vite
- Patch Engine applies diffs via git apply --check/apply and writes `.saw/session.ndjson` + recovery.

WHAT’S BROKEN
- GUI still restarts/reloads during patch operations.
- Patch apply sometimes triggers Patch Engine “recovery.rollback” events (service reload mid-flight).
- Want better logs that show exactly which subprocess failed.

WHAT WE’VE CHANGED ALREADY
- Patch Engine moved out of Vite into `services/patch_engine/app/main.py`.
- Vite now only proxies /api/dev/* to Patch Engine.
- Patch Engine logging:
  - logs every HTTP request (`type: http`)
  - logs every subprocess end (`type: proc.end`) with cmd/cwd/rc/duration/stdout/stderr (trimmed)
- Patch Engine safety changes:
  - removed `git clean -fd` from rollback
  - removed `git stash push -u` (don’t stash untracked)
  - added `git apply --recount`
  - strips `index ...` lines in incoming diffs
  - best-effort new-file normalization
- Vite logs OpenAI requests into `.saw/session.ndjson` (`type: openai.chat_completions`).
- `scripts/dev_all.sh` should start Postgres + SAW API + Patch Engine + Vite, with Vite `--strictPort`.
- We tried to limit uvicorn reload scope with `--reload-dir services/saw_api` and `--reload-dir services/patch_engine`.

EVIDENCE (IMPORTANT)
- `.saw/session.ndjson` shows patterns like:
  - `safe.patch.start` then (sometimes) `recovery.rollback` near the same time → indicates service reload/restart mid-flight.
  - `openai.chat_completions` entries are now present.
- Vite console showed frequent `vite.config.ts changed, restarting server...`
- Patch Engine previously crashed due to `@app.middleware` placement (fixed).

REQUEST
1) Identify why the GUI (Vite) still restarts:
   - Is it Vite config changes, file watchers, or patch engine writing something under watched paths?
   - Confirm whether Vite is restarting due to `vite.config.ts` HMR or due to server port conflicts.
   - Ensure patch apply does NOT modify `vite.config.ts` or any watched config.
2) Identify why Patch Engine still does recovery rollbacks:
   - Check if uvicorn reload is still watching too broadly (e.g. repo root).
   - Ensure patch applies do not touch patch_engine code, `.venv`, or other watched dirs.
3) Make logs “forensic-grade”:
   - Add correlation id per request (`req_id`) and include it in all `http` and `proc.end` events.
   - Include subprocess start events (`proc.start`) and the temp patch file path, plus the exact git args.
   - Include `git rev-parse HEAD` before/after apply/check/rollback into logs.
   - Persist logs in a single DB table (or reuse `saw_ops.audit_event`) with schema: ts, service, req_id, type, payload_json.
4) Suggest a minimal set of code changes to stop restarts and improve logging, without bloating.

FILES TO READ FIRST (authoritative)
- scripts/dev_all.sh
- services/patch_engine/app/main.py
- vite.config.ts
- src/store/useSawStore.ts (chat/todo local handling + attachments)
- .saw/session.ndjson (tail 200)
- Any terminal output showing Vite restart reasons

DELIVERABLE
- A small patch that:
  - prevents unwanted restarts (strictPort already; fix watcher triggers)
  - adds request/subprocess correlation logging
  - optionally adds DB-backed unified log table or uses existing audit table

Constraints
- Prefer minimal changes.
- Don’t break the current UX: “Apply patch” and “Apply + Commit” should work.
- Don’t delete user workspace content.