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

check_embedded_node() {
  local ordinal="$1"
  if ! awk -v ordinal="${ordinal}" '
    /node - <<'\''NODE'\''$/ {
      block += 1
      in_block = block == ordinal
      next
    }
    in_block && /^NODE$/ {
      in_block = 0
      exit
    }
    in_block { print }
  ' "${E2E_SCRIPT}" | node --check >/dev/null 2>&1; then
    fail "embedded Node heredoc ${ordinal} is not valid CommonJS"
  fi
}

if grep -Eq '^[[:space:]]+NODE$' "${E2E_SCRIPT}"; then
  fail 'an embedded Node heredoc terminator is indented'
fi
check_embedded_node 1
check_embedded_node 2
pass 'embedded Node heredocs have column-zero terminators and valid CommonJS syntax'

if ! grep -Fq 'np08_cleanup_check_residual' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_cleanup_final_status' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_read_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Fq 'pre_gate_marker_cluster_fingerprint' "${E2E_SCRIPT}" ||
  ! grep -Fq 'image_mode_images_generated_at' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_verify_sync_marker' "${E2E_SCRIPT}" ||
  ! grep -Eq '^for command_name in .* node npm;' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_gateway_raw_header_checks' "${E2E_SCRIPT}" ||
  ! grep -Fq 'net.connect' "${E2E_SCRIPT}" ||
  ! grep -Fq 'duplicate system header was not rejected' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_deployed_manager_journey' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_product_manager_status' "${E2E_SCRIPT}" ||
  ! grep -Fq "require('/app/mcp-host/dist/mcp/managerFactory.js')" "${E2E_SCRIPT}" ||
  ! grep -Fq 'mcpServers' "${E2E_SCRIPT}" ||
  ! grep -Fq "state !== 'connected'" "${E2E_SCRIPT}" ||
  ! grep -Fq 'HOST_B=' "${E2E_SCRIPT}" ||
  ! grep -Fq 'kind: Host' "${E2E_SCRIPT}" ||
  ! grep -Fq 'deployment/${HOST_B}' "${E2E_SCRIPT}" ||
  ! grep -Fq "proxy_mode='positive'" "${E2E_SCRIPT}" ||
  ! grep -Fq "proxy_mode='cross'" "${E2E_SCRIPT}" ||
  ! grep -Fq '__np08/stats' "${E2E_SCRIPT}" ||
  ! grep -Fq 'connections' "${E2E_SCRIPT}" ||
  ! grep -Fq 'requests' "${E2E_SCRIPT}" ||
  ! grep -Fq 'bytes' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_assert_stats_unchanged' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_live_authority_phase' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_flag_off_phase' "${E2E_SCRIPT}" ||
  ! grep -Fq 'positive-rotate)' "${E2E_SCRIPT}" ||
  ! grep -Fq 'forwarding-off)' "${E2E_SCRIPT}" ||
  ! grep -Fq 'NP08_PROXY_FORCE_REFRESH' "${E2E_SCRIPT}" ||
  ! grep -Fq 'np08_projected_identity_digest' "${E2E_SCRIPT}" ||
  ! grep -Fq 'run_np08_sdk_protocol_journey' "${E2E_SCRIPT}" ||
  ! grep -Fq 'src/mcp/__tests__/np08ProxyJourney.test.ts' "${E2E_SCRIPT}" ||
  ! grep -Fq "const scheme = ['Be', 'arer'].join('')" "${E2E_SCRIPT}" ||
  grep -Fq "const scheme = ['Be', 'arer'].join(' ')" "${E2E_SCRIPT}" ||
  ! grep -Fq "scheme !== ['B', 'earer'].join('')" "${E2E_SCRIPT}"; then
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
