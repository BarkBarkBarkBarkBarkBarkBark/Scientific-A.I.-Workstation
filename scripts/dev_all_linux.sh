#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Shared helpers
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib/ports.sh"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib/copilot_server.sh"

LOG_PREFIX="[dev_all_linux]"
log() { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} WARN: $*" >&2; }
die() { echo "${LOG_PREFIX} ERROR: $*" >&2; exit 1; }

FRONTEND_PORT="${FRONTEND_PORT:-5173}"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-5127}"
API_URL="${SAW_API_URL:-http://${API_HOST}:${API_PORT}}"
PATCH_ENGINE_HOST="${PATCH_ENGINE_HOST:-127.0.0.1}"
PATCH_ENGINE_PORT="${PATCH_ENGINE_PORT:-5128}"
PATCH_ENGINE_URL="${SAW_PATCH_ENGINE_URL:-http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}}"

SAW_ENABLE_DB="${SAW_ENABLE_DB:-1}"
SAW_ENABLE_PLUGINS="${SAW_ENABLE_PLUGINS:-1}"
SAW_PATCH_APPLY_ALLOWLIST="${SAW_PATCH_APPLY_ALLOWLIST:-saw-workspace/}"

# Allow safe_write/apply_patch to touch todo + workspace files
export SAW_PATCH_APPLY_ALLOWLIST


RELOAD_MODE=1

usage() {
  cat <<EOF
Usage:
  scripts/dev_all_linux.sh [--frontend-port 7176] [--api-port 5127] [--no-reload]

What it does:
  - Optionally starts postgres via: docker compose up -d
  - Creates/activates .venv
  - Installs deps for SAW API + Patch Engine
  - Starts:
      * SAW API (uvicorn)
      * Patch Engine (uvicorn)
      * Frontend (vite)
  - Cleans up child processes on exit

Env (optional):
  FRONTEND_PORT=5173
  API_HOST=127.0.0.1
  API_PORT=5127
  SAW_API_URL=http://127.0.0.1:5127
  PATCH_ENGINE_HOST=127.0.0.1
  PATCH_ENGINE_PORT=5128
  SAW_PATCH_ENGINE_URL=http://127.0.0.1:5128
  SAW_ENABLE_DB=1
  SAW_ENABLE_PLUGINS=1
  SAW_PATCH_APPLY_ALLOWLIST="."  # dev-only

Notes (AWS/SSH):
  - Forward ports to your laptop:
      ssh -L 5173:127.0.0.1:5173 -L 5127:127.0.0.1:5127 -L 5128:127.0.0.1:5128 <host>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --frontend-port)
      FRONTEND_PORT="${2:-}"; shift 2;;
    --api-port)
      API_PORT="${2:-}"; shift 2;;
    --no-reload)
      RELOAD_MODE=0; shift;;
    -h|--help)
      usage; exit 0;;
    *)
      die "Unknown arg: $1";;
  esac
done

# --- sudo pre-auth + keepalive (for docker/systemctl/usermod) ---
SUDO=""
SUDO_KEEPALIVE_PID=""

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    log "Requesting sudo password (may prompt once)..."
    sudo -v || die "sudo authentication failed"

    (
      while true; do
        sudo -n true 2>/dev/null || exit 0
        sleep 60
      done
    ) &
    SUDO_KEEPALIVE_PID="$!"
    trap 'kill "${SUDO_KEEPALIVE_PID}" 2>/dev/null || true' EXIT

    SUDO="sudo"
  else
    die "Need root privileges (sudo not found). Re-run as root."
  fi
fi

# --- docker invocation helper (handles docker.sock permissions) ---
DOCKER=("docker")
docker_cmd() { "${DOCKER[@]}" "$@"; }

select_docker_invocation() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi

  if docker info >/dev/null 2>&1; then
    DOCKER=("docker")
    return
  fi

  if [[ -n "${SUDO}" ]] && sudo -n docker info >/dev/null 2>&1; then
    DOCKER=("sudo" "docker")
    warn "Docker requires sudo for this user. Using sudo docker for this run."
    warn "Tip: add your user to the docker group + reconnect SSH to run docker without sudo."
    return
  fi
}

