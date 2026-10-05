#!/usr/bin/env bash
# Decide how pods on this cluster can reach the Kubernetes API server under a
# default-deny egress policy.
#
# DigitalOcean documents that, on the DOKS control plane, a Kubernetes
# NetworkPolicy cannot selectively allow access to the API server and that
# CiliumNetworkPolicies should be used instead. Cilium CIDR selectors also do
# not match in-cluster entities unless policy-cidr-match-mode=nodes. Evenfire's
# base policies grant API egress with ipBlocks, so this probe measures both
# mechanisms on the target cluster instead of assuming either.
#
# Phases, in a throwaway namespace (deleted on exit), from two pods spread over
# nodes when possible, to the kubernetes Service ClusterIP (443) and every
# EndpointSlice address (on its own port), TCP connect only (`nc -z`, no bytes sent):
#   BASELINE  no policy                                 must reach, else exit 2
#   DENY      deny-all egress only                      must be blocked, else exit 2
#             (otherwise API egress is not policed and the next phases prove nothing)
#   IPBLOCK   deny-all egress + ipBlock /32 allow       best case for ipBlocks
#   CNP       deny-all egress + CiliumNetworkPolicy toEntities kube-apiserver
#             with toPorts; the ipBlock policy is removed first, because Cilium
#             unions allow rules and would otherwise mask a failing CNP
# A phase passes only if every pod reaches every target within ATTEMPTS tries.
#
# Output (stdout, KEY=value): API_IPS, BASELINE, DENY_ONLY, IPBLOCK_PATH, CNP_PATH,
# API_EGRESS_PATH (cnp|ipblock|none, cnp preferred), NODES_TESTED.
# Exit: 0 = at least one path works; 1 = both blocked; 2 = inconclusive.
#
# Required env: CONTEXT. Optional: PROBE_NS (default evenfire-api-probe),
# PROBE_IMAGE (default busybox:1.36), ATTEMPTS (default 10), PROBE_SLEEP
# (policy settle seconds, default 10), PROBE_RETRY_SLEEP (default 3), KUBECTL.
set -uo pipefail

: "${CONTEXT:?set CONTEXT}"
NS="${PROBE_NS:-evenfire-api-probe}"
IMAGE="${PROBE_IMAGE:-busybox:1.36}"
ATTEMPTS="${ATTEMPTS:-10}"
PROBE_SLEEP="${PROBE_SLEEP:-10}"
PROBE_RETRY_SLEEP="${PROBE_RETRY_SLEEP:-3}"
k() { "${KUBECTL:-kubectl}" --context "$CONTEXT" "$@"; }
say() { printf 'api-egress-probe: %s\n' "$*" >&2; }

if k get namespace "$NS" >/dev/null 2>&1; then
  say "namespace $NS already exists; refusing to reuse it"
  exit 2
fi

cluster_ip="$(k -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')"
ep_ips="$(k -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{range .endpoints[*]}{.addresses[*]}{" "}{end}{end}')"
ep_port="$(k -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[*].ports[*].port}' | tr ' ' '\n' | awk 'NF' | sort -u)"
if [ "$(printf '%s\n' "$ep_port" | awk 'NF' | wc -l | tr -d ' ')" != 1 ] || ! [[ "$ep_port" =~ ^[0-9]+$ ]]; then
  say "kubernetes EndpointSlices expose ports [$(printf '%s ' $ep_port)]; expected exactly one"
  exit 2
fi
if [ -z "$cluster_ip" ] || [ -z "$(printf '%s' "$ep_ips" | tr -d ' ')" ]; then
  say "cannot read the kubernetes Service ClusterIP or its EndpointSlice addresses"
  exit 2
fi
# Targets as "ip port": the ClusterIP on the Service port, endpoints on theirs.
targets="$cluster_ip 443"
for ip in $ep_ips; do targets="$targets
$ip $ep_port"; done
api_ips="$(printf '%s\n' "$targets" | awk '{print $1}' | awk '!seen[$0]++' | paste -sd' ' -)"
ports="$(printf '443\n%s\n' "$ep_port" | sort -un)"

cnp_crd=true
k get crd ciliumnetworkpolicies.cilium.io >/dev/null 2>&1 || cnp_crd=false

