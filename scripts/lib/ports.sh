#!/usr/bin/env bash

# Shared port utilities used by dev scripts.
#
# Portability notes:
# - macOS typically has `lsof` by default.
# - many Linux distros do NOT install `lsof` by default, but do ship `ss` (iproute2).
#
# We support both. Prefer `lsof` when present; fall back to `ss`.

saw_require_port_tooling() {
  if command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    return 0
  fi
  echo "[dev_all] ERROR: need either 'lsof' or 'ss' for port checks." >&2
  echo "[dev_all] Tip (Debian/Ubuntu): sudo apt-get update && sudo apt-get install -y lsof" >&2
  echo "[dev_all] Tip (Fedora/RHEL): sudo dnf install -y lsof" >&2
  return 127
}

saw_port_listener_pids() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    # Only LISTEN sockets; -t prints just PIDs.
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    # ss output format is stable enough for parsing the pid= fragments.
    # We want LISTEN lines matching the local port.
    # Example users field: users:(("uvicorn",pid=12345,fd=3))
    ss -ltnp 2>/dev/null \
      | awk -v p=":${port}" '$1 == "LISTEN" && $4 ~ p { print $0 }' \
      | grep -oE 'pid=[0-9]+' \
      | cut -d= -f2 \
      | sort -u || true
    return 0
  fi

  return 0
}

saw_port_has_listener() {
  local port="$1"
  [[ -n "$(saw_port_listener_pids "$port" | head -n 1 || true)" ]]
}

saw_pick_free_port() {
  local start_port="$1"
  local tries="$2"
  local p="$start_port"
  local i=0
  while [[ "$i" -lt "$tries" ]]; do
    if ! saw_port_has_listener "$p"; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
    i=$((i + 1))
  done
  return 1
}

saw_require_port_free() {
  local port="$1"
  local label="$2"
  if saw_port_has_listener "$port"; then
    echo "[dev_all] ERROR: port ${port} already in use (${label})." >&2
    echo "[dev_all] Tip: inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN" >&2
    return 1
  fi
}

saw_ensure_port_free() {
  local port="$1"
  local label="$2"
  local nuke_script="$3"

  if ! saw_port_has_listener "$port"; then
    return 0
  fi

  if [[ ! -f "$nuke_script" ]]; then
    echo "[dev_all] ERROR: port ${port} already in use (${label})." >&2
    echo "[dev_all] ERROR: ${nuke_script} not found; cannot auto-clear ports." >&2
    return 1
  fi

  echo "[dev_all] port ${port} in use (${label}); killing listeners..."
  bash "$nuke_script" "$port" || true

  if saw_port_has_listener "$port"; then
    echo "[dev_all] ERROR: port ${port} still in use after cleanup (${label})." >&2
    echo "[dev_all] Tip: inspect with: lsof -nP -iTCP:${port} -sTCP:LISTEN" >&2
    return 1
  fi
}
