#!/usr/bin/env bash
#
# Detects the kube-apiserver endpoint IP on the minikube cluster and patches
# deploy/overlays/minikube/patches/k8s-api-ip.yaml to use it.
#
# Why endpoint IP (not Service clusterIP)?
#   In minikube, the `kubernetes` Service VIP (10.96.0.1) is DNAT'd by
#   kube-proxy to the node IP where the apiserver runs (e.g. 192.168.58.2).
#   Calico enforces egress NetworkPolicy AFTER DNAT, so the rule must match
#   the node IP, not the Service VIP. (The GKE-equivalent script uses
#   clusterIP because GKE's control plane is reachable differently.)
#
# Usage:
#   deploy/scripts/minikube-detect-k8s-api-ip.sh
#   CONTEXT=clerum-test deploy/scripts/minikube-detect-k8s-api-ip.sh
set -euo pipefail

OVERLAY_DIR="${OVERLAY_DIR:-deploy/overlays/minikube}"
CONTEXT="${CONTEXT:-clerum-test}"
PATCH_FILE="$OVERLAY_DIR/patches/k8s-api-ip.yaml"
TEMPLATE_FILE="$PATCH_FILE.template"

# Render from the template when present (minikube overlay). Fall back to
# in-place rewrite when only a plain patch file exists, so callers that
# construct their own overlay dir (scripts/tests/test-gcp-scripts.sh) keep
# working unchanged.
if [ ! -f "$TEMPLATE_FILE" ] && [ ! -f "$PATCH_FILE" ]; then
  echo "[detect-k8s-api-ip] no $PATCH_FILE or $TEMPLATE_FILE; skipping."
  exit 0
fi

IP="$(kubectl --context="$CONTEXT" get endpoints kubernetes -n default \
  -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"

if [ -z "$IP" ]; then
  echo "ERROR: could not read kubernetes endpoint IP from context '$CONTEXT'." >&2
  echo "       Is minikube running?  Try: make minikube-status" >&2
  exit 1
fi

echo "[detect-k8s-api-ip] context=$CONTEXT endpoint=$IP"

# Rewrite every `cidr: <ip>/32` line in the patch (BSD + GNU sed compatible).
SOURCE_FILE="$PATCH_FILE"
[ -f "$TEMPLATE_FILE" ] && SOURCE_FILE="$TEMPLATE_FILE"

tmp="$(mktemp)"
awk -v ip="$IP" '
  /^[[:space:]]+cidr:/ { sub(/cidr:[[:space:]]*.*/, "cidr: " ip "/32"); }
  { print }
' "$SOURCE_FILE" > "$tmp"
mv "$tmp" "$PATCH_FILE"

echo "[detect-k8s-api-ip] patched: $PATCH_FILE"
