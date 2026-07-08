#!/usr/bin/env bash
set -u

FAIL=0
SCRIPT="scripts/minikube/pre-gate-sync.sh"
REGISTRY_SCRIPT="scripts/minikube/deploy-evenfire-registry.sh"

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

contains() {
  grep -Fq -- "$1" "$SCRIPT"
}

not_contains() {
  ! grep -Fq -- "$1" "$SCRIPT"
}

if bash -n "$SCRIPT"; then
  pass "pre-gate sync script has valid bash syntax"
else
  fail "pre-gate sync script has invalid bash syntax"
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
   not_contains '--from-literal=worktreePath='; then
  pass "pre-gate sync records a non-sensitive cluster marker"
else
  fail "pre-gate sync cluster marker is missing or stores local paths"
fi

if contains 'elif ! cluster_marker_matches "${cluster_fingerprint}" "${WORKTREE_ID}"; then' &&
   contains 'persist_cluster_marker "${cluster_fingerprint}" "${infra_fingerprint}"'; then
  pass "pre-gate sync detects cluster drift from another worktree"
else
  fail "pre-gate sync does not detect cluster drift from another worktree"
fi

if contains 'scripts/minikube/sync-auth-key.sh' &&
   contains '--context "${PROFILE}"'; then
  pass "pre-gate sync uses the shared idempotent auth-key sync helper"
else
  fail "pre-gate sync does not use the shared idempotent auth-key sync helper"
fi

if contains 'fingerprint_dir packages/workflow-runtime-core' &&
   contains 'run_if_changed packages/workflow-runtime-core "npm test && npm run build"' &&
   contains 'ensure_artifact packages/workflow-runtime-core dist/index.js "npm run build"'; then
  pass "pre-gate sync builds workflow-runtime-core before dependent package tests"
else
  fail "pre-gate sync does not build workflow-runtime-core before dependent package tests"
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

exit "$FAIL"
