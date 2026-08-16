#!/usr/bin/env bash
set -euo pipefail

# Read-only deployment conformance for NP-08. Every Kubernetes call carries the
# caller-provided context. This script never reads Secret objects, token files,
# pod filesystems, or tenant data; output is limited to booleans/counts.

context=''
read_only=0
redact=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --context)
      context="${2:-}"
      shift 2
      ;;
    --read-only)
      read_only=1
      shift
      ;;
    --redact-identifiers)
      redact=1
      shift
      ;;
    *)
      echo "usage: $0 --context <kube-context> --read-only --redact-identifiers" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${context}" || "${read_only}" -ne 1 || "${redact}" -ne 1 ]]; then
  echo "usage: $0 --context <kube-context> --read-only --redact-identifiers" >&2
  exit 2
fi

check() {
  local name="$1"
  local result="$2"
  if [[ "${result}" != 1 ]]; then
    echo "FAIL: ${name}=false" >&2
    exit 1
  fi
  echo "CHECK ${name}=true"
}

kubectl --context="${context}" get namespace control-plane -o name >/dev/null
kubectl --context="${context}" get namespace mcp-host -o name >/dev/null
kubectl --context="${context}" get namespace mcp-server -o name >/dev/null

hcc_replicas="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller -o jsonpath='{.spec.replicas}')"
hcc_ready="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller -o jsonpath='{.status.readyReplicas}')"
gateway_replicas="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller-api-gateway -o jsonpath='{.spec.replicas}')"
gateway_ready="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller-api-gateway -o jsonpath='{.status.readyReplicas}')"
check hcc_ready "$([[ -n "${hcc_replicas}" && "${hcc_ready}" == "${hcc_replicas}" ]] && echo 1 || echo 0)"
check gateway_ready "$([[ -n "${gateway_replicas}" && "${gateway_ready}" == "${gateway_replicas}" ]] && echo 1 || echo 0)"

hcc_key_ref="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller -o jsonpath='{range .spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="HCC_MCP_HOST_JWT_PUBLIC_KEY")]}{.valueFrom.configMapKeyRef.name}{"/"}{.valueFrom.configMapKeyRef.key}{end}')"
check hcc_public_key_ref "$([[ "${hcc_key_ref}" == 'control-api-public-key/CONTROL_API_PUBLIC_KEY_PEM' ]] && echo 1 || echo 0)"

hcc_issuer_ref="$(kubectl --context="${context}" -n control-plane get deployment host-context-controller -o jsonpath='{range .spec.template.spec.containers[?(@.name=="host-context-controller")].env[?(@.name=="HCC_MCP_HOST_JWT_ISSUER")]}{.valueFrom.configMapKeyRef.name}{"/"}{.valueFrom.configMapKeyRef.key}{end}')"
check hcc_issuer_config_ref "$([[ "${hcc_issuer_ref}" == 'control-api-config/CONTROL_API_ADMIN_JWT_ISSUER' ]] && echo 1 || echo 0)"

proxy_flag="$(kubectl --context="${context}" -n mcp-host get configmap mcp-host-config -o jsonpath='{.data.MCP_PROXY_ENABLED}')"
check mcp_proxy_enabled_false "$([[ "${proxy_flag}" == 'false' ]] && echo 1 || echo 0)"

proxy_replicas="$(kubectl --context="${context}" -n mcp-server get deployment mcp-proxy -o jsonpath='{.spec.replicas}')"
proxy_ready="$(kubectl --context="${context}" -n mcp-server get deployment mcp-proxy -o jsonpath='{.status.readyReplicas}')"
check proxy_singleton_replicas "$([[ "${proxy_replicas}" == '1' ]] && echo 1 || echo 0)"
check proxy_singleton_ready "$([[ "${proxy_ready}" == '1' ]] && echo 1 || echo 0)"

host_proxy_ports="$(kubectl --context="${context}" -n mcp-host get networkpolicies -o jsonpath='{range .items[*].spec.egress[*].ports[*]}{.port}{"\n"}{end}')"
if rg -x -q '8083' <<<"${host_proxy_ports}"; then
  host_proxy_8083_ok=0
else
  host_proxy_8083_ok=1
fi
check no_host_proxy_8083_egress "${host_proxy_8083_ok}"

gateway_config="$(kubectl --context="${context}" -n control-plane get configmap host-context-controller-api-gateway -o jsonpath='{.data.nginx\.conf}')"
check v1_context_tombstone "$(rg -q 'location ~ \^/api/v1/mcpservers/context/\[\^/\]\+\$' <<<"${gateway_config}" && rg -q 'return 410' <<<"${gateway_config}" && echo 1 || echo 0)"
check v1_auth_tombstone "$(rg -q 'location ~ \^/api/v1/mcpservers/\[\^/\]\+/auth\$' <<<"${gateway_config}" && rg -q 'return 410' <<<"${gateway_config}" && echo 1 || echo 0)"
check v2_host_routes "$(rg -q '/api/v2/hosts/self/mcpservers' <<<"${gateway_config}" && rg -q '/api/v2/hosts/self/mcpservers/credential' <<<"${gateway_config}" && echo 1 || echo 0)"

echo 'PASS: NP-08 read-only HCC deployment conformance'
