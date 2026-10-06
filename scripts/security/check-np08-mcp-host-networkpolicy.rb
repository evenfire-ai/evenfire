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
host_pods = nil
if ARGV[0] == "--host-pods"
  pods_path = ARGV.fetch(1)
  host_pods = JSON.parse(File.read(pods_path))
end
policies = Array(documents.fetch("items", [])).select do |document|
  document.is_a?(Hash) &&
    document["kind"] == "NetworkPolicy" &&
    document.dig("metadata", "namespace") == "mcp-host"
end

policy_rules = policies.flat_map do |policy|
  Array(policy.dig("spec", "egress")).map { |rule| [policy, rule] }
end

selector_matches = lambda do |selector, labels|
  selector = {} if selector.nil?
  next false unless selector.is_a?(Hash) && labels.is_a?(Hash)

  match_labels = selector["matchLabels"]
  next false unless !match_labels || (match_labels.is_a?(Hash) && match_labels.all? { |key, value| labels[key] == value })

  Array(selector["matchExpressions"]).all? do |expression|
    next false unless expression.is_a?(Hash)

    key = expression["key"]
    operator = expression["operator"]
    values = Array(expression["values"])
    case operator
    when "In"
      values.include?(labels[key])
    when "NotIn"
      !values.include?(labels[key])
    when "Exists"
      labels.key?(key)
    when "DoesNotExist"
      !labels.key?(key)
    else
      false
    end
  end
end

policy_types_include_egress = lambda do |policy|
  Array(policy.dig("spec", "policyTypes")).include?("Egress")
end

# HCC also labels execution Pods clerum.io/managed-by=host-context-controller.
# NetworkPolicies are additive, so every static Host grant excludes them with
# exactly this expression; any other narrowing of the Host selector fails.
EXECUTION_ROLE_LABEL = "clerum.io/role"
EXECUTION_ROLE_VALUE = "host-execution"
HOST_EXECUTION_EXCLUSION = [
  { "key" => EXECUTION_ROLE_LABEL, "operator" => "NotIn", "values" => [EXECUTION_ROLE_VALUE] },
].freeze
EXPECTED_EXECUTION_SPEC = {
  "podSelector" => {
    "matchLabels" => {
      "clerum.io/managed-by" => "host-context-controller",
      EXECUTION_ROLE_LABEL => EXECUTION_ROLE_VALUE,
    },
  },
  "policyTypes" => ["Ingress", "Egress"],
  "ingress" => [
    {
      "from" => [
        {
          "namespaceSelector" => { "matchLabels" => { "kubernetes.io/metadata.name" => "control-plane" } },
          "podSelector" => { "matchLabels" => { "app" => "host-context-controller" } },
        },
      ],
      "ports" => [{ "port" => 9300, "protocol" => "TCP" }, { "port" => 9301, "protocol" => "TCP" }],
    },
  ],
  "egress" => [],
}.freeze

static_host_pod_selector = lambda do |policy|
  selector = policy.dig("spec", "podSelector")
  selector.is_a?(Hash) && selector.keys.sort == ["matchExpressions", "matchLabels"] &&
    selector["matchLabels"] == { "clerum.io/managed-by" => "host-context-controller" } &&
    selector["matchExpressions"] == HOST_EXECUTION_EXCLUSION
end

default_deny = policies.find { |policy| policy.dig("metadata", "name") == "deny-all-mcp-host" }
managed_host_policy = policies.find { |policy| policy.dig("metadata", "name") == "mcp-host" }
static_host_grants = %w[mcp-host allow-dns-egress-mcp-host allow-k8s-api-egress-mcp-host].map do |name|
  policies.find { |policy| policy.dig("metadata", "name") == name }
end
execution_policy = policies.find { |policy| policy.dig("metadata", "name") == "host-execution-private" }
context_allow_policies = policies.select do |policy|
  policy.dig("metadata", "labels", "clerum.io/policy-type") == "context-allow"
end

