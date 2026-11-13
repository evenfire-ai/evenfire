#!/usr/bin/env bash
# Cluster-free tests for scripts/e2e/e2e-hcc-restart-fleet-continuity.sh
# (issue #1338). The lane's own functions are extracted from the script at test
# time, so a test fails when the lane changes, and every cluster call is a stub.
#
#   teardown   a signal to the lane's process group (SIGTERM, SIGHUP, SIGINT)
#              or to its main PID runs every cleanup step and finalizes the lock
#   pipefail   host_received_fixture_fleet finds its line in a log larger than
#              a pipe buffer
#   C3         judge_write refuses a new issued-at over unchanged token data
#   C7         the revocation lines C7 looks for still exist in mcp-host
set -u

FAIL=0
TOTAL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LANE="${HCC_CONTINUITY_LANE:-${ROOT}/scripts/e2e/e2e-hcc-restart-fleet-continuity.sh}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hcc-continuity-lane-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass() { TOTAL=$((TOTAL + 1)); echo "PASS: $1"; }
fail() { TOTAL=$((TOTAL + 1)); echo "FAIL: $1"; FAIL=1; }

[ -f "$LANE" ] || { echo "FAIL: lane script ${LANE} is missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required"; exit 1; }

# extract_function <name>: prints `name() {` through the first line that is
# `}`, or the single line of a one-line definition `name() { ...; }`.
extract_function() {
  awk -v start="$1() {" '
    !found && index($0, start) == 1 {
      found = 1
      print
      if ($0 != start && $0 ~ /}$/) exit
      next
    }
    found { print }
    found && $0 == "}" { exit }
  ' "$LANE"
}

for fn in die start_sampler stop_sampler teardown host_received_fixture_fleet run_mid_pass_attempts kill_hcc; do
  extract_function "$fn" >"${WORK}/fn-${fn}.sh"
  if [ -s "${WORK}/fn-${fn}.sh" ] && [[ "$(tail -n 1 "${WORK}/fn-${fn}.sh")" == *"}" ]]; then
    pass "extracted ${fn} from the lane"
  else
    fail "could not extract ${fn} from ${LANE}"
  fi
done

# ─── teardown under signals ───────────────────────────────────────────
# The harness installs the trap line taken from the lane. A lane without it
# gives a harness without a trap, and every case below fails.
LANE_TRAP="${WORK}/lane-trap.sh"
grep -x 'trap teardown EXIT' "$LANE" >"$LANE_TRAP" || true
if [ "$(wc -l <"$LANE_TRAP" | tr -d ' ')" = 1 ]; then
  pass "the lane installs 'trap teardown EXIT' exactly once"
else
  fail "the lane must contain the line 'trap teardown EXIT' exactly once, found $(wc -l <"$LANE_TRAP" | tr -d ' ')"
