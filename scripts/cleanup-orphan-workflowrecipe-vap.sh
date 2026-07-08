#!/usr/bin/env bash
# Remove orphaned ValidatingAdmissionPolicy `workflowrecipe-mcp-server-namespace`
# and its binding from a target cluster.
#
# Why this exists: The cluster has a pre-Phase-8 VAP that forces WorkflowRecipe
# CRDs into `mcp-server` only. Since Phase 8 (commit de3fab0, rename PR #126),
# the repo's policy (deploy/base/cluster-wide/workflowrecipe-admission.yaml)
# legitimately allows both `mcp-server` and `sandbox-recipes`. The old policy
# is not in the repo and cannot be pruned by kustomize — it must be deleted
# out-of-band. This script does exactly that and is idempotent.
#
# Usage:
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_clerum-dev \
#     ./scripts/cleanup-orphan-workflowrecipe-vap.sh
#
#   # dry-run (no deletion, only shows what would happen):
#   DRY_RUN=true CONTEXT=... ./scripts/cleanup-orphan-workflowrecipe-vap.sh

set -euo pipefail
umask 077

: "${CONTEXT:?must set CONTEXT to target kubectl context}"
DRY_RUN="${DRY_RUN:-false}"

# Prod safety gate: any context NOT ending in `-dev` is treated as prod-like
# and requires explicit CONFIRM=yes per the project convention
# (`CLAUDE.md` §GCP Deployment — "Every prod mutation requires CONFIRM=yes").
# Match `-dev` at the END of the context string so e.g.
# `gke_${GCP_PROJECT}_us-central1-a_clerum-dev` is dev, but
# `gke_${GCP_PROJECT}_us-central1-a_clerum` (prod) trips the gate.
if [[ "${CONTEXT}" != *-dev ]] && [[ "${DRY_RUN}" != "true" ]]; then
  if [[ "${CONFIRM:-}" != "yes" ]]; then
    echo "[cleanup-vap] ERROR: non-dev context '${CONTEXT}' requires CONFIRM=yes" >&2
    echo "[cleanup-vap] re-run with: CONFIRM=yes CONTEXT='${CONTEXT}' $0" >&2
    exit 1
  fi
fi

POLICY="workflowrecipe-mcp-server-namespace"
BINDING="workflowrecipe-mcp-server-namespace"

echo "[cleanup-vap] target context: ${CONTEXT}"
echo "[cleanup-vap] dry_run: ${DRY_RUN}"

# 0. Verify the repo's current policy still allows both namespaces — fail fast
#    if someone has changed the intended allowlist without updating this script.
CURRENT_POLICY_FILE="deploy/base/cluster-wide/workflowrecipe-admission.yaml"
if [[ ! -f "${CURRENT_POLICY_FILE}" ]]; then
  echo "[cleanup-vap] ERROR: expected ${CURRENT_POLICY_FILE} not found" >&2
  exit 1
fi
if ! grep -q "mcp-server" "${CURRENT_POLICY_FILE}" \
   || ! grep -q "sandbox-recipes" "${CURRENT_POLICY_FILE}"; then
  echo "[cleanup-vap] ERROR: ${CURRENT_POLICY_FILE} no longer allows both namespaces" >&2
  echo "[cleanup-vap] refusing to delete the old restrictive policy — review repo first" >&2
  exit 1
fi
echo "[cleanup-vap] repo policy sanity check: ok (allows both mcp-server and sandbox-recipes)"

# 1. Binding first, so no admission traffic lands on a policy-without-binding.
echo "[cleanup-vap] deleting binding ${BINDING}..."
if [[ "${DRY_RUN}" == "true" ]]; then
  kubectl --context "${CONTEXT}" get validatingadmissionpolicybinding "${BINDING}" \
    --ignore-not-found -o name
else
  kubectl --context "${CONTEXT}" delete validatingadmissionpolicybinding "${BINDING}" \
    --ignore-not-found=true
fi

# 2. Then the policy.
echo "[cleanup-vap] deleting policy ${POLICY}..."
if [[ "${DRY_RUN}" == "true" ]]; then
  kubectl --context "${CONTEXT}" get validatingadmissionpolicy "${POLICY}" \
    --ignore-not-found -o name
else
  kubectl --context "${CONTEXT}" delete validatingadmissionpolicy "${POLICY}" \
    --ignore-not-found=true
fi

# 3. Verification: the legitimate replacement must still be present.
echo "[cleanup-vap] verifying legitimate policy workflowrecipe-namespace-allowlist survives..."
if ! kubectl --context "${CONTEXT}" get validatingadmissionpolicy \
      workflowrecipe-namespace-allowlist >/dev/null 2>&1; then
  echo "[cleanup-vap] WARNING: replacement policy 'workflowrecipe-namespace-allowlist' is MISSING" >&2
  echo "[cleanup-vap] apply deploy/base/cluster-wide/workflowrecipe-admission.yaml before continuing" >&2
  exit 1
fi

echo "[cleanup-vap] done."
