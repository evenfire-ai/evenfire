#!/usr/bin/env bash
# Rebuild the control-api database contract and restore persisted GFS roles
# after an intentional PostgreSQL data-volume recreation.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY=""
JOB_NAME="control-api-db-migrate-reset"
NAMESPACE=control-plane
PVC=control-postgres-data
RESET_STATE=control-db-reset-state
# Migration Jobs intentionally share app=control-api for NetworkPolicy access.
# Fence only the unlabeled runtime Deployment Pods; completed Job Pods can
# remain until their TTL expires and must not block writer quiescence.
CONTROL_API_POD_SELECTOR='app=control-api,!clerum.io/component'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --overlay)
      OVERLAY="${2:?--overlay requires a path}"
      shift 2
      ;;
    --job-name)
      JOB_NAME="${2:?--job-name requires a value}"
      shift 2
      ;;
    *)
      printf '[converge-control-db-after-reset] ERROR: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[ -n "$OVERLAY" ] \
  || { printf '[converge-control-db-after-reset] ERROR: --overlay is required\n' >&2; exit 2; }

# Reset convergence writes cluster state, scales multiple workloads, and
# restores GFS credentials. It is a private child of the owning T2/full-setup
# transition and must prove that lease before the first Kubernetes read/write.
# The validator also binds the effective profile and context, so CONTEXT alone
# cannot redirect this recovery path.
T2_EFFECTIVE_PROFILE="${T2_PROFILE:-${MINIKUBE_PROFILE:-${CONTEXT}}}"
T2_EFFECTIVE_CONTEXT="${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-${CONTEXT}}}"
if [[ "${T2_EFFECTIVE_PROFILE}" != "${T2_EFFECTIVE_CONTEXT}" ||
      "${T2_EFFECTIVE_CONTEXT}" != "${CONTEXT}" ]]; then
  printf '[converge-control-db-after-reset] ERROR: mutation profile/context does not match CONTEXT\n' >&2
  exit 1
fi
T2_PROJECT_DIR="${T2_PROJECT_DIR:-${ROOT}}" \
T2_PROFILE="${T2_EFFECTIVE_PROFILE}" \
T2_CONTEXT="${T2_EFFECTIVE_CONTEXT}" \
T2_LOCK_TOKEN="${T2_LOCK_TOKEN:-}" \
T2_LOCK_ROOT="${T2_LOCK_ROOT:-${HOME}/.cache/evenfire/minikube-t2-locks}" \
bash "$ROOT/scripts/minikube/require-t2-mutation-lock.sh"

kc() { kubectl --context="$CONTEXT" "$@"; }
fail() { printf '[converge-control-db-after-reset] ERROR: %s\n' "$*" >&2; exit 1; }

