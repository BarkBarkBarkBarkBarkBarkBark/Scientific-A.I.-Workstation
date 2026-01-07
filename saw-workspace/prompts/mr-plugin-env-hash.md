mr\_spec\_version: "1.0"  
name: "SAW Plugin Runner: env hashing \+ venv cache \+ run/service directories"  
priority: "P0"  
target\_repo: "Scientific-A.I.-Workstation"  
timezone: "America/Los\_Angeles"

goals:  
  \- "Implement deterministic environment hashing (env\_key) for plugin dependencies and platform."  
  \- "Create and manage a central uv venv cache at .saw/venvs/\<env\_key\>/."  
  \- "Standardize always-present workspace directories under .saw/ (runs, services, logs, env manifests)."  
  \- "Run plugins out-of-process using the venv's python and a stable wrapper entrypoint."  
  \- "Support long-running plugin-launched services (e.g., SIGUI web GUI) with PID+port tracking and crash recovery."  
  \- "Persist run metadata in Postgres (existing pgvector container) with minimal new tables."

non\_goals:  
  \- "Container/VM sandboxing enforcement (Docker/Firejail) in this iteration."  
  \- "Hard OS-level network blocking; only policy validation/logging in MVP."  
  \- "Multi-Python-version management (assume one Python major.minor for MVP)."

assumptions:  
  \- "Backend service exists (saw\_api) and can run subprocesses."  
  \- "uv is available on PATH in the backend runtime."  
  \- "Plugins exist under plugins/\<plugin\_id\>/ with plugin.yaml \+ wrapper.py \+ optional lockfile."  
  \- "Postgres is reachable via env config; migrations can be applied."

repo\_conventions:  
  plugin\_root: "plugins"  
  plugin\_manifest\_name: "plugin.yaml"  
  plugin\_wrapper\_name: "wrapper.py"  
  saw\_root: ".saw"

always\_present\_directories:  
  \- ".saw/venvs"  
  \- ".saw/runs"  
  \- ".saw/services"  
  \- ".saw/env/manifests"  
  \- ".saw/logs"

plugin\_manifest\_contract:  
  required\_fields:  
    \- "id"  
    \- "name"  
    \- "version"  
    \- "entrypoint.file"  
    \- "entrypoint.callable"  
    \- "environment.python"  
  optional\_fields:  
    \- "environment.lockfile"  
    \- "environment.requirements"  
    \- "environment.pip"  
    \- "inputs"  
    \- "params"  
    \- "outputs"  
    \- "services"  
    \- "side\_effects"  
  notes:  
    \- "Prefer lockfile if present (uv.lock or requirements.lock)."  
    \- "If no lockfile: materialize a normalized requirements representation for hashing."

env\_hashing:  
  objective: "Compute env\_key \= stable hash of platform \+ python \+ dependency lock content."  
  inputs:  
    python\_major\_minor: "string like '3.11'"  
    platform\_tag: "sys.platform \+ '-' \+ platform.machine() (e.g., 'linux-x86\_64', 'darwin-arm64', 'win32-AMD64')"  
    deps\_source\_precedence:  
      \- "plugin manifest environment.lockfile (path relative to plugin root)"  
      \- "file exists at plugins/\<id\>/uv.lock"  
      \- "file exists at plugins/\<id\>/requirements.lock"  
      \- "plugin manifest environment.requirements (path relative to plugin root)"  
      \- "plugin manifest environment.pip (list of requirement strings)"  
  canonical\_payload\_json:  
    keys:  
      \- "python"  
      \- "platform"  
      \- "deps\_sha256"  
      \- "extras"  
    rules:  
      \- "JSON stringify with sorted keys and separators=(',', ':')"  
      \- "deps\_sha256 computed from bytes of lock/requirements content"  
      \- "extras is a dict; include 'cuda'='none' for MVP"  
  env\_key\_format:  
    algo: "sha256(canonical\_payload\_json)"  
    output: "first\_16\_hex\_chars"  
  artifacts:  
    \- path: ".saw/env/manifests/\<env\_key\>.json"  
      content: "the canonical payload plus resolved dependency source info (paths, sha256, timestamps)"

venv\_cache:  
  venv\_root: ".saw/venvs"  
  venv\_path: ".saw/venvs/\<env\_key\>"  
  python\_path\_resolution:  
    linux\_darwin: ".saw/venvs/\<env\_key\>/bin/python"  
    windows: ".saw/venvs/\<env\_key\>/Scripts/python.exe"  
  ensure\_env\_algorithm:  
    \- "If venv\_path exists and python is runnable \-\> reuse"  
    \- "Else create venv with: uv venv \<venv\_path\>"  
    \- "Then install deps:"  
    \- "  If lockfile is uv.lock and plugin has pyproject: prefer uv sync (or uv pip sync per available commands)."  
    \- "  Else if requirements(.lock/.txt): uv pip install \-r \<requirements\_file\>"  
    \- "Record install output to .saw/logs/env\_\<env\_key\>.log"  
  garbage\_collection\_mvp:  
    \- "Not required, but write TODO hooks and metadata fields (last\_used\_at)."

