#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FRONTEND_PORT="${FRONTEND_PORT:-5173}"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-5127}"
API_URL="${SAW_API_URL:-http://${API_HOST}:${API_PORT}}"

SAW_ENABLE_DB="${SAW_ENABLE_DB:-1}"
SAW_ENABLE_PLUGINS="${SAW_ENABLE_PLUGINS:-1}"

usage() {
  cat <<EOF
Usage:
  scripts/dev_all.sh [--frontend-port 7176] [--api-port 5127]

Env (optional):
  FRONTEND_PORT=5173
  API_HOST=127.0.0.1
  API_PORT=5127
  SAW_API_URL=http://127.0.0.1:5127
  SAW_ENABLE_DB=1
  SAW_ENABLE_PLUGINS=1
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
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "[dev_all] root: $ROOT_DIR"

if command -v docker >/dev/null 2>&1; then
  echo "[dev_all] starting postgres (docker compose up -d)..."
  docker compose up -d >/dev/null
else
  echo "[dev_all] docker not found; skipping postgres startup" >&2
fi

if [[ ! -d ".venv" ]]; then
  echo "[dev_all] creating .venv..."
  python -m venv .venv
fi

# shellcheck disable=SC1091
source ".venv/bin/activate"

echo "[dev_all] installing SAW API deps..."
pip install -r services/saw_api/requirements.txt >/dev/null

export SAW_ENABLE_DB
export SAW_ENABLE_PLUGINS
export SAW_API_URL="$API_URL"

echo "[dev_all] starting SAW API on ${API_HOST}:${API_PORT} ..."
python -m uvicorn services.saw_api.app.main:app --host "$API_HOST" --port "$API_PORT" --reload &
API_PID=$!

echo "[dev_all] waiting for SAW API /health ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null 2>&1; then
    echo "[dev_all] SAW API ok"
    break
  fi
  sleep 0.25
done

if [[ ! -d "node_modules" ]]; then
  echo "[dev_all] node_modules missing; running npm install..."
  npm install
fi

echo "[dev_all] starting frontend (vite) on port ${FRONTEND_PORT} ..."
npm run dev -- --port "$FRONTEND_PORT" &
VITE_PID=$!

echo "[dev_all] running:"
echo "  - SAW API:   http://${API_HOST}:${API_PORT}"
echo "  - Frontend:  http://127.0.0.1:${FRONTEND_PORT}"
echo ""
echo "Ctrl+C to stop both."

wait


