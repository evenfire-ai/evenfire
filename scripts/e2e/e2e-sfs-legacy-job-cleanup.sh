#!/usr/bin/env bash
# E2E Gate B (#549): legacy wfc-init Job cleanup.
#
# Proves the reconciler reaps obsolete standalone `wfc-init-<hash>-*` Jobs left
# over from before seeding moved into the controller's initContainer, WITHOUT
# disturbing the live controller pod. Single-node is sufficient.
#
# Fails on OLD code (no cleanupLegacyInitJobs); passes on the fix.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

SFS_NAME="${SFS_NAME:-e2e-sfs-cleanup}"
SFS_NS="${MCP_HOST_NS}"
SFS_HASH=$(printf '%s' "${SFS_NS}/${SFS_NAME}" | shasum -a 256 | cut -c1-10)
WFC_NAME="wfc-${SFS_HASH}"
PVC_NAME="sfs-${SFS_HASH}-files"
LEGACY_JOB="wfc-init-${SFS_HASH}-e2elegacy"

cleanup() {
  header "Cleanup"
  kctl delete sharedfilesystem "$SFS_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete job "$LEGACY_JOB" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$WFC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc "$PVC_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete job -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${SFS_NAME}" --ignore-not-found 2>/dev/null || true
}
[[ "${1:-}" == "--cleanup-only" ]] && { cleanup; exit 0; }

check_prerequisites
cleanup
sleep 3

header "Phase 1 — Apply RWO SharedFilesystem and reach Ready"
kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${SFS_NAME}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  accessModes: [ReadWriteOnce]
  directories: [docs]
  retainOnDelete: false
YAML
wait_for_deployment "$SFS_NS" "$WFC_NAME" 120 || fail "controller never became Available (RWO Multi-Attach wedge?)"
WFC_POD=$(kctl get pods -n "$SFS_NS" -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${SFS_NAME}" -o jsonpath='{.items[0].metadata.name}')
WFC_UID_BEFORE=$(kctl get pod "$WFC_POD" -n "$SFS_NS" -o jsonpath='{.metadata.uid}')
ok "Controller pod ${WFC_POD} Ready"

header "Phase 2 — Plant a wedged legacy wfc-init Job (labeled + name-prefixed)"
kctl apply -f - <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${LEGACY_JOB}
  namespace: ${SFS_NS}
  labels: { clerum.io/sharedfilesystem: ${SFS_NAME}, clerum.io/sharedfilesystem-namespace: ${SFS_NS} }
spec:
  backoffLimit: 0
  template:
    metadata: { labels: { clerum.io/sharedfilesystem: ${SFS_NAME}, clerum.io/sharedfilesystem-namespace: ${SFS_NS} } }
    spec:
      restartPolicy: Never
      containers:
        - name: legacy
          image: busybox:1.36
          command: ["sh","-c","sleep 600"]
YAML
kctl get job "$LEGACY_JOB" -n "$SFS_NS" >/dev/null && ok "Legacy Job planted"

header "Phase 3 — Trigger a reconcile and assert the legacy Job is reaped"
# Bump an annotation so HCC reconciles this SFS.
kctl annotate sharedfilesystem "$SFS_NAME" -n "$SFS_NS" \
  "clerum.io/e2e-poke=$(date +%s)" --overwrite >/dev/null
reaped=false
for _ in $(seq 1 45); do
  if ! kctl get job "$LEGACY_JOB" -n "$SFS_NS" &>/dev/null; then reaped=true; break; fi
  sleep 2
done
if $reaped; then ok "Legacy wfc-init Job was deleted by cleanupLegacyInitJobs"; else fail "Legacy wfc-init Job still present after 90s"; fi

header "Phase 4 — Controller pod is undisturbed"
WFC_UID_AFTER=$(kctl get pod "$WFC_POD" -n "$SFS_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || echo "GONE")
if [ "$WFC_UID_AFTER" = "$WFC_UID_BEFORE" ]; then ok "Controller pod UID unchanged (no collateral restart)"; else fail "Controller pod changed (${WFC_UID_BEFORE} -> ${WFC_UID_AFTER})"; fi

cleanup || true
print_results
