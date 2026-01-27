#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Convenience runner for Copilot CLI with TLS scoped to Copilot only.
# Default uses the macOS keychain PEM bundle if present.

NODE_OPTIONS="${NODE_OPTIONS:- --use-system-ca}"
NODE_OPTIONS="$(echo "$NODE_OPTIONS" | xargs)"

DEFAULT_CA="$ROOT_DIR/saw-workspace/certs/macos-keychain.pem"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$DEFAULT_CA}"

export NODE_OPTIONS
export NODE_EXTRA_CA_CERTS

exec copilot "$@"
