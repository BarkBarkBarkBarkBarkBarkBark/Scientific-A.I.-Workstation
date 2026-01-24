#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FRONTEND_PORT="${FRONTEND_PORT:-5173}"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-5127}"
API_URL="${SAW_API_URL:-http://${API_HOST}:${API_PORT}}"
PATCH_ENGINE_HOST="${PATCH_ENGINE_HOST:-127.0.0.1}"
PATCH_ENGINE_PORT="${PATCH_ENGINE_PORT:-5128}"
PATCH_ENGINE_URL="${SAW_PATCH_ENGINE_URL:-http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}}"

SAW_ENABLE_DB="${SAW_ENABLE_DB:-1}"
SAW_ENABLE_PLUGINS="${SAW_ENABLE_PLUGINS:-1}"
SAW_PATCH_APPLY_ALLOWLIST="${SAW_PATCH_APPLY_ALLOWLIST:-.}"

usage() {
  cat <<EOF
Usage:
  scripts/dev_all_mac.sh [--frontend-port 7176] [--api-port 5127]

Linux/AWS headless bootstrap:
  scripts/linux_init.sh --compose-up

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
EOF
}

require_value() {
  local opt="$1"
  local val="${2:-}"
  if [[ -z "$val" ]]; then
    echo "[dev_all] ERROR: ${opt} requires a value" >&2
    usage
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --frontend-port)
      require_value "$1" "${2:-}"
      FRONTEND_PORT="${2:-}"; shift 2;;
    --api-port)
      require_value "$1" "${2:-}"
      API_PORT="${2:-}"; shift 2;;
    -h|--help)
      usage; exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 2;;
  esac
done

