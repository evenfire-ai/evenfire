#!/usr/bin/env bash
# Cluster-free tests for scripts/e2e/_lib/hcc-node-kill.sh (issue #1338): the
# mid-pass watcher reads every line written after ARMED, ignores a line written
# before the script started, and leaves no tail behind after a kill. The script
# runs under /bin/sh and, when present, /bin/dash (the minikube node runs it
# with sh). crictl and timeout are stubs; tail, wc and pkill are the host's.
set -u

FAIL=0
TOTAL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${HCC_NODE_KILL_SCRIPT:-${ROOT}/scripts/e2e/_lib/hcc-node-kill.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hcc-node-kill-test.XXXXXX")"
VICTIMS=()
cleanup() {
  local pid
  for pid in ${VICTIMS[@]+"${VICTIMS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { TOTAL=$((TOTAL + 1)); echo "PASS: $1"; }
fail() { TOTAL=$((TOTAL + 1)); echo "FAIL: $1"; FAIL=1; }

STUBS="${WORK}/stubs"
mkdir -p "$STUBS"
# crictl: one running container (or STUB_IDS), whose pid and log path the test chose.
cat >"${STUBS}/crictl" <<'STUB'
#!/bin/sh
case "$1" in
  ps) printf '%s\n' "${STUB_IDS:-c0ffee}" ;;
  inspect)
    case "$*" in
      *'.info.pid'*) printf '%s\n' "$STUB_PID" ;;
      *'.status.logPath'*) printf '%s\n' "$STUB_LOG" ;;
    esac
    ;;
esac
STUB
# timeout SEC CMD...: records CMD, appends STUB_GAP_LINE to the log first when set
# (the moment between ARMED and the watcher opening the file), then runs CMD and
# kills it after SEC seconds.
cat >"${STUBS}/timeout" <<'STUB'
#!/bin/sh
sec=$1
shift
echo "$*" >>"$STUB_CALLS"
# STUB_TIMEOUT_FAIL: the watcher cannot run (timeout or tail missing).
[ -z "${STUB_TIMEOUT_FAIL:-}" ] || exit 127
[ -z "${STUB_GAP_LINE:-}" ] || printf '%s\n' "$STUB_GAP_LINE" >>"$STUB_LOG"
"$@" &
cpid=$!
sleep "$sec" >/dev/null 2>&1 &
spid=$!
while kill -0 "$cpid" 2>/dev/null; do
  if ! kill -0 "$spid" 2>/dev/null; then
    kill "$cpid" 2>/dev/null
    break
  fi
  sleep 0.1
done
kill "$spid" 2>/dev/null
wait "$cpid"
STUB
chmod +x "${STUBS}/crictl" "${STUBS}/timeout"

START_LINE='2026-11-13T10:00:00.000000000Z stdout F {"event":"networkpolicy-pass-start"}'
OTHER_LINE='2026-11-13T10:00:00.000000000Z stdout F {"event":"something-else"}'

# run_case <name> <shell> <mode> <bound-sec> [setup]
# setup: "gap" appends the start line between ARMED and the watcher, "after"
# appends it 1 s after the script started, "old" puts it in the log before the
# script starts. Results in ${WORK}/<name>/{out,status,secs,calls,size}.
run_case() {
  local name=$1 shell=$2 mode=$3 bound=$4 setup=${5:-} dir victim started ended writer=""
  dir="${WORK}/${name}"
  mkdir -p "$dir"
  printf '%s\n' "$OTHER_LINE" >"${dir}/container.log"
  [ "$setup" != old ] || printf '%s\n' "$START_LINE" >>"${dir}/container.log"
  wc -c <"${dir}/container.log" | tr -d ' ' >"${dir}/size"
  : >"${dir}/calls"
  sleep 300 &
  victim=$!
  VICTIMS+=("$victim")
  echo "$victim" >"${dir}/victim"
  if [ "$setup" = after ]; then
    (sleep 1 && printf '%s\n' "$START_LINE" >>"${dir}/container.log") &
    writer=$!
  fi
  started=$(date +%s)
  STUB_PID="${STUB_PID_OVERRIDE:-$victim}" STUB_LOG="${dir}/container.log" STUB_CALLS="${dir}/calls" \
    STUB_GAP_LINE="$([ "$setup" != gap ] || printf '%s' "$START_LINE")" \
    PATH="${STUBS}:${PATH}" "$shell" "$SCRIPT" "$mode" "$bound" >"${dir}/out" 2>&1
  echo $? >"${dir}/status"
  ended=$(date +%s)
  echo $((ended - started)) >"${dir}/secs"
  [ -z "$writer" ] || wait "$writer" 2>/dev/null
}

alive() { kill -0 "$(cat "${WORK}/$1/victim")" 2>/dev/null; }
tails_left() { pgrep -f "tail .*${WORK}/$1/container.log" >/dev/null; }
# The witness for every negative below: the watcher ran exactly once, from the
# byte after the log as it was when the script started.
watcher_ran_from_start() {
  local expected
  expected="tail -c +$(($(cat "${WORK}/$1/size") + 1)) -F ${WORK}/$1/container.log"
  [ "$(wc -l <"${WORK}/$1/calls" | tr -d ' ')" = 1 ] && [ "$(cat "${WORK}/$1/calls")" = "$expected" ]
}
show() { echo "status=$(cat "${WORK}/$1/status") secs=$(cat "${WORK}/$1/secs") calls=[$(tr '\n' ';' <"${WORK}/$1/calls")] out=[$(tr '\n' ';' <"${WORK}/$1/out")]"; }

