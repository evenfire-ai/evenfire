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
when 'mcp-server-egress'
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
    'ports' => [{ 'port' => 443, 'protocol' => 'TCP' }],
  }
when 'wide-internal-egress'
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
          'matchLabels' => { 'kubernetes.io/metadata.name' => 'control-plane' },
        },
      },
    ],
    'ports' => [{ 'port' => 443, 'protocol' => 'TCP' }],
  }
when 'broad-internal-expression'
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
          'matchLabels' => { 'kubernetes.io/metadata.name' => 'control-plane' },
          'matchExpressions' => [{ 'key' => 'app', 'operator' => 'Exists' }],
        },
        'podSelector' => {
          'matchExpressions' => [{ 'key' => 'app', 'operator' => 'Exists' }],
        },
      },
    ],
    'ports' => [{ 'port' => 443, 'protocol' => 'TCP' }],
  }
when 'named-port'
  policy = documents.find do |document|
    document['kind'] == 'NetworkPolicy' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host'
  end
  abort('fixture source is missing mcp-host NetworkPolicy') unless policy
  policy.fetch('spec').fetch('egress') << {
    'to' => [{ 'ipBlock' => { 'cidr' => '198.51.100.1/32' } }],
    'ports' => [{ 'port' => 'mcp-http', 'protocol' => 'TCP' }],
  }
when 'invalid-host-selector'
  policies = documents.select do |document|
    document['kind'] == 'NetworkPolicy' && document.dig('metadata', 'namespace') == 'mcp-host'
  end
  abort('fixture source is missing mcp-host NetworkPolicies') if policies.empty?
  policies.each do |policy|
    policy['spec']['podSelector'] = { 'matchLabels' => { 'np08.invalid/never' => 'true' } }
  end
when 'missing-egress-policy-type'
  policy = documents.find do |document|
    document['kind'] == 'NetworkPolicy' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host'
  end
  abort('fixture source is missing mcp-host NetworkPolicy') unless policy
  policy['spec']['policyTypes'] = ['Ingress']
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
when 'host-secret-user-grant', 'host-secret-group-grant'
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'Role',
    'metadata' => { 'name' => "fixture-#{mutation}", 'namespace' => 'mcp-server' },
    'rules' => [
      { 'apiGroups' => [''], 'resources' => ['secrets'], 'verbs' => ['get'] },
    ],
  }
  subject = if mutation == 'host-secret-user-grant'
    { 'kind' => 'User', 'name' => 'system:serviceaccount:mcp-host:fixture-host-sa' }
  else
    { 'kind' => 'Group', 'name' => 'system:serviceaccounts:mcp-host' }
  end
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'RoleBinding',
    'metadata' => { 'name' => "fixture-#{mutation}", 'namespace' => 'mcp-server' },
    'roleRef' => {
      'apiGroup' => 'rbac.authorization.k8s.io',
      'kind' => 'Role',
      'name' => "fixture-#{mutation}",
    },
    'subjects' => [subject],
  }
when 'host-secret-authenticated-group-grant'
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'Role',
    'metadata' => { 'name' => 'fixture-host-secret-authenticated-reader', 'namespace' => 'mcp-server' },
    'rules' => [
      { 'apiGroups' => [''], 'resources' => ['secrets'], 'verbs' => ['get'] },
    ],
  }
  documents << {
    'apiVersion' => 'rbac.authorization.k8s.io/v1',
    'kind' => 'RoleBinding',
    'metadata' => { 'name' => 'fixture-host-secret-authenticated-reader', 'namespace' => 'mcp-server' },
    'roleRef' => {
      'apiGroup' => 'rbac.authorization.k8s.io',
      'kind' => 'Role',
      'name' => 'fixture-host-secret-authenticated-reader',
    },
    'subjects' => [{ 'kind' => 'Group', 'name' => 'system:authenticated' }],
  }
when 'authority-staleness-60s', 'poll-interval-60s'
  host_config = documents.find do |document|
    document['kind'] == 'ConfigMap' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host-config'
  end
  abort('fixture source is missing mcp-host/mcp-host-config') unless host_config
  key = if mutation == 'authority-staleness-60s'
    'HCC_AUTHORITY_MAX_STALENESS_MS'
  else
    'CLERUM_CONTEXT_MAPPER_POLL_INTERVAL'
  end
  data = host_config.fetch('data')
  abort("fixture source mcp-host-config has no #{key}") unless data.key?(key)
  data[key] = '60000'
