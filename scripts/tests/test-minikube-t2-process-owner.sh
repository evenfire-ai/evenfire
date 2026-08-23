#!/usr/bin/env bash
# T2 attributes only exact-context kubectl forwards and accepts exactly one
# structured ownership record bound to this profile and worktree.
set -euo pipefail
set +x

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COMMON="$ROOT/scripts/minikube/t2-common.sh"
OWNER="$ROOT/scripts/minikube/port-forward-owner.sh"
TMP_ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "$TMP_ROOT/evenfire-t2-process-owner.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

PROFILE=clerum-t2-pf-fixture
PID=4242
START='Sun Aug 23 10:11:12 2026'
PROFILE_ROOT="$TEST_DIR/profiles"
PID_DIR="$PROFILE_ROOT/$PROFILE/pids"
PS_DATA="$TEST_DIR/ps-data"
PS_BIN="$TEST_DIR/bin"
PS_EF="$PS_DATA/ef"
RECORD="$PID_DIR/control-ui.pid"
mkdir -p "$PID_DIR" "$PS_DATA" "$PS_BIN"

cat >"$PS_BIN/ps" <<'EOF_PS'
#!/usr/bin/env bash
pid=''
mode=''
if [ "${1:-}" = -ef ]; then
  [ ! -f "${T2_PS_DATA_DIR:?}/ef" ] || cat "${T2_PS_DATA_DIR}/ef"
  exit 0
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) pid="$2"; shift 2 ;;
    -o) mode="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$pid" ] || exit 1
case "$mode" in
  comm=) suffix=comm ;;
  command=) suffix=command ;;
  lstart=) suffix=start ;;
  pid=) suffix=pid ;;
  *) exit 1 ;;
esac
[ ! -f "${T2_PS_DATA_DIR:?}/${pid}.${suffix}" ] || cat "${T2_PS_DATA_DIR}/${pid}.${suffix}"
EOF_PS
chmod +x "$PS_BIN/ps"

set_process_fixture() {
  local comm="$1" command="$2"
  printf '%s\n' "user $PID 1 0 10:00 ttys000 0:00 $command" >"$PS_EF"
  printf '%s\n' "$comm" >"$PS_DATA/$PID.comm"
  printf '%s\n' "$command" >"$PS_DATA/$PID.command"
  printf '%s\n' "$START" >"$PS_DATA/$PID.start"
  printf '%s\n' "$PID" >"$PS_DATA/$PID.pid"
}

run_process_check() {
  local output="$1"
  T2_PS_DATA_DIR="$PS_DATA" PATH="$PS_BIN:$PATH" \
    T2_PROFILE="$PROFILE" T2_CONTEXT="$PROFILE" MINIKUBE_PROFILE="$PROFILE" \
    T2_PROFILE_ROOT="$PROFILE_ROOT" T2_PROJECT_DIR="$ROOT" \
    bash -c 'source "$1"; t2_process_check' _ "$COMMON" >"$output" 2>&1
}

exact_command="kubectl --context=$PROFILE -n control-plane port-forward --address=127.0.0.1 svc/control-ui 3000:3000"
set_process_fixture kubectl "$exact_command"
if run_process_check "$TEST_DIR/unowned.out"; then
  printf 'FAIL: exact-context forward without a record was accepted\n' >&2
  exit 1
fi
grep -Fq PORT_FORWARD_CONFLICT "$TEST_DIR/unowned.out"

set_process_fixture bash "bash -c echo kubectl --context=$PROFILE port-forward"
run_process_check "$TEST_DIR/wrapper.out"

set_process_fixture kubectl 'kubectl -n control-plane port-forward svc/control-ui 3000:3000'
run_process_check "$TEST_DIR/contextless.out"

set_process_fixture kubectl 'kubectl --context=another-profile -n control-plane port-forward svc/control-ui 3000:3000'
run_process_check "$TEST_DIR/other-context.out"

# shellcheck source=scripts/minikube/port-forward-owner.sh
source "$OWNER"
set_process_fixture kubectl "$exact_command"
pf_owner_write_record_atomic "$RECORD" "$PID" "$START" "$PROFILE" \
  "$PROFILE" "$ROOT" control-plane control-ui 3000 3000
run_process_check "$TEST_DIR/exact.out"

printf '%s\n' 'different process start' >"$PS_DATA/$PID.start"
if run_process_check "$TEST_DIR/reused.out"; then
  printf 'FAIL: process-start mismatch was accepted\n' >&2
  exit 1
fi
grep -Fq PORT_FORWARD_CONFLICT "$TEST_DIR/reused.out"
printf '%s\n' "$START" >"$PS_DATA/$PID.start"

SECOND_RECORD="$PID_DIR/control-ui-duplicate.pid"
pf_owner_write_record_atomic "$SECOND_RECORD" "$PID" "$START" "$PROFILE" \
  "$PROFILE" "$ROOT" control-plane control-ui 3000 3000
if run_process_check "$TEST_DIR/duplicate.out"; then
  printf 'FAIL: duplicate exact ownership records were accepted\n' >&2
  exit 1
fi
grep -Fq PORT_FORWARD_CONFLICT "$TEST_DIR/duplicate.out"

printf 'PASS: T2 process inventory requires one exact structured port-forward owner\n'
