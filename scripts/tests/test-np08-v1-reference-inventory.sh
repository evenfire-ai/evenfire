#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

fail=0

if grep -RInF -- '/api/v1/mcpservers' mcp-host/src; then
  echo "FAIL: mcp-host must not retain an HCC v1 discovery or credential path" >&2
  fail=1
fi

if grep -RInE -- 'listServersByContext|getAuthTokenForServer|pollServers\([^)]*context' mcp-host/src; then
  echo "FAIL: mcp-host retains a caller-selected Context or legacy credential API" >&2
  fail=1
fi

if ! grep -qF -- '/api/v1/mcpservers' mcp-proxy/src/hccClient.ts; then
  echo "FAIL: the temporary PR 2 global-inventory consumer is no longer explicit" >&2
  fail=1
fi

if grep -RInE -- '/api/v1/mcpservers/(context/|[^/]+/auth)' mcp-proxy/src; then
  echo "FAIL: mcp-proxy must not consume caller-selected v1 Host routes" >&2
  fail=1
fi

if grep -RInE -- 'getMcpServers[[:space:]]*\([^)]*context|getMcpAuth|getAuthTokenForServer' tests/e2e; then
  echo "FAIL: E2E helpers retain a caller-selected v1 Host contract" >&2
  fail=1
fi

if [[ "${fail}" -ne 0 ]]; then
  exit 1
fi

echo "PASS: NP-08 v1 reference inventory"
