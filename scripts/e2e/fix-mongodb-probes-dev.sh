#!/usr/bin/env bash
# Patch the live mongodb StatefulSet in sandbox-recipes to relax liveness/readiness
# probes. WRC auto-generates probes with timeoutSeconds:1 which kills mongosh cold
# starts on memory-constrained pods.
#
# Swaps probes to tcpSocket (cheap, always <10ms) instead of mongosh exec.
set -eo pipefail
umask 077

KCTX="${KUBECONTEXT:-gke_${GCP_PROJECT}_us-central1-a_clerum-dev}"
NS="sandbox-recipes"
STS="mongodb"

log() { echo "[probe-fix] $*" >&2; }

log "=== Current probe config ==="
kubectl --context "$KCTX" -n "$NS" get sts "$STS" \
  -o jsonpath='{.spec.template.spec.containers[0].livenessProbe}' 2>&1; echo
kubectl --context "$KCTX" -n "$NS" get sts "$STS" \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}' 2>&1; echo

log "=== Patching probes to tcpSocket ==="
kubectl --context "$KCTX" -n "$NS" patch sts "$STS" --type=json -p='[
  {"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe","value":{
    "tcpSocket":{"port":27017},
    "initialDelaySeconds":30,
    "periodSeconds":15,
    "timeoutSeconds":5,
    "failureThreshold":3
  }},
  {"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe","value":{
    "tcpSocket":{"port":27017},
    "initialDelaySeconds":10,
    "periodSeconds":5,
    "timeoutSeconds":3,
    "failureThreshold":3
  }}
]'

log "=== Deleting pod to pick up new probes ==="
kubectl --context "$KCTX" -n "$NS" delete pod mongodb-0 --ignore-not-found --grace-period=30 2>&1 || true

log "=== Waiting 90s for Ready ==="
if kubectl --context "$KCTX" -n "$NS" wait --for=condition=Ready pod/mongodb-0 --timeout=120s 2>&1; then
  log "✓ mongodb-0 is Ready"
else
  log "✗ still not Ready — listing pod"
  kubectl --context "$KCTX" -n "$NS" get pod mongodb-0 -o wide 2>&1 || true
fi

log "=== Final pod status ==="
kubectl --context "$KCTX" -n "$NS" get pod mongodb-0 2>&1 || true
kubectl --context "$KCTX" -n "$NS" get sts mongodb 2>&1 || true

log "Done."
