#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

check_no_matches() {
  local pattern="$1"
  shift
  local output
  if output=$(rg -n --fixed-strings --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' "$pattern" "$@" 2>/dev/null); then
    printf '%s\n' "$output" >&2
    fail "forbidden workflow runtime contract pattern found: ${pattern}"
  fi
}

check_no_legacy_workflow_control_family() {
  local output
  if output=$(
    rg -n --fixed-strings --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' \
      'workflow-control' "$@" 2>/dev/null \
      | rg -v --fixed-strings 'mcp-host-workflow-control-token' \
      | rg -v --fixed-strings 'MCP_HOST_WORKFLOW_CONTROL_TOKEN'
  ); then
    printf '%s\n' "$output" >&2
    fail "forbidden workflow runtime contract pattern found: workflow-control"
  fi
}

ACTIVE_SURFACES=(
  control-api/src
  workflow-recipes/src
  host-context-controller/src
  mcp-host/src
  workflow-approval-request-reader/src
  deploy/base
  scripts/e2e
  scripts/load
  desktop-app/test/e2e-playwright
)

OLD_APPROVAL_ENV_PREFIX=APPROVAL
OLD_APPROVAL_SECRET_PREFIX=approval
OLD_WORKFLOW_ENV_PREFIX=CLERUM_WORKFLOW

FORBIDDEN_PATTERNS=(
  "${OLD_APPROVAL_ENV_PREFIX}_ACCESS_TOKEN"
  "${OLD_APPROVAL_ENV_PREFIX}_REFRESH_TOKEN"
  "${OLD_APPROVAL_SECRET_PREFIX}-access-token"
  "${OLD_APPROVAL_SECRET_PREFIX}-refresh-token"
  "${OLD_WORKFLOW_ENV_PREFIX}_ACCESS_TOKEN"
  workflowAccessToken
  createWorkflowsRouter
  exposeAuthIssue
  exposeLeader
  exposeRuns
  exposeGrants
  auth/issue
)

for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  check_no_matches "$pattern" "${ACTIVE_SURFACES[@]}"
done

check_no_legacy_workflow_control_family "${ACTIVE_SURFACES[@]}"

check_no_matches CONTROL_API_INTERNAL_SERVICE_TOKENS \
  deploy/base/channels \
  workflow-approval-request-reader/src

if [[ -e control-api/src/routes/workflows/handlers.ts ]]; then
  fail "control-api/src/routes/workflows/handlers.ts must not exist as a god-route factory"
fi

echo "PASS: workflow runtime contract static gate"
