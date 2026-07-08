#!/usr/bin/env bash
#
# Pre-flight gate before enabling NetworkPolicy enforcement on a GKE cluster.
#
# Read-only. Run this and get a clean exit BEFORE flipping enforcement — the
# 2026-05-15 attempt was rolled back because allow-k8s-api-egress-* targeted
# the wrong IP. See docs/deploy/gcp.md §7 for the full runbook.
#
# Checks (blockers fail the run; the label audit is a WARN):
#   0. Current NetworkPolicy enforcement state            (informational)
#   1. Kubernetes API ClusterIP + post-DNAT endpoint IP
#   2. allow-k8s-api-egress-* carries the endpoint IP in all 6 namespaces
#   3. DNS egress to kube-dns ClusterIP present in every clerum namespace
#   4. runtime-namespace pods with K8s-API RBAC carry the opt-in label  (WARN)
#
# Usage:
#   make gcp-prod-np-preflight            # sets CONTEXT for you
#   make gcp-dev-np-preflight
#   CONTEXT=<kube-context> deploy/scripts/np-enforce-preflight.sh
#
# CONTEXT MUST be passed explicitly — the script never inherits the current
# kubectl context (per CLAUDE.md: the active context is not load-bearing).

# Not `set -e`: we want to run every check and tally blockers, not abort early.
set -uo pipefail

CONTEXT="${CONTEXT:-}"
OVERLAY="${OVERLAY:-}"
if [ -z "$CONTEXT" ]; then
  echo "ERROR: CONTEXT is unset. Pass the target kube-context explicitly," >&2
  echo "       e.g. 'make gcp-prod-np-preflight', or" >&2
  echo "       'CONTEXT=<ctx> deploy/scripts/np-enforce-preflight.sh'." >&2
  exit 2
fi

# Defaults are overwritten from the rendered overlay below. They remain here as
# a fallback only for non-GKE diagnostics where no overlay can be inferred.
K8S_API_NAMESPACES="channels control-plane mcp-host mcp-server rpc-proxy sandbox-recipes"
# Every rendered Clerum namespace needs DNS egress before enforcement flips.
ALL_NAMESPACES="channels control-plane ingress mcp-host mcp-server profiles rpc-proxy sandbox-recipes sandbox-ui webhook-ingress"
# HCC runtime namespaces — allow-k8s-api-egress-* is opt-in here (PR #314).
RUNTIME_NAMESPACES="mcp-server rpc-proxy sandbox-recipes sandbox-ui"

blockers=0
warns=0
pass() { printf '  PASS  %s\n' "$1"; }
warn() { printf '  WARN  %s\n' "$1"; warns=$((warns + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; blockers=$((blockers + 1)); }

kq() { kubectl --context "$CONTEXT" "$@"; }

if [ -z "$OVERLAY" ]; then
  case "$CONTEXT" in
    *clerum-dev) OVERLAY="gcp-dev" ;;
    *clerum) OVERLAY="gcp-prod" ;;
  esac
fi

