#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OWNER="${ROOT}/scripts/minikube/port-forward-owner.sh"
PF_ALL="${ROOT}/scripts/minikube/pf-all-stack.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-pf-owner.XXXXXX")"
trap 'rm -rf -- "${TMP_ROOT}"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

[[ -f "${OWNER}" ]] || fail 'port-forward-owner.sh is missing'
grep -Fq 'profile_owner_validate_selection' "${PF_ALL}" ||
  fail 'branch-owned pf-all-stack does not validate worktree/profile ownership'
# shellcheck source=scripts/minikube/port-forward-owner.sh
source "${OWNER}"

WORKTREE="${TMP_ROOT}/worktree"
OTHER_WORKTREE="${TMP_ROOT}/other-worktree"
RECORD_DIR="${TMP_ROOT}/cache/profile-a/pids"
RECORD="${RECORD_DIR}/control-api.pid"
STATE_FILE="${TMP_ROOT}/process.state"
KILL_LOG="${TMP_ROOT}/kill.log"
REAP_LOG="${TMP_ROOT}/reap.log"
mkdir -p "${WORKTREE}" "${OTHER_WORKTREE}" "${RECORD_DIR}"
WORKTREE="$(cd -- "${WORKTREE}" && pwd -P)"
OTHER_WORKTREE="$(cd -- "${OTHER_WORKTREE}" && pwd -P)"

PROFILE='profile-a'
CONTEXT='profile-a'
NAMESPACE='control-plane'
SERVICE='control-api'
LOCAL_PORT='30190'
REMOTE_PORT='8090'
PID='4242'
RECORDED_START='Sun Aug 23 10:11:12 2026'
ACTUAL_START="${RECORDED_START}"
ACTUAL_COMMAND="kubectl --context=${CONTEXT} -n ${NAMESPACE} port-forward --address=127.0.0.1 svc/${SERVICE} ${LOCAL_PORT}:${REMOTE_PORT}"

# Deterministic process boundary. No real process is signalled by the ownership
# unit cases; state transitions happen only through these fixtures.
pf_owner_process_state() {
  sed -n '1p' "${STATE_FILE}"
}

pf_owner_process_start() {
  printf '%s\n' "${ACTUAL_START}"
}

pf_owner_process_command() {
  printf '%s\n' "${ACTUAL_COMMAND}"
}

pf_owner_signal_process() {
  printf '%s %s\n' "$1" "$2" >>"${KILL_LOG}"
  printf 'dead\n' >"${STATE_FILE}"
}

pf_owner_reap_process() {
  printf '%s\n' "$1" >>"${REAP_LOG}"
}

pf_owner_pause() {
  :
}

reset_process_fixture() {
  printf 'live\n' >"${STATE_FILE}"
  : >"${KILL_LOG}"
  : >"${REAP_LOG}"
  rm -f -- "${RECORD}"
  ACTUAL_START="${RECORDED_START}"
  ACTUAL_COMMAND="kubectl --context=${CONTEXT} -n ${NAMESPACE} port-forward --address=127.0.0.1 svc/${SERVICE} ${LOCAL_PORT}:${REMOTE_PORT}"
}

write_record() {
  local profile="${1:-${PROFILE}}"
  local context="${2:-${CONTEXT}}"
  local worktree="${3:-${WORKTREE}}"
  local namespace="${4:-${NAMESPACE}}"
  local service="${5:-${SERVICE}}"
  local local_port="${6:-${LOCAL_PORT}}"
  local remote_port="${7:-${REMOTE_PORT}}"
  pf_owner_write_record_atomic "${RECORD}" "${PID}" "${RECORDED_START}" \
    "${profile}" "${context}" "${worktree}" "${namespace}" "${service}" \
    "${local_port}" "${remote_port}"
}

cleanup_record() {
  pf_owner_cleanup_record "${RECORD}" "${PROFILE}" "${CONTEXT}" \
    "${WORKTREE}" "${NAMESPACE}" "${SERVICE}" "${LOCAL_PORT}" "${REMOTE_PORT}"
}

expect_refusal() {
  local label="$1"
  if cleanup_record >"${TMP_ROOT}/refusal.out" 2>&1; then
    fail "${label} was accepted"
  fi
  [[ -f "${RECORD}" ]] || fail "${label} removed a live ambiguous record"
  [[ ! -s "${KILL_LOG}" ]] || fail "${label} signalled a live ambiguous process"
  pass "${label} fails closed"
}

reset_process_fixture
write_record
mode="$(stat -f '%Lp' "${RECORD}" 2>/dev/null || true)"
if [[ ! "${mode}" =~ ^[0-7]{3,4}$ ]]; then
  mode="$(stat -c '%a' "${RECORD}")"
