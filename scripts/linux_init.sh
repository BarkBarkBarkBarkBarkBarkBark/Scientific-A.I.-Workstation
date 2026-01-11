#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_PREFIX="[linux_init]"

log() { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} WARN: $*" >&2; }
die() { echo "${LOG_PREFIX} ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  scripts/linux_init.sh [--compose-up] [--yes]

What it does (headless-safe):
  - Installs Docker Engine (if missing)
  - Installs Docker Compose v2 (docker compose) (if missing)
  - Enables + starts Docker daemon (if installed but not running)
  - Optionally runs: docker compose up -d (repo root docker-compose.yml)

Flags:
  --compose-up   Run "docker compose up -d" after install
  --yes          Non-interactive (default behavior); reserved for future prompts

Env (optional):
  DOCKER_COMPOSE_VERSION=v2.27.0   # used only if package install fails

Examples:
  scripts/linux_init.sh
  scripts/linux_init.sh --compose-up
EOF
}

RUN_COMPOSE_UP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-up)
      RUN_COMPOSE_UP=1; shift;;
    --yes)
      shift;; # kept for compatibility; script is already non-interactive
    -h|--help)
      usage; exit 0;;
    *)
      die "Unknown arg: $1";;
  esac
done

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    # -n: non-interactive (fail fast if sudo requires a password)
    SUDO="sudo -n"
  else
    die "Need root privileges (sudo not found). Re-run as root."
  fi
fi

detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt"; return; fi
  if command -v dnf >/dev/null 2>&1; then echo "dnf"; return; fi
  if command -v yum >/dev/null 2>&1; then echo "yum"; return; fi
  die "Unsupported Linux (no apt-get/dnf/yum found)."
}

pm_install() {
  local pm="$1"; shift
  case "$pm" in
    apt)
      ${SUDO} apt-get update -y
      ${SUDO} apt-get install -y "$@"
      ;;
    dnf)
      ${SUDO} dnf install -y "$@"
      ;;
    yum)
      ${SUDO} yum install -y "$@"
      ;;
    *)
      die "Unknown package manager: $pm"
      ;;
  esac
}

start_docker_service() {
  if command -v systemctl >/dev/null 2>&1; then
    ${SUDO} systemctl enable docker >/dev/null 2>&1 || true
    ${SUDO} systemctl start docker
    return
  fi
  if command -v service >/dev/null 2>&1; then
    ${SUDO} service docker start
    return
  fi
  warn "Could not start docker automatically (no systemctl/service)."
}

ensure_docker_running() {
  if ! command -v docker >/dev/null 2>&1; then
    return
  fi

  if docker info >/dev/null 2>&1; then
    log "docker daemon is running"
    return
  fi

  log "docker installed but daemon not reachable; attempting to start..."
  start_docker_service || true

  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "docker daemon is running"
      return
    fi
    sleep 0.25
  done

  warn "docker daemon still not reachable. If you are not root, try: sudo docker info"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "docker already installed"
    return
  fi

local pm
pm="$(detect_pm)"
log "Installing prerequisites ($pm)..."
pm_install "$pm" ca-certificates curl git

log "Installing Docker Engine via get.docker.com (non-interactive)..."
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
${SUDO} sh /tmp/get-docker.sh

start_docker_service

log "Docker installed: $(docker --version 2>/dev/null || echo 'unknown')"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if getent group docker >/dev/null 2>&1; then
    ${SUDO} usermod -aG docker "${USER}" || true
    warn "Added ${USER} to docker group. You MUST log out/in (or reconnect SSH) to use docker without sudo."
  fi
fi
}

ensure_docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    log "docker compose already available"
    return
  fi

local pm
pm="$(detect_pm)"
log "Installing docker compose plugin via package manager ($pm)..."

case "$pm" in
  apt)
    pm_install "$pm" docker-compose-plugin && start_docker_service || true
    ;;
  dnf|yum)
    pm_install "$pm" docker-compose-plugin && start_docker_service || true
    ;;
esac

if docker compose version >/dev/null 2>&1; then
  log "docker compose now available"
  return
fi

local version arch url
version="${DOCKER_COMPOSE_VERSION:-v2.27.0}"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="x86_64" ;;
  aarch64|arm64) arch="aarch64" ;;
  *) die "Unsupported architecture for docker compose plugin install: $(uname -m)" ;;
esac

url="https://github.com/docker/compose/releases/download/${version}/docker-compose-linux-${arch}"
log "Package install failed; installing docker compose plugin from ${url}"

${SUDO} mkdir -p /usr/local/lib/docker/cli-plugins
${SUDO} curl -fsSL "$url" -o /usr/local/lib/docker/cli-plugins/docker-compose
${SUDO} chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

docker compose version >/dev/null 2>&1 || die "docker compose still not working after install"
log "docker compose installed: $(docker compose version)"
}

main() {
  log "root: $ROOT_DIR"

  ensure_docker
  ensure_docker_running
  ensure_docker_compose

if [[ "$RUN_COMPOSE_UP" -eq 1 ]]; then
    if [[ ! -f docker-compose.yml ]]; then
      die "docker-compose.yml not found in repo root: $ROOT_DIR"
    fi
    docker info >/dev/null 2>&1 || die "docker daemon not reachable (try rerun as root or ensure docker service is running)"
    log "Running: docker compose up -d"
    docker compose up -d
    log "Done."
  fi

  log "OK"
}

main