if [ -n "$OVERLAY" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  OVERLAY_DIR="$REPO_ROOT/deploy/overlays/$OVERLAY"
  if [ ! -d "$OVERLAY_DIR" ]; then
    echo "ERROR: overlay not found: $OVERLAY_DIR" >&2
    exit 2
  fi
  if ! command -v ruby >/dev/null 2>&1; then
    echo "ERROR: ruby is required to derive NetworkPolicy namespaces from $OVERLAY" >&2
    exit 2
  fi
  DERIVED="$(
    kubectl kustomize "$OVERLAY_DIR" 2>/dev/null | RUBYOPT=--disable=gems ruby -ryaml -e '
      docs = YAML.load_stream(STDIN.read).select { |doc| doc.is_a?(Hash) }
      quote = lambda { |value| "'"'"'" + value.gsub("'"'"'", "'"'"'\\\\'"'"''"'"'") + "'"'"'" }
      namespaces = docs
        .select { |doc| doc["kind"] == "Namespace" && (doc.dig("metadata", "labels") || {})["app.kubernetes.io/part-of"] == "clerum" }
        .map { |doc| doc.dig("metadata", "name") }
        .compact
        .uniq
        .sort
      static_k8s = docs
        .select { |doc| doc["kind"] == "NetworkPolicy" }
        .map { |doc| [doc.dig("metadata", "namespace"), doc.dig("metadata", "name")] }
        .select { |_ns, name| name&.start_with?("allow-k8s-api-egress-") }
        .map(&:first)
        .compact
      hcc = docs.find { |doc| doc["kind"] == "Deployment" && doc.dig("metadata", "name") == "host-context-controller" }
      env = (((hcc || {}).dig("spec", "template", "spec", "containers") || []).first || {})["env"] || []
      env_value = lambda do |name|
        item = env.find { |entry| entry["name"] == name }
        (item && item["value"] || "").split(",").map(&:strip).reject(&:empty?)
      end
      runtime = env_value.call("CONTEXT_MAPPER_RUNTIME_NAMESPACES")
      minimal = env_value.call("CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES")
      k8s_api = (static_k8s + (runtime - minimal)).uniq.sort
      puts "ALL_NAMESPACES=#{quote.call(namespaces.join(" "))}"
      puts "K8S_API_NAMESPACES=#{quote.call(k8s_api.join(" "))}"
      puts "RUNTIME_NAMESPACES=#{quote.call(runtime.join(" "))}"
    '
  )"
  if [ -z "$DERIVED" ]; then
    echo "ERROR: failed to derive namespace inventory from overlay $OVERLAY" >&2
    exit 2
  fi
  eval "$DERIVED"

  echo "[static] Rendered NetworkPolicy lint"
  if "$REPO_ROOT/deploy/scripts/lint-networkpolicies.sh" --overlay "$OVERLAY"; then
    pass "overlay $OVERLAY and standalone MCP fallback policies passed static lint"
  else
    bad "overlay $OVERLAY or standalone MCP fallback policies contain unsafe NetworkPolicy shapes"
  fi
  if "$REPO_ROOT/deploy/scripts/lint-workload-hardening.sh" \
    --overlay "$OVERLAY" \
    --exceptions "${WORKLOAD_HARDENING_EXCEPTIONS:-${REPO_ROOT}/deploy/security/workload-hardening-exceptions.yaml}"; then
    pass "overlay $OVERLAY workloads passed token and pod-hardening lint"
  else
    bad "overlay $OVERLAY workloads contain unowned token or pod-hardening gaps"
  fi
  echo
fi

echo "NetworkPolicy enforcement pre-flight"
echo "  context: $CONTEXT"
echo "  overlay: ${OVERLAY:-not-derived}"
echo

if ! kq get nodes -o name >/dev/null 2>&1; then
  echo "ERROR: cannot reach cluster for context '$CONTEXT'." >&2
  exit 2
fi

# ── Check 0: current enforcement state (informational, gcloud best-effort) ──
echo "[0] Current NetworkPolicy enforcement state"
case "$CONTEXT" in
  gke_*)
    # Context name shape: gke_<project>_<zone>_<cluster>
    IFS=_ read -r _gke PROJECT ZONE CLUSTER <<<"$CONTEXT"
    if command -v gcloud >/dev/null 2>&1 && [ -n "${CLUSTER:-}" ]; then
      ENABLED="$(gcloud container clusters describe "$CLUSTER" \
        --zone="$ZONE" --project="$PROJECT" \
        --format='value(networkPolicy.enabled)' 2>/dev/null | tr -d '[:space:]')"
      case "$ENABLED" in
        True|true) warn "enforcement appears already ENABLED — confirm this run is still wanted" ;;
        *)        pass "enforcement is DISABLED (expected pre-flip)" ;;
      esac
    else
      echo "  (gcloud unavailable or non-gke context — skipped)"
    fi
    ;;
  *)
    echo "  (non-gke context — skipped)"
    ;;
