#!/usr/bin/env bash
set -euo pipefail

# Export Linux system CA certificates to a PEM bundle suitable for Node via NODE_EXTRA_CA_CERTS.
#
# Linux typically already has a CA bundle on disk (e.g., ca-certificates package).
# This script copies the system bundle into the repo so tools can reference it
# consistently (e.g., SAW_COPILOT_EXTRA_CA_CERTS) without guessing distro paths.
#
# Default output: saw-workspace/certs/linux-ca-bundle.pem
# Usage:
#   bash scripts/sub/export_linux_keychains_certs_pem.sh
#   bash scripts/sub/export_linux_keychains_certs_pem.sh /tmp/linux-cas.pem
#
# After generating, try:
#   NODE_EXTRA_CA_CERTS=saw-workspace/certs/linux-ca-bundle.pem copilot -p "Say pong" --allow-all-tools --allow-url github.com --silent
#
# Or for SAW API:
#   export SAW_COPILOT_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/linux-ca-bundle.pem"

os="$(uname -s)"
if [[ "$os" != "Linux" ]]; then
  echo "[export] ERROR: this script is Linux-only (uname -s = $os)." >&2
  exit 2
fi

out="${1:-saw-workspace/certs/linux-ca-bundle.pem}"
mkdir -p "$(dirname "$out")"

# Common CA bundle locations by distro.
# - Debian/Ubuntu/Arch: /etc/ssl/certs/ca-certificates.crt
# - RHEL/CentOS/Fedora: /etc/pki/tls/certs/ca-bundle.crt
# - Alpine:            /etc/ssl/cert.pem
candidates=(
  "/etc/ssl/certs/ca-certificates.crt"
  "/etc/pki/tls/certs/ca-bundle.crt"
  "/etc/ssl/cert.pem"
)

src=""
for p in "${candidates[@]}"; do
  if [[ -f "$p" ]] && [[ -s "$p" ]]; then
    src="$p"
    break
  fi
done

if [[ -z "$src" ]]; then
  echo "[export] ERROR: no system CA bundle found." >&2
  echo "[export] Looked for:" >&2
  for p in "${candidates[@]}"; do
    echo "  - $p" >&2
  done
  echo "[export] Install your distro CA package (often: ca-certificates) or pass a bundle path explicitly." >&2
  exit 1
fi

# Copy as-is; these files are already PEM bundles in practice.
cp "$src" "$out"

# Ensure the output is not world-writable.
chmod 644 "$out" 2>/dev/null || true

echo "[export] copied system CA bundle: $src" >&2
echo "[export] wrote PEM bundle: $out" >&2
