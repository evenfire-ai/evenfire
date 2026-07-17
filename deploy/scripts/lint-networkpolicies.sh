#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OVERLAY=""
RENDERED=""
INCLUDE_STANDALONE="yes"

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy/scripts/lint-networkpolicies.sh --overlay <minikube|gcp-dev|gcp-prod>
  deploy/scripts/lint-networkpolicies.sh --rendered <rendered-yaml>

Read-only render lint for Clerum NetworkPolicies. It blocks policy shapes that
create false confidence before Calico enforcement is enabled.
USAGE
}

die() {
  echo "[lint-networkpolicies] ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --overlay)
      OVERLAY="${2:-}"
      shift 2
      ;;
    --rendered)
      RENDERED="${2:-}"
      shift 2
      ;;
    --no-standalone)
      INCLUDE_STANDALONE="no"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -n "${OVERLAY}" && -n "${RENDERED}" ]]; then
  die "pass either --overlay or --rendered, not both"
fi
if [[ -z "${OVERLAY}" && -z "${RENDERED}" ]]; then
  usage
  exit 2
fi

require_command ruby

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

PUBLIC_EGRESS_EXCEPTIONS="${REPO_ROOT}/deploy/base/public-egress-exceptions.yaml"
PUBLIC_EGRESS_RENDERER="${REPO_ROOT}/deploy/scripts/render-public-egress-exceptions.rb"

inputs=()
if [[ -n "${OVERLAY}" ]]; then
  require_command kubectl
  overlay_dir="${REPO_ROOT}/deploy/overlays/${OVERLAY}"
  [[ -d "${overlay_dir}" ]] || die "overlay not found: ${overlay_dir}"
  rendered="${tmp_dir}/${OVERLAY}.yaml"
  kubectl kustomize "${overlay_dir}" >"${rendered}"
  inputs+=("${rendered}")
else
  [[ -f "${RENDERED}" ]] || die "rendered file not found: ${RENDERED}"
  inputs+=("${RENDERED}")
fi

if [[ "${INCLUDE_STANDALONE}" == "yes" ]]; then
  shopt -s nullglob
  for dir in "${REPO_ROOT}"/mcp-servers/*; do
    [[ -d "${dir}" ]] || continue
    if [[ -f "${dir}/networkpolicy.yaml" ]]; then
      rendered_standalone="${tmp_dir}/mcp-$(basename "${dir}")-networkpolicy.yaml"
      RUBYOPT=--disable=gems ruby "${PUBLIC_EGRESS_RENDERER}" "${PUBLIC_EGRESS_EXCEPTIONS}" "${dir}/networkpolicy.yaml" >"${rendered_standalone}"
      inputs+=("${rendered_standalone}")
    fi
    for file in "${dir}"/networkpolicy-*.yaml; do
      inputs+=("${file}")
    done
  done
  shopt -u nullglob
fi

RUBYOPT=--disable=gems ruby -ryaml - "${PUBLIC_EGRESS_EXCEPTIONS}" "${inputs[@]}" <<'RUBY'
exceptions_path = ARGV.shift
raw_exceptions = YAML.load_file(exceptions_path) || {}
required_public_exceptions = Array(raw_exceptions.dig('spec', 'ranges'))
if required_public_exceptions.empty?
  warn "#{exceptions_path}: spec.ranges must define the public egress exception CIDRs"
  exit 1
end
required_public_exceptions.freeze
dns_infrastructure_cidrs = %w[
  203.0.113.10/32
  169.254.20.10/32
].freeze

issues = []
policy_count = 0

dns_ports_only = lambda do |ports|
  Array(ports).map do |port|
    next unless port.is_a?(Hash)

    [(port['protocol'] || 'TCP').to_s.upcase, port['port'].to_s]
  end.compact.sort == [['TCP', '53'], ['UDP', '53']]
end

ARGV.each do |path|
  YAML.load_stream(File.read(path)) do |doc|
    next unless doc.is_a?(Hash)
    next unless doc['kind'] == 'NetworkPolicy'

    policy_count += 1
    meta = doc['metadata'] || {}
    spec = doc['spec'] || {}
    namespace = meta['namespace'] || 'default'
    name = meta['name'] || '<unnamed>'
    label = "#{path}: #{namespace}/#{name}"

    (spec['egress'] || []).each_with_index do |rule, rule_index|
      next unless rule.is_a?(Hash)

      ports = rule['ports']
      destinations = rule['to']
      if ports.is_a?(Array) && !ports.empty? && (!destinations.is_a?(Array) || destinations.empty?)
        issues << "#{label} egress[#{rule_index}] has ports but no to; this allows those ports to every destination"
      end

      Array(destinations).each_with_index do |peer, peer_index|
        next unless peer.is_a?(Hash)

        if peer.key?('namespaceSelector') && (peer['namespaceSelector'].nil? || peer['namespaceSelector'] == {})
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] has an empty namespaceSelector"
        end
        if peer.key?('podSelector') && (peer['podSelector'].nil? || peer['podSelector'] == {})
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] has an empty podSelector"
        end

        ip_block = peer['ipBlock']
        next unless ip_block.is_a?(Hash)

        cidr = ip_block['cidr']
        if cidr == '169.254.169.254/32' || cidr == '169.254.169.254'
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] allows metadata server directly; require an explicit WIF decision"
        end
        if dns_infrastructure_cidrs.include?(cidr) && !dns_ports_only.call(ports)
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] uses DNS infrastructure CIDR #{cidr} without limiting the rule to TCP/UDP 53"
        end
        next unless cidr == '0.0.0.0/0'

        if !ports.is_a?(Array) || ports.empty?
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] uses 0.0.0.0/0 without explicit ports"
        end

        actual_exceptions = Array(ip_block['except'])
        missing = required_public_exceptions - actual_exceptions
        unless missing.empty?
          issues << "#{label} egress[#{rule_index}].to[#{peer_index}] uses 0.0.0.0/0 without public-only exceptions: missing #{missing.join(', ')}"
        end
      end
    end

    (spec['ingress'] || []).each_with_index do |rule, rule_index|
      next unless rule.is_a?(Hash)

      ports = rule['ports']
      sources = rule['from']
      if ports.is_a?(Array) && !ports.empty? && (!sources.is_a?(Array) || sources.empty?)
        issues << "#{label} ingress[#{rule_index}] has ports but no from; this allows those ports from every source"
      end

      Array(sources).each_with_index do |peer, peer_index|
        next unless peer.is_a?(Hash)

        if peer.key?('namespaceSelector') && (peer['namespaceSelector'].nil? || peer['namespaceSelector'] == {})
          issues << "#{label} ingress[#{rule_index}].from[#{peer_index}] has an empty namespaceSelector"
        end
        if peer.key?('podSelector') && (peer['podSelector'].nil? || peer['podSelector'] == {})
          issues << "#{label} ingress[#{rule_index}].from[#{peer_index}] has an empty podSelector"
        end
      end
    end
  end
end

if policy_count.zero?
  warn '[lint-networkpolicies] ERROR: no NetworkPolicies found'
  exit 1
end

unless issues.empty?
  warn "[lint-networkpolicies] ERROR: #{issues.length} unsafe NetworkPolicy shape(s):"
  issues.each { |issue| warn "  - #{issue}" }
  exit 1
end

puts "[lint-networkpolicies] OK: #{policy_count} NetworkPolicies passed render lint"
RUBY
