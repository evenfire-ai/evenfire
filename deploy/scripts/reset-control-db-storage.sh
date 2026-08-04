#!/usr/bin/env bash
# Fail-closed destructive boundary for an intentional control-postgres reset.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAMESPACE=control-plane
PVC=control-postgres-data
SCRUB_POD=control-postgres-storage-reset
RESET_STATE=control-db-reset-state
EXPECTED_PVC_UID=""
EXPECT_NO_PVC=false
RESUME=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-pvc-uid)
      EXPECTED_PVC_UID="${2:?--expected-pvc-uid requires a value}"
      shift 2
      ;;
    --expect-no-pvc)
      EXPECT_NO_PVC=true
      shift
      ;;
    --resume)
      RESUME=true
      shift
      ;;
    *)
      printf '[reset-control-db-storage] ERROR: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [ "$EXPECT_NO_PVC" = true ] && [ -n "$EXPECTED_PVC_UID" ]; then
  printf '[reset-control-db-storage] ERROR: choose exactly one PVC expectation\n' >&2
  exit 2
fi
[ "$EXPECT_NO_PVC" = true ] || [ -n "$EXPECTED_PVC_UID" ] \
  || { printf '[reset-control-db-storage] ERROR: --expected-pvc-uid or --expect-no-pvc is required\n' >&2; exit 2; }

kc() { kubectl --context="$CONTEXT" "$@"; }
fail() { printf '[reset-control-db-storage] ERROR: %s\n' "$*" >&2; exit 1; }

deployment_replicas() {
  local namespace="$1" deployment="$2" value
  if ! value="$(kc -n "$namespace" get "deployment/$deployment" -o 'jsonpath={.spec.replicas}' 2>&1)"; then
    case "$namespace $value" in
      'gfs '*NotFound*)
        fail "gfs deployment ${deployment} not found — this cluster has not adopted the GFS stack, and the control-DB reset requires running gfsc-writer/gfsc-reader for verified restoration (see docs/deploy/minikube.md)"
        ;;
    esac
    fail "cannot capture ${namespace}/${deployment} replicas: ${value}"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] \
    || fail "invalid ${namespace}/${deployment} replica count"
  printf '%s' "$value"
}

wait_for_deployment_pods_gone() {
  local namespace="$1" selector="$2" pods
  pods="$(kc -n "$namespace" get pods -l "$selector" -o name)" \
    || fail "cannot inspect ${namespace} pods selected by ${selector}"
  if [ -n "$pods" ]; then
    kc -n "$namespace" wait --for=delete pod -l "$selector" --timeout=180s >/dev/null \
      || fail "timed out quiescing ${namespace} pods selected by ${selector}"
  fi
}

read_reset_state() {
  local raw
  raw="$(kc -n "$NAMESPACE" get configmap "$RESET_STATE" -o \
    'jsonpath={.metadata.resourceVersion}{"|"}{.data.stateVersion}{"|"}{.data.phase}{"|"}{.data.originalPvcUid}{"|"}{.data.replacementPvcUid}{"|"}{.data.hccReplicas}{"|"}{.data.workflowReplicas}{"|"}{.data.traceReplicas}{"|"}{.data.writerReplicas}{"|"}{.data.readerReplicas}{"|"}{.data.controlApiReplicas}')" \
    || return 1
  IFS='|' read -r STATE_RV STATE_VERSION STATE_PHASE STATE_ORIGINAL_PVC_UID \
    STATE_REPLACEMENT_PVC_UID STATE_HCC_REPLICAS STATE_WORKFLOW_REPLICAS \
    STATE_TRACE_REPLICAS STATE_WRITER_REPLICAS STATE_READER_REPLICAS \
    STATE_CONTROL_API_REPLICAS <<<"$raw"
  [ -n "$STATE_RV" ] \
    && [ "$STATE_VERSION" = 1 ] \
    && [[ "$STATE_PHASE" =~ ^(authorized|deleting-original|original-deleted|replacement-bound|converged)$ ]] \
    && [ -n "$STATE_ORIGINAL_PVC_UID" ] \
    && [ -n "$STATE_REPLACEMENT_PVC_UID" ] \
    && [[ "$STATE_HCC_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$STATE_WORKFLOW_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$STATE_TRACE_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$STATE_WRITER_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$STATE_READER_REPLICAS" =~ ^[0-9]+$ ]] \
    && [[ "$STATE_CONTROL_API_REPLICAS" =~ ^[1-9][0-9]*$ ]] \
    || fail "${NAMESPACE}/${RESET_STATE} is incomplete or invalid"
}