fi
HARNESS="${WORK}/teardown-harness.sh"
{
  cat <<'EOF'
set -euo pipefail
RED=''
NC=''
STEPS="$1"
READY="$2"
EVIDENCE_DIR="$3"
SERIES="${EVIDENCE_DIR}/series.tsv"
SAMPLER_STOP="${EVIDENCE_DIR}/sampler.stop"
SAMPLER_PID=""
FIXTURES_CREATED=1
HOST_NS=mcp-host
MCP_NS=mcp-server
MCP_FIXTURE=fixture
SUSPENDED_HOST=host-suspended
ACTIVE_HOST=host-active
RUN_LABEL=run
E2E_KUBECONTEXT=branch-context
NODE_KILL_PATH=/tmp/node-kill.sh
MINIKUBE_BIN=minikube_stub
kctl() { echo "kctl $*" >>"$STEPS"; }
minikube_stub() { echo "minikube $*" >>"$STEPS"; }
wait_until() { echo "wait_until $2" >>"$STEPS"; }
restore_cadences() { echo "restore_cadences" >>"$STEPS"; }
finalize_hcc_watch_gate_lock() { echo "FINALIZE_LOCK cleanup_failed=$1 restore_ok=$2" >>"$STEPS"; }
pod_ready_by_selector() { echo true; }
condition_status() { echo True; }
host_state() { echo active; }
EOF
  cat "${WORK}/fn-die.sh" "${WORK}/fn-start_sampler.sh" "${WORK}/fn-stop_sampler.sh" "${WORK}/fn-teardown.sh"
  cat "$LANE_TRAP"
} >"${WORK}/teardown-prelude.sh"
{
  cat "${WORK}/teardown-prelude.sh"
  cat <<'EOF'
start_sampler selector
echo "SAMPLER_STARTED" >>"$STEPS"
: >"$READY"
# A foreground sleep, as the lane's settle window is.
sleep 30
EOF
} >"$HARNESS"
# Normal exit with a sampler whose process ended with status $4.
SAMPLER_HARNESS="${WORK}/sampler-harness.sh"
{
  cat "${WORK}/teardown-prelude.sh"
  cat <<'EOF'
(exit "$4") &
SAMPLER_PID=$!
echo "SAMPLER_STARTED" >>"$STEPS"
exit 0
EOF
} >"$SAMPLER_HARNESS"

# run_signal_case <mode>: group-TERM | group-HUP | group-INT | main-TERM.
# Prints the harness exit status (negative: killed by that signal).
run_signal_case() {
  local mode=$1
  rm -rf "${WORK}/case" && mkdir -p "${WORK}/case/evidence"
  python3 -I - "$BASH" "$HARNESS" "${WORK}/case/steps" "${WORK}/case/ready" "${WORK}/case/evidence" "$mode" <<'PY'
import os, signal, subprocess, sys, time
shell, harness, steps, ready, evidence, mode = sys.argv[1:7]
open(steps, "w").close()

def default_signals():
    # A shell cannot trap a signal that was ignored when it started; a lane run
    # from a terminal starts with these at their defaults.
    for name in ("SIGINT", "SIGHUP", "SIGTERM", "SIGQUIT"):
        signal.signal(getattr(signal, name), signal.SIG_DFL)

child = subprocess.Popen([shell, harness, steps, ready, evidence], start_new_session=True,
                         preexec_fn=default_signals,
                         stdout=open(steps + ".out", "w"), stderr=subprocess.STDOUT)
deadline = time.time() + 10
while not os.path.exists(ready):
    if time.time() > deadline or child.poll() is not None:
        print("NOT_READY")
        sys.exit(0)
    time.sleep(0.05)
time.sleep(0.3)
target, name = mode.split("-")
sig = getattr(signal, "SIG" + name)
if target == "group":
    os.killpg(child.pid, sig)
else:
    os.kill(child.pid, sig)
try:
    print(child.wait(timeout=20))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    print("TIMEOUT")
PY
}

CLEANUP_STEPS=(
  "kctl delete hosts -n mcp-host -l e2e.clerum.io/run=run --wait=true --timeout=180s"
  "kctl delete mcpservers,contexts -n mcp-server -l e2e.clerum.io/run=run --wait=true --timeout=180s"
  "wait_until fixture objects and their runtimes to be gone"
  "restore_cadences"
  "minikube -p branch-context ssh -- sudo rm -f /tmp/node-kill.sh"
  "FINALIZE_LOCK cleanup_failed=0 restore_ok=1"
)

for mode in group-TERM group-HUP group-INT main-TERM; do
  status="$(run_signal_case "$mode")"
  steps="${WORK}/case/steps"
  missing=()
  for step in "${CLEANUP_STEPS[@]}"; do
    grep -qxF "$step" "$steps" || missing+=("$step")
  done
  if grep -qxF "SAMPLER_STARTED" "$steps" && [ "${#missing[@]}" = 0 ] && [ "$status" != 0 ] &&
     [ "$status" != NOT_READY ] && [ "$status" != TIMEOUT ]; then
    pass "teardown after ${mode} runs every cleanup step and finalizes the lock (exit ${status})"
  else
    fail "teardown after ${mode}: exit=${status} missing=[${missing[*]+"${missing[*]}"}] steps=$(tr '\n' ';' <"$steps") output=$(tr '\n' ';' <"${steps}.out")"
  fi
