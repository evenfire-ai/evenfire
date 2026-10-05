#!/usr/bin/env bash
# Read-only discovery for an Evenfire install on an existing DOKS cluster.
#
# Prints KEY=value lines the guide and write-network-patches.sh consume, and
# stops (exit 1, "STOP:" on stderr) on conditions the guide cannot handle.
# Every doctl call is pinned with --context "$DOCTL_CONTEXT" (never
# `doctl auth switch`); every kubectl call is a `get` pinned to "$CONTEXT".
#
# Required env: DOCTL_CONTEXT, CLUSTER_NAME, CONTEXT. Optional: DOCTL, KUBECTL.
#
# Output keys: ACCOUNT_TEAM CLUSTER_ID VERSION HA AUTO_UPGRADE SURGE_UPGRADE
# VPC_NATIVE API_IPS API_ENDPOINT_PORT DNS_IP NODELOCAL_DNS_IP DEFAULT_SC
# RETAIN_SC_PRESENT CNP_CRD CILIUM_POLICY_CIDR_MATCH_MODE CILIUM_IMAGE DO_CCNPS
# LB_DEFAULT
set -uo pipefail

: "${DOCTL_CONTEXT:?set DOCTL_CONTEXT (the doctl auth context name)}"
: "${CLUSTER_NAME:?set CLUSTER_NAME}"
: "${CONTEXT:?set CONTEXT (the kubeconfig context)}"
d() { "${DOCTL:-doctl}" --context "$DOCTL_CONTEXT" "$@"; }
kc() { "${KUBECTL:-kubectl}" --context "$CONTEXT" "$@"; }
die() { printf 'doks-discover: STOP: %s\n' "$*" >&2; exit 1; }
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

account_json="$(d account get -o json)" || die "doctl account get failed for context $DOCTL_CONTEXT"
cluster_json="$(d kubernetes cluster get "$CLUSTER_NAME" -o json)" || die "doctl cannot read cluster $CLUSTER_NAME"

# godo marks ha, auto_upgrade and surge_upgrade omitempty: a missing key is false.
cluster_kv="$(ACCOUNT="$account_json" CLUSTER="$cluster_json" ruby -rjson -e '
  one = ->(s) { v = JSON.parse(s); v.is_a?(Array) ? v.first : v }
  a = one.(ENV.fetch("ACCOUNT")) || {}
  c = one.(ENV.fetch("CLUSTER")) || {}
  b = ->(k) { c[k] == true ? "true" : "false" }
  ver = c["version"].to_s
  m = ver.match(/\A(\d+)\.(\d+)\.(\d+)-do\.(\d+)\z/)
  lb = if m.nil? then "unknown"
       elsif (m.captures.map(&:to_i) <=> [1, 33, 1, 0]) >= 0 then "REGIONAL_NETWORK"
       else "REGIONAL" end
  vpc = c["cluster_subnet"].to_s.empty? || c["service_subnet"].to_s.empty? ? "no" : "yes"
  puts "ACCOUNT_TEAM=#{a.dig("team", "name")}"
  puts "CLUSTER_ID=#{c["id"]}"
  puts "VERSION=#{ver}"
  puts "STATE=#{c.dig("status", "state")}"
  puts "HA=#{b.("ha")}"
  puts "AUTO_UPGRADE=#{b.("auto_upgrade")}"
  puts "SURGE_UPGRADE=#{b.("surge_upgrade")}"
  puts "VPC_NATIVE=#{vpc}"
  puts "LB_DEFAULT=#{lb}"
')" || die "cannot parse doctl JSON"
state="$(printf '%s\n' "$cluster_kv" | sed -n 's/^STATE=//p')"
[ "$state" = running ] || die "cluster $CLUSTER_NAME is '$state', not running"
printf '%s\n' "$cluster_kv" | grep -v '^STATE='

cluster_ip="$(kc -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')"
ep_ips="$(kc -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{range .endpoints[*]}{.addresses[*]}{" "}{end}{end}')"
ep_port="$(kc -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[0].ports[0].port}')"
dns_ip="$(kc -n kube-system get service kube-dns -o jsonpath='{.spec.clusterIP}')"
api_ips="$(printf '%s\n' "$cluster_ip" $ep_ips | awk 'NF && !seen[$0]++' | paste -sd' ' -)"
[ -n "$cluster_ip" ] && [ -n "$(printf '%s' "$ep_ips" | tr -d ' ')" ] || die "cannot read the kubernetes Service and its endpoints"
for ip in $api_ips $dns_ip; do
  is_ipv4 "$ip" || die "'$ip' is not IPv4 (DOKS does not support IPv6 clusters; this guide covers IPv4 only)"
done
[[ "$ep_port" =~ ^[0-9]+$ ]] || die "cannot read the kubernetes EndpointSlice port"
if kc -n kube-system get daemonset node-local-dns -o name >/dev/null 2>&1; then
  die "node-local-dns is installed (not a DOKS default); read its listen IP from its config and pass NODELOCAL_DNS_IP to write-network-patches.sh by hand"
fi
printf 'API_IPS=%s\nAPI_ENDPOINT_PORT=%s\nDNS_IP=%s\nNODELOCAL_DNS_IP=\n' "$api_ips" "$ep_port" "$dns_ip"

sc_kv="$(kc get storageclass -o json | ruby -rjson -e '
  items = JSON.parse(STDIN.read)["items"]
  dflt = items.select { |s| (s.dig("metadata", "annotations") || {})["storageclass.kubernetes.io/is-default-class"] == "true" }
  puts "DEFAULT_SC=#{dflt.size == 1 ? dflt[0]["metadata"]["name"] : ""}"
  puts "DEFAULT_SC_COUNT=#{dflt.size}"
  puts "RETAIN_SC_PRESENT=#{items.any? { |s| s["metadata"]["name"] == "do-block-storage-retain" } ? "yes" : "no"}"
')" || die "cannot list StorageClasses"
[ "$(printf '%s\n' "$sc_kv" | sed -n 's/^DEFAULT_SC_COUNT=//p')" = 1 ] \
  || die "need exactly one default StorageClass (WorkflowRecipe output PVCs request none); ask the human"
printf '%s\n' "$sc_kv" | grep -v '^DEFAULT_SC_COUNT='

if kc get crd ciliumnetworkpolicies.cilium.io -o name >/dev/null 2>&1; then cnp=yes; else cnp=no; fi
cidr_mode="$(kc -n kube-system get configmap cilium-config -o json | ruby -rjson -e '
  v = (JSON.parse(STDIN.read)["data"] || {})["policy-cidr-match-mode"].to_s
  puts(v.empty? ? "unset" : v)')"
cilium_image="$(kc -n kube-system get daemonset cilium \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}' | sed -n 's/^cilium-agent=//p')"
ccnps="$(kc get ciliumclusterwidenetworkpolicies -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)"
printf 'CNP_CRD=%s\nCILIUM_POLICY_CIDR_MATCH_MODE=%s\nCILIUM_IMAGE=%s\nDO_CCNPS=%s\n' \
  "$cnp" "${cidr_mode:-unknown}" "${cilium_image:-unknown}" "$ccnps"
