#!/usr/bin/env bash

# Copilot CLI server management for dev scripts.
# Depends on functions from scripts/lib/ports.sh

saw_start_managed_copilot_cli_server() {
  local nuke_script="$1"

  if [[ -n "${SAW_COPILOT_CLI_URL:-}" ]]; then
    return 0
  fi

  if [[ -z "${SAW_COPILOT_SERVER_PORT:-}" ]]; then
    # Don't kill anything here; pick a free port instead.
    local p
    if p="$(saw_pick_free_port 4321 40)"; then
      export SAW_COPILOT_SERVER_PORT="$p"
      echo "[dev_all] Copilot server mode port: ${SAW_COPILOT_SERVER_PORT}"
    else
      echo "[dev_all] ERROR: could not find a free Copilot port in range 4321..4360" >&2
      return 1
    fi
  else
    saw_require_port_free "$SAW_COPILOT_SERVER_PORT" "Copilot CLI server mode" || return 1
  fi

  # Start Copilot CLI server as an external managed process.
  # This avoids the Copilot Python SDK spawning a server per uvicorn reload,
  # which can leave orphan servers behind and cause port conflicts.
  #
  # NOTE: COPILOT_CLI_PATH may point at a repo script (e.g. scripts/sub/copilot_cli_wrapper.sh).
  # Git can lose executable bits depending on how files are created/checked out.
  # To be robust, if the path isn't executable we run it via bash.
  local copilot_server_cmd=("copilot")
  if [[ -n "${COPILOT_CLI_PATH:-}" ]]; then
    if [[ -x "${COPILOT_CLI_PATH}" ]]; then
      copilot_server_cmd=("${COPILOT_CLI_PATH}")
    else
      copilot_server_cmd=("bash" "${COPILOT_CLI_PATH}")
    fi
  fi

  local copilot_server_node_options="${NODE_OPTIONS:-}"
  if [[ "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "0" && "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "false" && "${SAW_COPILOT_USE_SYSTEM_CA:-1}" != "False" ]]; then
    if [[ "$copilot_server_node_options" != *"--use-system-ca"* ]]; then
      copilot_server_node_options="${copilot_server_node_options} --use-system-ca"
    fi
  fi
  copilot_server_node_options="$(echo "$copilot_server_node_options" | xargs)"

  echo "[dev_all] starting Copilot CLI server on :${SAW_COPILOT_SERVER_PORT} ..."
  (
    if [[ -n "$copilot_server_node_options" ]]; then
      export NODE_OPTIONS="$copilot_server_node_options"
    fi
    if [[ -n "${SAW_COPILOT_EXTRA_CA_CERTS:-}" ]]; then
      export NODE_EXTRA_CA_CERTS="$SAW_COPILOT_EXTRA_CA_CERTS"
    fi
    exec "${copilot_server_cmd[@]}" --server --port "$SAW_COPILOT_SERVER_PORT"
  ) &
  COPILOT_SERVER_PID=$!
  export COPILOT_SERVER_PID

  # Wait briefly for the server to bind before starting SAW.
  for _ in $(seq 1 40); do
    if saw_port_has_listener "$SAW_COPILOT_SERVER_PORT"; then
      break
    fi
    sleep 0.25
  done
  if ! saw_port_has_listener "$SAW_COPILOT_SERVER_PORT"; then
    echo "[dev_all] ERROR: Copilot CLI server did not start on port ${SAW_COPILOT_SERVER_PORT}." >&2
    return 1
  fi

  export SAW_COPILOT_CLI_URL="localhost:${SAW_COPILOT_SERVER_PORT}"
  unset SAW_COPILOT_SERVER_PORT

  # If any later code wants to ensure ports are clean, it can call saw_ensure_port_free.
  # We keep nuke_script param to preserve parity with other helpers even though we
  # do not kill anything for Copilot server port selection.
  : "$nuke_script" >/dev/null 2>&1 || true
}
