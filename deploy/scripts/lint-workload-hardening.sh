#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OVERLAY=""
RENDERED=""
EXCEPTIONS="${REPO_ROOT}/deploy/security/workload-hardening-exceptions.yaml"

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy/scripts/lint-workload-hardening.sh --overlay <minikube|gcp-dev|gcp-prod>
  deploy/scripts/lint-workload-hardening.sh --rendered <rendered-yaml>
USAGE
}

die() {
  echo "[lint-workload-hardening] ERROR: $*" >&2
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
    --exceptions)
      EXCEPTIONS="${2:-}"
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

if [[ -n "${OVERLAY}" && -n "${RENDERED}" ]]; then
  die "pass either --overlay or --rendered, not both"
fi
if [[ -z "${OVERLAY}" && -z "${RENDERED}" ]]; then
  usage
  exit 2
fi

require_command ruby
[[ -f "${EXCEPTIONS}" ]] || die "exceptions file not found: ${EXCEPTIONS}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

if [[ -n "${OVERLAY}" ]]; then
  require_command kubectl
  overlay_dir="${REPO_ROOT}/deploy/overlays/${OVERLAY}"
  [[ -d "${overlay_dir}" ]] || die "overlay not found: ${overlay_dir}"
  rendered="${tmp_dir}/${OVERLAY}.yaml"
  kubectl kustomize "${overlay_dir}" >"${rendered}"
else
  [[ -f "${RENDERED}" ]] || die "rendered file not found: ${RENDERED}"
  rendered="${RENDERED}"
fi

RUBYOPT=--disable=gems ruby -ryaml - "${EXCEPTIONS}" "${rendered}" <<'RUBY'
exceptions_path, rendered_path = ARGV
raw_exceptions = YAML.load_file(exceptions_path) || {}
exception_rows = Array(raw_exceptions['exceptions'])
issues = []

exceptions = {}
exception_rows.each_with_index do |entry, index|
  unless entry.is_a?(Hash) && entry['workload'].is_a?(String) && !entry['workload'].empty?
    issues << "#{exceptions_path}: exceptions[#{index}] is missing workload"
    next
  end
  unless entry['reason'].is_a?(String) && !entry['reason'].strip.empty?
    issues << "#{exceptions_path}: #{entry['workload']} is missing reason"
  end
  issues << "#{exceptions_path}: duplicate exception for #{entry['workload']}" if exceptions.key?(entry['workload'])
  exceptions[entry['workload']] = entry
end

docs = YAML.load_stream(File.read(rendered_path)).select { |doc| doc.is_a?(Hash) }
service_accounts = {}
docs.each do |doc|
  next unless doc['kind'] == 'ServiceAccount'
  namespace = doc.dig('metadata', 'namespace') || 'default'
  name = doc.dig('metadata', 'name')
  service_accounts[[namespace, name]] = doc if name
end

config_maps = {}
docs.each do |doc|
  next unless doc['kind'] == 'ConfigMap'
  namespace = doc.dig('metadata', 'namespace') || 'default'
  name = doc.dig('metadata', 'name')
  config_maps[[namespace, name]] = doc if name
end

pod_spec_for = lambda do |doc|
  case doc['kind']
  when 'Deployment', 'DaemonSet', 'StatefulSet', 'ReplicaSet'
    doc.dig('spec', 'template', 'spec')
  when 'Job'
    doc.dig('spec', 'template', 'spec')
  when 'CronJob'
    doc.dig('spec', 'jobTemplate', 'spec', 'template', 'spec')
  end
end

container_allowed = lambda do |exception, field, container_name, requested = nil|
  value = exception[field]
  return false if value.nil?
  return true if value == true
  return value.include?(container_name) if value.is_a?(Array)
  if value.is_a?(Hash)
    allowed = Array(value[container_name])
    return requested ? (Array(requested) - allowed).empty? : allowed.any?
  end
  false
end

nginx_container = lambda do |container|
  name = container['name'].to_s
  image = container['image'].to_s
  name == 'nginx' || image.start_with?('nginx:') || image.include?('/nginx:')
end

nginx_tmp_directives = %w[
  pid
  client_body_temp_path
  proxy_temp_path
  fastcgi_temp_path
  uwsgi_temp_path
  scgi_temp_path
]

workload_keys = []
workload_count = 0

