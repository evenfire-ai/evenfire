#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
MUTATION_WRAPPER="${ROOT}/scripts/minikube/with-t2-mutation-lock.sh"
TMP_DIR="$(mktemp -d)"
source "${ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"

MINIKUBE_TEST_PROFILE="clerum-boundary-1234abcd"
MINIKUBE_TEST_CONTEXT="${MINIKUBE_TEST_PROFILE}"
minikube_test_fixture_repo_init "${ROOT}" "${TMP_DIR}"
cleanup() {
  local status=$?
  trap - EXIT
  if ! minikube_test_assert_host_unchanged; then
    status=1
  fi
  rm -rf "${TMP_DIR}"
  exit "${status}"
}
trap cleanup EXIT

PROFILE="${MINIKUBE_TEST_PROFILE}"
TOKEN=boundary-test-token
LOCK_ROOT="${TMP_DIR}/locks"
LOCK_DIR="${LOCK_ROOT}/${PROFILE}.lock"
LOG="${TMP_DIR}/mutations.log"
mkdir -p "${LOCK_DIR}"

BRANCH="${MINIKUBE_TEST_BRANCH}"
HEAD="${MINIKUBE_TEST_HEAD}"
WORKTREE_ID="${MINIKUBE_TEST_WORKTREE_ID}"
LOCK_KEY="${MINIKUBE_TEST_LOCK_KEY}"
write_owner() {
  local owner_pid="${1:-$$}"
  cat >"${LOCK_DIR}/owner.env" <<EOF
REPOSITORY=${MINIKUBE_TEST_PROJECT_DIR}
BRANCH=${BRANCH}
HEAD=${HEAD}
PROFILE=${PROFILE}
CONTEXT=${PROFILE}
WORKTREE_ID=${WORKTREE_ID}
LOCK_KEY=${LOCK_KEY}
TOKEN=${TOKEN}
PID=${owner_pid}
PROCESS_START=unavailable
EOF
}
write_owner

# GNU Make may execute recipe lines containing $(MAKE) during a dry run. Force
# the dry-run flag into the child environment so with-t2-mutation-lock.sh
# exits before a plan can touch profile state on CI.
dry_run_make() {
  local output status
  if output="$(MAKEFLAGS=-n make -n -C "${ROOT}" "$@" 2>&1)"; then
    printf '%s\n' "${output}"
    return 0
  else
    status=$?
  fi
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
  else
    status=$?
  fi
  printf 'FAIL: valid inherited lease child exited %s (branch=%s head=%s)\n' \
    "${status}" "${BRANCH}" "${HEAD}" >&2
  return "${status}"
}

assert_makeflags_dry_run_matrix() {
  local flags label output status sentinel lock_root profile_root
  local dry_flags='n --no-print-directory|ns --no-print-directory|kn --no-print-directory|rns --no-print-directory|--dry-run|--just-print|--recon'
  local non_dry_flags='--no-print-directory|NAME=contains-n'

  IFS='|' read -r -a dry_cases <<<"${dry_flags}"
  for flags in "${dry_cases[@]}"; do
    label="$(printf '%s' "${flags}" | tr ' =-' '_')"
    sentinel="${TMP_DIR}/${label}.sentinel"
    lock_root="${TMP_DIR}/${label}.locks"
    profile_root="${TMP_DIR}/${label}.profiles"
    mkdir -p "${lock_root}" "${profile_root}"
    output=""; status=0
    MAKEFLAGS="${flags}" T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" \
      T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
      MINIKUBE_PROFILE="${PROFILE}" CONTROL_API_REAL_PG_CONTEXT="${PROFILE}" \
      T2_PROFILE_ROOT="${profile_root}" T2_LOCK_ROOT="${lock_root}" \
      SENTINEL="${sentinel}" \
      bash "${MUTATION_WRAPPER}" -- bash -c 'printf invoked >"${SENTINEL}"' \
      >"${TMP_DIR}/${label}.out" 2>&1 || status=$?
    output="$(cat "${TMP_DIR}/${label}.out")"
    if [ "${status}" -ne 0 ] || [ -e "${sentinel}" ] \
       || [ -n "$(find "${lock_root}" -mindepth 1 -print -quit)" ] \
       || [ -n "$(find "${profile_root}" -mindepth 1 -print -quit)" ]; then
      printf 'FAIL: MAKEFLAGS=%s did not stop before mutation: rc=%s output=%s\n' \
        "${flags}" "${status}" "${output}" >&2
      exit 1
    fi
  done

  IFS='|' read -r -a non_dry_cases <<<"${non_dry_flags}"
  for flags in "${non_dry_cases[@]}"; do
    label="non-dry-$(printf '%s' "${flags}" | tr ' =-' '_')"
    sentinel="${TMP_DIR}/${label}.sentinel"
    lock_root="${TMP_DIR}/${label}.locks"
    profile_root="${TMP_DIR}/${label}.profiles"
    mkdir -p "${lock_root}" "${profile_root}"
    output=""; status=0
    MAKEFLAGS="${flags}" T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" \
      T2_PROFILE="${PROFILE}" T2_CONTEXT="${PROFILE}" \
      MINIKUBE_PROFILE="${PROFILE}" CONTROL_API_REAL_PG_CONTEXT="${PROFILE}" \
      T2_PROFILE_ROOT="${profile_root}" T2_LOCK_ROOT="${lock_root}" \
      SENTINEL="${sentinel}" \
      bash "${MUTATION_WRAPPER}" -- bash -c 'printf invoked >"${SENTINEL}"' \
      >"${TMP_DIR}/${label}.out" 2>&1 || status=$?
    output="$(cat "${TMP_DIR}/${label}.out")"
    if [ "${status}" -eq 0 ] || [ -e "${sentinel}" ]; then
      printf 'FAIL: MAKEFLAGS=%s was treated as a dry-run: rc=%s output=%s\n' \
        "${flags}" "${status}" "${output}" >&2
      exit 1
    fi
  done

  printf 'PASS: compact and long GNU Make dry-run flags stop the real wrapper before profile or lock mutation\n'
}

