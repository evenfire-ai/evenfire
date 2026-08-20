#!/usr/bin/env bash
set -u

FAIL=0
SCRIPT="scripts/minikube/pre-gate-sync.sh"
MARKER_SCRIPT="scripts/minikube/pre-gate-marker.sh"
RUNTIME_SCRIPT="scripts/minikube/pre-gate-runtime.sh"
INCREMENTAL_SCRIPT="scripts/minikube/pre-gate-incremental.sh"
REGISTRY_SCRIPT="scripts/minikube/deploy-evenfire-registry.sh"

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

contains() {
  grep -Fq -- "$1" "$SCRIPT"
}

runtime_contains() {
  grep -Fq -- "$1" "$RUNTIME_SCRIPT"
}

incremental_contains() {
  grep -Fq -- "$1" "$INCREMENTAL_SCRIPT"
}

marker_contains() {
  grep -Fq -- "$1" "$MARKER_SCRIPT"
}

not_contains() {
  ! grep -Fq -- "$1" "$SCRIPT"
}

if bash -n "$SCRIPT"; then
  pass "pre-gate sync script has valid bash syntax"
else
  fail "pre-gate sync script has invalid bash syntax"
fi

if bash -n "$MARKER_SCRIPT"; then
  pass "shared pre-gate marker helper has valid bash syntax"
else
  fail "shared pre-gate marker helper has invalid bash syntax"
fi

if bash -n "$INCREMENTAL_SCRIPT"; then
  pass "incremental pre-gate helper has valid bash syntax"
else
  fail "incremental pre-gate helper has invalid bash syntax"
fi

if bash -n "scripts/minikube/sync-auth-key.sh"; then
  pass "auth-key sync helper has valid bash syntax"
else
  fail "auth-key sync helper has invalid bash syntax"
fi

if bash -n "$REGISTRY_SCRIPT"; then
  pass "evenfire registry deploy helper has valid bash syntax"
else
  fail "evenfire registry deploy helper has invalid bash syntax"
fi

if contains 'WORKTREE_ID="$(printf '\''%s'\'' "${PROJECT_DIR}" | shasum | awk '\''{print $1}'\'')"' &&
   contains 'STATE_DIR="${STATE_ROOT}/${WORKTREE_ID}"' &&
   not_contains 'STATE_DIR="${TMPDIR:-/tmp}/clerum-pre-gate-sync"'; then
  pass "pre-gate sync state is scoped per worktree"
else
  fail "pre-gate sync state can be shared across worktrees"
fi

if contains 'cluster_marker_matches()' &&
   contains 'persist_cluster_marker()' &&
   contains '--from-literal=clusterFingerprint=' &&
   contains '--from-literal=worktreeId=' &&
   contains "-o jsonpath='{.data.gitHead}'" &&
   contains 'actual_git_head' &&
   not_contains '--from-literal=worktreePath='; then
  pass "pre-gate sync records and verifies a non-sensitive cluster marker"
else
  fail "pre-gate sync cluster marker is incomplete or stores local paths"
fi

if contains 'elif ! cluster_marker_matches "${cluster_fingerprint}" "${WORKTREE_ID}"; then' &&
   contains 'persist_cluster_marker "${cluster_fingerprint}" "${infra_fingerprint}"'; then
  pass "pre-gate sync detects cluster drift from another worktree"
else
  fail "pre-gate sync does not detect cluster drift from another worktree"
fi

if incremental_contains 'git -C "${PROJECT_DIR}" diff --name-only "${marker_git_head}" HEAD' &&
   incremental_contains 'git -C "${PROJECT_DIR}" diff --name-only HEAD' &&
   incremental_contains 'git -C "${PROJECT_DIR}" ls-files --others --exclude-standard'; then
  pass "incremental sync compares deployed, working-tree, and untracked paths"
else
  fail "incremental sync cannot derive a safe delta from the deployed marker"
fi

if incremental_contains 'control-api/*) incremental_add_target control-api control-plane control-api' &&
   incremental_contains 'rpc-proxy/*) incremental_add_target rpc-proxy rpc-proxy rpc-proxy' &&
   incremental_contains 'host-context-controller/*) incremental_add_target host-context-controller control-plane host-context-controller' &&
   incremental_contains 'control-ui/*) incremental_add_target control-ui control-plane control-ui' &&
   incremental_contains 'tests/e2e/fixtures/workflow-plugin-sdk-e2e/*)' &&
   incremental_contains 'incremental_add_target workflow-plugin-sdk-e2e sandbox-recipes workflow-plugin-sdk-e2e'; then
  pass "incremental sync maps known runtime paths to their own images and deployments"
