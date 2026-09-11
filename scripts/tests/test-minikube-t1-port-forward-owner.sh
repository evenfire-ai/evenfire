#!/usr/bin/env bash
# T1 must delegate cleanup to the exact structured ownership contract.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
T1="$ROOT/scripts/e2e/minikube-real-postgres.sh"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/evenfire-t1-pf-owner.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

# shellcheck source=scripts/e2e/minikube-real-postgres.sh
source "$T1"

T2_PROFILE=clerum-feature-owner
T2_CONTEXT=clerum-feature-owner
PG_NAMESPACE=control-plane
PG_SERVICE=control-postgres
LOCAL_PORT=32123
PORT_FORWARD_PID=4242
PORT_FORWARD_RECORD="$TEST_DIR/control-postgres.pid"
CALLS="$TEST_DIR/calls"
: >"$PORT_FORWARD_RECORD"

pf_owner_cleanup_record() {
  printf '%s\n' "$@" >"$CALLS"
  rm -f -- "$1"
}

stop_control_postgres_forward
python3 - "$CALLS" "$ROOT" <<'PY'
import sys
from pathlib import Path

values = Path(sys.argv[1]).read_text().splitlines()
assert values[1:] == [
    "clerum-feature-owner",
    "clerum-feature-owner",
    sys.argv[2],
    "control-plane",
    "control-postgres",
    "32123",
    "5432",
]
PY
[ -z "$PORT_FORWARD_PID" ] && [ -z "$PORT_FORWARD_RECORD" ] || {
  printf 'FAIL: successful exact cleanup did not clear T1 ownership state\n' >&2
  exit 1
}

PORT_FORWARD_PID=4343
PORT_FORWARD_RECORD="$TEST_DIR/missing-live.pid"
pf_owner_process_state() { printf 'live\n'; }
if stop_control_postgres_forward >"$TEST_DIR/missing-live.out" 2>&1; then
  printf 'FAIL: missing ownership record was accepted for a possibly live process\n' >&2
  exit 1
fi
[ "$PORT_FORWARD_PID" = 4343 ] || {
  printf 'FAIL: ambiguous live process state was discarded\n' >&2
  exit 1
}

PORT_FORWARD_PID=4444
PORT_FORWARD_RECORD="$TEST_DIR/missing-dead.pid"
pf_owner_process_state() { printf 'dead\n'; }
stop_control_postgres_forward
[ -z "$PORT_FORWARD_PID" ] && [ -z "$PORT_FORWARD_RECORD" ] || {
  printf 'FAIL: a proven-dead child did not clear stale T1 state\n' >&2
  exit 1
}

grep -Fq 'pf_owner_record_process "$PORT_FORWARD_RECORD" "$PORT_FORWARD_PID"' "$T1"
grep -Fq 'pf_owner_abort_child "$PORT_FORWARD_PID"' "$T1"
grep -Fq 'pf_owner_cleanup_record "$PORT_FORWARD_RECORD"' "$T1"
if grep -Eq 'command_line=.*port-forward|command_line.*svc/control-postgres' "$T1"; then
  printf 'FAIL: T1 still uses fuzzy process-command ownership matching\n' >&2
  exit 1
fi

printf 'PASS: T1 port-forward lifecycle uses exact structured ownership\n'
