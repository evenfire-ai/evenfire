#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat >"$TMP/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_LOG"

case "$*" in
  *'get secret gfs-controller-db -o name') printf 'secret/gfs-controller-db\n' ;;
  *'get secret'*'-o json')
    if [[ "$*" == *gfs-controller-reader-db* ]]; then role=gfs_controller_reader; else role=gfs_controller; fi
    DSN="postgresql://${role}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@control-postgres.control-plane.svc.cluster.local:5432/profiles" \
      python3 -c 'import base64,json,os; print(json.dumps({"metadata":{"resourceVersion":"1","annotations":{"clerum.io/gfs-dsn-state":"ready"}},"data":{"connection-string":base64.b64encode(os.environ["DSN"].encode()).decode()}}))'
    ;;
  *'apply set-last-applied'*|*' apply -f '*) exit 0 ;;
  *'get pvc control-postgres-data -o json --ignore-not-found'*)
    # JSON view consumed by the scrub-finalizer compare-and-swap. Finalizer
    # presence is tracked in a file toggled by the pvc patch mock below.
    if [ "$FAKE_MODE" = no-pvc ]; then exit 0; fi
    uid=claim-uid-1
    [ "$FAKE_MODE" != pin-replaced ] || uid=replacement-uid
    deletion=''
    [ "$FAKE_MODE" != pin-terminating ] || deletion=',"deletionTimestamp":"2026-07-21T00:00:00Z"'
    fin='"kubernetes.io/pvc-protection"'
    [ ! -f "$FAKE_FINALIZER" ] || fin="$fin,\"clerum.io/control-db-reset-scrub\""
    printf '{"metadata":{"uid":"%s","resourceVersion":"10","finalizers":[%s]%s}}\n' "$uid" "$fin" "$deletion"
    ;;
  *'patch pvc control-postgres-data --type=json'*)
    [ "$FAKE_MODE" != pin-patch-fail ] || exit 1
    payload=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -p ]; then shift; payload="$1"; break; fi
      shift
    done
    [ -n "$payload" ] || { printf 'missing pvc patch payload\n' >&2; exit 1; }
    case "$payload" in
      *control-db-reset-scrub*) touch "$FAKE_FINALIZER" ;;
      *)
        if [ "$FAKE_MODE" = unpin-contention ] && [ ! -f "$FAKE_UNPIN" ]; then
          touch "$FAKE_UNPIN"
          exit 1
        fi
        rm -f "$FAKE_FINALIZER"
        ;;
    esac
    ;;
  *'get pvc control-postgres-data'*)
    count=0; [ ! -f "$FAKE_COUNTER" ] || count="$(cat "$FAKE_COUNTER")"
    count=$((count + 1)); printf '%s' "$count" >"$FAKE_COUNTER"
    if [ "$FAKE_MODE" = no-pvc ]; then exit 0; fi
    if [[ "$FAKE_MODE" =~ ^resume-(after-delete|replacement-bound|converged|deleting-replacement)$ ]]; then printf replacement-uid; exit 0; fi
    if [ "$FAKE_MODE" = uid-mismatch ] && [ "$count" -eq 1 ]; then printf other-uid; exit 0; fi
    if [ "$FAKE_MODE" = uid-replaced-before-scrub ] && [ "$count" -ge 2 ]; then printf replacement-uid; exit 0; fi
    if [ "$FAKE_MODE" = uid-replaced-before-delete ] && [ "$count" -eq 3 ]; then printf replacement-uid; exit 0; fi
    if [ "$FAKE_MODE" = pin-replaced ] && [ "$count" -ge 3 ]; then printf replacement-uid; exit 0; fi
    printf claim-uid-1
    ;;
  *'get configmap control-db-reset-state'*)
    [ -s "$FAKE_STATE" ] || exit 1
    cat "$FAKE_STATE"
    ;;
  *'get deployment/host-context-controller'*) printf 4 ;;
  *'get deployment/workflow-recipes'*) printf 5 ;;
  *'get deployment/trace-maintenance-worker'*) printf 6 ;;
  *'get deployment/gfsc-writer'*) printf 3 ;;
  *'get deployment/gfsc-reader'*) printf 2 ;;
  *'get deployment/control-api'*) printf 2 ;;
  *'create configmap control-db-reset-state'*)
    [ "$FAKE_MODE" != state-create-fail ] || exit 1
    printf '1|1|authorized|%s|unbound|4|5|6|3|2|2\n' "${FAKE_ORIGINAL_UID:-claim-uid-1}" >"$FAKE_STATE"
    ;;
  *'patch configmap control-db-reset-state'*)
    [ "$FAKE_MODE" != state-cas-fail ] || exit 1
    IFS='|' read -r rv version phase original replacement hcc workflow trace writer reader controlapi <"$FAKE_STATE"
    payload=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -p ]; then shift; payload="$1"; break; fi
      shift
    done
    [ -n "$payload" ] || { printf 'missing patch payload\n' >&2; exit 1; }
    next_phase="$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(next(x["value"] for x in p if x["op"]=="replace" and x["path"]=="/data/phase"))' "$payload")" || { printf 'cannot parse phase\n' >&2; exit 1; }
    next_replacement="$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(next(x["value"] for x in p if x["op"]=="replace" and x["path"]=="/data/replacementPvcUid"))' "$payload")" || { printf 'cannot parse replacement\n' >&2; exit 1; }
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$((rv + 1))" "$version" "$next_phase" "$original" "$next_replacement" "$hcc" "$workflow" "$trace" "$writer" "$reader" "$controlapi" >"$FAKE_STATE"
    ;;
  *'scale deployment/host-context-controller --replicas=0'*) exit 0 ;;
  *'scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0'*) exit 0 ;;
  *'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0'*) exit 0 ;;
  *'get pods -l app=host-context-controller -o name') printf 'pod/hcc-old\n' ;;
  *'get pods -l app=gfs-controller -o name') printf 'pod/gfsc-old\n' ;;
  *'get pods -l app=workflow-recipes -o name') printf 'pod/workflow-old\n' ;;
  *'get pods -l app=trace-maintenance-worker -o name') printf 'pod/trace-old\n' ;;
  *'wait --for=delete pod -l app=host-context-controller'*) exit 0 ;;
  *'wait --for=delete pod -l app=gfs-controller'*) exit 0 ;;
  *'wait --for=delete pod -l app=workflow-recipes'*) exit 0 ;;
  *'wait --for=delete pod -l app=trace-maintenance-worker'*) exit 0 ;;
  *'scale deployment/control-api --replicas=0'*) exit 0 ;;
  *'scale deployment/control-postgres --replicas=0'*) exit 0 ;;
  *'get pods -l'*'-o json') printf '{"items":[]}\n' ;;
  *'get deployment control-postgres'*) printf 'postgres:16-alpine' ;;
  *'create -f -'*) cat >"$FAKE_MANIFEST"; [ "$FAKE_MODE" != scrub-create-fail ] ;;
  *'get pod control-postgres-storage-reset'*) printf Succeeded ;;
  *'delete pod control-postgres-storage-reset'*) exit 0 ;;
  *'delete --raw /api/v1/namespaces/control-plane/persistentvolumeclaims/control-postgres-data'*) cat >/dev/null; exit 0 ;;
  *'get pv -o json'*) printf '{"items":[]}\n' ;;
  *) printf 'unexpected kubectl invocation: %s\n' "$*" >&2; exit 91 ;;
