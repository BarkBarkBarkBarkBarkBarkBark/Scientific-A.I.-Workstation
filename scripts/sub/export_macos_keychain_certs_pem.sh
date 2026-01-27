#!/usr/bin/env bash
set -euo pipefail

# Export macOS keychain certificates to a PEM bundle suitable for Node via NODE_EXTRA_CA_CERTS.
#
# Default output: saw-workspace/certs/macos-keychain.pem
# Usage:
#   bash scripts/sub/export_macos_keychain_certs_pem.sh
#   bash scripts/sub/export_macos_keychain_certs_pem.sh /tmp/macos-cas.pem
#
# After generating, try:
#   NODE_EXTRA_CA_CERTS=saw-workspace/certs/macos-keychain.pem copilot -p "Say pong" --allow-all-tools --allow-url github.com --silent
#
# Or for SAW API:
#   export SAW_COPILOT_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/macos-keychain.pem"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[export] ERROR: this script is macOS-only (needs the 'security' tool)." >&2
  exit 2
fi

out="${1:-saw-workspace/certs/macos-keychain.pem}"
mkdir -p "$(dirname "$out")"

# Collect certs from common keychains.
# Some environments install corporate roots in the login keychain.
keychains=(
  "/System/Library/Keychains/SystemRootCertificates.keychain"
  "/Library/Keychains/System.keychain"
  "$HOME/Library/Keychains/login.keychain-db"
)

: >"$out"

found_any=0
for kc in "${keychains[@]}"; do
  if [[ -f "$kc" ]]; then
    echo "[export] adding certs from: $kc" >&2
    # `security find-certificate -a -p` prints PEM blocks.
    security find-certificate -a -p "$kc" >>"$out" || true
    found_any=1
  fi
done

if [[ "$found_any" -eq 0 ]]; then
  echo "[export] no keychains found; wrote empty bundle: $out" >&2
  exit 1
fi

echo "[export] wrote PEM bundle: $out" >&2
