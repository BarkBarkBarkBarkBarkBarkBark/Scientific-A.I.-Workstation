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
SAW_KILL_PORTS_ON_START="${SAW_KILL_PORTS_ON_START:-0}"
SAW_PORT_CONFLICT="${SAW_PORT_CONFLICT:-fail}" # fail|kill|reuse

usage() {
  cat <<EOF
Usage:
  scripts/dev_all.sh [--frontend-port 7176] [--api-port 5127]

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
  SAW_KILL_PORTS_ON_START=1       # kill listeners on frontend/api/patch ports before launching
  SAW_PORT_CONFLICT=fail|kill|reuse
    - fail:  exit with a helpful message if ports are in use
    - kill:  kill processes listening on the port(s) before launching
    - reuse: if /health responds on that port, reuse existing process; otherwise kill+launch
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --frontend-port)
      FRONTEND_PORT="${2:-}"; shift 2;;
    --api-port)
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

handle_port_conflict() {
  local port="$1"
  local label="$2"
  local health_url="${3:-}"

  if ! port_has_listener "$port"; then
    return 0
  fi

  case "$SAW_PORT_CONFLICT" in
    kill)
      echo "[dev_all] port ${port} in use; killing listeners (SAW_PORT_CONFLICT=kill) ..."
      bash "$ROOT_DIR/scripts/nuke_ports_mac.sh" "$port" || true
      return 0
      ;;
    reuse)
      if [[ -n "$health_url" ]] && curl -fsS "$health_url" >/dev/null 2>&1; then
        echo "[dev_all] port ${port} in use; reusing existing ${label} (SAW_PORT_CONFLICT=reuse)"
        return 2
      fi
      echo "[dev_all] port ${port} in use but ${label} not healthy; killing + relaunching (SAW_PORT_CONFLICT=reuse) ..."
      bash "$ROOT_DIR/scripts/nuke_ports_mac.sh" "$port" || true
      return 0
      ;;
    fail|*)
      echo "[dev_all] ERROR: port ${port} already in use (${label})." >&2
      echo "[dev_all] Tip: run: bash scripts/nuke_ports_mac.sh ${port}" >&2
      echo "[dev_all] Tip: or set SAW_PORT_CONFLICT=kill (or SAW_KILL_PORTS_ON_START=1)" >&2
      exit 1
      ;;
  esac
}

if [[ "$SAW_KILL_PORTS_ON_START" == "1" ]]; then
  if [[ -f "$ROOT_DIR/scripts/nuke_ports_mac.sh" ]]; then
    echo "[dev_all] clearing stale dev ports (SAW_KILL_PORTS_ON_START=1) ..."
    bash "$ROOT_DIR/scripts/nuke_ports_mac.sh" "$API_PORT" "$PATCH_ENGINE_PORT" "$FRONTEND_PORT" || true
  else
    echo "[dev_all] WARN: scripts/nuke_ports_mac.sh not found; skipping port cleanup" >&2
  fi
fi

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

export SAW_ENABLE_DB
export SAW_ENABLE_PLUGINS
export SAW_API_URL="$API_URL"
export SAW_PATCH_ENGINE_URL="$PATCH_ENGINE_URL"
export SAW_REPO_ROOT="$ROOT_DIR"
export SAW_PATCH_APPLY_ALLOWLIST

echo "[dev_all] starting SAW API on ${API_HOST}:${API_PORT} ..."
# IMPORTANT: keep reload scope narrow so patches don't restart the API mid-flight.
handle_port_conflict "$API_PORT" "SAW API" "http://${API_HOST}:${API_PORT}/health"
API_CONFLICT_RC=$?
if [[ "$API_CONFLICT_RC" -eq 2 ]]; then
  API_PID=""
else
  "$VENV_PY" -m uvicorn services.saw_api.app.main:app --host "$API_HOST" --port "$API_PORT" --reload --reload-dir "services/saw_api" &
  API_PID=$!
fi

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
handle_port_conflict "$PATCH_ENGINE_PORT" "Patch Engine" "http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}/health"
PATCH_CONFLICT_RC=$?
if [[ "$PATCH_CONFLICT_RC" -eq 2 ]]; then
  PATCH_ENGINE_PID=""
else
  "$VENV_PY" -m uvicorn services.patch_engine.app.main:app --host "$PATCH_ENGINE_HOST" --port "$PATCH_ENGINE_PORT" --reload --reload-dir "services/patch_engine" &
  PATCH_ENGINE_PID=$!
fi

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
handle_port_conflict "$FRONTEND_PORT" "Vite dev server" ""
VITE_CONFLICT_RC=$?
if [[ "$VITE_CONFLICT_RC" -eq 2 ]]; then
  echo "[dev_all] reusing existing Vite dev server (port ${FRONTEND_PORT})"
  VITE_PID=""
else
  npm run dev -- --port "$FRONTEND_PORT" --strictPort &
  VITE_PID=$!
fi

echo "[dev_all] running:"
echo "  - SAW API:   http://${API_HOST}:${API_PORT}"
echo "  - Patch Eng: http://${PATCH_ENGINE_HOST}:${PATCH_ENGINE_PORT}"
echo "  - Frontend:  http://127.0.0.1:${FRONTEND_PORT}"
echo ""
echo "Ctrl+C to stop."

wait