esac
echo

# ── Check 1: K8s API ClusterIP + endpoint ──────────────────────────────────
echo "[1] Kubernetes API server addresses"
CLUSTER_IP="$(kq get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}' 2>/dev/null)"
ENDPOINT_IPS="$(kq get endpoints kubernetes -n default \
  -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null)"
if [ -n "$CLUSTER_IP" ] && [ -n "$ENDPOINT_IPS" ]; then
  pass "ClusterIP=$CLUSTER_IP  endpoint(s)=$ENDPOINT_IPS"
else
  bad "could not read the kubernetes Service ClusterIP and/or endpoints"
fi
echo

# ── Check 2: allow-k8s-api-egress-* covers the post-DNAT endpoint IP ────────
echo "[2] allow-k8s-api-egress-* covers the post-DNAT endpoint IP"
echo "    (GKE legacy Calico enforces egress against the endpoint, not the ClusterIP)"
for NS in $K8S_API_NAMESPACES; do
  CIDRS="$(kq -n "$NS" get networkpolicy "allow-k8s-api-egress-$NS" \
    -o jsonpath='{.spec.egress[*].to[*].ipBlock.cidr}' 2>/dev/null)"
  if [ -z "$CIDRS" ]; then
    bad "$NS: allow-k8s-api-egress-$NS not found, or it has no ipBlock"
    continue
  fi
  missing=0
  for ip in $ENDPOINT_IPS; do
    case " $CIDRS " in *" $ip/32 "*) ;; *) missing=1 ;; esac
  done
  broad=""
  for c in $CIDRS; do
    case "$c" in
      */*) ;;
      *) broad="$broad $c(malformed-no-prefix)"; continue ;;
    esac
    if [ "$c" = "10.109.0.1/32" ]; then
      broad="$broad $c(stale-DO-placeholder)"
      continue
    fi
    prefix="${c##*/}"
    if [ -n "$prefix" ] && [ "$prefix" -lt 24 ] 2>/dev/null; then
      broad="$broad $c"
    fi
  done
  if [ "$missing" -ne 0 ]; then
    bad "$NS: missing endpoint IP — has [$CIDRS]"
  elif [ -n "$broad" ]; then
    bad "$NS: over-broad / stale CIDR present —$broad"
  else
    pass "$NS: [$CIDRS]"
  fi
done
echo

# ── Check 3: DNS egress to kube-dns ClusterIP in every namespace ─────────────
# GKE NodeLocal DNSCache + NetworkPolicy requires an ipBlock allow to the
# kube-dns Service ClusterIP. A namespaceSelector/podSelector-only DNS policy can
# pass admission while still failing under legacy Calico enforcement.
echo "[3] DNS egress (UDP/TCP 53) to kube-dns ClusterIP in every clerum namespace"
DNS_SERVICE_IP="$(kq -n kube-system get svc kube-dns -o jsonpath='{.spec.clusterIP}' 2>/dev/null)"
if [ -z "$DNS_SERVICE_IP" ]; then
  bad "could not read kube-system/kube-dns ClusterIP"
fi
DNS_SERVICE_CIDR="${DNS_SERVICE_IP}/32"
for NS in $ALL_NAMESPACES; do
  if [ -z "$DNS_SERVICE_IP" ]; then
    bad "$NS: cannot validate DNS egress without kube-dns ClusterIP"
    continue
  fi

  NP_JSON="$(kq -n "$NS" get networkpolicy -o json 2>/dev/null)"
  if printf '%s' "$NP_JSON" | DNS_SERVICE_CIDR="$DNS_SERVICE_CIDR" RUBYOPT=--disable=gems ruby -rjson -e '
      dns_cidr = ENV.fetch("DNS_SERVICE_CIDR")
      doc = JSON.parse(STDIN.read)
      ok = Array(doc["items"]).any? do |item|
        Array(item.dig("spec", "egress")).any? do |rule|
          ports = Array(rule["ports"]).map do |port|
            next unless port.is_a?(Hash)
            [(port["protocol"] || "TCP").to_s.upcase, port["port"].to_s]
          end.compact.sort
          next false unless ports == [["TCP", "53"], ["UDP", "53"]]

          Array(rule["to"]).any? { |peer| peer.is_a?(Hash) && peer.dig("ipBlock", "cidr") == dns_cidr }
        end
      end
      exit(ok ? 0 : 1)
    '; then
    pass "$NS: DNS egress includes $DNS_SERVICE_CIDR"
  else
    bad "$NS: no NetworkPolicy allows TCP/UDP 53 to kube-dns ClusterIP $DNS_SERVICE_CIDR"
  fi
