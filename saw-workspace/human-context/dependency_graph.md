# SAW Repo Dependency Graph — Usage Guide

## Where does the tool live?

- **Backend location:**
  - All core logic and analyzers are implemented in:
    - `services/saw_api/app/repo_intel/` (Python FastAPI backend)
    - `tools/repo_intel/depcruise_graph.mjs` (TypeScript/JS analyzer, uses dependency-cruiser)
  - Postgres schema: see `services/saw_api/migrations/003_repo_intel.sql`

## How to create a repo graph (static scan)

1. **Register the repo:**
   - POST `/repo-intel/repos/register` with `{ "name": "MyRepo", "root_path": "/absolute/path/to/repo" }`
   - Response: `{ "repo_id": "..." }`

2. **Start a scan:**
   - POST `/repo-intel/scans/start` with `{ "repo_id": "...", "scan_type": "static_scan" }`
   - Response: `{ "scan_id": "...", "status": "running" }`

3. **Check scan status:**
   - GET `/repo-intel/scans/{scan_id}`
   - Response: `{ "scan": { ... }, "progress": { ... } }`
   - Wait for status to be `ok` or `partial`.

## How to view the repo graph and evidence

- **Graph (nodes + edges):**
  - GET `/repo-intel/graph?repo_id=...&scan_id=...`
  - Optional query params: `scope_prefix`, `include_tests`
  - Returns: `{ nodes: [...], edges: [...] }`

- **Runtime evidence summary:**
  - GET `/repo-intel/evidence/summary?repo_id=...`
  - Returns: `{ file_hotness: [...], cold_files: [...] }`

- **Recommendations (dead code, cycles, etc):**
  - GET `/repo-intel/recommendations?repo_id=...&scan_id=...`
  - Returns: `{ recommendations: [...] }`

- **Patch proposal (diff only, no writes):**
  - POST `/repo-intel/recommendations/propose_patch` with `{ repo_id, scan_id, rec_id, action }`
  - Returns: `{ patch_unified_diff: "..." }`

## Notes
- All analyzer execution is isolated (subprocess, no in-process import).
- TypeScript/JS import graph uses dependency-cruiser (see devDependencies).
- Python import graph uses AST parsing (first-party only).
- Runtime evidence (coverage, cProfile) is supported for Python entrypoints.
- All endpoints are available on the running SAW API (default: `http://127.0.0.1:5127`).
