#!/usr/bin/env bash
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="${ROOT}/scripts/e2e"
WATCH_GATE="${SCRIPT_DIR}/e2e-hcc-communicationchannel-watch-recovery.sh"
READINESS_GATE="${SCRIPT_DIR}/e2e-hcc-readiness-bootstrap.sh"
MCP_READINESS_GATE="${SCRIPT_DIR}/e2e-hcc-mcp-context-readiness.sh"
GATES=("$WATCH_GATE" "$READINESS_GATE" "$MCP_READINESS_GATE")
LOCK_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
LOG_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
FIXTURE_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
MOCK_STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-lock-test.XXXXXX")"
MOCK_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-log-test.XXXXXX")"
rm -f "$MOCK_STATE_FILE"
trap 'rm -f "$MOCK_STATE_FILE" "$MOCK_LOG_FILE"' EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

for script in "${GATES[@]}" "$LOCK_HELPER" "$LOG_HELPER" "$FIXTURE_HELPER"; do
  if bash -n "$script"; then
    pass "$(basename "$script") has valid bash syntax"
  else
    fail "$(basename "$script") has invalid bash syntax"
  fi
done

# Literal source-code assertions.
# shellcheck disable=SC2016
if grep -Fq 'source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"' "$READINESS_GATE" &&
   grep -Fq 'require_branch_owned_hcc_gate "$HCC_NS"' "$READINESS_GATE" &&
   grep -Fq 'sync_marker="$HCC_BRANCH_GATE_SYNC_MARKER"' "$READINESS_GATE" &&
   ! grep -Fq 'sync_marker="$(kctl get configmap' "$READINESS_GATE" &&
   grep -Fq "actual_cluster_fingerprint=\"\$(jq -r '.data.clusterFingerprint" "$READINESS_GATE" &&
   grep -Fq "actual_gate=\"\$(jq -r '.data.gate" "$READINESS_GATE"; then
  pass "readiness gate reuses one shared branch-owned ownership, HEAD, fingerprint, and gate snapshot"
else
  fail "readiness gate duplicates, bypasses, or splits the branch-owned marker snapshot"
fi

fixture_gate_function="$(sed -n '/^require_branch_owned_hcc_gate() {$/,/^}$/p' "$FIXTURE_HELPER")"
marker_get_count="$(
  grep -Fc 'kctl get configmap clerum-pre-gate-sync-state' <<<"$fixture_gate_function"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [ "$marker_get_count" = 1 ] &&
   [[ "$fixture_gate_function" == *'-o json'* ]] &&
   [[ "$fixture_gate_function" == *'.data.worktreeId'* ]] &&
   [[ "$fixture_gate_function" == *'.data.gitHead'* ]] &&
   [[ "$fixture_gate_function" == *'<<<"$HCC_BRANCH_GATE_SYNC_MARKER"'* ]]; then
  pass "shared branch gate derives ownership and HEAD from one exported ConfigMap JSON snapshot"
else
  fail "shared branch gate can split ownership and HEAD across marker reads"
fi

# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-logs.sh
source "$LOG_HELPER"
HCC_LOG_BUFFER="$MOCK_LOG_FILE"
START_TIME=2026-07-14T00:00:00Z
HOST_NS=mcp-host

blocker_holds_function="$(sed -n '/^blocker_holds_token_request() {$/,/^}$/p' "$READINESS_GATE")"
blocker_count_function="$(sed -n '/^blocker_fixture_request_count() {$/,/^}$/p' "$READINESS_GATE")"
if (
  BLOCKER_NAME=readiness-blocker
  HCC_NS=control-plane
  FIXTURE_HOST_PREFIX=e2e-hcc-ready-test
  TOKEN_REQUEST_LOG_PREFIX='holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host='
  kctl() { cat "$MOCK_LOG_FILE"; }
  eval "$blocker_holds_function"
  eval "$blocker_count_function"
  printf '%s\n' \
    'holding-token GET /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-01' \
    'holding-token POST /wrong/path host=e2e-hcc-ready-test-02' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-03' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-03' \
    'holding-token POST /api/v1/auth/mcp-host/mcp-host/standalone/tokens host=e2e-hcc-ready-test-04' \
    >"$MOCK_LOG_FILE"
  [ "$(blocker_fixture_request_count)" = 2 ] &&
    blocker_holds_token_request
); then
  pass "blocker evidence counts unique fixtures only on the canonical token issuance method and path"
else
  fail "wrong-method, wrong-path, or duplicate blocker traffic can satisfy the fleet evidence"