done

# ─── teardown on a normal exit: the sampler's status decides ──────────
# The control (sampler status 0) shows that exit 1 below comes from the
# sampler and from nothing else in the harness.
for sampler_status in 0 1; do
  rm -rf "${WORK}/case" && mkdir -p "${WORK}/case/evidence"
  : >"${WORK}/case/steps"
  status=0
  "$BASH" "$SAMPLER_HARNESS" "${WORK}/case/steps" "${WORK}/case/ready" "${WORK}/case/evidence" "$sampler_status" \
    >"${WORK}/case/steps.out" 2>&1 || status=$?
  missing=()
  for step in "${CLEANUP_STEPS[@]}"; do
    grep -qxF "$step" "${WORK}/case/steps" || missing+=("$step")
  done
  sampler_line=0
  grep -qxF 'teardown: the sampler exited with an error' "${WORK}/case/steps.out" && sampler_line=1
  if grep -qxF "SAMPLER_STARTED" "${WORK}/case/steps" && [ "${#missing[@]}" = 0 ] &&
     [ "$status" = "$sampler_status" ] && [ "$sampler_line" = "$sampler_status" ]; then
    pass "normal exit with sampler status ${sampler_status}: every cleanup step ran, exit ${status}"
  else
    fail "normal exit with sampler status ${sampler_status}: exit=${status} sampler_line=${sampler_line} missing=[${missing[*]+"${missing[*]}"}] output=$(tr '\n' ';' <"${WORK}/case/steps.out")"
  fi
done

# ─── mid-pass attempts: NO_PASS_START is a failed attempt ─────────────
# run_mid_pass_case <kill_hcc results, one per attempt as rc:last-pass-event>
# Prints the subshell's exit status; the calls are in ${WORK}/mid/steps.
run_mid_pass_case() {
  rm -rf "${WORK}/mid" && mkdir -p "${WORK}/mid/evidence"
  : >"${WORK}/mid/steps"
  printf '%s\n' "$@" >"${WORK}/mid/plan"
  (
    set -euo pipefail
    RED='' NC=''
    STEPS="${WORK}/mid/steps"
    EVIDENCE_DIR="${WORK}/mid/evidence"
    MID_PASS_ATTEMPTS=3 KILL_EPOCH="" KILL_WATCH_SEC=60 KILLS=0 HCC_RESTARTS_BEFORE=4
    RESTART_WAIT_SEC=1 RECOVERY_BETWEEN_SEC=1 HCC_POD=""
    hcc_pod() { echo hcc-pod; }
    copy_node_kill_script() { echo "copy_node_kill_script" >>"$STEPS"; }
    kill_hcc() {
      local n line rc
      n=$(($(grep -c '^kill_hcc' "$STEPS" || true) + 1))
      echo "kill_hcc $1 attempt=${n}" >>"$STEPS"
      line="$(sed -n "${n}p" "${WORK}/mid/plan")"
      rc="${line%%:*}"
      [ "$rc" != 0 ] || KILLS=$((KILLS + 1))
      return "$rc"
    }
    wait_until() { echo "wait_until $2" >>"$STEPS"; }
    # The stamp of attempt N is 1000 + N - 1 (taken before its kill_hcc call).
    date() { echo "$((1000 + $(grep -c '^kill_hcc' "$STEPS" || true)))"; }
    save_killed_hcc_log() { echo "save_killed_hcc_log kills=${KILLS}" >>"$STEPS"; }
    last_pass_event() {
      local line
      line="$(sed -n "$(grep -c '^kill_hcc' "$STEPS")p" "${WORK}/mid/plan")"
      echo "${line#*:}"
    }
    # shellcheck disable=SC1090
    source "${WORK}/fn-die.sh"
    # shellcheck disable=SC1090
    source "${WORK}/fn-run_mid_pass_attempts.sh"
    run_mid_pass_attempts
    echo "RETURNED achieved=${achieved} kills=${KILLS} previous=${previous}" >>"$STEPS"
    echo "KILL_EPOCH=${KILL_EPOCH}" >>"$STEPS"
  ) >"${WORK}/mid/out" 2>&1
  echo $?
}
mid_steps() { tr '\n' ';' <"${WORK}/mid/steps"; }

