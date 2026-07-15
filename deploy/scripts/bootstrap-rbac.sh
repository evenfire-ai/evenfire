#!/usr/bin/env bash
set -euo pipefail

# Bootstrap RBAC manifests for a Clerum cluster.
#
# WHY THIS EXISTS
# ===============
# The CI/CD Service Account intentionally does NOT have `container.roles.update`
# (or the equivalent Kubernetes RBAC `patch` verb on `roles`/`rolebindings`).
# This is a security posture decision — CD should never be able to escalate its
# own privileges by patching its own RoleBindings.
#
# As a consequence, `kubectl apply -k deploy/overlays/...` fails the first time
# any Role in the manifests differs from the Role in the cluster, with:
#
#     roles.rbac.authorization.k8s.io "control-api" is forbidden:
#     User "..." cannot patch resource "roles" ... requires one of
#     ["container.roles.update"] permission(s)
#
# This script applies those RBAC manifests using the *operator's* kubeconfig
# (which does have admin permissions). After a one-time run per cluster, the
# Roles in the cluster match the Roles in the repo byte-for-byte, so subsequent
# CD applies see "unchanged" and do not need patch permission.
#
# RE-RUN POLICY
# =============
# Re-run this script whenever a PR changes ANY RBAC manifest under deploy/base/
# (`rbac.yaml`, `clusterroles.yaml`, or `clusterrolebindings.yaml`). The CD
# pipeline will fail on the first deploy after such a PR until you do.
# Running when there are no diffs is a safe no-op.
#
# USAGE
# =====
#   # Against example-dev (GKE)
#   CONTEXT=gke_your-gcp-project_us-central1-a_example-dev \
#     bash deploy/scripts/bootstrap-rbac.sh
#
#   # Against clerum prod (GKE) — requires CONFIRM=yes
#   CONTEXT=gke_your-gcp-project_us-central1-a_clerum \
#     CONFIRM=yes \
#     bash deploy/scripts/bootstrap-rbac.sh
#
#   # Against current kubeconfig context (minikube, etc.)
#   bash deploy/scripts/bootstrap-rbac.sh
#
# ENV VARS
# ========
#   CONTEXT   kubectl context (empty = current-context)
#   CONFIRM   required when CONTEXT matches a known-prod cluster

CONTEXT="${CONTEXT:-}"
CONFIRM="${CONFIRM:-}"

# Prod guardrail: any context containing "clerum" but not "example-dev"/"clerum-test".
is_prod_context() {
  local c="$1"
  if [[ -z "$c" ]]; then return 1; fi
  if [[ "$c" == *"example-dev"* ]] || [[ "$c" == *"clerum-test"* ]] || [[ "$c" == *"minikube"* ]] || [[ "$c" == *"kind"* ]]; then
    return 1
  fi
  if [[ "$c" == *"clerum"* ]]; then
    return 0
  fi
  return 1
}

kctl() {
  if [ -n "$CONTEXT" ]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

log() { printf '[bootstrap-rbac] %s\n' "$*" >&2; }
die() { printf '[bootstrap-rbac] ERROR: %s\n' "$*" >&2; exit 1; }

if is_prod_context "$CONTEXT" && [ "$CONFIRM" != "yes" ]; then
  die "Refusing to bootstrap RBAC in prod context '$CONTEXT' without CONFIRM=yes"
fi

# Discover all RBAC manifests under deploy/base — this keeps the script
# self-maintaining when a new service base or cluster-wide RBAC file is added.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RBAC_FILES=()
while IFS= read -r f; do
  RBAC_FILES+=("$f")
done < <(
  find "$REPO_ROOT/deploy/base" \
    \( -name "rbac.yaml" -o -name "clusterroles.yaml" -o -name "clusterrolebindings.yaml" \) \
    | sort
)

if [ ${#RBAC_FILES[@]} -eq 0 ]; then
  die "No RBAC manifest files found under $REPO_ROOT/deploy/base"
fi

log "Applying ${#RBAC_FILES[@]} RBAC manifest files to context '${CONTEXT:-<current>}'"
for f in "${RBAC_FILES[@]}"; do
  rel="${f#$REPO_ROOT/}"
  log "  - $rel"
  kctl apply -f "$f"
done

log "Done. Subsequent 'kubectl apply -k' runs from CD should see RBAC 'unchanged'."