fi

create_fixtures_function="$(sed -n '/^create_host_fixtures() {$/,/^}$/p' "$READINESS_GATE")"
if (
  RUN_ID=fixture-failure
  SUITE_NAME=hcc-readiness-bootstrap
  HOST_NS=mcp-host
  MCP_NS=mcp-server
  FIXTURE_SECRET=e2e-secret
  FIXTURE_CONTEXT=e2e-context
  FIXTURE_HOST_PREFIX=e2e-host
  FIXTURE_HOST_COUNT=4
  FIXTURE_HOST_NAMES=()
  FIXTURES_CREATED=0
  KCTL_APPLY_COUNT=0
  kctl() {
    KCTL_APPLY_COUNT=$((KCTL_APPLY_COUNT + 1))
    cat >/dev/null
    [ "$KCTL_APPLY_COUNT" -ne 3 ]
  }
  eval "$create_fixtures_function"
  if create_host_fixtures; then
    exit 1
  fi
  [ "$KCTL_APPLY_COUNT" = 3 ]
); then
  pass "an intermediate Host apply failure aborts fixture creation even from an OR-list"
else
  fail "fixture creation can continue or report success after an intermediate apply failure"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  pass "fresh Host LIST before channel recovery is attributed to the same interruption"
else
  fail "valid LIST-to-recovery ordering was rejected"
fi

printf '%s\n' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  fail "a Host LIST from before the interruption satisfied the recovery assertion"
else
  pass "a stale pre-interruption Host LIST cannot satisfy recovery"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 4 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 1 5; then
  fail "a stale Host inventory count satisfied recovery"
else
  pass "recovery requires the exact fresh Host inventory count"
fi

printf '%s\n' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 1 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 4 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' \
  '[K8s] CommunicationChannel watch ended; holding stateless lifecycle active until snapshot recovery' \
  '[K8s] Listing all Hosts in namespace mcp-host' \
  '[K8s] Recovered 2 CommunicationChannel(s) into cache (ccCacheSynced=true)' \
  '[K8s] Reconciling 5 Host(s) for lifecycle after CommunicationChannel recovery' \
  '[K8s] Completed Host reconciliation after CommunicationChannel recovery' >"$MOCK_LOG_FILE"
if recovery_cycle_used_fresh_host_inventory 2 5; then
  pass "recovery attribution selects the requested interruption cycle"
else
  fail "the second recovery cycle was not isolated from the first"
fi

large_log_tail="$(awk 'BEGIN {
  for (i = 1; i <= 20000; i++) {
    printf "trailing-log-line-%05d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n", i
  }
}')"
large_active_snapshot="${START_MARKER:-Starting initial Host background convergence}
${large_log_tail}"
if hcc_log_snapshot_contains \
     "$large_active_snapshot" 'Starting initial Host background convergence'; then
  pass "buffered marker lookup survives a log tail larger than a pipe buffer"
else
  fail "large trailing logs can hide a marker from buffered lookup"
fi

if hcc_initial_pass_snapshot_is_active \
     "$large_active_snapshot" \
     'Starting initial Host background convergence' \
     'Completed Host reconciliation after initial Host reconciliation' \
     'Host reconciliation after initial Host reconciliation failed'; then
  pass "Host pass snapshot is active only with START and no terminal marker"
else
  fail "valid active Host pass snapshot was rejected"
fi

for terminal_marker in \
  'Completed Host reconciliation after initial Host reconciliation' \
  'Host reconciliation after initial Host reconciliation failed'; do
  if hcc_initial_pass_snapshot_is_active \
       "${large_active_snapshot}
${terminal_marker}" \
       'Starting initial Host background convergence' \
       'Completed Host reconciliation after initial Host reconciliation' \
       'Host reconciliation after initial Host reconciliation failed'; then
    fail "terminal Host marker '${terminal_marker}' can still satisfy the active-pass guard"
  else
    pass "terminal Host marker '${terminal_marker}' invalidates the active-pass guard"
  fi
done

readiness_log_function="$(
  sed -n '/^hcc_log_contains() {$/,/^}$/p' "$READINESS_GATE"
)"
running_pod_function="$(
  sed -n '/^running_hcc_pod() {$/,/^}$/p' "$READINESS_GATE"
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$readiness_log_function" == *'logs="$(hcc_logs "$pod")"'* ]] &&
   [[ "$readiness_log_function" == *'hcc_log_snapshot_contains "$logs" "$marker"'* ]] &&
   [[ "$running_pod_function" == *'rows="$(kctl get pods'* ]] &&
   [[ "$running_pod_function" == *'<<<"$rows"'* ]]; then
  pass "readiness log and Running-pod selection buffer producers before early-exit consumers"
