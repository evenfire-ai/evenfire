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
SETTLE_T2_MANAGED=false
[ -n "$T2_LOCK_TOKEN" ] && SETTLE_T2_MANAGED=true
GFS_NS="${GFS_NS:-gfs}"
DEPLOY="${GFS_READER_DEPLOYMENT:-gfsc-reader}"
SECRET="${GFS_READER_DB_SECRET:-gfs-controller-reader-db}"
SELECTOR="${GFS_READER_SELECTOR:-app=gfs-controller,clerum.io/gfsc-role=reader}"
SCALE_DOWN_TIMEOUT_SECONDS="${GFS_READER_SCALE_DOWN_TIMEOUT_SECONDS:-60}"
SCALE_DOWN_POLL_SECONDS="${GFS_READER_SCALE_DOWN_POLL_SECONDS:-1}"

log() { printf '[settle-gfs-reader-rollout] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
kc() { kubectl --context="$T2_CONTEXT" "$@"; }

wait_for_scaled_rs() {
  local rs_name="$1" deadline desired pod_rows live
  deadline=$((SECONDS + SCALE_DOWN_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    desired="$(kc -n "$GFS_NS" get rs "$rs_name" -o jsonpath='{.spec.replicas}' 2>&1)" ||
      die "unable to verify ReplicaSet ${rs_name} scale-down: ${desired}"
    [[ "$desired" =~ ^[0-9]+$ ]] || die "ReplicaSet ${rs_name} returned a non-numeric replica count"
    pod_rows="$(kc -n "$GFS_NS" get pods -l "$SELECTOR" -o \
      'jsonpath={range .items[*]}{.metadata.ownerReferences[0].name}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>&1)" ||
      die "unable to inspect pods while waiting for ReplicaSet ${rs_name} scale-down: ${pod_rows}"
    live="$(awk -F'|' -v rs="$rs_name" '$1 == rs && $2 == "" { n++ } END { print n+0 }' <<<"$pod_rows")"
    if [ "$desired" = 0 ] && [ "${live:-0}" -eq 0 ]; then
      return 0
    fi
    sleep "$SCALE_DOWN_POLL_SECONDS"
  done
  die "ReplicaSet ${rs_name} did not settle at zero replicas before credential proof"
}

SETTLE_CLEANUP_DONE=false

cleanup_settle() {
  local status="${1:-$?}"
  if [ "$SETTLE_CLEANUP_DONE" = true ]; then
    return "$status"
  fi
  SETTLE_CLEANUP_DONE=true
  trap - EXIT
  trap '' INT TERM
  if [ "$SETTLE_T2_MANAGED" = true ]; then
    t2_lock_release "$status" || status=$?
  fi
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
if [ "$SETTLE_T2_MANAGED" = true ]; then
  t2_repo_metadata
  t2_profile_scope
  t2_context_check
  t2_mutation_lock
else
  [ "${GFS_READER_ROLLOUT_AUTHORIZED:-false}" = true ] ||
    die 'non-T2 reader settlement requires explicit GFS_READER_ROLLOUT_AUTHORIZED=true'
  authorized=false
  # Bash 3.2 expands an empty array as an unset variable under `set -u`.
  # Leave the explicit authorization failure below in charge when the caller
  # omits ALLOWED_CONTEXTS instead of masking it with an array expansion error.
  if [ -n "${ALLOWED_CONTEXTS:-}" ]; then
    IFS=',' read -r -a allowed_contexts <<<"${ALLOWED_CONTEXTS}"
    for allowed_context in "${allowed_contexts[@]}"; do
      [ "$allowed_context" = "$CONTEXT" ] && authorized=true
    done
  fi
  [ "$authorized" = true ] ||
    die "non-T2 reader settlement context is not in the explicit ALLOWED_CONTEXTS list: $CONTEXT"
fi

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
scaled_rs_names=()
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
  scaled_rs_names+=("$rs_name")
done <<<"$rs_rows"

# Bash 3.2 treats an empty array expansion as unbound with `set -u`.
if [ "${#scaled_rs_names[@]}" -gt 0 ]; then
  for rs_name in "${scaled_rs_names[@]}"; do
    wait_for_scaled_rs "$rs_name"
  done
fi

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
