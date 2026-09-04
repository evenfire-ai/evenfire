#!/usr/bin/env bash
# Aggregate PR #580 gate. Every WRC NetworkPolicy family must execute; a missing
# script or any non-zero child result fails the aggregate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${KUBECONTEXT:?KUBECONTEXT is required for WRC NetworkPolicy E2E}"

suites=(
  e2e-wrc-networkpolicy-service-routes.sh
  e2e-wrc-internal-dependency-networkpolicy.sh
  e2e-sandbox-ui-oauth.sh
  e2e-webhooks-basic.sh
)

executed=0
for suite in "${suites[@]}"; do
  path="${SCRIPT_DIR}/${suite}"
  [ -f "$path" ] || {
    printf 'FAIL: required WRC NetworkPolicy E2E suite is missing: %s\n' "$suite" >&2
    exit 1
  }
  printf '\n[WRC-NP-E2E] running %s\n' "$suite"
  KUBECONTEXT="$KUBECONTEXT" bash "$path"
  executed=$((executed + 1))
done

[ "$executed" -eq "${#suites[@]}" ] || {
  printf 'FAIL: WRC NetworkPolicy E2E executed %s/%s suites\n' "$executed" "${#suites[@]}" >&2
  exit 1
}
printf 'WRC_NETWORKPOLICY_E2E_PASS suites=%s\n' "$executed"
