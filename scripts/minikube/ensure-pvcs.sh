#!/usr/bin/env bash
# ======================================================================
# ensure-pvcs.sh — Idempotent PVC size reconciliation
# ======================================================================
#
# Checks each known PVC against the desired size in manifests.
# If a PVC exists with the wrong size (Kubernetes forbids shrinking),
# this script:
#   1. Scales the owning Deployment to 0 replicas
#   2. Waits for pod termination (so PVC is released)
#   3. Deletes the PVC (now unbound)
#   4. Exits cleanly — the subsequent `kubectl apply` recreates it
#
# Called automatically by:
#   - make minikube-deploy-mcp      (mcp-host-workspace)
#   - make minikube-deploy-profiles (control-postgres-data)
#   - make minikube-deploy-all      (both, via the above)
#
# Usage:
#   ./scripts/minikube/ensure-pvcs.sh
# ======================================================================

set -euo pipefail

PROFILE="${MINIKUBE_PROFILE:-clerum-test}"
KC="kubectl --context=${PROFILE}"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${CYAN}[ENSURE-PVCS]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} — $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} — $*"; }

# ensure_pvc <pvc-name> <namespace> <wanted-size> <owner-deployment> <owner-namespace>
ensure_pvc() {
  local name="$1" ns="$2" want_size="$3" owner_deploy="$4" owner_ns="$5"

  local cur_size
  cur_size=$($KC get pvc "$name" -n "$ns" \
    -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || echo "")

  if [ -z "$cur_size" ]; then
    ok "PVC ${ns}/${name} — not found, will be created by apply"
    return 0
  fi

  if [ "$cur_size" = "$want_size" ]; then
    ok "PVC ${ns}/${name} — ${cur_size} (no change needed)"
    return 0
  fi

  warn "PVC ${ns}/${name} — size conflict: cluster=${cur_size}, manifest=${want_size}"
  log  "  Scaling down ${owner_ns}/${owner_deploy} to 0 replicas..."
  $KC scale deployment "$owner_deploy" -n "$owner_ns" --replicas=0 2>/dev/null || true

  log "  Waiting for pods to terminate (max 45s)..."
  $KC wait pods -l "app=${owner_deploy}" -n "$owner_ns" \
    --for=delete --timeout=45s 2>/dev/null || true

  log "  Deleting PVC ${ns}/${name}..."
  $KC delete pvc "$name" -n "$ns" --timeout=30s 2>/dev/null || true
  ok "PVC ${ns}/${name} removed — will be recreated at ${want_size} by apply"
}

# ── Known PVCs ────────────────────────────────────────────────────────
# Size values must match the PVC specs in deploy/minikube/services/*/
ensure_pvc "mcp-host-workspace"    "mcp-host"      "1Gi" "mcp-host"         "mcp-host"
ensure_pvc "control-postgres-data" "control-plane" "1Gi" "control-postgres"  "control-plane"
