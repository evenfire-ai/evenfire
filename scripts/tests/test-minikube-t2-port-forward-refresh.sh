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

# run_pre_gate records the sync only when it actually ran, and after a sync it
# re-reads the marker pre-gate-sync stamped so the lanes attestation carries
# its cluster fingerprint.
SAVED_PROJECT_DIR="$T2_PROJECT_DIR"
T2_PROJECT_DIR="$WORK/project"
mkdir -p "$T2_PROJECT_DIR/workflow-recipes/src" "$T2_PROJECT_DIR/scripts/minikube"
printf 'export {}\n' >"$T2_PROJECT_DIR/workflow-recipes/src/index.ts"
printf '#!/usr/bin/env bash\n' >"$T2_PROJECT_DIR/scripts/minikube/t2.sh"
SOURCE_FP="$(pre_gate_marker_cluster_fingerprint "$T2_PROJECT_DIR")"
[[ "$SOURCE_FP" =~ ^[0-9a-f]{40}$ ]] || fail "fixture source fingerprint is not a digest: $SOURCE_FP"
T2_HEAD=pre-gate-fixture-head
T2_WORKTREE_ID=pre-gate-fixture-worktree
T2_PLAN_MODE=false
KC_CALLS="$WORK/kc-calls"
marker_json() {
  printf '{"data":{"clusterFingerprint":"%s","gitHead":"%s","worktreeId":"%s","imageSource":"local","imageTag":"fixture","imagesGeneratedAt":"2026-09-24T00:00:00Z"}}' \
    "$1" "$T2_HEAD" "$2"
}
FAKE_MARKER=''
t2_kc() {
  printf 'kc %s\n' "$*" >>"$KC_CALLS"
  case "$*" in
    *"get configmap"*) printf '%s' "$FAKE_MARKER" ;;
    *) printf 'unexpected kubectl call: %s\n' "$*" >&2; return 1 ;;
  esac
}
reset_pre_gate_case() {
  reset_case
  : >"$KC_CALLS"
  T2_PRE_GATE_SYNC_RAN=false
  T2_CLUSTER_FINGERPRINT=''
  T2_MARKER_MATCHES_HEAD=false
  T2_BOOTSTRAP_REQUIRED=false
}
make() { printf 'make %s\n' "$*" >>"$CALLS"; }
SYNC_CALL='make minikube-pre-gate-sync GATE=minikube-t2 ARGS=--skip-port-forwards'

# already-synced: no sync and no marker re-read.
reset_pre_gate_case
T2_PLAN_STATE=already-synced
run_pre_gate >"$WORK/skip.log"
[[ "$T2_PRE_GATE_SYNC_RAN" == false && ! -s "$CALLS" && "$EVIDENCE_LOG" == 'pre-gate-sync=SKIPPED;' ]] ||
  fail "an already-synced plan recorded a sync: flag=${T2_PRE_GATE_SYNC_RAN} evidence=${EVIDENCE_LOG}"
[[ "$(cat "$WORK/skip.log")" == *'skipping pre-gate-sync'* && ! -s "$KC_CALLS" ]] ||
  fail "an already-synced plan re-read the marker: log=$(cat "$WORK/skip.log") kc=$(cat "$KC_CALLS")"

# targeted-sync, full-reconcile and full-bootstrap: the sync runs once and the
# marker it stamped is re-read, so the fingerprint is set for the attestation.
for plan_state in targeted-sync full-reconcile full-bootstrap; do
  reset_pre_gate_case
  T2_PLAN_STATE="$plan_state"
  # full-bootstrap starts with bootstrap pending; pre-gate-sync clears it.
  [[ "$plan_state" != full-bootstrap ]] || T2_BOOTSTRAP_REQUIRED=true
  FAKE_MARKER="$(marker_json "$SOURCE_FP" "$T2_WORKTREE_ID")"
  run_pre_gate >/dev/null
  [[ "$T2_PRE_GATE_SYNC_RAN" == true && "$(cat "$CALLS")" == "$SYNC_CALL" ]] ||
    fail "a ${plan_state} plan did not record its sync: flag=${T2_PRE_GATE_SYNC_RAN} calls=$(cat "$CALLS")"
  [[ "$(grep -c 'get configmap' "$KC_CALLS")" == 1 ]] ||
    fail "a ${plan_state} plan did not re-read the marker once: kc=$(cat "$KC_CALLS")"
  [[ "$T2_CLUSTER_FINGERPRINT" == "$SOURCE_FP" && "$T2_MARKER_MATCHES_HEAD" == true &&
    "$T2_BOOTSTRAP_REQUIRED" == false && "$EVIDENCE_LOG" == pre-gate-sync=PASS* ]] ||
    fail "a ${plan_state} plan left fingerprint='${T2_CLUSTER_FINGERPRINT}' matches=${T2_MARKER_MATCHES_HEAD} bootstrap=${T2_BOOTSTRAP_REQUIRED} evidence=${EVIDENCE_LOG}"
done

# A stamped marker that does not describe the current source fails the sync
# before its PASS evidence is written.
reset_pre_gate_case
T2_PLAN_STATE=targeted-sync
FAKE_MARKER="$(marker_json 0000000000000000000000000000000000000000 "$T2_WORKTREE_ID")"
if run_pre_gate >/dev/null 2>&1; then
  fail 'a sync whose marker carries a foreign fingerprint was accepted'
fi
[[ "$(cat "$CALLS")" == "$SYNC_CALL" && "$(grep -c 'get configmap' "$KC_CALLS")" == 1 ]] ||
  fail "the foreign-fingerprint case did not sync and re-read: calls=$(cat "$CALLS") kc=$(cat "$KC_CALLS")"
[[ "$T2_ERROR_CODE" == HEAD_MARKER_MISMATCH && -z "$T2_CLUSTER_FINGERPRINT" && "$EVIDENCE_LOG" == '' ]] ||
  fail "a foreign fingerprint returned ${T2_ERROR_CODE:-<empty>} fingerprint='${T2_CLUSTER_FINGERPRINT}' evidence=${EVIDENCE_LOG}"

# A marker stamped by another worktree keeps its ownership code: the re-read
# runs with errexit suspended and must not fall through to the digest check.
reset_pre_gate_case
T2_PLAN_STATE=targeted-sync
FAKE_MARKER="$(marker_json "$SOURCE_FP" another-worktree)"
if run_pre_gate >/dev/null 2>&1; then
  fail 'a sync whose marker belongs to another worktree was accepted'
fi
[[ "$(grep -c 'get configmap' "$KC_CALLS")" == 1 ]] ||
  fail "the ownership case did not re-read the marker: kc=$(cat "$KC_CALLS")"
[[ "$T2_ERROR_CODE" == PROFILE_OWNERSHIP_MISMATCH && -z "$T2_CLUSTER_FINGERPRINT" && "$EVIDENCE_LOG" == '' ]] ||
  fail "a foreign-owned marker returned ${T2_ERROR_CODE:-<empty>} fingerprint='${T2_CLUSTER_FINGERPRINT}' evidence=${EVIDENCE_LOG}"
unset -f make t2_kc
T2_PROJECT_DIR="$SAVED_PROJECT_DIR"

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
