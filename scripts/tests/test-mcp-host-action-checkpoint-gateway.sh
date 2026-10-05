#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT="$ROOT_DIR/mcp-host/src/runtime/actionAuthorityCheckpointClient.ts"
RPC_CLIENT="$ROOT_DIR/rpc-proxy/src/actionAuthorityV2.ts"
CONTRACT="$ROOT_DIR/packages/action-context-contracts/index.cjs"

checkpoint_path="$(sed -n "s/^const ACTION_AUTHORITY_CHECKPOINT_PATH = '\([^']*\)'$/\1/p" "$CONTRACT")"
if [[ -z "$checkpoint_path" ]]; then
  echo "::error::canonical action checkpoint path is missing"
  exit 1
fi
if ! grep -q 'ACTION_AUTHORITY_CHECKPOINT_PATH' "$CLIENT"; then
  echo "::error::MCP Host checkpoint client no longer uses the canonical route constant"
  exit 1
fi
if ! grep -q 'ACTION_AUTHORITY_CHECKPOINT_PATH' "$RPC_CLIENT"; then
  echo "::error::RPC Proxy checkpoint producer no longer uses the canonical route constant"
  exit 1
fi

for overlay in \
  deploy/overlays/minikube \
  deploy/overlays/minikube-no-uis \
  deploy/overlays/minikube-ghcr \
  deploy/overlays/minikube-no-uis-ghcr; do
  rendered="$(kubectl kustomize "$ROOT_DIR/$overlay")"
  ruby - "$checkpoint_path" "$overlay" 3<<<"$rendered" <<'RUBY'
require 'yaml'

path = ARGV.fetch(0)
overlay = ARGV.fetch(1)
documents = YAML.load_stream(IO.new(3).read)

gateway = documents.find do |document|
  document.is_a?(Hash) && document['kind'] == 'ConfigMap' &&
    document.dig('metadata', 'name') == 'nginx-workflow-approval-gateway'
end
raise "#{overlay}: rendered workflow gateway ConfigMap missing" unless gateway

config = gateway.dig('data', 'nginx.conf')
raise "#{overlay}: rendered nginx.conf missing" unless config.is_a?(String)

lines = config.lines
open_line = "location = #{path} {"
matches = lines.each_index.select { |index| lines[index].strip == open_line }
raise "#{overlay}: expected one exact checkpoint location, found #{matches.length}" unless matches.length == 1

start = matches.first
depth = 0
block = []
lines.drop(start).each do |line|
  block << line
  depth += line.count('{') - line.count('}')
  break if depth.zero?
end
location = block.join
raise "#{overlay}: exact checkpoint location is not POST-only" unless
  location.match?(/limit_except\s+POST\s*\{[^}]*deny all;/m)
raise "#{overlay}: exact checkpoint location does not proxy to Control API" unless
  location.include?('proxy_pass http://control_api_upstream;')
raise "#{overlay}: checkpoint bearer identity is not forwarded" unless
  location.include?('proxy_set_header Authorization $http_authorization;')
raise "#{overlay}: checkpoint location disables request headers" if
  location.match?(/proxy_pass_request_headers\s+off\s*;/)