esac
EOF
chmod +x "$TMP/bin/kubectl"

run_case() {
  local mode="$1"; shift
  : >"$TMP/$mode.log"; : >"$TMP/$mode.manifest"
  rm -f "$TMP/$mode.counter" "$TMP/$mode.state" "$TMP/$mode.finalizer" "$TMP/$mode.unpin"
  case "$mode" in
    concurrent|resume) printf '1|1|deleting-original|claim-uid-1|unbound|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
    resume-pinned)
      printf '1|1|deleting-original|claim-uid-1|unbound|4|5|6|3|2|2\n' >"$TMP/$mode.state"
      touch "$TMP/$mode.finalizer" ;;
    resume-after-delete) printf '1|1|original-deleted|claim-uid-1|unbound|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
    resume-replacement-bound) printf '1|1|replacement-bound|claim-uid-1|replacement-uid|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
    resume-converged) printf '1|1|converged|claim-uid-1|replacement-uid|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
    resume-deleting-replacement) printf '1|1|deleting-original|claim-uid-1|unbound|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
    state-substitution) printf '1|1|replacement-bound|claim-uid-1|other-replacement|4|5|6|3|2|2\n' >"$TMP/$mode.state" ;;
  esac
  env PATH="$TMP/bin:$PATH" FAKE_MODE="$mode" FAKE_LOG="$TMP/$mode.log" \
    FAKE_MANIFEST="$TMP/$mode.manifest" FAKE_COUNTER="$TMP/$mode.counter" \
    FAKE_STATE="$TMP/$mode.state" FAKE_FINALIZER="$TMP/$mode.finalizer" \
    FAKE_UNPIN="$TMP/$mode.unpin" \
    FAKE_ORIGINAL_UID="$([ "$mode" = no-pvc ] && printf none || printf claim-uid-1)" CONTEXT=test \
    bash "$ROOT/deploy/scripts/reset-control-db-storage.sh" "$@" >"$TMP/$mode.out" 2>&1
}

