#!/usr/bin/env ruby
# Fail closed when a full overlay would create the forbidden old-Proxy -> strict-Host pair
# or downgrade a currently strict Proxy without the explicit ordered rollback command.

require "json"
require "open3"
require "yaml"

STRICT_PROTOCOL = "dedicated-header-v1"
PROXY_PROTOCOL_LABEL = "clerum.io/rpc-proxy-edge-protocol"
HOST_PROTOCOL_ENV = "CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL"

def fail(message)
  warn("ERROR: #{message}")
  exit(1)
end

def option_value(args, name)
  index = args.index(name)
  return nil unless index
  fail("missing value for #{name}") unless args[index + 1]
  args[index + 1]
end

context = option_value(ARGV, "--context")
overlay = option_value(ARGV, "--overlay")
fail("usage: #{$PROGRAM_NAME} --context NAME --overlay DIRECTORY") if context.to_s.empty? || overlay.to_s.empty?

kubectl = ENV.fetch("KUBECTL_BIN", "kubectl")
rendered, render_status = Open3.capture2e(kubectl, "--context=#{context}", "kustomize", overlay)
fail("unable to render target overlay: #{rendered.strip}") unless render_status.success?

documents = YAML.load_stream(rendered).compact.select { |document| document.is_a?(Hash) }
deployment = lambda do |name, namespace|
  matches = documents.select do |document|
    metadata = document["metadata"] || {}
    document["kind"] == "Deployment" && metadata["name"] == name && metadata["namespace"] == namespace
  end
  fail("target overlay must contain exactly one #{namespace}/#{name} Deployment") unless matches.length == 1
  matches.first
end

target_proxy = deployment.call("rpc-proxy", "rpc-proxy")
target_hcc = deployment.call("host-context-controller", "control-plane")
target_proxy_protocol = target_proxy.dig("spec", "template", "metadata", "labels", PROXY_PROTOCOL_LABEL)
target_host_protocols = Array(target_hcc.dig("spec", "template", "spec", "containers"))
  .flat_map { |container| Array(container["env"]) }
  .select { |environment| environment["name"] == HOST_PROTOCOL_ENV }
fail("target HCC defines #{HOST_PROTOCOL_ENV} more than once") if target_host_protocols.length > 1
target_host_protocol = target_host_protocols.empty? ? "legacy-headers" : target_host_protocols.first["value"]
fail("unsupported target edge protocol") unless [STRICT_PROTOCOL, "legacy-headers"].include?(target_host_protocol)

if target_host_protocol == STRICT_PROTOCOL && target_proxy_protocol != STRICT_PROTOCOL
  fail("target old-Proxy/strict-Host combination is forbidden")
end

proxy_json, proxy_status = Open3.capture2e(
  kubectl, "--context=#{context}", "get", "deployment", "rpc-proxy", "-n", "rpc-proxy", "-o", "json"
)
current_proxy_strict = false
current_proxy_exists = proxy_status.success?
if proxy_status.success?
  current_proxy = JSON.parse(proxy_json)
  current_proxy_strict =
    current_proxy.dig("spec", "template", "metadata", "labels", PROXY_PROTOCOL_LABEL) == STRICT_PROTOCOL
else
  # A missing current Proxy is valid only for a fresh bootstrap; there is no serving
  # strict cohort whose transition needs an ordered rollback.
  fail("unable to inspect current RPC Proxy Deployment: #{proxy_json.strip}") unless proxy_json.include?("NotFound")
end

proxy_pods_json, proxy_pods_status = Open3.capture2e(
  kubectl, "--context=#{context}", "get", "pods", "-n", "rpc-proxy", "-l", "app=rpc-proxy", "-o", "json"
)
if proxy_pods_status.success?
  current_proxy_pods = JSON.parse(proxy_pods_json)
  current_proxy_strict ||= Array(current_proxy_pods["items"]).any? do |pod|
    pod.dig("metadata", "labels", PROXY_PROTOCOL_LABEL) == STRICT_PROTOCOL
  end
elsif current_proxy_exists || !proxy_pods_json.include?("NotFound")
  fail("unable to inspect current RPC Proxy pods: #{proxy_pods_json.strip}")
end

strict_host_pods_json, strict_host_pods_status = Open3.capture2(
  kubectl,
  "--context=#{context}",
  "get",
  "pods",
  "-n",
  "mcp-host",
  "-l",
  "#{PROXY_PROTOCOL_LABEL}=#{STRICT_PROTOCOL}",
  "-o",
  "json"
)
strict_hosts_present = false
if strict_host_pods_status.success?
  strict_hosts_present = Array(JSON.parse(strict_host_pods_json)["items"]).any?
elsif !strict_host_pods_json.include?("NotFound")
  fail("unable to inspect strict MCP Host pods: #{strict_host_pods_json.strip}")
end

if current_proxy_strict && target_proxy_protocol != STRICT_PROTOCOL
  fail("current strict Proxy cannot be downgraded by a full overlay; run the ordered Host-first rollback command")
end

if target_proxy_protocol != STRICT_PROTOCOL && strict_hosts_present
  fail("full overlay blocked while strict Host pods remain; use the ordered Host-first rollback")
end

puts "RPC Proxy/Host target protocol transition is safe for full overlay apply"
