#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
source "${ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"

MINIKUBE_TEST_PROFILE="boundary-profile"
MINIKUBE_TEST_CONTEXT="boundary-profile"
minikube_test_fixture_repo_init "${ROOT}" "${TMP_DIR}"
cleanup() {
  local status=$?
  if ! minikube_test_assert_host_unchanged; then
    status=1
  fi
  rm -rf "${TMP_DIR}"
  return "${status}"
}
trap cleanup EXIT

PROFILE=boundary-profile
TOKEN=boundary-test-token
LOCK_ROOT="${TMP_DIR}/locks"
LOCK_DIR="${LOCK_ROOT}/${PROFILE}.lock"
LOG="${TMP_DIR}/mutations.log"
mkdir -p "${LOCK_DIR}"

BRANCH="${MINIKUBE_TEST_BRANCH}"
HEAD="${MINIKUBE_TEST_HEAD}"
WORKTREE_ID="${MINIKUBE_TEST_WORKTREE_ID}"
LOCK_KEY="${MINIKUBE_TEST_LOCK_KEY}"
cat >"${LOCK_DIR}/owner.env" <<EOF
REPOSITORY=${MINIKUBE_TEST_PROJECT_DIR}
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
  local output status
  if output="$(MAKEFLAGS=-n make -n -C "${ROOT}" "$@" 2>&1)"; then
    printf '%s\n' "${output}"
    return 0
  fi
  status=$?
  printf 'FAIL: dry-run make %s exited %s\n%s\n' "$*" "${status}" "${output}" >&2
  return "${status}"
}

run_child() {
  local status
  if T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
    T2_LOCK_ROOT="${LOCK_ROOT}" T2_LOCK_TOKEN="${TOKEN}" \
    bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh"; then
    printf 'mutation\n' >>"${LOG}"
    return 0
  fi
  status=$?
  printf 'FAIL: valid inherited lease child exited %s (branch=%s head=%s)\n' \
    "${status}" "${BRANCH}" "${HEAD}" >&2
  return "${status}"
}

run_child
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: valid inherited lease did not reach the child boundary' >&2
  exit 1
}

if T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
  T2_LOCK_ROOT="${LOCK_ROOT}" T2_LOCK_TOKEN=wrong-token \
  bash "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" >/dev/null 2>&1; then
  echo 'FAIL: random token was accepted by the child mutation boundary' >&2
  exit 1
fi
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: invalid lease token reached a mutating child' >&2
  exit 1
}

if T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" T2_PROFILE="${PROFILE}" T2_CONTEXT=wrong-context \
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