read_reset_state() {
  local raw
  raw="$(kc -n "$NAMESPACE" get configmap "$RESET_STATE" -o \
    'jsonpath={.metadata.uid}{"|"}{.metadata.resourceVersion}{"|"}{.data.stateVersion}{"|"}{.data.phase}{"|"}{.data.originalPvcUid}{"|"}{.data.replacementPvcUid}{"|"}{.data.hccReplicas}{"|"}{.data.workflowReplicas}{"|"}{.data.traceReplicas}{"|"}{.data.writerReplicas}{"|"}{.data.readerReplicas}{"|"}{.data.controlApiReplicas}')" \
    || return 1
  IFS='|' read -r STATE_UID STATE_RV STATE_VERSION STATE_PHASE ORIGINAL_PVC_UID \
    REPLACEMENT_PVC_UID HCC_REPLICAS WORKFLOW_REPLICAS TRACE_REPLICAS \
    WRITER_REPLICAS READER_REPLICAS CONTROL_API_REPLICAS <<<"$raw"
  case "$STATE_PHASE" in
    authorized|deleting-original)
      fail "reset is still in storage phase '${STATE_PHASE}'; run reset-control-db-storage.sh --resume to finish it before convergence" ;;
  esac
  [ -n "$STATE_UID" ] && [ -n "$STATE_RV" ] && [ "$STATE_VERSION" = 1 ] \
    && [[ "$STATE_PHASE" =~ ^(original-deleted|replacement-bound|converged)$ ]] \
    && [ -n "$ORIGINAL_PVC_UID" ] && [ -n "$REPLACEMENT_PVC_UID" ] \
    && [[ "$HCC_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$WORKFLOW_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$TRACE_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$WRITER_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$READER_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$CONTROL_API_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    || fail "reset recovery state is incomplete or invalid"
}

cas_phase() {
  local expected_phase="$1" next_phase="$2" expected_replacement="$3" next_replacement="$4" patch
  patch="$(python3 - "$STATE_RV" "$expected_phase" "$next_phase" \
    "$ORIGINAL_PVC_UID" "$expected_replacement" "$next_replacement" <<'PY'
import json
import sys

rv, old_phase, new_phase, original_uid, old_replacement, new_replacement = sys.argv[1:]
print(json.dumps([
    {"op": "test", "path": "/metadata/resourceVersion", "value": rv},
    {"op": "test", "path": "/data/stateVersion", "value": "1"},
    {"op": "test", "path": "/data/phase", "value": old_phase},
    {"op": "test", "path": "/data/originalPvcUid", "value": original_uid},
    {"op": "test", "path": "/data/replacementPvcUid", "value": old_replacement},
    {"op": "replace", "path": "/data/phase", "value": new_phase},
    {"op": "replace", "path": "/data/replacementPvcUid", "value": new_replacement},
]))
PY
)" || fail "cannot build reset-state compare-and-swap patch"
  kc -n "$NAMESPACE" patch configmap "$RESET_STATE" --type=json -p "$patch" >/dev/null \
    || fail "reset state changed concurrently while advancing ${expected_phase} to ${next_phase}"
  read_reset_state || fail "cannot reload reset state after advancing to ${next_phase}"
  [ "$STATE_PHASE" = "$next_phase" ] && [ "$REPLACEMENT_PVC_UID" = "$next_replacement" ] \
    || fail "reset-state compare-and-swap did not persist ${next_phase}"
}

current_pvc_uid() {
  kc -n "$NAMESPACE" get pvc "$PVC" -o 'jsonpath={.metadata.uid}' --ignore-not-found
}

assert_replacement_uid() {
  local observed
  observed="$(current_pvc_uid)" || fail "cannot inspect replacement PVC"
  [ -n "$observed" ] || fail "replacement PVC is missing"
  [ "$observed" = "$REPLACEMENT_PVC_UID" ] \
    || fail "replacement PVC UID changed after it was bound"
}

delete_reset_state() {
  local remaining_uid
  if printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}\n' \
    "$STATE_UID" | kc -n "$NAMESPACE" delete --raw \
      "/api/v1/namespaces/${NAMESPACE}/configmaps/${RESET_STATE}" -f - --wait=true >/dev/null; then
    CONVERGED=true
    return 0
  fi
  remaining_uid="$(kc -n "$NAMESPACE" get configmap "$RESET_STATE" \
    -o 'jsonpath={.metadata.uid}' --ignore-not-found)" \
    || fail "cannot resolve reset-state cleanup result"
  if [ -z "$remaining_uid" ]; then
    CONVERGED=true
    return 0
  fi
  [ "$remaining_uid" = "$STATE_UID" ] \
    || fail "a different reset state replaced the completed recovery record"
  CONVERGED=true
  fail "verified convergence is complete but reset-state cleanup failed; retry convergence"
}

CONVERGED=false
fail_closed() {
  local rc=$? scale_rc control_api_pods
  if [ "$CONVERGED" != true ]; then
    set +e
    scale_rc=0
    control_api_pods=""
    kc -n control-plane scale deployment/control-api --replicas=0 >/dev/null || scale_rc=1
    kc -n control-plane scale deployment/host-context-controller --replicas=0 >/dev/null || scale_rc=1
    kc -n control-plane scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0 >/dev/null || scale_rc=1
    kc -n gfs scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0 >/dev/null || scale_rc=1
    if ! control_api_pods="$(kc -n control-plane get pods -l "$CONTROL_API_POD_SELECTOR" -o name)"; then
      scale_rc=1
    elif [ -n "$control_api_pods" ]; then
      kc -n control-plane wait --for=delete pod \
        -l "$CONTROL_API_POD_SELECTOR" --timeout=180s >/dev/null || scale_rc=1
    fi
    printf '[converge-control-db-after-reset] ERROR: convergence failed; DB-dependent controllers remain scaled to zero' >&2
    [ "$scale_rc" -eq 0 ] || printf ' (failed to confirm fail-closed quiescence)' >&2
    printf '\n' >&2
  fi
  trap - EXIT
  exit "$rc"
}
trap fail_closed EXIT

