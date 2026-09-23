#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T2="$ROOT/scripts/minikube/t2.sh"

# shellcheck source=scripts/minikube/t2.sh
source "$T2"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

EVIDENCE_LOG=''
t2_evidence_write() {
  EVIDENCE_LOG+="$1=$2;"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CALLS="$WORK/calls"
T2_PROFILE_ROOT="$WORK/profiles"
T2_PROFILE=pf-refresh-fixture
PIDS="$T2_PROFILE_ROOT/$T2_PROFILE/pids"
mkdir -p "$PIDS"

reset_case() {
  EVIDENCE_LOG=''
  T2_ERROR_CODE=''
  T2_NEXT_COMMAND=''
  T2_PORT_FORWARD_STATUS=NOT_RUN
  rm -f "$PIDS"/*.pid
  : >"$CALLS"
}

# run_pre_gate records the sync only when it actually ran.
make() { printf 'make %s\n' "$*" >>"$CALLS"; }
reset_case
T2_PRE_GATE_SYNC_RAN=false
T2_PLAN_STATE=already-synced
run_pre_gate >/dev/null
[[ "$T2_PRE_GATE_SYNC_RAN" == false && ! -s "$CALLS" && "$EVIDENCE_LOG" == 'pre-gate-sync=SKIPPED;' ]] ||
  fail "an already-synced plan recorded a sync: flag=${T2_PRE_GATE_SYNC_RAN} evidence=${EVIDENCE_LOG}"
reset_case
T2_PLAN_STATE=full-reconcile
run_pre_gate >/dev/null
[[ "$T2_PRE_GATE_SYNC_RAN" == true && "$(cat "$CALLS")" == 'make minikube-pre-gate-sync GATE=minikube-t2 ARGS=--skip-port-forwards' ]] ||
  fail "a full-reconcile plan did not record its sync: flag=${T2_PRE_GATE_SYNC_RAN} calls=$(cat "$CALLS")"
unset -f make

# pre-gate-sync did not run (already-synced): the hold is not touched.
reset_case
T2_PRE_GATE_SYNC_RAN=false
T2_PORT_FORWARD_COMMAND="printf refreshed >>'$CALLS'"
refresh_port_forwards_if_requested
[[ "$T2_PORT_FORWARD_STATUS" == SKIPPED && "$EVIDENCE_LOG" == 'PortForwards=SKIPPED;' ]] ||
  fail "an already-synced run recorded ${T2_PORT_FORWARD_STATUS} / ${EVIDENCE_LOG}"
[[ ! -s "$CALLS" ]] || fail 'the refresh command ran although pre-gate-sync did not'

# pre-gate-sync ran and the operator supplied the command: it runs exactly once
# with the inherited lease identity.
reset_case
T2_PRE_GATE_SYNC_RAN=true
T2_LOCK_TOKEN=lease-token-1
T2_PORT_FORWARD_COMMAND="printf '%s|%s\\n' \"\$T2_SKIP_LOCK\" \"\$T2_LOCK_TOKEN\" >>'$CALLS'"
refresh_port_forwards_if_requested
[[ "$T2_PORT_FORWARD_STATUS" == PASS && "$EVIDENCE_LOG" == 'PortForwards=PASS;' ]] ||
  fail "a successful refresh recorded ${T2_PORT_FORWARD_STATUS} / ${EVIDENCE_LOG}"
[[ "$(cat "$CALLS")" == 'true|lease-token-1' ]] ||
  fail "the refresh command did not run once under the inherited lease: $(cat "$CALLS")"

# pre-gate-sync ran and the command fails: T2 stops with a stable code.
reset_case
T2_PRE_GATE_SYNC_RAN=true
T2_PORT_FORWARD_COMMAND="printf attempted >>'$CALLS'; exit 7"
if refresh_port_forwards_if_requested >/dev/null 2>&1; then
  fail 'a failing refresh command was accepted'
fi
[[ "$(cat "$CALLS")" == attempted ]] || fail 'the failing refresh command did not run'
[[ "$T2_ERROR_CODE" == PORT_FORWARD_CONFLICT && "$T2_PORT_FORWARD_STATUS" == FAIL &&
  "$EVIDENCE_LOG" == 'PortForwards=FAIL;' && "$T2_NEXT_COMMAND" == *'repair the host port-forward command'* ]] ||
  fail "a failed refresh returned ${T2_ERROR_CODE:-<empty>} / ${T2_PORT_FORWARD_STATUS} / ${EVIDENCE_LOG} / ${T2_NEXT_COMMAND}"

# pre-gate-sync ran, a host hold is registered and no command renews it: fail
# closed before any journey runs against the stale forwards.
reset_case
T2_PRE_GATE_SYNC_RAN=true
T2_PORT_FORWARD_COMMAND=''
printf '4242\n' >"$PIDS/control-ui.pid"
if refresh_port_forwards_if_requested >/dev/null 2>&1; then
  fail 'a registered hold invalidated by pre-gate-sync was accepted without a refresh command'
fi
[[ "$T2_ERROR_CODE" == PORT_FORWARD_CONFLICT && "$T2_PORT_FORWARD_STATUS" == FAIL &&
  "$EVIDENCE_LOG" == 'PortForwards=FAIL;' && "$T2_NEXT_COMMAND" == *'set T2_PORT_FORWARD_COMMAND'* ]] ||
  fail "a stale registered hold returned ${T2_ERROR_CODE:-<empty>} / ${T2_PORT_FORWARD_STATUS} / ${EVIDENCE_LOG} / ${T2_NEXT_COMMAND}"

# pre-gate-sync ran with no hold and no command: recorded NOT_RUN, and a later
# health failure names the missing forwards in its next step.
T2_PLAN_STATE=full-reconcile
T2_HEALTHCHECK_COMMAND='exit 2'
T2_HEALTHCHECK_TIMEOUT_SECONDS=5
validate_healthcheck_contract
reset_case
T2_PRE_GATE_SYNC_RAN=true
T2_PORT_FORWARD_COMMAND=''
refresh_port_forwards_if_requested
[[ "$T2_PORT_FORWARD_STATUS" == NOT_RUN && "$EVIDENCE_LOG" == 'PortForwards=NOT_RUN;' ]] ||
  fail "a profile with no hold and no command recorded ${T2_PORT_FORWARD_STATUS} / ${EVIDENCE_LOG}"
if run_healthcheck_if_requested >/dev/null 2>&1; then
  fail 'a failing health command passed'
fi
[[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY && "$T2_NEXT_COMMAND" == *'start branch-profile-pf'* ]] ||
  fail "a health failure after an unrenewed sync did not name the forwards: ${T2_NEXT_COMMAND}"

# A health failure after renewed or untouched forwards keeps the generic next
# step: the forwards are not the suspect.
for status in PASS SKIPPED; do
  reset_case
  T2_PORT_FORWARD_STATUS="$status"
  if run_healthcheck_if_requested >/dev/null 2>&1; then
    fail "a failing health command passed with PortForwards=$status"
  fi
  [[ "$T2_ERROR_CODE" == PROFILE_UNHEALTHY && "$T2_NEXT_COMMAND" == *'repair the health failure'* &&
    "$T2_NEXT_COMMAND" != *branch-profile-pf* ]] ||
    fail "PortForwards=$status blamed the forwards: ${T2_ERROR_CODE:-<empty>} / ${T2_NEXT_COMMAND}"
done

# The orchestrator refreshes after NP-08 and before the user-facing journeys.
order="$(grep -nE '^  (run_np08_hcc_authorization|refresh_port_forwards_if_requested|run_healthcheck_if_requested|run_playwright_if_requested)$' "$T2" | cut -d: -f2 | tr -d ' ' | tr '\n' ' ')"
[[ "$order" == 'run_np08_hcc_authorization refresh_port_forwards_if_requested run_healthcheck_if_requested run_playwright_if_requested ' ]] ||
  fail "main does not refresh host forwards between NP-08 and Health: ${order}"

printf 'PASS: T2 renews the host port-forward hold after pre-gate-sync and before Health\n'