cleanup() {
  echo ""
  echo "[dev_all] stopping..."
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

echo "[dev_all] root: $ROOT_DIR"

if ! command -v lsof >/dev/null 2>&1; then
  echo "[dev_all] ERROR: lsof not found on PATH (required for port checks)." >&2
  exit 127
fi

port_has_listener() {
  local port="$1"
  [[ -n "$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)" ]]
}

pick_free_port() {
  local start_port="$1"
  local tries="$2"
  local p="$start_port"
  local i=0
  while [[ "$i" -lt "$tries" ]]; do
    if ! port_has_listener "$p"; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
    i=$((i + 1))
  done
  return 1
}

require_port_free() {
  local port="$1"
  local label="$2"
  if port_has_listener "$port"; then
    echo "[dev_all] ERROR: port ${port} already in use (${label})." >&2
    echo "[dev_all] Tip: pick another port or unset it to auto-pick: SAW_COPILOT_SERVER_PORT=..." >&2
    echo "[dev_all] Tip: inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN" >&2
    exit 1
  fi
}

ensure_port_free() {
  local port="$1"
  local label="$2"

  if ! port_has_listener "$port"; then
    return 0
  fi

  if [[ ! -f "$ROOT_DIR/scripts/nuke_ports_mac.sh" ]]; then
    echo "[dev_all] ERROR: port ${port} already in use (${label})." >&2
    echo "[dev_all] ERROR: scripts/nuke_ports_mac.sh not found; cannot auto-clear ports." >&2
    exit 1
  fi

  echo "[dev_all] port ${port} in use (${label}); killing listeners..."
  bash "$ROOT_DIR/scripts/nuke_ports_mac.sh" "$port" || true

  if port_has_listener "$port"; then
    echo "[dev_all] ERROR: port ${port} still in use after cleanup (${label})." >&2
    echo "[dev_all] Tip: inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN" >&2
    exit 1
  fi
}

if ! command -v uv >/dev/null 2>&1; then
  echo "[dev_all] ERROR: uv not found on PATH." >&2
  echo "[dev_all] Install uv (macOS/Linux): curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 127
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "[dev_all] ERROR: python3/python not found on PATH" >&2
  exit 127
fi

if command -v docker >/dev/null 2>&1; then
  echo "[dev_all] starting postgres (docker compose up -d)..."
  docker compose up -d >/dev/null
else
  echo "[dev_all] docker not found; skipping postgres startup" >&2
fi

if [[ ! -d ".venv" ]]; then
  echo "[dev_all] creating .venv..."
  uv venv --python "$PYTHON_BIN" .venv
fi

VENV_PY="$ROOT_DIR/.venv/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  echo "[dev_all] ERROR: venv python not found or not executable: $VENV_PY" >&2
  exit 127
fi

# shellcheck disable=SC1091
source ".venv/bin/activate"

echo "[dev_all] installing SAW API deps..."
uv pip install -r services/saw_api/requirements.txt >/dev/null

echo "[dev_all] installing Patch Engine deps..."
uv pip install -r services/patch_engine/requirements.txt >/dev/null

# Copilot TLS scoping
# -------------------
# Do NOT export NODE_OPTIONS / NODE_EXTRA_CA_CERTS globally here.
# The frontend dev server (Vite) runs on your system Node and may reject some
# NODE_OPTIONS flags (e.g., "--use-system-ca").
#
# Instead, pass Copilot TLS settings to the SAW API, which forwards them ONLY
# to the Copilot CLI subprocess when/if the Copilot provider is used.
if [[ -z "${SAW_COPILOT_EXTRA_CA_CERTS:-}" ]]; then
  # Prefer a minimal CA bundle if present; fall back to the larger keychain export.
  if [[ -f "$ROOT_DIR/saw-workspace/certs/copilot-ca.pem" ]]; then
    export SAW_COPILOT_EXTRA_CA_CERTS="$ROOT_DIR/saw-workspace/certs/copilot-ca.pem"
  elif [[ -f "$ROOT_DIR/saw-workspace/certs/macos-keychain.pem" ]]; then
    export SAW_COPILOT_EXTRA_CA_CERTS="$ROOT_DIR/saw-workspace/certs/macos-keychain.pem"
  else
    # No CA bundle present yet; generate a keychain bundle automatically (macOS).
    if [[ -f "$ROOT_DIR/scripts/export_macos_keychain_certs_pem.sh" ]]; then
      echo "[dev_all] generating macOS keychain CA bundle for Copilot..."
      bash "$ROOT_DIR/scripts/export_macos_keychain_certs_pem.sh" "$ROOT_DIR/saw-workspace/certs/macos-keychain.pem" >/dev/null
      if [[ -f "$ROOT_DIR/saw-workspace/certs/macos-keychain.pem" ]]; then
        export SAW_COPILOT_EXTRA_CA_CERTS="$ROOT_DIR/saw-workspace/certs/macos-keychain.pem"
      fi
    fi
  fi
fi

export SAW_COPILOT_USE_SYSTEM_CA="${SAW_COPILOT_USE_SYSTEM_CA:-1}"

# Model defaults
# - OpenAI provider: SAW_AGENT_MODEL (fallback is in services/saw_api/app/agent_runtime/core.py)
# - Copilot provider: SAW_COPILOT_MODEL (forwarded into Copilot SDK session config)
export SAW_AGENT_MODEL="${SAW_AGENT_MODEL:-gpt-5.2}"
export SAW_COPILOT_MODEL="${SAW_COPILOT_MODEL:-gpt-5.2}"

# Copilot CLI logging (applies to Copilot subprocess only; forwarded by SAW API)
export SAW_COPILOT_LOG_LEVEL="${SAW_COPILOT_LOG_LEVEL:-info}"

# Start the Copilot CLI transport at SAW API startup (fail fast if TLS/auth/CLI is broken).
export SAW_COPILOT_EAGER_START="${SAW_COPILOT_EAGER_START:-1}"

# Use a wrapper so Copilot CLI runs with non-interactive-safe permissions
# (e.g., allow tools + github.com) without changing other Node processes.
if [[ -z "${COPILOT_CLI_PATH:-}" ]] && [[ -f "$ROOT_DIR/scripts/copilot_cli_wrapper.sh" ]]; then
  export COPILOT_CLI_PATH="$ROOT_DIR/scripts/copilot_cli_wrapper.sh"
fi


export SAW_ENABLE_DB
export SAW_ENABLE_PLUGINS
export SAW_API_URL="$API_URL"
export SAW_PATCH_ENGINE_URL="$PATCH_ENGINE_URL"
export SAW_REPO_ROOT="$ROOT_DIR"
export SAW_PATCH_APPLY_ALLOWLIST

# Copilot CLI transport
# - Default (this script): TCP server mode on a free port (docs-style)
# - Override: set SAW_COPILOT_SERVER_PORT to a specific free port
# - External server: set SAW_COPILOT_CLI_URL=localhost:4321 and start `copilot --server --port 4321` yourself

if [[ -z "${SAW_COPILOT_CLI_URL:-}" ]]; then
  if [[ -z "${SAW_COPILOT_SERVER_PORT:-}" ]]; then
    # Don't kill anything here; pick a free port instead.
    if p="$(pick_free_port 4321 40)"; then
      export SAW_COPILOT_SERVER_PORT="$p"
      echo "[dev_all] Copilot server mode port: ${SAW_COPILOT_SERVER_PORT}"
    else
      echo "[dev_all] ERROR: could not find a free Copilot port in range 4321..4360" >&2
      exit 1
    fi
  else
    require_port_free "$SAW_COPILOT_SERVER_PORT" "Copilot CLI server mode"
  fi

  # Start Copilot CLI server as an external managed process.
  # This avoids the Copilot Python SDK spawning a server per uvicorn reload,
  # which can leave orphan servers behind and cause port conflicts.
  COPILOT_SERVER_BIN="${COPILOT_CLI_PATH:-copilot}"

  COPILOT_SERVER_NODE_OPTIONS="${NODE_OPTIONS:-}"
  if [[ "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "0" && "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "false" && "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "False" ]]; then
    if [[ "$COPILOT_SERVER_NODE_OPTIONS" != *"--use-system-ca"* ]]; then
      COPILOT_SERVER_NODE_OPTIONS="${COPILOT_SERVER_NODE_OPTIONS} --use-system-ca"
    fi
  fi
  COPILOT_SERVER_NODE_OPTIONS="$(echo "$COPILOT_SERVER_NODE_OPTIONS" | xargs)"

  echo "[dev_all] starting Copilot CLI server on :${SAW_COPILOT_SERVER_PORT} ..."
  (
    if [[ -n "$COPILOT_SERVER_NODE_OPTIONS" ]]; then
      export NODE_OPTIONS="$COPILOT_SERVER_NODE_OPTIONS"
    fi
    if [[ -n "${SAW_COPILOT_EXTRA_CA_CERTS:-}" ]]; then
      export NODE_EXTRA_CA_CERTS="$SAW_COPILOT_EXTRA_CA_CERTS"
    fi
    exec "$COPILOT_SERVER_BIN" --server --port "$SAW_COPILOT_SERVER_PORT"
  ) &
  COPILOT_SERVER_PID=$!

  # Wait briefly for the server to bind before starting SAW.
  for _ in $(seq 1 40); do
    if port_has_listener "$SAW_COPILOT_SERVER_PORT"; then
      break
    fi
    sleep 0.25
  done
  if ! port_has_listener "$SAW_COPILOT_SERVER_PORT"; then
    echo "[dev_all] ERROR: Copilot CLI server did not start on port ${SAW_COPILOT_SERVER_PORT}." >&2
    exit 1
  fi

  export SAW_COPILOT_CLI_URL="localhost:${SAW_COPILOT_SERVER_PORT}"
  unset SAW_COPILOT_SERVER_PORT
fi

echo "[dev_all] starting SAW API on ${API_HOST}:${API_PORT} ..."
# IMPORTANT: keep reload scope narrow so patches don't restart the API mid-flight.
ensure_port_free "$API_PORT" "SAW API"
"$VENV_PY" -m uvicorn services.saw_api.app.main:app --host "$API_HOST" --port "$API_PORT" --reload --reload-dir "services/saw_api" &
API_PID=$!

echo "[dev_all] waiting for SAW API /health ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null 2>&1; then
    echo "[dev_all] SAW API ok"
    break
  fi
  sleep 0.25
done

echo "[dev_all] starting Patch Engine on ${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT} ..."
# IMPORTANT: keep reload scope narrow so patch ops don't restart patch_engine mid-flight.
ensure_port_free "$PATCH_ENGINE_PORT" "Patch Engine"
"$VENV_PY" -m uvicorn services.patch_engine.app.main:app --host "$PATCH_ENGINE_HOST" --port "$PATCH_ENGINE_PORT" --reload --reload-dir "services/patch_engine" &
PATCH_ENGINE_PID=$!

echo "[dev_all] waiting for Patch Engine /health ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}/health" >/dev/null 2>&1; then
    echo "[dev_all] Patch Engine ok"
    break
  fi
  sleep 0.25
done

if [[ ! -d "node_modules" ]]; then
  echo "[dev_all] node_modules missing; running npm install..."
  npm install
fi

echo "[dev_all] starting frontend (vite) on port ${FRONTEND_PORT} ..."
ensure_port_free "$FRONTEND_PORT" "Vite dev server"
npm run dev -- --port "$FRONTEND_PORT" --strictPort &
VITE_PID=$!

echo "[dev_all] running:"
echo "  - SAW API:   http://${API_HOST}:${API_PORT}"
echo "  - Patch Eng: http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}"
echo "  - Frontend:  http://127.0.0.1:${FRONTEND_PORT}"
echo ""
echo "Ctrl+C to stop."

wait


