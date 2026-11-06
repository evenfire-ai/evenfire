#!/usr/bin/env bash
# Cluster-free tests for scripts/e2e/_lib/host-log-window.sh (issue #1338):
# a Host log read counts only when it provably covers the whole window.
set -u

FAIL=0
TOTAL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="${ROOT}/scripts/e2e/_lib/host-log-window.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/host-log-window-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass() { TOTAL=$((TOTAL + 1)); echo "PASS: $1"; }
fail() { TOTAL=$((TOTAL + 1)); echo "FAIL: $1"; FAIL=1; }

if bash -n "$HELPER"; then pass "host-log-window.sh has valid bash syntax"; else fail "host-log-window.sh has invalid bash syntax"; fi
# shellcheck source=scripts/e2e/_lib/host-log-window.sh
source "$HELPER"

HOST_NS=mcp-host
EVIDENCE_DIR="${WORK}/evidence"
mkdir -p "$EVIDENCE_DIR"
CALLS="${WORK}/kctl-calls"
SINCE=1767225600 # 2026-01-01T00:00:00Z
BEFORE='2025-12-31T23:00:00Z'
AFTER='2026-01-01T00:05:00Z'

DEPLOYMENT='{"spec":{"selector":{"matchLabels":{"app":"host-a"}}}}'
MOCK_PODS=''
MOCK_PODS_AFTER_LOGS=''
MOCK_FAIL_LIST=0
MOCK_FAIL_LOGS=0
MOCK_LOG_LINES=0

# Stub: serves fixture JSON and logs, records every call.
kctl() {
  echo "$*" >>"$CALLS"
  case "$1 $2" in
    "get deployment/host-a") printf '%s\n' "$DEPLOYMENT" ;;
    "get pods")
      [ "$MOCK_FAIL_LIST" = 1 ] && return 1
      if [ -n "$MOCK_PODS_AFTER_LOGS" ] && grep -q "^logs pod/" "$CALLS"; then
        printf '%s\n' "$MOCK_PODS_AFTER_LOGS"
      else
        printf '%s\n' "$MOCK_PODS"
      fi
      ;;
    "logs pod/"*)
      case "$*" in
        *--previous*) echo "previous container line" ;;
        *)
          [ "$MOCK_FAIL_LOGS" = 1 ] && return 1
          local line
          for ((line = 0; line < MOCK_LOG_LINES; line++)); do echo "log line ${line}"; done
          ;;
      esac
      ;;
    *) echo "unexpected kctl call: $*" >&2; return 1 ;;
  esac
}

pod() {
  local name="$1" started="$2" restarts="$3" phase="${4:-Running}"
  printf '{"metadata":{"name":"%s"},"spec":{"containers":[{"name":"mcp-host"}]},"status":{"phase":"%s","containerStatuses":[{"name":"mcp-host","restartCount":%s,"state":{"running":{"startedAt":"%s"}}}]}}' \
    "$name" "$phase" "$restarts" "$started"
}

