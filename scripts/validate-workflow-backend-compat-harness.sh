#!/usr/bin/env bash
# Validate the backend-compat E2E harness keeps profile-scoped kubectl usage and
# checks the Context selected by each delegated McpServer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

targets=(
  "scripts/e2e/e2e-lib.sh"
  "scripts/e2e/workflow-backend-compat"
)

search_targets() {
  local pattern="$1"
  if command -v rg >/dev/null 2>&1; then
    rg -n "$pattern" "${targets[@]}" || true
  else
    grep -RInE "$pattern" "${targets[@]}" || true
  fi
}

raw_kubectl_matches="$(
  search_targets '(^|[^[:alnum:]_])kubectl([^[:alnum:]_]|$)' \
    | grep -Ev '^[^:]+:[0-9]+:[[:space:]]*#' \
    | grep -Fv 'KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"' || true
)"
if [ -n "$raw_kubectl_matches" ]; then
  echo "ERROR: backend-compat harness must use kctl so KUBECONTEXT is honored." >&2
  echo "$raw_kubectl_matches" >&2
  exit 1
fi

hardcoded_context_matches="$(
  search_targets 'wf-\$\{(RECIPE_NAME|recipe_name)\}|wf-\$\('
)"
if [ -n "$hardcoded_context_matches" ]; then
  echo "ERROR: backend-compat harness must read McpServer.spec.contextRef instead of assuming wf-<recipe>." >&2
  echo "$hardcoded_context_matches" >&2
  exit 1
fi

primitive_array_jsonpath_matches="$(
  search_targets 'range \.spec\.mcpServers'
)"
if [ -n "$primitive_array_jsonpath_matches" ]; then
  echo "ERROR: kubectl JSONPath range over primitive mcpServers arrays prints empty values." >&2
  echo "$primitive_array_jsonpath_matches" >&2
  exit 1
fi

for file in scripts/e2e/e2e-lib.sh scripts/e2e/workflow-backend-compat/http-mongodb-stack.sh; do
  if ! grep -Fq "jsonpath='{.spec.contextRef}'" "$file"; then
    echo "ERROR: expected $file to verify the delegated McpServer contextRef." >&2
    exit 1
  fi
done

echo "OK -- workflow backend-compat harness honors KUBECONTEXT and delegated contextRef"