if ! run_case success --expected-pvc-uid claim-uid-1; then
  cat "$TMP/success.out" >&2
  cat "$TMP/success.log" >&2
  exit 1
fi
log="$TMP/success.log"
hcc_zero="$(grep -n 'scale deployment/host-context-controller --replicas=0' "$log" | head -1 | cut -d: -f1)"
hcc_wait="$(grep -n 'wait --for=delete pod -l app=host-context-controller' "$log" | cut -d: -f1)"
gfsc_zero="$(grep -n 'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0' "$log" | head -1 | cut -d: -f1)"
scrub="$(grep -n 'create -f -' "$log" | cut -d: -f1)"
pvc_delete="$(grep -n 'delete --raw /api/v1/namespaces/control-plane/persistentvolumeclaims/control-postgres-data' "$log" | cut -d: -f1)"
[[ "$hcc_zero" -lt "$hcc_wait" && "$hcc_wait" -lt "$gfsc_zero" && "$gfsc_zero" -lt "$scrub" && "$scrub" -lt "$pvc_delete" ]]
grep -q -- '--from-literal=hccReplicas=4' "$log"
grep -q -- '--from-literal=workflowReplicas=5' "$log"
grep -q -- '--from-literal=traceReplicas=6' "$log"
grep -q -- '--from-literal=writerReplicas=3' "$log"
grep -q -- '--from-literal=readerReplicas=2' "$log"
grep -q -- '--from-literal=controlApiReplicas=2' "$log"
grep -q 'find /reset-target -mindepth 1 -xdev -delete' "$TMP/success.manifest"
# The scrub-finalizer pin closes the mount-by-name reuse window: the original
# is pinned before the scrub pod exists and released only after the post-scrub
# UID recheck, immediately before the UID-preconditioned delete.
pin="$(grep -n 'patch pvc control-postgres-data' "$log" | head -1 | cut -d: -f1)"
unpin="$(grep -n 'patch pvc control-postgres-data' "$log" | tail -1 | cut -d: -f1)"
[[ -n "$pin" && -n "$unpin" && "$pin" != "$unpin" ]]
[[ "$pin" -lt "$scrub" && "$scrub" -lt "$unpin" && "$unpin" -lt "$pvc_delete" ]]

run_case resume --expected-pvc-uid claim-uid-1 --resume
! grep -q 'create configmap control-db-reset-state' "$TMP/resume.log"
grep -q 'delete --raw /api/v1/namespaces/control-plane/persistentvolumeclaims/control-postgres-data' "$TMP/resume.log"
# A crash can leave the fixed-name scrub pod behind; resume must remove any
# leftover BEFORE creating its own, or it would fail AlreadyExists forever.
leftover_cleanup="$(grep -n 'delete pod control-postgres-storage-reset' "$TMP/resume.log" | head -1 | cut -d: -f1)"
resume_scrub="$(grep -n 'create -f -' "$TMP/resume.log" | head -1 | cut -d: -f1)"
[[ -n "$leftover_cleanup" && -n "$resume_scrub" && "$leftover_cleanup" -lt "$resume_scrub" ]]

# A crash BETWEEN pin and unpin leaves the original still pinned. Resume must
# treat the present finalizer as an idempotent "already pinned" (no second pin
# patch), run the scrub, and issue exactly one pvc patch — the unpin — before
# the UID-preconditioned delete.
run_case resume-pinned --expected-pvc-uid claim-uid-1 --resume
[ "$(grep -c 'patch pvc control-postgres-data' "$TMP/resume-pinned.log")" -eq 1 ]
rp_scrub="$(grep -n 'create -f -' "$TMP/resume-pinned.log" | head -1 | cut -d: -f1)"
rp_unpin="$(grep -n 'patch pvc control-postgres-data' "$TMP/resume-pinned.log" | head -1 | cut -d: -f1)"
rp_delete="$(grep -n 'delete --raw /api/v1/namespaces/control-plane/persistentvolumeclaims/control-postgres-data' "$TMP/resume-pinned.log" | head -1 | cut -d: -f1)"
[[ -n "$rp_scrub" && -n "$rp_unpin" && -n "$rp_delete" ]]
[[ "$rp_scrub" -lt "$rp_unpin" && "$rp_unpin" -lt "$rp_delete" ]]
# The single patch really released the finalizer in the mock's tracked state.
[ ! -f "$TMP/resume-pinned.finalizer" ]

