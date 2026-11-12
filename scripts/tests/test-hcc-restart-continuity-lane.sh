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

for fn in die start_sampler stop_sampler teardown host_received_fixture_fleet; do
  extract_function "$fn" >"${WORK}/fn-${fn}.sh"
  if [ -s "${WORK}/fn-${fn}.sh" ] && [[ "$(tail -n 1 "${WORK}/fn-${fn}.sh")" == *"}" ]]; then
    pass "extracted ${fn} from the lane"
  else
    fail "could not extract ${fn} from ${LANE}"
  fi
done

# ─── teardown under signals ───────────────────────────────────────────
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
  cat <<'EOF'
trap teardown EXIT
start_sampler selector
echo "SAMPLER_STARTED" >>"$STEPS"
: >"$READY"
# A foreground sleep, as the lane's settle window is.
sleep 30
EOF
} >"$HARNESS"

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
C7_PATTERN_LINE="$(grep -c "grep -qE 'MCP authority revoked|Removed server'" "$LANE")"
if [ "$C7_PATTERN_LINE" -ge 1 ]; then
  pass "the lane's C7 pattern is 'MCP authority revoked|Removed server'"
else
  fail "the lane's C7 pattern changed; update this contract test with it"
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

if [ "$TOTAL" -lt 17 ]; then
  echo "FAIL: expected at least 17 checks, ran ${TOTAL}"
  exit 1
fi
if [ "$FAIL" != 0 ]; then
  echo "test-hcc-restart-continuity-lane: FAILED (${TOTAL} checks)"
  exit 1
fi
echo "test-hcc-restart-continuity-lane: PASSED (${TOTAL} checks)"
