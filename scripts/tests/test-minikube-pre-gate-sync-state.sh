#!/usr/bin/env bash
set -u

FAIL=0
SCRIPT="scripts/minikube/pre-gate-sync.sh"
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

not_contains() {
  ! grep -Fq -- "$1" "$SCRIPT"
}

if bash -n "$SCRIPT"; then
  pass "pre-gate sync script has valid bash syntax"
else
  fail "pre-gate sync script has invalid bash syntax"
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

if contains 'nginx.conf is mounted through a subPath' &&
   contains 'INCREMENTAL_FULL_DEPLOYMENT' &&
   contains 'rollout_restart_with_retry control-plane nginx-workflow-approval-gateway' &&
   contains 'rollout_if_present control-plane nginx-workflow-approval-gateway'; then
  pass "pre-gate sync refreshes the subPath-mounted workflow gateway after deployment changes"
else
  fail "pre-gate sync can leave a stale workflow gateway after ConfigMap changes"
fi

if contains 'fingerprint_dir packages/workflow-runtime-core' &&
   contains 'run_if_changed packages/workflow-runtime-core "npm test && npm run build"' &&
   contains 'ensure_artifact packages/workflow-runtime-core dist/index.js "npm run build"'; then
  pass "pre-gate sync builds workflow-runtime-core before dependent package tests"
else
  fail "pre-gate sync does not build workflow-runtime-core before dependent package tests"
fi

control_api_rollout_line="$(grep -nF 'rollout_if_present control-plane control-api' "$SCRIPT" | head -n 1 | cut -d: -f1)"
gfs_provision_line="$(grep -nF 'provision_gfs_serving' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
if [[ -n "$control_api_rollout_line" &&
      -n "$gfs_provision_line" &&
      "$control_api_rollout_line" -lt "$gfs_provision_line" ]]; then
  pass "pre-gate sync waits for control-api migrations before gfs provisioning"
else
  fail "pre-gate sync can provision gfs before control-api migrations"
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

exit "$FAIL"
