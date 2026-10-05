#!/usr/bin/env bash
# Read-only discovery for an Evenfire install on an existing DOKS cluster.
#
# Prints shell-sourceable KEY=value lines (values quoted) that the guide and
# write-network-patches.sh consume, and stops (exit 1, "STOP:" on stderr) on
# conditions the guide cannot handle. Every doctl call is pinned with
# --context "$DOCTL_CONTEXT" (never `doctl auth switch`); every kubectl call is
# a `get` pinned to "$CONTEXT".
#
# Required env: DOCTL_CONTEXT, CLUSTER_NAME, CONTEXT. Optional: DOCTL, KUBECTL.
#
# Output keys: ACCOUNT_TEAM CLUSTER_ID VERSION HA AUTO_UPGRADE SURGE_UPGRADE
# VPC_NATIVE LB_DEFAULT API_IPS API_ENDPOINT_PORT DNS_IP NODELOCAL_DNS_IP
# DEFAULT_SC RETAIN_SC_PRESENT CNP_CRD CILIUM_POLICY_CIDR_MATCH_MODE
# CILIUM_IMAGE DO_CCNPS
set -uo pipefail

: "${DOCTL_CONTEXT:?set DOCTL_CONTEXT (the doctl auth context name)}"
: "${CLUSTER_NAME:?set CLUSTER_NAME}"
: "${CONTEXT:?set CONTEXT (the kubeconfig context)}"
d() { "${DOCTL:-doctl}" --context "$DOCTL_CONTEXT" "$@"; }
kc() { "${KUBECTL:-kubectl}" --context "$CONTEXT" "$@"; }
die() { printf 'doks-discover: STOP: %s\n' "$*" >&2; exit 1; }
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
kv() { printf "%s='%s'\n" "$1" "${2//\'/\'\\\'\'}"; }

account_json="$(d account get -o json)" || die "doctl account get failed for context $DOCTL_CONTEXT"
cluster_json="$(d kubernetes cluster get "$CLUSTER_NAME" -o json)" || die "doctl cannot read cluster $CLUSTER_NAME"

# godo marks ha, auto_upgrade and surge_upgrade omitempty: a missing key is false.
# VPC_NATIVE: doctl documents that the default subnets 10.244.0.0/16 and
# 10.245.0.0/16 create a cluster "with a virtual network" and custom ones a
# "vpc-native cluster" (`doctl kubernetes cluster create --help`).
cluster_kv="$(ACCOUNT="$account_json" CLUSTER="$cluster_json" ruby -rjson -rshellwords -e '
  one = ->(s) { v = JSON.parse(s); v.is_a?(Array) ? v.first : v }
  a = one.(ENV.fetch("ACCOUNT")) || {}
  c = one.(ENV.fetch("CLUSTER")) || {}
  b = ->(k) { c[k] == true ? "true" : "false" }
  ver = c["version"].to_s
  m = ver.match(/\A(\d+)\.(\d+)\.(\d+)-do\.(\d+)\z/)
  lb = if m.nil? then "unknown"
       elsif (m.captures.map(&:to_i) <=> [1, 33, 1, 0]) >= 0 then "REGIONAL_NETWORK"
       else "REGIONAL" end
  cs, ss = c["cluster_subnet"].to_s, c["service_subnet"].to_s
  vpc = if cs.empty? || ss.empty? then "unknown"
        elsif cs == "10.244.0.0/16" && ss == "10.245.0.0/16" then "no"
        else "yes" end
  out = { "ACCOUNT_TEAM" => a.dig("team", "name"), "CLUSTER_ID" => c["id"], "VERSION" => ver,
          "STATE" => c.dig("status", "state"), "HA" => b.("ha"), "AUTO_UPGRADE" => b.("auto_upgrade"),
          "SURGE_UPGRADE" => b.("surge_upgrade"), "VPC_NATIVE" => vpc, "LB_DEFAULT" => lb }
  out.each { |k, v| puts "#{k}=#{v.to_s.shellescape}" }