fi
[[ "${mode}" == 600 ]] || fail "structured pid record mode is ${mode}, expected 600"
grep -Fxq "${PID}" "${RECORD}" || fail 'legacy-compatible PID first line is missing'
grep -Fxq 'PORT_FORWARD_OWNER_VERSION=1' "${RECORD}" || fail 'record version is missing'
grep -Fxq "PID=${PID}" "${RECORD}" || fail 'structured PID binding is missing'
grep -Fxq "PROCESS_START=${RECORDED_START}" "${RECORD}" || fail 'process-start binding is missing'
grep -Fxq "PROFILE=${PROFILE}" "${RECORD}" || fail 'profile binding is missing'
grep -Fxq "CONTEXT=${CONTEXT}" "${RECORD}" || fail 'context binding is missing'
grep -Fxq "WORKTREE=${WORKTREE}" "${RECORD}" || fail 'canonical worktree binding is missing'
grep -Fxq "NAMESPACE=${NAMESPACE}" "${RECORD}" || fail 'namespace binding is missing'
grep -Fxq "SERVICE=${SERVICE}" "${RECORD}" || fail 'service binding is missing'
grep -Fxq "LOCAL_PORT=${LOCAL_PORT}" "${RECORD}" || fail 'local-port binding is missing'
grep -Fxq "REMOTE_PORT=${REMOTE_PORT}" "${RECORD}" || fail 'remote-port binding is missing'
if find "${RECORD_DIR}" -maxdepth 1 -name '*.tmp.*' -print -quit | grep -q .; then
  fail 'atomic record write left a temporary file behind'
fi
pass 'structured records are complete, atomic, private, and legacy-readable'

record_hash="$(shasum "${RECORD}" | awk '{print $1}')"
if pf_owner_write_record_atomic "${RECORD}" 5252 "${RECORDED_START}" \
  "${PROFILE}" "${CONTEXT}" "${WORKTREE}" "${NAMESPACE}" "${SERVICE}" \
  "${LOCAL_PORT}" "${REMOTE_PORT}" >"${TMP_ROOT}/no-clobber.out" 2>&1; then
  fail 'atomic publication replaced an existing ownership record'
fi
[[ "$(shasum "${RECORD}" | awk '{print $1}')" == "${record_hash}" ]] ||
  fail 'failed no-clobber publication changed the existing owner'
pass 'atomic publication never replaces an existing owner'

reset_process_fixture
write_record 'profile-b'
expect_refusal 'wrong-profile record'

reset_process_fixture
write_record "${PROFILE}" 'profile-b'
expect_refusal 'wrong-context record'

reset_process_fixture
write_record "${PROFILE}" "${CONTEXT}" "${OTHER_WORKTREE}"
expect_refusal 'wrong-worktree record'

reset_process_fixture
write_record
ACTUAL_COMMAND="kubectl --context=${CONTEXT} -n ${NAMESPACE} port-forward --address=127.0.0.1 svc/foreign-service ${LOCAL_PORT}:${REMOTE_PORT}"
expect_refusal 'wrong-service argv'

reset_process_fixture
write_record
ACTUAL_COMMAND="kubectl --context=${CONTEXT} -n ${NAMESPACE} port-forward --address=127.0.0.1 svc/${SERVICE} 39999:${REMOTE_PORT}"
expect_refusal 'wrong-ports argv'

reset_process_fixture
write_record
ACTUAL_START='Sun Aug 23 10:11:13 2026'
expect_refusal 'PID-reuse/start mismatch'

reset_process_fixture
write_record
ACTUAL_START=''
expect_refusal 'unavailable process-start identity'

reset_process_fixture
printf '%s\nPROCESS_START=%s\n' "${PID}" "${RECORDED_START}" >"${RECORD}"
chmod 600 "${RECORD}"
printf 'dead\n' >"${STATE_FILE}"
cleanup_record || fail 'dead legacy pidfile was not cleaned'
[[ ! -e "${RECORD}" ]] || fail 'dead legacy pidfile remains'
[[ ! -s "${KILL_LOG}" ]] || fail 'dead legacy cleanup sent a signal'
pass 'dead stale pidfiles are removed without signalling'

reset_process_fixture
write_record
pf_owner_record_process_matches "${RECORD}" "${PROFILE}" "${CONTEXT}" \
  "${WORKTREE}" "${NAMESPACE}" "${SERVICE}" "${LOCAL_PORT}" "${REMOTE_PORT}" ||
  fail 'exact ownership revalidation rejected the recorded live process'