assert_wrc_admission() {
  local fixture_scripts="${MINIKUBE_TEST_PROJECT_DIR}/scripts"
  local fixture_entry="${fixture_scripts}/e2e/e2e-wrc-egress-degradation.sh"
  local fixture_wrapper="${fixture_scripts}/minikube/with-t2-mutation-lock.sh"
  local fake_bin="${TMP_DIR}/wrc-admission-bin"
  local entry_log="${TMP_DIR}/wrc-entry.log"
  local cluster_log="${TMP_DIR}/wrc-cluster.log"
  local output="${TMP_DIR}/wrc-admission.out"
  local real_node owner_before journal status
  real_node="$(command -v node)"
  mkdir -p "${fixture_scripts}/e2e/_lib" "${fixture_scripts}/minikube" "${fake_bin}"
  # Keep the fixture repository clean for the real wrapper's Git admission.
  # No Git operation or exclusion is applied to the host checkout.
  printf '/scripts/\n/.local-notes/\n' >>"${MINIKUBE_TEST_PROJECT_DIR}/.git/info/exclude"
  cp "${ROOT}/scripts/e2e/e2e-wrc-egress-degradation.sh" "${fixture_entry}"
  cp "${ROOT}/scripts/e2e/e2e-lib.sh" "${fixture_scripts}/e2e/e2e-lib.sh"
  cp "${ROOT}/scripts/e2e/_lib/hcc-watch-recovery-fixture.sh" "${fixture_scripts}/e2e/_lib/hcc-watch-recovery-fixture.sh"
  cp "${MUTATION_WRAPPER}" "${fixture_wrapper}"
  cp "${ROOT}/scripts/minikube/require-t2-mutation-lock.sh" "${fixture_scripts}/minikube/require-t2-mutation-lock.sh"
  cp "${ROOT}/scripts/minikube/t2-common.sh" "${fixture_scripts}/minikube/t2-common.sh"
  # Only runtime discovery/health is faked. Git admission, lease validation,
  # journal refusal, recovery dispatch, and lease release execute the real code.
  cat >>"${fixture_scripts}/minikube/t2-common.sh" <<'SH'
t2_require_commands() { :; }
t2_profile_scope() { :; }
t2_profile_status() { T2_BOOTSTRAP_REQUIRED=false; }
t2_context_check() { :; }
t2_profile_context_identity_check() { :; }
SH
  cat >"${fake_bin}/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "$WRC_ADMISSION_GUARD" && "$#" -eq 3 ]]; then
  exec "$WRC_ADMISSION_NODE" "$@"
fi
if [[ "$1" == "$WRC_ADMISSION_RUNNER" && "$#" -eq 2 && "$2" == --recover ]]; then
  printf '%s\n' "$2" >>"$WRC_ADMISSION_ENTRY_LOG"
  exit 0
fi
printf 'unexpected Node runtime dispatch\n' >>"$WRC_ADMISSION_ENTRY_LOG"
exit 99
SH
  cat >"${fake_bin}/kubectl" <<'SH'
#!/usr/bin/env bash
printf 'unexpected cluster operation\n' >>"$WRC_ADMISSION_CLUSTER_LOG"
exit 99
SH
  chmod +x "${fake_bin}/node" "${fake_bin}/kubectl"
  : >"${entry_log}"; : >"${cluster_log}"

  invoke_wrc() {
    local surface="$1" lease_token="$2" effective_context="$3" acknowledgement="$4"
    shift 4
    local script="${fixture_entry}"
    [[ "$surface" != wrapper ]] || script="${fixture_wrapper}"
    PATH="${fake_bin}:${PATH}" MAKEFLAGS= \
      T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" T2_SCRIPT_DIR="${ROOT}/scripts/minikube" \
      T2_PROFILE="${PROFILE}" T2_CONTEXT="${effective_context}" T2_LOCK_ROOT="${LOCK_ROOT}" \
      T2_LOCK_TOKEN="${lease_token}" T2_SKIP_LOCK=true T2_MUTATION_LOCK_WRAPPED=true \
      T2_PROFILE_ROOT="${TMP_DIR}/wrc-profiles" T2_GATE_ID=wrc-egress-recovery \
      MINIKUBE_PROFILE="${PROFILE}" KUBECONTEXT="${PROFILE}" \
      CONTROL_API_REAL_PG_CONTEXT="${effective_context}" \
      E2E_WRC_EGRESS_FAULT_INJECTION="${acknowledgement}" \
      WRC_ADMISSION_GUARD="${ROOT}/scripts/minikube/../e2e/_lib/wrc-egress-lifecycle.cjs" \
      WRC_ADMISSION_RUNNER="${fixture_scripts}/e2e/_lib/wrc-egress-gate.cjs" \
      WRC_ADMISSION_NODE="${real_node}" WRC_ADMISSION_ENTRY_LOG="${entry_log}" \
      WRC_ADMISSION_CLUSTER_LOG="${cluster_log}" bash "${script}" "$@"
  }
  expect_wrc_refusal() {
    local description="$1" reason="$2"
    shift 2
    : >"${entry_log}"; : >"${cluster_log}"
    status=0
    invoke_wrc "$@" >"${output}" 2>&1 || status=$?
    if [[ "$status" -eq 0 || -s "$entry_log" || -s "$cluster_log" ]] || ! grep -Fq "$reason" "$output"; then
      printf 'FAIL: %s did not refuse before runtime dispatch (exit=%s)\n' "$description" "$status" >&2
      cat "$output" >&2
      exit 1
    fi
  }

  expect_wrc_refusal 'direct gate without a lease' PROFILE_LOCK_REQUIRED entry '' "$PROFILE" 1
  expect_wrc_refusal 'wrapped boolean with false inherited token' PROFILE_LOCK_REQUIRED entry wrong-token "$PROFILE" 1
  expect_wrc_refusal 'direct recovery without a lease' PROFILE_LOCK_REQUIRED entry '' "$PROFILE" 0 --recover
  expect_wrc_refusal 'direct entry with mismatched context' 'inherited lease target differs' entry "$TOKEN" wrong-context 1
  expect_wrc_refusal 'valid lease without fault acknowledgement' 'explicit fault-injection acknowledgement' entry "$TOKEN" "$PROFILE" 0
  expect_wrc_refusal 'recovery with arbitrary extra command' usage wrapper "$TOKEN" "$PROFILE" 0 --recover-wrc-egress -- bash -c true
  expect_wrc_refusal 'wrapper recovery with mismatched context' PROFILE_LOCK_REQUIRED wrapper "$TOKEN" wrong-context 0 --recover-wrc-egress

  # This deliberately impossible PID cannot belong to another local process.
  if kill -0 2147483647 2>/dev/null; then
    printf 'FAIL: dead-owner PID fixture unexpectedly exists\n' >&2
    exit 1
  fi
  write_owner 2147483647
  expect_wrc_refusal 'dead inherited owner' PROFILE_LOCK_REQUIRED entry "$TOKEN" "$PROFILE" 0 --recover
  expect_wrc_refusal 'dedicated recovery with dead inherited owner' PROFILE_LOCK_REQUIRED wrapper "$TOKEN" "$PROFILE" 0 --recover-wrc-egress
  write_owner

  journal="$(node - "${ROOT}/scripts/e2e/_lib/wrc-egress-lifecycle.cjs" "${MINIKUBE_TEST_PROJECT_DIR}" "$PROFILE" <<'NODE'
const { Journal, journalPath } = require(process.argv[2])
const { randomUUID } = require('node:crypto')
const repository = process.argv[3], profile = process.argv[4]
const file = journalPath(repository, profile)
new Journal(file, { version: 1, runId: randomUUID(), phase: 'DNS-injected',
  binding: { repository, profile, context: profile, branch: process.env.MINIKUBE_TEST_BRANCH,
    head: process.env.MINIKUBE_TEST_HEAD }, resources: [] })
process.stdout.write(file)
NODE
  )"
  owner_before="$(shasum -a 256 "${LOCK_DIR}/owner.env")"
  expect_wrc_refusal 'ordinary mutation over pending journal' WRC_EGRESS_RECOVERY_REQUIRED wrapper "$TOKEN" "$PROFILE" 1 -- bash "$fixture_entry"
  expect_wrc_refusal 'recovery path with false inheritance' PROFILE_LOCK_REQUIRED wrapper wrong-token "$PROFILE" 0 --recover-wrc-egress
  for surface in entry wrapper; do
    : >"${entry_log}"; : >"${cluster_log}"
    status=0
    if [[ "$surface" == entry ]]; then
      invoke_wrc entry "$TOKEN" "$PROFILE" 0 --recover >"${output}" 2>&1 || status=$?
    else
      invoke_wrc wrapper "$TOKEN" "$PROFILE" 0 --recover-wrc-egress >"${output}" 2>&1 || status=$?
    fi
    if [[ "$status" -ne 0 || "$(cat "$entry_log")" != --recover || -s "$cluster_log" \
      || ! -f "$journal" || "$(shasum -a 256 "${LOCK_DIR}/owner.env")" != "$owner_before" ]]; then
      printf 'FAIL: dedicated %s recovery did not preserve the inherited lease and dispatch only recovery\n' "$surface" >&2
      cat "$output" >&2
      exit 1
    fi
  done
  printf 'PASS: WRC direct entry, pending journal and dedicated recovery enforce the real inherited lease\n'
}