# Any other mcp-host policy that grants traffic must not be able to select an
# execution Pod. Operation and Host UID label values are per Pod, so a selector
# keyed on them is treated as possibly matching; an unknown operator matches.
EXECUTION_STATIC_LABELS = {
  "clerum.io/managed-by" => "host-context-controller",
  EXECUTION_ROLE_LABEL => EXECUTION_ROLE_VALUE,
}.freeze
EXECUTION_DYNAMIC_LABELS = %w[clerum.io/operation clerum.io/host-uid].freeze
selects_execution_pod = lambda do |selector|
  next true unless selector.is_a?(Hash)

  labels_match = (selector["matchLabels"] || {}).all? do |key, value|
    EXECUTION_DYNAMIC_LABELS.include?(key) || EXECUTION_STATIC_LABELS[key] == value
  end
  expressions_match = Array(selector["matchExpressions"]).all? do |expression|
    next true unless expression.is_a?(Hash)

    key = expression["key"]
    values = Array(expression["values"])
    if EXECUTION_DYNAMIC_LABELS.include?(key)
      expression["operator"] != "DoesNotExist"
    else
      present = EXECUTION_STATIC_LABELS.key?(key)
      case expression["operator"]
      when "In" then present && values.include?(EXECUTION_STATIC_LABELS[key])
      when "NotIn" then !present || !values.include?(EXECUTION_STATIC_LABELS[key])
      when "Exists" then present
      when "DoesNotExist" then !present
      else true
      end
    end
  end
  labels_match && expressions_match
end
policy_grants_traffic = lambda do |policy|
  !Array(policy.dig("spec", "ingress")).empty? || !Array(policy.dig("spec", "egress")).empty?
end
execution_grants = policies.select do |policy|
  policy.dig("metadata", "name") != "host-execution-private" &&
    policy_grants_traffic.call(policy) &&
    selects_execution_pod.call(policy.dig("spec", "podSelector"))
end

selector_contract_ok =
  default_deny.is_a?(Hash) &&
  default_deny.dig("spec", "podSelector") == {} &&
  policy_types_include_egress.call(default_deny) &&
  managed_host_policy.is_a?(Hash) &&
  static_host_grants.all? do |policy|
    policy.is_a?(Hash) && static_host_pod_selector.call(policy) && policy_types_include_egress.call(policy)
  end &&
  execution_policy.is_a?(Hash) &&
  # The API server omits an empty egress list, so a live object and a render
  # compare equal only after restoring it.
  execution_policy["spec"].is_a?(Hash) &&
  execution_policy["spec"].merge("egress" => Array(execution_policy["spec"]["egress"])) == EXPECTED_EXECUTION_SPEC &&
  execution_grants.empty? &&
  context_allow_policies.all? do |policy|
    labels = policy.dig("spec", "podSelector", "matchLabels")
    context = policy.dig("metadata", "labels", "clerum.io/context")
    labels.is_a?(Hash) &&
      labels["clerum.io/managed-by"] == "host-context-controller" &&
      labels["clerum.io/context"] == context &&
      Array(policy.dig("spec", "podSelector", "matchExpressions")).empty? &&
      policy_types_include_egress.call(policy)
  end

