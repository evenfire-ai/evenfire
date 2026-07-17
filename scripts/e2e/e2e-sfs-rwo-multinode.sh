#!/usr/bin/env bash
# E2E Gate A (#549, THE TEETH): RWO SharedFilesystem on a MULTI-NODE cluster.
#
# This is the regression guard for the cross-node RWO Multi-Attach deadlock.
# On OLD code the standalone wfc-init Job could schedule on a different node
# than the controller and wedge in ContainerCreating forever. With the fix,
# seeding is the controller's initContainer (same pod => same node => same RWO
# mount), so there is exactly ONE pod and no second mounter to wedge.
#
# REQUIRES >= 2 schedulable nodes (run on a multi-node minikube profile:
#   MINIKUBE_MULTI_NODE=true MINIKUBE_NODES=2 make minikube-start ...).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

SFS_NAME="${SFS_NAME:-e2e-sfs-rwo-mn}"
SFS_NS="${MCP_HOST_NS}"
SFS_HASH=$(printf '%s' "${SFS_NS}/${SFS_NAME}" | shasum -a 256 | cut -c1-10)
WFC_NAME="wfc-${SFS_HASH}"
PVC_NAME="sfs-${SFS_HASH}-files"

cleanup() {
  header "Cleanup"
  kctl delete sharedfilesystem "$SFS_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc "$PVC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete job -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" --ignore-not-found 2>/dev/null || true
}
[[ "${1:-}" == "--cleanup-only" ]] && { cleanup; exit 0; }

check_prerequisites

header "Phase 0 — Require >= 2 schedulable nodes"
NODE_COUNT=$(kctl get nodes --no-headers 2>/dev/null | grep -c ' Ready ' || true)
if [ "${NODE_COUNT:-0}" -lt 2 ]; then
  fail "Need >= 2 Ready nodes for the multi-node RWO gate (found ${NODE_COUNT}). Start a multi-node profile."
  print_results
  exit 1
fi
ok "${NODE_COUNT} Ready nodes — multi-node scheduling is in play"

cleanup
sleep 3

header "Phase 1 — Apply an RWO SharedFilesystem"
kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${SFS_NAME}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  accessModes: [ReadWriteOnce]
  directories: [docs, runbooks]
  retainOnDelete: false
YAML
ok "RWO SharedFilesystem applied"

header "Phase 2 — Controller becomes Available (no Multi-Attach wedge)"
wait_for_deployment "$SFS_NS" "$WFC_NAME" 180 || fail "controller never became Available (RWO Multi-Attach wedge?)"

header "Phase 3 — Exactly ONE pod; ZERO standalone wfc-init pods/jobs"
PODS=$(kctl get pods -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" --no-headers 2>/dev/null | wc -l | tr -d ' ')
INIT_PODS=$(kctl get pods -n "$SFS_NS" --no-headers 2>/dev/null | grep -c "wfc-init-${SFS_HASH}" || true)
INIT_JOBS=$(kctl get jobs -n "$SFS_NS" --no-headers 2>/dev/null | grep -c "wfc-init-${SFS_HASH}" || true)
[ "$PODS" = "1" ] && ok "Exactly one controller pod for the SFS" || fail "expected 1 pod, got ${PODS}"
[ "${INIT_PODS:-0}" = "0" ] && ok "Zero standalone wfc-init pods" || fail "found ${INIT_PODS} wfc-init pods (the bug)"
[ "${INIT_JOBS:-0}" = "0" ] && ok "Zero standalone wfc-init Jobs" || fail "found ${INIT_JOBS} wfc-init Jobs (the bug)"

header "Phase 4 — initContainer completed; no Multi-Attach / ContainerCreating wedge"
WFC_POD=$(kctl get pods -n "$SFS_NS" -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${SFS_NAME}" -o jsonpath='{.items[0].metadata.name}')
REASON=$(kctl get pod "$WFC_POD" -n "$SFS_NS" -o jsonpath='{.status.initContainerStatuses[0].state.terminated.reason}' 2>/dev/null || echo "")
[ "$REASON" = "Completed" ] && ok "initContainer terminated Completed" || fail "initContainer not Completed (got '${REASON}')"
if kctl get events -n "$SFS_NS" --field-selector reason=FailedAttachVolume 2>/dev/null | grep -q "$PVC_NAME"; then
  fail "FailedAttachVolume / Multi-Attach event present for ${PVC_NAME}"
else
  ok "No FailedAttachVolume / Multi-Attach events for the PVC"
fi

header "Phase 5 — SFS Ready + seeded dirs are read/write"
phase=""
for _ in $(seq 1 30); do
  phase=$(kctl get sharedfilesystem "$SFS_NAME" -n "$SFS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  [ "$phase" = "Ready" ] && break; sleep 2
done
[ "$phase" = "Ready" ] && ok "SFS status.phase == Ready" || fail "SFS phase='${phase}' (expected Ready)"
if kctl exec -n "$SFS_NS" "$WFC_POD" -- sh -c \
  'test -d /workspace/docs && test -d /workspace/runbooks && echo ok > /workspace/docs/p.txt && cat /workspace/docs/p.txt' 2>/dev/null | grep -q ok; then
  ok "Seeded dirs exist and the PVC is writable"
else
  fail "seeded dirs missing or PVC not writable"
fi

cleanup || true
print_results
