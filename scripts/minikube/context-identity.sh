#!/usr/bin/env bash
# Pure predicates that bind a kube context to a local Minikube profile.
#
# Shared by the T2 lane (t2-common.sh) and the branch profile helper
# (scripts/minikube-profiles/branch-profile.sh) so both apply the same rule.
# Every input is an argument, nothing is printed on a negative answer, and no
# function here contacts a cluster: callers fetch the kubeconfig endpoint, the
# node list and the Minikube IP themselves, with their own timeouts.

# kube_endpoint_host <server-url>
# Prints the lowercased host of an API server URL (brackets stripped from an
# IPv6 literal, port and path dropped).
kube_endpoint_host() {
  local host="${1#*://}"
  host="${host%%/*}"
  if [[ "${host}" == \[*\]* ]]; then
    host="${host#\[}"
    host="${host%%\]*}"
  else
    host="${host%%:*}"
  fi
  printf '%s' "${host}" | tr '[:upper:]' '[:lower:]'
}

# kube_endpoint_is_local <server-url>
# Succeeds when the API server is on this machine or a private network:
# loopback, localhost, *.minikube, or a private/loopback/link-local IP literal.
# A DNS name other than localhost and *.minikube is not local.
kube_endpoint_is_local() {
  local host
  host="$(kube_endpoint_host "${1:-}")"
  [[ -n "${host}" ]] || return 1
  if [[ "${host}" == 127.0.0.1 || "${host}" == localhost || "${host}" == ::1 || "${host}" == *.minikube ]]; then
    return 0
  fi
  python3 - "${host}" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if (address.is_private or address.is_loopback or address.is_link_local) else 1)
PY
}

# minikube_nodes_identify_profile <nodes-json> <profile> <ip>
# Succeeds when `kubectl get nodes -o json` output contains a node labelled
# minikube.k8s.io/name=<profile> whose InternalIP is <ip>, the address that
# `minikube -p <profile> ip` reports. A localhost endpoint alone does not prove
# the context belongs to this profile: kubeconfig can point at another local
# Minikube profile, and the private-address allowlist admits LAN clusters.
minikube_nodes_identify_profile() {
  local nodes_json="${1:-}" profile="${2:-}" expected_ip="${3:-}"
  [[ -n "${nodes_json}" && -n "${profile}" && -n "${expected_ip}" ]] || return 1
  python3 - "${nodes_json}" "${profile}" "${expected_ip}" <<'PY'
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except ValueError:
    raise SystemExit(1)
profile = sys.argv[2]
expected_ip = sys.argv[3]
for node in payload.get("items", []):
    metadata = node.get("metadata") or {}
    labels = metadata.get("labels") or {}
    if labels.get("minikube.k8s.io/name") != profile:
        continue
    for address in (node.get("status") or {}).get("addresses", []):
        if address.get("type") == "InternalIP" and address.get("address") == expected_ip:
            raise SystemExit(0)
raise SystemExit(1)
PY
}