if host_pods
  managed_pods = Array(host_pods.fetch("items", [])).select do |pod|
    pod.dig("metadata", "labels", "clerum.io/managed-by") == "host-context-controller"
  end
  execution_pods, managed_host_pods = managed_pods.partition do |pod|
    pod.dig("metadata", "labels", EXECUTION_ROLE_LABEL) == EXECUTION_ROLE_VALUE
  end
  # Every Host pod has an egress grant; every execution Pod is selected by no
  # granting policy other than its private one.
  selector_contract_ok &&= !managed_host_pods.empty? && managed_host_pods.all? do |pod|
    labels = pod.dig("metadata", "labels") || {}
    policies.any? do |policy|
      policy_types_include_egress.call(policy) &&
        !Array(policy.dig("spec", "egress")).empty? &&
        selector_matches.call(policy.dig("spec", "podSelector"), labels)
    end
  end
  selector_contract_ok &&= execution_pods.all? do |pod|
    labels = pod.dig("metadata", "labels") || {}
    policies.none? do |policy|
      policy.dig("metadata", "name") != "host-execution-private" &&
        policy_grants_traffic.call(policy) &&
        selector_matches.call(policy.dig("spec", "podSelector"), labels)
    end
  end
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
  exact_namespace_selector = namespace_selector.keys.sort == ["matchLabels"] &&
    labels == { "kubernetes.io/metadata.name" => namespace_name }
  next true unless exact_namespace_selector
  pod_selector = peer["podSelector"]
  pod_labels = pod_selector.is_a?(Hash) ? pod_selector["matchLabels"] : nil
  pod_expressions = pod_selector.is_a?(Hash) ? pod_selector["matchExpressions"] : nil
  has_pod_selector = pod_labels.is_a?(Hash) && !pod_labels.empty? ||
    pod_expressions.is_a?(Array) && !pod_expressions.empty?
  if namespace_name == "mcp-server"
    server_name = pod_selector.dig("matchLabels", "clerum.io/mcpserver") if pod_selector.is_a?(Hash)
    policy_labels = policy.dig("metadata", "labels")
    source_selector = policy.dig("spec", "podSelector")
    source_labels = source_selector.is_a?(Hash) ? source_selector["matchLabels"] : nil
    context_bound_policy = policy_labels.is_a?(Hash) &&
      policy_labels["clerum.io/managed-by"] == "host-context-controller" &&
      policy_labels["clerum.io/policy-type"] == "context-allow" &&
      policy_labels["clerum.io/context"].is_a?(String) && !policy_labels["clerum.io/context"].empty? &&
      policy_labels["clerum.io/mcpserver"].is_a?(String) && !policy_labels["clerum.io/mcpserver"].empty? &&
      source_selector.is_a?(Hash) && source_selector.keys.sort == ["matchLabels"] &&
      source_labels.is_a?(Hash) &&
      source_labels.keys.sort == ["clerum.io/context", "clerum.io/managed-by"] &&
      source_labels["clerum.io/managed-by"] == "host-context-controller" &&
      source_labels["clerum.io/context"] == policy_labels["clerum.io/context"]
    exact_server_selector = server_name.is_a?(String) && !server_name.empty? &&
      Array(pod_selector["matchExpressions"]).empty? &&
      context_bound_policy && server_name == policy_labels["clerum.io/mcpserver"]
    next false if exact_server_selector
    next true
  end
  if namespace_name == "control-plane"
    exact_gateway = pod_selector.is_a?(Hash) &&
      pod_selector.keys.sort == ["matchLabels"] &&
      pod_selector["matchLabels"].is_a?(Hash) &&
      Array(pod_selector["matchExpressions"]).empty? &&
      %w[host-context-controller-api-gateway nginx-workflow-approval-gateway].include?(pod_selector.dig("matchLabels", "app")) &&
      pod_selector["matchLabels"].keys == ["app"]
    next false if exact_gateway
    next true
  end
  if namespace_name == "kube-system"
    exact_dns_namespace = pod_selector.nil?
    exact_dns_pods = pod_selector.is_a?(Hash) &&
      pod_selector.keys.sort == ["matchLabels"] &&
      pod_selector["matchLabels"] == { "k8s-app" => "kube-dns" } &&
      Array(pod_selector["matchExpressions"]).empty?
    next false if exact_dns_namespace || exact_dns_pods
    next true
  end
  if namespace_name == "gfs"
    exact_gfs_pods = pod_selector.is_a?(Hash) &&
      pod_selector.keys.sort == ["matchLabels"] &&
      pod_selector["matchLabels"] == { "app" => "gfs-controller" } &&
      Array(pod_selector["matchExpressions"]).empty?
    next false if exact_gfs_pods
    next true
  end

  next true
end

egress_contract_ok = policy_rules.all? do |policy, rule|
  peers = rule["to"]
  ports = rule["ports"]
  peers.is_a?(Array) && !peers.empty? &&
    ports.is_a?(Array) && !ports.empty? &&
    ports.all? { |port| port_is_numeric.call(port) } &&
    peers.none? { |peer| broad_internal_peer.call(peer, policy) }
end

gfs_contract_ok = policy_rules.all? do |_policy, rule|
  gfs_peers = Array(rule["to"]).select do |peer|
    peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "gfs"
  end
  next true if gfs_peers.empty?

  gfs_peers.length == 1 &&
    gfs_peers.first.dig("podSelector", "matchLabels") == { "app" => "gfs-controller" } &&
    Array(rule["ports"]).length == 1 &&
    rule["ports"].first["protocol"].to_s == "TCP" &&
    rule["ports"].first["port"] == 8087 &&
    rule["ports"].first["endPort"].nil?
end

egress_contract_ok &&= gfs_contract_ok

hcc_lane = policy_rules.any? do |_policy, rule|
  policy = _policy
  policy_types_include_egress.call(policy) &&
    static_host_pod_selector.call(policy) &&
    allows_tcp_port.call(rule, 8081) &&
    Array(rule["to"]).any? do |peer|
      peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "control-plane" &&
        peer.dig("podSelector", "matchLabels", "app") == "host-context-controller-api-gateway"
    end
end

proxy_8083 = policy_rules.any? { |_policy, rule| allows_tcp_port.call(rule, 8083) }

puts JSON.generate(
  "egress_contract_ok" => egress_contract_ok,
  "selector_contract_ok" => selector_contract_ok,
  "hcc_lane" => hcc_lane,
  "proxy_8083" => proxy_8083,
)
