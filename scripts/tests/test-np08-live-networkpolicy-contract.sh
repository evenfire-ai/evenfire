#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || ! -f "$1" ]]; then
  echo "usage: $0 <rendered-yaml>" >&2
  exit 2
fi

rendered="$1"
helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/security/check-np08-mcp-host-networkpolicy.rb"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/np08-live-policy-test.XXXXXX")"
trap 'rm -rf "${tmp_dir}"' EXIT

RUBYOPT=--disable=gems ruby -ryaml -rjson -e '
  documents = YAML.load_stream(File.read(ARGV.fetch(0))).select { |d| d.is_a?(Hash) }
  items = documents.select { |d| d["kind"] == "NetworkPolicy" && d.dig("metadata", "namespace") == "mcp-host" }
  File.write(ARGV.fetch(1), JSON.generate("items" => items))
' "$rendered" "${tmp_dir}/valid.json"

assert_result() {
  local fixture="$1"
  local expected="$2"
  local pods="${3:-}"
  local actual
  if [[ -n "${pods}" ]]; then
    actual="$(RUBYOPT=--disable=gems ruby "$helper" --host-pods "${pods}" <"${fixture}")"
  else
    actual="$(RUBYOPT=--disable=gems ruby "$helper" <"${fixture}")"
  fi
  if ! ruby -rjson -e '
    expected = JSON.parse(ARGV.fetch(0))
    actual = JSON.parse(STDIN.read)
    abort unless expected.all? { |key, value| actual[key] == value }
  ' "${expected}" <<<"${actual}"; then
    echo "FAIL: unexpected live NetworkPolicy result" >&2
    exit 1
  fi
}

assert_result "${tmp_dir}/valid.json" '{"egress_contract_ok":true,"selector_contract_ok":true,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper accepts the current render"

mutate() {
  local name="$1"
  local expression="$2"
  local output="${tmp_dir}/${name}.json"
  RUBYOPT=--disable=gems ruby -rjson -e "data = JSON.parse(File.read(ARGV.fetch(0))); ${expression}; File.write(ARGV.fetch(1), JSON.generate(data))" "${tmp_dir}/valid.json" "${output}" || return 1
  printf '%s\n' "${output}"
}

broad="$(mutate broad 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [], "ports" => [] }')"
assert_result "${broad}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects broad/all-port egress"

missing_to="$(mutate missing-to 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "ports" => [{ "port" => 443, "protocol" => "TCP" }] }')"
assert_result "${missing_to}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects missing destinations"

missing_ports="$(mutate missing-ports 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "control-plane" } }, "podSelector" => { "matchLabels" => { "app" => "host-context-controller-api-gateway" } } }] }')"
assert_result "${missing_ports}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects missing ports"

empty_peer="$(mutate empty-peer 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{}], "ports" => [{ "port" => 443, "protocol" => "TCP" }] }')"
assert_result "${empty_peer}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects an empty peer"

named="$(mutate named 'data["items"].find { |d| d["metadata"]["name"] == "allow-dns-egress-mcp-host" }["spec"]["egress"].first["ports"].first["port"] = "mcp"')"
assert_result "${named}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects named ports"

wide="$(mutate wide 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => {} }, "podSelector" => {} }], "ports" => [{ "port" => 443, "protocol" => "TCP" }] }')"
assert_result "${wide}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects wide internal selectors"

broad_expression="$(mutate broad-expression 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "control-plane" }, "matchExpressions" => [{ "key" => "app", "operator" => "Exists" }] }, "podSelector" => { "matchExpressions" => [{ "key" => "app", "operator" => "Exists" }] } }], "ports" => [{ "port" => 443, "protocol" => "TCP" }] }')"
assert_result "${broad_expression}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects broad internal matchExpressions"

mcp_server="$(mutate mcp-server 'data["items"] << { "apiVersion" => "networking.k8s.io/v1", "kind" => "NetworkPolicy", "metadata" => { "name" => "ctx-a-server-a-egress", "namespace" => "mcp-host", "labels" => { "clerum.io/managed-by" => "host-context-controller", "clerum.io/policy-type" => "context-allow", "clerum.io/context" => "context-a", "clerum.io/mcpserver" => "server-a" } }, "spec" => { "podSelector" => { "matchLabels" => { "clerum.io/managed-by" => "host-context-controller", "clerum.io/context" => "context-a" } }, "policyTypes" => ["Egress"], "egress" => [{ "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "mcp-server" } }, "podSelector" => { "matchLabels" => { "clerum.io/mcpserver" => "server-a" } } }], "ports" => [{ "port" => 3000, "protocol" => "TCP" }] }] } }')"
assert_result "${mcp_server}" '{"egress_contract_ok":true,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper accepts a context-scoped MCP server peer"