cleanup() {
  echo ""
  log "stopping..."

  if [[ -n "${COPILOT_SERVER_PID:-}" ]] && kill -0 "$COPILOT_SERVER_PID" 2>/dev/null; then
    kill "$COPILOT_SERVER_PID" 2>/dev/null || true
  fi

  if [[ -n "${VITE_PID:-}" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
  fi
  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${PATCH_ENGINE_PID:-}" ]] && kill -0 "$PATCH_ENGINE_PID" 2>/dev/null; then
    kill "$PATCH_ENGINE_PID" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

log "root: $ROOT_DIR"

saw_require_port_tooling

NUKE_PORTS_SCRIPT="$ROOT_DIR/scripts/sub/nuke_ports.sh"

ensure_port_free() {
  saw_ensure_port_free "$1" "$2" "$NUKE_PORTS_SCRIPT"
}

if ! command -v uv >/dev/null 2>&1; then
  die "uv not found on PATH. Install uv (Linux/macOS): curl -LsSf https://astral.sh/uv/install.sh | sh"
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  die "python3/python not found on PATH"
fi

mkdir -p "$ROOT_DIR/.saw" "$ROOT_DIR/saw-workspace"
touch "$ROOT_DIR/.saw/caps.json" "$ROOT_DIR/saw-workspace/todo.md"
chmod 700 "$ROOT_DIR/.saw" || true
chmod 600 "$ROOT_DIR/.saw/caps.json" || true


# Start postgres if docker is available + compose file exists
if command -v docker >/dev/null 2>&1 && [[ -f docker-compose.yml ]]; then
  select_docker_invocation
  log "starting postgres (docker compose up -d)..."
  docker_cmd compose up -d >/dev/null
else
  warn "docker or docker-compose.yml not found; skipping postgres startup"
fi

if [[ ! -d ".venv" ]]; then
  log "creating .venv..."
  uv venv --python "$PYTHON_BIN" .venv
fi

VENV_PY="$ROOT_DIR/.venv/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  die "venv python not found or not executable: $VENV_PY"
fi

# shellcheck disable=SC1091
source ".venv/bin/activate"

log "installing SAW API deps..."
uv pip install -r services/saw_api/requirements.txt >/dev/null

log "installing Patch Engine deps..."
uv pip install -r services/patch_engine/requirements.txt >/dev/null

# Copilot TLS scoping
# -------------------
# On Linux, rely on system CA by default (requires `ca-certificates` installed).
export SAW_COPILOT_USE_SYSTEM_CA="${SAW_COPILOT_USE_SYSTEM_CA:-1}"

# Model defaults
export SAW_AGENT_MODEL="${SAW_AGENT_MODEL:-gpt-5.2}"
export SAW_COPILOT_MODEL="${SAW_COPILOT_MODEL:-gpt-5.2}"
export SAW_COPILOT_LOG_LEVEL="${SAW_COPILOT_LOG_LEVEL:-info}"

# If COPILOT_CLI_PATH isn't set, use our wrapper when present.
if [[ -z "${COPILOT_CLI_PATH:-}" ]] && [[ -f "$ROOT_DIR/scripts/sub/copilot_cli_wrapper.sh" ]]; then
  export COPILOT_CLI_PATH="$ROOT_DIR/scripts/sub/copilot_cli_wrapper.sh"
fi

# Start managed Copilot CLI server only if Copilot is available.
# (Avoid breaking Linux users who don't have Copilot installed.)
if [[ -z "${SAW_COPILOT_CLI_URL:-}" ]]; then
  if command -v copilot >/dev/null 2>&1 || [[ -n "${COPILOT_CLI_PATH:-}" ]]; then
    saw_start_managed_copilot_cli_server "$NUKE_PORTS_SCRIPT" || warn "Copilot server did not start; continuing without managed Copilot transport"
  else
    warn "copilot not found; skipping managed Copilot server"
  fi
fi

export SAW_ENABLE_DB
export SAW_ENABLE_PLUGINS
export SAW_API_URL="$API_URL"
export SAW_PATCH_ENGINE_URL="$PATCH_ENGINE_URL"
export SAW_REPO_ROOT="$ROOT_DIR"
export SAW_PATCH_APPLY_ALLOWLIST

UVICORN_RELOAD_ARGS=()
if [[ "$RELOAD_MODE" -eq 1 ]]; then
  UVICORN_RELOAD_ARGS=(--reload)
fi

log "starting SAW API on ${API_HOST}:${API_PORT} ..."
ensure_port_free "$API_PORT" "SAW API"
"$VENV_PY" -m uvicorn services.saw_api.app.main:app \
  --host "$API_HOST" --port "$API_PORT" \
  "${UVICORN_RELOAD_ARGS[@]}" --reload-dir "services/saw_api" &
API_PID=$!

log "waiting for SAW API /health ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null 2>&1; then
    log "SAW API ok"
    break
  fi
  sleep 0.25
done

log "starting Patch Engine on ${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT} ..."
ensure_port_free "$PATCH_ENGINE_PORT" "Patch Engine"
"$VENV_PY" -m uvicorn services.patch_engine.app.main:app \
  --host "$PATCH_ENGINE_HOST" --port "$PATCH_ENGINE_PORT" \
  "${UVICORN_RELOAD_ARGS[@]}" --reload-dir "services/patch_engine" &
PATCH_ENGINE_PID=$!

log "waiting for Patch Engine /health ..."
for _ in $(seq 1 60); do
  if curl -fsS "http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}/health" >/dev/null 2>&1; then
    log "Patch Engine ok"
    break
  fi
  sleep 0.25
done

if [[ ! -d "node_modules" ]]; then
  log "node_modules missing; running npm install..."
  npm install
fi

log "starting frontend (vite) on 127.0.0.1:${FRONTEND_PORT} ..."
ensure_port_free "$FRONTEND_PORT" "Vite dev server"
npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort &
VITE_PID=$!

log "running:"
log "  - SAW API:   http://${API_HOST}:${API_PORT}"
log "  - Patch Eng: http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}"
log "  - Frontend:  http://127.0.0.1:${FRONTEND_PORT}"
echo ""
echo "Ctrl+C to stop."

wait
