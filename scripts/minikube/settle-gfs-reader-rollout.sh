#!/usr/bin/env bash
# If gfsc-reader is already Ready, clear a leftover rollout-running claim
# on the reader Secret so the next reconcile does not rollout restart.
# HCC's gfsReconciler patches gfsc-reader; a second restart races
# `kubectl rollout status` ("Waiting for deployment spec update to be
# observed") until the wait times out.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
GFS_NS="${GFS_NS:-gfs}"
DEPLOY="${GFS_READER_DEPLOYMENT:-gfsc-reader}"
SECRET="${GFS_READER_DB_SECRET:-gfs-controller-reader-db}"

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