status="$(run_mid_pass_case 3: 0:start)"
if [ "$status" = 0 ] && [ "$(grep -c '^kill_hcc' "${WORK}/mid/steps")" = 2 ] &&
   [ "$(grep -c '^wait_until HCC container restart' "${WORK}/mid/steps")" = 1 ] &&
   grep -qxF 'wait_until HCC container restart after attempt 2' "${WORK}/mid/steps" &&
   grep -qxF 'RETURNED achieved=1 kills=1 previous=start' "${WORK}/mid/steps" &&
   grep -qF 'attempt 1: no pass started' "${WORK}/mid/evidence/mid-pass.log"; then
  pass "mid-pass: NO_PASS_START on attempt 1 is a failed attempt, attempt 2 kills inside a pass"
else
  fail "mid-pass NO_PASS_START then kill: exit=${status} steps=$(mid_steps) output=$(tr '\n' ';' <"${WORK}/mid/out")"
fi
status="$(run_mid_pass_case 3: 3: 3:)"
if [ "$status" != 0 ] && [ "$(grep -c '^kill_hcc' "${WORK}/mid/steps")" = 3 ] &&
   ! grep -q '^RETURNED' "${WORK}/mid/steps" &&
   grep -qF 'no mid-pass attempt killed HCC' "${WORK}/mid/out"; then
  pass "mid-pass: three NO_PASS_START attempts end the lane, with no kill to verify (exit ${status})"
else
  fail "mid-pass all NO_PASS_START: exit=${status} steps=$(mid_steps) output=$(tr '\n' ';' <"${WORK}/mid/out")"
fi
status="$(run_mid_pass_case 2: 0:start)"
if [ "$status" != 0 ] && [ "$(grep -c '^kill_hcc' "${WORK}/mid/steps")" = 1 ] &&
   grep -qF 'mid-pass kill attempt 1 failed (rc=2)' "${WORK}/mid/out"; then
  pass "mid-pass: a kill failure other than NO_PASS_START still aborts at once (exit ${status})"
else
  fail "mid-pass rc=2: exit=${status} steps=$(mid_steps) output=$(tr '\n' ';' <"${WORK}/mid/out")"
fi
status="$(run_mid_pass_case 0:result 0:start)"
if [ "$status" = 0 ] && [ "$(grep -c '^kill_hcc' "${WORK}/mid/steps")" = 2 ] &&
   grep -qxF 'wait_until HCC ready before the next attempt' "${WORK}/mid/steps" &&
   grep -qxF 'RETURNED achieved=1 kills=2 previous=start' "${WORK}/mid/steps"; then
  pass "mid-pass: a kill outside a pass is followed by the next attempt, as before"
else
  fail "mid-pass kill outside a pass: exit=${status} steps=$(mid_steps) output=$(tr '\n' ';' <"${WORK}/mid/out")"
fi
# C6 measures from KILL_EPOCH: an attempt that killed nothing must not move it
# earlier, and an attempt after a real kill must not move it later.
status="$(run_mid_pass_case 3: 0:start)"
if [ "$status" = 0 ] && grep -qxF 'KILL_EPOCH=1001' "${WORK}/mid/steps"; then
  pass "mid-pass: KILL_EPOCH is the start of the first attempt that killed, not of an earlier NO_PASS_START"
