#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "usage: $0 <rendered-yaml|-> [...]" >&2
  exit 2
fi

for rendered in "$@"; do
  if [[ "${rendered}" != "-" && ! -f "${rendered}" ]]; then
    echo "FAIL: rendered manifest is absent" >&2
    exit 1
  fi

  RUBYOPT=--disable=gems ruby -ryaml -e '
    source = ARGV.fetch(0)
    yaml = source == "-" ? STDIN.read : File.read(source)
    documents = YAML.load_stream(yaml).select { |document| document.is_a?(Hash) }

    find = lambda do |kind, name, namespace|
      documents.find do |document|
        document["kind"] == kind &&
          document.dig("metadata", "name") == name &&
          document.dig("metadata", "namespace") == namespace
      end
    end
    require_resource = lambda do |kind, name, namespace|
      find.call(kind, name, namespace) || abort("missing #{namespace}/#{kind}/#{name}")
    end

    host_config = require_resource.call("ConfigMap", "mcp-host-config", "mcp-host")
    abort("mcp-host must keep direct MCP transport") unless host_config.dig("data", "MCP_PROXY_ENABLED") == "false"
    abort("HCC authority staleness must stay bounded at 60 seconds") unless host_config.dig("data", "HCC_AUTHORITY_MAX_STALENESS_MS") == "60000"

    hcc = require_resource.call("Deployment", "host-context-controller", "control-plane")
    hcc_container = Array(hcc.dig("spec", "template", "spec", "containers")).find do |container|
      container["name"] == "host-context-controller"
    end
    abort("HCC container is missing") unless hcc_container
    hcc_env = Array(hcc_container["env"]).to_h { |entry| [entry["name"], entry] }
    public_key_ref = hcc_env.dig("HCC_MCP_HOST_JWT_PUBLIC_KEY", "valueFrom", "configMapKeyRef")
    unless public_key_ref == {
      "name" => "control-api-public-key",
      "key" => "CONTROL_API_PUBLIC_KEY_PEM",
    }
      abort("HCC Host JWT public-key wiring is not authoritative")
    end
    issuer_ref = hcc_env.dig("HCC_MCP_HOST_JWT_ISSUER", "valueFrom", "configMapKeyRef")
    unless issuer_ref == {
      "name" => "control-api-config",
      "key" => "CONTROL_API_ADMIN_JWT_ISSUER",
    }
      abort("HCC Host JWT issuer is not wired to the Control API issuer contract")
    end
    max_ttl_ref = hcc_env.dig("HCC_MCP_HOST_JWT_MAX_TTL_SECONDS", "valueFrom", "configMapKeyRef")
    unless max_ttl_ref == {
      "name" => "control-api-config",
      "key" => "WORKFLOW_APPROVAL_ACCESS_TTL_SEC",
    }
      abort("HCC Host JWT maximum TTL must share the Control API access-token contract")
    end

    gateway = require_resource.call("ConfigMap", "host-context-controller-api-gateway", "control-plane")
    nginx = gateway.dig("data", "nginx.conf").to_s
    location_block = lambda do |marker|
      start = nginx.index(marker) || abort("gateway is missing #{marker}")
      finish = nginx.index(/^\s*location\s/m, start + marker.length) || nginx.length
      nginx[start...finish]
    end
    inventory = location_block.call("location = /api/v2/hosts/self/mcpservers {")
    credential = location_block.call("location = /api/v2/hosts/self/mcpservers/credential {")
    [inventory, credential].each do |block|
      abort("v2 route forwards ambient request headers") unless block.include?("proxy_pass_request_headers off;")
      abort("v2 route does not explicitly forward Authorization") unless block.include?("proxy_set_header Authorization $http_authorization;")
      abort("v2 route permits caching") unless block.include?("Cache-Control \"no-store, private\"")
    end
    abort("credential route is not POST-only") unless credential.include?("$request_method != POST")
    abort("credential body is not bounded") unless credential.include?("client_max_body_size 1k;")
    abort("credential route does not preserve explicit body framing") unless credential.include?("proxy_set_header Content-Length $content_length;")
    abort("inventory route is not GET-only") unless inventory.include?("$request_method != GET")
    secure_local_response = lambda do |block, label|
      abort("#{label} permits caching") unless block.include?("Cache-Control \"no-store, private\"")
      abort("#{label} omits legacy no-cache protection") unless block.include?("Pragma \"no-cache\"")
      abort("#{label} permits content sniffing") unless block.include?("X-Content-Type-Options \"nosniff\"")
    end
    legacy_context = location_block.call("location ~ ^/api/v1/mcpservers/context/[^/]+$ {")
    legacy_credential = location_block.call("location ~ ^/api/v1/mcpservers/[^/]+/auth$ {")
    [legacy_context, legacy_credential].each do |block|
      abort("legacy Host route is not tombstoned") unless block.include?("return 410")
      secure_local_response.call(block, "legacy Host tombstone")
    end
    %w[@hcc_bad_request @hcc_method_not_allowed @hcc_payload_too_large].each do |location|
      secure_local_response.call(location_block.call("location #{location} {"), "gateway error response")
    end
    abort("temporary system inventory compatibility route is absent") unless nginx.include?("location = /api/v1/mcpservers {")

    access_log = nginx[/log_format hcc_gateway_json.*?;/m].to_s
    abort("sanitized HCC audit log is absent") if access_log.empty?
    %w[$uri $request_uri $request_body $http_authorization].each do |forbidden|
      abort("HCC audit log includes request-derived sensitive data") if access_log.include?(forbidden)
    end

    proxy_deployment = require_resource.call("Deployment", "mcp-proxy", "mcp-server")
    require_resource.call("Service", "mcp-proxy", "mcp-server")
    abort("PR 1 must not disable the retained mcp-proxy") unless proxy_deployment.dig("spec", "replicas") == 1

    policies = documents.select do |document|
      document["kind"] == "NetworkPolicy" && document.dig("metadata", "namespace") == "mcp-host"
    end
    policy_types_include_egress = lambda do |policy|
      Array(policy.dig("spec", "policyTypes")).include?("Egress")
    end
    exact_pod_selector = lambda do |policy, expected_labels|
      selector = policy.dig("spec", "podSelector")
      selector.is_a?(Hash) && selector.keys.sort == ["matchLabels"] &&
        selector["matchLabels"] == expected_labels && Array(selector["matchExpressions"]).empty?
    end
    default_deny = policies.find { |policy| policy.dig("metadata", "name") == "deny-all-mcp-host" }
    abort("mcp-host default-deny must select every pod and enforce Egress") unless
      default_deny && default_deny.dig("spec", "podSelector") == {} && policy_types_include_egress.call(default_deny)
    managed_host_policy = policies.find { |policy| policy.dig("metadata", "name") == "mcp-host" }
    abort("mcp-host allow policy must select HCC-managed Host pods and enforce Egress") unless
      managed_host_policy && exact_pod_selector.call(managed_host_policy, { "clerum.io/managed-by" => "host-context-controller" }) &&
      policy_types_include_egress.call(managed_host_policy)
    context_allow_policies = policies.select do |policy|
      policy.dig("metadata", "labels", "clerum.io/policy-type") == "context-allow"
    end
    context_allow_policies.each do |policy|
      source_labels = policy.dig("spec", "podSelector", "matchLabels")
      context = policy.dig("metadata", "labels", "clerum.io/context")
      abort("context-allow policy does not select its live Context Host pods") unless
        source_labels.is_a?(Hash) && source_labels["clerum.io/managed-by"] == "host-context-controller" &&
        source_labels["clerum.io/context"] == context &&
        Array(policy.dig("spec", "podSelector", "matchExpressions")).empty? &&
        policy_types_include_egress.call(policy)
    end
    broad_host_egress = policies.any? do |policy|
      Array(policy.dig("spec", "egress")).any? do |rule|
        !rule.key?("to") || Array(rule["to"]).empty? ||
          !rule.key?("ports") || Array(rule["ports"]).empty?
      end
    end
    abort("mcp-host must not gain broad destination or all-port egress") if broad_host_egress

    broad_internal_peer = lambda do |peer, policy|
      abort("mcp-host egress contains an empty or unknown peer") unless peer.is_a?(Hash) && !peer.empty? && (peer.keys - %w[ipBlock namespaceSelector podSelector]).empty?
      next true if peer["ipBlock"].nil? && peer["namespaceSelector"].nil? && peer["podSelector"].nil?
      if peer["ipBlock"]
        ip_block = peer["ipBlock"]
        next true unless ip_block.is_a?(Hash) && ip_block["cidr"].is_a?(String) && !ip_block["cidr"].empty?
        cidr = ip_block["cidr"]
        if cidr == "0.0.0.0/0" || cidr == "::/0"
          next true unless Array(ip_block["except"]).sort == %w[
            0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8
            169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24
            192.31.196.0/24 192.52.193.0/24 192.88.99.0/24 192.168.0.0/16
            192.175.48.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24
            224.0.0.0/4 240.0.0.0/4
          ].sort
        elsif !cidr.match?(%r{/(32|128)\z})
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
    broad_internal_egress = policies.any? do |policy|
      Array(policy.dig("spec", "egress")).any? do |rule|
        Array(rule["to"]).any? { |peer| broad_internal_peer.call(peer, policy) }
      end
    end
    abort("mcp-host must not gain broad internal or mcp-server egress") if broad_internal_egress

    gfs_contract_ok = policies.all? do |policy|
      Array(policy.dig("spec", "egress")).all? do |rule|
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
    end
    abort("mcp-host GFS egress must remain the exact 8087 lane") unless gfs_contract_ok

    named_port = policies.any? do |policy|
      Array(policy.dig("spec", "egress")).any? do |rule|
        Array(rule["ports"]).any? do |port|
          port["port"].is_a?(String) || port["endPort"].is_a?(String)
        end
      end
    end
    abort("mcp-host egress must use numeric ports") if named_port

    hcc_lane = policies.any? do |policy|
      next false unless policy_types_include_egress.call(policy) &&
        exact_pod_selector.call(policy, { "clerum.io/managed-by" => "host-context-controller" })
      Array(policy.dig("spec", "egress")).any? do |rule|
        ports = Array(rule["ports"])
        peers = Array(rule["to"])
        ports.any? { |port| port["port"] == 8081 && port.fetch("protocol", "TCP") == "TCP" } &&
          peers.any? do |peer|
            peer.dig("namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "control-plane" &&
              peer.dig("podSelector", "matchLabels", "app") == "host-context-controller-api-gateway"
          end
      end
    end
    abort("mcp-host to HCC TCP 8081 lane is absent") unless hcc_lane

    allows_tcp_port = lambda do |rule, expected_port|
      ports = rule["ports"]
      next false if ports.nil? || Array(ports).empty?

      Array(ports).any? do |port|
        next false unless port.fetch("protocol", "TCP") == "TCP"

        first = port["port"]
        last = port.fetch("endPort", first)
        if first.is_a?(Integer) && last.is_a?(Integer)
          first <= expected_port && expected_port <= last
        else
          false
        end
      end
    end
    host_proxy_lane = policies.any? do |policy|
      Array(policy.dig("spec", "egress")).any? do |rule|
        allows_tcp_port.call(rule, 8083)
      end
    end
    abort("mcp-host must not gain an egress lane to mcp-proxy TCP 8083") if host_proxy_lane

    secret_reading_role = lambda do |role|
      Array(role["rules"]).any? do |rule|
        api_groups = Array(rule["apiGroups"])
        resources = Array(rule["resources"])
        verbs = Array(rule["verbs"])
        (api_groups.include?("") || api_groups.include?("*")) &&
          (resources.include?("secrets") || resources.include?("*")) &&
          !(verbs & %w[get list watch *]).empty?
      end
    end
    roles = documents.each_with_object({}) do |document, index|
      next unless %w[Role ClusterRole].include?(document["kind"])

      namespace = document["kind"] == "Role" ? document.dig("metadata", "namespace") : nil
      index[[document["kind"], namespace, document.dig("metadata", "name")]] = document
    end
    subject_is_mcp_host_identity = lambda do |subject|
      case subject["kind"]
      when "ServiceAccount"
        subject["namespace"] == "mcp-host"
      when "User"
        subject["name"].to_s.match?(/\Asystem:serviceaccount:mcp-host:[^:]+\z/)
      when "Group"
        %w[system:authenticated system:serviceaccounts system:serviceaccounts:mcp-host].include?(subject["name"])
      else
        false
      end
    end
    host_mcp_secret_grant = documents.any? do |binding|
      next false unless %w[RoleBinding ClusterRoleBinding].include?(binding["kind"])

      binding_namespace = binding.dig("metadata", "namespace")
      host_subject = Array(binding["subjects"]).any? { |subject| subject_is_mcp_host_identity.call(subject) }
      next false unless host_subject
      next false unless binding["kind"] == "ClusterRoleBinding" || binding_namespace == "mcp-server"

      role_kind = binding.dig("roleRef", "kind")
      role_namespace = role_kind == "Role" ? binding_namespace : nil
      role = roles[[role_kind, role_namespace, binding.dig("roleRef", "name")]]
      role && secret_reading_role.call(role)
    end
    abort("mcp-host identities must not receive MCP Secret read grants") if host_mcp_secret_grant
  ' "${rendered}"

  echo "PASS: NP-08 rendered contract (${rendered##*/})"
done
