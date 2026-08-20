#!/usr/bin/env bash
# If gfsc-reader is already Ready, settle every leftover that would make the
# next reconcile rollout restart it and race HCC's gfsReconciler:
# - scale to 0 any leftover non-current ReplicaSet that contributes no Ready
#   pod (a stale-template RS whose live unready pod keeps
#   credential_rollout_pending true forever);
# - delete CrashLoopBackOff reader pods so kubelet's up-to-5m backoff resets
#   and the pod re-reads the restored Secret immediately;
# - clear a leftover rollout-running claim on the reader Secret.
# HCC's gfsReconciler owns the reader template and strips the restartedAt
# annotation, so `kubectl rollout status` after a restart loops on
# "Waiting for deployment spec update to be observed" until the wait
# times out; not restarting a Ready reader is the only safe path.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
GFS_NS="${GFS_NS:-gfs}"
DEPLOY="${GFS_READER_DEPLOYMENT:-gfsc-reader}"
SECRET="${GFS_READER_DB_SECRET:-gfs-controller-reader-db}"
SELECTOR="${GFS_READER_SELECTOR:-app=gfs-controller,clerum.io/gfsc-role=reader}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[settle-gfs-reader-rollout] %s\n' "$*" >&2; }

if ! kc -n "$GFS_NS" get deployment "$DEPLOY" >/dev/null 2>&1; then
  exit 0
fi

desired="$(kc -n "$GFS_NS" get deployment "$DEPLOY" -o jsonpath='{.spec.replicas}')"
ready="$(kc -n "$GFS_NS" get deployment "$DEPLOY" -o jsonpath='{.status.readyReplicas}')"
if [ -z "$desired" ] || [ "$desired" = "0" ] || [ "${ready:-0}" != "$desired" ]; then
  exit 0
fi

# Desired Ready is met from here on: leftovers below serve nothing.
current_rev="$(kc -n "$GFS_NS" get deployment "$DEPLOY" \
  -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
rs_rows="$(kc -n "$GFS_NS" get rs -l "$SELECTOR" -o \
  'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.ownerReferences[0].name}{"|"}{.spec.replicas}{"|"}{.status.readyReplicas}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"\n"}{end}' \
  2>/dev/null || true)"
while IFS='|' read -r rs_name rs_owner rs_replicas rs_ready rs_rev; do
  [ -n "$rs_name" ] || continue
  [ "$rs_owner" = "$DEPLOY" ] || continue
  [ "${rs_replicas:-0}" -gt 0 ] || continue
  [ "${rs_ready:-0}" -eq 0 ] || continue
  # Never fight the deployment controller over its current-revision RS.
  [ -n "$current_rev" ] && [ "$rs_rev" = "$current_rev" ] && continue
  log "scaling leftover unready ReplicaSet ${rs_name} to 0 (revision ${rs_rev:-unknown}, current ${current_rev:-unknown})"
  kc -n "$GFS_NS" scale rs "$rs_name" --replicas=0 >/dev/null
done <<<"$rs_rows"

pod_rows="$(kc -n "$GFS_NS" get pods -l "$SELECTOR" -o \
  'jsonpath={range .items[*]}{.metadata.name}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.status.containerStatuses[0].state.waiting.reason}{"\n"}{end}' \
  2>/dev/null || true)"
while IFS='|' read -r pod_name pod_ready pod_deleting pod_reason; do
  [ -n "$pod_name" ] || continue
  [ -z "$pod_deleting" ] || continue
  [ "$pod_ready" != True ] || continue
  [ "$pod_reason" = CrashLoopBackOff ] || continue
  log "deleting CrashLoopBackOff pod ${pod_name} so it re-reads the Secret without waiting out kubelet backoff"
  kc -n "$GFS_NS" delete pod "$pod_name" --wait=false >/dev/null
done <<<"$pod_rows"

if ! kc -n "$GFS_NS" get secret "$SECRET" >/dev/null 2>&1; then
  exit 0
fi

state="$(kc -n "$GFS_NS" get secret "$SECRET" \
  -o jsonpath='{.metadata.annotations.clerum\.io/gfs-dsn-state}')"
[ "$state" = rollout-running ] || exit 0

rotated="$(kc -n "$GFS_NS" get secret "$SECRET" \
  -o jsonpath='{.metadata.annotations.clerum\.io/gfs-dsn-rotated-at}')"
if [ -z "$rotated" ]; then
  log "reader Secret is rollout-running without rotated-at; leaving it for reconcile"
  exit 0
fi

log "gfsc-reader is Ready with an interrupted rollout claim; marking the reader Secret ready without restart"
python3 -c 'import json, sys
state, stamp = sys.argv[1:]
print(json.dumps([
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": state},
  {"op": "test", "path": "/metadata/annotations/clerum.io~1gfs-dsn-rotated-at", "value": stamp},
  {"op": "replace", "path": "/metadata/annotations/clerum.io~1gfs-dsn-state", "value": "ready"},
]))' "$state" "$rotated" \
  | kc -n "$GFS_NS" patch secret "$SECRET" --type=json --patch-file=/dev/stdin >/dev/null
