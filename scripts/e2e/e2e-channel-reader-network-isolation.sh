#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E suite — Channel-reader network isolation (per-Host NetworkPolicy)
# ═══════════════════════════════════════════════════════════════════════
#
# Validates that per-Host NetworkPolicies pin channel-reader-<host> traffic
# to mcp-host-<host> only. Cross-Host attempts must fail at the network layer.
#
# Assertions:
#   1. channel-reader-A → mcp-host-A (same Host) — PASS (200 OK)
#   2. channel-reader-B → mcp-host-B (same Host) — PASS (200 OK)
#   3. channel-reader-A → mcp-host-B (cross Host) — FAIL (timeout/refused)
#   4. channel-reader-B → mcp-host-A (cross Host) — FAIL (timeout/refused)
#   5. channel-readers → workflow approval gateway — FAIL (timeout/refused)
#
# The two same-Host positive assertions cover both readers before the
# cross-Host negatives, so a broken HOST_B reader cannot make a cross-Host
# denial appear as a network-policy success.
#
# Prerequisites:
#   - minikube cluster running with Calico CNI
#   - `make minikube-deploy-all` already run
#   - At least 2 Host CRDs deployed (e.g. hosta, hostb)
#   - Per-Host channel-reader Deployments materialized
#   - Per-Host NetworkPolicies in place (channels and mcp-host namespaces)
#
# Usage:
#   bash scripts/e2e/e2e-channel-reader-network-isolation.sh
#
# Env vars:
#   CONTEXT          kubectl context (default: clerum-test)
#   HOST_A           first Host name (default: hosta)
#   HOST_B           second Host name (default: hostb)
#   TIMEOUT_SECS     curl timeout per request (default: 8)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
CONTEXT="${CONTEXT:-clerum-test}"
HOST_A="${HOST_A:-hosta}"
HOST_B="${HOST_B:-hostb}"
TIMEOUT_SECS="${TIMEOUT_SECS:-8}"

NAMESPACE_CHANNELS="channels"
NAMESPACE_MCP_HOST="mcp-host"

# ─── Logging ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

log()    { echo -e "${BOLD}[E2E Network Isolation]${NC} $*"; }
ok()     { echo -e "${GREEN}✓ PASS${NC} — $*"; }
fail()   { echo -e "${RED}✗ FAIL${NC} — $*"; }

# ─── Main ────────────────────────────────────────────────────────────
log "Network isolation E2E (Calico CNI)"
log "Context: $CONTEXT, Hosts: $HOST_A, $HOST_B"
echo

# Pre-flight: verify cluster + resources exist
log "Phase 0 — Pre-flight checks"
if ! kubectl --context="$CONTEXT" cluster-info &>/dev/null; then
  fail "Cluster not reachable (context: $CONTEXT)"
  exit 1
fi
ok "Cluster reachable"

for host in "$HOST_A" "$HOST_B"; do
  if ! kubectl --context="$CONTEXT" -n "$NAMESPACE_CHANNELS" get deploy "channel-reader-$host" &>/dev/null; then
    fail "Deployment 'channel-reader-$host' not found in namespace '$NAMESPACE_CHANNELS'"
    exit 1
  fi
  if ! kubectl --context="$CONTEXT" -n "$NAMESPACE_MCP_HOST" get svc "$host" &>/dev/null; then
    fail "Service '$host' not found in namespace '$NAMESPACE_MCP_HOST'"
    exit 1
  fi
done
ok "Both Host Deployments + Services exist"

# Wait for channel-reader pods to be ready
log "Phase 1 — Waiting for pod readiness"
for host in "$HOST_A" "$HOST_B"; do
  if kubectl --context="$CONTEXT" -n "$NAMESPACE_CHANNELS" wait \
       --for=condition=available --timeout=60s \
       deploy/"channel-reader-$host" &>/dev/null; then
    ok "channel-reader-$host deployment ready"
  else
    fail "channel-reader-$host deployment did not become ready in time"
    exit 1
  fi
done
echo

# Verify NetworkPolicies exist
log "Phase 2 — Verifying NetworkPolicies"
for host in "$HOST_A" "$HOST_B"; do
  if ! kubectl --context="$CONTEXT" -n "$NAMESPACE_CHANNELS" get netpol "channel-reader-$host-egress" &>/dev/null; then
    fail "NetworkPolicy 'channel-reader-$host-egress' not found in namespace '$NAMESPACE_CHANNELS'"
    exit 1
  fi
  if ! kubectl --context="$CONTEXT" -n "$NAMESPACE_MCP_HOST" get netpol "mcp-host-$host-ingress-channel-reader" &>/dev/null; then
    fail "NetworkPolicy 'mcp-host-$host-ingress-channel-reader' not found in namespace '$NAMESPACE_MCP_HOST'"
    exit 1
  fi