k create namespace "$NS" >/dev/null || { say "cannot create namespace $NS"; exit 2; }
cleanup() { k delete namespace "$NS" --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

k -n "$NS" apply -f - >/dev/null <<EOF || { say "cannot create probe Deployment"; exit 2; }
apiVersion: apps/v1
kind: Deployment
metadata:
  name: probe
  namespace: ${NS}
spec:
  replicas: 2
  selector:
    matchLabels: {app: api-probe}
  template:
    metadata:
      labels: {app: api-probe}
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels: {app: api-probe}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: probe
          image: ${IMAGE}
          command: ["sleep", "3600"]
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
EOF

k -n "$NS" rollout status deployment/probe --timeout=180s >/dev/null \
  || { say "probe pods not ready"; exit 2; }
pods_nodes="$(k -n "$NS" get pods -l app=api-probe \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{"\n"}{end}' | awk 'NF')"
pods="$(printf '%s\n' "$pods_nodes" | awk '{print $1}')"
nodes_tested="$(printf '%s\n' "$pods_nodes" | awk '{print $2}' | sort -u | awk 'NF' | wc -l | tr -d ' ')"
[ -n "$pods" ] || { say "no probe pods found"; exit 2; }
[ "$nodes_tested" -ge 2 ] || say "only one node scheduled probe pods; cross-node case not tested"

# reach_all: every pod reaches every target within ATTEMPTS tries.
reach_all() {
  local pod ip port i ok
  for pod in $pods; do
    while read -r ip port; do
      ok=false
      for ((i = 1; i <= ATTEMPTS; i++)); do
        if k -n "$NS" exec "$pod" -- timeout 5 nc -z -w 3 "$ip" "$port" </dev/null >/dev/null 2>&1; then
          ok=true; break
        fi
        [ "$i" -lt "$ATTEMPTS" ] && sleep "$PROBE_RETRY_SLEEP"
      done
      if [ "$ok" != true ]; then
        say "$pod cannot reach $ip:$port"
        return 1
      fi
    done <<<"$targets"
  done
  return 0
}

# reach_any: some pod reaches some target (used to prove deny-all blocks).
reach_any() {
  local pod ip port
  for pod in $pods; do
    while read -r ip port; do
      if k -n "$NS" exec "$pod" -- timeout 5 nc -z -w 3 "$ip" "$port" </dev/null >/dev/null 2>&1; then
        say "$pod reached $ip:$port"
        return 0
      fi
    done <<<"$targets"
  done
  return 1
}

print_result() { # baseline deny ipblock cnp path
  printf 'API_IPS=%s\nBASELINE=%s\nDENY_ONLY=%s\nIPBLOCK_PATH=%s\nCNP_PATH=%s\nAPI_EGRESS_PATH=%s\nNODES_TESTED=%s\n' \
    "$api_ips" "$1" "$2" "$3" "$4" "$5" "$nodes_tested"
}

if ! reach_all; then
  say "pods cannot reach the API server before any policy exists; probe is inconclusive"
  print_result blocked - - - none
  exit 2
fi

k -n "$NS" apply -f - >/dev/null <<EOF || { say "cannot create deny-all policy"; exit 2; }
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-egress
  namespace: ${NS}
spec:
  podSelector: {}
  policyTypes: ["Egress"]
EOF
sleep "$PROBE_SLEEP"
if reach_any; then
  say "API server still reachable under deny-all egress; NetworkPolicy does not police API egress here"
  print_result reach reach - - none
  exit 2
fi

ipblock_peers="$(for ip in $api_ips; do printf '        - ipBlock:\n            cidr: %s/32\n' "$ip"; done)"
port_list() {
  local indent="$1" p
  for p in $ports; do printf '%s- port: %s\n%s  protocol: TCP\n' "$indent" "$p" "$indent"; done
}
k -n "$NS" apply -f - >/dev/null <<EOF || { say "cannot create ipBlock policy"; exit 2; }
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-ipblock
  namespace: ${NS}
spec:
  podSelector:
    matchLabels: {app: api-probe}
  policyTypes: ["Egress"]
  egress:
    - to:
${ipblock_peers}
      ports:
$(port_list '        ')
EOF
sleep "$PROBE_SLEEP"
if reach_all; then ipblock_path=works; else ipblock_path=blocked; fi

if [ "$cnp_crd" != true ]; then
  cnp_path=no-crd
  say "CiliumNetworkPolicy CRD not found"
else
  k -n "$NS" delete networkpolicy allow-api-ipblock >/dev/null \
    || { say "cannot remove the ipBlock policy before the CNP phase"; exit 2; }
  cnp_ports="$(for p in $ports; do printf '            - port: "%s"\n              protocol: TCP\n' "$p"; done)"
  k -n "$NS" apply -f - >/dev/null <<EOF || { say "cannot create CiliumNetworkPolicy"; exit 2; }
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-api-entity
  namespace: ${NS}
spec:
  endpointSelector:
    matchLabels: {app: api-probe}
  egress:
    - toEntities: [kube-apiserver]
      toPorts:
        - ports:
${cnp_ports}
EOF
  sleep "$PROBE_SLEEP"
  if reach_all; then cnp_path=works; else cnp_path=blocked; fi
fi

if [ "$cnp_path" = works ]; then api_path=cnp
elif [ "$ipblock_path" = works ]; then api_path=ipblock
else api_path=none
fi
print_result reach blocked "$ipblock_path" "$cnp_path" "$api_path"
if [ "$api_path" = none ]; then
  say "neither ipBlock nor CiliumNetworkPolicy reaches the API server under default-deny; do not install"
  exit 1
fi
exit 0
