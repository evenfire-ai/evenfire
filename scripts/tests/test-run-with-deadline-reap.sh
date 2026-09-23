#!/usr/bin/env bash
# The runner's final process-group reap must not replace the wrapped command's
# status when the kernel refuses the SIGKILL with EPERM because the group is
# already exiting (macOS), and must still fail loud when the refused group is
# alive. The EPERM is injected by a preload, because the kernel race cannot be
# produced on demand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RUNNER="$ROOT/scripts/minikube/run-with-deadline.mjs"
PRELOAD="$ROOT/scripts/tests/fixtures/run-with-deadline/deny-group-sigkill.mjs"
TMP_DIR="$(mktemp -d)"
LEFTOVER_PIDS=()
# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  local pid
  for pid in "${LEFTOVER_PIDS[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

FAIL=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=1; }

run_denied() {
  local label="$1" deny_log="$2" output="$3"
  shift 3
  DENY_GROUP_SIGKILL_LOG="$deny_log" node --import "$PRELOAD" "$RUNNER" \
    --heartbeat-seconds 1 --label "$label" "$@" >"$output" 2>&1
}

assert_denied_reap_after_exit_keeps_the_child_status() {
  local output="$TMP_DIR/exit.out" deny_log="$TMP_DIR/exit.deny" status=0
  : >"$deny_log"
  run_denied denied-exit "$deny_log" "$output" \
    --timeout-seconds 10 --kill-grace-seconds 1 -- bash -c 'exit 7' || status=$?

  if [[ "$status" -eq 7 ]] && grep -Fq 'denied pgid=' "$deny_log" \
    && grep -Fq 'event=exit' "$output" && grep -Fq 'exitCode=7' "$output" \
    && grep -Fq 'event=reap-permission-denied' "$output" \
    && grep -Fq 'groupGone=true' "$output" \
    && ! grep -Fq 'event=reap-failed' "$output"; then
    pass "an EPERM reap of an exited group keeps the child's exit status 7"
  else
    fail "denied reap after exit (status=$status denials=$(wc -l <"$deny_log" | tr -d ' ')): $(cat "$output")"
  fi
}

assert_denied_reap_after_timeout_keeps_the_timeout_status() {
  local output="$TMP_DIR/timeout.out" deny_log="$TMP_DIR/timeout.deny" status=0
  : >"$deny_log"
  run_denied denied-timeout "$deny_log" "$output" \
    --timeout-seconds 1 --kill-grace-seconds 1 -- sleep 30 || status=$?

  if [[ "$status" -eq 124 ]] && grep -Fq 'denied pgid=' "$deny_log" \
    && grep -Fq 'event=timeout' "$output" \
    && grep -Fq 'event=reap-permission-denied' "$output" \
    && grep -Fq 'groupGone=true' "$output" \
    && grep -Fq 'event=terminated' "$output" \
    && ! grep -Fq 'event=reap-failed' "$output"; then
    pass "an EPERM reap after a SIGTERM teardown keeps the timeout status 124"
  else
    fail "denied reap after timeout (status=$status denials=$(wc -l <"$deny_log" | tr -d ' ')): $(cat "$output")"
  fi
}

assert_denied_reap_of_a_live_group_fails_loud() {
  local output="$TMP_DIR/live.out" deny_log="$TMP_DIR/live.deny"
  local pid_file="$TMP_DIR/live.pid" status=0 descendant="" alive_after=false
  : >"$deny_log"
  rm -f -- "$pid_file"
  # Positional values and $! belong to the child shell.
  # shellcheck disable=SC2016
  run_denied denied-live "$deny_log" "$output" \
    --timeout-seconds 10 --kill-grace-seconds 1 -- \
    bash -c 'sleep 30 & printf "%s\n" "$!" >"$1"; exit 0' _ "$pid_file" || status=$?
  if [[ -s "$pid_file" ]]; then
    descendant="$(cat "$pid_file")"
    LEFTOVER_PIDS+=("$descendant")
    kill -0 "$descendant" 2>/dev/null && alive_after=true
  fi

  # The descendant still running after the runner returned is the witness that
  # the group really was alive, so the non-zero status is the refused reap and
  # not the wrapped command.
  if [[ "$status" -ne 0 && "$alive_after" == true ]] \
    && grep -Fq 'denied pgid=' "$deny_log" \
    && grep -Fq 'event=exit' "$output" && grep -Fq 'exitCode=0' "$output" \
    && grep -Fq 'event=reap-failed' "$output" && grep -Fq 'reason=EPERM' "$output" \
    && ! grep -Fq 'event=reap-permission-denied' "$output"; then
    pass "an EPERM reap of a group that is still alive fails loud (status=$status)"
  else
    fail "denied reap of a live group (status=$status descendant=${descendant:-missing} alive=$alive_after): $(cat "$output")"
  fi
}

assert_an_undenied_reap_reports_no_permission_event() {
  local output="$TMP_DIR/control.out" status=0
  node "$RUNNER" --timeout-seconds 10 --heartbeat-seconds 1 --kill-grace-seconds 1 \
    --label control-exit -- bash -c 'exit 7' >"$output" 2>&1 || status=$?

  if [[ "$status" -eq 7 ]] && grep -Fq 'event=exit' "$output" \
    && grep -Fq 'exitCode=7' "$output" \
    && ! grep -Fq 'event=reap-' "$output"; then
    pass "without a refused SIGKILL the reap adds no event and keeps status 7"
  else
    fail "control exit (status=$status): $(cat "$output")"
  fi
}

assert_every_defined_case_is_invoked() {
  local self defined invoked missing
  self="$ROOT/scripts/tests/test-run-with-deadline-reap.sh"
  defined="$(grep -oE '^assert_[a-z_]+\(\) \{' "$self" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^assert_[a-z_]+$' "$self" | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    fail "defined but never invoked: ${missing//$'\n'/ }"
  fi
}

assert_denied_reap_after_exit_keeps_the_child_status
assert_denied_reap_after_timeout_keeps_the_timeout_status
assert_denied_reap_of_a_live_group_fails_loud
assert_an_undenied_reap_reports_no_permission_event
assert_every_defined_case_is_invoked

exit "$FAIL"
