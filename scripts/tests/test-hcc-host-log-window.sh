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
# #1489: the first line each container's current log file returns with
# --timestamps, per container (MOCK_OLDEST_<name with - as _>); empty = no log.
MOCK_OLDEST_mcp_host=''
MOCK_OLDEST_sidecar=''
MOCK_FAIL_TIMESTAMPS=0

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
        *--timestamps*)
          [ "$MOCK_FAIL_TIMESTAMPS" = 1 ] && return 1
          local container_name="" next=0 arg oldest_var
          for arg in "$@"; do
            if [ "$next" = 1 ]; then container_name="$arg"; next=0; fi
            [ "$arg" = "-c" ] && next=1
          done
          oldest_var="MOCK_OLDEST_${container_name//-/_}"
          if [ -n "${!oldest_var:-}" ]; then
            printf '%s\n' "${!oldest_var}"
            echo "2026-01-01T00:09:00.000000000Z a later line"
          fi
          ;;
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

# (l) no BSD-only date call is left in the lane or the helper. grep exits 2 on
# a missing file, which `if !` would read as "no match", so each scanned file
# must exist and grep must exit exactly 1.
LANE="${ROOT}/scripts/e2e/e2e-hcc-restart-fleet-continuity.sh"
if [ ! -f "$LANE" ] || [ ! -f "$HELPER" ]; then
  fail "(l) a scanned file is missing: lane=$([ -f "$LANE" ] && echo present || echo missing) helper=$([ -f "$HELPER" ] && echo present || echo missing)"
else
  grep -nE 'date .*-r ' "$LANE" "$HELPER" >"${WORK}/date-r"
  date_r_status=$?
  if [ "$date_r_status" = 1 ]; then
    pass "(l) the lane and the helper use no BSD-only date flag"
  else
    fail "(l) BSD-only date flag or grep error (status ${date_r_status}): $(cat "${WORK}/date-r")"
  fi
fi

# ─── #1489: the current log file must reach back to the window start ───
TWO_CONTAINERS='{"items":[{"metadata":{"name":"host-a-1"},"spec":{"initContainers":[{"name":"sidecar","restartPolicy":"Always"}]},"status":{"phase":"Running","containerStatuses":[{"name":"mcp-host","restartCount":0,"state":{"running":{"startedAt":"'"$BEFORE"'"}}}],"initContainerStatuses":[{"name":"sidecar","restartCount":0,"state":{"running":{"startedAt":"'"$BEFORE"'"}}}]}}]}'

# (m) the first line of the current log file is inside the window: fails.
MOCK_PODS="{\"items\":[$(pod host-a-1 "$BEFORE" 0)]}"
MOCK_OLDEST_mcp_host='2026-01-01T00:01:00.123456789Z first line after a rotation'
run_case
MOCK_OLDEST_mcp_host=''
if [ "$STATUS" != 0 ] && grep -q "container mcp-host starts at 2026-01-01T00:01:00Z, inside the window" "${WORK}/stderr" &&
   [ -s "${EVIDENCE_DIR}/host-host-a-mcp-host-oldest.log" ] && ! grep -q -- "--since-time" "$CALLS"; then
  pass "(m) a log file that starts inside the window fails, the oldest line is saved, and no window read happens"
else
  fail "(m) rotated log: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

# (n) a quiet Host whose log file starts before the window is covered.
MOCK_OLDEST_mcp_host='2025-12-31T22:00:00.5Z boot line'
run_case
MOCK_OLDEST_mcp_host=''
if [ "$STATUS" = 0 ] && [ "$(grep -c -- "--timestamps" "$CALLS")" = 1 ] &&
   [ "$(grep -n -- "--timestamps" "$CALLS" | cut -d: -f1)" -lt "$(grep -n -- "--since-time" "$CALLS" | cut -d: -f1)" ] &&
   [ ! -e "${EVIDENCE_DIR}/host-host-a-mcp-host-oldest.log" ]; then
  pass "(n) a log file older than the window is covered: one --timestamps read, then the window read"
else
  fail "(n) old log file: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

# (o) a container that has logged nothing is covered.
run_case
if [ "$STATUS" = 0 ] && grep -q -- "-c mcp-host --timestamps" "$CALLS" && grep -q -- "--since-time" "$CALLS"; then
  pass "(o) an empty log is covered, and its --timestamps read happened"
else
  fail "(o) empty log: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS")"
fi

# (p) an unparsable first timestamp fails.
MOCK_OLDEST_mcp_host='garbage without a timestamp'
run_case
MOCK_OLDEST_mcp_host=''
if [ "$STATUS" != 0 ] && grep -q "has no parsable timestamp" "${WORK}/stderr" && ! grep -q -- "--since-time" "$CALLS"; then
  pass "(p) an unparsable first timestamp fails"
else
  fail "(p) unparsable timestamp: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (q) a failed per-container read fails.
MOCK_FAIL_TIMESTAMPS=1
run_case
MOCK_FAIL_TIMESTAMPS=0
if [ "$STATUS" != 0 ] && grep -q "could not read the log of container mcp-host" "${WORK}/stderr" &&
   grep -q -- "--timestamps" "$CALLS" && ! grep -q -- "--since-time" "$CALLS"; then
  pass "(q) a failed per-container read fails"
else
  fail "(q) failed per-container read: status=${STATUS} stderr=$(cat "${WORK}/stderr")"
fi

# (r) two containers, the second one rotated: fails (the loop does not stop at the first).
MOCK_PODS="$TWO_CONTAINERS"
MOCK_OLDEST_mcp_host='2025-12-31T22:00:00Z boot line'
MOCK_OLDEST_sidecar='2026-01-01T00:02:00Z first line after a rotation'
run_case
MOCK_OLDEST_mcp_host=''
MOCK_OLDEST_sidecar=''
if [ "$STATUS" != 0 ] && grep -q "container sidecar starts at" "${WORK}/stderr" &&
   [ "$(grep -c -- "--timestamps" "$CALLS")" = 2 ] && [ -s "${EVIDENCE_DIR}/host-host-a-sidecar-oldest.log" ]; then
  pass "(r) the second container's rotated log fails the window"
else
  fail "(r) second container rotated: status=${STATUS} calls=$(tr '\n' ';' <"$CALLS") stderr=$(cat "${WORK}/stderr")"
fi

if [ "$TOTAL" -lt 19 ]; then
  echo "FAIL: expected at least 19 checks, ran ${TOTAL}"
  exit 1
fi
if [ "$FAIL" != 0 ]; then
  echo "test-hcc-host-log-window: FAILED (${TOTAL} checks)"
  exit 1
fi
echo "test-hcc-host-log-window: PASSED (${TOTAL} checks)"
