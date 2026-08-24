#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HANDOFF="${ROOT}/.local-notes/future-np08-v1-cleanup-pr-handoff.md"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[[ -f "${HANDOFF}" ]] || fail 'the canonical v1 cleanup handoff is missing'
grep -qF -- 'chore/np-08-remove-legacy-v1-mcp-inventory' "${HANDOFF}" || fail 'the handoff does not identify the separate cleanup branch'
grep -qF -- 'Do not delete the global v1 route' "${HANDOFF}" || fail 'the handoff does not fence v1 deletion out of PR2'
grep -qF -- 'Deployment/version evidence shows every deployed mcp-proxy consumer uses' "${HANDOFF}" || fail 'the handoff omits the deployed-version entry criterion'
grep -qF -- 'v2 system inventory plus live authorization' "${HANDOFF}" || fail 'the handoff omits the v2 deployment contract'
grep -qF -- 'location = /api/v1/mcpservers {' "${ROOT}/deploy/base/control-plane/configmaps.yaml" || fail 'PR2 no longer retains the global v1 compatibility route'

echo 'PASS: NP-08 v1 cleanup handoff preserves the PR2 compatibility residual'
