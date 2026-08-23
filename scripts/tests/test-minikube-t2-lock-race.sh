#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

LOCK_ROOT="${TMP_DIR}/locks"
LOCK_DIR="${LOCK_ROOT}/race-profile.lock"
READY_FILE="${TMP_DIR}/ready"
RESULT_FILE="${TMP_DIR}/result"
RELEASE_FILE="${TMP_DIR}/release"
mkdir -p "${LOCK_DIR}"
: >"${READY_FILE}"
: >"${RESULT_FILE}"

owner_token_key=TOKEN
{
  printf '%s=%s\n' "${owner_token_key}" stale-owner-token
  printf 'PID=999999\n'
  printf 'PROCESS_START=stale-process-start\n'
} >"${LOCK_DIR}/owner.env"

cat >"${TMP_DIR}/worker.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "${TEST_COMMON}"
T2_PROJECT_DIR="${TEST_PROJECT_DIR}"
T2_BRANCH=feat/lock-race
T2_HEAD=1111111111111111111111111111111111111111
T2_PROFILE=race-profile
T2_CONTEXT=race-profile
T2_WORKTREE_ID=lock-race-worktree

# Force both contenders to classify the same original owner as stale before
# either can claim it. A replacement owner is judged by liveness so the loser
# cannot remove the winner's newly acquired lock.
t2_lock_process_matches() {
  local pid="$1" deadline lines
  if [[ "${pid}" != 999999 ]]; then
    kill -0 "${pid}" >/dev/null 2>&1
    return
  fi
  printf '%s\n' "$$" >>"${TEST_READY_FILE}"
  deadline=$((SECONDS + 10))
  while :; do
    lines="$(wc -l <"${TEST_READY_FILE}" | tr -d ' ')"
    [[ "${lines}" -ge 2 ]] && break
    [[ "${SECONDS}" -lt "${deadline}" ]] || exit 70
    sleep 0.02
  done
  return 1
}

t2_lock_acquire
printf 'ACQUIRED %s\n' "$$" >>"${TEST_RESULT_FILE}"
deadline=$((SECONDS + 10))
while [[ ! -e "${TEST_RELEASE_FILE}" ]]; do
  [[ "${SECONDS}" -lt "${deadline}" ]] || exit 71
  sleep 0.02
done
t2_lock_release 0
SH
chmod +x "${TMP_DIR}/worker.sh"

worker_env=(
  TEST_COMMON="${ROOT}/scripts/minikube/t2-common.sh"
  TEST_PROJECT_DIR="${ROOT}"
  TEST_READY_FILE="${READY_FILE}"
  TEST_RESULT_FILE="${RESULT_FILE}"
  TEST_RELEASE_FILE="${RELEASE_FILE}"
  T2_LOCK_ROOT="${LOCK_ROOT}"
  T2_PROFILE=race-profile
  T2_CONTEXT=race-profile
  MINIKUBE_PROFILE=race-profile
)

env "${worker_env[@]}" bash "${TMP_DIR}/worker.sh" >"${TMP_DIR}/worker-1.out" 2>&1 &
worker_1=$!
env "${worker_env[@]}" bash "${TMP_DIR}/worker.sh" >"${TMP_DIR}/worker-2.out" 2>&1 &
worker_2=$!

deadline=$((SECONDS + 10))
while [[ "$(wc -l <"${RESULT_FILE}" | tr -d ' ')" -lt 1 ]]; do
  if ! kill -0 "${worker_1}" >/dev/null 2>&1 && ! kill -0 "${worker_2}" >/dev/null 2>&1; then
    cat "${TMP_DIR}/worker-1.out" "${TMP_DIR}/worker-2.out" >&2
    echo 'FAIL: both stale-lock reclaimers exited before acquiring the lock' >&2
    exit 1
  fi
  [[ "${SECONDS}" -lt "${deadline}" ]] || {
    echo 'FAIL: stale-lock race did not produce a winner' >&2
    exit 1
  }
  sleep 0.02
done

[[ "$(wc -l <"${RESULT_FILE}" | tr -d ' ')" -eq 1 ]] || {
  cat "${RESULT_FILE}" >&2
  echo 'FAIL: two stale-lock reclaimers entered the critical section' >&2
  exit 1
}
winner_pid="$(awk '{print $2}' "${RESULT_FILE}")"
[[ "$(sed -n 's/^PID=//p' "${LOCK_DIR}/owner.env")" == "${winner_pid}" ]] || {
  echo 'FAIL: active lock owner does not match the sole reclaimer' >&2
  exit 1
}
[[ ! -e "${LOCK_DIR}/.reclaim" ]] || {
  echo 'FAIL: losing reclaimer left a claim inside the active replacement lock' >&2
  exit 1
}

: >"${RELEASE_FILE}"
set +e
wait "${worker_1}"; rc_1=$?
wait "${worker_2}"; rc_2=$?
set -e
if ! { [[ "${rc_1}" -eq 0 && "${rc_2}" -ne 0 ]] || [[ "${rc_2}" -eq 0 && "${rc_1}" -ne 0 ]]; }; then
  cat "${TMP_DIR}/worker-1.out" "${TMP_DIR}/worker-2.out" >&2
  echo "FAIL: expected one successful reclaimer and one fail-closed contender (rc=${rc_1},${rc_2})" >&2
  exit 1
fi
[[ ! -e "${LOCK_DIR}" ]] || {
  echo 'FAIL: winning reclaimer did not release its lock' >&2
  exit 1
}

cat "${TMP_DIR}/worker-1.out" "${TMP_DIR}/worker-2.out" | \
  grep -Eq 'stale lock is already being reclaimed|became live while its stale lock was being reclaimed|unable to acquire the profile lock' || {
    echo 'FAIL: losing reclaimer did not report a fail-closed lock conflict' >&2
    exit 1
  }

printf 'PASS: concurrent stale-lock reclaim admits exactly one owner and preserves its replacement lock\n'
