#!/usr/bin/env bash

set -uo pipefail

FAIL=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pass() { printf 'PASS: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1"
  FAIL=1
}

# Called indirectly by the sourced production helper.
# shellcheck disable=SC2329
log() { printf '[pre-gate-sync] %s\n' "$*"; }

# Exercise the real runtime guard without a cluster. The route-present fixture
# deliberately emits more than one pipe buffer after the match: under
# `set -o pipefail`, `grep -q` used to close its input early and turn a healthy
# `kubectl exec` into SIGPIPE (141), which the guard misreported as a missing
# route.
# Called through the production helper's KC command string.
# shellcheck disable=SC2329
kubectl() {
  case "$*" in
    *"get deployment nginx-workflow-approval-gateway -n control-plane"*)
      return 0
      ;;
    *"get pods -n control-plane -l app=nginx-workflow-approval-gateway"*)
      printf 'gateway-pod\n'
      return 0
      ;;
    *"get pod gateway-pod -n control-plane -o jsonpath={.metadata.deletionTimestamp}"*)
      return 0
      ;;
    *"get pod gateway-pod -n control-plane -o jsonpath={.status.containerStatuses"*)
      printf 'true'
      return 0
      ;;
    *"exec -n control-plane gateway-pod -c nginx -- nginx -T"*)
      case "${TEST_NGINX_MODE:?}" in
        route-present)
          trap 'exit 141' PIPE
          printf '%s\n' \
            'location ~ ^/api/v1/mcp-host/plugin-workload-sdk/invocations/[^/]+/finalize$'
          local i=0
          while [[ "$i" -lt 4096 ]]; do
            printf 'trailing nginx configuration line %080d\n' "$i" || exit 141
            i=$((i + 1))
          done
          ;;
        route-absent)
          printf 'location = /health { return 200; }\n'
          ;;
        exec-failed)
          printf 'simulated nginx inspection failure\n' >&2
          return 42
          ;;
        *)
          printf 'unknown TEST_NGINX_MODE=%s\n' "$TEST_NGINX_MODE" >&2
          return 2
          ;;
      esac
      return 0
      ;;
  esac

  printf 'unexpected kubectl invocation: %s\n' "$*" >&2
  return 2
}

KC="kubectl --context=clerum-test"
PROFILE="clerum-test"
PROJECT_DIR="$REPO_ROOT"
GATE_NAME="plugin-workload-sdk"
export KC PROFILE PROJECT_DIR GATE_NAME

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/minikube/pre-gate-runtime.sh"

run_guard() {
  local mode="$1"
  TEST_NGINX_MODE="$mode" assert_workflow_gateway_prompt_bridge_finalization_route
}

output="$(run_guard route-present 2>&1)"
rc=$?
if [[ "$rc" -eq 0 ]] &&
   [[ "$output" == *'Workflow gateway serves the SDK promptBridge finalization route'* ]]; then
  pass "runtime guard accepts an exact route followed by a full nginx dump"
else
  fail "runtime guard rejected a present route (rc=${rc}): ${output}"
fi

output="$(run_guard route-absent 2>&1)"
rc=$?
if [[ "$rc" -ne 0 ]] &&
   [[ "$output" == *'does not serve the SDK finalization route'* ]]; then
  pass "runtime guard rejects a Ready pod whose nginx config omits the route"
else
  fail "runtime guard accepted an absent route or lost its diagnostic (rc=${rc}): ${output}"
fi

output="$(run_guard exec-failed 2>&1)"
rc=$?
if [[ "$rc" -ne 0 ]] &&
   [[ "$output" == *'could not inspect the active nginx configuration'* ]]; then
  pass "runtime guard distinguishes inspection failure from an absent route"
else
  fail "runtime guard did not fail closed on nginx inspection failure (rc=${rc}): ${output}"
fi

exit "$FAIL"