cas_reset_phase() {
  local expected_phase="$1" next_phase="$2" expected_replacement="$3" next_replacement="$4"
  local patch
  patch="$(python3 - "$STATE_RV" "$expected_phase" "$next_phase" \
    "$STATE_ORIGINAL_PVC_UID" "$expected_replacement" "$next_replacement" <<'PY'
import json
import sys

rv, expected_phase, next_phase, original_uid, expected_replacement, next_replacement = sys.argv[1:]
print(json.dumps([
    {"op": "test", "path": "/metadata/resourceVersion", "value": rv},
    {"op": "test", "path": "/data/stateVersion", "value": "1"},
    {"op": "test", "path": "/data/phase", "value": expected_phase},
    {"op": "test", "path": "/data/originalPvcUid", "value": original_uid},
    {"op": "test", "path": "/data/replacementPvcUid", "value": expected_replacement},
    {"op": "replace", "path": "/data/phase", "value": next_phase},
    {"op": "replace", "path": "/data/replacementPvcUid", "value": next_replacement},
]))
PY
)" || fail "cannot build reset-state compare-and-swap patch"
  kc -n "$NAMESPACE" patch configmap "$RESET_STATE" --type=json -p "$patch" >/dev/null \
    || fail "reset state changed concurrently while advancing ${expected_phase} to ${next_phase}"
  read_reset_state || fail "cannot reload reset state after advancing to ${next_phase}"
  [ "$STATE_PHASE" = "$next_phase" ] \
    && [ "$STATE_REPLACEMENT_PVC_UID" = "$next_replacement" ] \
    || fail "reset-state compare-and-swap did not persist ${next_phase}"
}

# The scrub pod can only mount the claim by name, so the authorized original
# object is frozen first: a finalizer added under a UID+resourceVersion
# compare-and-swap guarantees the name cannot be reused by a replacement
# between the UID check and the scrub mount. The API server refuses new
# finalizers on terminating objects and refuses a same-name create while the
# pinned object exists, so a pinned claim is provably the authorized original.
RESET_SCRUB_FINALIZER=clerum.io/control-db-reset-scrub

original_finalizer_step() {
  local mode="$1" expected_uid="$2" claim_json
  claim_json="$(kc -n "$NAMESPACE" get pvc "$PVC" -o json --ignore-not-found)" \
    || return 1
  RESET_CLAIM_JSON="$claim_json" python3 - "$mode" "$expected_uid" "$RESET_SCRUB_FINALIZER" <<'PY'
import json
import os
import sys

mode, expected_uid, finalizer = sys.argv[1:]
raw = os.environ.get("RESET_CLAIM_JSON", "").strip()
if not raw:
    print("absent")
    sys.exit(0)
meta = json.loads(raw).get("metadata") or {}
if meta.get("uid", "") != expected_uid:
    print("replaced")
    sys.exit(0)
finalizers = list(meta.get("finalizers") or [])
present = finalizer in finalizers
if mode == "ensure" and meta.get("deletionTimestamp"):
    print("terminating")
    sys.exit(0)
if present == (mode == "ensure"):
    print("done")
    sys.exit(0)
if mode == "ensure":
    value = finalizers + [finalizer]
else:
    value = [item for item in finalizers if item != finalizer]
patch = [
    {"op": "test", "path": "/metadata/uid", "value": expected_uid},
    {"op": "test", "path": "/metadata/resourceVersion", "value": meta.get("resourceVersion", "")},
    {"op": "replace" if finalizers else "add", "path": "/metadata/finalizers", "value": value},
]
print("patch " + json.dumps(patch))
PY
}