else
  fail "readiness log or Running-pod selection reintroduced a pipefail/SIGPIPE path"
fi

active_guard_function="$(
  sed -n '/^initial_host_pass_is_active() {$/,/^}$/p' "$READINESS_GATE"
)"
# shellcheck disable=SC2016
probe_result_line="$(grep -nF 'probe_result="$(kctl exec' "$READINESS_GATE" | cut -d: -f1)"
# shellcheck disable=SC2016
final_active_guard_line="$(
  grep -nF 'initial_host_pass_is_active "$new_hcc_pod"' "$READINESS_GATE" |
    tail -1 |
    cut -d: -f1
)"
# Literal source-code assertions.
# shellcheck disable=SC2016
if [[ "$active_guard_function" == *'"$COMPLETE_MARKER"'* ]] &&
   [[ "$active_guard_function" == *'"$FAIL_MARKER"'* ]] &&
   [ -n "$probe_result_line" ] &&
   [ -n "$final_active_guard_line" ] &&
   [ "$final_active_guard_line" -gt "$probe_result_line" ]; then
  pass "final readiness assertion rejects both failed and completed Host passes"
else
  fail "final readiness assertion does not enforce both terminal Host markers"
fi

cleanup_body="$(sed -n '/^cleanup() {$/,/^}$/p' "$READINESS_GATE")"
fixture_cleanup_body="$(sed -n '/^delete_host_fixtures() {$/,/^}$/p' "$READINESS_GATE")"
# shellcheck disable=SC2016
cleanup_stop_line="$(grep -nF 'kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0' \
  <<<"$cleanup_body" | head -1 | cut -d: -f1)"
cleanup_fixture_line="$(grep -nF 'delete_host_fixtures' <<<"$cleanup_body" | head -1 | cut -d: -f1)"
# shellcheck disable=SC2016
cleanup_restore_line="$(grep -nF 'kctl set env deployment/"$HCC_DEPLOY"' \
  <<<"$cleanup_body" | head -1 | cut -d: -f1)"
# Literal source-code assertion.
# shellcheck disable=SC2016
if grep -Fq 'FIXTURE_HOST_COUNT=$((HOST_RECONCILE_CONCURRENCY * 2 + 1))' "$READINESS_GATE" &&
   grep -Fq 'kind: Host' "$READINESS_GATE" &&
   grep -Fq "host='+host" "$READINESS_GATE" &&
   grep -Fq 'blocker_fixture_request_count' "$READINESS_GATE" &&
   [[ "$fixture_cleanup_body" == *'clerum.io/managed-by=host-context-controller,clerum.io/host=${host}'* ]] &&
   [[ "$fixture_cleanup_body" == *'fixture_resources_absent'* ]] &&
   ! grep -Fq 'RUNTIME_SECRET' "$READINESS_GATE" &&
   ! grep -Fq 'HOST_REF' "$READINESS_GATE" &&
   [ -n "$cleanup_stop_line" ] &&
   [ -n "$cleanup_fixture_line" ] &&
   [ -n "$cleanup_restore_line" ] &&
   [ "$cleanup_stop_line" -lt "$cleanup_fixture_line" ] &&
   [ "$cleanup_fixture_line" -lt "$cleanup_restore_line" ]; then
  pass "readiness gate uses a multi-wave owned Host fleet and deletes it while HCC is stopped"
else
  fail "readiness gate can mutate a real Host Secret or restore HCC before fixture deletion"
fi

if [[ "$cleanup_body" == *'header "HCC readiness bootstrap gate passed"'* ]] &&
   grep -Fq 'header "HCC readiness assertions passed; restoring branch-owned runtime"' \
     "$READINESS_GATE" &&
   [ "$(grep -Fc 'header "HCC readiness bootstrap gate passed"' "$READINESS_GATE")" = 1 ]; then
  pass "readiness gate emits its final pass banner only after verified restoration and lock finalization"
else
  fail "readiness gate can announce a final pass before cleanup and ownership release finish"
fi

wait_until_body="$(sed -n '/^wait_until() {$/,/^}$/p' "$READINESS_GATE")"
# Literal source-code assertion.
# shellcheck disable=SC2016
if [[ "$wait_until_body" == *'deadline=$(( $(date +%s) + timeout ))'* ]] &&
   ! grep -Fq -- '--for=delete' "$READINESS_GATE" &&
   ! grep -Fq 'port: 8081' "$READINESS_GATE" &&
   grep -Fq 'HCC_E2E_PORT' "$READINESS_GATE"; then
  pass "readiness gate uses wall-clock deadlines, absence waits, and the deployed HCC port"
