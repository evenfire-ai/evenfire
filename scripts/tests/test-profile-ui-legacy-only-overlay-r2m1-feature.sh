#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

cp -R "$REPO_ROOT/deploy" "$FIXTURE_ROOT/deploy"
DEPLOY="$FIXTURE_ROOT/deploy"
OVERLAY="$DEPLOY/overlays/profile-ui-legacy-only-r2m1"
mkdir -p "$OVERLAY"
cat > "$OVERLAY/control-api-config.patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.legacy.example.test
YAML
cat > "$OVERLAY/control-api-secret.patch.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: control-api-internal-tokens
  namespace: control-plane
stringData:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.secret.example.test
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: https://api.secret.example.test
YAML
cat > "$OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-config.patch.yaml
  - path: control-api-secret.patch.yaml
YAML

kubectl kustomize "$OVERLAY" > "$FIXTURE_ROOT/rendered.yaml"
ruby -r yaml - "$FIXTURE_ROOT/rendered.yaml" <<'RUBY'
documents = YAML.load_stream(File.read(ARGV.fetch(0))).compact
find_resource = lambda do |kind, namespace, name|
  documents.find do |resource|
    resource.is_a?(Hash) && resource['kind'] == kind &&
      resource.dig('metadata', 'namespace') == namespace &&
      resource.dig('metadata', 'name') == name
  end || raise("#{kind} #{namespace}/#{name} is absent from rendered legacy-only overlay")
end
validate_control_api_secret_sources = lambda do |container, config_map_name|
  env_from = Array(container['envFrom'])
  config_index = env_from.index do |entry|
    entry.dig('configMapRef', 'name') == config_map_name
  end
  known_secret_names = %w[control-api-internal-tokens internal-control-jwt-secrets]
  later_secret_names = env_from.each_with_index.each_with_object([]) do |(entry, index), names|
    next unless config_index && index > config_index
    names << entry.dig('secretRef', 'name') if entry.dig('secretRef', 'name')
  end
  unless config_index && later_secret_names.include?('control-api-internal-tokens') &&
         (later_secret_names - known_secret_names).empty?
    raise "unapproved or unordered Control API Secret source #{later_secret_names.inspect}"
  end
end

expected = 'https://profile.legacy.example.test'
secret_profile = 'https://profile.secret.example.test'
secret_rest = 'https://api.secret.example.test'
control = find_resource.call('ConfigMap', 'control-plane', 'control-api-config')
external = find_resource.call('ConfigMap', 'profiles', 'desktop-profile-ui-config')
control_secret = find_resource.call('Secret', 'control-plane', 'control-api-internal-tokens')
control_url = control.dig('data', 'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL')
external_data = external.fetch('data', {})
external_url = external_data['CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL'] ||
  external_data['DESKTOP_PROFILE_UI_PUBLIC_BASE_URL']
raise "Control API uses #{control_url.inspect}, expected #{expected.inspect}" unless control_url == expected
unless external_url == expected
  raise "External REST uses #{external_url.inspect}, expected canonical operator URL #{expected.inspect}"
end
raise 'External REST has an independent Profile UI URL setting' if external_data.key?('DESKTOP_PROFILE_UI_PUBLIC_BASE_URL')

{
  'external-rest-api' => ['profiles', 'external-rest-api', 'desktop-profile-ui-config'],
  'control-api' => ['control-plane', 'control-api', 'control-api-config'],
}.each do |name, (namespace, container_name, config_map_name)|
  deployment = find_resource.call('Deployment', namespace, name)
  container = deployment.dig('spec', 'template', 'spec', 'containers')&.find do |entry|
    entry['name'] == container_name
  end
  raise "Deployment #{namespace}/#{name} lacks container #{container_name}" unless container
  projected = Array(container['envFrom']).any? do |entry|
    entry.dig('configMapRef', 'name') == config_map_name
  end
  raise "Deployment #{namespace}/#{name} does not project #{config_map_name}" unless projected
  origin_name = 'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL'
  explicit = Array(container['env']).select { |entry| entry['name'] == origin_name }
  raise "Deployment #{namespace}/#{name} repeats #{origin_name}" if explicit.length > 1
  if name == 'control-api'
    unless explicit.empty?
      raise "Deployment #{namespace}/#{name} overrides envFrom Secret precedence for #{origin_name}"
    end
    validate_control_api_secret_sources.call(container, config_map_name)
    effective_profile = control.dig('data', origin_name)
    effective_rest = control.dig('data', 'CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL')
    secret_values = control_secret['stringData'] || {}
    effective_profile = secret_values[origin_name] if secret_values.key?(origin_name)
    rest_name = 'CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL'
    effective_rest = secret_values[rest_name] if secret_values.key?(rest_name)
    unless effective_profile == secret_profile && effective_rest == secret_rest
      raise "Control API effective values #{effective_profile.inspect}/#{effective_rest.inspect} did not preserve Secret precedence"
    end
    if effective_profile == external_url
      raise 'Control API Secret origin did not diverge from the External REST ConfigMap origin'
    end
  else
    raise "Deployment #{namespace}/#{name} explicitly overrides #{origin_name}" unless explicit.empty?
    last = Array(container['envFrom']).last
    unless last&.dig('configMapRef', 'name') == config_map_name
      raise "Deployment #{namespace}/#{name} has a later unverified envFrom source"
    end
  end
end

control_deployment = find_resource.call('Deployment', 'control-plane', 'control-api')
control_containers = control_deployment.dig('spec', 'template', 'spec', 'containers')
control_container = control_containers.find { |entry| entry['name'] == 'control-api' }
unknown_secret_container = Marshal.load(Marshal.dump(control_container))
unknown_secret_container['envFrom'] << { 'secretRef' => { 'name' => 'unapproved-control-secret' } }
begin
  validate_control_api_secret_sources.call(unknown_secret_container, 'control-api-config')
  raise 'unknown later Control API Secret source escaped legacy projection validation'
rescue RuntimeError => error
  unless error.message.include?('unapproved or unordered Control API Secret source')
    raise
  end
end

puts "PASS R2-M1: External REST uses #{expected}; Control API Secret origin may differ"
puts 'PASS legacy projection rejects unknown later Control API Secret sources'
RUBY
