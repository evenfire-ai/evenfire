#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
# Evaluate the production declaration and validator, without sourcing T2's
# orchestrator or contacting a cluster.
source_function() {
  local text
  text="$(sed -n "/^$2() {/,/^}/p" "$1")"
  [[ -n "$text" ]] || { echo "Missing function $2" >&2; exit 1; }
  eval "$text"
}
unset T2_HEALTHCHECK_KILL_GRACE_SECONDS
eval "$(sed -n '/^T2_HEALTHCHECK_KILL_GRACE_SECONDS=/p' "$ROOT/scripts/minikube/t2.sh")"
[[ "$T2_HEALTHCHECK_KILL_GRACE_SECONDS" = 5 ]]
source_function "$ROOT/scripts/minikube/t2.sh" validate_healthcheck_contract
T2_HEALTHCHECK_TIMEOUT_SECONDS=900 T2_PLAN_STATE=already-synced
T2_HEALTHCHECK_PENDING=false T2_HEALTHCHECK_COMMAND=''
t2_fail() { printf '%s\n' "$*" >> "$tmp/validation-errors"; }
for value in 0 -1 1.5 abc 301 999999999999999999999; do
  T2_HEALTHCHECK_KILL_GRACE_SECONDS="$value"
  if validate_healthcheck_contract; then
    echo "FAIL: accepted invalid health cleanup grace $value" >&2; exit 1
  fi
done
for value in 1 5 300; do
  T2_HEALTHCHECK_KILL_GRACE_SECONDS="$value"
  validate_healthcheck_contract
done
# Verify the validated value reaches the actual runner invocation.
source_function "$ROOT/scripts/minikube/t2.sh" run_healthcheck_if_requested
T2_HEALTHCHECK_COMMAND=true T2_DEADLINE_RUNNER="$ROOT/scripts/minikube/run-with-deadline.mjs"
T2_HEALTHCHECK_KILL_GRACE_SECONDS=300
node() { printf '%s\n' "$@" > "$tmp/runner-args"; }
t2_evidence_write() { :; }
run_healthcheck_if_requested
unset -f node
awk 'last=="--kill-grace-seconds" && $0=="300" {found=1} {last=$0} END {exit !found}' "$tmp/runner-args"
echo 'PASS: health grace defaults to 5, validates 1..300 and reaches the runner'

# Execute the actual callback and supervisor, replacing only the kubectl process.
python3 - "$ROOT" "$tmp" <<'PY'
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root, tmp = map(Path, sys.argv[1:])
source = (root / 'scripts/e2e/e2e-hcc-watch-churn-readiness.sh').read_text()
start = source.index('cleanup() {\n')
end = source.index('\n}\n', start) + 3
cleanup = source[start:end]
traps = '\n'.join(line for line in source.splitlines() if line.startswith('trap '))
assert 'trap cleanup EXIT' in traps and 'TERM' in traps
kubectl = tmp / 'kubectl-fixture.py'
kubectl.write_text('''#!/usr/bin/env python3
import os, sys, time
args = sys.argv[1:]
with open(os.environ['TRACE'], 'a') as trace:
    trace.write('kubectl ' + ' '.join(args) + '\\n')
args = args[2:] # explicit --context fixture-context
if args[:2] == ['set', 'env']:
    time.sleep(float(os.environ.get('RESTORE_DELAY', '0')))
if args[:2] == ['rollout', 'status'] and os.environ.get('FAIL_RESTORE') == '1':
    sys.exit(1)
if args[0] == 'delete' and os.environ.get('FAIL_FIXTURE') == '1':
    sys.exit(1)
''')
kubectl.chmod(0o700)
child = tmp / 'cleanup-child.sh'
child.write_text('''#!/usr/bin/env bash
set -euo pipefail
ROOT=$1
source "$ROOT/scripts/e2e/_lib/hcc-watch-churn-fixture.sh"
source "$ROOT/scripts/e2e/_lib/hcc-networkpolicy-lifecycle.sh"
source "$ROOT/scripts/e2e/_lib/hcc-watch-recovery-lock.sh"
source "$ROOT/scripts/e2e/_lib/hcc-watch-lifecycle-cleanup.sh"
E2E_HCC_POLICY_LIFECYCLE=1 E2E_KUBECONTEXT=fixture-context
HCC_PATCHED=1 HCC_SCALED_DOWN=1 ORIGINAL_REPLICAS=1
HCC_DEPLOY=fixture-hcc HCC_NS=fixture-control
FLEET_CREATED=0 PROXY_CREATED=0 PROBE_CREATED=0
NP604_CREATED=1 NP604_WATCH_PID=''
NP604_SERVER=fixture-affected NP604_CONTROL=fixture-control MCP_NS=fixture-mcp
RUN_ID=fixture HCC_GATE_LOCK_ACQUIRED=1
HCC_LOG_BUFFER="${TRACE}.buffer" READY_SERIES="${TRACE}.series"
release_hcc_watch_gate_lock() {
  echo lock-released >> "$TRACE"
  HCC_GATE_LOCK_ACQUIRED=0
}
print_hcc_watch_gate_lock_instructions() { echo lock-retained >> "$TRACE"; }
print_repair_instructions() { echo repair-required >> "$TRACE"; }
print_results() { :; }
''' + cleanup + '\n' + traps + '''
echo ready > "${TRACE}.ready"
if [[ "${DIRECT_EXIT:-}" != '' ]]; then exit "$DIRECT_EXIT"; fi
sleep 30
''')
runner = root / 'scripts/minikube/run-with-deadline.mjs'
base_env = {**os.environ, 'KUBECTL_BIN': str(kubectl)}

