#!/usr/bin/env bash
# E2E Gate D (#549): SharedFilesystem security.
#
# D1 — hostile spec.directories are rejected by CRD validation at apply time
#      (no root initContainer ever runs them).
# D2 — retained-PVC reuse with a changed runAsUser corrects ownership WITHOUT
#      clobbering pre-existing files (sentinel/idempotent seeding).
# Single-node is sufficient.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

SFS_NS="${MCP_HOST_NS}"
D2_NAME="${D2_NAME:-e2e-sfs-reuse}"
D2_HASH=$(printf '%s' "${SFS_NS}/${D2_NAME}" | shasum -a 256 | cut -c1-10)
D2_WFC="wfc-${D2_HASH}"
D2_PVC="sfs-${D2_HASH}-files"

cleanup() {
  header "Cleanup"
  kctl delete sharedfilesystem "$D2_NAME" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete deployment "$D2_WFC" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete svc "$D2_WFC" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete pvc "$D2_PVC" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  kctl delete networkpolicy -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${D2_NAME}" --ignore-not-found 2>/dev/null || true
}
[[ "${1:-}" == "--cleanup-only" ]] && { cleanup; exit 0; }

check_prerequisites
cleanup
sleep 2

header "D1 — hostile spec.directories are rejected at admission"
i=0
for hostile in '../escape' '/etc/passwd' 'docs; rm -rf /workspace' '$(id)' 'a b'; do
  i=$((i + 1))
  if kctl apply --dry-run=server -f - >/dev/null 2>&1 <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: e2e-sfs-hostile-${i}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  accessModes: [ReadWriteOnce]
  directories: ["${hostile}"]
YAML
  then
    fail "Hostile directory accepted by admission: ${hostile}"
  else
    ok "Rejected hostile directory at admission: ${hostile}"
  fi
done

header "D2 — retained-PVC reuse corrects ownership without clobbering"
apply_d2() { # $1 = uid
  kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${D2_NAME}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  accessModes: [ReadWriteOnce]
  directories: [docs]
  retainOnDelete: true
  security: { runAsUser: $1, runAsGroup: $1, fsGroup: $1 }
YAML
}

apply_d2 1000
wait_for_deployment "$SFS_NS" "$D2_WFC" 120 || fail "wfc never became Available"
POD1=$(kctl get pods -n "$SFS_NS" -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${D2_NAME}" -o jsonpath='{.items[0].metadata.name}')
kctl exec -n "$SFS_NS" "$POD1" -- sh -c 'echo original > /workspace/docs/keep.txt' 2>/dev/null \
  && ok "Wrote keep.txt as uid 1000" || fail "could not write keep.txt"

# Delete SFS (PVC retained), then recreate with a NEW uid.
kctl delete sharedfilesystem "$D2_NAME" -n "$SFS_NS" --ignore-not-found >/dev/null 2>&1 || true
kctl delete deployment "$D2_WFC" -n "$SFS_NS" --ignore-not-found >/dev/null 2>&1 || true
# Wait for the old wfc pod to fully terminate (releases the RWO mount) before the
# new uid=2000 pod re-attaches — otherwise it wedges in ContainerCreating on RWO.
for _ in $(seq 1 30); do
  [ "$(kctl get pods -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${D2_NAME}" --no-headers 2>/dev/null | wc -l | tr -d ' ')" = "0" ] && break
  sleep 2
done
kctl get pvc "$D2_PVC" -n "$SFS_NS" >/dev/null 2>&1 \
  && ok "PVC retained across delete (retainOnDelete=true)" || fail "PVC was not retained"

apply_d2 2000
wait_for_deployment "$SFS_NS" "$D2_WFC" 120 || fail "wfc never became Available"
POD2=$(kctl get pods -n "$SFS_NS" -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${D2_NAME}" -o jsonpath='{.items[0].metadata.name}')
OWNER=$(kctl exec -n "$SFS_NS" "$POD2" -- sh -c 'stat -c %u /workspace/docs' 2>/dev/null || echo "?")
if [ "$OWNER" = "2000" ]; then ok "Ownership corrected to new uid 2000"; else fail "ownership not corrected (got uid=${OWNER})"; fi
CONTENT=$(kctl exec -n "$SFS_NS" "$POD2" -- sh -c 'cat /workspace/docs/keep.txt' 2>/dev/null || echo "")
if [ "$CONTENT" = "original" ]; then ok "Pre-existing keep.txt preserved (no clobber)"; else fail "keep.txt clobbered (got: '${CONTENT}')"; fi

cleanup || true
print_results