sync_original_finalizer() {
  # ensure -> pinned (scrub may mount by name) or skip (original gone/replaced).
  # remove -> done. Terminating or persistently contended claims fail closed.
  local mode="$1" expected_uid="$2" attempt step
  for attempt in 1 2 3 4 5; do
    step="$(original_finalizer_step "$mode" "$expected_uid")" \
      || fail "cannot inspect ${NAMESPACE}/${PVC} while settling its scrub finalizer"
    case "$step" in
      done)
        if [ "$mode" = ensure ]; then printf pinned; else printf done; fi
        return 0
        ;;
      absent|replaced)
        if [ "$mode" = ensure ]; then printf skip; else printf done; fi
        return 0
        ;;
      terminating)
        fail "authorized original ${NAMESPACE}/${PVC} is terminating; if this reset just issued its delete, retry --resume after termination completes — otherwise an external delete is in flight and scrubbing an unpinnable claim is refused"
        ;;
      "patch "*)
        # A lost compare-and-swap means the claim changed concurrently; the
        # next iteration re-reads and re-adjudicates the live object.
        kc -n "$NAMESPACE" patch pvc "$PVC" --type=json -p "${step#patch }" >/dev/null || true
        ;;
      *)
        fail "unexpected scrub-finalizer state for ${NAMESPACE}/${PVC}: ${step}"
        ;;
    esac
  done
  fail "cannot settle the ${RESET_SCRUB_FINALIZER} finalizer on ${NAMESPACE}/${PVC} after repeated concurrent changes"
}

quiesce_gfs() {
  # HCC owns GFSC and must stop first so its reconciler cannot undo the
  # zero-replica boundary while PostgreSQL storage is being removed.
  kc -n control-plane scale deployment/host-context-controller --replicas=0 >/dev/null \
    || fail "cannot quiesce control-plane/host-context-controller"
  wait_for_deployment_pods_gone control-plane app=host-context-controller
  kc -n control-plane scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0 >/dev/null \
    || fail "cannot quiesce PostgreSQL-dependent control-plane workers"
  wait_for_deployment_pods_gone control-plane app=workflow-recipes
  wait_for_deployment_pods_gone control-plane app=trace-maintenance-worker
  kc -n gfs scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0 >/dev/null \
    || fail "cannot quiesce GFS controllers"
  wait_for_deployment_pods_gone gfs app=gfs-controller
}

RESET_ACTIVE=false
fail_closed() {
  local rc=$?
  if [ "$RESET_ACTIVE" = true ]; then
    set +e
    kc -n control-plane scale deployment/host-context-controller --replicas=0 >/dev/null
    kc -n control-plane scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0 >/dev/null
    kc -n gfs scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0 >/dev/null
    printf '[reset-control-db-storage] ERROR: reset interrupted; DB-dependent controllers remain scaled to zero and %s/%s preserves recovery state; a pinned original PVC keeps the %s finalizer until --resume completes the scrub\n' \
      "$NAMESPACE" "$RESET_STATE" "$RESET_SCRUB_FINALIZER" >&2
  fi
  trap - EXIT
  exit "$rc"
}
trap fail_closed EXIT

wait_for_pods_gone() {
  local selector="$1" deadline=$((SECONDS + 120)) pods
  while true; do
    pods="$(kc -n "$NAMESPACE" get pods -l "$selector" -o json | python3 -c '
import json
import sys

for item in json.load(sys.stdin).get("items", []):
    owners = (item.get("metadata") or {}).get("ownerReferences") or []
    if any(owner.get("kind") == "ReplicaSet" for owner in owners):
        print((item.get("metadata") or {}).get("name", ""))
')" \
      || fail "cannot inspect pods matching ${selector}"
    [ -z "$pods" ] && return 0
    (( SECONDS < deadline )) \
      || fail "timed out waiting for pods matching ${selector} to terminate"
    sleep 1
  done
}

remove_scrub_pod() {
  kc -n "$NAMESPACE" delete pod "$SCRUB_POD" \
    --ignore-not-found=true --wait=true >/dev/null \
    || fail "cannot remove cleanup pod ${NAMESPACE}/${SCRUB_POD}"
}

report_scrub_failure() {
  local reason="$1"
  printf '[reset-control-db-storage] cleanup pod failed: %s\n' "$reason" >&2
  if ! kc -n "$NAMESPACE" logs "pod/$SCRUB_POD" >&2; then
    printf '[reset-control-db-storage] cleanup pod logs unavailable\n' >&2
  fi
  remove_scrub_pod
  fail "refusing to delete ${NAMESPACE}/${PVC}: storage cleanup did not succeed"
}

