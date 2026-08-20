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

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
set +u
T2_PROJECT_DIR="$T2_PROJECT_DIR"
T2_PROFILE="$T2_PROFILE"
T2_CONTEXT="$T2_CONTEXT"
MINIKUBE_PROFILE="$MINIKUBE_PROFILE"
CONTROL_API_REAL_PG_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"
CONTEXT="$CONTEXT"
set -u
if [ -z "$T2_PROJECT_DIR" ]; then T2_PROJECT_DIR="$ROOT"; fi
if [ -z "$T2_PROFILE" ]; then T2_PROFILE="$MINIKUBE_PROFILE"; fi
if [ -z "$T2_PROFILE" ]; then T2_PROFILE="$CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$CONTROL_API_REAL_PG_CONTEXT"; fi
if [ -z "$T2_CONTEXT" ]; then T2_CONTEXT="$CONTEXT"; fi
# shellcheck source=scripts/minikube/t2-common.sh
source "$ROOT/scripts/minikube/t2-common.sh"
if [ -z "$T2_SKIP_LOCK" ]; then T2_SKIP_LOCK=false; fi
T2_CONTEXT="$T2_CONTEXT"
CONTEXT="$T2_CONTEXT"
GFS_NS="${GFS_NS:-gfs}"
DEPLOY="${GFS_READER_DEPLOYMENT:-gfsc-reader}"
SECRET="${GFS_READER_DB_SECRET:-gfs-controller-reader-db}"
SELECTOR="${GFS_READER_SELECTOR:-app=gfs-controller,clerum.io/gfsc-role=reader}"

log() { printf '[settle-gfs-reader-rollout] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
kc() { kubectl --context="$T2_CONTEXT" "$@"; }

SETTLE_CLEANUP_DONE=false

cleanup_settle() {
  local status="${1:-$?}"
  if [ "$SETTLE_CLEANUP_DONE" = true ]; then
    return "$status"
  fi
  SETTLE_CLEANUP_DONE=true
  trap - EXIT
  trap '' INT TERM
  t2_lock_release "$status" || status=$?
  return "$status"
}
handle_settle_signal() {
  local signal="$1" status
  case "$signal" in
    INT) status=130 ;;
    TERM) status=143 ;;
    *) status=1 ;;
  esac
  cleanup_settle "$status" || status=$?
  exit "$status"
}
handle_settle_exit() {
  local status=$?
  cleanup_settle "$status" || status=$?
  exit "$status"
}
trap handle_settle_exit EXIT
trap 'handle_settle_signal INT' INT
trap 'handle_settle_signal TERM' TERM
t2_repo_metadata
t2_profile_scope
t2_context_check
t2_mutation_lock

# The proof library is sourced only after the profile fence is established. It
# reads the committed DSN in memory and never prints it.
# shellcheck source=deploy/scripts/lib/gfs-credential-secret.sh
source "$ROOT/deploy/scripts/lib/gfs-credential-secret.sh"
# shellcheck source=deploy/scripts/lib/gfs-credential-rollout.sh
source "$ROOT/deploy/scripts/lib/gfs-credential-rollout.sh"

deployment_probe=""
if ! deployment_probe="$(kc -n "$GFS_NS" get deployment "$DEPLOY" 2>&1)"; then
  if [[ "$deployment_probe" == *NotFound* || "$deployment_probe" == *"not found"* ]]; then
    exit 0
  fi
  die "unable to inspect gfs/${DEPLOY}: ${deployment_probe}"
fi

if ! desired="$(kc -n "$GFS_NS" get deployment "$DEPLOY" -o jsonpath='{.spec.replicas}' 2>&1)"; then
  die "unable to read desired replicas for gfs/${DEPLOY}: ${desired}"
fi
if [ -z "$desired" ] || ! [[ "$desired" =~ ^[0-9]+$ ]]; then
  die "desired replicas for gfs/${DEPLOY} is not numeric"
fi
if [ "$desired" = "0" ]; then
  exit 0
fi
if ! ready="$(kc -n "$GFS_NS" get deployment "$DEPLOY" -o jsonpath='{.status.readyReplicas}' 2>&1)"; then
  die "unable to read Ready replicas for gfs/${DEPLOY}: ${ready}"
fi
ready="${ready:-0}"
if ! [[ "$ready" =~ ^[0-9]+$ ]]; then
  die "Ready replicas for gfs/${DEPLOY} is not numeric"
fi
if [ "$ready" != "$desired" ]; then
  exit 0
fi

# Desired Ready is met from here on: leftovers below serve nothing.
current_rev="$(kc -n "$GFS_NS" get deployment "$DEPLOY" \
  -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
rs_rows="$(kc -n "$GFS_NS" get rs -l "$SELECTOR" -o \
  'jsonpath={range .items[*]}{.metadata.name}{"|"}{.metadata.ownerReferences[0].name}{"|"}{.spec.replicas}{"|"}{.status.readyReplicas}{"|"}{.metadata.annotations.deployment\.kubernetes\.io/revision}{"\n"}{end}' \
  2>/dev/null)"
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
  2>/dev/null)"
while IFS='|' read -r pod_name pod_ready pod_deleting pod_reason; do
  [ -n "$pod_name" ] || continue
  [ -z "$pod_deleting" ] || continue
  [ "$pod_ready" != True ] || continue
  [ "$pod_reason" = CrashLoopBackOff ] || continue
  log "deleting CrashLoopBackOff pod ${pod_name} so it re-reads the Secret without waiting out kubelet backoff"
  kc -n "$GFS_NS" delete pod "$pod_name" --wait=false >/dev/null
done <<<"$pod_rows"

secret_probe=""
if ! secret_probe="$(kc -n "$GFS_NS" get secret "$SECRET" 2>&1)"; then
  if [[ "$secret_probe" == *NotFound* || "$secret_probe" == *"not found"* ]]; then
    exit 0
  fi
  die "unable to inspect ${GFS_NS}/${SECRET}: ${secret_probe}"
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
credential_rollout_proof "$SECRET" "$DEPLOY" "$rotated"
mark_secret_rollout_ready "$SECRET" "$rotated" rollout-running
