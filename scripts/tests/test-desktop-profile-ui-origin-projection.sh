#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_PARENT="${TMPDIR:-${CODEX_SCRATCH_ROOT:-/tmp}}"
mkdir -p "$TMP_PARENT"
FIXTURE_ROOT="$(mktemp -d "$TMP_PARENT/pr-1463-profile-ui-projection.XXXXXX")"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

cp -R "$REPO_ROOT/deploy" "$FIXTURE_ROOT/deploy"
DEPLOY="$FIXTURE_ROOT/deploy"

verify_projection() {
  local manifest="$1"
  local expected_source="${2:-}"
  local label="$3"

  ruby -r yaml - "$manifest" "$expected_source" "$label" <<'RUBY'
manifest_path, expected_source, label = ARGV
documents = YAML.load_stream(File.read(manifest_path)).compact

def find_resource(documents, kind, namespace, name, label)
  documents.find do |resource|
    resource.is_a?(Hash) && resource['kind'] == kind &&
      resource.dig('metadata', 'namespace') == namespace &&
      resource.dig('metadata', 'name') == name
  end || raise("#{kind} #{namespace}/#{name} is absent from rendered #{label}")
end

source = find_resource(documents, 'ConfigMap', 'profiles', 'desktop-profile-ui-config', label)
target = find_resource(documents, 'ConfigMap', 'control-plane', 'control-api-config', label)
source_url = source.dig('data', 'DESKTOP_PROFILE_UI_PUBLIC_BASE_URL')
target_url = target.dig('data', 'DESKTOP_PROFILE_UI_PUBLIC_BASE_URL')

if expected_source != '' && source_url != expected_source
  raise "#{label}: source URL #{source_url.inspect} did not match #{expected_source.inspect}"
end
unless source_url == target_url
  raise "#{label}: Control API URL #{target_url.inspect} differs from External REST source #{source_url.inspect}"
end

checks = {
  'external-rest-api' => ['profiles', 'external-rest-api', 'desktop-profile-ui-config'],
  'control-api' => ['control-plane', 'control-api', 'control-api-config'],
}
checks.each do |deployment_name, (namespace, container_name, config_map_name)|
  deployment = find_resource(documents, 'Deployment', namespace, deployment_name, label)
  container = deployment.dig('spec', 'template', 'spec', 'containers')&.find do |entry|
    entry['name'] == container_name
  end
  raise "#{label}: Deployment #{namespace}/#{deployment_name} lacks container #{container_name}" unless container

  projected_config_maps = Array(container['envFrom']).map do |entry|
    entry.dig('configMapRef', 'name')
  end.compact
  unless projected_config_maps.include?(config_map_name)
    raise "#{label}: #{namespace}/#{deployment_name} does not envFrom ConfigMap #{config_map_name}"
  end
end

puts "PASS #{label}: #{source_url} is projected into both service Deployments"
RUBY
}

kubectl kustomize "$DEPLOY/base" > "$FIXTURE_ROOT/base.yaml"
verify_projection "$FIXTURE_ROOT/base.yaml" 'http://127.0.0.1:3001' 'base'

# The Minikube API-IP file is an ignored render product. Generate a reserved
# documentation-range address in the copied fixture so this test never queries a cluster.
awk -v ip='192.0.2.77' '
  /^[[:space:]]+cidr:/ { sub(/cidr:[[:space:]]*.*/, "cidr: " ip "/32"); }
  { print }
' "$DEPLOY/overlays/minikube/patches/k8s-api-ip.yaml.template" \
  > "$DEPLOY/overlays/minikube/patches/k8s-api-ip.yaml"
kubectl kustomize "$DEPLOY/overlays/minikube" > "$FIXTURE_ROOT/minikube.yaml"
verify_projection "$FIXTURE_ROOT/minikube.yaml" 'http://127.0.0.1:3001' 'minikube'

CUSTOM_OVERLAY="$DEPLOY/overlays/profile-ui-origin-regression"
mkdir -p "$CUSTOM_OVERLAY"
cat > "$CUSTOM_OVERLAY/profile-ui-config.patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: desktop-profile-ui-config
  namespace: profiles
data:
  DESKTOP_PROFILE_UI_PUBLIC_BASE_URL: https://profile.prod.example.test
YAML
cat > "$CUSTOM_OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: profile-ui-config.patch.yaml
YAML

kubectl kustomize "$CUSTOM_OVERLAY" > "$FIXTURE_ROOT/custom-production-style.yaml"
verify_projection "$FIXTURE_ROOT/custom-production-style.yaml" \
  'https://profile.prod.example.test' 'custom production-style overlay'
