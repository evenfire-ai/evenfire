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
when 'dns-without-execution-exclusion', 'k8s-api-wrong-execution-exclusion',
     'execution-egress', 'execution-ingress-widened'
  name = {
    'dns-without-execution-exclusion' => 'allow-dns-egress-mcp-host',
    'k8s-api-wrong-execution-exclusion' => 'allow-k8s-api-egress-mcp-host',
    'execution-egress' => 'host-execution-private',
    'execution-ingress-widened' => 'host-execution-private',
  }.fetch(mutation)
  policy = documents.find do |document|
    document['kind'] == 'NetworkPolicy' &&
      document.dig('metadata', 'namespace') == 'mcp-host' &&
      document.dig('metadata', 'name') == name
  end
  abort("fixture source is missing mcp-host NetworkPolicy #{name}") unless policy
  case mutation
  when 'dns-without-execution-exclusion'
    policy['spec']['podSelector'].delete('matchExpressions')
  when 'k8s-api-wrong-execution-exclusion'
    policy['spec']['podSelector']['matchExpressions'][0]['values'] = ['other']
  when 'execution-egress'
    policy['spec']['egress'] = [{
      'to' => [{ 'namespaceSelector' => { 'matchLabels' => { 'kubernetes.io/metadata.name' => 'kube-system' } } }],
      'ports' => [{ 'port' => 53, 'protocol' => 'UDP' }],
    }]
  when 'execution-ingress-widened'
    policy['spec']['ingress'][0]['from'] << {
      'namespaceSelector' => { 'matchLabels' => { 'kubernetes.io/metadata.name' => 'mcp-server' } },
    }
  end
when 'execution-grant-by-role', 'execution-grant-by-operation'
  pod_selector = if mutation == 'execution-grant-by-role'
    { 'matchExpressions' => [{ 'key' => 'clerum.io/role', 'operator' => 'In', 'values' => ['host-execution'] }] }
  else
    { 'matchLabels' => { 'clerum.io/operation' => 'fixture-operation' } }
  end
  documents << {
    'apiVersion' => 'networking.k8s.io/v1',
    'kind' => 'NetworkPolicy',
    'metadata' => { 'name' => "fixture-#{mutation}", 'namespace' => 'mcp-host' },
    'spec' => {
      'podSelector' => pod_selector,
      'policyTypes' => ['Ingress'],
      'ingress' => [{
        'from' => [{ 'namespaceSelector' => { 'matchLabels' => { 'kubernetes.io/metadata.name' => 'mcp-server' } } }],
        'ports' => [{ 'port' => 9300, 'protocol' => 'TCP' }],
      }],
    },
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

dns_without_execution_exclusion="${tmpdir}/dns-without-execution-exclusion.yaml"
mutate_render dns-without-execution-exclusion "${dns_without_execution_exclusion}"
assert_rejected \
  "${dns_without_execution_exclusion}" \
  'allow-dns-egress-mcp-host must select HCC-managed Host pods except execution Pods and enforce Egress' \
  'DNS egress inherited by execution Pods'

k8s_api_wrong_execution_exclusion="${tmpdir}/k8s-api-wrong-execution-exclusion.yaml"
mutate_render k8s-api-wrong-execution-exclusion "${k8s_api_wrong_execution_exclusion}"
assert_rejected \
  "${k8s_api_wrong_execution_exclusion}" \
  'allow-k8s-api-egress-mcp-host must select HCC-managed Host pods except execution Pods and enforce Egress' \
  'k8s API egress exclusion naming another role'

for execution_change in execution-egress execution-ingress-widened; do
  execution_private="${tmpdir}/${execution_change}.yaml"
  mutate_render "${execution_change}" "${execution_private}"
  assert_rejected \
    "${execution_private}" \
    'host-execution-private must admit only HCC on 9300/9301 and grant no egress' \
    "private execution policy with ${execution_change}"
done

for execution_selector in role operation; do
  execution_grant="${tmpdir}/execution-grant-by-${execution_selector}.yaml"
  mutate_render "execution-grant-by-${execution_selector}" "${execution_grant}"
  assert_rejected \
    "${execution_grant}" \
    "execution Pods must not inherit mcp-host grants: fixture-execution-grant-by-${execution_selector}" \
    "mcp-host grant selecting execution Pods by ${execution_selector}"
done