else
  fail "incremental sync does not map known runtime paths precisely"
fi

if contains 'incremental_plan' &&
   contains 'incremental_build_images' &&
   contains 'incremental_restart_targets' &&
   not_contains 'make minikube-build-images' &&
   incremental_contains 'bash "${PROJECT_DIR}/scripts/minikube/build-images.sh" "--only=${selector}"' &&
   incremental_contains 'make minikube-build-images'; then
  pass "pre-gate sync builds targeted images and retains a fail-closed full-build fallback"
else
  fail "pre-gate sync still performs an unconditional all-image build"
fi

if contains 'scripts/minikube/sync-auth-key.sh' &&
   contains '--context "${PROFILE}"'; then
  pass "pre-gate sync uses the shared idempotent auth-key sync helper"
else
  fail "pre-gate sync does not use the shared idempotent auth-key sync helper"
fi

if contains 'Both nginx gateway configs are mounted through subPath' &&
   contains 'INCREMENTAL_FULL_DEPLOYMENT' &&
   contains 'rollout_restart_with_retry control-plane nginx-workflow-approval-gateway' &&
   contains 'rollout_if_present control-plane nginx-workflow-approval-gateway' &&
   contains 'assert_workflow_gateway_prompt_bridge_finalization_route'; then
  pass "pre-gate sync refreshes the subPath-mounted workflow gateway after deployment changes"
else
  fail "pre-gate sync can leave a stale workflow gateway after ConfigMap changes"
fi

hcc_gateway_restart_line="$(grep -nF 'rollout_restart_with_retry control-plane host-context-controller-api-gateway' "$SCRIPT" | head -n 1 | cut -d: -f1)"
hcc_gateway_wait_line="$(grep -nF 'rollout_if_present control-plane host-context-controller-api-gateway' "$SCRIPT" | head -n 1 | cut -d: -f1)"
hcc_gateway_assert_line="$(grep -nF 'assert_hcc_gateway_np08_routes' "$SCRIPT" | head -n 1 | cut -d: -f1)"
if [[ -n "$hcc_gateway_restart_line" &&
      -n "$hcc_gateway_wait_line" &&
      -n "$hcc_gateway_assert_line" &&
      "$hcc_gateway_restart_line" -lt "$hcc_gateway_wait_line" &&
      "$hcc_gateway_wait_line" -lt "$hcc_gateway_assert_line" ]]; then
  pass "pre-gate restarts and waits for the subPath-mounted HCC gateway before NP-08 inspection"
else
  fail "pre-gate can inspect a stale HCC gateway after its ConfigMap changes"
fi

if runtime_contains 'assert_hcc_gateway_np08_routes()' &&
   runtime_contains 'location = /api/v2/hosts/self/mcpservers {' &&
   runtime_contains 'location = /api/v2/hosts/self/mcpservers/credential {' &&
   runtime_contains 'location ~ ^/api/v1/mcpservers/context/[^/]+$ {' &&
   runtime_contains 'location ~ ^/api/v1/mcpservers/[^/]+/auth$ {' &&
   runtime_contains 'proxy_set_header Authorization $http_authorization;' &&
   runtime_contains 'add_header Pragma "no-cache" always;' &&
   runtime_contains 'access_log /dev/stdout hcc_gateway_json;' &&
   runtime_contains 'return 410'; then
  pass "pre-gate fails closed when the running HCC gateway lacks the NP-08 route contract"
else
  fail "pre-gate does not verify the running NP-08 HCC gateway contract"
fi

nginx_inspection_pipeline_lines="$(grep -F 'nginx -T' "$RUNTIME_SCRIPT" | grep -vE '^[[:space:]]*#' | grep -E '\\|[[:space:]]*(grep|rg|sed|awk|head|tail|cut|sort|tr|wc)([[:space:]]|$)' || true)"
if runtime_contains 'assert_workflow_gateway_prompt_bridge_finalization_route()' &&
   runtime_contains 'nginx_config="$(${KC} exec' &&
   runtime_contains 'could not inspect the active nginx configuration' &&
   runtime_contains '[[ "${nginx_config}" != *"${expected_route}"* ]]' &&
   [[ -z "$nginx_inspection_pipeline_lines" ]]; then
  pass "pre-gate runtime guard separates nginx inspection from route validation"