wait_for_scrub() {
  local deadline=$((SECONDS + 120)) phase
  while true; do
    phase="$(kc -n "$NAMESPACE" get pod "$SCRUB_POD" \
      -o 'jsonpath={.status.phase}')" \
      || report_scrub_failure "cannot inspect pod status"
    case "$phase" in
      Succeeded) return 0 ;;
      Failed) report_scrub_failure "pod entered Failed phase" ;;
    esac
    (( SECONDS < deadline )) \
      || report_scrub_failure "timed out waiting for Succeeded phase"
    sleep 1
  done
}

scrub_claim_contents() {
  local postgres_image
  postgres_image="$(kc -n "$NAMESPACE" get deployment control-postgres \
    -o 'jsonpath={.spec.template.spec.containers[?(@.name=="postgres")].image}')" \
    || fail "cannot resolve the current control-postgres image"
  [ -n "$postgres_image" ] \
    || fail "control-postgres deployment has no postgres container image"

  # A crash between pod creation and removal leaves the fixed-name pod behind;
  # remove any leftover first so --resume can recreate it instead of failing
  # AlreadyExists forever.
  remove_scrub_pod

  # Use the database image already selected by the deployment. The pod receives
  # only the exact database PVC: no hostPath, service-account token, or
  # privileged container is needed to remove storage-provider-retained bytes.
  if ! kc -n "$NAMESPACE" create -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${SCRUB_POD}
  namespace: ${NAMESPACE}
  labels:
    app: control-postgres-storage-reset
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 120
  terminationGracePeriodSeconds: 5
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: scrub
    image: ${postgres_image}
    imagePullPolicy: IfNotPresent
    command: ["/bin/sh", "-ceu"]
    args:
    - |
      find /reset-target -mindepth 1 -xdev -delete
      test -z "\$(find /reset-target -mindepth 1 -xdev -print -quit)"
    securityContext:
      allowPrivilegeEscalation: false
      privileged: false
      readOnlyRootFilesystem: true
      # Root is required to remove storage-provider-retained bytes across
      # arbitrary UIDs. Allowed by control-plane's PSA enforce=baseline;
      # restricted enforcement would reject this pod.
      runAsUser: 0
    volumeMounts:
    - name: reset-target
      mountPath: /reset-target
  volumes:
  - name: reset-target
    persistentVolumeClaim:
      claimName: ${PVC}
EOF
  then
    fail "cannot create cleanup pod ${NAMESPACE}/${SCRUB_POD}"
  fi

  wait_for_scrub
  remove_scrub_pod
}

CONTEXT="$CONTEXT" bash "$ROOT/deploy/scripts/preflight-gfs-db-reset.sh"

claim_uid="$(kc -n "$NAMESPACE" get pvc "$PVC" \
  -o 'jsonpath={.metadata.uid}' --ignore-not-found)" \
  || fail "cannot inspect ${NAMESPACE}/${PVC}"
expected_state_uid="$EXPECTED_PVC_UID"
[ "$EXPECT_NO_PVC" = true ] && expected_state_uid=none
if read_reset_state; then
  [ "$RESUME" = true ] \
    || fail "${NAMESPACE}/${RESET_STATE} already exists; refusing concurrent reset (use --resume only for the same interrupted reset)"
  [ "$STATE_ORIGINAL_PVC_UID" = "$expected_state_uid" ] \
    || fail "existing reset state belongs to a different PVC expectation"
  RESET_ACTIVE=true
  case "$STATE_PHASE" in
    authorized)
      if [ "$expected_state_uid" = none ]; then
        [ -z "$claim_uid" ] || fail "a PVC appeared before the no-PVC reset entered its destructive phase"
      else
        [ -z "$claim_uid" ] || [ "$claim_uid" = "$expected_state_uid" ] \
          || fail "${NAMESPACE}/${PVC} changed before the destructive phase was recorded"
      fi
      ;;
    deleting-original)
      # Once this phase is durable, only the authorized original UID can ever
      # be scrubbed or deleted. A different UID is a replacement and is left
      # untouched for converge-control-db-after-reset.sh to bind by CAS.
      ;;
    original-deleted)
      [ -z "$claim_uid" ] || [ "$claim_uid" != "$expected_state_uid" ] \
        || fail "the authorized original PVC reappeared after deletion"
      ;;
    replacement-bound|converged)
      [ "$STATE_REPLACEMENT_PVC_UID" != unbound ] \
        || fail "${STATE_PHASE} reset state has no replacement UID"
      [ "$claim_uid" = "$STATE_REPLACEMENT_PVC_UID" ] \
        || fail "replacement PVC UID changed after it was bound"
      ;;
  esac
