#!/usr/bin/env bash
set -euo pipefail

# Nukes processes listening on common SAW dev ports (macOS).
# Safe-by-default: only kills LISTEN sockets on explicit ports.
#
# Usage:
#   scripts/nuke_ports_mac.sh                 # uses defaults / env
#   scripts/nuke_ports_mac.sh 5127 5128 7176  # explicit ports
#
# Env (optional):
#   FRONTEND_PORT=7176
#   API_PORT=5127
#   PATCH_ENGINE_PORT=5128
#   SAW_PORTS="5127,5128,7176"   # comma/space separated
#   SAW_NUKE_FORCE=1             # skip TERM wait; go straight to KILL

log() { echo "[nuke_ports] $*"; }
warn() { echo "[nuke_ports] WARN: $*" >&2; }

if ! command -v lsof >/dev/null 2>&1; then
  echo "[nuke_ports] ERROR: lsof not found (required)." >&2
  exit 127
fi

parse_ports() {
  # Prints one port per line.
  # bash 3.2 compatible: avoid mapfile + assoc arrays.
  local token

  if [[ $# -gt 0 ]]; then
    for token in "$@"; do
      echo "$token"
    done
    return 0
  fi

  if [[ -n "${SAW_PORTS:-}" ]]; then
    # split on commas/spaces
    local s
    s="${SAW_PORTS//,/ }"
    for token in $s; do
      echo "$token"
    done
    return 0
  fi

  echo "${API_PORT:-5127}"
  echo "${PATCH_ENGINE_PORT:-5128}"
  echo "${FRONTEND_PORT:-5173}"
}

pids_for_port() {
  local port="$1"
  # Only LISTEN sockets; -t prints just PIDs.
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

kill_pids() {
  local signal="$1"; shift
  [[ $# -eq 0 ]] && return 0

  # Dedup using sort -u (bash 3.2 compatible)
  local uniq
  uniq="$(printf '%s\n' "$@" | awk 'NF' | sort -u | tr '\n' ' ')"
  uniq="$(echo "$uniq" | tr -s ' ' | sed 's/^ *//; s/ *$//')"
  [[ -z "$uniq" ]] && return 0

  log "kill -${signal} ${uniq}"
  # shellcheck disable=SC2086
  kill "-${signal}" $uniq 2>/dev/null || true
}

wait_ports_clear() {
  local tries=25
  local delay=0.15
  local i
  local port

  for i in $(seq 1 "$tries"); do
    local any=0
    for port in "$@"; do
      [[ -z "$port" ]] && continue
      if [[ -n "$(pids_for_port "$port")" ]]; then
        any=1
        break
      fi
    done
    if [[ "$any" -eq 0 ]]; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

main() {
  local ports_text
  ports_text="$(parse_ports "$@" | tr -d '[:space:]' | awk 'NF')"
  if [[ -z "$ports_text" ]]; then
    warn "No ports provided (nothing to do)."
    exit 0
  fi

  # Validate + dedup ports
  local ports
  ports="$(echo "$ports_text" | awk 'NF' | while read -r p; do
    if [[ -z "$p" ]]; then continue; fi
    if ! echo "$p" | grep -Eq '^[0-9]{2,5}$'; then
      echo "SKIP:$p"; continue
    fi
    if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then
      echo "SKIP:$p"; continue
    fi
    echo "$p"
  done | grep -v '^SKIP:' | sort -u | tr '\n' ' ')"
  ports="$(echo "$ports" | tr -s ' ' | sed 's/^ *//; s/ *$//')"
  if [[ -z "$ports" ]]; then
    warn "No valid ports provided."
    exit 0
  fi

  log "Target ports: $ports"

  local all_pids
  all_pids=""

  local port
  for port in $ports; do
    local pids
    pids="$(pids_for_port "$port" | awk 'NF' || true)"
    if [[ -z "$pids" ]]; then
      log "port $port: clear"
      continue
    fi
    log "port $port: listeners: $(echo "$pids" | tr '\n' ' ')"
    all_pids="${all_pids}
${pids}"
  done

  all_pids="$(echo "$all_pids" | awk 'NF' | sort -u | tr '\n' ' ')"
  all_pids="$(echo "$all_pids" | tr -s ' ' | sed 's/^ *//; s/ *$//')"
  if [[ -z "$all_pids" ]]; then
    log "Nothing is listening on target ports."
    exit 0
  fi

  if [[ "${SAW_NUKE_FORCE:-0}" == "1" ]]; then
    # shellcheck disable=SC2086
    kill_pids KILL $all_pids
  else
    # shellcheck disable=SC2086
    kill_pids TERM $all_pids
    # shellcheck disable=SC2086
    if ! wait_ports_clear $ports; then
      warn "Ports still busy; escalating to SIGKILL"
      # shellcheck disable=SC2086
      kill_pids KILL $all_pids
    fi
  fi

  # shellcheck disable=SC2086
  if wait_ports_clear $ports; then
    log "All target ports are clear."
    exit 0
  fi

  warn "Some ports still appear busy. Current listeners:"
  for port in $ports; do
    local p
    p="$(pids_for_port "$port")"
    if [[ -n "$p" ]]; then
      warn "port $port: $(echo "$p" | tr '\n' ' ')"
    fi
  done
  exit 1
}

main "$@"
