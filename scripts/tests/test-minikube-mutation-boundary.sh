#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PROFILE=boundary-profile
TOKEN=boundary-test-token
LOCK_ROOT="${TMP_DIR}/locks"
LOCK_DIR="${LOCK_ROOT}/${PROFILE}.lock"
LOG="${TMP_DIR}/mutations.log"
mkdir -p "${LOCK_DIR}"

BRANCH="$(git -C "${ROOT}" branch --show-current)"
HEAD="$(git -C "${ROOT}" rev-parse --verify HEAD)"
WORKTREE_ID="$(printf '%s' "${ROOT}" | shasum | awk '{print $1}')"
LOCK_KEY="$(printf '%s\0%s\0%s\0%s\0%s' "${ROOT}" "${BRANCH}" "${HEAD}" "${PROFILE}" "${PROFILE}" | shasum | awk '{print $1}')"
cat >"${LOCK_DIR}/owner.env" <<EOF
REPOSITORY=${ROOT}
BRANCH=${BRANCH}
HEAD=${HEAD}
PROFILE=${PROFILE}
CONTEXT=${PROFILE}
WORKTREE_ID=${WORKTREE_ID}
LOCK_KEY=${LOCK_KEY}
TOKEN=${TOKEN}
PID=$$
PROCESS_START=unavailable
EOF

run_child() {
  T2_PROJECT_DIR="${ROOT}" T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
    T2_LOCK_ROOT="${LOCK_ROOT}" T2_LOCK_TOKEN="${TOKEN}" \
    bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" &&
    printf 'mutation\n' >>"${LOG}"
}

run_child
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: valid inherited lease did not reach the child boundary' >&2
  exit 1
}

if T2_PROJECT_DIR="${ROOT}" T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
  T2_LOCK_ROOT="${LOCK_ROOT}" T2_LOCK_TOKEN=wrong-token \
  bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" >/dev/null 2>&1; then
  echo 'FAIL: random token was accepted by the child mutation boundary' >&2
  exit 1
fi
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: invalid lease token reached a mutating child' >&2
  exit 1
}

if T2_PROJECT_DIR="${ROOT}" T2_PROFILE="${PROFILE}" T2_CONTEXT=wrong-context \
  T2_LOCK_ROOT="${LOCK_ROOT}" T2_LOCK_TOKEN="${TOKEN}" \
  bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" >/dev/null 2>&1; then
  echo 'FAIL: profile/context mismatch was accepted by the child mutation boundary' >&2
  exit 1
fi
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: mismatched effective context reached a mutating child' >&2
  exit 1
}

printf 'PASS: child mutation boundary requires the exact live profile lease and target context\n'