run\_management:  
  run\_dir\_layout:  
    base: ".saw/runs/\<plugin\_id\>/\<run\_id\>"  
    children:  
      \- "input"  
      \- "work"  
      \- "output"  
      \- "logs"  
  run\_id\_generation:  
    format: "\<UTC\_ISO8601\_compact\>\_\<8char\_random\_hex\>"  
  run\_json:  
    path: ".saw/runs/\<plugin\_id\>/\<run\_id\>/run.json"  
    fields:  
      \- "plugin\_id"  
      \- "plugin\_version"  
      \- "run\_id"  
      \- "env\_key"  
      \- "inputs"  
      \- "params"  
      \- "created\_at"  
      \- "status"  
  output\_path\_policy:  
    mvp\_validation:  
      \- "Any returned output paths must be within run\_dir/output OR within an allowlisted output\_root param."  
      \- "Reject run as failed if outputs violate policy."  
  logging:  
    \- "Stream subprocess stdout/stderr into .saw/runs/\<plugin\_id\>/\<run\_id\>/logs/plugin.log"  
    \- "Optionally mirror tail to API clients via SSE/WebSocket later (stub only)."

service\_management:  
  registry\_dir: ".saw/services"  
  service\_record\_file: ".saw/services/\<service\_id\>.json"  
  service\_id\_generation: "svc\_\<8char\_random\_hex\>"  
  port\_allocation:  
    policy: "allocate\_free\_localhost\_port"  
    host: "127.0.0.1"  
    range: "49152-65535"  
    collision\_handling: "retry up to 50"  
  launch\_tracking:  
    \- "When wrapper requests/declares a service, backend allocates port and passes it to wrapper via context."  
    \- "Backend records pid/port/url/run\_id/plugin\_id/status."  
  crash\_recovery\_on\_backend\_start:  
    \- "Scan .saw/services/\*.json"  
    \- "For each: if pid exists \-\> keep running; else mark stale."  
    \- "Expose stale/running status via API."

backend\_api:  
  base\_path: "/api"  
  endpoints:  
    \- method: "POST"  
      path: "/plugins/{plugin\_id}/run"  
      request\_json:  
        inputs: "dict"  
        params: "dict"  
      response\_json:  
        run\_id: "string"  
        status: "queued|running|succeeded|failed"  
        env\_key: "string"  
        run\_dir: "string"  
    \- method: "GET"  
      path: "/runs/{plugin\_id}/{run\_id}"  
      response\_json:  
        status: "queued|running|succeeded|failed"  
        outputs: "dict"  
        logs\_path: "string"  
        services: "list"  
    \- method: "POST"  
      path: "/services/{service\_id}/stop"  
      response\_json:  
        stopped: "bool"  
        prior\_status: "string"  
  notes:  
    \- "If existing routes/framework differ, adapt to current saw\_api patterns; keep semantics identical."

backend\_execution\_contract:  
  wrapper\_invocation:  
    mode: "subprocess"  
    argv:  
      \- "\<venv\_python\>"  
      \- "\<plugin\_root\>/wrapper.py"  
      \- "--run-dir"  
      \- "\<run\_dir\>"  
      \- "--run-json"  
      \- "\<run\_dir\>/run.json"  
    env:  
      \- "SAW\_RUN\_DIR=\<run\_dir\>"  
      \- "SAW\_PLUGIN\_ID=\<plugin\_id\>"  
      \- "SAW\_ENV\_KEY=\<env\_key\>"  
      \- "SAW\_SERVICE\_PORTS\_JSON=\<json mapping of service\_name-\>port\>"  
  wrapper\_stdout\_protocol:  
    mvp:  
      \- "Wrapper prints logs normally."  
      \- "Wrapper MUST write a results.json to \<run\_dir\>/output/results.json OR print a single JSON line prefixed with 'SAW\_RESULT:'"  
    preferred:  
      \- "results.json at \<run\_dir\>/output/results.json"  
      \- "schema: { outputs: {..}, services: {..}, metrics: {..} }"

