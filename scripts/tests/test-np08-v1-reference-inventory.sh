#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

# PR2 deliberately retains the global v1 directory for rollback and older
# deployed proxy versions. This allowlist is intentionally file-scoped: a v1
# reference in any new runtime consumer is a failure, even when the endpoint
# still exists for compatibility.
V1_PATH='/api/v1/mcpservers'
SCAN_ROOTS=(
  host-context-controller/src
  mcp-proxy/src
  mcp-host/src
  scripts/e2e
  tests/e2e
  workflow-recipes
)

# These files are the only intentional v1 consumers in PR2:
# - HCC server/tests: global metadata compatibility handler and 410 tombstones.
# - existing deployed journeys/helpers: metadata-only compatibility probes and
#   negative tombstone assertions.
# - workflow-recipes: legacy global metadata discovery compatibility coverage.
declare -A V1_ALLOWLIST=(
  [host-context-controller/src/server.ts]=compatibility
  [host-context-controller/src/server.test.ts]=tombstone-tests
  [scripts/e2e/e2e-agentic-stdio-baseline.sh]=compatibility
  [scripts/e2e/e2e-hcc-mcp-context-readiness.sh]=compatibility
  [scripts/e2e/e2e-hcc-readiness-bootstrap.sh]=compatibility
  [scripts/e2e/e2e-np08-hcc-authorization.sh]=negative-tombstone-tests
  [tests/e2e/helpers.ts]=compatibility
  [tests/e2e/mcp-host/context-mapper.test.ts]=compatibility-and-tombstones
  [workflow-recipes/tests/e2e/hcc-wrc-integration.test.ts]=compatibility
)

fail=0

if ! grep -qF -- '/api/v2/system/mcpservers' mcp-proxy/src/hccClient.ts ||
   ! grep -qF -- '/api/v2/system/mcpservers/authorize' mcp-proxy/src/hccClient.ts; then
  echo 'FAIL: mcp-proxy v2 system inventory and authorization consumers are not explicit' >&2
  fail=1
fi

if ! grep -qF -- 'location = /api/v1/mcpservers {' deploy/base/control-plane/configmaps.yaml; then
  echo 'FAIL: the retained global v1 inventory compatibility route is absent from the gateway' >&2
  fail=1
fi

matches_file="$(mktemp)"
trap 'rm -f "${matches_file}"' EXIT

if rg -l -F -- "${V1_PATH}" "${SCAN_ROOTS[@]}" >"${matches_file}"; then
  while IFS= read -r file; do
    if [[ -z "${V1_ALLOWLIST[${file}]+x}" ]]; then
      echo "FAIL: unallowlisted v1 reference in ${file}" >&2
      fail=1
    fi
  done <"${matches_file}"
fi

for forbidden in listServersByContext getAuthTokenForServer getMcpAuth; do
  if rg -n --glob '*.ts' --glob '*.sh' -- "${forbidden}" mcp-host/src mcp-proxy/src; then
    echo "FAIL: new runtime consumer retains legacy symbol ${forbidden}" >&2
    fail=1
  fi
done

# Caller-selected v1 credential/discovery shapes are forbidden everywhere in
# the new runtime; only the explicit allowlist above may mention the base path.
if rg -n --glob '*.ts' --glob '*.sh' -- '/api/v1/mcpservers/(context/|[^/]+/auth)' \
  mcp-host/src mcp-proxy/src; then
  echo 'FAIL: new runtime consumes caller-selected v1 Host routes' >&2
  fail=1
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo 'PASS: NP-08 v1 reference inventory (explicit compatibility allowlist)'