docs.each do |doc|
  pod_spec = pod_spec_for.call(doc)
  next unless pod_spec.is_a?(Hash)

  workload_count += 1
  namespace = doc.dig('metadata', 'namespace') || 'default'
  name = doc.dig('metadata', 'name') || '<unnamed>'
  key = "#{namespace}/#{name}"
  workload_keys << key
  exception = exceptions.fetch(key, {})

  service_account_name = pod_spec['serviceAccountName'] || 'default'
  service_account = service_accounts[[namespace, service_account_name]] || {}
  pod_automount = pod_spec['automountServiceAccountToken']
  effective_token =
    if pod_automount == false
      false
    elsif pod_automount == true
      true
    elsif service_account['automountServiceAccountToken'] == false
      false
    else
      true
    end

  if effective_token && exception['allowServiceAccountToken'] != true
    issues << "#{key} mounts a ServiceAccount token without an explicit workload exception"
  end

  volumes = {}
  Array(pod_spec['volumes']).each do |volume|
    next unless volume.is_a?(Hash) && volume['name']
    volumes[volume['name']] = volume
  end

  pod_sc = pod_spec['securityContext'] || {}
  if pod_sc.dig('seccompProfile', 'type') != 'RuntimeDefault' && exception['allowMissingPodSeccomp'] != true
    issues << "#{key} is missing pod seccompProfile RuntimeDefault"
  end

  containers = Array(pod_spec['initContainers']) + Array(pod_spec['containers'])
  containers.each do |container|
    next unless container.is_a?(Hash)
    container_name = container['name'] || '<unnamed>'
    label = "#{key}/#{container_name}"
    sc = container['securityContext'] || {}
    missing_privilege_allowed = container_allowed.call(exception, 'allowMissingPrivilegeHardening', container_name)

    issues << "#{label} must set allowPrivilegeEscalation: false" unless sc['allowPrivilegeEscalation'] == false || missing_privilege_allowed

    cap_drop = Array(sc.dig('capabilities', 'drop'))
    issues << "#{label} must drop ALL capabilities" unless cap_drop.include?('ALL') || missing_privilege_allowed

    cap_add = Array(sc.dig('capabilities', 'add'))
    unless cap_add.empty? || container_allowed.call(exception, 'allowAddedCapabilities', container_name, cap_add)
      issues << "#{label} adds capabilities without an explicit exception: #{cap_add.join(', ')}"
    end

    unless sc['readOnlyRootFilesystem'] == true || container_allowed.call(exception, 'allowWritableRootFilesystem', container_name)
      issues << "#{label} must set readOnlyRootFilesystem: true or declare an owned exception"
    end

    run_as_non_root = sc['runAsNonRoot'] == true || pod_sc['runAsNonRoot'] == true
    unless run_as_non_root || container_allowed.call(exception, 'allowMissingRunAsNonRoot', container_name)
      issues << "#{label} must set runAsNonRoot: true at pod or container level"
    end

    next unless sc['readOnlyRootFilesystem'] == true && nginx_container.call(container)

    volume_mounts = Array(container['volumeMounts'])
    writable_tmp_mount = volume_mounts.any? do |mount|
      next false unless mount.is_a?(Hash) && mount['mountPath'] == '/tmp'
      volumes.dig(mount['name'], 'emptyDir').is_a?(Hash)
    end
    unless writable_tmp_mount
      issues << "#{label} runs nginx with readOnlyRootFilesystem but does not mount /tmp from emptyDir"
    end

    nginx_conf_mount = volume_mounts.find do |mount|
      mount.is_a?(Hash) && mount['mountPath'] == '/etc/nginx/nginx.conf'
    end
    nginx_conf = nil
    if nginx_conf_mount
      volume = volumes[nginx_conf_mount['name']]
      config_map_name = volume&.dig('configMap', 'name')
      config_key = nginx_conf_mount['subPath'] || 'nginx.conf'
      nginx_conf = config_maps[[namespace, config_map_name]]&.dig('data', config_key)
    end

    unless nginx_conf.is_a?(String)
      issues << "#{label} runs nginx with readOnlyRootFilesystem but does not mount nginx.conf from a ConfigMap"
      next
    end

    missing_tmp_directives = nginx_tmp_directives.reject do |directive|
      nginx_conf.match?(/^\s*#{Regexp.escape(directive)}\s+\/tmp(?:\/|\b)/)
    end
    unless missing_tmp_directives.empty?
      issues << "#{label} runs nginx with readOnlyRootFilesystem but nginx.conf does not place runtime paths under /tmp: #{missing_tmp_directives.join(', ')}"
    end
  end
end

(exceptions.keys - workload_keys).each do |key|
  issues << "#{exceptions_path}: exception references missing workload #{key}"
end

if workload_count.zero?
  warn '[lint-workload-hardening] ERROR: no rendered workloads found'
  exit 1
end

unless issues.empty?
  warn "[lint-workload-hardening] ERROR: #{issues.length} workload hardening issue(s):"
  issues.each { |issue| warn "  - #{issue}" }
  exit 1
end

puts "[lint-workload-hardening] OK: #{workload_count} workloads passed hardening lint with #{exceptions.length} owned exception(s)"
RUBY
