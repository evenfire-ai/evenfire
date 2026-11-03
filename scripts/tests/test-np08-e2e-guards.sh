#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
E2E_SCRIPT="${ROOT}/scripts/e2e/e2e-np08-hcc-authorization.sh"
RUNTIME_ACCESS_MODULE="${ROOT}/scripts/e2e/_lib/np08-runtime-access.mjs"
RUNTIME_ACCESS_TEST="${ROOT}/scripts/tests/test-np08-runtime-access.mjs"
T2_SCRIPT="${ROOT}/scripts/minikube/t2.sh"
MAKEFILE="${ROOT}/Makefile"

# shellcheck source=scripts/e2e/_lib/np08-cleanup.sh
source "${ROOT}/scripts/e2e/_lib/np08-cleanup.sh"
# shellcheck source=scripts/e2e/_lib/np08-provenance.sh
source "${ROOT}/scripts/e2e/_lib/np08-provenance.sh"
# shellcheck source=scripts/e2e/_lib/np08-rollout.sh
source "${ROOT}/scripts/e2e/_lib/np08-rollout.sh"

# Consumed dynamically by the sourced cleanup helper.
# shellcheck disable=SC2034
MCP_NS='mcp-server'
KCTL_RESULT='empty'

kctl() {
  case "${KCTL_RESULT}" in
    empty)
      return 0
      ;;
    residual)
      printf '%s\n' 'mcpserver/owned-fixture'
      return 0
      ;;
    error)
      printf '%s\n' 'secret/owned-fixture'
      printf '%s\n' 'simulated kubectl read error' >&2
      return 42
      ;;
    *)
      return 99
      ;;
  esac
}

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

KCTL_RESULT='empty'
np08_cleanup_check_residual mcpserver 'np08.evenfire/run=test' || \
  fail 'an empty successful residual read failed cleanup'
pass 'cleanup accepts an empty successful residual read'

KCTL_RESULT='empty'
set +e
marker_output="$(np08_read_sync_marker control-plane marker 2>&1)"
marker_rc=$?
set -e
if [[ "${marker_rc}" -eq 0 || -n "${marker_output}" ]]; then
  fail 'an empty marker read was treated as a valid marker'
fi
pass 'provenance rejects an empty marker read without disclosure'

KCTL_RESULT='error'
set +e
marker_output="$(np08_read_sync_marker control-plane marker 2>&1)"
marker_rc=$?
set -e
if [[ "${marker_rc}" -eq 0 || -n "${marker_output}" ]]; then
  fail 'a failed marker read was treated as a valid marker'
fi
pass 'provenance fails closed on a marker read error without disclosure'

KCTL_RESULT='residual'
set +e
cleanup_output="$(np08_cleanup_check_residual mcpserver 'np08.evenfire/run=test' 2>&1)"
cleanup_rc=$?
set -e
if [[ "${cleanup_rc}" -eq 0 ]]; then
  fail 'a residual object was treated as clean'
fi
if [[ -n "${cleanup_output}" ]]; then
  fail 'the residual check disclosed a resource name'
fi
pass 'cleanup rejects a residual object without disclosing it'

KCTL_RESULT='error'
set +e
cleanup_output="$(np08_cleanup_check_residual secret 'np08.evenfire/run=test' 2>&1)"
cleanup_rc=$?
set -e
if [[ "${cleanup_rc}" -eq 0 ]]; then
  fail 'a failed residual read was treated as an empty result'
fi
if [[ -n "${cleanup_output}" ]]; then
  fail 'the failed residual read emitted command or Secret output'
fi
pass 'cleanup fails closed on a read error without disclosure'

if [[ "$(np08_cleanup_final_status 17 0)" != '17' ]]; then
  fail 'successful cleanup erased the prior journey failure'
fi
if [[ "$(np08_cleanup_final_status 0 1)" != '1' ]]; then
  fail 'cleanup failure did not fail an otherwise successful journey'
fi
if [[ "$(np08_cleanup_final_status 17 1)" != '1' ]]; then
  fail 'cleanup failure did not preserve a failed overall result'
fi
pass 'cleanup preserves prior failures and promotes cleanup failures'

