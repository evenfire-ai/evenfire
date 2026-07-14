#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Gate (#592, THE TEETH): SharedFileSystem RWO default + truthful status
#                            + wfc↔mcp-host co-location on a MULTI-NODE cluster.
# ═══════════════════════════════════════════════════════════════════════
#
# This is the durable regression guard for issue #592. Before the fix the CRD
# defaulted its PVC to ReadWriteMany (RWX) — which never provisions on our
# RWO-only StorageClasses — AND the reconciler reported `phase: Ready` anyway
# (the "status lie"). On single-node clusters the unbound PVC even jammed the
# scheduler's VolumeBinding for unrelated pods.
#
# This gate proves, end to end, on a real ≥2-node cluster:
#   P1  default (no accessModes) SFS provisions RWO and reports a TRUTHFUL Ready
#   P2  a Host that mounts the SFS is CO-LOCATED with the SFS's wfc pod (podAffinity)
#   P3  a wedged SFS (PVC that cannot bind) reports Degraded/PVCUnbound — NOT Ready
#   P4  a referenced-but-not-Ready SFS is GATED: the mcp-host comes up WITHOUT the
#       mount and is NOT stuck Pending (the fix's "come up normally" behaviour)
#   P5  once the misconfiguration is corrected the status CONVERGES to Ready
#       (the sfsResyncTimer re-evaluates — no manual status hack)
#   P6  anti-co-location: when the wfc node is cordoned the required podAffinity
#       fails LOUDLY (mcp-host Unschedulable), and recovers when uncordoned
#   P7  mount RESILIENCE: a Ready+mounted SFS whose wfc is wedged (durably, via
#       node cordon) keeps its PVC Bound, so the consuming mcp-host RETAINS its RO
#       mount and is NOT rolled — the mount is to the PVC, not the wfc. Recovers
#       cleanly on uncordon. (Regression guard for the mount-thrash anti-pattern.)
#
# REQUIRES ≥2 schedulable nodes AND an HCC image built from THIS branch
# (the assessReadiness + sfsResyncTimer + podAffinity code). Run on a fresh
# generated multi-node profile, e.g.:
#   MINIKUBE_PROFILE=clerum-codex-rwo-<sha> MINIKUBE_MULTI_NODE=true \
#     MINIKUBE_NODES=2 make minikube-start
#   ... deploy this branch ...
#   KUBECONTEXT=clerum-codex-rwo-<sha> bash scripts/e2e/e2e-sharedfilesystem-rwo.sh
#
# Fail-loud / fail-fast: every check is a hard assertion; on timeout we dump the
# pod/PVC/SFS state and FAIL. Nothing is skipped silently and no mock substitutes
# for the real cluster behaviour.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"

# ─── Names / derived identifiers ─────────────────────────────────────────
SFS_OK="${SFS_OK:-e2e-sfs592-ok}"     # healthy default-RWO SFS (P1, P2, P6)
SFS_BAD="${SFS_BAD:-e2e-sfs592-bad}"  # unbindable SFS (P3, P4, P5)
SFS_NS="${MCP_HOST_NS}"               # SFS + wfc + mcp-host all live here
CTX="${CONTEXT_NAME}"                 # context1
CTX_NS="${RECIPE_NS}"                 # mcp-server (where Contexts live)
BAD_SC="${BAD_SC:-e2e-sfs592-nonexistent-sc}"  # a StorageClass that does not exist

sfs_hash() { printf '%s' "${SFS_NS}/$1" | shasum -a 256 | cut -c1-10; }
OK_HASH="$(sfs_hash "$SFS_OK")"
BAD_HASH="$(sfs_hash "$SFS_BAD")"
WFC_OK="wfc-${OK_HASH}"
WFC_BAD="wfc-${BAD_HASH}"
PVC_OK="sfs-${OK_HASH}-files"
PVC_BAD="sfs-${BAD_HASH}-files"
MOUNT_OK="/context-files/${SFS_OK}"
MOUNT_BAD="/context-files/${SFS_BAD}"

