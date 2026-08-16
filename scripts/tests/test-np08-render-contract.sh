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
    hcc_lane = policies.any? do |policy|
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

    host_proxy_lane = policies.any? do |policy|
      Array(policy.dig("spec", "egress")).any? do |rule|
        Array(rule["ports"]).any? { |port| port["port"] == 8083 }
      end
    end
    abort("mcp-host must not gain an egress lane to mcp-proxy TCP 8083") if host_proxy_lane
  ' "${rendered}"

  echo "PASS: NP-08 rendered contract (${rendered##*/})"
done
