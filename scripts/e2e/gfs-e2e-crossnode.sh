#!/usr/bin/env bash
# gfs E2E cross-node broker access (plan P5-S06) — multi-node profile, RWO.
#
# Proves that the RWO drive constrains only gfsc's OWN pods, not consumers:
# schedule an mcp-host agent pod on a DIFFERENT node than the gfsc writer
# (nodeSelector/anti-affinity) while the drive stays ReadWriteOnce single-node,
# then assert read+write succeed THROUGH the gfsc ClusterIP Service.
#
# Requires a generated multi-node branch profile:
#   MINIKUBE_MULTI_NODE=true MINIKUBE_NODES=2 make minikube-start
#
# NOT a CI test. Fail-loud: fewer than 2 Ready schedulable nodes, co-located
# scheduling, or an unreachable Service aborts with the concrete reason.
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the generated multi-node branch profile}"
GFS_NS="${GFS_NS:-gfs}"
MCP_NS="${MCP_NS:-mcp-host}"

kc() { kubectl --context="$CONTEXT" "$@"; }

case "$CONTEXT" in
  clerum-codex-* | clerum-detached-*) : ;;
  *) echo "FATAL: cross-node gate needs a generated multi-node branch profile, not '$CONTEXT'" >&2; exit 1 ;;
esac

echo "== gfs E2E cross-node broker access (context=$CONTEXT) =="

# Require at least two Ready, schedulable nodes — single-node cannot prove this.
ready_nodes="$(kc get nodes -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.spec.unschedulable}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
  | awk -F'\t' '$2!="true" && $3=="True"' | wc -l | tr -d ' ')"
if [[ "${ready_nodes:-0}" -lt 2 ]]; then
  echo "FATAL: need >=2 Ready schedulable nodes, found ${ready_nodes:-0}" >&2
  kc get nodes -o wide >&2 || true
  exit 1
fi
echo "  PASS: ${ready_nodes} Ready schedulable nodes"

# Identify the gfsc writer's node; the agent pod must land elsewhere.
writer_node="$(kc -n "$GFS_NS" get pods -l 'app=gfs-controller,clerum.io/gfsc-role=writer' \
  -o 'jsonpath={.items[0].spec.nodeName}' 2>/dev/null || true)"
[[ -n "$writer_node" ]] || { echo "FATAL: no gfsc writer pod found in $GFS_NS" >&2; exit 1; }
echo "  gfsc writer is on node: $writer_node"

# The core assertion — an off-node agent pod (anti-affinity) reading+writing
# through the gfsc ClusterIP while the drive stays RWO single-node — is NOT yet
# wired (needs the agent pod + a minted host token + the write API). Fail loud:
# this gate proves nothing until that assertion exists, so it is RED, not "complete".
echo "FATAL: off-node read+write assertion not wired — cross-node gate is RED until implemented" >&2
exit 1
