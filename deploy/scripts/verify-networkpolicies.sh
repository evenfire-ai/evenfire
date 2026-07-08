#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OVERLAY=""
CONTEXT=""
FORBID_CIDR="${FORBID_CIDR:-10.109.0.1/32}"

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy/scripts/verify-networkpolicies.sh --overlay <minikube|gcp-dev|gcp-prod> [--context <kubectl-context>]

Renders the selected overlay, extracts NetworkPolicies, and verifies that every
rendered namespace/name exists in the target cluster. This script is read-only:
it never applies manifests.
USAGE
}

die() {
  echo "[verify-networkpolicies] ERROR: $*" >&2
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
    --context)
      CONTEXT="${2:-}"
      shift 2
      ;;
    --forbid-cidr)
      FORBID_CIDR="${2:-}"
      shift 2
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

if [[ -z "${OVERLAY}" ]]; then
  usage
  exit 2
fi

OVERLAY_DIR="${REPO_ROOT}/deploy/overlays/${OVERLAY}"
if [[ ! -d "${OVERLAY_DIR}" ]]; then
  die "overlay not found: ${OVERLAY_DIR}"
fi

require_command kubectl
require_command ruby

KCTL=(kubectl)
if [[ -n "${CONTEXT}" ]]; then
  KCTL=(kubectl --context "${CONTEXT}")
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

rendered="${tmp_dir}/rendered.yaml"
expected="${tmp_dir}/expected.txt"
actual="${tmp_dir}/actual.txt"
actual_json="${tmp_dir}/actual.json"
missing="${tmp_dir}/missing.txt"
drift="${tmp_dir}/drift.txt"

kubectl kustomize "${OVERLAY_DIR}" >"${rendered}"

"${REPO_ROOT}/deploy/scripts/lint-networkpolicies.sh" \
  --rendered "${rendered}" \
  --no-standalone

"${REPO_ROOT}/deploy/scripts/lint-workload-hardening.sh" \
  --rendered "${rendered}" \
  --exceptions "${WORKLOAD_HARDENING_EXCEPTIONS:-${REPO_ROOT}/deploy/security/workload-hardening-exceptions.yaml}"

if [[ -n "${FORBID_CIDR}" ]] && grep -Fq "cidr: ${FORBID_CIDR}" "${rendered}"; then
  echo "[verify-networkpolicies] ERROR: overlay ${OVERLAY} rendered forbidden CIDR ${FORBID_CIDR}" >&2
  exit 1
fi

"${KCTL[@]}" get networkpolicy -A -o json >"${actual_json}"

RUBYOPT=--disable=gems ruby -ryaml -rjson - "${rendered}" "${actual_json}" "${expected}" "${actual}" "${missing}" "${drift}" <<'RUBY'
rendered_path, actual_path, expected_path, actual_names_path, missing_path, drift_path = ARGV

def deep_sort(value)
  case value
  when Hash
    value.keys.sort.each_with_object({}) do |key, acc|
      acc[key] = deep_sort(value[key])
    end
  when Array
    value.map { |entry| deep_sort(entry) }.sort_by { |entry| JSON.generate(entry) }
  else
    value
  end
end

def normalize_ports(rule)
  ports = rule['ports']
  return unless ports.is_a?(Array)

  ports.each do |port|
    next unless port.is_a?(Hash)

    port['protocol'] ||= 'TCP'
  end
end

def normalize_policy_spec(spec)
  normalized = Marshal.load(Marshal.dump(spec || {}))
  %w[ingress egress].each do |direction|
    rules = normalized[direction]
    next unless rules.is_a?(Array)

    if rules.empty?
      normalized.delete(direction)
      next
    end

    rules.each do |rule|
      normalize_ports(rule) if rule.is_a?(Hash)
    end
  end
  deep_sort(normalized)
end

def equivalent_policy_specs?(expected, actual)
  expected_norm = normalize_policy_spec(expected)
  actual_norm = normalize_policy_spec(actual)

  unless expected&.key?('policyTypes') && actual&.key?('policyTypes')
    expected_norm.delete('policyTypes')
    actual_norm.delete('policyTypes')
  end

  expected_norm == actual_norm
end

expected_specs = {}
YAML.load_stream(File.read(rendered_path)) do |doc|
  next unless doc.is_a?(Hash)
  next unless doc['kind'] == 'NetworkPolicy'

  meta = doc['metadata'] || {}
  name = meta['name']
  namespace = meta['namespace'] || 'default'
  expected_specs["#{namespace}/#{name}"] = doc['spec'] || {} if name
end

actual_doc = JSON.parse(File.read(actual_path))
actual_specs = {}
(actual_doc['items'] || []).each do |item|
  next unless item.is_a?(Hash)

  meta = item['metadata'] || {}
  name = meta['name']
  namespace = meta['namespace'] || 'default'
  actual_specs["#{namespace}/#{name}"] = item['spec'] || {} if name
end

expected_keys = expected_specs.keys.sort
actual_keys = actual_specs.keys.sort
missing = expected_keys.reject { |key| actual_specs.key?(key) }
drift = expected_keys.select do |key|
  actual_specs.key?(key) && !equivalent_policy_specs?(expected_specs[key], actual_specs[key])
end

File.write(expected_path, expected_keys.join("\n") + (expected_keys.empty? ? '' : "\n"))
File.write(actual_names_path, actual_keys.join("\n") + (actual_keys.empty? ? '' : "\n"))
File.write(missing_path, missing.join("\n") + (missing.empty? ? '' : "\n"))
File.write(drift_path, drift.join("\n") + (drift.empty? ? '' : "\n"))
RUBY

if [[ ! -s "${expected}" ]]; then
  echo "[verify-networkpolicies] ERROR: overlay ${OVERLAY} rendered no NetworkPolicies" >&2
  exit 1
fi

if [[ -s "${missing}" ]]; then
  echo "[verify-networkpolicies] ERROR: cluster is missing rendered NetworkPolicies for overlay ${OVERLAY}:" >&2
  sed 's/^/  - /' "${missing}" >&2
  exit 1
fi

if [[ -s "${drift}" ]]; then
  echo "[verify-networkpolicies] ERROR: cluster NetworkPolicy specs differ from rendered overlay ${OVERLAY}:" >&2
  sed 's/^/  - /' "${drift}" >&2
  exit 1
fi

echo "[verify-networkpolicies] OK: $(wc -l <"${expected}" | tr -d ' ') NetworkPolicies from ${OVERLAY} exist and match ${CONTEXT:-current context}"
