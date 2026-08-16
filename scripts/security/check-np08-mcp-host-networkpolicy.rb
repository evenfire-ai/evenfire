#!/usr/bin/env ruby
# frozen_string_literal: true

# Read a Kubernetes NetworkPolicyList from stdin and emit only boolean contract
# fields. This is shared by the live NP-08 gate and fixture tests.

require "json"

documents = JSON.parse(STDIN.read)
policies = Array(documents.fetch("items", [])).select do |document|
  document.is_a?(Hash) &&
    document["kind"] == "NetworkPolicy" &&
    document.dig("metadata", "namespace") == "mcp-host"
end

rules = policies.flat_map { |policy| Array(policy.dig("spec", "egress")) }

port_is_numeric = lambda do |port|
  port.is_a?(Hash) &&
    port["port"].is_a?(Integer) &&
    (port["endPort"].nil? || port["endPort"].is_a?(Integer))
end

allows_tcp_port = lambda do |rule, expected_port|
  Array(rule["ports"]).any? do |port|
    next false unless port.is_a?(Hash)
    next false unless port.fetch("protocol", "TCP") == "TCP"

    first = port["port"]
    last = port.fetch("endPort", first)
    first.is_a?(Integer) && last.is_a?(Integer) && first <= expected_port && expected_port <= last
  end
end

broad_internal_peer = lambda do |peer|
  namespace_selector = peer["namespaceSelector"]
  next false unless namespace_selector.is_a?(Hash)

  labels = namespace_selector["matchLabels"]
  namespace_name = labels.is_a?(Hash) ? labels["kubernetes.io/metadata.name"] : nil
  pod_selector = peer["podSelector"]
  has_pod_selector = pod_selector.is_a?(Hash) && !pod_selector.empty?
  next true if !labels.is_a?(Hash) || labels.empty? || namespace_name == "mcp-server"

  !has_pod_selector && namespace_name != "kube-system"
end

egress_contract_ok = rules.all? do |rule|
  peers = rule["to"]
  ports = rule["ports"]
  peers.is_a?(Array) && !peers.empty? &&
    ports.is_a?(Array) && !ports.empty? &&
    ports.all? { |port| port_is_numeric.call(port) } &&
    peers.none? { |peer| broad_internal_peer.call(peer) }
end

hcc_lane = rules.any? do |rule|
  allows_tcp_port.call(rule, 8081) &&
    Array(rule["to"]).any? do |peer|
      peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "control-plane" &&
        peer.dig("podSelector", "matchLabels", "app") == "host-context-controller-api-gateway"
    end
end

proxy_8083 = rules.any? { |rule| allows_tcp_port.call(rule, 8083) }

puts JSON.generate(
  "egress_contract_ok" => egress_contract_ok,
  "hcc_lane" => hcc_lane,
  "proxy_8083" => proxy_8083,
)