else
  [ "$RESUME" = false ] \
    || fail "--resume requested but ${NAMESPACE}/${RESET_STATE} does not exist"
  if [ -n "$claim_uid" ]; then
    [ "$EXPECT_NO_PVC" = false ] \
      || fail "${NAMESPACE}/${PVC} exists; --expect-no-pvc cannot authorize its deletion"
    [ "$claim_uid" = "$EXPECTED_PVC_UID" ] \
      || fail "${NAMESPACE}/${PVC} UID changed before reset authorization was consumed"
  else
    [ "$EXPECT_NO_PVC" = true ] \
      || fail "approved ${NAMESPACE}/${PVC} UID is no longer present"
  fi
  hcc_replicas="$(deployment_replicas control-plane host-context-controller)"
  workflow_replicas="$(deployment_replicas control-plane workflow-recipes)"
  trace_replicas="$(deployment_replicas control-plane trace-maintenance-worker)"
  writer_replicas="$(deployment_replicas gfs gfsc-writer)"
  reader_replicas="$(deployment_replicas gfs gfsc-reader)"
  control_api_replicas="$(deployment_replicas "$NAMESPACE" control-api)"
  [ "$writer_replicas" -gt 0 ] && [ "$reader_replicas" -gt 0 ] \
    || fail "active GFSC writer and reader replicas are required for verified restoration"
  # Zero here means a previous reset quiesced control-api and its state record
  # was cleared: storing 0 would pass this script's checks and only fail in
  # converge AFTER the PVC is destroyed. Fail before anything is deleted.
  [ "$control_api_replicas" -gt 0 ] \
    || fail "control-api has 0 replicas at capture time; scale it up (or --resume the interrupted reset that quiesced it) before authorizing a new reset"
  kc -n "$NAMESPACE" create configmap "$RESET_STATE" \
    --from-literal="stateVersion=1" \
    --from-literal="phase=authorized" \
    --from-literal="originalPvcUid=$expected_state_uid" \
    --from-literal="replacementPvcUid=unbound" \
    --from-literal="hccReplicas=$hcc_replicas" \
    --from-literal="workflowReplicas=$workflow_replicas" \
    --from-literal="traceReplicas=$trace_replicas" \
    --from-literal="writerReplicas=$writer_replicas" \
    --from-literal="readerReplicas=$reader_replicas" \
    --from-literal="controlApiReplicas=$control_api_replicas" >/dev/null \
    || fail "cannot acquire reset state lock ${NAMESPACE}/${RESET_STATE}"
  read_reset_state || fail "cannot read newly acquired reset state"
fi
RESET_ACTIVE=true

# A converged reset already restored storage AND controllers; only its
# recovery-record cleanup can still be pending. Quiescing here would tear a
# healthy stack down to zero, so convergence owns that retry entirely.
if [ "$STATE_PHASE" = converged ]; then
  RESET_ACTIVE=false
  printf '[reset-control-db-storage] reset already converged; re-run converge-control-db-after-reset.sh to retry recovery-state cleanup\n' >&2
  trap - EXIT
  exit 0
fi

quiesce_gfs

# A resumed reset that has already deleted the original PVC must never turn a
# replacement PVC into a new destructive target. Convergence owns replacement
# binding and all later phases.
if [ "$STATE_PHASE" = original-deleted ] \
  || [ "$STATE_PHASE" = replacement-bound ]; then
  printf '[reset-control-db-storage] reset already passed original deletion (%s); replacement storage left untouched\n' \
    "$STATE_PHASE" >&2
  trap - EXIT
  exit 0
fi