else
  fail "readiness gate retains a command-latency, zero-pod wait, or hard-coded-port edge"
fi

for gate in "${GATES[@]}"; do
  acquire_line="$(grep -nF 'acquire_hcc_watch_gate_lock' "$gate" | tail -1 | cut -d: -f1)"
  case "$gate" in
    "$WATCH_GATE")
      # Literal source-code assertion.
      # shellcheck disable=SC2016
      mutation_line="$(grep -nF 'kctl patch deployment "$HCC_DEPLOY"' "$gate" | tail -1 | cut -d: -f1)"
      ;;
    *)
      mutation_line="$(grep -nF 'HCC_MUTATED=1' "$gate" | tail -1 | cut -d: -f1)"
      ;;
  esac
  # The grep pattern intentionally matches literal shell variable references.
  # shellcheck disable=SC2016
  if [ -n "$acquire_line" ] && [ -n "$mutation_line" ] &&
     [ "$acquire_line" -lt "$mutation_line" ] &&
     grep -Fq 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"' "$gate"; then
    pass "$(basename "$gate") acquires before mutation and finalizes ownership from cleanup"
  else
    fail "$(basename "$gate") does not hold the shared lock across its full fault-injection window"
  fi
done

kctl() {
  local action=$1 body expected_rv current_rv current_uid next_rv
  case "$action" in
    create)
      [ ! -s "$MOCK_STATE_FILE" ] || return 1
      body="$(cat)"
      if [ "${MOCK_CREATE_WITHOUT_UID:-0}" = 1 ]; then
        jq -c '.metadata.resourceVersion="1"' <<<"$body" >"$MOCK_STATE_FILE"
      else
        jq -c '.metadata.uid="uid-1" | .metadata.resourceVersion="1"' <<<"$body" >"$MOCK_STATE_FILE"
      fi
      cat "$MOCK_STATE_FILE"
      ;;
    get)
      [ -s "$MOCK_STATE_FILE" ] || return 1
      cat "$MOCK_STATE_FILE"
      ;;
    replace)
      body="$(cat)"
      [ -s "$MOCK_STATE_FILE" ] || return 1
      if [ "${MOCK_REPLACE_RACE:-0}" = 1 ]; then
        jq -c '.metadata.uid="uid-race" | .metadata.resourceVersion="99" |
          .data.state="active" | .data.holder="intruder"' "$MOCK_STATE_FILE" >"${MOCK_STATE_FILE}.next"
        mv "${MOCK_STATE_FILE}.next" "$MOCK_STATE_FILE"
        return 1
      fi
      expected_rv="$(jq -r '.metadata.resourceVersion' <<<"$body")"
      current_rv="$(jq -r '.metadata.resourceVersion' "$MOCK_STATE_FILE")"
      [ "$expected_rv" = "$current_rv" ] || return 1
      current_uid="$(jq -r '.metadata.uid' "$MOCK_STATE_FILE")"
      next_rv=$((current_rv + 1))
      jq -c --arg uid "$current_uid" --arg rv "$next_rv" \
        '.metadata.uid=$uid | .metadata.resourceVersion=$rv' <<<"$body" >"$MOCK_STATE_FILE"
      cat "$MOCK_STATE_FILE"
      ;;
    *) return 1 ;;
  esac
}
truncate_rfc1123() { printf '%.63s' "$1"; }
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
source "$LOCK_HELPER"

HCC_NS=control-plane
HCC_DEPLOY=host-context-controller
E2E_KUBECONTEXT=clerum-codex-lock-test-1234abcd
RUN_ID=owner-1
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_NAME=""
HCC_GATE_LOCK_UID=""
HCC_GATE_FINALIZATION_FAILURE=""
if acquire_hcc_watch_gate_lock &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = owner-1 ] &&
   [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = active ]; then
  pass "first gate atomically creates an active lock with diagnostic metadata"
else
  fail "first gate could not acquire the lock"
fi

RUN_ID=contender-2
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "second gate acquired an active lock"
else
  pass "second gate is rejected while the lock is active"
fi

HCC_GATE_LOCK_ACQUIRED=1
HCC_GATE_LOCK_UID="uid-1"
if release_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "non-owner released the lock"
else
  pass "non-owner cannot release the lock"
