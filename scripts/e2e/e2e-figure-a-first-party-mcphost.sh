#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if (($# > 0)); then
  echo "1st-party AuthN, 1st-party MCP-Host requires the complete Control UI + Desktop App Playwright route and accepts no optional shortcut flags." >&2
  exit 2
fi

resolved_context="${KUBECONTEXT:-${K8S_CONTEXT:-${E2E_K8S_CONTEXT:-}}}"
if [[ -z "$resolved_context" ]]; then
  cat >&2 <<'MSG'
1st-party AuthN, 1st-party MCP-Host requires an explicit Kubernetes context.
Set KUBECONTEXT, K8S_CONTEXT, or E2E_K8S_CONTEXT to the branch/commit minikube profile resolved from .local-notes.
This runner intentionally has no shared legacy context fallback.
MSG
  exit 2
fi

if [[ -z "${E2E_DESKTOP_PASSWORD:-${E2E_TEST_PASSWORD:-}}" ]]; then
  cat >&2 <<'MSG'
1st-party AuthN, 1st-party MCP-Host requires E2E_DESKTOP_PASSWORD or E2E_TEST_PASSWORD.
This gate intentionally validates real Desktop password login and does not use the synthetic auth endpoint as evidence.
MSG
  exit 2
fi

export K8S_CONTEXT="$resolved_context"
export E2E_K8S_CONTEXT="${E2E_K8S_CONTEXT:-$K8S_CONTEXT}"
export E2E_AUTH_PREFLIGHT="password"

"${SCRIPT_DIR}/playwright-dev.sh" figure-a-first-party-mcphost-flow.test.ts
