#!/usr/bin/env bash
#
# Renders deploy/overlays/minikube/patches/llm-egress-cluster-cidrs.yaml from its
# .template, filling in the cluster-internal CIDRs that turn on HCC's STRONG
# egress-broker guard (CONTEXT_MAPPER_K8S_API_CIDRS +
# CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS). See the template header for what this
# enables and why it is opt-in.
#
# These values are environment-specific and the rendered file is gitignored, so
# only the template is tracked — mirrors deploy/scripts/minikube-detect-k8s-api-ip.sh.
#
# Detection (minikube / kubeadm):
#   * K8S_API_CIDRS         = the kubernetes endpoint IP as a /32 (same source as
#                             minikube-detect-k8s-api-ip.sh — the node IP the
#                             apiserver is reachable on after DNAT).
#   * CLUSTER_INTERNAL_CIDRS = pod CIDR (--cluster-cidr) + Service CIDR
#                             (--service-cluster-ip-range), read from the
#                             kube-apiserver / kube-controller-manager command line.
#
# Usage:
#   deploy/scripts/minikube-detect-cluster-cidrs.sh
#   CONTEXT=clerum-test deploy/scripts/minikube-detect-cluster-cidrs.sh
#
# Override detection explicitly (e.g. for a non-minikube cluster):
#   K8S_API_CIDRS=10.0.0.1/32 CLUSTER_INTERNAL_CIDRS=10.244.0.0/16,10.96.0.0/12 \
#     deploy/scripts/minikube-detect-cluster-cidrs.sh
set -euo pipefail

OVERLAY_DIR="${OVERLAY_DIR:-deploy/overlays/minikube}"
CONTEXT="${CONTEXT:-clerum-test}"
PATCH_FILE="$OVERLAY_DIR/patches/llm-egress-cluster-cidrs.yaml"
TEMPLATE_FILE="$PATCH_FILE.template"

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "ERROR: template $TEMPLATE_FILE not found." >&2
  exit 1
fi

# kube-apiserver endpoint IP → /32 (same source as minikube-detect-k8s-api-ip.sh).
if [ -z "${K8S_API_CIDRS:-}" ]; then
  IP="$(kubectl --context="$CONTEXT" get endpoints kubernetes -n default \
    -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"
  if [ -z "$IP" ]; then
    echo "ERROR: could not read kubernetes endpoint IP from context '$CONTEXT'." >&2
    echo "       Is the cluster running? Try: make minikube-status" >&2
    echo "       Or set K8S_API_CIDRS / CLUSTER_INTERNAL_CIDRS explicitly." >&2
    exit 1
  fi
  K8S_API_CIDRS="$IP/32"
fi

# Pod + Service CIDRs from the apiserver pod's command line (kubeadm/minikube).
if [ -z "${CLUSTER_INTERNAL_CIDRS:-}" ]; then
  APISERVER_CMD="$(kubectl --context="$CONTEXT" -n kube-system get pods \
    -l component=kube-apiserver -o jsonpath='{.items[0].spec.containers[0].command}' 2>/dev/null || true)"
  # jsonpath renders the command []string space-joined with no quotes or commas,
  # so the flag value ends at the next space (or a quote/comma if one appears) —
  # exclude the space too, or the match runs on into the following flag.
  SERVICE_CIDR="$(printf '%s' "$APISERVER_CMD" | grep -oE 'service-cluster-ip-range=[^" ,]+' | head -1 | cut -d= -f2 || true)"
  KCM_CMD="$(kubectl --context="$CONTEXT" -n kube-system get pods \
    -l component=kube-controller-manager -o jsonpath='{.items[0].spec.containers[0].command}' 2>/dev/null || true)"
  POD_CIDR="$(printf '%s' "$KCM_CMD" | grep -oE 'cluster-cidr=[^" ,]+' | head -1 | cut -d= -f2 || true)"

  parts=""
  [ -n "$POD_CIDR" ] && parts="$POD_CIDR"
  [ -n "$SERVICE_CIDR" ] && parts="${parts:+$parts,}$SERVICE_CIDR"
  if [ -z "$parts" ]; then
    echo "ERROR: could not detect pod/Service CIDRs from context '$CONTEXT'." >&2
    echo "       Set CLUSTER_INTERNAL_CIDRS explicitly (comma-separated)." >&2
    exit 1
  fi
  CLUSTER_INTERNAL_CIDRS="$parts"
fi

echo "[detect-cluster-cidrs] context=$CONTEXT"
echo "[detect-cluster-cidrs]   K8S_API_CIDRS=$K8S_API_CIDRS"
echo "[detect-cluster-cidrs]   CLUSTER_INTERNAL_CIDRS=$CLUSTER_INTERNAL_CIDRS"

tmp="$(mktemp)"
sed -e "s#__K8S_API_CIDRS__#${K8S_API_CIDRS}#g" \
    -e "s#__CLUSTER_INTERNAL_CIDRS__#${CLUSTER_INTERNAL_CIDRS}#g" \
    "$TEMPLATE_FILE" > "$tmp"
mv "$tmp" "$PATCH_FILE"

echo "[detect-cluster-cidrs] rendered: $PATCH_FILE"
echo "[detect-cluster-cidrs] NOTE: add '- patches/llm-egress-cluster-cidrs.yaml' to"
echo "[detect-cluster-cidrs]       $OVERLAY_DIR/kustomization.yaml (patchesStrategicMerge) to enable the strong guard."