else
  fail "mid-pass KILL_EPOCH after NO_PASS_START: exit=${status} steps=$(mid_steps)"
fi
status="$(run_mid_pass_case 0:result 3: 3:)"
if [ "$status" = 0 ] && [ "$(grep -c '^kill_hcc' "${WORK}/mid/steps")" = 3 ] &&
   grep -qxF 'RETURNED achieved=0 kills=1 previous=result' "${WORK}/mid/steps" &&
   grep -qxF 'KILL_EPOCH=1000' "${WORK}/mid/steps"; then
  pass "mid-pass: kills that all landed outside a pass return to the lane's fail branch, with KILL_EPOCH kept"
else
  fail "mid-pass kill outside then NO_PASS_START twice: exit=${status} steps=$(mid_steps) output=$(tr '\n' ';' <"${WORK}/mid/out")"
fi

# ─── kill_hcc: the node output decides the status ─────────────────────
cat >"${WORK}/minikube-stub" <<'STUB'
#!/bin/sh
printf '%b' "$STUB_KILL_OUTPUT"
exit "${STUB_KILL_RC:-0}"
STUB
chmod +x "${WORK}/minikube-stub"
# run_kill_case <node output> <ssh status>: two idle kill_hcc calls; prints the
# subshell's exit status, the results are in ${WORK}/kill/out.
run_kill_case() {
  rm -rf "${WORK}/kill" && mkdir -p "${WORK}/kill/evidence"
  (
    set -euo pipefail
    RED='' NC=''
    EVIDENCE_DIR="${WORK}/kill/evidence" MINIKUBE_BIN="${WORK}/minikube-stub" E2E_KUBECONTEXT=ctx
    NODE_KILL_PATH=/tmp/node-kill.sh KILL_WATCH_SEC=60 KILLS=0 KILL_ATTEMPTS=0
    export STUB_KILL_OUTPUT="$1" STUB_KILL_RC="$2"
    # shellcheck disable=SC1090
    source "${WORK}/fn-kill_hcc.sh"
    rc=0
    kill_hcc idle || rc=$?
    echo "first rc=${rc} kills=${KILLS}"
    rc=0
    kill_hcc idle || rc=$?
    echo "second rc=${rc} kills=${KILLS} attempts=${KILL_ATTEMPTS}"
  ) >"${WORK}/kill/out" 2>&1
  echo $?
}
kill_out() { tr '\n' ';' <"${WORK}/kill/out"; }

status="$(run_kill_case 'KILLED pid=7 container=c0ffee\nNO_PASS_START\n' 3)"
if [ "$status" = 0 ] && grep -qx 'first rc=0 kills=1' "${WORK}/kill/out" &&
   grep -qx 'second rc=0 kills=2 attempts=2' "${WORK}/kill/out"; then
  pass "kill_hcc: a KILLED line wins over a later NO_PASS_START from a process not yet reaped"
else
  fail "kill_hcc KILLED then NO_PASS_START: exit=${status} out=$(kill_out)"
fi
status="$(run_kill_case 'NO_PASS_START\n' 3)"
if [ "$status" = 0 ] && grep -qx 'first rc=3 kills=0' "${WORK}/kill/out" &&
   grep -qx 'second rc=3 kills=0 attempts=2' "${WORK}/kill/out" &&
   grep -qx 'NO_PASS_START' "${WORK}/kill/evidence/kill-1.log" &&
   grep -qx 'NO_PASS_START' "${WORK}/kill/evidence/kill-2.log"; then
  pass "kill_hcc: NO_PASS_START is status 3 and each attempt keeps its own node log"
else
  fail "kill_hcc NO_PASS_START: exit=${status} out=$(kill_out) logs=$(ls "${WORK}/kill/evidence" | tr '\n' ' ')"