pass 'post-health ownership revalidation proves the exact live process and binding'
cleanup_record || fail 'exact owned cleanup failed'
[[ ! -e "${RECORD}" ]] || fail 'exact owned cleanup kept the pidfile'
grep -Fxq "${PID} TERM" "${KILL_LOG}" || fail 'exact owned cleanup did not send TERM'
pass 'exact record, start identity, and kubectl argv permit cleanup'

reset_process_fixture
write_record
pf_owner_signal_process() {
  printf '%s %s\n' "$1" "$2" >>"${KILL_LOG}"
}
PF_OWNER_TERMINATE_ATTEMPTS=2 PF_OWNER_TERMINATE_DELAY=0
if cleanup_record >"${TMP_ROOT}/term-timeout.out" 2>&1; then
  fail 'cleanup accepted a live child that ignored TERM'
fi
[[ -f "${RECORD}" ]] || fail 'bounded TERM timeout removed the live ownership record'
grep -Fxq "${PID} TERM" "${KILL_LOG}" || fail 'bounded TERM timeout did not signal the exact PID'
[[ ! -s "${REAP_LOG}" ]] || fail 'bounded TERM timeout called blocking reap on a live process'
pass 'TERM-resistant cleanup is bounded and never waits on a live process'

# A fast child may disappear after the post-TERM state probe but before ps(1)
# can return its start time. The cleanup contract must accept that only after a
# second state probe proves the PID is dead; it must never remove a live or
# ambiguous record on a missing start-time read.
reset_process_fixture
write_record
RACE_AFTER_TERM=false
RACE_START_FAILED_FILE="${TMP_ROOT}/race-start-failed"
rm -f -- "${RACE_START_FAILED_FILE}"
pf_owner_signal_process() {
  printf '%s %s\n' "$1" "$2" >>"${KILL_LOG}"
  RACE_AFTER_TERM=true
}
pf_owner_process_state() {
  if [[ "${RACE_AFTER_TERM}" == true ]]; then
    if [[ -e "${RACE_START_FAILED_FILE}" ]]; then
      printf 'dead\n'
    else
      printf 'live\n'
    fi
  else
    printf 'live\n'
  fi
}
pf_owner_process_start() {
  if [[ "${RACE_AFTER_TERM}" == true ]]; then
    : >"${RACE_START_FAILED_FILE}"
    return 1
  fi
  printf '%s\n' "${ACTUAL_START}"
}
PF_OWNER_TERMINATE_ATTEMPTS=1 PF_OWNER_TERMINATE_DELAY=0 cleanup_record ||
  fail 'cleanup rejected a process that exited during the post-TERM start-time race'
[[ ! -e "${RECORD}" ]] || fail 'post-TERM race cleanup kept the dead ownership record'
[[ -s "${REAP_LOG}" ]] || fail 'post-TERM race cleanup did not reap the dead process'
pass 'post-TERM start-time race cleans up only after a dead-state recheck'

pf_owner_signal_process() {
  printf '%s %s\n' "$1" "$2" >>"${KILL_LOG}"
  printf 'dead\n' >"${STATE_FILE}"
}

reset_process_fixture
ACTUAL_START=''
if pf_owner_record_process "${RECORD}" "${PID}" "${PROFILE}" "${CONTEXT}" \
  "${WORKTREE}" "${NAMESPACE}" "${SERVICE}" "${LOCAL_PORT}" "${REMOTE_PORT}" \
  >"${TMP_ROOT}/missing-start.out" 2>&1; then
  fail 'record_process accepted an unavailable process-start identity'
fi
[[ ! -e "${RECORD}" ]] || fail 'record_process persisted an unavailable start identity'
pass 'new ownership fails closed when process-start cannot be captured'

# Execute the real forwarding entrypoint against command stubs. The first
# required health endpoint fails, so the script must exit non-zero and remove
# the exact owned process/record. The fake kubectl only execs /bin/sleep.
BIN_DIR="${TMP_ROOT}/bin"
HEALTH_CACHE="${TMP_ROOT}/health-cache"
KUBECTL_LOG="${TMP_ROOT}/kubectl.log"
LAUNCHED_PID="${TMP_ROOT}/launched.pid"
RECORD_SNAPSHOT="${TMP_ROOT}/record.snapshot"
HEALTH_OUTPUT="${TMP_ROOT}/health.out"
HEALTH_PROFILE='pf-owner-health'
HEALTH_CONTEXT='pf-owner-health'
HEALTH_PIDFILE="${HEALTH_CACHE}/${HEALTH_PROFILE}/pids/control-ui.pid"
mkdir -p "${BIN_DIR}"

cat >"${BIN_DIR}/kubectl" <<'EOF_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${PF_TEST_KUBECTL_LOG:?}"
printf '%s\n' "$$" >"${PF_TEST_LAUNCHED_PID:?}"
exec /bin/sleep 30
EOF_KUBECTL