marker_json() {
  local cluster="$1"
  local generated="$2"
  printf '%s' "{\"data\":{\"worktreeId\":\"worktree-a\",\"gitHead\":\"head-a\",\"clusterFingerprint\":\"${cluster}\",\"infraFingerprint\":\"infra-a\",\"imageSource\":\"local\",\"imageTag\":\"\",\"imagesGeneratedAt\":\"${generated}\"}}"
}

exact_marker="$(marker_json 'cluster-a' '2026-08-17T12:54:11Z')"
np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' "${exact_marker}" || \
  fail 'the exact provenance tuple was rejected'
pass 'provenance accepts the exact marker tuple'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-current' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'a wrong but non-empty cluster fingerprint was accepted'
fi
pass 'provenance rejects a wrong cluster fingerprint'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T13:00:00Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'a stale image acquisition timestamp was accepted'
fi
pass 'provenance rejects a stale image acquisition timestamp'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'local' '' '2026-08-17T12:54:11Z' 'not-json' >/dev/null 2>&1; then
  fail 'a malformed marker read was accepted'
fi
pass 'provenance fails closed on a malformed marker read'

if np08_verify_sync_marker \
  'worktree-a' 'head-a' 'cluster-a' 'infra-a' \
  'ghcr' 'v0.0.0' '2026-08-17T12:54:11Z' "${exact_marker}" >/dev/null 2>&1; then
  fail 'the local-only NP-08 E2E accepted a non-local image coordinate'
fi
pass 'provenance rejects a non-local image coordinate'

if ! grep -Fq 'np08_cleanup_check_residual' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_cleanup_final_status' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_read_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Fq 'pre_gate_marker_cluster_fingerprint' "${E2E_SCRIPT}" ||
  ! grep -Fq 'image_mode_images_generated_at' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_verify_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Eq '^for command_name in .* node;' "${E2E_SCRIPT}"; then
  fail 'the deployed E2E is not wired to every tested guard'
fi
pass 'the deployed E2E is wired to cleanup and provenance guards'

forbidden_refresh_env='MCP_HOST_RUNTIME_'"REFRESH_TOKEN"
forbidden_refresh_path='/api/v1/workflow-auth/'"refresh"
forbidden_reissue_path='/api/v1/workflow-auth/'"reissue"
for runtime_file in "${E2E_SCRIPT}" "${RUNTIME_ACCESS_MODULE}"; do
  [[ -f "${runtime_file}" ]] || fail 'the NP-08 access-only runtime module is missing'
  if grep -Fq "${forbidden_refresh_env}" "${runtime_file}" ||
    grep -Fq "${forbidden_refresh_path}" "${runtime_file}" ||
    grep -Fq "${forbidden_reissue_path}" "${runtime_file}"; then
    fail 'the deployed NP-08 path can still consume or mutate the runtime credential lineage'
  fi
done
pass 'the deployed NP-08 path is access-only and has no refresh or reissue route'

if ! grep -Fq 'NP08_RUNTIME_ACTION=health' "${E2E_SCRIPT}" ||
  ! grep -Fq 'NP08_RUNTIME_ACTION=journey' "${E2E_SCRIPT}" ||
  ! grep -Fq "node --input-type=module - < \"\${NP08_RUNTIME_MODULE}\"" "${E2E_SCRIPT}" ||
  ! grep -Fq 'approval-auth.json' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'hostRefs' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'recipeNamespace' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'recipeName' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'CLERUM_CONTEXT_MAPPER_URL' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'CLERUM_SERVER_PORT' "${RUNTIME_ACCESS_MODULE}" ||
  ! grep -Fq 'runtime_access_rotation_timeout' "${RUNTIME_ACCESS_MODULE}"; then
  fail 'the deployed E2E is not wired to the tested access observation and retry contract'
fi
pass 'the deployed journey streams the tested binding-aware access observer into mcp-host'

health_line="$(grep -n -m1 'NP08_RUNTIME_ACTION=health' "${E2E_SCRIPT}" | cut -d: -f1)"
fixture_line="$(grep -n -m1 'apply -f -' "${E2E_SCRIPT}" | cut -d: -f1)"
if [[ -z "${health_line}" || -z "${fixture_line}" || "${health_line}" -ge "${fixture_line}" ]]; then
  fail 'mcp-host runtime health is not required before fixture mutation'
fi
pass 'mcp-host runtime health is proven before fixture mutation'

