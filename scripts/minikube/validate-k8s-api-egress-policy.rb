#!/usr/bin/env ruby
# Validate and extract the fully rendered control-plane Kubernetes API
# NetworkPolicy. The generated k8s-api-ip.yaml is a strategic-merge patch and
# is intentionally not safe to apply as a standalone resource.

require "json"
require "yaml"

TARGET_API_VERSION = "networking.k8s.io/v1"
TARGET_KIND = "NetworkPolicy"
TARGET_NAME = "allow-k8s-api-egress-control-plane"
TARGET_NAMESPACE = "control-plane"
EXPECTED_SELECTOR = {
  "matchExpressions" => [
    {
      "key" => "app",
      "operator" => "In",
      "values" => [
        "host-context-controller",
        "workflow-recipes",
        "control-api",
        "trace-maintenance-worker"
      ]
    }
  ]
}.freeze
EXPECTED_POLICY_TYPES = ["Egress"].freeze
EXPECTED_PORTS = [
  { "port" => 443, "protocol" => "TCP" },
  { "port" => 8443, "protocol" => "TCP" }
].freeze

class PolicyValidationError < StandardError; end

def fail_policy(message, status = 2)
  warn "K8S_API_POLICY_ERROR: #{message}"
  exit status
end

def target_identity!(policy)
  unless policy.is_a?(Hash) &&
         policy["apiVersion"] == TARGET_API_VERSION &&
         policy["kind"] == TARGET_KIND
    raise PolicyValidationError, "rendered object is not the expected NetworkPolicy"
  end

  metadata = policy["metadata"]
  unless metadata.is_a?(Hash) && metadata["name"] == TARGET_NAME &&
         metadata["namespace"] == TARGET_NAMESPACE
    raise PolicyValidationError, "NetworkPolicy identity is not control-plane/#{TARGET_NAME}"
  end
end

def validated_signature!(policy, expected_cidr, exact_ports:)
  target_identity!(policy)
  spec = policy["spec"]
  unless spec.is_a?(Hash) && spec.keys.sort == %w[egress podSelector policyTypes]
    raise PolicyValidationError, "NetworkPolicy spec is incomplete or contains unexpected fields"
  end
  unless spec["podSelector"] == EXPECTED_SELECTOR
    raise PolicyValidationError, "NetworkPolicy podSelector is not the complete control-plane writer selector"
  end
  unless spec["policyTypes"] == EXPECTED_POLICY_TYPES
    raise PolicyValidationError, "NetworkPolicy policyTypes is not exactly Egress"
  end

  egress = spec["egress"]
  unless egress.is_a?(Array) && egress.length == 1 && egress[0].is_a?(Hash)
    raise PolicyValidationError, "NetworkPolicy must contain exactly one egress rule"
  end
  rule = egress[0]
  unless rule.keys.sort == %w[ports to]
    raise PolicyValidationError, "NetworkPolicy egress rule is incomplete or contains unexpected fields"
  end

  peers = rule["to"]
  unless peers.is_a?(Array) && peers.length == 1 && peers[0].is_a?(Hash) &&
         peers[0].keys == ["ipBlock"] && peers[0]["ipBlock"].is_a?(Hash)
    raise PolicyValidationError, "NetworkPolicy must contain exactly one ipBlock peer"
  end
  ip_block = peers[0]["ipBlock"]
  unless ip_block.keys == ["cidr"] && ip_block["cidr"].is_a?(String) &&
         ip_block["cidr"].match?(/\A(?:\d{1,3}\.){3}\d{1,3}\/32\z/)
    raise PolicyValidationError, "NetworkPolicy must contain exactly one IPv4 /32 CIDR"
  end
  if exact_ports && ip_block["cidr"] != expected_cidr
    raise PolicyValidationError, "rendered NetworkPolicy CIDR does not match the current Kubernetes API endpoint"
  end

  ports = rule["ports"]
  unless ports.is_a?(Array) && !ports.empty? && ports.all? do |port|
    port.is_a?(Hash) && port.keys.sort == %w[port protocol] &&
      port["port"].is_a?(Integer) && [443, 8443].include?(port["port"]) &&
      port["protocol"] == "TCP"
  end
    raise PolicyValidationError, "NetworkPolicy ports are not restricted to TCP 443/8443"
  end
  normalized_ports = ports.map { |port| { "port" => port["port"], "protocol" => port["protocol"] } }
  if normalized_ports.uniq.length != normalized_ports.length
    raise PolicyValidationError, "NetworkPolicy egress ports contain duplicates"
  end
  if exact_ports && normalized_ports.sort_by { |port| port["port"] } != EXPECTED_PORTS
    raise PolicyValidationError, "rendered NetworkPolicy does not contain exactly TCP 443 and 8443"
  end

  {
    "selector" => spec["podSelector"],
    "policyTypes" => spec["policyTypes"],
    "ports" => normalized_ports.sort_by { |port| port["port"] },
    "cidr" => ip_block["cidr"]
  }
end

mode = ARGV.shift
cidr = ARGV.shift
unless ["--extract", "--check-live"].include?(mode) && cidr&.match?(/\A(?:\d{1,3}\.){3}\d{1,3}\/32\z/)
  fail_policy "usage: #{File.basename($PROGRAM_NAME)} --extract|--check-live <ipv4>/32"
end

if mode == "--extract"
  documents = YAML.load_stream($stdin.read).compact
  candidates = documents.select do |document|
    begin
      target_identity!(document)
      true
    rescue PolicyValidationError
      false
    end
  end
  fail_policy "rendered overlay must contain exactly one #{TARGET_NAMESPACE}/#{TARGET_NAME}" unless candidates.length == 1
  begin
    validated_signature!(candidates.first, cidr, exact_ports: true)
  rescue PolicyValidationError => error
    fail_policy error.message
  end
  # Emit only the complete, merged object. Applying this output cannot create
  # the broad all-pods policy that applying the strategic-merge patch itself
  # could create.
  print YAML.dump(candidates.first)
else
  raw = $stdin.read
  if raw.strip.empty?
    puts "MISSING"
    exit 1
  end
  begin
    live = JSON.parse(raw)
  rescue JSON::ParserError => error
    fail_policy "live NetworkPolicy JSON is invalid: #{error.message}"
  end
  begin
    signature = validated_signature!(live, cidr, exact_ports: false)
  rescue PolicyValidationError => error
    fail_policy error.message
  end
  if signature["cidr"] == cidr && signature["ports"] == EXPECTED_PORTS
    puts "MATCH"
    exit 0
  end
  puts "DRIFT"
  exit 1
end