def run_case(name, *, mode='timeout', **extra):
    trace = tmp / (name + '.trace')
    env = {**base_env, 'TRACE': str(trace), **extra}
    args = ['node', str(runner), '--timeout-seconds', '1' if mode == 'timeout' else '30',
            '--kill-grace-seconds', '300', '--label', 'cleanup-contract', '--',
            'bash', str(child), str(root)]
    process = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if mode == 'term':
        deadline = time.monotonic() + 5
        ready = Path(str(trace) + '.ready')
        while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert ready.exists(), 'child never became ready for TERM'
        process.send_signal(signal.SIGTERM)
    try:
        stdout, stderr = process.communicate(timeout=25)
    except subprocess.TimeoutExpired:
        # Reap the owned process group even if this test fails.
        process.send_signal(signal.SIGTERM)
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=3)
        raise
    expected = 124 if mode == 'timeout' else 143 if mode == 'term' else int(extra['DIRECT_EXIT'])
    assert process.returncode == expected, (name, process.returncode, stdout, stderr)
    lines = trace.read_text().splitlines()
    restore = next(i for i, line in enumerate(lines) if ' rollout status ' in line)
    fixture = [i for i, line in enumerate(lines) if ' delete mcpserver,secret ' in line]
    if extra.get('FAIL_RESTORE') == '1':
        assert not fixture, (name, 'removed fixtures before confirming restoration', lines)
    else:
        assert fixture and restore < fixture[0], (name, 'fixture removal preceded restoration', lines)
    if extra.get('FAIL_RESTORE') == '1' or extra.get('FAIL_FIXTURE') == '1':
        assert 'lock-retained' in lines and 'lock-released' not in lines, lines
    else:
        assert 'lock-released' in lines, (name, 'cleanup did not finish', lines, stderr)

for mode in ('timeout', 'term'):
    run_case(mode, mode=mode, RESTORE_DELAY='6')
    print(f'PASS: {mode} retains its failure after real cleanup takes more than five seconds')
run_case('restore-failure', mode='exit', DIRECT_EXIT='7', FAIL_RESTORE='1')
run_case('fixture-failure', mode='exit', DIRECT_EXIT='7', FAIL_FIXTURE='1')
print('PASS: restoration precedes fixture work; restoration/fixture failures retain the lock')

# Deliberate transport stall, bounded by the production command wrapper.
trace = tmp / 'budget.trace'
env = {**base_env, 'TRACE': str(trace), 'RESTORE_DELAY': '5'}
command = '''source "$1/scripts/e2e/_lib/hcc-watch-lifecycle-cleanup.sh"
E2E_KUBECONTEXT=fixture-context
HCC_CLEANUP_PHASE_DEADLINE=$((SECONDS + 1))
hcc_cleanup_kctl set env deployment/fixture-hcc
'''
started = time.monotonic()
result = subprocess.run(['bash', '-c', command, 'budget-check', str(root)], env=env,
                        capture_output=True, text=True, timeout=8)
assert result.returncode == 124, (result.returncode, result.stderr)
assert time.monotonic() - started < 4
print('PASS: actual cleanup command boundary terminates a stalled request at its budget')
PY

# Actual absence predicates must handle partial setup and resources that lack
# the suite/run labels (the proxy has an app label instead).
(
  set -euo pipefail
  source "$ROOT/scripts/e2e/_lib/hcc-networkpolicy-lifecycle.sh"
  source "$ROOT/scripts/e2e/_lib/hcc-watch-lifecycle-cleanup.sh"
  NP604_CREATED=0 FLEET_CREATED=0 PROXY_CREATED=0 PROBE_CREATED=0
  HCC_CLEANUP_HOSTS='' RUN_ID=fixture HCC_NS=fixture-control
  unset NP604_SERVER NP604_CONTROL MCP_NS
  kctl() { :; }
  hcc_lifecycle_fixture_absent
  echo 'PASS: absence check tolerates setup failure before NP604 names exist under nounset'

  PROXY_CREATED=1 PROXY_NAME=fixture-proxy
  PROXY_EGRESS_NP=fixture-egress HCC_PROXY_NP=fixture-hcc PROBE_EGRESS_NP=fixture-probe
  remaining_kind=deployment
  kctl() {
    if [[ "$remaining_kind" = deployment && "$*" = "get deployment,service $PROXY_NAME -n $HCC_NS --ignore-not-found -o name" ]]; then
      printf 'deployment.apps/%s\n' "$PROXY_NAME"
    elif [[ "$remaining_kind" = pod && "$*" = "get pod -n $HCC_NS -l app=$PROXY_NAME -o name" ]]; then
      printf 'pod/%s-terminating\n' "$PROXY_NAME"
    fi
    return 0
  }
  if hcc_lifecycle_fixture_absent; then
    echo 'FAIL: exact-name proxy resource was mistaken for absence' >&2; exit 1
  fi
  remaining_kind=pod
  if hcc_lifecycle_fixture_absent; then
    echo 'FAIL: remaining app-labelled proxy pod was mistaken for absence' >&2; exit 1
  fi
  remaining_kind=none
  hcc_lifecycle_fixture_absent
  echo 'PASS: proxy absence requires both exact-name resources and app-labelled pods to disappear'
)