for expected_status in 200 404 400 401 410; do
  grep -Fq "status !== ${expected_status}" "${RUNTIME_ACCESS_MODULE}" ||
    fail "the access-only journey lost its HTTP ${expected_status} assertion"
done
pass 'the access-only journey preserves the deployed authorization status assertions'

if grep -Fq 'clerum-codex-np-08-cross-context-mcp-token-plan-' "${E2E_SCRIPT}"; then
  fail 'the deployed E2E is still hard-wired to one historical branch profile'
fi
if ! grep -Fq '*gke*|*prod*|*staging*|clerum-test|default|minikube)' "${E2E_SCRIPT}" ||
  ! grep -Fq 'profile_branch=' "${E2E_SCRIPT}" ||
  ! grep -Fq 'current_branch=' "${E2E_SCRIPT}" ||
  ! grep -Fq "git -C \"\${PROJECT_DIR}\" status --porcelain" "${E2E_SCRIPT}"; then
  fail 'the deployed E2E does not enforce generic protected-context, branch, and clean-HEAD guards'
fi
pass 'the deployed E2E accepts only a clean branch-owned local profile'

if ! grep -Fq 'run_np08_hcc_authorization' "${T2_SCRIPT}" ||
  ! grep -Fq "CLERUM_PROFILE_PORTS_ENV=\"\$T2_PORTS_ENV\"" "${T2_SCRIPT}" ||
  ! grep -Fq 'NP08_HCC_AUTHORIZATION PASS' "${T2_SCRIPT}" ||
  ! grep -Fq "NP08_HCC_AUTHORIZATION=\$T2_NP08_HCC_AUTHORIZATION_STATUS" "${T2_SCRIPT}" ||
  ! grep -Fq 'minikube-t2-np08-hcc-authorization: minikube-t2' "${MAKEFILE}"; then
  fail 'the deployed E2E is not a required evidence-recorded canonical T2 phase'
fi
pass 'canonical local T2 records the deployed NP-08 authorization journey'

if grep -R -Fq 'e2e-np08-hcc-authorization.sh' "${ROOT}/.github/workflows"; then
  fail 'CI directly invokes the cluster-mutating NP-08 deployed journey'
fi
pass 'CI validates NP-08 wiring statically without cluster writes'

node --check "${RUNTIME_ACCESS_MODULE}"
node --test "${RUNTIME_ACCESS_TEST}"
pass 'NP-08 access selection and retry unit tests pass'

# --- rollout settle gate (token-rotation rollout killed the journey exec) ---
ROLLOUT_STATE_DIR="$(mktemp -d)"
trap 'rm -rf "${ROLLOUT_STATE_DIR}"' EXIT

deploy_item() {
  local generation="$1" observed="$2" ready="$3" updated="$4" revision="$5"
  printf '%s' "{\"apiVersion\":\"apps/v1\",\"kind\":\"Deployment\",\"metadata\":{\"name\":\"chatllm\",\"uid\":\"uid-chatllm\",\"generation\":${generation}},\"status\":{\"observedGeneration\":${observed},\"readyReplicas\":${ready},\"updatedReplicas\":${updated}},\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"clerum.io/runtime-token-revision\":\"${revision}\"}}}}}"
}

replicaset_item() {
  local name="$1" owner="$2" replicas="$3"
  printf '%s' "{\"apiVersion\":\"apps/v1\",\"kind\":\"ReplicaSet\",\"metadata\":{\"name\":\"${name}\",\"ownerReferences\":[{\"apiVersion\":\"apps/v1\",\"kind\":\"Deployment\",\"name\":\"${owner}\",\"uid\":\"uid-${owner}\"}]},\"spec\":{\"replicas\":${replicas}}}"
}

context_policy_item() {
  local context_id="$1" server_name="$2"
  printf '%s' "{\"apiVersion\":\"networking.k8s.io/v1\",\"kind\":\"NetworkPolicy\",\"metadata\":{\"name\":\"ctx-${context_id}-${server_name}-egress\",\"namespace\":\"mcp-host\",\"labels\":{\"clerum.io/managed-by\":\"host-context-controller\",\"clerum.io/policy-type\":\"context-allow\",\"clerum.io/context\":\"${context_id}\",\"clerum.io/mcpserver\":\"${server_name}\"}}}"
}

