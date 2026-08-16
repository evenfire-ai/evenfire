#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || ! -f "$1" ]]; then
  echo "usage: $0 <valid-rendered-yaml>" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACT="${ROOT}/scripts/tests/test-np08-render-contract.sh"
SOURCE_RENDER="$1"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/np08-render-contract.XXXXXX")"
trap 'rm -rf "${tmpdir}"' EXIT

mutate_render() {
  local mutation="$1"
  local destination="$2"
  RUBYOPT=--disable=gems ruby -ryaml - "${mutation}" "${SOURCE_RENDER}" >"${destination}" <<'RUBY'
mutation, source = ARGV
documents = YAML.load_stream(File.read(source)).select { |document| document.is_a?(Hash) }

case mutation
when 'broad-egress'
  policy = documents.find do |document|
    document['kind'] == 'NetworkPolicy' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host'
  end
  abort('fixture source is missing mcp-host NetworkPolicy') unless policy
  policy.fetch('spec').fetch('egress') << {
    'to' => [
      {
        'namespaceSelector' => {
          'matchLabels' => { 'kubernetes.io/metadata.name' => 'mcp-server' },
        },
      },
    ],
  }
when 'host-secret-grant'
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'Role',
    'metadata' => { 'name' => 'fixture-host-secret-reader', 'namespace' => 'mcp-server' },
    'rules' => [
      { 'apiGroups' => [''], 'resources' => ['secrets'], 'verbs' => ['get'] },
    ],
  }
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'RoleBinding',
    'metadata' => { 'name' => 'fixture-host-secret-reader', 'namespace' => 'mcp-server' },
    'roleRef' => {
      'apiGroup' => 'rbac.authorization.k8s.io',
      'kind' => 'Role',
      'name' => 'fixture-host-secret-reader',
    },
    'subjects' => [
      { 'kind' => 'ServiceAccount', 'name' => 'host-fixture-sa', 'namespace' => 'mcp-host' },
    ],
  }
else
  abort("unknown fixture mutation: #{mutation}")
end

puts documents.map { |document| YAML.dump(document) }.join("---\n")
RUBY
}

assert_rejected() {
  local rendered="$1"
  local expected="$2"
  local label="$3"
  local output="${tmpdir}/${label}.out"

  if bash "${CONTRACT}" "${rendered}" >"${output}" 2>&1; then
    echo "FAIL: NP-08 render contract accepted ${label}" >&2
    exit 1
  fi
  if ! grep -Fq -- "${expected}" "${output}"; then
    echo "FAIL: NP-08 render contract rejected ${label} for an unexpected reason" >&2
    sed -n '1,80p' "${output}" >&2
    exit 1
  fi
  echo "PASS: NP-08 render contract rejects ${label}"
}

broad_egress="${tmpdir}/broad-egress.yaml"
mutate_render broad-egress "${broad_egress}"
assert_rejected \
  "${broad_egress}" \
  'mcp-host must not gain broad destination or all-port egress' \
  'broad mcp-host egress'

host_secret_grant="${tmpdir}/host-secret-grant.yaml"
mutate_render host-secret-grant "${host_secret_grant}"
assert_rejected \
  "${host_secret_grant}" \
  'mcp-host ServiceAccounts must not receive MCP Secret read grants' \
  'mcp-host MCP Secret grant'