kc -n "$NAMESPACE" scale deployment/control-api --replicas=0 >/dev/null
kc -n "$NAMESPACE" scale deployment/control-postgres --replicas=0 >/dev/null
wait_for_pods_gone app=control-api
wait_for_pods_gone app=control-postgres

if [ "$STATE_PHASE" = authorized ]; then
  read_reset_state || fail "cannot reload reset state before destructive phase"
  [ "$STATE_PHASE" = authorized ] \
    || fail "reset state changed before destructive phase"
  cas_reset_phase authorized deleting-original unbound unbound
fi

claim_uid="$(kc -n "$NAMESPACE" get pvc "$PVC" \
  -o 'jsonpath={.metadata.uid}' --ignore-not-found)" \
  || fail "cannot inspect ${NAMESPACE}/${PVC}"
[ "$STATE_PHASE" = deleting-original ] \
  || fail "destructive reset requires the durable deleting-original phase"
if [ -n "$claim_uid" ] \
  && { [ "$expected_state_uid" = none ] || [ "$claim_uid" != "$expected_state_uid" ]; }; then
  # The authorized original is already gone and a replacement now occupies
  # the name. It is never scrubbed or deleted by this reset invocation.
  claim_uid=""
fi
if [ -n "$claim_uid" ]; then
  # Freeze the authorized original before the scrub pod mounts by name: while
  # the finalizer is held the claim name cannot be handed to a replacement, so
  # the volume the scrub pod receives is provably the authorized original.
  pin_state="$(sync_original_finalizer ensure "$claim_uid")"
  if [ "$pin_state" = skip ]; then
    # The authorized original disappeared before it could be pinned; whatever
    # occupies the name now is a replacement and is never scrubbed.
    claim_uid=""
  fi
fi
[ -z "$claim_uid" ] || scrub_claim_contents
delete_uid="$(kc -n "$NAMESPACE" get pvc "$PVC" \
  -o 'jsonpath={.metadata.uid}' --ignore-not-found)" \
  || fail "cannot recheck ${NAMESPACE}/${PVC} before deletion"
if [ -n "$claim_uid" ]; then
  [ "$delete_uid" = "$claim_uid" ] \
    || fail "${NAMESPACE}/${PVC} changed between storage scrub and deletion"
  unpin_state="$(sync_original_finalizer remove "$claim_uid")"
  [ "$unpin_state" = done ] \
    || fail "cannot release the ${RESET_SCRUB_FINALIZER} finalizer before deletion"
  # The API-server UID precondition closes the name-reuse race between the
  # final check and deletion. It cannot delete a replacement PVC.
  printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}\n' \
    "$claim_uid" | kc -n "$NAMESPACE" delete --raw \
      "/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims/${PVC}" \
      -f - --wait=true >/dev/null \
    || fail "cannot delete the UID-bound original PVC"
elif [ -n "$delete_uid" ] && [ "$delete_uid" = "$expected_state_uid" ]; then
  fail "authorized original PVC appeared before deletion without being scrubbed"
fi

# Most StorageClasses reclaim the PV automatically. If a Released PV remains,
# delete only the volume bound to the exact claim UID observed above.
if [ -n "$claim_uid" ]; then
  released_pvs="$(kc get pv -o json | python3 -c '
import json
import sys

expected_uid = sys.argv[1]
for item in json.load(sys.stdin).get("items", []):
    phase = (item.get("status") or {}).get("phase", "")
    claim = (item.get("spec") or {}).get("claimRef") or {}
    if (
        phase == "Released"
        and claim.get("namespace") == "control-plane"
        and claim.get("name") == "control-postgres-data"
        and claim.get("uid") == expected_uid
    ):
        print((item.get("metadata") or {}).get("name", ""))
' "$claim_uid")" || fail "cannot inspect released persistent volumes"
  while IFS= read -r pv; do
    [ -z "$pv" ] && continue
    kc delete pv "$pv" --ignore-not-found=true --wait=true >/dev/null
  done <<<"$released_pvs"
fi

read_reset_state || fail "cannot reload reset state after original deletion"
[ "$STATE_PHASE" = deleting-original ] \
  || fail "reset state changed before recording original deletion"
cas_reset_phase deleting-original original-deleted unbound unbound

printf '[reset-control-db-storage] control-postgres storage deleted after safe scale-down\n' >&2
trap - EXIT