if sh -n "$SCRIPT"; then pass "hcc-node-kill.sh has valid sh syntax"; else fail "hcc-node-kill.sh has invalid sh syntax"; fi

# The start position must be fixed before ARMED is printed.
offset_line=$(grep -n '^ *start=\$((\$(wc -c' "$SCRIPT" | head -1 | cut -d: -f1)
armed_line=$(grep -n 'echo "ARMED log=' "$SCRIPT" | head -1 | cut -d: -f1)
if [ -n "$offset_line" ] && [ -n "$armed_line" ] && [ "$offset_line" -lt "$armed_line" ]; then
  pass "the watcher's start byte is taken before ARMED is printed (lines ${offset_line} < ${armed_line})"
else
  fail "the watcher's start byte must be taken before ARMED is printed: start='${offset_line}' ARMED='${armed_line}'"
fi

SHELLS=(/bin/sh)
[ ! -x /bin/dash ] || SHELLS+=(/bin/dash)
for shell in "${SHELLS[@]}"; do
  tag=$(basename "$shell")

  for setup in gap after; do
    name="${tag}-${setup}"
    run_case "$name" "$shell" mid-pass 20 "$setup"
    if [ "$(cat "${WORK}/${name}/status")" = 0 ] && grep -q '^ARMED log=' "${WORK}/${name}/out" &&
      grep -q '^KILLED pid=' "${WORK}/${name}/out" && ! alive "$name" &&
      [ "$(cat "${WORK}/${name}/secs")" -le 5 ] && watcher_ran_from_start "$name" && ! tails_left "$name"; then
      pass "${tag}: a pass start written ${setup} ARMED kills the controller, ends within 5 s of a 20 s bound and leaves no tail"
    else
      fail "${tag}: pass start ${setup} ARMED: $(show "$name") victim_alive=$(alive "$name" && echo yes || echo no) tail_left=$(tails_left "$name" && echo yes || echo no)"
    fi
  done

  for setup in none old; do
    name="${tag}-${setup}"
    run_case "$name" "$shell" mid-pass 2 "$setup"
    if [ "$(cat "${WORK}/${name}/status")" = 3 ] && grep -qx 'NO_PASS_START' "${WORK}/${name}/out" &&
      alive "$name" && watcher_ran_from_start "$name"; then
      pass "${tag}: no pass start after ARMED (${setup}) is NO_PASS_START, exit 3, controller alive, watcher ran"
    else
      fail "${tag}: no pass start (${setup}): $(show "$name")"
    fi
  done

  name="${tag}-watcher-fails"
  STUB_TIMEOUT_FAIL=1 run_case "$name" "$shell" mid-pass 20
  if [ "$(cat "${WORK}/${name}/status")" = 2 ] &&
    grep -q '^KILL_ERROR watcher ended after [0-9]*s of 20s without a pass start' "${WORK}/${name}/out" &&
    ! grep -q 'NO_PASS_START' "${WORK}/${name}/out" && alive "$name" && watcher_ran_from_start "$name"; then
    pass "${tag}: a watcher that ends before its bound is a kill error, exit 2, not NO_PASS_START"
  else
    fail "${tag}: watcher that fails at once: $(show "$name")"
  fi

  name="${tag}-idle"
  run_case "$name" "$shell" idle 2
  if [ "$(cat "${WORK}/${name}/status")" = 0 ] && grep -q '^KILLED pid=' "${WORK}/${name}/out" &&
    ! alive "$name" && [ ! -s "${WORK}/${name}/calls" ]; then
    pass "${tag}: idle mode kills at once without a watcher"
  else
    fail "${tag}: idle mode: $(show "$name")"
  fi

  name="${tag}-two-ids"
  STUB_IDS="$(printf 'aaa\nbbb')" run_case "$name" "$shell" mid-pass 2
  if [ "$(cat "${WORK}/${name}/status")" = 2 ] && grep -q '^KILL_ERROR running host-context-controller containers=2' "${WORK}/${name}/out" &&
    alive "$name"; then
    pass "${tag}: two running containers are a lookup error, exit 2"
  else
    fail "${tag}: two containers: $(show "$name")"
  fi

  name="${tag}-bad-pid"
  STUB_PID_OVERRIDE=abc run_case "$name" "$shell" mid-pass 2
  if [ "$(cat "${WORK}/${name}/status")" = 2 ] && grep -q '^KILL_ERROR pid=abc' "${WORK}/${name}/out" &&
    alive "$name"; then
    pass "${tag}: a non-numeric pid is a lookup error, exit 2"
  else
    fail "${tag}: non-numeric pid: $(show "$name")"
  fi
done

EXPECTED=$((2 + 8 * ${#SHELLS[@]}))
if [ "$TOTAL" -lt "$EXPECTED" ] || [ "$TOTAL" -lt 10 ]; then
  echo "FAIL: expected at least ${EXPECTED} checks (and never fewer than 10), ran ${TOTAL}"
  FAIL=1
fi
if [ "$FAIL" != 0 ]; then
  echo "test-hcc-node-kill: FAILED (${TOTAL} checks)"
  exit 1
fi
echo "test-hcc-node-kill: PASSED (${TOTAL} checks)"
