#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
LOG="$TMP/calls.log"

cat >"$TMP/bin/kubectl" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'kubectl %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  *'get configmap control-db-reset-state -o jsonpath={.metadata.uid} --ignore-not-found'*)
    [ -s "$FAKE_STATE" ] && cut -d'|' -f1 "$FAKE_STATE"
    ;;
  *'get configmap control-db-reset-state'*) [ -s "$FAKE_STATE" ] && cat "$FAKE_STATE" ;;
  *'get pvc control-postgres-data'*) printf '%s' "${FAKE_PVC_UID:-replacement-uid}" ;;
  *'patch configmap control-db-reset-state'*)
    [ "${FAIL_CAS:-false}" != true ] || exit 1
    IFS='|' read -r state_uid rv version phase original replacement hcc workflow trace writer reader <"$FAKE_STATE"
    payload=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -p ]; then shift; payload="$1"; break; fi
      shift
    done
    next_phase="$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(next(x["value"] for x in p if x["op"]=="replace" and x["path"]=="/data/phase"))' "$payload")"
    next_replacement="$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(next(x["value"] for x in p if x["op"]=="replace" and x["path"]=="/data/replacementPvcUid"))' "$payload")"
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$state_uid" "$((rv + 1))" "$version" "$next_phase" "$original" "$next_replacement" "$hcc" "$workflow" "$trace" "$writer" "$reader" >"$FAKE_STATE"
    ;;
  *'scale deployment/host-context-controller --replicas=0') exit 0 ;;
  *'get pods -l app=host-context-controller -o name') printf 'pod/hcc-old\n' ;;
  *'wait --for=delete pod -l app=host-context-controller --timeout=180s') exit 0 ;;
  *'get pods -l app=gfs-controller -o name') printf 'pod/gfsc-writer-old\n' ;;
  *'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0') exit 0 ;;
  *'scale deployment/gfsc-writer --replicas=3') exit 0 ;;
  *'scale deployment/gfsc-reader --replicas=2') exit 0 ;;
  *'scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0') exit 0 ;;
  *'scale deployment/workflow-recipes --replicas=5') exit 0 ;;
  *'scale deployment/trace-maintenance-worker --replicas=6') exit 0 ;;
  *'wait --for=delete pod -l app=gfs-controller --timeout=180s') exit 0 ;;
  *'rollout status deployment/control-api --timeout=180s') exit 0 ;;
  *'rollout status deployment/gfsc-writer --timeout=180s') exit 0 ;;
  *'rollout status deployment/gfsc-reader --timeout=180s') exit 0 ;;
  *'rollout status deployment/workflow-recipes --timeout=180s') exit 0 ;;
  *'rollout status deployment/trace-maintenance-worker --timeout=180s') exit 0 ;;
  *'scale deployment/host-context-controller --replicas=4') exit 0 ;;
  *'rollout status deployment/host-context-controller --timeout=480s') exit 0 ;;
  *'get pods -l app=workflow-recipes -o name') printf 'pod/workflow-old\n' ;;
  *'get pods -l app=trace-maintenance-worker -o name') printf 'pod/trace-old\n' ;;
  *'wait --for=delete pod -l app=workflow-recipes --timeout=180s') exit 0 ;;
  *'wait --for=delete pod -l app=trace-maintenance-worker --timeout=180s') exit 0 ;;
  *'delete --raw /api/v1/namespaces/control-plane/configmaps/control-db-reset-state'*)
    cat >/dev/null
    [ "${FAIL_STATE_DELETE:-false}" != true ] || exit 1
    rm -f "$FAKE_STATE"
    ;;
  *'scale deployment/control-api --replicas=2') exit 0 ;;
  *) printf 'unexpected kubectl call: %s\n' "$*" >&2; exit 1 ;;
esac
EOF

cat >"$TMP/bin/bash" <<'EOF'
#!/bin/sh
printf 'bash %s\n' "$*" >>"$FAKE_LOG"
case "$*" in
  *reconcile-gfs-deploy-credentials.sh*) [ "${FAIL_RECONCILE:-false}" != true ] ;;
  *scripts/minikube/verify-gfs.sh*) [ "${FAIL_VERIFY:-false}" != true ] ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TMP/bin/kubectl" "$TMP/bin/bash"

run_converge() {
  PATH="$TMP/bin:$PATH" FAKE_LOG="$LOG" FAKE_STATE="$TMP/state" CONTEXT=test-context "$@" \
    /bin/bash "$ROOT/deploy/scripts/converge-control-db-after-reset.sh" --overlay fake-overlay
}

init_state() {
  local phase="${1:-original-deleted}" replacement="${2:-unbound}"
  printf 'state-uid|1|1|%s|claim-uid-1|%s|4|5|6|3|2|2\n' \
    "$phase" "$replacement" >"$TMP/state"
}

: >"$LOG"
init_state
if ! run_converge >"$TMP/success.out" 2>&1; then
  cat "$TMP/success.out" >&2
  cat "$LOG" >&2
  printf 'FAIL: successful convergence fixture failed\n' >&2
  exit 1