emit_list() {
  local item out=''
  for item in "$@"; do
    out="${out}${out:+,}${item}"
  done
  printf '{"apiVersion":"v1","kind":"List","items":[%s]}' "${out}"
}

rollout_index() {
  local name="$1" index=0
  [[ -f "${ROLLOUT_STATE_DIR}/${name}" ]] && index="$(cat "${ROLLOUT_STATE_DIR}/${name}")"
  index=$((index + 1))
  printf '%s' "${index}" >"${ROLLOUT_STATE_DIR}/${name}"
  printf '%s' "${index}"
}

kctl() {
  local args="$*" clock
  printf '%s\n' "${args}" >>"${ROLLOUT_STATE_DIR}/calls"
  # One logical clock for every read, so a scenario can model "HCC records the
  # change, then its Host reconcile rolls the template".
  clock="$(rollout_index clock)"
  case "${args}" in
    *'get networkpolicy'*)
      case "${ROLLOUT_SCENARIO:-settle}" in
        record-present)
          emit_list "$(context_policy_item 'context1' 'server-a')"
          ;;
        record-error)
          printf '%s\n' 'simulated networkpolicy read error' >&2
          return 42
          ;;
        hcc-reaction)
          # HCC records the Context change on the third read; the deployment
          # template rolls one read later.
          if [[ "${clock}" -ge 3 ]]; then
            emit_list "$(context_policy_item 'context1' 'server-a')"
          else
            emit_list
          fi
          ;;
        *)
          emit_list
          ;;
      esac
      ;;
    *'get deploy,rs'*)
      local index
      index="$(rollout_index deploy-index)"
      case "${ROLLOUT_SCENARIO:-settle}" in
        settle)
          # rolling, revision A complete, revision B (rotation), then B stable
          case "${index}" in
            1) emit_list "$(deploy_item 5 4 1 0 'rev-a')" "$(replicaset_item 'chatllm-5f' 'chatllm' 1)" ;;
            2) emit_list "$(deploy_item 5 5 1 1 'rev-a')" "$(replicaset_item 'chatllm-5f' 'chatllm' 1)" ;;
            *) emit_list "$(deploy_item 6 6 1 1 'rev-b')" "$(replicaset_item 'chatllm-6f' 'chatllm' 1)" ;;
          esac
          ;;
        foreign-rs)
          # A second Deployment in the same namespace owns a ReplicaSet with a
          # replica. The gate under test owns only chatllm.
          emit_list \
            "$(deploy_item 6 6 1 1 'rev-b')" \
            "$(replicaset_item 'chatllm-6f' 'chatllm' 1)" \
            "$(replicaset_item 'workflow-recipes-7c' 'workflow-recipes' 1)"
          ;;
        two-owned-rs)
          # Two ReplicaSets of the SAME Deployment are still rolling: the gate
          # must not treat that as settled.
          emit_list \
            "$(deploy_item 6 6 1 1 'rev-b')" \
            "$(replicaset_item 'chatllm-5f' 'chatllm' 1)" \
            "$(replicaset_item 'chatllm-6f' 'chatllm' 1)"
          ;;
        hcc-reaction)
          if [[ "${clock}" -ge 4 ]]; then
            emit_list "$(deploy_item 7 7 1 1 'rev-c')" "$(replicaset_item 'chatllm-next' 'chatllm' 1)"
          else
            emit_list "$(deploy_item 6 6 1 1 'rev-b')" "$(replicaset_item 'chatllm-6f' 'chatllm' 1)"
          fi
          ;;
        unstable)
          emit_list "$(deploy_item "${index}" "${index}" 1 1 "rev-${index}")" \
            "$(replicaset_item 'chatllm-current' 'chatllm' 1)"
          ;;
        never-ready)
          emit_list "$(deploy_item 5 5 0 1 'rev-a')" "$(replicaset_item 'chatllm-current' 'chatllm' 1)"
          ;;
        error)
          return 42
          ;;
      esac
      ;;
    *)
      return 99
      ;;
  esac
}

ROLLOUT_SCENARIO='settle' \
  np08_wait_rollout_settled 'mcp-host' 'chatllm' 30 3 0 ||
  fail 'rollout settle rejected a rollout that completes and then stays stable'
[[ "$(cat "${ROLLOUT_STATE_DIR}/deploy-index")" == '5' ]] ||
  fail 'rollout settle did not wait for three identical complete snapshots'