gfs="$(mutate gfs 'data["items"] << { "apiVersion" => "networking.k8s.io/v1", "kind" => "NetworkPolicy", "metadata" => { "name" => "mcp-host-gfs-egress", "namespace" => "mcp-host" }, "spec" => { "podSelector" => { "matchLabels" => { "app" => "mcp-host" } }, "policyTypes" => ["Egress"], "egress" => [{ "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "gfs" } }, "podSelector" => { "matchLabels" => { "app" => "gfs-controller" } } }], "ports" => [{ "port" => 8087, "protocol" => "TCP" }] }] } }')"
assert_result "${gfs}" '{"egress_contract_ok":true,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper accepts the exact GFS 8087 lane"

gfs_bad_port="$(mutate gfs-bad-port 'data["items"] << { "apiVersion" => "networking.k8s.io/v1", "kind" => "NetworkPolicy", "metadata" => { "name" => "mcp-host-gfs-egress", "namespace" => "mcp-host" }, "spec" => { "podSelector" => { "matchLabels" => { "app" => "mcp-host" } }, "policyTypes" => ["Egress"], "egress" => [{ "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "gfs" } }, "podSelector" => { "matchLabels" => { "app" => "gfs-controller" } } }], "ports" => [{ "port" => 443, "protocol" => "TCP" }] }] } }')"
assert_result "${gfs_bad_port}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects a non-GFS port on the GFS lane"

proxy="$(mutate proxy 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "mcp-server" } }, "podSelector" => { "matchLabels" => { "app" => "mcp-proxy" } } }], "ports" => [{ "port" => 8083, "protocol" => "TCP" }] }')"
assert_result "${proxy}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":true}'
echo "PASS: live policy helper rejects mcp-proxy TCP 8083"

proxy_range="$(mutate proxy-range 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "control-plane" } }, "podSelector" => { "matchLabels" => { "app" => "host-context-controller-api-gateway" } } }], "ports" => [{ "port" => 8000, "endPort" => 9000, "protocol" => "TCP" }] }')"
assert_result "${proxy_range}" '{"egress_contract_ok":true,"hcc_lane":true,"proxy_8083":true}'
echo "PASS: live policy helper rejects a TCP range containing 8083"

invalid_selector="$(mutate invalid-selector 'data["items"].select { |d| d["kind"] == "NetworkPolicy" && d.dig("metadata", "namespace") == "mcp-host" }.each { |d| d["spec"]["podSelector"] = { "matchLabels" => { "np08.invalid/never" => "true" } } }')"
assert_result "${invalid_selector}" '{"egress_contract_ok":true,"selector_contract_ok":false,"hcc_lane":false,"proxy_8083":false}'
echo "PASS: live policy helper rejects ineffective Host selectors"

missing_egress_type="$(mutate missing-egress-type 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["policyTypes"] = ["Ingress"]')"
assert_result "${missing_egress_type}" '{"selector_contract_ok":false,"hcc_lane":false}'
echo "PASS: live policy helper rejects a Host policy without Egress policy type"

dns_without_exclusion="$(mutate dns-without-exclusion 'data["items"].find { |d| d["metadata"]["name"] == "allow-dns-egress-mcp-host" }["spec"]["podSelector"].delete("matchExpressions")')"
assert_result "${dns_without_exclusion}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects a DNS grant that execution Pods inherit"

wrong_exclusion="$(mutate wrong-exclusion 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["podSelector"]["matchExpressions"].first["operator"] = "In"')"
assert_result "${wrong_exclusion}" '{"selector_contract_ok":false,"hcc_lane":false}'
echo "PASS: live policy helper rejects a Host selector narrowed by anything but the execution exclusion"

execution_egress="$(mutate execution-egress 'data["items"].find { |d| d["metadata"]["name"] == "host-execution-private" }["spec"]["egress"] = [{ "to" => [{ "ipBlock" => { "cidr" => "0.0.0.0/0" } }] }]')"
assert_result "${execution_egress}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects egress on the execution policy"

execution_live_shape="$(mutate execution-live-shape 'data["items"].find { |d| d["metadata"]["name"] == "host-execution-private" }["spec"].delete("egress")')"
assert_result "${execution_live_shape}" '{"selector_contract_ok":true,"hcc_lane":true}'
echo "PASS: live policy helper accepts the execution policy as the API server returns it"