run_case resume-after-delete --expected-pvc-uid claim-uid-1 --resume
! grep -q 'create -f -' "$TMP/resume-after-delete.log"
grep -q 'scale deployment/host-context-controller --replicas=0' "$TMP/resume-after-delete.log"
! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/resume-after-delete.log"

for mode in resume-deleting-replacement resume-replacement-bound resume-converged; do
  run_case "$mode" --expected-pvc-uid claim-uid-1 --resume
  ! grep -q 'create -f -' "$TMP/$mode.log"
  ! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/$mode.log"
done
grep -q 'original-deleted' "$TMP/resume-deleting-replacement.state"
# A converged reset already restored the controllers; a stray resume must not
# quiesce the healthy stack, only point the operator back at convergence.
! grep -q 'scale deployment' "$TMP/resume-converged.log"
grep -q 'converge-control-db-after-reset.sh' "$TMP/resume-converged.out"

run_case uid-replaced-before-scrub --expected-pvc-uid claim-uid-1
! grep -q 'create -f -' "$TMP/uid-replaced-before-scrub.log"
! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/uid-replaced-before-scrub.log"
grep -q 'original-deleted' "$TMP/uid-replaced-before-scrub.state"

# A replacement that takes the name between the UID check and the finalizer
# pin is detected by the pin CAS itself: no scrub pod is created, nothing is
# deleted, and the reset still converges to original-deleted.
run_case pin-replaced --expected-pvc-uid claim-uid-1
! grep -q 'create -f -' "$TMP/pin-replaced.log"
! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/pin-replaced.log"
grep -q 'original-deleted' "$TMP/pin-replaced.state"

# A contended finalizer release retries against the live object and still
# completes the UID-preconditioned delete (1 pin + 2 unpin attempts).
run_case unpin-contention --expected-pvc-uid claim-uid-1
[ "$(grep -c 'patch pvc control-postgres-data' "$TMP/unpin-contention.log")" -eq 3 ]
grep -q 'create -f -' "$TMP/unpin-contention.log"
grep -q 'delete --raw /api/v1/namespaces/control-plane/persistentvolumeclaims/control-postgres-data' "$TMP/unpin-contention.log"

# A terminating original or a persistently failing pin must fail closed
# before any scrub pod exists and before anything is deleted.
for mode in pin-terminating pin-patch-fail; do
  if run_case "$mode" --expected-pvc-uid claim-uid-1; then
    echo "FAIL: $mode was accepted" >&2; exit 1
  fi
  ! grep -q 'create -f -' "$TMP/$mode.log"
  ! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/$mode.log"
done

for mode in missing-expectation uid-mismatch concurrent uid-replaced-before-delete state-create-fail state-cas-fail state-substitution; do
  args=("$mode")
  [ "$mode" = missing-expectation ] || args+=(--expected-pvc-uid claim-uid-1)
  [ "$mode" != state-substitution ] || args+=(--resume)
  if run_case "${args[@]}"; then
    echo "FAIL: $mode was accepted" >&2; exit 1
  fi
done
! grep -q 'scale deployment/host-context-controller' "$TMP/uid-mismatch.log"
! grep -q 'scale deployment/host-context-controller' "$TMP/concurrent.log"
! grep -q 'persistentvolumeclaims/control-postgres-data' "$TMP/uid-replaced-before-delete.log"
grep -q 'scale deployment/host-context-controller --replicas=0' "$TMP/uid-replaced-before-delete.log"
grep -q 'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0' "$TMP/uid-replaced-before-delete.log"
grep -q 'scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0' "$TMP/uid-replaced-before-delete.log"
grep -q 'scale deployment/host-context-controller --replicas=0' "$TMP/state-substitution.log"

run_case no-pvc --expect-no-pvc
! grep -q 'create -f -' "$TMP/no-pvc.log"
grep -q -- '--from-literal=originalPvcUid=none' "$TMP/no-pvc.log"

printf 'PASS: control DB reset is UID-bound, scrub-pinned, crash-resumable, and quiesces DB-dependent controllers\n'
