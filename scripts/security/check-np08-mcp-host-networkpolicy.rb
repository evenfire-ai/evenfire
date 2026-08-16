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
  next true unless peer.is_a?(Hash)
  next true if peer.empty?
  next true unless (peer.keys - %w[ipBlock namespaceSelector podSelector]).empty?
  next true if peer["ipBlock"].nil? && peer["namespaceSelector"].nil? && peer["podSelector"].nil?

  if peer["ipBlock"]
    ip_block = peer["ipBlock"]
    next true unless ip_block.is_a?(Hash) && ip_block["cidr"].is_a?(String) && !ip_block["cidr"].empty?

    cidr = ip_block["cidr"]
    if cidr == "0.0.0.0/0" || cidr == "::/0"
      next true unless Array(ip_block["except"]).any?
    elsif !(cidr.match?(%r{/(32|128)\z}))
      next true
    end
    next false
  end

  namespace_selector = peer["namespaceSelector"]
  if namespace_selector.nil?
    next false if peer["podSelector"].is_a?(Hash) && !peer["podSelector"].empty?

    next true
  end
  next true unless namespace_selector.is_a?(Hash)

  labels = namespace_selector["matchLabels"]
  namespace_name = labels.is_a?(Hash) ? labels["kubernetes.io/metadata.name"] : nil
  pod_selector = peer["podSelector"]
  has_pod_selector = pod_selector.is_a?(Hash) && !pod_selector.empty?
  if namespace_name == "mcp-server"
    server_name = pod_selector.dig("matchLabels", "clerum.io/mcpserver") if has_pod_selector
    exact_server_selector = server_name.is_a?(String) && !server_name.empty? &&
      Array(pod_selector["matchExpressions"]).empty?
    next false if exact_server_selector
    next true
  end
  next true if !labels.is_a?(Hash) || labels.empty?

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
