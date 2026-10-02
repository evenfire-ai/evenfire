#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
source "${ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"
minikube_test_fixture_repo_init "${ROOT}" "${TMP_DIR}"
cleanup() {
  local status=$?
  trap - EXIT
  minikube_test_assert_host_unchanged || status=1
  rm -rf -- "${TMP_DIR}"
  exit "${status}"
}
trap cleanup EXIT

FIXTURE="${MINIKUBE_TEST_PROJECT_DIR}"
mkdir -p "${FIXTURE}/scripts/minikube" "${TMP_DIR}/bin"
cp "${ROOT}/scripts/minikube/remove-evenfire-registry.sh" "${FIXTURE}/scripts/minikube/"
# The lease validator is an external boundary for these cleanup assertions;
# test-minikube-mutation-boundary.sh exercises its real ownership protocol.
cat >"${FIXTURE}/scripts/minikube/require-t2-mutation-lock.sh" <<'SH'
[[ "${FIXTURE_LEASE_VALID:-false}" == true ]] || exit 73
printf 'lease-validated\n' >>"${FIXTURE_CALLS}"
SH
cat >"${TMP_DIR}/bin/kubectl" <<'SH'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >>"${FIXTURE_CALLS}"
[[ "${FIXTURE_KUBECTL_FAIL:-false}" != true ]] || exit 74
SH
chmod +x "${TMP_DIR}/bin/kubectl"
export PATH="${TMP_DIR}/bin:${PATH}"
export FIXTURE_CALLS="${TMP_DIR}/calls"
SCRIPT="${FIXTURE}/scripts/minikube/remove-evenfire-registry.sh"
PROFILE=fixture-registry-cleanup

run_cleanup() {
  MINIKUBE_PROFILE="${PROFILE}" CONTROL_API_REAL_PG_CONTEXT="${1}" \
    FIXTURE_LEASE_VALID="${2}" FIXTURE_KUBECTL_FAIL="${3:-false}" \
    bash "${SCRIPT}" >"${TMP_DIR}/output" 2>&1
}
assert_live_cleanup() {
  : >"${FIXTURE_CALLS}"
  run_cleanup "${PROFILE}" true
  [[ "$(head -n 1 "${FIXTURE_CALLS}")" == lease-validated ]]
  [[ "$(wc -l <"${FIXTURE_CALLS}" | tr -d ' ')" == 3 ]]
  grep -Fq -- "--context=${PROFILE} --request-timeout=20s -n registry delete deployment registry-api registry-minio registry-postgres registry-zot" "${FIXTURE_CALLS}"
  grep -Fq -- "--context=${PROFILE} --request-timeout=20s -n registry delete service registry-api registry-minio registry-postgres registry-zot" "${FIXTURE_CALLS}"
  ! grep -Eq 'delete (namespace|pvc|secret|configmap)|kube-system' "${FIXTURE_CALLS}"
  grep -Eq '^LOCAL_REGISTRY_REMOVAL=PASS$' "${TMP_DIR}/output"
}

: >"${FIXTURE_CALLS}"
if run_cleanup another-context true; then exit 1; fi
[[ ! -s "${FIXTURE_CALLS}" ]]
assert_live_cleanup
printf 'PASS: mismatched context fails before calls; matching leased cleanup is live\n'

: >"${FIXTURE_CALLS}"
if run_cleanup "${PROFILE}" false; then exit 1; fi
[[ ! -s "${FIXTURE_CALLS}" ]]
assert_live_cleanup
printf 'PASS: invalid lease prevents mutation; valid lease admits named cleanup\n'

: >"${FIXTURE_CALLS}"
if run_cleanup "${PROFILE}" true true; then exit 1; fi
[[ "$(wc -l <"${FIXTURE_CALLS}" | tr -d ' ')" == 2 ]]
! grep -Eq '^LOCAL_REGISTRY_REMOVAL=PASS$' "${TMP_DIR}/output"
assert_live_cleanup
printf 'PASS: Kubernetes failure is propagated; restored boundary completes cleanup\n'

dry_output="$(MAKEFLAGS=-n make -n -C "${ROOT}" minikube-remove-evenfire-registry MINIKUBE_PROFILE="${PROFILE}" 2>&1)"
[[ "${dry_output}" == *with-t2-mutation-lock.sh* ]]
[[ "${dry_output}" == *minikube-remove-evenfire-registry-body* ]]
[[ "${dry_output}" != *LOCAL_REGISTRY_REMOVAL=PASS* ]]
assert_live_cleanup
printf 'PASS: public removal enters the mutation wrapper and dry-run remains inert\n'

printf 'TEST_TOTAL=4 TEST_FAILED=0\n'