run_child
[[ "$(wc -l <"${LOG}" | tr -d ' ')" -eq 1 ]] || {
  echo 'FAIL: valid inherited lease did not reach the child boundary' >&2
  exit 1
}

assert_makeflags_dry_run_matrix

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

assert_wrc_admission

full_plan="$(dry_run_make minikube-build-images 2>&1)"
full_body_plan="$(dry_run_make minikube-build-images-body 2>&1)"
targeted_plan="$(dry_run_make minikube-deploy-service SVC=control-api NS=control-plane 2>&1)"
targeted_body_plan="$(dry_run_make minikube-deploy-service-body SVC=control-api NS=control-plane 2>&1)"
restart_plan="$(dry_run_make minikube-restart-deploy SVC=control-api NS=control-plane 2>&1)"
restart_body_plan="$(dry_run_make minikube-restart-deploy-body SVC=control-api NS=control-plane 2>&1)"
e2e_fixture_plan="$(dry_run_make minikube-build-e2e-fixtures 2>&1)"
e2e_fixture_body_plan="$(dry_run_make minikube-build-e2e-fixtures-body 2>&1)"
verify_plan="$(dry_run_make minikube-verify-images 2>&1)"
wrc_plan="$(dry_run_make test-e2e-wrc-egress-degradation E2E_KUBECONTEXT="$PROFILE" E2E_EXPECTED_PRE_GATE_GATE=unit-gate 2>&1)"
wrc_recovery_plan="$(dry_run_make test-e2e-wrc-egress-recover E2E_KUBECONTEXT="$PROFILE" 2>&1)"

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
[[ "$wrc_plan" == *"with-t2-mutation-lock.sh -- bash scripts/e2e/e2e-wrc-egress-degradation.sh"* \
  && "$wrc_plan" == *"T2_SKIP_LOCK="* && "$wrc_plan" == *"T2_LOCK_TOKEN="* \
  && "$wrc_plan" == *"T2_PROFILE=\"${PROFILE}\""* && "$wrc_plan" == *"T2_CONTEXT=\"${PROFILE}\""* \
  && "$wrc_recovery_plan" == *"with-t2-mutation-lock.sh --recover-wrc-egress"* \
  && "$wrc_recovery_plan" != *"--recover-wrc-egress --"* \
  && "$wrc_recovery_plan" == *"T2_SKIP_LOCK="* && "$wrc_recovery_plan" == *"T2_LOCK_TOKEN="* ]] || {
  echo 'FAIL: WRC gate/recovery Make targets do not preserve the canonical lease and dedicated recovery dispatch' >&2
  exit 1
}

printf 'PASS: child mutation boundary requires the exact live profile lease and target context\n'
printf 'PASS: image builds and targeted deployment mutations require the lease while verify-only stays read-only\n'
