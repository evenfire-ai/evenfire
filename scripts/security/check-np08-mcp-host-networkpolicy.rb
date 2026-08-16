#!/usr/bin/env ruby
# frozen_string_literal: true

# Read a Kubernetes NetworkPolicyList from stdin and emit only boolean contract
# fields. This is shared by the live NP-08 gate and fixture tests.

require "json"

PUBLIC_EGRESS_EXCEPTIONS = %w[
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  127.0.0.0/8
  169.254.0.0/16
  172.16.0.0/12
  192.0.0.0/24
  192.0.2.0/24
  192.31.196.0/24
  192.52.193.0/24
  192.88.99.0/24
  192.168.0.0/16
  192.175.48.0/24
  198.18.0.0/15
  198.51.100.0/24
  203.0.113.0/24
  224.0.0.0/4
  240.0.0.0/4
].freeze

documents = JSON.parse(STDIN.read)
policies = Array(documents.fetch("items", [])).select do |document|
  document.is_a?(Hash) &&
    document["kind"] == "NetworkPolicy" &&
    document.dig("metadata", "namespace") == "mcp-host"
end

policy_rules = policies.flat_map do |policy|
  Array(policy.dig("spec", "egress")).map { |rule| [policy, rule] }
end

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

broad_internal_peer = lambda do |peer, policy|
  next true unless peer.is_a?(Hash)
  next true if peer.empty?
  next true unless (peer.keys - %w[ipBlock namespaceSelector podSelector]).empty?
  next true if peer["ipBlock"].nil? && peer["namespaceSelector"].nil? && peer["podSelector"].nil?

  if peer["ipBlock"]
    ip_block = peer["ipBlock"]
    next true unless ip_block.is_a?(Hash) && ip_block["cidr"].is_a?(String) && !ip_block["cidr"].empty?

    cidr = ip_block["cidr"]
    if cidr == "0.0.0.0/0" || cidr == "::/0"
      next true unless Array(ip_block["except"]).sort == PUBLIC_EGRESS_EXCEPTIONS.sort
    elsif !(cidr.match?(%r{/(32|128)\z}))
      next true
    end
    next false
  end

  namespace_selector = peer["namespaceSelector"]
  if namespace_selector.nil?
    pod_selector = peer["podSelector"]
    pod_labels = pod_selector.is_a?(Hash) ? pod_selector["matchLabels"] : nil
    pod_expressions = pod_selector.is_a?(Hash) ? pod_selector["matchExpressions"] : nil
    has_pod_selector = pod_labels.is_a?(Hash) && !pod_labels.empty? ||
      pod_expressions.is_a?(Array) && !pod_expressions.empty?
    next false if has_pod_selector

    next true
  end
  next true unless namespace_selector.is_a?(Hash)

  labels = namespace_selector["matchLabels"]
  namespace_name = labels.is_a?(Hash) ? labels["kubernetes.io/metadata.name"] : nil
  pod_selector = peer["podSelector"]
  pod_labels = pod_selector.is_a?(Hash) ? pod_selector["matchLabels"] : nil
  pod_expressions = pod_selector.is_a?(Hash) ? pod_selector["matchExpressions"] : nil
  has_pod_selector = pod_labels.is_a?(Hash) && !pod_labels.empty? ||
    pod_expressions.is_a?(Array) && !pod_expressions.empty?
  if namespace_name == "mcp-server"
    server_name = pod_selector.dig("matchLabels", "clerum.io/mcpserver") if pod_selector.is_a?(Hash)
    policy_labels = policy.dig("metadata", "labels")
    source_labels = policy.dig("spec", "podSelector", "matchLabels")
    context_bound_policy = policy_labels.is_a?(Hash) &&
      policy_labels["clerum.io/policy-type"] == "context-allow" &&
      policy_labels["clerum.io/context"].is_a?(String) && !policy_labels["clerum.io/context"].empty? &&
      policy_labels["clerum.io/mcpserver"].is_a?(String) && !policy_labels["clerum.io/mcpserver"].empty? &&
      source_labels.is_a?(Hash) &&
      source_labels["clerum.io/managed-by"] == "host-context-controller" &&
      source_labels["clerum.io/context"] == policy_labels["clerum.io/context"]
    exact_server_selector = server_name.is_a?(String) && !server_name.empty? &&
      Array(pod_selector["matchExpressions"]).empty? &&
      context_bound_policy && server_name == policy_labels["clerum.io/mcpserver"]
    next false if exact_server_selector
    next true
  end
  next true if !labels.is_a?(Hash) || labels.empty?

  !has_pod_selector && namespace_name != "kube-system"
end

egress_contract_ok = policy_rules.all? do |policy, rule|
  peers = rule["to"]
  ports = rule["ports"]
  peers.is_a?(Array) && !peers.empty? &&
    ports.is_a?(Array) && !ports.empty? &&
    ports.all? { |port| port_is_numeric.call(port) } &&
    peers.none? { |peer| broad_internal_peer.call(peer, policy) }
end

hcc_lane = policy_rules.any? do |_policy, rule|
  allows_tcp_port.call(rule, 8081) &&
    Array(rule["to"]).any? do |peer|
      peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "control-plane" &&
        peer.dig("podSelector", "matchLabels", "app") == "host-context-controller-api-gateway"
    end
end

proxy_8083 = policy_rules.any? { |_policy, rule| allows_tcp_port.call(rule, 8083) }

puts JSON.generate(
  "egress_contract_ok" => egress_contract_ok,
  "hcc_lane" => hcc_lane,
  "proxy_8083" => proxy_8083,
)