when 'poll-interval-not-digits'
  host_config = documents.find do |document|
    document['kind'] == 'ConfigMap' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host-config'
  end
  abort('fixture source is missing mcp-host/mcp-host-config') unless host_config
  data = host_config.fetch('data')
  abort('fixture source mcp-host-config has no CLERUM_CONTEXT_MAPPER_POLL_INTERVAL') unless data.key?('CLERUM_CONTEXT_MAPPER_POLL_INTERVAL')
  data['CLERUM_CONTEXT_MAPPER_POLL_INTERVAL'] = '30s'
when 'authority-staleness-below-rule'
  host_config = documents.find do |document|
    document['kind'] == 'ConfigMap' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == 'mcp-host-config'
  end
  abort('fixture source is missing mcp-host/mcp-host-config') unless host_config
  data = host_config.fetch('data')
  abort('fixture source mcp-host-config has no HCC_AUTHORITY_MAX_STALENESS_MS') unless data.key?('HCC_AUTHORITY_MAX_STALENESS_MS')
  # One millisecond below the two-missed-poll floor at the 30000ms interval.
  data['HCC_AUTHORITY_MAX_STALENESS_MS'] = '100999'
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

mcp_server_egress="${tmpdir}/mcp-server-egress.yaml"
mutate_render mcp-server-egress "${mcp_server_egress}"
assert_rejected \
  "${mcp_server_egress}" \
  'mcp-host must not gain broad internal or mcp-server egress' \
  'mcp-server egress with explicit port'

wide_internal_egress="${tmpdir}/wide-internal-egress.yaml"
mutate_render wide-internal-egress "${wide_internal_egress}"
assert_rejected \
  "${wide_internal_egress}" \
  'mcp-host must not gain broad internal or mcp-server egress' \
  'wide internal egress selector'

broad_internal_expression="${tmpdir}/broad-internal-expression.yaml"
mutate_render broad-internal-expression "${broad_internal_expression}"
assert_rejected \
  "${broad_internal_expression}" \
  'mcp-host must not gain broad internal or mcp-server egress' \
  'broad internal matchExpression selector'

named_port="${tmpdir}/named-port.yaml"
mutate_render named-port "${named_port}"
assert_rejected \
  "${named_port}" \
  'mcp-host egress must use numeric ports' \
  'named mcp-host egress port'

invalid_host_selector="${tmpdir}/invalid-host-selector.yaml"
mutate_render invalid-host-selector "${invalid_host_selector}"
assert_rejected \
  "${invalid_host_selector}" \
  'mcp-host default-deny must select every pod and enforce Egress' \
  'mcp-host policies with ineffective selectors'

missing_egress_policy_type="${tmpdir}/missing-egress-policy-type.yaml"
mutate_render missing-egress-policy-type "${missing_egress_policy_type}"
assert_rejected \
  "${missing_egress_policy_type}" \
  'mcp-host allow policy must select HCC-managed Host pods and enforce Egress' \
  'mcp-host policy without Egress type'

host_secret_grant="${tmpdir}/host-secret-grant.yaml"
mutate_render host-secret-grant "${host_secret_grant}"
assert_rejected \
  "${host_secret_grant}" \
  'mcp-host identities must not receive MCP Secret read grants' \
  'mcp-host MCP Secret grant'

for identity in user group; do
  host_secret_identity="${tmpdir}/host-secret-${identity}-grant.yaml"
  mutate_render "host-secret-${identity}-grant" "${host_secret_identity}"
  assert_rejected \
    "${host_secret_identity}" \
    'mcp-host identities must not receive MCP Secret read grants' \
    "mcp-host MCP Secret ${identity} grant"
done

host_secret_authenticated_group="${tmpdir}/host-secret-authenticated-group-grant.yaml"
mutate_render host-secret-authenticated-group-grant "${host_secret_authenticated_group}"
assert_rejected \
  "${host_secret_authenticated_group}" \
  'mcp-host identities must not receive MCP Secret read grants' \
  'mcp-host MCP Secret system:authenticated grant'

# Issue #1350: 60000 tolerates no missed HCC poll at a 30000ms interval.
authority_staleness_60s="${tmpdir}/authority-staleness-60s.yaml"
mutate_render authority-staleness-60s "${authority_staleness_60s}"
assert_rejected \
  "${authority_staleness_60s}" \
  'NP-08 render contract: HCC_AUTHORITY_MAX_STALENESS_MS must be "180000"' \
  'mcp-host authority staleness of 60000ms'