fi

RUN_ID=owner-1
if finalize_hcc_watch_gate_lock 0 1 &&
   [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = released ] &&
   [ -z "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" ]; then
  pass "clean finalization releases ownership through resourceVersion CAS"
else
  fail "owner could not release the lock after clean finalization"
fi

RUN_ID=contender-2
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock && [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ]; then
  pass "a released semaphore can be reacquired through resourceVersion CAS"
else
  fail "released semaphore could not be reacquired"
fi

retained_output="$(finalize_hcc_watch_gate_lock 1 1 2>&1)" && retained_rc=0 || retained_rc=$?
if [ "$retained_rc" -ne 0 ] && [ "$HCC_GATE_LOCK_ACQUIRED" = 1 ] &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ] &&
   [[ "$retained_output" == *'cause=fixture_cleanup_failed'* ]] &&
   [[ "$retained_output" == *'Observed: state=active, holder=contender-2, uid=uid-1'* ]] &&
   [[ "$retained_output" != *'delete configmap'* ]]; then
  pass "failed cleanup retains ownership and emits verified, non-destructive diagnostics"
else
  fail "failed cleanup can silently release or misreport lock ownership"
fi

restore_output="$(finalize_hcc_watch_gate_lock 0 0 2>&1)" && restore_rc=0 || restore_rc=$?
if [ "$restore_rc" -ne 0 ] && [[ "$restore_output" == *'cause=hcc_restore_failed'* ]] &&
   [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = contender-2 ]; then
  pass "failed HCC restoration retains ownership and reports its distinct cause"
else
  fail "failed HCC restoration can release the lock or report the wrong cause"
fi

release_hcc_watch_gate_lock || fail "test setup could not release retained owner"
RUN_ID=race-owner
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
acquire_hcc_watch_gate_lock || fail "test setup could not acquire race owner"
MOCK_REPLACE_RACE=1
race_output="$(finalize_hcc_watch_gate_lock 0 1 2>&1)" && race_rc=0 || race_rc=$?
unset MOCK_REPLACE_RACE
if [ "$race_rc" -ne 0 ] && [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = intruder ] &&
   [[ "$race_output" == *'cause=lock_finalization_failed'* ]] &&
   [[ "$race_output" == *'Observed: state=active, holder=intruder, uid=uid-race'* ]]; then
  pass "release CAS cannot overwrite a replacement owner and reports lock finalization"
else
  fail "release race can clear or misreport the replacement owner's lock"
fi

RUN_ID=late-contender
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "active lock left by an interrupted owner was stolen"
else
  pass "stale or interrupted active locks remain fail-closed"
fi

rm -f "$MOCK_STATE_FILE"
RUN_ID=missing-uid-owner
HCC_GATE_LOCK_ACQUIRED=0
HCC_GATE_LOCK_UID=""
MOCK_CREATE_WITHOUT_UID=1
if acquire_hcc_watch_gate_lock >/dev/null 2>&1; then
  fail "lock acquisition trusted a response without a UID"
else
  missing_uid_output="$(finalize_hcc_watch_gate_lock 0 1 2>&1)" && missing_uid_rc=0 || missing_uid_rc=$?
  if [ "$missing_uid_rc" -ne 0 ] && [ "$HCC_GATE_LOCK_ACQUIRED" = 1 ] &&
     [ "$(jq -r '.data.state' "$MOCK_STATE_FILE")" = active ] &&
     [ "$(jq -r '.data.holder' "$MOCK_STATE_FILE")" = missing-uid-owner ] &&
     [[ "$missing_uid_output" == *'cause=lock_finalization_failed'* ]] &&
     [[ "$missing_uid_output" == *'uid=unknown'* ]]; then
    pass "an unverifiable acquisition UID retains the lock fail-closed"
  else
    fail "a lock without a verified UID can be released or misreported"
  fi
fi
unset MOCK_CREATE_WITHOUT_UID

cleanup_fail_line="$(grep -nF 'fail "fixture cleanup, HCC restoration, or lock finalization did not complete' "$WATCH_GATE" | cut -d: -f1)"
results_line="$(grep -nF '  print_results' "$WATCH_GATE" | head -1 | cut -d: -f1)"
if [ -n "$cleanup_fail_line" ] && [ -n "$results_line" ] && [ "$cleanup_fail_line" -lt "$results_line" ]; then
  pass "cleanup failure is counted before the final result summary"
else
  fail "cleanup can still print a false all-passed summary"
fi

exit "$FAIL"