run_case() {
  : >"$CALLS"
  rm -f "${EVIDENCE_DIR}"/*
  OUT="${WORK}/out.log"
  rm -f "$OUT"
  STDOUT="$(read_host_log_window host-a "$SINCE" "$OUT" 2>"${WORK}/stderr")"
  STATUS=$?
}

# (a) one pod, running since before the window, quiet: passes, with coverage.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$BEFORE" 0)]}"
run_case
if [ "$STATUS" = 0 ] && [[ "$STDOUT" == "covered: pod host-a-1, containers started mcp-host=${BEFORE}, 0 lines" ]] &&
   [ -f "$OUT" ] && [ ! -s "$OUT" ] &&
   grep -q "^logs pod/host-a-1 -n mcp-host --all-containers=true --since-time=2025-12-31T23:59:30Z$" "$CALLS"; then
  pass "(a) a quiet Host whose only process ran across the window is covered, and its log was read"
else
  fail "(a) quiet covered Host: status=${STATUS} stdout='${STDOUT}' calls=$(tr '\n' ';' <"$CALLS")"
fi

# (b) the container restarted inside the window: fails, saves --previous.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$AFTER" 1)]}"
run_case
if [ "$STATUS" != 0 ] && grep -q "restarted inside the window" "${WORK}/stderr" &&
   [ -s "${EVIDENCE_DIR}/host-host-a-mcp-host-previous.log" ] && ! grep -q -- "--since-time" "$CALLS"; then
  pass "(b) a restart inside the window fails and its previous log is saved"
else
  fail "(b) restart inside the window: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (c) two pods (a rollout): fails.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$BEFORE" 0),$(pod host-a-2 "$BEFORE" 0)]}"
run_case
if [ "$STATUS" != 0 ] && grep -q "has 2 pods" "${WORK}/stderr" && ! grep -q "^logs" "$CALLS"; then
  pass "(c) two pods fail"
else
  fail "(c) two pods: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (d) the pod list read fails: fails.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$BEFORE" 0)]}"
MOCK_FAIL_LIST=1
run_case
MOCK_FAIL_LIST=0
if [ "$STATUS" != 0 ] && grep -q "could not list the pods" "${WORK}/stderr" && grep -q "^get pods" "$CALLS"; then
  pass "(d) a failed pod list fails"
else
  fail "(d) failed pod list: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (e) the log read fails: fails.
MOCK_FAIL_LOGS=1
MOCK_LOG_LINES=3
run_case
MOCK_FAIL_LOGS=0
MOCK_LOG_LINES=0
if [ "$STATUS" != 0 ] && grep -q "could not read the log of host-a-1" "${WORK}/stderr" &&
   grep -q "^logs pod/host-a-1" "$CALLS"; then
  pass "(e) a failed log read fails"
else
  fail "(e) failed log read: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (f) a replaced pod (started inside the window, no restart): fails, no --previous.
MOCK_PODS="{\"items\":[$(pod host-a-2 "$AFTER" 0)]}"
run_case
if [ "$STATUS" != 0 ] && grep -q "started inside the window" "${WORK}/stderr" &&
   grep -q "^get pods" "$CALLS" && ! grep -q -- "--previous" "$CALLS"; then
  pass "(f) a replaced pod fails without a --previous read"
else
  fail "(f) replaced pod: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

# (g) a native sidecar restarted inside the window: fails.
MOCK_PODS='{"items":[{"metadata":{"name":"host-a-1"},"spec":{"initContainers":[{"name":"sidecar","restartPolicy":"Always"},{"name":"setup"}]},"status":{"phase":"Running","containerStatuses":[{"name":"mcp-host","restartCount":0,"state":{"running":{"startedAt":"'"$BEFORE"'"}}}],"initContainerStatuses":[{"name":"setup","restartCount":0,"state":{"terminated":{"exitCode":0}}},{"name":"sidecar","restartCount":2,"state":{"running":{"startedAt":"'"$AFTER"'"}}}]}}]}'
run_case
if [ "$STATUS" != 0 ] && grep -q "container sidecar restarted inside the window" "${WORK}/stderr" &&
   [ -s "${EVIDENCE_DIR}/host-host-a-sidecar-previous.log" ]; then
  pass "(g) a native sidecar restart inside the window fails; a completed init container is ignored"
else
  fail "(g) native sidecar: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (h) a terminating pod: fails.
MOCK_PODS='{"items":[{"metadata":{"name":"host-a-1","deletionTimestamp":"'"$AFTER"'"},"status":{"phase":"Running","containerStatuses":[{"name":"mcp-host","restartCount":0,"state":{"running":{"startedAt":"'"$BEFORE"'"}}}]}}]}'
run_case
if [ "$STATUS" != 0 ] && grep -q "terminating or not Running" "${WORK}/stderr"; then
  pass "(h) a terminating pod fails"
else
  fail "(h) terminating pod: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (i) a start less than the clock margin before the window is not covered.
MOCK_PODS="{\"items\":[$(pod host-a-1 '2025-12-31T23:59:50Z' 0)]}"
run_case
if [ "$STATUS" != 0 ] && grep -q "started inside the window" "${WORK}/stderr" && grep -q "^get pods" "$CALLS" &&
   ! grep -q "^logs" "$CALLS"; then
  pass "(i) a start 10 s before the window is not covered: the clocks may differ by the margin"
else
  fail "(i) start inside the margin: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

# (j) a container restarts while the log is read: fails.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$BEFORE" 0)]}"
MOCK_PODS_AFTER_LOGS="{\"items\":[$(pod host-a-1 "$AFTER" 1)]}"
run_case
MOCK_PODS_AFTER_LOGS=''
if [ "$STATUS" != 0 ] && grep -q "changed while its log was read" "${WORK}/stderr" &&
   grep -q "^logs pod/host-a-1" "$CALLS" && [ "$(grep -c "^get pods" "$CALLS")" = 2 ]; then
  pass "(j) a pod that changed while its log was read fails, and it was read again after the log"
else
  fail "(j) changed during the read: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

# (k) the epoch formatter works without a BSD-only date flag.
if [ "$(epoch_to_utc 1767225600)" = "2026-01-01T00:00:00Z" ]; then
  pass "(k) epoch_to_utc formats an epoch in UTC"
else
  fail "(k) epoch_to_utc 1767225600 gave '$(epoch_to_utc 1767225600)'"
fi

# (l) no BSD-only date call is left in the lane or the helper.
if ! grep -nE 'date .*-r ' "${ROOT}/scripts/e2e/e2e-hcc-restart-fleet-continuity.sh" "$HELPER" >"${WORK}/date-r"; then
  pass "(l) the lane and the helper use no BSD-only date flag"
else
  fail "(l) BSD-only date flag: $(cat "${WORK}/date-r")"
fi

if [ "$TOTAL" -lt 13 ]; then
  echo "FAIL: expected at least 13 checks, ran ${TOTAL}"
  exit 1
fi
if [ "$FAIL" != 0 ]; then
  echo "test-hcc-host-log-window: FAILED (${TOTAL} checks)"
  exit 1
fi
echo "test-hcc-host-log-window: PASSED (${TOTAL} checks)"