pass 'rollout settle waits out a token-rotation rollout and then requires stability'

# N8: the deployment and its ReplicaSets are read by ONE combined request, and
# the ReplicaSets are scoped to the Deployment's ownerReference (R3-L6). The
# stub answers only the combined form, so a split read fails loud here.
if grep -Fq 'get deployment ' "${ROLLOUT_STATE_DIR}/calls" ||
  grep -Fq 'get replicaset' "${ROLLOUT_STATE_DIR}/calls" ||
  ! grep -Fq 'get deploy,rs -o json' "${ROLLOUT_STATE_DIR}/calls"; then
  fail 'rollout settle did not read the deployment and its ReplicaSets in one combined request'
fi
pass 'rollout settle reads the deployment and its ReplicaSets in one request'

printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
ROLLOUT_SCENARIO='foreign-rs' \
  np08_wait_rollout_settled 'mcp-host' 'chatllm' 30 2 0 ||
  fail 'a ReplicaSet owned by another Deployment in the same namespace blocked the gate (R3-L6)'
[[ "${NP08_ROLLOUT_CERTIFIED_SNAPSHOT%%$'\t'*}" == '6' ]] ||
  fail 'the gate did not certify the settled generation of the owned Deployment'
pass 'rollout settle ignores a ReplicaSet owned by another Deployment (R3-L6)'

printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
if ROLLOUT_SCENARIO='two-owned-rs' np08_wait_rollout_settled 'mcp-host' 'chatllm' 1 2 0 >/dev/null 2>&1; then
  fail 'rollout settle accepted two ReplicaSets of the same Deployment as settled'
fi
pass 'rollout settle still requires exactly one ReplicaSet of the owned Deployment'

printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
if ROLLOUT_SCENARIO='unstable' np08_wait_rollout_settled 'mcp-host' 'chatllm' 1 3 0 >/dev/null 2>&1; then
  fail 'rollout settle accepted a deployment whose token revision keeps changing'
fi
pass 'rollout settle fails closed while the token revision keeps changing'

printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
if ROLLOUT_SCENARIO='never-ready' np08_wait_rollout_settled 'mcp-host' 'chatllm' 0 3 0 >/dev/null 2>&1; then
  fail 'rollout settle accepted a deployment that never becomes ready'
fi
pass 'rollout settle fails closed while the deployment is not ready'

printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
if ROLLOUT_SCENARIO='error' np08_wait_rollout_settled 'mcp-host' 'chatllm' 0 3 0 >/dev/null 2>&1; then
  fail 'rollout settle accepted a failed deployment read'
fi
pass 'rollout settle fails closed on a deployment read error'

# --- HCC's recorded observation of the Context change (R3-L7) ---
# The fixture Context patch appends two McpServer names. HCC records the change
# as one owned `context-allow` NetworkPolicy per (Context, McpServer) pair in
# the Host namespace, so its presence is the field the gate can read.
printf '0' >"${ROLLOUT_STATE_DIR}/clock"
: >"${ROLLOUT_STATE_DIR}/calls"
if ROLLOUT_SCENARIO='record-absent' \
  np08_hcc_context_recorded 'mcp-host' 'context1' 'server-a'; then
  fail 'an absent HCC record was treated as an observed Context change'
fi
grep -Fq 'get networkpolicy' "${ROLLOUT_STATE_DIR}/calls" ||
  fail 'the HCC observation gate did not read the owned NetworkPolicies (liveness)'
grep -Fq 'clerum.io/managed-by=host-context-controller' "${ROLLOUT_STATE_DIR}/calls" ||
  fail 'the HCC observation gate did not require HCC ownership of the record'
grep -Fq 'clerum.io/policy-type=context-allow' "${ROLLOUT_STATE_DIR}/calls" ||
  fail 'the HCC observation gate did not require the context-allow policy type'
grep -Fq 'clerum.io/context=context1' "${ROLLOUT_STATE_DIR}/calls" ||
  fail 'the HCC observation gate did not scope the record to the Context'
grep -Fq 'clerum.io/mcpserver=server-a' "${ROLLOUT_STATE_DIR}/calls" ||
  fail 'the HCC observation gate did not scope the record to the appended McpServer'
pass 'the HCC observation gate reads the owned, context-scoped NetworkPolicy record'

