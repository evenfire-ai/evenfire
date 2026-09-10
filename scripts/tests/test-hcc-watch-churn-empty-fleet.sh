#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
# shellcheck source=scripts/e2e/_lib/hcc-watch-churn-fixture.sh
source "$ROOT/scripts/e2e/_lib/hcc-watch-churn-fixture.sh"
export FLEET_SECRET=fixture-llm HOST_NS=mcp-host MCP_NS=mcp-server
export FLEET_PREFIX=fixture RUN_ID=fixture HCC_IMAGE=fixture-image
expected_mcp=0
truncate_rfc1123() { printf '%s' "$1"; }
die() { echo "$*" >&2; exit 1; }
kctl() {
  case "$1" in
    create) printf '%s\n' 'apiVersion: v1' 'kind: Secret' ;;
    label) cat ;;
    apply)
      local input
      input="$(cat)"
      [[ -n "$input" ]] || { echo 'FAIL: empty apply payload' >&2; return 1; }
      printf '%s\n' "$input" >> "$tmp/applied"
      ;;
    get)
      if (( expected_mcp > 0 )); then printf '%s\n' 'mcpserver/fixture'; fi
      ;;
    *) echo "FAIL: unexpected kubectl operation $1" >&2; return 1 ;;
  esac
}
create_synthetic_fleet 1 0 1
[[ "$FLEET_CREATED" = 1 ]]
grep -q '^kind: Context' "$tmp/applied"
grep -q '^kind: Host' "$tmp/applied"
if grep -q '^kind: McpServer' "$tmp/applied"; then
  echo 'FAIL: zero-sized MCP inventory emitted a filler resource' >&2
  exit 1
fi
: > "$tmp/applied"
expected_mcp=1
create_synthetic_fleet 1 1 1
grep -q '^kind: McpServer' "$tmp/applied"
grep -q '^kind: Context' "$tmp/applied"
grep -q '^kind: Host' "$tmp/applied"
echo 'PASS: zero MCP inventory omits empty apply; nonzero inventory still creates resources'

# Run the actual EXIT cleanup in a subshell with runtime calls replaced by
# recording stubs. In particular, do not model the cleanup in the test.
cleanup_source="$(sed -n '/^cleanup() {/,/^}/p' "$ROOT/scripts/e2e/e2e-hcc-watch-churn-readiness.sh")"
[[ -n "$cleanup_source" ]]
for patched in 0 1; do
  (
    HCC_PATCHED="$patched" HCC_SCALED_DOWN=1 ORIGINAL_REPLICAS=1
    HCC_DEPLOY=host-context-controller HCC_NS=control-plane
    FLEET_CREATED=0 PROXY_CREATED=0 PROBE_CREATED=0
    E2E_HCC_POLICY_LIFECYCLE=0
    PROXY_EGRESS_NP=fixture-egress HCC_PROXY_NP=fixture-hcc PROBE_EGRESS_NP=fixture-probe
    HCC_LOG_BUFFER="$tmp/buffer" READY_SERIES="$tmp/series"
    kctl() { printf '%s\n' "$*" >> "$tmp/cleanup-$patched"; }
    stop_hcc_recovery_log_stream() { :; }
    wait_until() { :; }
    restore_hcc_after_churn() { echo restore-template >> "$tmp/cleanup-$patched"; }
    finalize_hcc_watch_gate_lock() { :; }
    print_results() { :; }
    eval "$cleanup_source"
    cleanup
  )
  grep -q 'scale deployment host-context-controller -n control-plane --replicas=1' "$tmp/cleanup-$patched"
done
if grep -q restore-template "$tmp/cleanup-0"; then
  echo 'FAIL: early failure rewrote a template the gate had not changed' >&2
  exit 1
fi
grep -q restore-template "$tmp/cleanup-1"
echo 'PASS: cleanup restores replicas before/after redirect and preserves an untouched template'

# The initial LIST is a liveness signal, but cannot substitute for proof that
# a subsequent mutation reached the streaming observer.
# shellcheck source=scripts/e2e/_lib/hcc-networkpolicy-lifecycle.sh
source "$ROOT/scripts/e2e/_lib/hcc-networkpolicy-lifecycle.sh"
NP604_EVIDENCE="$tmp" NP604_CONTEXT=fixture-context NP604_CONTROL=fixture-control
printf '%s\n' 'ADDED mcp-server/ctx-fixture-context-fixture-control' > "$tmp/policy-events.txt"
np604_observer_initial_witness
if np604_observer_witness; then
  echo 'FAIL: initial inventory alone satisfied the streaming witness' >&2
  exit 1
fi
printf '%s\n' 'MODIFIED mcp-server/ctx-fixture-context-fixture-control' >> "$tmp/policy-events.txt"
np604_observer_witness
echo 'PASS: observer requires initial LIST and a distinct streaming MODIFIED witness'