database:  
  new\_tables:  
    \- name: "saw\_runs"  
      columns:  
        id: "uuid primary key"  
        plugin\_id: "text not null"  
        plugin\_version: "text not null"  
        run\_id: "text not null unique"  
        env\_key: "text not null"  
        run\_dir: "text not null"  
        status: "text not null"  
        created\_at: "timestamptz not null"  
        started\_at: "timestamptz"  
        finished\_at: "timestamptz"  
        inputs\_json: "jsonb"  
        params\_json: "jsonb"  
        outputs\_json: "jsonb"  
        error\_text: "text"  
    \- name: "saw\_services"  
      columns:  
        id: "uuid primary key"  
        service\_id: "text not null unique"  
        plugin\_id: "text not null"  
        run\_id: "text not null"  
        name: "text not null"  
        pid: "int"  
        port: "int"  
        url: "text"  
        status: "text not null"  
        created\_at: "timestamptz not null"  
        updated\_at: "timestamptz not null"  
  migrations:  
    \- "Add Alembic or existing migration system files under .saw/db/migrations (or repo standard)."

implementation\_tasks:  
  \- id: "T1"  
    title: "Create SAW filesystem bootstrap"  
    details:  
      \- "On backend startup, ensure always\_present\_directories exist."  
      \- "Add helper: ensure\_saw\_dirs()."  
  \- id: "T2"  
    title: "Implement env spec resolution and env\_key hashing"  
    details:  
      \- "Parse plugin.yaml"  
      \- "Resolve deps source per precedence"  
      \- "Compute deps\_sha256"  
      \- "Write .saw/env/manifests/\<env\_key\>.json"  
      \- "Unit tests for hash stability and order-insensitivity"  
  \- id: "T3"  
    title: "Implement ensure\_env(env\_key) with uv"  
    details:  
      \- "Create venv if missing"  
      \- "Install deps using resolved source"  
      \- "Return python\_path"  
      \- "Log install output"  
  \- id: "T4"  
    title: "Implement run creation \+ wrapper subprocess runner"  
    details:  
      \- "Create run\_dir layout"  
      \- "Write run.json"  
      \- "Spawn subprocess with venv python"  
      \- "Capture logs to plugin.log"  
      \- "Detect results.json and validate outputs"  
      \- "Persist run record in Postgres"  
  \- id: "T5"  
    title: "Implement service manager (port allocation \+ registry)"  
    details:  
      \- "Allocate ports"  
      \- "Pass ports into wrapper via env var SAW\_SERVICE\_PORTS\_JSON"  
      \- "Record service.json files"  
      \- "Persist service rows in Postgres"  
      \- "Implement stop endpoint (terminate process tree if possible)"  
      \- "Startup recovery scan"  
  \- id: "T6"  
    title: "Expose backend API endpoints"  
    details:  
      \- "POST /plugins/{plugin\_id}/run"  
      \- "GET /runs/{plugin\_id}/{run\_id}"  
      \- "POST /services/{service\_id}/stop"  
      \- "Return consistent JSON errors"  
  \- id: "T7"  
    title: "Add one example plugin and smoke test"  
    details:  
      \- "plugins/example\_hello with plugin.yaml \+ wrapper.py"  
      \- "Optionally include a dummy http service (python \-m http.server) to test services registry"

acceptance\_criteria:  
  \- "Given a plugin with a lockfile, backend computes same env\_key across runs and reuses venv."  
  \- "If plugin dependencies change (lock content changes), env\_key changes and a new venv is created."  
  \- "Running a plugin creates a run\_dir with run.json, logs, and output/results.json."  
  \- "Outputs violating run\_dir policy cause run failure with clear error."  
  \- "Service registry persists pid/port/url; backend restart restores running/stale status."  
  \- "API endpoints return correct status and metadata and do not crash on plugin failure."  
  \- "Unit tests cover env hashing and port allocation; integration test covers a full run."

error\_handling:  
  \- "All subprocess failures captured with exit code and last N lines of log."  
  \- "Clear user-facing errors for missing plugin.yaml, missing wrapper, invalid YAML, missing deps spec."  
  \- "Timeout option (configurable) for plugin runs; kill process if exceeded."

security\_mvp:  
  \- "Default side\_effects policy: network=none, subprocess=allowlist, disk=run\_dir\_only (validated)."  
  \- "Log declared side\_effects and enforce output path validation."  
  \- "No secrets passed to plugin by default; only explicit allowlist env vars."

notes\_for\_cursor\_agent:  
  \- "Keep code modular: saw\_api/services/env\_manager.py, run\_manager.py, service\_manager.py, plugin\_loader.py."  
  \- "Prefer deterministic pure functions for hashing and path building."  
  \- "Do not block the main server thread; run plugin subprocess management in background tasks or async-aware execution."  
  \- "Add minimal docs in README under backend section: how env hashing works and where venvs/runs live."