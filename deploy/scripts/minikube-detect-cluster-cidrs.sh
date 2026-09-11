#!/usr/bin/env bash
#
# Renders deploy/overlays/minikube/patches/llm-egress-cluster-cidrs.yaml from its
# .template, filling in the cluster-internal CIDRs that HCC's egress-broker guard
# requires (CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS). HCC is fail-closed on this
# value, so this patch is applied BY DEFAULT — see the template header.
#
# These values are environment-specific and the rendered file is gitignored, so
# only the template is tracked — mirrors deploy/scripts/minikube-detect-k8s-api-ip.sh.
#
# Detection (minikube / kubeadm):
#   * CLUSTER_INTERNAL_CIDRS = pod CIDR (--cluster-cidr) + Service CIDR
#                             (--service-cluster-ip-range), read from the
#                             kube-apiserver / kube-controller-manager command line.
#
# FAIL-CLOSED RENDER. HCC treats the rendered CIDRs as a security allow/deny
# input, so a partial render is worse than none: a patch carrying only the
# Service CIDR would make HCC believe the guard is configured while pod space
# stays unprotected. This script therefore aborts (exit 1, no patch written)
# if EITHER the pod CIDR or the Service CIDR is missing, and validates the
# shape of every CIDR it emits — a malformed entry is inert in the runtime LAN
# classifier (it denies nothing), so it must never reach the manifest.
#
# The apiserver-reachable ranges (CONTEXT_MAPPER_K8S_API_CIDRS) stay OPT-IN and
# are NOT rendered here — they also drive the allow-k8s-api-egress NetworkPolicies
# and watch-recovery fixtures. Use deploy/scripts/minikube-detect-k8s-api-ip.sh /
# a dedicated patch to turn them on deliberately.
#
# Usage:
#   deploy/scripts/minikube-detect-cluster-cidrs.sh
#   CONTEXT=clerum-test deploy/scripts/minikube-detect-cluster-cidrs.sh
#
# Override detection explicitly (e.g. for a non-minikube cluster):
#   CLUSTER_INTERNAL_CIDRS=10.244.0.0/16,10.96.0.0/12 \
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

# IPv4 dotted-quad CIDR: four octets (each 0..255) and a prefix 1..32. The
# runtime LAN classifier is IPv4-only and treats an unparseable entry as "no
# overlap" (denies nothing), so anything this script cannot validate must abort
# the render rather than ship a silently-inert range.
is_ipv4_cidr() {
  local cidr="$1" ip prefix o
  case "$cidr" in
    */*) ip="${cidr%/*}"; prefix="${cidr#*/}" ;;
    *) return 1 ;;
  esac
  [ -n "$ip" ] && [ -n "$prefix" ] || return 1
  # Prefix: digits only, 1..32.
  case "$prefix" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$prefix" -ge 1 ] && [ "$prefix" -le 32 ] || return 1
  # Exactly four dotted octets, each 0..255.
  local IFS=.
  # shellcheck disable=SC2086
  set -- $ip
  [ "$#" -eq 4 ] || return 1
  for o in "$@"; do
    case "$o" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$o" -ge 0 ] && [ "$o" -le 255 ] || return 1
  done
  return 0
}

# Validates a comma-separated CIDR list (from an explicit override). Empty list
# or any empty/malformed item is a hard error — an override is a deliberate
# security input, so a typo must fail loud, not slip through.
validate_cidr_list() {
  local label="$1" list="$2" item had=0
  local IFS=,
  for item in $list; do
    had=1
    if [ -z "$item" ]; then
      echo "ERROR: $label contains an empty entry: '$list'." >&2
      exit 1
    fi
    if ! is_ipv4_cidr "$item"; then
      echo "ERROR: $label entry '$item' is not a valid IPv4 CIDR (e.g. 10.96.0.0/12)." >&2
      exit 1
    fi
  done
  if [ "$had" -eq 0 ]; then
    echo "ERROR: $label is empty." >&2
    exit 1
  fi
}

# Literal splice of a placeholder into a template. Unlike sed/awk sub/gsub, the
# replacement is inserted verbatim (index()/substr() — no interpretation of &,
# \, or a delimiter), matching deploy/scripts/minikube-detect-k8s-api-ip.sh.
splice_placeholder() {
  awk -v ph="$1" -v val="$2" '
    {
      line = $0
      out = ""
      while ((p = index(line, ph)) > 0) {
        out = out substr(line, 1, p - 1) val
        line = substr(line, p + length(ph))
      }
      print out line
    }
  '
}

# Pod + Service CIDRs from the apiserver / controller-manager command line
# (kubeadm/minikube), unless overridden.
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

  if [ -z "$POD_CIDR" ]; then
    echo "ERROR: could not detect the pod CIDR (--cluster-cidr on kube-controller-manager) from context '$CONTEXT'." >&2
    echo "       Set CLUSTER_INTERNAL_CIDRS explicitly (comma-separated pod,Service CIDRs)." >&2
    exit 1
  fi
  if [ -z "$SERVICE_CIDR" ]; then
    echo "ERROR: could not detect the Service CIDR (--service-cluster-ip-range on kube-apiserver) from context '$CONTEXT'." >&2
    echo "       Set CLUSTER_INTERNAL_CIDRS explicitly (comma-separated pod,Service CIDRs)." >&2
    exit 1
  fi
  if ! is_ipv4_cidr "$POD_CIDR"; then
    echo "ERROR: detected pod CIDR '$POD_CIDR' is not a valid IPv4 CIDR." >&2
    exit 1
  fi
  if ! is_ipv4_cidr "$SERVICE_CIDR"; then
    echo "ERROR: detected Service CIDR '$SERVICE_CIDR' is not a valid IPv4 CIDR." >&2
    exit 1
  fi
  CLUSTER_INTERNAL_CIDRS="$POD_CIDR,$SERVICE_CIDR"
else
  validate_cidr_list "CLUSTER_INTERNAL_CIDRS" "$CLUSTER_INTERNAL_CIDRS"
fi

echo "[detect-cluster-cidrs] context=$CONTEXT"
echo "[detect-cluster-cidrs]   CLUSTER_INTERNAL_CIDRS=$CLUSTER_INTERNAL_CIDRS"

tmp="$(mktemp)"
splice_placeholder "__CLUSTER_INTERNAL_CIDRS__" "$CLUSTER_INTERNAL_CIDRS" \
  < "$TEMPLATE_FILE" > "$tmp"
mv "$tmp" "$PATCH_FILE"

echo "[detect-cluster-cidrs] rendered: $PATCH_FILE"
echo "[detect-cluster-cidrs] applied by default via $OVERLAY_DIR/kustomization.yaml (patchesStrategicMerge)."