else
  fail "pre-gate runtime guard can confuse SIGPIPE or exec failure with a missing route"
fi

if marker_contains 'packages/workflow-runtime-core' &&
   contains 'run_if_changed packages/workflow-runtime-core "npm test && npm run build"' &&
   contains 'ensure_artifact packages/workflow-runtime-core dist/index.js "npm run build"'; then
  pass "pre-gate sync builds workflow-runtime-core before dependent package tests"
else
  fail "pre-gate sync does not build workflow-runtime-core before dependent package tests"
fi

final_cluster_fingerprint_line="$(grep -n 'cluster_fingerprint=.*pre_gate_marker_cluster_fingerprint' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
final_infra_fingerprint_line="$(grep -n 'infra_fingerprint=.*pre_gate_marker_infra_fingerprint' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
persist_marker_line="$(grep -nF 'commit_cluster_sync_state "${cluster_fingerprint}" "${infra_fingerprint}"' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
if [ -n "$final_cluster_fingerprint_line" ] &&
   [ -n "$final_infra_fingerprint_line" ] &&
   [ -n "$persist_marker_line" ] &&
   [ "$final_cluster_fingerprint_line" -lt "$persist_marker_line" ] &&
   [ "$final_infra_fingerprint_line" -lt "$persist_marker_line" ]; then
  pass "pre-gate recomputes both fingerprints after generated deploy inputs before stamping the marker"
else
  fail "pre-gate can stamp a marker from fingerprints computed before generated deploy inputs"
fi

marker_failure_dir="$(mktemp -d)"
mkdir -p "${marker_failure_dir}/bin" "${marker_failure_dir}/repo/control-api"
printf '#!/usr/bin/env bash\nexit 42\n' >"${marker_failure_dir}/bin/find"
chmod +x "${marker_failure_dir}/bin/find"
if (
  # shellcheck source=/dev/null
  source "$MARKER_SCRIPT"
  PATH="${marker_failure_dir}/bin:${PATH}"
  export PATH
  pre_gate_marker_fingerprint_dir "${marker_failure_dir}/repo" control-api >/dev/null
) || (
  # shellcheck source=/dev/null
  source "$MARKER_SCRIPT"
  PATH="${marker_failure_dir}/bin:${PATH}"
  export PATH
  pre_gate_marker_cluster_fingerprint "${marker_failure_dir}/repo" >/dev/null
); then
  fail "shared pre-gate marker helper can turn a hashing failure into a valid fingerprint"
else
  pass "shared pre-gate marker helper propagates hashing failures instead of stamping empty input"
fi
rm -rf "${marker_failure_dir}"

control_api_migration_line="$(grep -nF 'run-control-api-db-migration.sh' "$SCRIPT" | head -n 1 | cut -d: -f1)"
runtime_roles_line="$(grep -nF 'provision-control-api-runtime-roles.sh' "$SCRIPT" | head -n 1 | cut -d: -f1)"
control_api_probe_restore_line="$(grep -nF '    restore_control_api' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
gfs_provision_line="$(grep -nF '    provision_gfs_serving' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
if [[ -n "$control_api_migration_line" &&
      -n "$runtime_roles_line" &&
      -n "$control_api_probe_restore_line" &&
      -n "$gfs_provision_line" &&
      "$control_api_migration_line" -lt "$runtime_roles_line" &&
      "$runtime_roles_line" -lt "$control_api_probe_restore_line" &&
      "$control_api_probe_restore_line" -lt "$gfs_provision_line" ]]; then
  pass "pre-gate restores the control-api probe only after migration/roles and before gfs provisioning"
else
  fail "pre-gate sync can run the GFS authentication probe while control-api is fenced"
fi

cluster_sync_line="$(grep -nF 'if [[ "${cluster_changed}" == "true" ]]; then' "$SCRIPT" | head -n 1 | cut -d: -f1)"
pre_migration_reconcile_line="$(awk -v start="$cluster_sync_line" -v end="$control_api_migration_line" \
  'NR >= start && NR < end && /reconcile-gfs-deploy-credentials\.sh/ { print NR; exit }' "$SCRIPT")"
