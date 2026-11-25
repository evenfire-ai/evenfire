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
cat > "$OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-config.patch.yaml
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

expected = 'https://profile.legacy.example.test'
control = find_resource.call('ConfigMap', 'control-plane', 'control-api-config')
external = find_resource.call('ConfigMap', 'profiles', 'desktop-profile-ui-config')
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
end

puts "PASS R2-M1: both service Deployments use #{expected} from one legacy operator input"
RUBY