cat >"${BIN_DIR}/ps" <<'EOF_PS'
#!/usr/bin/env bash
set -euo pipefail
pid=''
mode=''
while (( $# > 0 )); do
  case "$1" in
    -p)
      pid="$2"
      shift 2
      ;;
    -o)
      mode="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[[ "${pid}" =~ ^[1-9][0-9]*$ ]] || exit 2
if ! /bin/kill -0 "${pid}" 2>/dev/null; then
  exit 1
fi
case "${mode}" in
  lstart=)
    printf 'Sun Aug 23 10:11:12 2026\n'
    ;;
  command=)
    printf 'kubectl --context=%s -n control-plane port-forward --address=127.0.0.1 svc/control-ui 3000:3000\n' \
      "${PF_TEST_CONTEXT:?}"
    ;;
  pid=)
    printf '%s\n' "${pid}"
    ;;
  *)
    exit 2
    ;;
esac
EOF_PS

cat >"${BIN_DIR}/curl" <<'EOF_CURL'
#!/usr/bin/env bash
set -euo pipefail
cp "${PF_TEST_PIDFILE:?}" "${PF_TEST_RECORD_SNAPSHOT:?}"
exit 22
EOF_CURL

chmod +x "${BIN_DIR}/kubectl" "${BIN_DIR}/ps" "${BIN_DIR}/curl"

health_status=0
env PATH="${BIN_DIR}:${PATH}" \
  MINIKUBE_PROFILE="${HEALTH_PROFILE}" \
  KUBECONTEXT="${HEALTH_CONTEXT}" \
  CLERUM_PROFILE_CACHE_ROOT="${HEALTH_CACHE}" \
  CLERUM_PROFILE_PORTS_ENV="${TMP_ROOT}/no-ports.env" \
  PF_HEALTH_ATTEMPTS=1 \
  PF_HEALTH_DELAY=0 \
  PF_STARTUP_DELAY=0 \
  PF_OWNER_TERMINATE_DELAY=0 \
  PF_TEST_CONTEXT="${HEALTH_CONTEXT}" \
  PF_TEST_KUBECTL_LOG="${KUBECTL_LOG}" \
  PF_TEST_LAUNCHED_PID="${LAUNCHED_PID}" \
  PF_TEST_PIDFILE="${HEALTH_PIDFILE}" \
  PF_TEST_RECORD_SNAPSHOT="${RECORD_SNAPSHOT}" \
  bash "${PF_ALL}" >"${HEALTH_OUTPUT}" 2>&1 || health_status=$?

[[ "${health_status}" -ne 0 ]] || fail 'required health failure returned success'
grep -Fq 'ERROR: control-ui did not become healthy' "${HEALTH_OUTPUT}" || \
  fail 'required health failure was not fail-loud'
grep -Fxq -- "--context=${HEALTH_CONTEXT} -n control-plane port-forward --address=127.0.0.1 svc/control-ui 3000:3000" \
  "${KUBECTL_LOG}" || fail 'port-forward did not use the explicit context argv'
[[ -f "${RECORD_SNAPSHOT}" ]] || fail 'health fixture could not snapshot the structured pid record'
grep -Fxq "PROFILE=${HEALTH_PROFILE}" "${RECORD_SNAPSHOT}" || fail 'runtime record omitted profile'
grep -Fxq "CONTEXT=${HEALTH_CONTEXT}" "${RECORD_SNAPSHOT}" || fail 'runtime record omitted context'
grep -Fxq "WORKTREE=${ROOT}" "${RECORD_SNAPSHOT}" || fail 'runtime record omitted canonical worktree'
grep -Fxq 'NAMESPACE=control-plane' "${RECORD_SNAPSHOT}" || fail 'runtime record omitted namespace'
grep -Fxq 'SERVICE=control-ui' "${RECORD_SNAPSHOT}" || fail 'runtime record omitted service'
grep -Fxq 'LOCAL_PORT=3000' "${RECORD_SNAPSHOT}" || fail 'runtime record omitted local port'
grep -Fxq 'REMOTE_PORT=3000' "${RECORD_SNAPSHOT}" || fail 'runtime record omitted remote port'
[[ ! -e "${HEALTH_PIDFILE}" ]] || fail 'required health failure left the canonical pidfile behind'
launched_pid="$(sed -n '1p' "${LAUNCHED_PID}")"
if /bin/kill -0 "${launched_pid}" 2>/dev/null; then
  fail 'required health failure left the fake port-forward alive'
fi
pass 'required health failure is loud, cleans up, and uses explicit --context'

printf 'PASS: Minikube port-forward ownership hardening\n'