poll_interval_60s="${tmpdir}/poll-interval-60s.yaml"
mutate_render poll-interval-60s "${poll_interval_60s}"
assert_rejected \
  "${poll_interval_60s}" \
  'NP-08 render contract: CLERUM_CONTEXT_MAPPER_POLL_INTERVAL must be "30000"' \
  'mcp-host context mapper poll interval of 60000ms'

# #1350: the rule itself, computed from mcp-host/src/config.ts. 101000 below
# is produced by the contract's computation, not typed into it.
authority_staleness_below_rule="${tmpdir}/authority-staleness-below-rule.yaml"
mutate_render authority-staleness-below-rule "${authority_staleness_below_rule}"
assert_rejected \
  "${authority_staleness_below_rule}" \
  '+ 10000 + 1000 = 101000ms; got HCC_AUTHORITY_MAX_STALENESS_MS=100999 and CLERUM_CONTEXT_MAPPER_POLL_INTERVAL=30000' \
  'mcp-host authority staleness one millisecond below the rule'

# A source whose request timeout grows to 60000ms makes the shipped
# 180000/30000 pair break the rule; the contract must follow the source.
slow_request_source="${tmpdir}/config-request-timeout-60s.ts"
RUBYOPT=--disable=gems ruby -e '
  source, destination = ARGV
  text = File.read(source, encoding: "UTF-8")
  pattern = /^export const CONTEXT_MAPPER_REQUEST_TIMEOUT_MS = [0-9_]+$/
  abort("fixture: expected exactly one CONTEXT_MAPPER_REQUEST_TIMEOUT_MS in #{source}") unless text.scan(pattern).length == 1
  File.write(destination, text.sub(pattern, "export const CONTEXT_MAPPER_REQUEST_TIMEOUT_MS = 60_000"))
' "${ROOT}/mcp-host/src/config.ts" "${slow_request_source}"
NP08_MCP_HOST_CONFIG_SOURCE="${slow_request_source}" assert_rejected \
  "${SOURCE_RENDER}" \
  '+ 60000 + 1000 = 211000ms; got HCC_AUTHORITY_MAX_STALENESS_MS=180000 and CLERUM_CONTEXT_MAPPER_POLL_INTERVAL=30000' \
  'the shipped authority pair under a 60000ms request timeout'

poll_interval_not_digits="${tmpdir}/poll-interval-not-digits.yaml"
mutate_render poll-interval-not-digits "${poll_interval_not_digits}"
assert_rejected \
  "${poll_interval_not_digits}" \
  'must be positive safe integers' \
  'a mcp-host context mapper poll interval that is not plain digits'

# A source the extractor cannot read must stop the contract, not pass it.
source_without_timeout="${tmpdir}/config-without-request-timeout.ts"
RUBYOPT=--disable=gems ruby -e '
  source, destination = ARGV
  text = File.read(source, encoding: "UTF-8")
  pattern = /^export const CONTEXT_MAPPER_REQUEST_TIMEOUT_MS = [0-9_]+$/
  abort("fixture: expected exactly one CONTEXT_MAPPER_REQUEST_TIMEOUT_MS in #{source}") unless text.scan(pattern).length == 1
  File.write(destination, text.sub(pattern, "const contextMapperRequestTimeoutRenamed = 10_000"))
' "${ROOT}/mcp-host/src/config.ts" "${source_without_timeout}"
NP08_MCP_HOST_CONFIG_SOURCE="${source_without_timeout}" assert_rejected \
  "${SOURCE_RENDER}" \
  'expected exactly one CONTEXT_MAPPER_REQUEST_TIMEOUT_MS' \
  'an mcp-host source without the request timeout constant'

# The overlay pin must follow the source default.
source_default_45s="${tmpdir}/config-default-interval-45s.ts"
RUBYOPT=--disable=gems ruby -e '
  source, destination = ARGV
  text = File.read(source, encoding: "UTF-8")
  literal = "getEnv(\x27CLERUM_CONTEXT_MAPPER_POLL_INTERVAL\x27, \x2730000\x27)"
  abort("fixture: expected exactly one poll interval default in #{source}") unless text.scan(literal).length == 1
  File.write(destination, text.sub(literal, "getEnv(\x27CLERUM_CONTEXT_MAPPER_POLL_INTERVAL\x27, \x2745000\x27)"))
' "${ROOT}/mcp-host/src/config.ts" "${source_default_45s}"
NP08_MCP_HOST_CONFIG_SOURCE="${source_default_45s}" assert_rejected \
  "${SOURCE_RENDER}" \
  'must equal the mcp-host source defaults' \
  'an overlay pin that differs from the source default'