done
echo

# ── Check 4: runtime-namespace K8s-API opt-in label coverage ────────────────
# allow-k8s-api-egress-* in runtime namespaces is opt-in via the label
# clerum.io/k8s-api-egress=true (PR #314). A pod needs that label only if it
# actually calls the K8s API — the proxy signal is "its ServiceAccount is the
# subject of a Role/ClusterRoleBinding". A mounted token alone is not enough
# (the default SA has no powers), so we key on RBAC, not on token presence.
echo "[4] runtime namespaces: pods with K8s-API RBAC carry the opt-in label"
flagged=0
for NS in $RUNTIME_NAMESPACES; do
  # ServiceAccounts local to NS that are bound by some RoleBinding. A subject
  # with no explicit namespace defaults to the RoleBinding's namespace (NS).
  RB_SAS="$(kq -n "$NS" get rolebindings \
    -o jsonpath='{range .items[*].subjects[*]}{.kind}|{.namespace}|{.name}{"\n"}{end}' 2>/dev/null \
    | awk -F'|' -v ns="$NS" '$1=="ServiceAccount" && ($2==ns || $2=="") {print $3}')"
  # ServiceAccounts local to NS that are bound by a ClusterRoleBinding.
  CRB_SAS="$(kq get clusterrolebindings \
    -o jsonpath='{range .items[*].subjects[*]}{.kind}|{.namespace}|{.name}{"\n"}{end}' 2>/dev/null \
    | awk -F'|' -v ns="$NS" '$1=="ServiceAccount" && $2==ns {print $3}')"
  POWERED="$(printf '%s\n%s\n' "$RB_SAS" "$CRB_SAS" | grep -v '^$' | sort -u)"

  while IFS='|' read -r pod sa label; do
    [ -z "$pod" ] && continue
    [ -z "$sa" ] && sa="default"
    if printf '%s\n' "$POWERED" | grep -qxF "$sa" && [ "$label" != "true" ]; then
      warn "$NS/$pod (sa=$sa): has K8s-API RBAC, missing clerum.io/k8s-api-egress label"
      flagged=$((flagged + 1))
    fi
  done <<EOF
$(kq -n "$NS" get pods -o jsonpath='{range .items[*]}{.metadata.name}|{.spec.serviceAccountName}|{.metadata.labels.clerum\.io/k8s-api-egress}{"\n"}{end}' 2>/dev/null)
EOF
done
if [ "$flagged" -eq 0 ]; then
  pass "no RBAC-empowered pod is missing the label in: $RUNTIME_NAMESPACES"
fi
echo

# ── Summary ─────────────────────────────────────────────────────────────────
echo "─────────────────────────────────────────────"
if [ "$blockers" -ne 0 ]; then
  echo "RESULT: $blockers blocker(s) — do NOT enable NetworkPolicy enforcement."
  echo "        Fix every FAIL above, then re-run this gate."
  exit 1
fi
if [ "$warns" -ne 0 ]; then
  echo "RESULT: 0 blockers, $warns warning(s) — review each WARN above before the flip."
else
  echo "RESULT: all checks passed."
fi
echo "        Proceed per the NP-enforcement runbook (docs/deploy/gcp.md §7)."
exit 0
