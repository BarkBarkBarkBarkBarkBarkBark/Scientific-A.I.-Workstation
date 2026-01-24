#!/usr/bin/env bash
set -euo pipefail

echo "=== GitHub CLI auth (gh) ==="
if command -v gh >/dev/null 2>&1; then
  gh auth status || true
else
  echo "gh not found"
fi

echo ""
echo "=== Copilot CLI ==="
if command -v copilot >/dev/null 2>&1; then
  copilot --version || true
  echo "NODE_OPTIONS: ${NODE_OPTIONS:-}"
  echo "NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:-}"
  echo "Config dir: ${COPILOT_CONFIG_DIR:-$HOME/.copilot}"
  echo "Log dir: ${COPILOT_LOG_DIR:-$HOME/.copilot/logs}"
  echo ""
  echo "Latest Copilot CLI log tail:"
  latest=$(ls -t "$HOME/.copilot/logs"/process-*.log 2>/dev/null | head -n 1 || true)
  if [[ -n "${latest:-}" ]]; then
    echo "$latest"
    tail -n 120 "$latest" || true
  else
    echo "(no logs found)"
  fi
else
  echo "copilot not found on PATH"
fi

echo ""
echo "=== Quick interpretation ==="
cat <<'TXT'
- If gh auth shows you're logged in, your GitHub CLI token is fine.
- If Copilot CLI logs show: "unable to get issuer certificate", it's a TLS CA trust issue, not an auth issue.
  In SAW we now set NODE_OPTIONS=--use-system-ca when starting the Copilot CLI server.

If the error persists, generate a PEM bundle from macOS keychains and point Node at it:
  bash scripts/export_macos_keychain_certs_pem.sh
  export SAW_COPILOT_EXTRA_CA_CERTS="$PWD/saw-workspace/certs/macos-keychain.pem"
  # then restart SAW API and re-try.
TXT
