#!/usr/bin/env ruby
# frozen_string_literal: true

# Derives the NetworkPolicy namespace inventory for np-enforce-preflight.sh
# from a rendered overlay (multi-document YAML on stdin). Prints three shell
# assignments: ALL_NAMESPACES, K8S_API_NAMESPACES and RUNTIME_NAMESPACES.
#
# HCC's namespace variables are interpreted the way HCC reads them: an absent
# entry means HCC's code default, an explicit value (including "") overrides
# it. A value the render cannot show (valueFrom, or a possible envFrom source)
# aborts with a message on stderr, because guessing it would let the preflight
# skip namespaces it has to check.

require 'yaml'

# Code defaults of host-context-controller/src/config.ts (runtimeNamespaces and
# minimalInfraNamespaces). scripts/tests/test-np-preflight-inventory.sh fails
# when these and the config.ts literals differ.
HCC_DEFAULT_RUNTIME_NAMESPACES = %w[mcp-server sandbox-recipes rpc-proxy sandbox-ui].freeze
HCC_DEFAULT_MINIMAL_INFRA_NAMESPACES = %w[sandbox-ui].freeze

HCC_NAME = 'host-context-controller'

def derive_inventory(rendered)
  docs = YAML.load_stream(rendered).select { |doc| doc.is_a?(Hash) }
  quote = lambda { |value| "'" + value.gsub("'", "'\\\\''") + "'" }
  namespaces = docs
    .select { |doc| doc["kind"] == "Namespace" && (doc.dig("metadata", "labels") || {})["app.kubernetes.io/part-of"] == "clerum" }
    .map { |doc| doc.dig("metadata", "name") }
    .compact
    .uniq
    .sort
  static_k8s = docs
    .select { |doc| doc["kind"] == "NetworkPolicy" }
    .map { |doc| [doc.dig("metadata", "namespace"), doc.dig("metadata", "name")] }
    .select { |_ns, name| name&.start_with?("allow-k8s-api-egress-") }
    .map(&:first)
    .compact
  hcc = docs.find { |doc| doc["kind"] == "Deployment" && doc.dig("metadata", "name") == HCC_NAME }
  abort("np-preflight-inventory: the render has no Deployment #{HCC_NAME}; cannot derive") unless hcc
  container = (hcc.dig("spec", "template", "spec", "containers") || []).find { |c| c["name"] == HCC_NAME }
  abort("np-preflight-inventory: Deployment #{HCC_NAME} has no container #{HCC_NAME}; cannot derive") unless container
  env = container["env"] || []
  env_from = !(container["envFrom"] || []).empty?
  resolve = lambda do |name, default|
    item = env.find { |entry| entry["name"] == name }
    if item.nil?
      abort("np-preflight-inventory: #{name} may come from envFrom; cannot derive") if env_from
      default.dup
    elsif item.key?("valueFrom")
      abort("np-preflight-inventory: #{name} uses valueFrom; cannot derive")
    else
      (item["value"] || "").split(",").map(&:strip).reject(&:empty?)
    end
  end
  runtime = resolve.call("CONTEXT_MAPPER_RUNTIME_NAMESPACES", HCC_DEFAULT_RUNTIME_NAMESPACES)
  minimal = resolve.call("CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES", HCC_DEFAULT_MINIMAL_INFRA_NAMESPACES)
  k8s_api = (static_k8s + (runtime - minimal)).uniq.sort
  [
    "ALL_NAMESPACES=#{quote.call(namespaces.join(" "))}",
    "K8S_API_NAMESPACES=#{quote.call(k8s_api.join(" "))}",
    "RUNTIME_NAMESPACES=#{quote.call(runtime.join(" "))}",
  ]
end

puts derive_inventory(STDIN.read) if $PROGRAM_NAME == __FILE__
