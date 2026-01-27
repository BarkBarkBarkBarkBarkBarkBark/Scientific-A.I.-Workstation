#!/usr/bin/env bash
set -euo pipefail

# Wrapper for Copilot CLI invoked by SAW's Copilot SDK.
# Purpose:
# - Make Copilot CLI usable in non-interactive/server mode by pre-approving needed permissions.
# - Keep TLS settings scoped to the Copilot CLI subprocess (SAW passes env to this wrapper).
# - Provide sane defaults that can be overridden via env.

COPILOT_BIN="${COPILOT_BIN:-copilot}"

# Defaults (override with env in the parent process):
# - SAW_COPILOT_MODEL: Copilot model id (e.g. gpt-5.2)
# - SAW_COPILOT_LOG_LEVEL: none|error|warning|info|debug|all
# - SAW_COPILOT_ALLOW_ALL: true/false (maps to COPILOT_ALLOW_ALL)
# - SAW_COPILOT_ALLOW_URLS: space-separated domains/urls to allow (e.g. "github.com")

if [[ -n "${SAW_COPILOT_MODEL:-}" ]]; then
  export COPILOT_MODEL="${SAW_COPILOT_MODEL}"
fi

if [[ -n "${SAW_COPILOT_ALLOW_ALL:-}" ]]; then
  export COPILOT_ALLOW_ALL="${SAW_COPILOT_ALLOW_ALL}"
fi

log_level="${SAW_COPILOT_LOG_LEVEL:-info}"

# Build extra args we want to force for non-interactive execution.
extra_args=()

# Keep logs useful by default.
extra_args+=("--log-level" "$log_level")

# In server/non-interactive mode, prompts for permissions will stall.
# This is safe in SAW because SAW's own write tools are still approval-gated.
extra_args+=("--allow-all-tools")

# Allow GitHub domain access by default for GitHub MCP/server.
# You can provide additional domains via SAW_COPILOT_ALLOW_URLS.
allow_urls=(github.com)
if [[ -n "${SAW_COPILOT_ALLOW_URLS:-}" ]]; then
  # shellcheck disable=SC2206
  allow_urls+=(${SAW_COPILOT_ALLOW_URLS})
fi
for u in "${allow_urls[@]}"; do
  extra_args+=("--allow-url" "$u")
done

# Be quiet only for one-shot prompt mode; avoid affecting server/stdio protocols.
for a in "$@"; do
  if [[ "$a" == "-p" || "$a" == "--prompt" ]]; then
    extra_args+=("--silent")
    break
  fi
done

exec "$COPILOT_BIN" "${extra_args[@]}" "$@"