if [[ -z "$pre_migration_reconcile_line" && -n "$gfs_provision_line" && \
      -n "$control_api_migration_line" && "$control_api_migration_line" -lt "$gfs_provision_line" ]]; then
  pass "pre-gate defers GFS credential reconciliation until after schema migration"
else
  fail "pre-gate can reconcile GFS roles before the migration that grants their projection"
fi

if contains 'fence_control_api()' &&
   contains 'restore_control_api()' &&
   contains 'fence_workflow_reconciler' &&
   contains 'fence_control_api' &&
   contains 'trap finalize_pre_gate_sync EXIT' &&
   contains 'restore_pre_gate_writers || return 1' &&
   contains 'commit_cluster_sync_state "${cluster_fingerprint}" "${infra_fingerprint}"' &&
   grep -Fq 'type: Recreate' deploy/base/control-plane/control-api.yaml; then
  pass "pre-gate and Deployment enforce a no-overlap Control API writer window"
else
  fail "Control API writer overlap is not fail-closed during migration/rollout"
fi

if grep -Fq 'MINIKUBE_MULTI_NODE=true' "$REGISTRY_SCRIPT" &&
   grep -Fq 'minikube --profile="${PROFILE}" image load localhost:5000/registry-api:test' "$REGISTRY_SCRIPT" &&
   grep -Fq 'eval "$(minikube --profile="${PROFILE}" docker-env)"' "$REGISTRY_SCRIPT"; then
  pass "evenfire registry deploy helper supports multi-node image loading"
else
  fail "evenfire registry deploy helper still assumes docker-env for every profile"
fi

if grep -Fq 'patch_minikube_registry_volume_permissions()' "$REGISTRY_SCRIPT" &&
   grep -Fq 'registry-postgres-volume-permissions' "$REGISTRY_SCRIPT" &&
   grep -Fq 'registry-minio-volume-permissions' "$REGISTRY_SCRIPT" &&
   grep -Fq 'rollout restart deployment/registry-api' "$REGISTRY_SCRIPT"; then
  pass "evenfire registry deploy helper patches minikube PVC ownership"
else
  fail "evenfire registry deploy helper does not patch minikube PVC ownership"
fi

if runtime_contains 'if ! gate_needs_registry; then' &&
   runtime_contains 'this gate does not require the sibling service' &&
   contains 'if gate_needs_registry; then' &&
   contains 'rollout_if_present registry registry-api'; then
  pass "pre-gate sync keeps the sibling registry scoped to registry-backed gates"
else
  fail "pre-gate sync can couple unrelated gates to the sibling registry"
fi

if contains "deployment/control-postgres -- \\" &&
   contains 'psql -U postgres -d profiles -Atqc "${query}"'; then
  pass "legacy grant inventory keeps the kubectl exec command intact"
else
  fail "legacy grant inventory can execute psql on the host instead of PostgreSQL"
fi

if contains 'fence_workflow_reconciler()' &&
   contains 'restore_workflow_reconciler()' &&
   contains 'trap finalize_pre_gate_sync EXIT' &&
   contains 'restore_pre_gate_writers || return 1' &&
   contains 'fence_workflow_reconciler' &&
   contains 'run-control-api-db-migration.sh' &&
   contains 'make minikube-deploy-all'; then
  fence_line="$(grep -n 'fence_workflow_reconciler$' "$SCRIPT" | tail -1 | cut -d: -f1)"
  migration_line="$(grep -n 'run-control-api-db-migration.sh' "$SCRIPT" | head -1 | cut -d: -f1)"
  overlay_line="$(grep -n 'make minikube-deploy-all' "$SCRIPT" | head -1 | cut -d: -f1)"
  if [[ "$fence_line" -lt "$migration_line" && "$migration_line" -lt "$overlay_line" ]]; then
    pass "pre-gate fences workflow reconciliation before schema-first migration"
  else
    fail "pre-gate rollout order can expose consumers before schema migration"
  fi
else
  fail "pre-gate sync lacks an explicit workflow reconciliation fence"
fi

if contains 'assert_no_legacy_prompt_bridge_grants()' &&
   contains 'rollout_if_present control-plane control-postgres' &&
   contains '${KC} exec -n control-plane deployment/control-postgres'; then
  pass "legacy grant inventory waits for the Ready control-postgres deployment before exec"
else
  fail "legacy grant inventory can race a restarting or completed control-postgres pod"
fi

exit "$FAIL"