fi
status="$(run_kill_case 'KILL_ERROR watcher ended after 0s of 60s without a pass start\n' 2)"
if [ "$status" = 0 ] && grep -qx 'first rc=2 kills=0' "${WORK}/kill/out" &&
   grep -qF 'node kill failed (ssh rc=2): KILL_ERROR watcher ended' "${WORK}/kill/out"; then
  pass "kill_hcc: a watcher that ended early is a kill failure (status 2), not NO_PASS_START"
else
  fail "kill_hcc early watcher end: exit=${status} out=$(kill_out)"
fi

# ─── host_received_fixture_fleet under pipefail ───────────────────────
BIG_LOG="${WORK}/big-host.log"
{
  echo 'Received 1 authorized MCP server(s)'
  python3 -I -c 'import sys; sys.stdout.write("filler log line padding padding padding\n" * 10000)'
} >"$BIG_LOG"
big_size="$(wc -c <"$BIG_LOG" | tr -d ' ')"
fleet_case() {
  (
    set -euo pipefail
    HOST_NS=mcp-host
    EVIDENCE_DIR="${WORK}/fleet-evidence"
    mkdir -p "$EVIDENCE_DIR"
    kctl() { [ "$1" = logs ] || return 1; cat "$FLEET_LOG"; }
    # shellcheck disable=SC1090
    source "${WORK}/fn-host_received_fixture_fleet.sh"
    host_received_fixture_fleet host-active
  )
}
if [ "$big_size" -gt 300000 ] && FLEET_LOG="$BIG_LOG" fleet_case; then
  pass "host_received_fixture_fleet finds its line in a ${big_size}-byte log under pipefail"
else
  fail "host_received_fixture_fleet missed its line in a ${big_size}-byte log under pipefail"
fi
printf 'no fleet line here\n' >"${WORK}/small-host.log"
if ! FLEET_LOG="${WORK}/small-host.log" fleet_case; then
  pass "host_received_fixture_fleet is false when the line is absent"
else
  fail "host_received_fixture_fleet is true without the line"
fi

# ─── C3: a new issued-at over unchanged token data ────────────────────
awk '
  $0 == "  cat <<'"'"'TOKEN_RULES_PY'"'"'" { inside = 1; next }
  $0 == "TOKEN_RULES_PY" { inside = 0 }
  inside { print }
' "$LANE" >"${WORK}/token_rules.py"
if [ "$(grep -cx 'main()' "${WORK}/token_rules.py")" = 1 ]; then
  pass "extracted token_rules_py from the lane"
else
  fail "could not extract token_rules_py from ${LANE}"
fi
c3_out="$(python3 -I - "${WORK}/token_rules.py" <<'PY'
import sys
source = open(sys.argv[1]).read()
assert source.count("\nmain()\n") == 1, "main() call not found exactly once"
ns = {"__name__": "token_rules"}
exec(compile(source.replace("\nmain()\n", "\n"), "token_rules_py", "exec"), ns)
ms = ns["ms"]
name = "host-e2e-act-mcp-host-runtime-tokens"
issued_a, issued_b = "2027-01-15T08:00:00.000Z", "2027-01-15T08:21:40.000Z"
row = {"earliestMs": ms("2027-01-15T08:20:00.000Z"), "class": "A", "binding": "rotate-before point",
       "rotateBeforeMs": ms("2027-01-15T08:20:00.000Z"), "refreshBeforeMs": ms("2027-01-16T00:00:00.000Z"),
       "gfsRefreshBeforeMs": ms("2027-01-16T00:00:00.000Z"), "refreshExpiresMs": ms("2027-01-17T00:00:00.000Z"),
       "problems": []}
def token(issued, revision, data):
    return {"resourceVersion": revision, "dataSha256": data, "annotations": {
        ns["ISSUED"]: issued, ns["SECRET_REVISION"]: revision, ns["BOOT_STATE"]: "fresh", ns["ROLLOUT"]: "false"}}
