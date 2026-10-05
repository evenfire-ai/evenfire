#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

ruby -ryaml - "$ROOT" <<'RUBY'
root = ARGV.fetch(0)

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [], permitted_symbols: [], aliases: false)
end

def env_map(entries)
  Array(entries).to_h { |entry| [entry.fetch('name'), entry.fetch('value')] }
end

static = load_yaml(File.join(root, 'deploy/overlays/minikube/instances-e2e/mongodb-server.yaml'))
static_env = env_map(static.dig('spec', 'env'))
raise 'static MongoDB MCP server lacks explicit non-loopback binding authority' unless
  static_env['MDB_MCP_DANGEROUS_HOST_BINDING'] == 'true'
mapping = static.dig('spec', 'envMapping') || {}
raise 'static MongoDB MCP server uses deprecated monitoring host variable' unless
  mapping['healthCheckHost'] == 'MDB_MCP_MONITORING_SERVER_HOST'
raise 'static MongoDB MCP server uses deprecated monitoring port variable' unless
  mapping['healthCheckPort'] == 'MDB_MCP_MONITORING_SERVER_PORT'

recipe = load_yaml(File.join(root, 'deploy/overlays/minikube/instances-e2e/mongodb-mcp-stack.yaml'))
workload = Array(recipe.dig('spec', 'workloads')).find { |item| item['id'] == 'mongodb-mcp-server' }
raise 'MongoDB MCP recipe workload is missing' unless workload
recipe_env = env_map(workload['env'])
raise 'recipe MongoDB MCP server lacks explicit non-loopback binding authority' unless
  recipe_env['MDB_MCP_DANGEROUS_HOST_BINDING'] == 'true'
raise 'recipe MongoDB MCP server uses deprecated monitoring host variable' unless
  recipe_env.key?('MDB_MCP_MONITORING_SERVER_HOST') &&
    !recipe_env.key?('MDB_MCP_HEALTH_CHECK_HOST')
raise 'recipe MongoDB MCP server uses deprecated monitoring port variable' unless
  recipe_env.key?('MDB_MCP_MONITORING_SERVER_PORT') &&
    !recipe_env.key?('MDB_MCP_HEALTH_CHECK_PORT')
RUBY

printf 'PASS: MongoDB MCP fixtures explicitly authorize network binding and use current monitoring variables\n'