ROLLOUT_SCENARIO='record-present' \
  np08_hcc_context_recorded 'mcp-host' 'context1' 'server-a' ||
  fail 'a present HCC record was not accepted as an observed Context change'
pass 'the HCC observation gate accepts the owned Context record'

if ROLLOUT_SCENARIO='record-error' \
  np08_hcc_context_recorded 'mcp-host' 'context1' 'server-a'; then
  fail 'a failed NetworkPolicy read was treated as an observed Context change'
fi
pass 'the HCC observation gate fails closed on a read error'

if np08_hcc_context_recorded 'mcp-host' 'context1,other' 'server-a'; then
  fail 'the HCC observation gate accepted an unselectable label value'
fi
pass 'the HCC observation gate refuses an unselectable label value'

# Ported G4-deepseek M4: the pre-patch chatllm deployment is already complete,
# HCC records the Context change on the third read, and its Host reconcile rolls
# the template one read later. The composite gate (record, then settle) must
# certify the post-reaction snapshot; a settle-only gate certifies generation 6
# and the following read already sees generation 7 (the journey exec would start
# in the outgoing pod).
printf '0' >"${ROLLOUT_STATE_DIR}/clock"
printf '0' >"${ROLLOUT_STATE_DIR}/deploy-index"
ROLLOUT_SCENARIO='hcc-reaction' \
  np08_wait_hcc_context_recorded 'mcp-host' 'context1' 'server-a' 30 0 ||
  fail 'the composite gate did not wait for the HCC record of the Context change'
ROLLOUT_SCENARIO='hcc-reaction' \
  np08_wait_rollout_settled 'mcp-host' 'chatllm' 30 3 0 ||
  fail 'the composite gate did not settle after the HCC record'
certified_generation="${NP08_ROLLOUT_CERTIFIED_SNAPSHOT%%$'\t'*}"
post_snapshot="$(ROLLOUT_SCENARIO='hcc-reaction' np08_rollout_snapshot 'mcp-host' 'chatllm')" ||
  fail 'the composite gate could not re-read the deployment after certifying it'
[[ "${post_snapshot%%$'\t'*}" == '7' ]] ||
  fail 'the rollout timeline did not roll after the HCC record (vacuity witness)'
[[ "${certified_generation}" == "${post_snapshot%%$'\t'*}" ]] ||
  fail 'the gate certified a snapshot that changed before the journey exec (R3-L7)'
[[ "${certified_generation}" == '7' ]] ||
  fail 'the gate certified the pre-reaction generation as settled (R3-L7)'
pass 'the composite gate certifies only the post-reaction snapshot (R3-L7)'

if ! grep -Fq 'np08_wait_rollout_settled' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_wait_hcc_context_recorded' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_rollout_snapshot' "${E2E_SCRIPT}" ||
  ! grep -Fq '_lib/np08-rollout.sh' "${E2E_SCRIPT}"; then
  fail 'the deployed E2E is not wired to the HCC observation and rollout settle gates'
fi
patch_line="$(grep -n -m1 'fixture_context_patched=1' "${E2E_SCRIPT}" | cut -d: -f1)"
observe_line="$(grep -n -m1 'np08_wait_hcc_context_recorded' "${E2E_SCRIPT}" | cut -d: -f1)"
settle_line="$(grep -n -m1 'np08_wait_rollout_settled' "${E2E_SCRIPT}" | cut -d: -f1)"
recheck_line="$(grep -n -m1 'np08_rollout_snapshot' "${E2E_SCRIPT}" | cut -d: -f1)"
journey_line="$(grep -n -m1 'NP08_RUNTIME_ACTION=journey' "${E2E_SCRIPT}" | cut -d: -f1)"
if [[ -z "${patch_line}" || -z "${observe_line}" || -z "${settle_line}" ||
  -z "${recheck_line}" || -z "${journey_line}" ||
  "${patch_line}" -ge "${observe_line}" || "${observe_line}" -ge "${settle_line}" ||
  "${settle_line}" -ge "${recheck_line}" || "${recheck_line}" -ge "${journey_line}" ]]; then
  fail 'the journey exec does not wait for the HCC record, the settle and a stable re-read after the fixture patch'
fi
pass 'the journey exec waits for HCC to record the change, the rollout, and a stable re-read'