done
ok "All per-Host NetworkPolicies exist"
echo

# Channel-reader image carries busybox wget, not curl. Use wget throughout.
# wget exits non-zero on connect-refused / timeout → same semantics as curl -f.

# Test 1: HOST_A same-Host access (should succeed)
log "Test 1 — channel-reader-$HOST_A → mcp-host-$HOST_A (same Host, expect 200)"
if kubectl --context="$CONTEXT" exec -n "$NAMESPACE_CHANNELS" \
     "deploy/channel-reader-$HOST_A" -- \
     wget -qO- --timeout="$TIMEOUT_SECS" --tries=1 \
     "http://$HOST_A.$NAMESPACE_MCP_HOST.svc.cluster.local:8080/v1/runtime/health" \
     2>/dev/null | grep -q '"status":"ok"'; then
  ok "channel-reader-$HOST_A can reach mcp-host-$HOST_A ✓"
else
  fail "channel-reader-$HOST_A could NOT reach mcp-host-$HOST_A (per-Host NP misconfigured?)"
  exit 1
fi
echo

# Test 2: HOST_B same-Host access (should succeed)
# This positive control runs BEFORE the cross-Host negatives so a broken
# HOST_B reader (e.g. CrashLoopBackOff, missing creds, unhealthy mcp-host)
# cannot make Test 4's denial look like an NP success.
log "Test 2 — channel-reader-$HOST_B → mcp-host-$HOST_B (same Host, expect 200)"
if kubectl --context="$CONTEXT" exec -n "$NAMESPACE_CHANNELS" \
     "deploy/channel-reader-$HOST_B" -- \
     wget -qO- --timeout="$TIMEOUT_SECS" --tries=1 \
     "http://$HOST_B.$NAMESPACE_MCP_HOST.svc.cluster.local:8080/v1/runtime/health" \
     2>/dev/null | grep -q '"status":"ok"'; then
  ok "channel-reader-$HOST_B can reach mcp-host-$HOST_B ✓"
else
  fail "channel-reader-$HOST_B could NOT reach mcp-host-$HOST_B (per-Host NP misconfigured? broken reader?)"
  exit 1
fi
echo

# Test 3: Cross-Host access A→B (should fail)
log "Test 3 — channel-reader-$HOST_A → mcp-host-$HOST_B (cross Host, expect timeout/refused)"
if kubectl --context="$CONTEXT" exec -n "$NAMESPACE_CHANNELS" \
     "deploy/channel-reader-$HOST_A" -- \
     wget -qO- --timeout="$TIMEOUT_SECS" --tries=1 \
     "http://$HOST_B.$NAMESPACE_MCP_HOST.svc.cluster.local:8080/v1/runtime/health" \
     2>/dev/null; then
  fail "channel-reader-$HOST_A reached mcp-host-$HOST_B — isolation broken!"
  exit 1
else
  ok "channel-reader-$HOST_A cannot reach mcp-host-$HOST_B ✓ (isolation working)"
fi
echo

# Test 4: Cross-Host access B→A (should fail)
log "Test 4 — channel-reader-$HOST_B → mcp-host-$HOST_A (cross Host, expect timeout/refused)"
if kubectl --context="$CONTEXT" exec -n "$NAMESPACE_CHANNELS" \
     "deploy/channel-reader-$HOST_B" -- \
     wget -qO- --timeout="$TIMEOUT_SECS" --tries=1 \
     "http://$HOST_A.$NAMESPACE_MCP_HOST.svc.cluster.local:8080/v1/runtime/health" \
     2>/dev/null; then
  fail "channel-reader-$HOST_B reached mcp-host-$HOST_A — isolation broken!"
  exit 1
else
  ok "channel-reader-$HOST_B cannot reach mcp-host-$HOST_A ✓ (isolation working)"
fi
echo

# Test 5: Workflow approval gateway is intentionally not a channel-reader peer.
log "Test 5 — channel-readers → nginx-workflow-approval-gateway (expect timeout/refused)"
for host in "$HOST_A" "$HOST_B"; do
  if kubectl --context="$CONTEXT" exec -n "$NAMESPACE_CHANNELS" \
       "deploy/channel-reader-$host" -- \
       wget -qO- --timeout="$TIMEOUT_SECS" --tries=1 \
       "http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092/health" \
       2>/dev/null; then
    fail "channel-reader-$host reached nginx-workflow-approval-gateway — boundary broken!"
    exit 1
  else
    ok "channel-reader-$host cannot reach nginx-workflow-approval-gateway ✓"
  fi
done
echo

log "═════════════════════════════════════════════════════════════════"
echo -e "${GREEN}All isolation checks passed${NC}"
log "═════════════════════════════════════════════════════════════════"