# mcp-host Deployment name (chatllm in minikube). Detected by e2e-lib.
MCP_HOST_DEPLOY=""

# ─── Helpers ─────────────────────────────────────────────────────────────

# Current Running, non-terminating pod of the mcp-host Deployment.
mcp_host_pod() {
  kctl get pods -n "$SFS_NS" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null \
    | awk -F'\t' -v p="^${MCP_HOST_DEPLOY}-" '$1 ~ p && $2=="" {print $1; exit}'
}

# A Running, non-terminating mcp-host pod that already carries volume $1.
# (The Context→Host re-reconcile that injects an SFS mount is async + rolls the
# Deployment, so we must poll for the NEW pod that actually has the mount rather
# than read whichever pod is currently Running.)
host_pod_with_volume() {
  local vol=$1
  kctl get pods -n "$SFS_NS" --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\t"}{range .spec.volumes[*]}{.name}{","}{end}{"\n"}{end}' \
    2>/dev/null \
    | awk -F'\t' -v p="^${MCP_HOST_DEPLOY}-" -v v="${vol}," \
        '$1 ~ p && $2=="" && index($3, v){print $1; exit}'
}

wait_for_host_pod_volume() {  # wait_for_host_pod_volume <volumeName> <timeout>
  local vol=$1 timeout=$2 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    [ -n "$(host_pod_with_volume "$vol")" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# Is a SPECIFIC pod $1 still present, Running, non-terminating, and carrying
# volume $2? Used to prove mount RETENTION: the same consumer pod must keep its
# RO mount across a wfc outage (it is NOT rolled, IgnoredDuringExecution + a
# stable mount set), rather than being torn down and re-created.
pod_running_with_volume() {  # <podName> <volumeName>
  kctl get pod "$1" -n "$SFS_NS" \
    -o jsonpath='{.status.phase}{"\t"}{.metadata.deletionTimestamp}{"\t"}{range .spec.volumes[*]}{.name}{","}{end}' \
    2>/dev/null \
    | awk -F'\t' -v v="$2," '$1=="Running" && $2=="" && index($3, v){print "yes"; exit}'
}

# Node hosting the wfc pod of a given SFS (the podAffinity target).
wfc_node_of() {  # wfc_node_of <sfsName>
  kctl get pods -n "$SFS_NS" \
    -l "app=workspace-files-controller,clerum.io/sharedfilesystem=$1" \
    -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || echo ""
}

sfs_phase() { kctl get sharedfilesystem "$1" -n "$SFS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo ""; }

# Wait until an SFS reaches a target phase (returns 0) or timeout (returns 1).
wait_for_sfs_phase() {
  local name=$1 want=$2 timeout=$3 elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase="$(sfs_phase "$name")"
    [ "$phase" = "$want" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# Wait until an SFS LEAVES Ready (any non-Ready phase, incl. empty) or timeout.
wait_for_sfs_phase_not_ready() {
  local name=$1 timeout=$2 elapsed=0 phase=""
  while [ "$elapsed" -lt "$timeout" ]; do
    phase="$(sfs_phase "$name")"
    [ "$phase" != "Ready" ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# Wait until the mcp-host Deployment has rolled to a generation that is fully
# available again (observedGeneration caught up AND updatedReplicas ready).
wait_for_mcp_host_rollout() {
  local timeout=$1 elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local desired updated avail
    desired=$(kctl get deploy "$MCP_HOST_DEPLOY" -n "$SFS_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)
    updated=$(kctl get deploy "$MCP_HOST_DEPLOY" -n "$SFS_NS" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null || echo 0)
    avail=$(kctl get deploy "$MCP_HOST_DEPLOY" -n "$SFS_NS" -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo 0)
    if [ "${updated:-0}" -ge "${desired:-1}" ] && [ "${avail:-0}" -ge "${desired:-1}" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

context_set_sfs() {  # context_set_sfs <sfsName> <mountPath>
  kctl patch context "$CTX" -n "$CTX_NS" --type=merge \
    -p "{\"spec\":{\"sharedFileSystems\":[{\"name\":\"$1\",\"mountPath\":\"$2\"}]}}" >/dev/null
}

context_clear_sfs() {
  kctl patch context "$CTX" -n "$CTX_NS" --type=json \
    -p '[{"op":"remove","path":"/spec/sharedFileSystems"}]' >/dev/null 2>&1 || true
}

uncordon_all() {
  kctl get nodes -o name 2>/dev/null | sed 's#^node/##' | while read -r n; do
    [ -n "$n" ] && kctl uncordon "$n" >/dev/null 2>&1 || true
  done
}

# Cordon EVERY node so a (re)scheduling pod has nowhere to land — used to hold the
# wfc Unschedulable DURABLY regardless of whether the hostpath PV is node-pinned
# (minikube hostpath is not). Already-running pods are NOT evicted by a cordon.
# Returns non-zero (fail-loud) if any node could not be cordoned.
cordon_all() {
  local rc=0 n
  for n in $(kctl get nodes -o name 2>/dev/null | sed 's#^node/##'); do
    [ -n "$n" ] || continue
    kctl cordon "$n" >/dev/null 2>&1 || rc=1
  done
  return "$rc"
}

dump_sfs() {  # diagnostics on failure (fail-loud, not fail-silent)
  local name=$1
  kctl get sharedfilesystem "$name" -n "$SFS_NS" -o yaml 2>/dev/null | sed -n '1,60p' || true
  kctl get pvc -n "$SFS_NS" 2>/dev/null | grep -E "sfs-|NAME" || true
  kctl get pods -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${name}" 2>/dev/null || true
  kctl describe pods -n "$SFS_NS" -l "clerum.io/sharedfilesystem=${name}" 2>/dev/null | tail -25 || true
}

cleanup() {
  header "Cleanup"
  context_clear_sfs
  uncordon_all
  local s w p
  for s in "$SFS_OK" "$SFS_BAD"; do
    kctl delete sharedfilesystem "$s" -n "$SFS_NS" --ignore-not-found --wait=false 2>/dev/null || true
  done
  for w in "$WFC_OK" "$WFC_BAD"; do
    kctl delete deployment "$w" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
    kctl delete svc "$w" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  done
  for p in "$PVC_OK" "$PVC_BAD"; do
    kctl delete pvc "$p" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
  done
  # Let the mcp-host Deployment settle back to the un-mounted template.
  log "Cleanup complete (context '${CTX}' restored, nodes uncordoned)"
}
trap 'uncordon_all' EXIT
[[ "${1:-}" == "--cleanup-only" ]] && { cleanup; exit 0; }

# ═══════════════════════════════════════════════════════════════════════
check_prerequisites
MCP_HOST_DEPLOY="$(_detect_mcp_host_deploy)"
if [ -z "$MCP_HOST_DEPLOY" ]; then
  fail "Cannot resolve the mcp-host Deployment (tried mcp-host, chatllm) — co-location phases need it"
  print_results
  exit 1
fi
log "mcp-host Deployment under test: ${MCP_HOST_DEPLOY}"

header "Phase 0 — Require ≥2 schedulable nodes"
NODE_COUNT=$(kctl get nodes --no-headers 2>/dev/null | grep -c ' Ready ' || true)
if [ "${NODE_COUNT:-0}" -lt 2 ]; then
  fail "Need ≥2 Ready nodes for the multi-node RWO co-location gate (found ${NODE_COUNT}). Start a multi-node profile."
  print_results
  exit 1
fi
ok "${NODE_COUNT} Ready nodes — cross-node scheduling is in play"

cleanup
sleep 3

# ───────────────────────────────────────────────────────────────────────
header "Phase 1 — Default SFS provisions RWO and reports a TRUTHFUL Ready"
kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${SFS_OK}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  directories: [docs]
  retainOnDelete: false
YAML
ok "SFS '${SFS_OK}' applied WITHOUT accessModes (exercises the RWO default)"

# The default must be ReadWriteOnce (#592) — assert on the PVC the controller built.
if wait_for_deployment "$SFS_NS" "$WFC_OK" 180; then
  ok "wfc Deployment '${WFC_OK}' became Available"
else
  fail "wfc '${WFC_OK}' never became Available"; dump_sfs "$SFS_OK"
fi
PVC_MODES=$(kctl get pvc "$PVC_OK" -n "$SFS_NS" -o jsonpath='{.spec.accessModes[0]}' 2>/dev/null || echo "")
[ "$PVC_MODES" = "ReadWriteOnce" ] && ok "PVC accessMode defaulted to ReadWriteOnce" \
  || fail "PVC accessMode='${PVC_MODES}' (expected ReadWriteOnce — RWO default regression)"

if wait_for_sfs_phase "$SFS_OK" "Ready" 120; then
  ok "SFS '${SFS_OK}' status.phase == Ready (truthful — PVC is actually Bound)"
else
  fail "SFS '${SFS_OK}' never reported Ready (phase='$(sfs_phase "$SFS_OK")')"; dump_sfs "$SFS_OK"
fi
PVC_PHASE=$(kctl get pvc "$PVC_OK" -n "$SFS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
[ "$PVC_PHASE" = "Bound" ] && ok "PVC '${PVC_OK}' is Bound (Ready is not a lie)" \
  || fail "PVC '${PVC_OK}' phase='${PVC_PHASE}' yet SFS claims Ready"

# ───────────────────────────────────────────────────────────────────────
header "Phase 2 — A Host that mounts the SFS is CO-LOCATED with its wfc pod"
WFC_NODE="$(wfc_node_of "$SFS_OK")"
[ -n "$WFC_NODE" ] && ok "wfc pod is scheduled on node '${WFC_NODE}'" \
  || fail "could not read wfc pod nodeName"

log "Patching Context '${CTX}' to mount '${SFS_OK}' at ${MOUNT_OK} (HCC re-reconciles ${MCP_HOST_DEPLOY} asynchronously)..."
context_set_sfs "$SFS_OK" "$MOUNT_OK"
# The Context→Host re-reconcile + rolling update is async: poll until a Running
# pod actually carries the injected mount, rather than reading the stale pod.
if wait_for_host_pod_volume "ctxfs-${OK_HASH}" 240; then
  ok "ctxfs-${OK_HASH} volume injected into ${MCP_HOST_DEPLOY} after the Context update"
else
  fail "mount ctxfs-${OK_HASH} never appeared in ${MCP_HOST_DEPLOY} after referencing a Ready SFS"
  kctl get pods -n "$SFS_NS" 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
fi

HOST_POD="$(host_pod_with_volume "ctxfs-${OK_HASH}")"
if [ -z "$HOST_POD" ]; then
  fail "no Running ${MCP_HOST_DEPLOY} pod with the SFS mount found"
else
  AFF=$(kctl get pod "$HOST_POD" -n "$SFS_NS" \
    -o jsonpath='{range .spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution[*]}{.labelSelector.matchLabels.clerum\.io/sharedfilesystem}{" "}{.topologyKey}{"\n"}{end}' 2>/dev/null || echo "")
  if printf "%s" "$AFF" | grep -q "${SFS_OK} kubernetes.io/hostname"; then
    ok "${MCP_HOST_DEPLOY} pod carries a required podAffinity term to wfc(${SFS_OK}) on topology hostname"
  else
    fail "${MCP_HOST_DEPLOY} pod missing the required podAffinity term for '${SFS_OK}' (got: ${AFF})"
  fi
  HOST_NODE=$(kctl get pod "$HOST_POD" -n "$SFS_NS" -o jsonpath='{.spec.nodeName}' 2>/dev/null || echo "")
  WFC_NODE="$(wfc_node_of "$SFS_OK")"  # re-read in case the wfc pod moved during the roll
  if [ -n "$HOST_NODE" ] && [ "$HOST_NODE" = "$WFC_NODE" ]; then
    ok "CO-LOCATION proven: ${MCP_HOST_DEPLOY} (node '${HOST_NODE}') == wfc (node '${WFC_NODE}')"
  else
    fail "co-location FAILED: ${MCP_HOST_DEPLOY} on '${HOST_NODE}' vs wfc on '${WFC_NODE}'"
  fi
  # The mount must be read-only.
  RO=$(kctl get pod "$HOST_POD" -n "$SFS_NS" \
    -o jsonpath="{.spec.volumes[?(@.name=='ctxfs-${OK_HASH}')].persistentVolumeClaim.readOnly}" 2>/dev/null || echo "")
  [ "$RO" = "true" ] && ok "ctxfs-${OK_HASH} is mounted read-only" \
    || fail "ctxfs-${OK_HASH} not read-only (got '${RO}')"
fi
context_clear_sfs
wait_for_mcp_host_rollout 240 \
  || fail "${MCP_HOST_DEPLOY} did not settle back to the un-mounted template after clearing the Context (P2 teardown)"

# ───────────────────────────────────────────────────────────────────────
header "Phase 3 — An unbindable SFS reports Degraded/PVCUnbound — NOT a Ready lie"
# A non-existent StorageClass keeps the PVC unprovisioned on ANY cluster, so the
# wfc pod stays Unschedulable. (On GKE the real trigger is RWX vs standard-rwo;
# minikube's hostpath would bind RWX, so we use a missing SC to reproduce the
# same observable symptom deterministically.)
kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${SFS_BAD}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  storageClassName: ${BAD_SC}
  directories: [docs]
  retainOnDelete: false
YAML
ok "SFS '${SFS_BAD}' applied with non-existent StorageClass '${BAD_SC}'"

if wait_for_sfs_phase "$SFS_BAD" "Degraded" 150; then
  ok "SFS '${SFS_BAD}' status.phase == Degraded (the status is TRUTHFUL about the wedge)"
else
  fail "SFS '${SFS_BAD}' never reported Degraded (phase='$(sfs_phase "$SFS_BAD")') — the status lie regressed"
  dump_sfs "$SFS_BAD"
fi
BAD_REASON=$(kctl get sharedfilesystem "$SFS_BAD" -n "$SFS_NS" \
  -o jsonpath='{.status.conditions[?(@.type=="Reconciled")].reason}' 2>/dev/null || echo "")
# Accept the exact wedge reason, or fall back to the message mentioning unbound/Unschedulable.
if [ "$BAD_REASON" = "PVCUnbound" ]; then
  ok "Degraded reason == PVCUnbound"
else
  BAD_MSG=$(kctl get sharedfilesystem "$SFS_BAD" -n "$SFS_NS" -o jsonpath='{.status.conditions[*].message}' 2>/dev/null || echo "")
  if printf "%s" "$BAD_MSG" | grep -qiE "unschedulable|accessModes|StorageClass|unbound"; then
    ok "Degraded condition message explains the wedge: ${BAD_MSG}"
  else
    fail "Degraded but no PVCUnbound reason/message (reason='${BAD_REASON}', msg='${BAD_MSG}')"
  fi
fi
PVC_BAD_PHASE=$(kctl get pvc "$PVC_BAD" -n "$SFS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Pending")
[ "$PVC_BAD_PHASE" != "Bound" ] && ok "PVC '${PVC_BAD}' is not Bound (phase='${PVC_BAD_PHASE}') — consistent with Degraded" \
  || fail "PVC '${PVC_BAD}' unexpectedly Bound — the wedge did not reproduce"

# ───────────────────────────────────────────────────────────────────────
header "Phase 4 — A referenced-but-not-Ready SFS is GATED (mcp-host comes up WITHOUT the mount)"
log "Patching Context '${CTX}' to reference the NON-Ready '${SFS_BAD}'..."
context_set_sfs "$SFS_BAD" "$MOUNT_BAD"
# Gating means: no template change (no mount injected) → mcp-host keeps running.
# Give the controller time to (not) act, then assert the host is healthy + unmounted.
sleep "${GATING_SETTLE:-20}"
if wait_for_mcp_host_rollout 180; then
  ok "${MCP_HOST_DEPLOY} stayed Available with a non-Ready SFS referenced"
else
  fail "${MCP_HOST_DEPLOY} went unavailable when a non-Ready SFS was referenced (gating broken — it should come up normally)"
  kctl get pods -n "$SFS_NS" 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
fi
HOST_POD="$(mcp_host_pod)"
if [ -n "$HOST_POD" ]; then
  PH=$(kctl get pod "$HOST_POD" -n "$SFS_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
  [ "$PH" = "Running" ] && ok "${MCP_HOST_DEPLOY} pod is Running (not stuck Pending on the bad SFS)" \
    || fail "${MCP_HOST_DEPLOY} pod phase='${PH}' (gating should prevent a Pending wedge)"
  if kctl get pod "$HOST_POD" -n "$SFS_NS" -o jsonpath='{.spec.volumes[*].name}' 2>/dev/null \
     | tr ' ' '\n' | grep -q "ctxfs-${BAD_HASH}"; then
    fail "mount ctxfs-${BAD_HASH} was injected for a NON-Ready SFS (gating failed)"
  else
    ok "no mount injected for the non-Ready SFS (gating works)"
  fi
else
  fail "no Running ${MCP_HOST_DEPLOY} pod during gating check"
fi
# Keep the Context referencing the (still non-Ready) '${SFS_BAD}' across into
# Phase 5: when P5 makes it Ready, the gap-A heal must inject the mount WITHOUT
# re-touching the Context. (Intentionally NOT clearing the Context here.)

# ───────────────────────────────────────────────────────────────────────
header "Phase 5 — Correcting the misconfiguration CONVERGES the status to Ready"
log "Recreating '${SFS_BAD}' without the bad StorageClass (operator fixes the SFS)..."
kctl delete sharedfilesystem "$SFS_BAD" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
kctl delete pvc "$PVC_BAD" -n "$SFS_NS" --ignore-not-found 2>/dev/null || true
sleep 3
kctl apply -f - <<YAML
apiVersion: clerum.io/v1alpha1
kind: SharedFileSystem
metadata: { name: ${SFS_BAD}, namespace: ${SFS_NS} }
spec:
  size: 1Gi
  directories: [docs]
  retainOnDelete: false
YAML
if wait_for_sfs_phase "$SFS_BAD" "Ready" 180; then
  ok "SFS '${SFS_BAD}' converged Degraded → Ready after the fix (no manual status hack)"
else
  fail "SFS '${SFS_BAD}' did not converge to Ready (phase='$(sfs_phase "$SFS_BAD")')"; dump_sfs "$SFS_BAD"
fi

# gap-A heal: the Context still references '${SFS_BAD}' (carried over from P4).
# Now that it is Ready, the Ready-flip re-reconcile (watch MODIFIED OR the SFS
# resync's Ready-ness flip) must inject the RO mount into the mcp-host WITHOUT
# any Context edit — proving inject-on-becoming-Ready, the consumer side of the
# co-location self-heal (an mcp-host that came up un-mounted picks the mount up
# once its SFS converges).
if wait_for_host_pod_volume "ctxfs-${BAD_HASH}" 240; then
  ok "ctxfs-${BAD_HASH} injected after '${SFS_BAD}' became Ready while still referenced (gap-A inject-on-flip heal)"
else
  fail "mount ctxfs-${BAD_HASH} never injected after '${SFS_BAD}' converged to Ready (the Ready-flip heal did not re-reconcile the Host)"
  kctl get pods -n "$SFS_NS" 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
fi
context_clear_sfs
wait_for_mcp_host_rollout 240 \
  || fail "${MCP_HOST_DEPLOY} did not settle back to the un-mounted template after clearing the Context (P5 teardown)"

# ───────────────────────────────────────────────────────────────────────
header "Phase 6 — Anti-co-location: required podAffinity fails LOUDLY when the wfc node is cordoned"
context_set_sfs "$SFS_OK" "$MOUNT_OK"
if ! wait_for_host_pod_volume "ctxfs-${OK_HASH}" 240; then
  fail "mount/affinity never injected before the anti-co-location test"
  kctl get pods -n "$SFS_NS" 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
else
  WFC_NODE="$(wfc_node_of "$SFS_OK")"   # the required-affinity target node
  log "Cordoning wfc node '${WFC_NODE}' and evicting ${MCP_HOST_DEPLOY} so it must reschedule under the required affinity..."
  kctl cordon "$WFC_NODE" >/dev/null 2>&1 \
    || fail "Phase 6: could not cordon wfc node '${WFC_NODE}' — the anti-co-location assertion below cannot be trusted"
  OLD_POD="$(host_pod_with_volume "ctxfs-${OK_HASH}")"
  [ -n "$OLD_POD" ] && kctl delete pod "$OLD_POD" -n "$SFS_NS" --wait=false >/dev/null 2>&1 || true
  # The ONLY node that satisfies the required podAffinity is cordoned, so the new
  # pod must be Unschedulable — a loud failure, never a silent off-node placement.
  UNSCHED_SEEN="no"
  elapsed=0
  while [ "$elapsed" -lt 120 ]; do
    REASON=$(kctl get pods -n "$SFS_NS" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.conditions[?(@.type=="PodScheduled")].reason}{"\n"}{end}' 2>/dev/null \
      | awk -F'\t' -v p="^${MCP_HOST_DEPLOY}-" '$1 ~ p && $2=="Pending" && $3=="Unschedulable"{print $3; exit}')
    if [ "$REASON" = "Unschedulable" ]; then UNSCHED_SEEN="yes"; break; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  if [ "$UNSCHED_SEEN" = "yes" ]; then
    ok "${MCP_HOST_DEPLOY} is Unschedulable with its only co-location node cordoned — required podAffinity failed loudly (no silent off-node mount)"
  else
    fail "${MCP_HOST_DEPLOY} did not become Unschedulable with the co-location node cordoned (required affinity not enforced)"
    kctl get pods -n "$SFS_NS" -o wide 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
  fi
  log "Uncordoning '${WFC_NODE}' and asserting recovery + re-co-location..."
  kctl uncordon "$WFC_NODE" >/dev/null 2>&1 || true
  RECOVERED="no"
  elapsed=0
  while [ "$elapsed" -lt 240 ]; do
    RP="$(host_pod_with_volume "ctxfs-${OK_HASH}")"
    if [ -n "$RP" ]; then
      HOST_NODE=$(kctl get pod "$RP" -n "$SFS_NS" -o jsonpath='{.spec.nodeName}' 2>/dev/null || echo "")
      WFC_NODE="$(wfc_node_of "$SFS_OK")"
      if [ -n "$HOST_NODE" ] && [ "$HOST_NODE" = "$WFC_NODE" ]; then RECOVERED="yes"; break; fi
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  [ "$RECOVERED" = "yes" ] \
    && ok "after uncordon ${MCP_HOST_DEPLOY} recovered and re-co-located on '${HOST_NODE}' with wfc" \
    || fail "after uncordon ${MCP_HOST_DEPLOY} ('${HOST_NODE:-none}') did not re-co-locate with wfc ('${WFC_NODE}')"
  context_clear_sfs
fi

# ───────────────────────────────────────────────────────────────────────
header "Phase 7 — Mount RESILIENCE: a wfc outage must NOT drop the RO mount (the mcp-host reads the PVC directly, not the wfc)"
# The consuming mcp-host mounts the SFS PVC read-only and never talks to the wfc
# HTTP server, so a wfc outage must NOT rip the mount out of a running agent pod.
# We make a Ready+mounted SFS leave Ready DURABLY by cordoning its wfc's node (the
# node-local RWO PVC keeps the wfc Unschedulable while the PVC stays Bound) and
# assert the SAME consumer pod KEEPS its mount and is NOT rolled — the regression
# guard for the mount-thrash the review surfaced. (Distinct from Phase 6, which
# EVICTS the consumer to prove the required affinity.)
context_set_sfs "$SFS_OK" "$MOUNT_OK"
if ! wait_for_host_pod_volume "ctxfs-${OK_HASH}" 240; then
  fail "mount never injected before the resilience test"
  kctl get pods -n "$SFS_NS" 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
else
  RES_POD="$(host_pod_with_volume "ctxfs-${OK_HASH}")"
  # Cordon EVERY node, then delete the wfc pod: with no schedulable node the wfc
  # cannot reschedule, so '${SFS_OK}' leaves Ready DURABLY (minikube hostpath PVs
  # are not node-pinned, so cordoning only the wfc's node would let it recover on
  # the other node and never exercise the not-Ready path). The PVC stays Bound and
  # the already-running consumer pod is NOT evicted by a cordon.
  log "Cordoning all nodes + deleting the wfc pod so '${SFS_OK}' leaves Ready durably (PVC stays Bound)..."
  cordon_all || fail "Phase 7: could not cordon all nodes — the resilience assertion cannot be trusted"
  WFC_POD=$(kctl get pods -n "$SFS_NS" \
    -l "app=workspace-files-controller,clerum.io/sharedfilesystem=${SFS_OK}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  [ -n "$WFC_POD" ] && kctl delete pod "$WFC_POD" -n "$SFS_NS" --wait=false >/dev/null 2>&1 || true
  # Prove the SFS genuinely leaves Ready (truthful status — the wfc can't serve).
  if wait_for_sfs_phase_not_ready "$SFS_OK" 150; then
    ok "SFS '${SFS_OK}' left Ready (phase='$(sfs_phase "$SFS_OK")') with its wfc wedged — truthful status"
  else
    fail "SFS '${SFS_OK}' stayed Ready (phase='$(sfs_phase "$SFS_OK")') with its wfc wedged — status lie"
  fi
  # CORE RESILIENCE ASSERTION: the SAME consumer pod keeps its RO mount and is NOT
  # rolled. Require it to stay mounted for >= 60s — well past one SFS resync
  # interval — so a buggy Ready-gated drop (which would re-reconcile the Host
  # without the mount) WOULD have rolled '${RES_POD}' away by now.
  RETAINED="no"; stable=0; elapsed=0
  while [ "$elapsed" -lt 120 ]; do
    if [ "$(pod_running_with_volume "$RES_POD" "ctxfs-${OK_HASH}")" = "yes" ]; then
      stable=$((stable + POLL_INTERVAL))
      [ "$stable" -ge 60 ] && { RETAINED="yes"; break; }
    else
      RETAINED="no"; break   # the original pod was rolled / lost its mount
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  if [ "$RETAINED" = "yes" ]; then
    ok "mcp-host pod '${RES_POD}' kept ctxfs-${OK_HASH} for >=60s through the wfc outage — mount RETAINED, no thrash"
  else
    fail "mcp-host pod '${RES_POD}' lost ctxfs-${OK_HASH} / was rolled during the wfc outage — mount-thrash regression"
    kctl get pods -n "$SFS_NS" -o wide 2>/dev/null | grep -E "${MCP_HOST_DEPLOY}|NAME" || true
  fi
  log "Uncordoning all nodes and asserting '${SFS_OK}' returns to Ready with the mount still present..."
  uncordon_all
  if wait_for_sfs_phase "$SFS_OK" "Ready" 180 && [ -n "$(host_pod_with_volume "ctxfs-${OK_HASH}")" ]; then
    ok "'${SFS_OK}' recovered to Ready and the mount is still present (the wfc blip caused no consumer disruption)"
  else
    fail "'${SFS_OK}' did not recover to Ready with the mount after uncordon (phase='$(sfs_phase "$SFS_OK")')"
  fi
  context_clear_sfs
  wait_for_mcp_host_rollout 240 \
    || fail "${MCP_HOST_DEPLOY} did not settle after clearing the Context (P7 teardown)"
fi

# ───────────────────────────────────────────────────────────────────────
cleanup || true
print_results
