#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
T2_TEST_RESTORE_DETACHED=false
T2_TEST_HEAD=""
T2_TEST_BRANCH=""
cleanup() {
  if [[ "${T2_TEST_RESTORE_DETACHED}" == true ]]; then
    git -C "${ROOT}" switch --quiet --detach "${T2_TEST_HEAD}" || true
    git -C "${ROOT}" branch -D "${T2_TEST_BRANCH}" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

PROFILE=boundary-profile
TOKEN=boundary-test-token
LOCK_ROOT="${TMP_DIR}/locks"
LOCK_DIR="${LOCK_ROOT}/${PROFILE}.lock"
LOG="${TMP_DIR}/mutations.log"
mkdir -p "${LOCK_DIR}"

BRANCH="$(git -C "${ROOT}" branch --show-current)"
HEAD="$(git -C "${ROOT}" rev-parse --verify HEAD)"
if [[ -z "${BRANCH}" ]]; then
  BRANCH="${GITHUB_HEAD_REF:-detached-ci-test}"
  git -C "${ROOT}" switch --quiet --create "${BRANCH}" "${HEAD}"
  T2_TEST_HEAD="${HEAD}"
  T2_TEST_BRANCH="${BRANCH}"
  T2_TEST_RESTORE_DETACHED=true
fi
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

# GNU Make may execute recipe lines containing $(MAKE) during a dry run. Force
# the dry-run flag into the child environment so with-t2-mutation-lock.sh
# exits before a plan can touch profile state on CI.
dry_run_make() {
  MAKEFLAGS=-n make -n -C "${ROOT}" "$@"
}

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

full_plan="$(dry_run_make minikube-build-images 2>&1)"
full_body_plan="$(dry_run_make minikube-build-images-body 2>&1)"
targeted_plan="$(dry_run_make minikube-deploy-service SVC=control-api NS=control-plane 2>&1)"
targeted_body_plan="$(dry_run_make minikube-deploy-service-body SVC=control-api NS=control-plane 2>&1)"
restart_plan="$(dry_run_make minikube-restart-deploy SVC=control-api NS=control-plane 2>&1)"
restart_body_plan="$(dry_run_make minikube-restart-deploy-body SVC=control-api NS=control-plane 2>&1)"
e2e_fixture_plan="$(dry_run_make minikube-build-e2e-fixtures 2>&1)"
e2e_fixture_body_plan="$(dry_run_make minikube-build-e2e-fixtures-body 2>&1)"
verify_plan="$(dry_run_make minikube-verify-images 2>&1)"

[[ "$full_plan" == *"with-t2-mutation-lock.sh"* \
  && "$full_body_plan" == *"require-t2-mutation-lock.sh"* ]] || {
  echo 'FAIL: full local image build is not enclosed by the T2 mutation lease' >&2
  exit 1
}
[[ "$targeted_plan" == *"with-t2-mutation-lock.sh"* \
  && "$targeted_body_plan" == *"require-t2-mutation-lock.sh"* \
  && "$targeted_body_plan" == *"build-images.sh --only=control-api"* ]] || {
  echo 'FAIL: targeted local image build is not enclosed by the T2 mutation lease' >&2
  exit 1
}
[[ "$restart_plan" == *"with-t2-mutation-lock.sh"* \
  && "$restart_body_plan" == *"require-t2-mutation-lock.sh"* \
  && "$restart_body_plan" == *"rollout restart deployment/control-api"* ]] || {
  echo 'FAIL: targeted deployment restart is not enclosed by the T2 mutation lease' >&2
  exit 1
}
[[ "$e2e_fixture_plan" == *"with-t2-mutation-lock.sh"* \
  && "$e2e_fixture_body_plan" == *"require-t2-mutation-lock.sh"* \
  && "$e2e_fixture_body_plan" == *"build-images.sh --only=workflow-custom-sdk-e2e"* \
  && "$e2e_fixture_body_plan" == *"build-images.sh --only=workflow-plugin-sdk-e2e"* ]] || {
  echo 'FAIL: E2E fixture image builds are not enclosed by one T2 mutation lease' >&2
  exit 1
}
[[ "$verify_plan" != *"with-t2-mutation-lock.sh"* \
  && "$verify_plan" != *"require-t2-mutation-lock.sh"* \
  && "$verify_plan" == *"build-images.sh --verify-only"* ]] || {
  echo 'FAIL: read-only image verification was incorrectly placed behind a mutation lease' >&2
  exit 1
}

printf 'PASS: child mutation boundary requires the exact live profile lease and target context\n'
printf 'PASS: image builds and targeted deployment mutations require the lease while verify-only stays read-only\n'
