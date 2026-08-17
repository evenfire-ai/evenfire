#!/usr/bin/env bash
set -u

FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="${ROOT}/scripts/e2e"
GATE="${SCRIPT_DIR}/e2e-hcc-communicationchannel-watch-recovery.sh"
LOCK_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
LOG_HELPER="${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
MOCK_STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-lock-test.XXXXXX")"
MOCK_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/hcc-log-test.XXXXXX")"
rm -f "$MOCK_STATE_FILE"
trap 'rm -f "$MOCK_STATE_FILE" "$MOCK_LOG_FILE"' EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

for script in "$GATE" "$LOCK_HELPER" "$LOG_HELPER"; do
  if bash -n "$script"; then
    pass "$(basename "$script") has valid bash syntax"
  else
    fail "$(basename "$script") has invalid bash syntax"
  fi
done

# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-logs.sh
source "$LOG_HELPER"
HCC_LOG_BUFFER="$MOCK_LOG_FILE"
START_TIME=2026-07-14T00:00:00Z
HOST_NS=mcp-host

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

acquire_line="$(grep -nF 'acquire_hcc_watch_gate_lock || die' "$GATE" | cut -d: -f1)"
# Literal source-code assertion.
# shellcheck disable=SC2016
mutation_line="$(grep -nF 'kctl get deployment "$HCC_DEPLOY"' "$GATE" | head -1 | cut -d: -f1)"
# Literal source-code assertion.
# shellcheck disable=SC2016
if [ -n "$acquire_line" ] && [ -n "$mutation_line" ] && [ "$acquire_line" -lt "$mutation_line" ] &&
   grep -Fq 'finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1' "$GATE"; then
  pass "gate acquires before HCC access and finalizes ownership from cleanup"
else
  fail "gate lock is not held across the full HCC fault-injection window"
fi

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

cleanup_fail_line="$(grep -nF 'fail "fixture cleanup, HCC restoration, or lock finalization did not complete' "$GATE" | cut -d: -f1)"
results_line="$(grep -nF '  print_results' "$GATE" | head -1 | cut -d: -f1)"
if [ -n "$cleanup_fail_line" ] && [ -n "$results_line" ] && [ "$cleanup_fail_line" -lt "$results_line" ]; then
  pass "cleanup failure is counted before the final result summary"
else
  fail "cleanup can still print a false all-passed summary"
fi

exit "$FAIL"