read_reset_state || fail "reset recovery state is missing"
observed_uid="$(current_pvc_uid)" || fail "cannot inspect replacement PVC"
[ -n "$observed_uid" ] || fail "replacement PVC is missing"
case "$STATE_PHASE" in
  original-deleted)
    [ "$ORIGINAL_PVC_UID" = none ] || [ "$observed_uid" != "$ORIGINAL_PVC_UID" ] \
      || fail "authorized original PVC still occupies the claim name"
    cas_phase original-deleted replacement-bound unbound "$observed_uid"
    ;;
  replacement-bound|converged)
    [ "$REPLACEMENT_PVC_UID" != unbound ] || fail "reset state has no replacement UID"
    [ "$observed_uid" = "$REPLACEMENT_PVC_UID" ] || fail "replacement PVC UID changed"
    ;;
esac

# A completed run can leave only its recovery record behind if cleanup failed.
# Revalidate the bound replacement and exact runtime, then retry cleanup without
# rerunning migrations or rotating credentials.
if [ "$STATE_PHASE" = converged ]; then
  kc -n control-plane scale deployment/control-api --replicas="$CONTROL_API_REPLICAS" >/dev/null
  kc -n control-plane rollout status deployment/control-api --timeout=180s >/dev/null
  kc -n gfs scale deployment/gfsc-writer --replicas="$WRITER_REPLICAS" >/dev/null
  kc -n gfs scale deployment/gfsc-reader --replicas="$READER_REPLICAS" >/dev/null
  kc -n gfs rollout status deployment/gfsc-writer --timeout=180s >/dev/null
  kc -n gfs rollout status deployment/gfsc-reader --timeout=180s >/dev/null
  CONTEXT="$CONTEXT" bash "$ROOT/scripts/minikube/verify-gfs.sh"
  kc -n control-plane scale deployment/workflow-recipes --replicas="$WORKFLOW_REPLICAS" >/dev/null
  kc -n control-plane scale deployment/trace-maintenance-worker --replicas="$TRACE_REPLICAS" >/dev/null
  if [ "$WORKFLOW_REPLICAS" -gt 0 ]; then
    kc -n control-plane rollout status deployment/workflow-recipes --timeout=180s >/dev/null
  fi
  if [ "$TRACE_REPLICAS" -gt 0 ]; then
    kc -n control-plane rollout status deployment/trace-maintenance-worker --timeout=180s >/dev/null
  fi
  kc -n control-plane scale deployment/host-context-controller --replicas="$HCC_REPLICAS" >/dev/null
  if [ "$HCC_REPLICAS" -gt 0 ]; then
    kc -n control-plane rollout status deployment/host-context-controller --timeout=900s >/dev/null
  fi
  assert_replacement_uid
  delete_reset_state
  printf '[converge-control-db-after-reset] verified convergence already complete; recovery state removed\n' >&2
  trap - EXIT
  exit 0
fi

# Secret-backed environment variables are captured when a Pod is created; a
# Secret patch does not update an existing container. Reassert this fence on
# every replacement-bound retry, not only in the destructive reset process, so
# no stale control-api Pod can survive runtime-role credential reconciliation.
kc -n control-plane scale deployment/control-api --replicas=0 >/dev/null
CONTROL_API_PODS="$(kc -n control-plane get pods -l "$CONTROL_API_POD_SELECTOR" -o name)"
if [ -n "$CONTROL_API_PODS" ]; then
  kc -n control-plane wait --for=delete pod \
    -l "$CONTROL_API_POD_SELECTOR" --timeout=180s >/dev/null
