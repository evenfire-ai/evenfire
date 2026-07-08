#!/usr/bin/env bash
# Diagnose mongodb-0 CrashLoopBackOff on clerum-dev sandbox-recipes namespace.
# If FIX_PVC=1, deletes the PVC + pod so K8s recreates both with fresh fsGroup
# ownership (works around stale root-owned files from pre-security-patch attempts).
set -eo pipefail
umask 077

KCTX="${KUBECONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum-dev}"
NS="sandbox-recipes"
POD="mongodb-0"
PVC="mongodb-data-mongodb-0"

log() { echo "[mongo-diag] $*" >&2; }

log "=== Pod status ==="
kubectl --context "$KCTX" -n "$NS" get pod "$POD" -o wide 2>&1 || true

log "=== Current logs (full, no filter) ==="
kubectl --context "$KCTX" -n "$NS" logs "$POD" --tail=80 2>&1 || true

log "=== Previous logs (last crashed container) ==="
kubectl --context "$KCTX" -n "$NS" logs "$POD" --previous --tail=80 2>&1 || true

log "=== Events (last 20) ==="
kubectl --context "$KCTX" -n "$NS" get events --sort-by='.lastTimestamp' \
  --field-selector=involvedObject.name="$POD" 2>&1 | tail -20 || true

if [[ "${FIX_PVC:-0}" == "1" ]]; then
  log "=== FIX_PVC=1 — deleting PVC + pod for fresh fsGroup chown ==="
  kubectl --context "$KCTX" -n "$NS" delete pod "$POD" --ignore-not-found --grace-period=0 --force 2>&1 || true
  kubectl --context "$KCTX" -n "$NS" delete pvc "$PVC" --ignore-not-found --timeout=30s 2>&1 || true
  log "Waiting 15s for StatefulSet to recreate pod + PVC..."
  sleep 15
  kubectl --context "$KCTX" -n "$NS" get pvc,pod -l app=mongodb 2>&1 || true
  log "Waiting up to 120s for pod Ready..."
  kubectl --context "$KCTX" -n "$NS" wait --for=condition=Ready pod/"$POD" --timeout=120s 2>&1 || true
  log "=== Post-fix pod status ==="
  kubectl --context "$KCTX" -n "$NS" get pod "$POD" -o wide 2>&1 || true
  log "=== Post-fix logs ==="
  kubectl --context "$KCTX" -n "$NS" logs "$POD" --tail=40 2>&1 || true
fi

log "Done."