raise "#{overlay}: broad internal route proxy is not permitted" if
  config.match?(/location\s+(?:\^~\s+)?\/api\/v1\/internal(?:\/|\s*\{)/)
raise "#{overlay}: default-deny catch-all was removed" unless
  config.match?(/location\s+\/\s*\{\s*return 403;/m)

rpc_gateway = documents.find do |document|
  document.is_a?(Hash) && document['kind'] == 'ConfigMap' &&
    document.dig('metadata', 'name') == 'control-api-rpc-gateway'
end
raise "#{overlay}: rendered RPC gateway ConfigMap missing" unless rpc_gateway

rpc_config = rpc_gateway.dig('data', 'nginx.conf')
raise "#{overlay}: rendered RPC gateway nginx.conf missing" unless rpc_config.is_a?(String)

rpc_lines = rpc_config.lines
admission_line = 'location ~ ^/api/v1/rpc/access/users/[^/]+/mcp-hosts/[^/]+/host-rpc-admission$ {'
admission_matches = rpc_lines.each_index.select { |index| rpc_lines[index].strip == admission_line }
raise "#{overlay}: expected one exact Host-RPC admission location, found #{admission_matches.length}" unless
  admission_matches.length == 1

admission_depth = 0
admission_block = []
rpc_lines.drop(admission_matches.first).each do |line|
  admission_block << line
  admission_depth += line.count('{') - line.count('}')
  break if admission_depth.zero?
end
admission_location = admission_block.join
raise "#{overlay}: Host-RPC admission location is not POST-only" unless
  admission_location.match?(/limit_except\s+POST\s*\{[^}]*deny all;/m)
raise "#{overlay}: Host-RPC admission location does not proxy to Control API" unless
  admission_location.include?('proxy_pass http://control_api_upstream;')
[
  'proxy_set_header Authorization $http_authorization;',
  'proxy_set_header X-Service-Token $http_x_service_token;',
  'proxy_set_header X-Rpc-Access-Token $http_x_rpc_access_token;',
].each do |header|
  raise "#{overlay}: Host-RPC admission does not forward #{header}" unless
    admission_location.include?(header)
end
raise "#{overlay}: Host-RPC admission disables request headers" if
  admission_location.match?(/proxy_pass_request_headers\s+off\s*;/)
raise "#{overlay}: broad internal route proxy is not permitted in RPC gateway" if
  rpc_config.match?(/location\s+(?:\^~\s+)?\/api\/v1\/internal(?:\/|\s*\{)/)
raise "#{overlay}: RPC gateway default-deny catch-all was removed" unless
  rpc_config.match?(/location\s+\/\s*\{\s*return 403;/m)

rpc_checkpoint_open = "location = #{path} {"
rpc_checkpoint_matches = rpc_lines.each_index.select { |index| rpc_lines[index].strip == rpc_checkpoint_open }
raise "#{overlay}: expected one exact RPC checkpoint location, found #{rpc_checkpoint_matches.length}" unless
  rpc_checkpoint_matches.length == 1
rpc_checkpoint_depth = 0
rpc_checkpoint_block = []
rpc_lines.drop(rpc_checkpoint_matches.first).each do |line|
  rpc_checkpoint_block << line
  rpc_checkpoint_depth += line.count('{') - line.count('}')
  break if rpc_checkpoint_depth.zero?
end
rpc_checkpoint_location = rpc_checkpoint_block.join
raise "#{overlay}: RPC checkpoint location is not POST-only" unless
  rpc_checkpoint_location.match?(/limit_except\s+POST\s*\{[^}]*deny all;/m)
raise "#{overlay}: RPC checkpoint location does not proxy to Control API" unless
  rpc_checkpoint_location.include?('proxy_pass http://control_api_upstream;')
[
  'proxy_set_header Authorization $http_authorization;',
  'proxy_set_header X-Service-Token $http_x_service_token;',
].each do |header|
  raise "#{overlay}: RPC checkpoint route does not forward #{header}" unless
    rpc_checkpoint_location.include?(header)
end
raise "#{overlay}: RPC checkpoint location disables request headers" if
  rpc_checkpoint_location.match?(/proxy_pass_request_headers\s+off\s*;/)
raise "#{overlay}: broad internal route proxy is not permitted in RPC gateway" if
  rpc_config.match?(/location\s+(?:\^~\s+)?\/api\/v1\/internal(?:\/|\s*\{)/)

rpc_proxy_config = documents.find do |document|
  document.is_a?(Hash) && document['kind'] == 'ConfigMap' &&
    document.dig('metadata', 'name') == 'rpc-proxy-config'
end
raise "#{overlay}: rendered RPC Proxy ConfigMap missing" unless rpc_proxy_config
rpc_base_url = rpc_proxy_config.dig('data', 'RPC_PROXY_CONTROL_API_BASE_URL')
expected_rpc_base_url =
  'http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/api/v1'
raise "#{overlay}: RPC Proxy checkpoint base URL changed unexpectedly" unless
  rpc_base_url == expected_rpc_base_url

gateway_policy = documents.find do |document|
  document.is_a?(Hash) && document['kind'] == 'NetworkPolicy' &&
    document.dig('metadata', 'name') == 'nginx-workflow-approval-gateway'
end
raise "#{overlay}: rendered gateway NetworkPolicy missing" unless gateway_policy

ingress_rule = gateway_policy.dig('spec', 'ingress').find do |rule|
  rule.fetch('ports', []).any? { |port| port['port'].to_i == 8092 } &&
    rule.fetch('from', []).any? do |peer|
      peer.dig('namespaceSelector', 'matchLabels', 'kubernetes.io/metadata.name') == 'mcp-host' &&
        peer.dig('podSelector', 'matchLabels', 'clerum.io/managed-by') == 'host-context-controller'
    end
end
raise "#{overlay}: gateway ingress does not admit managed MCP Host on 8092" unless ingress_rule

gateway_egress = gateway_policy.dig('spec', 'egress').find do |rule|
  rule.fetch('ports', []).any? { |port| port['port'].to_i == 8090 } &&
    rule.fetch('to', []).any? do |peer|
      peer.dig('podSelector', 'matchLabels', 'app') == 'control-api'
    end
end
raise "#{overlay}: gateway egress does not reach Control API on 8090" unless gateway_egress

mcp_host_policy = documents.find do |document|
  document.is_a?(Hash) && document['kind'] == 'NetworkPolicy' &&
    document.dig('metadata', 'name') == 'mcp-host' &&
    document.dig('metadata', 'namespace') == 'mcp-host'
end
raise "#{overlay}: rendered MCP Host NetworkPolicy missing" unless mcp_host_policy

mcp_host_egress = mcp_host_policy.dig('spec', 'egress').find do |rule|
  rule.fetch('ports', []).any? { |port| port['port'].to_i == 8092 } &&
    rule.fetch('to', []).any? do |peer|
      peer.dig('podSelector', 'matchLabels', 'app') == 'nginx-workflow-approval-gateway'
    end
end
raise "#{overlay}: MCP Host cannot reach the narrow gateway on 8092" unless mcp_host_egress

puts "PASS #{overlay}: configured RPC checkpoint, workflow checkpoint, and Host-RPC routes remain bounded"
RUBY
done