lines = [(ms("2027-01-15T08:21:41.000Z"), name, ns["NEAR"], False)]
ta = token(issued_a, "r1", "sha-before")
changed, detail = ns["judge_write"](name, ta, token(issued_b, "r2", "sha-after"), row, lines, None)
same, _ = ns["judge_write"](name, ta, token(issued_b, "r2", "sha-before"), row, lines, None)
print("CHANGED problems=%d admitted=%s" % (len(changed), detail is not None))
print("SAME problems=%s" % " | ".join(same))
PY
)"
c3_status=$?
if [ "$c3_status" = 0 ] && grep -qx 'CHANGED problems=0 admitted=True' <<<"$c3_out"; then
  pass "C3 admits an on-schedule rotation whose token data changed"
else
  fail "C3 control case: status=${c3_status} output=${c3_out}"
fi
if [ "$c3_status" = 0 ] && grep -q '^SAME problems=.*token data did not change' <<<"$c3_out"; then
  pass "C3 refuses a new issued-at over unchanged token data"
else
  fail "C3 admitted a new issued-at over unchanged token data: status=${c3_status} output=${c3_out}"
fi

# ─── C7: the revocation lines exist in their producers ────────────────
# C7 passes when a Host log has no 'MCP authority revoked' and no 'Removed
# server' line. That negative check means something only while mcp-host still
# logs those exact texts.
# The precondition and C7 must both judge by the one REVOCATION_PATTERN: two
# -qE verdicts and the two -cE counts in their messages, and no grep in the
# lane with its own copy of either text.
pattern_defs="$(grep -cx "REVOCATION_PATTERN='MCP authority revoked|Removed server'" "$LANE")"
pattern_any_defs="$(grep -c '^[[:space:]]*REVOCATION_PATTERN=' "$LANE")"
pattern_q_uses="$(grep -cE 'grep -qE "\$REVOCATION_PATTERN" "\$(settle_log|host_log)"' "$LANE")"
pattern_c_uses="$(grep -cE 'grep -cE "\$REVOCATION_PATTERN" "\$(settle_log|host_log)"' "$LANE")"
pattern_literals="$(grep -cE 'grep .*(MCP authority revoked|Removed server)' "$LANE")"
if [ "$pattern_defs" = 1 ] && [ "$pattern_any_defs" = 1 ] && [ "$pattern_q_uses" = 2 ] &&
   [ "$pattern_c_uses" = 2 ] && [ "$pattern_literals" = 0 ]; then
  pass "the precondition and C7 judge by one REVOCATION_PATTERN, 'MCP authority revoked|Removed server'"
else
  fail "the lane's revocation pattern changed: definitions=${pattern_defs}/${pattern_any_defs} -qE uses=${pattern_q_uses} -cE uses=${pattern_c_uses} greps with their own text=${pattern_literals}; update this contract test with it"
fi
if grep -qF 'MCP authority revoked' "${ROOT}/mcp-host/src/main.ts"; then
  pass "mcp-host/src/main.ts logs 'MCP authority revoked'"
else
  fail "mcp-host/src/main.ts no longer logs 'MCP authority revoked'; C7 would pass vacuously"
fi
if grep -qF "'Removed server'" "${ROOT}/mcp-host/src/mcp/manager.ts"; then
  pass "mcp-host/src/mcp/manager.ts logs 'Removed server'"
else
  fail "mcp-host/src/mcp/manager.ts no longer logs 'Removed server'; C7 would pass vacuously"
fi

if [ "$TOTAL" -lt 31 ]; then
  echo "FAIL: expected at least 31 checks, ran ${TOTAL}"
  exit 1
fi
if [ "$FAIL" != 0 ]; then
  echo "test-hcc-restart-continuity-lane: FAILED (${TOTAL} checks)"
  exit 1
fi
echo "test-hcc-restart-continuity-lane: PASSED (${TOTAL} checks)"