fi
writer_zero="$(grep -n 'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0' "$LOG" | head -1 | cut -d: -f1)"
hcc_zero="$(grep -n 'scale deployment/host-context-controller --replicas=0' "$LOG" | head -1 | cut -d: -f1)"
hcc_wait="$(grep -n 'wait --for=delete pod -l app=host-context-controller' "$LOG" | cut -d: -f1)"
migration="$(grep -n 'run-control-api-db-migration.sh' "$LOG" | head -1 | cut -d: -f1)"
restore_writer="$(grep -n 'scale deployment/gfsc-writer --replicas=3' "$LOG" | cut -d: -f1)"
restore_reader="$(grep -n 'scale deployment/gfsc-reader --replicas=2' "$LOG" | cut -d: -f1)"
reconcile="$(grep -n 'reconcile-gfs-deploy-credentials.sh' "$LOG" | cut -d: -f1)"
hcc_restore="$(grep -n 'scale deployment/host-context-controller --replicas=4' "$LOG" | cut -d: -f1)"
gfs_verify="$(grep -n 'scripts/minikube/verify-gfs.sh' "$LOG" | cut -d: -f1)"
workflow_restore="$(grep -n 'scale deployment/workflow-recipes --replicas=5' "$LOG" | cut -d: -f1)"
trace_restore="$(grep -n 'scale deployment/trace-maintenance-worker --replicas=6' "$LOG" | cut -d: -f1)"
state_delete="$(grep -n 'delete --raw /api/v1/namespaces/control-plane/configmaps/control-db-reset-state' "$LOG" | cut -d: -f1)"
[[ "$hcc_zero" -lt "$hcc_wait" && "$hcc_wait" -lt "$writer_zero" && "$writer_zero" -lt "$migration" && \
   "$reconcile" -lt "$restore_writer" && "$reconcile" -lt "$restore_reader" && \
   "$gfs_verify" -lt "$workflow_restore" && "$gfs_verify" -lt "$trace_restore" && \
   "$workflow_restore" -lt "$hcc_restore" && "$hcc_restore" -lt "$state_delete" ]] \
  || { printf 'FAIL: GFSC isolation/restore order is wrong\n' >&2; exit 1; }
grep -q 'wait --for=delete pod -l app=gfs-controller' "$LOG" \
  || { printf 'FAIL: GFSC pod termination was not awaited\n' >&2; exit 1; }

: >"$LOG"
init_state
if run_converge env FAIL_RECONCILE=true >/dev/null 2>&1; then
  printf 'FAIL: failed reconciliation was reported as success\n' >&2
  exit 1
fi
[[ "$(grep -c 'scale deployment/gfsc-writer deployment/gfsc-reader --replicas=0' "$LOG")" -eq 2 ]] \
  || { printf 'FAIL: failure did not reassert the zero-replica state\n' >&2; exit 1; }
! grep -q 'scale deployment/gfsc-writer --replicas=3' "$LOG" \
  || { printf 'FAIL: writer replicas were restored after failure\n' >&2; exit 1; }
! grep -q 'scale deployment/gfsc-reader --replicas=2' "$LOG" \
  || { printf 'FAIL: reader replicas were restored after failure\n' >&2; exit 1; }
! grep -q 'scale deployment/host-context-controller --replicas=4' "$LOG" \
  || { printf 'FAIL: HCC was restored after failure\n' >&2; exit 1; }

: >"$LOG"
init_state
if run_converge env FAIL_VERIFY=true >/dev/null 2>&1; then
  printf 'FAIL: failed GFS verification was reported as success\n' >&2
  exit 1
fi
! grep -q 'scale deployment/host-context-controller --replicas=4' "$LOG" \
  || { printf 'FAIL: HCC was restored before successful GFS verification\n' >&2; exit 1; }

: >"$LOG"
init_state
if run_converge env FAIL_STATE_DELETE=true >/dev/null 2>&1; then
  printf 'FAIL: reset-state deletion failure was reported as success\n' >&2
  exit 1
fi
grep -q '|converged|' "$TMP/state" \
  || { printf 'FAIL: cleanup failure did not preserve completed phase\n' >&2; exit 1; }
[[ "$(grep -c 'scale deployment/host-context-controller --replicas=0' "$LOG")" -eq 1 ]] \
  || { printf 'FAIL: cleanup-only failure incorrectly requiesced verified workloads\n' >&2; exit 1; }

: >"$LOG"
if ! run_converge >/dev/null 2>&1; then
  printf 'FAIL: converged-state cleanup resume failed\n' >&2; exit 1
fi
! grep -q 'run-control-api-db-migration.sh' "$LOG" \
  || { printf 'FAIL: cleanup resume reran migrations\n' >&2; exit 1; }
! grep -q 'reconcile-gfs-deploy-credentials.sh' "$LOG" \
  || { printf 'FAIL: cleanup resume reconciled credentials\n' >&2; exit 1; }
[ ! -e "$TMP/state" ] || { printf 'FAIL: cleanup resume left recovery state\n' >&2; exit 1; }

: >"$LOG"
init_state replacement-bound replacement-uid
if run_converge env FAKE_PVC_UID=substituted-uid >/dev/null 2>&1; then
  printf 'FAIL: replacement UID substitution was accepted\n' >&2; exit 1
fi
grep -q 'scale deployment/workflow-recipes deployment/trace-maintenance-worker --replicas=0' "$LOG" \
  || { printf 'FAIL: UID ambiguity did not keep DB workers fail-closed\n' >&2; exit 1; }

printf 'PASS: post-reset convergence isolates DB-dependent controllers and preserves replica counts\n'