')" || die "cannot parse doctl JSON"
state="$(STATE_KV="$cluster_kv" bash -c 'eval "$STATE_KV"; printf "%s" "$STATE"')"
[ "$state" = running ] || die "cluster $CLUSTER_NAME is '$state', not running"
lb_default="$(KVS="$cluster_kv" bash -c 'eval "$KVS"; printf "%s" "$LB_DEFAULT"')"
[ "$lb_default" != unknown ] || die "cannot parse the DOKS version; set the load balancer type by hand and ask the human"
printf '%s\n' "$cluster_kv" | grep -v '^STATE='

cluster_ip="$(kc -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')"
ep_ips="$(kc -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{range .endpoints[*]}{.addresses[*]}{" "}{end}{end}')"
ep_ports="$(kc -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[*].ports[*].port}' | tr ' ' '\n' | awk 'NF' | sort -u)"
dns_ip="$(kc -n kube-system get service kube-dns -o jsonpath='{.spec.clusterIP}')"
[ -n "$cluster_ip" ] && [ -n "$(printf '%s' "$ep_ips" | tr -d ' ')" ] || die "cannot read the kubernetes Service and its endpoints"
[ -n "$dns_ip" ] || die "cannot read the kube-system/kube-dns Service ClusterIP"
[ "$(printf '%s\n' "$ep_ports" | awk 'NF' | wc -l | tr -d ' ')" = 1 ] \
  || die "kubernetes EndpointSlices expose ports [$(printf '%s ' $ep_ports)]; expected exactly one"
[[ "$ep_ports" =~ ^[0-9]+$ ]] || die "cannot read the kubernetes EndpointSlice port"
api_ips="$(printf '%s\n' "$cluster_ip" $ep_ips | awk 'NF && !seen[$0]++' | paste -sd' ' -)"
for ip in $api_ips $dns_ip; do
  is_ipv4 "$ip" || die "'$ip' is not IPv4 (DOKS does not support IPv6 clusters; this guide covers IPv4 only)"
done
if kc -n kube-system get daemonset node-local-dns -o name >/dev/null 2>&1; then
  die "node-local-dns is installed (not a DOKS default); read its listen IP from its config and pass NODELOCAL_DNS_IP to write-network-patches.sh by hand"
fi
kv API_IPS "$api_ips"
kv API_ENDPOINT_PORT "$ep_ports"
kv DNS_IP "$dns_ip"
kv NODELOCAL_DNS_IP ""

sc_kv="$(kc get storageclass -o json | ruby -rjson -e '
  items = JSON.parse(STDIN.read)["items"]
  dflt = items.select { |s| (s.dig("metadata", "annotations") || {})["storageclass.kubernetes.io/is-default-class"] == "true" }
  puts(dflt.size == 1 ? dflt[0]["metadata"]["name"] : "")
  puts dflt.size
  puts(items.any? { |s| s["metadata"]["name"] == "do-block-storage-retain" } ? "yes" : "no")
')" || die "cannot list StorageClasses"
default_sc="$(sed -n 1p <<<"$sc_kv")"
[ "$(sed -n 2p <<<"$sc_kv")" = 1 ] \
  || die "need exactly one default StorageClass (WorkflowRecipe output PVCs request none); ask the human"
kv DEFAULT_SC "$default_sc"
kv RETAIN_SC_PRESENT "$(sed -n 3p <<<"$sc_kv")"

if kc get crd ciliumnetworkpolicies.cilium.io -o name >/dev/null 2>&1; then cnp=yes; else cnp=no; fi
cidr_mode="$(kc -n kube-system get configmap cilium-config -o json | ruby -rjson -e '
  v = (JSON.parse(STDIN.read)["data"] || {})["policy-cidr-match-mode"].to_s
  puts(v.empty? ? "unset" : v)')"
cilium_image="$(kc -n kube-system get daemonset cilium \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}' | sed -n 's/^cilium-agent=//p')"
ccnps="$(kc get ciliumclusterwidenetworkpolicies -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)"
kv CNP_CRD "$cnp"
kv CILIUM_POLICY_CIDR_MATCH_MODE "${cidr_mode:-unknown}"
kv CILIUM_IMAGE "${cilium_image:-unknown}"
kv DO_CCNPS "$ccnps"
