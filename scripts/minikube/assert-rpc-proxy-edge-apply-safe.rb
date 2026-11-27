#!/usr/bin/env ruby
# Fail closed unless a full overlay targets the signed-assertion edge protocol on both sides:
# the HCC selects signed-assertion-v1 exactly once and the RPC Proxy carries the same label.
# Any other target would leave Hosts that require the assertion without a Proxy that forwards it,
# or a Proxy rolled back without the ordered Host-first rollback command.

require "open3"
require "yaml"

STRICT_PROTOCOL = "signed-assertion-v1"
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
fail("target HCC must define #{HOST_PROTOCOL_ENV} exactly once") unless target_host_protocols.length == 1
fail("target HCC edge protocol must be #{STRICT_PROTOCOL}") unless target_host_protocols.first["value"] == STRICT_PROTOCOL
fail("target RPC Proxy edge protocol label must be #{STRICT_PROTOCOL}") unless target_proxy_protocol == STRICT_PROTOCOL

puts "RPC Proxy/Host target edge protocol is #{STRICT_PROTOCOL} on both sides"