execution_ingress="$(mutate execution-ingress 'data["items"].find { |d| d["metadata"]["name"] == "host-execution-private" }["spec"]["ingress"].first["from"] = [{ "namespaceSelector" => {} }]')"
assert_result "${execution_ingress}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects a widened execution ingress"

missing_execution="$(mutate missing-execution 'data["items"].reject! { |d| d["metadata"]["name"] == "host-execution-private" }')"
assert_result "${missing_execution}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects a missing execution policy"

execution_grant() {
  local name="$1"
  local selector="$2"
  mutate "${name}" "data[\"items\"] << { \"apiVersion\" => \"networking.k8s.io/v1\", \"kind\" => \"NetworkPolicy\", \"metadata\" => { \"name\" => \"fixture-${name}\", \"namespace\" => \"mcp-host\" }, \"spec\" => { \"podSelector\" => ${selector}, \"policyTypes\" => [\"Ingress\"], \"ingress\" => [{ \"from\" => [{ \"namespaceSelector\" => { \"matchLabels\" => { \"kubernetes.io/metadata.name\" => \"mcp-server\" } } }], \"ports\" => [{ \"port\" => 9300, \"protocol\" => \"TCP\" }] }] } }"
}

grant_by_role="$(execution_grant grant-by-role '{ "matchLabels" => { "clerum.io/role" => "host-execution" } }')"
assert_result "${grant_by_role}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects a grant selecting execution Pods by role"

grant_by_operation="$(execution_grant grant-by-operation '{ "matchExpressions" => [{ "key" => "clerum.io/operation", "operator" => "Exists" }] }')"
assert_result "${grant_by_operation}" '{"selector_contract_ok":false,"hcc_lane":true}'
echo "PASS: live policy helper rejects a grant selecting execution Pods by operation"

grant_elsewhere="$(execution_grant grant-elsewhere '{ "matchLabels" => { "app" => "unrelated" } }')"
assert_result "${grant_elsewhere}" '{"selector_contract_ok":true,"hcc_lane":true}'
echo "PASS: live policy helper accepts a grant that cannot select execution Pods"

host_pod='{ "metadata": { "name": "host-a", "labels": { "clerum.io/managed-by": "host-context-controller", "clerum.io/context": "context-a" } } }'
execution_pod='{ "metadata": { "name": "exec-a", "labels": { "clerum.io/managed-by": "host-context-controller", "clerum.io/role": "host-execution", "clerum.io/operation": "op-1", "clerum.io/host-uid": "uid-1" } } }'
printf '{ "items": [%s, %s] }' "${host_pod}" "${execution_pod}" >"${tmp_dir}/pods-both.json"
printf '{ "items": [%s] }' "${execution_pod}" >"${tmp_dir}/pods-execution-only.json"
printf '{ "items": [%s] }' "${host_pod}" >"${tmp_dir}/pods-host-only.json"

assert_result "${tmp_dir}/valid.json" '{"selector_contract_ok":true,"hcc_lane":true}' "${tmp_dir}/pods-both.json"
echo "PASS: live pod check accepts a Host pod with egress next to an execution Pod without it"

assert_result "${tmp_dir}/valid.json" '{"selector_contract_ok":false}' "${tmp_dir}/pods-execution-only.json"
echo "PASS: live pod check rejects a namespace with no Host pod"

# The GFS lane selects app=mcp-host, a label execution Pods are not created with,
# so only the pod check can see an execution Pod that carries it.
labelled_execution_pod='{ "metadata": { "name": "exec-b", "labels": { "clerum.io/managed-by": "host-context-controller", "clerum.io/role": "host-execution", "app": "mcp-host" } } }'
printf '{ "items": [%s, %s] }' "${host_pod}" "${labelled_execution_pod}" >"${tmp_dir}/pods-labelled-execution.json"
assert_result "${gfs}" '{"selector_contract_ok":true}' "${tmp_dir}/pods-both.json"
assert_result "${gfs}" '{"selector_contract_ok":false}' "${tmp_dir}/pods-labelled-execution.json"
echo "PASS: live pod check rejects an execution Pod selected by a Host grant through its live labels"

no_host_egress="$(mutate no-host-egress 'data["items"].each { |d| d["spec"]["egress"] = [] if %w[mcp-host allow-dns-egress-mcp-host allow-k8s-api-egress-mcp-host].include?(d["metadata"]["name"]) }')"
assert_result "${no_host_egress}" '{"selector_contract_ok":false}' "${tmp_dir}/pods-host-only.json"
echo "PASS: live pod check rejects a Host pod with no egress grant"
