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
  local actual
  actual="$(RUBYOPT=--disable=gems ruby "$helper" <"${fixture}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "FAIL: unexpected live NetworkPolicy result" >&2
    exit 1
  fi
}

assert_result "${tmp_dir}/valid.json" '{"egress_contract_ok":true,"hcc_lane":true,"proxy_8083":false}'
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

named="$(mutate named 'data["items"].find { |d| d["metadata"]["name"] == "allow-dns-egress-mcp-host" }["spec"]["egress"].first["ports"].first["port"] = "mcp"')"
assert_result "${named}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects named ports"

wide="$(mutate wide 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => {} }, "podSelector" => {} }], "ports" => [{ "port" => 443, "protocol" => "TCP" }] }')"
assert_result "${wide}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":false}'
echo "PASS: live policy helper rejects wide internal selectors"

proxy="$(mutate proxy 'data["items"].find { |d| d["metadata"]["name"] == "mcp-host" }["spec"]["egress"] << { "to" => [{ "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "mcp-server" } }, "podSelector" => { "matchLabels" => { "app" => "mcp-proxy" } } }], "ports" => [{ "port" => 8083, "protocol" => "TCP" }] }')"
assert_result "${proxy}" '{"egress_contract_ok":false,"hcc_lane":true,"proxy_8083":true}'
echo "PASS: live policy helper rejects mcp-proxy TCP 8083"