fi
kc -n control-plane scale deployment/host-context-controller --replicas=0 >/dev/null
HCC_PODS="$(kc -n control-plane get pods -l app=host-context-controller -o name)"
if [ -n "$HCC_PODS" ]; then
  kc -n control-plane wait --for=delete pod \
    -l app=host-context-controller --timeout=180s >/dev/null
fi
kc -n control-plane scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0 >/dev/null
WORKFLOW_PODS="$(kc -n control-plane get pods -l app=workflow-recipes -o name)"
if [ -n "$WORKFLOW_PODS" ]; then
  kc -n control-plane wait --for=delete pod -l app=workflow-recipes --timeout=180s >/dev/null
fi
TRACE_PODS="$(kc -n control-plane get pods -l app=trace-maintenance-worker -o name)"
if [ -n "$TRACE_PODS" ]; then
  kc -n control-plane wait --for=delete pod -l app=trace-maintenance-worker --timeout=180s >/dev/null
fi
kc -n gfs scale \
  deployment/gfsc-writer deployment/gfsc-reader --replicas=0 >/dev/null
GFSC_PODS="$(kc -n gfs get pods -l app=gfs-controller -o name)"
if [ -n "$GFSC_PODS" ]; then
  kc -n gfs wait --for=delete pod \
    -l app=gfs-controller --timeout=180s >/dev/null
fi

env CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash "$ROOT/deploy/scripts/run-control-api-db-migration.sh" \
  --overlay "$OVERLAY" --job-name "$JOB_NAME"
env CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash "$ROOT/deploy/scripts/provision-control-api-runtime-roles.sh"

kc -n control-plane scale deployment/control-api --replicas="$CONTROL_API_REPLICAS" >/dev/null
kc -n control-plane rollout status deployment/control-api --timeout=180s >/dev/null

# The base gfs-config intentionally carries no real key. Reset recovery is a
# complete serving restoration boundary, so materialize the canonical platform
# public key while GFSC remains at zero; missing authority inputs fail closed.
bash "$ROOT/scripts/minikube/sync-auth-key.sh" \
  --context "$CONTEXT" --require-gfs

GFS_RESTORE_ACTIVE_NOLOGIN=true CONTEXT="$CONTEXT" \
  bash "$ROOT/deploy/scripts/reconcile-gfs-deploy-credentials.sh"

kc -n gfs scale deployment/gfsc-writer \
  --replicas="$WRITER_REPLICAS" >/dev/null
kc -n gfs scale deployment/gfsc-reader \
  --replicas="$READER_REPLICAS" >/dev/null
kc -n gfs rollout status deployment/gfsc-writer --timeout=180s >/dev/null
kc -n gfs rollout status deployment/gfsc-reader --timeout=180s >/dev/null
CONTEXT="$CONTEXT" bash "$ROOT/scripts/minikube/verify-gfs.sh"

kc -n control-plane scale deployment/workflow-recipes --replicas="$WORKFLOW_REPLICAS" >/dev/null
kc -n control-plane scale deployment/trace-maintenance-worker --replicas="$TRACE_REPLICAS" >/dev/null
if [ "$WORKFLOW_REPLICAS" -gt 0 ]; then
  kc -n control-plane rollout status deployment/workflow-recipes --timeout=180s >/dev/null
fi
if [ "$TRACE_REPLICAS" -gt 0 ]; then
  kc -n control-plane rollout status deployment/trace-maintenance-worker --timeout=180s >/dev/null
fi

kc -n control-plane scale deployment/host-context-controller \
  --replicas="$HCC_REPLICAS" >/dev/null
if [ "$HCC_REPLICAS" -gt 0 ]; then
  kc -n control-plane rollout status \
    deployment/host-context-controller --timeout=900s >/dev/null
fi
assert_replacement_uid
read_reset_state || fail "cannot reload reset state before completion"
[ "$STATE_PHASE" = replacement-bound ] \
  || fail "reset state changed before convergence completion"
cas_phase replacement-bound converged "$REPLACEMENT_PVC_UID" "$REPLACEMENT_PVC_UID"
delete_reset_state
printf '[converge-control-db-after-reset] migrations, runtime roles, GFS restore, and verification complete\n' >&2
trap - EXIT
