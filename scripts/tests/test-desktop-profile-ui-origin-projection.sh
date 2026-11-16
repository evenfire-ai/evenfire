#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${CODEX_SCRATCH_ROOT:-}" ]]; then
  echo 'CODEX_SCRATCH_ROOT is required for task-owned render artifacts' >&2
  exit 2
fi
TASK_SCRATCH="$CODEX_SCRATCH_ROOT/evenfire/pr-1463-r2-m1-r48-20261115"
mkdir -p "$TASK_SCRATCH"
FIXTURE_ROOT="$(mktemp -d "$TASK_SCRATCH/projection-render.XXXXXX")"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

cp -R "$REPO_ROOT/deploy" "$FIXTURE_ROOT/deploy"
DEPLOY="$FIXTURE_ROOT/deploy"

verify_projection() {
  local manifest="$1"
  local expected_source="${2:-}"
  local label="$3"
  local only_service="${4:-}"

ruby -r yaml -r uri -r ipaddr -r json -r open3 - "$manifest" "$expected_source" "$label" "$only_service" <<'RUBY'
manifest_path, expected_source, label, only_service = ARGV
documents = YAML.load_stream(File.read(manifest_path)).compact

def find_resource(documents, kind, namespace, name, label)
  documents.find do |resource|
    resource.is_a?(Hash) && resource['kind'] == kind &&
      resource.dig('metadata', 'namespace') == namespace &&
      resource.dig('metadata', 'name') == name
  end || raise("#{kind} #{namespace}/#{name} is absent from rendered #{label}")
end

def effective_env(documents, container, namespace, label, target_name)
  values = {}
  Array(container['envFrom']).each do |source|
    ref = source['configMapRef']
    if !ref && source['secretRef']
      # Secret contents are intentionally not read. Model the unknown source
      # conservatively: a later Secret may override any validated Profile UI
      # or paired REST input.
      if %w[
        CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
        CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL
        EXTERNAL_REST_API_PUBLIC_BASE_URL
      ].include?(target_name)
        values[target_name] = :unresolved_secret_override
      end
      next
    end
    unless ref
      raise "#{label}: cannot verify non-ConfigMap envFrom source"
    end
    config_map = documents.find do |resource|
      resource.is_a?(Hash) && resource['kind'] == 'ConfigMap' &&
        resource.dig('metadata', 'namespace') == namespace &&
        resource.dig('metadata', 'name') == ref['name']
    end
    if !config_map && ref['optional'] == true
      next
    end
    raise "#{label}: unresolved envFrom ConfigMap #{namespace}/#{ref['name']}" unless config_map
    prefix = source['prefix'].to_s
    (config_map['data'] || {}).each { |key, value| values["#{prefix}#{key}"] = value }
    (config_map['binaryData'] || {}).each_key do |key|
      values["#{prefix}#{key}"] = :unresolved_binary_value
    end
  end

  explicit = Array(container['env']).select do |entry|
    entry['name'] == target_name
  end
  raise "#{label}: duplicate explicit #{target_name} variables" if explicit.length > 1
  unless explicit.empty?
    entry = explicit.first
    if entry.key?('valueFrom')
      if entry.key?('value') && !entry['value'].to_s.empty?
        raise "#{label}: #{target_name} has both value and valueFrom"
      end
      source = entry['valueFrom']
      config_map_ref = source['configMapKeyRef']
      unless config_map_ref
        values[entry['name']] = :unresolved_explicit_value
        return values
      end
      config_map = documents.find do |resource|
        resource.is_a?(Hash) && resource['kind'] == 'ConfigMap' &&
          resource.dig('metadata', 'namespace') == namespace &&
          resource.dig('metadata', 'name') == config_map_ref['name']
      end
      if !config_map && config_map_ref['optional'] == true
        # An absent optional valueFrom does not erase a same-named value
        # supplied by an earlier envFrom source.
      elsif !config_map
        raise "#{label}: unresolved explicit ConfigMap #{namespace}/#{config_map_ref['name']}"
      else
        value = config_map.dig('data', config_map_ref['key'])
        if value.nil?
          unless config_map_ref['optional'] == true
            raise "#{label}: missing required ConfigMap key #{namespace}/#{config_map_ref['name']}:#{config_map_ref['key']}"
          end
          # Leave an earlier envFrom value intact when this key is optional.
        else
          values[entry['name']] = value
        end
      end
    else
      values[entry['name']] = entry['value'].to_s
    end
  end
  values
end

def parsed_url(value, label, role, origin_only: false)
  raise "#{label}: #{role} URL is empty" unless value.is_a?(String) && !value.empty?
  if origin_only
    raw_origin = /\Ahttps?:\/\/([^\/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?\z/i.match(value)
    unless value == value.strip && !value.include?('\\') &&
           !value.match?(/[\x00-\x20\x7f]/) && raw_origin &&
           ['', '/'].include?(raw_origin[2]) && !value.include?('?') && !value.include?('#')
      raise "#{label}: #{role} URL is not a safe HTTP(S) origin"
    end
  end
  parser = 'const u = new URL(process.argv[1]); process.stdout.write(JSON.stringify({' \
    'scheme: u.protocol.slice(0, -1), host: u.hostname, username: u.username, ' \
    'password: u.password, path: u.pathname, query: u.search, fragment: u.hash }))'
  output, status = Open3.capture2('node', '-e', parser, value)
  raise "#{label}: #{role} URL is malformed" unless status.success?
  url = JSON.parse(output)
  unless %w[http https].include?(url['scheme']) && url['host'] &&
         url['username'].empty? && url['password'].empty?
    raise "#{label}: #{role} URL is not an absolute URL without credentials"
  end
  url
rescue JSON::ParserError
  raise "#{label}: #{role} URL is malformed"
end

def loopback_host?(host)
  normalized = host.downcase.sub(/\.$/, '')
  return true if normalized == 'localhost'

  IPAddr.new(normalized).loopback?
rescue IPAddr::InvalidAddressError
  false
end

def private_ip_host?(host)
  normalized = host.delete_prefix('[').delete_suffix(']').downcase
  ip = IPAddr.new(normalized)
  if ip.ipv4?
    ranges = %w[
      0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16
      172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16
      198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
    ].map { |range| IPAddr.new(range) }
    return ranges.any? { |range| range.include?(ip) }
  end

  ipv6_ranges = %w[::/128 fc00::/7 fe80::/10 fec0::/10 ff00::/8].map { |range| IPAddr.new(range) }
  mapped = ip.ipv4_mapped?
  ipv6_ranges.any? { |range| range.include?(ip) } ||
    (mapped && private_ip_host?(ip.native.to_s))
rescue IPAddr::InvalidAddressError
  false
end

def validate_profile_origin(profile_value, rest_value, label)
  profile = parsed_url(profile_value, label, 'Profile UI', origin_only: true)
  rest = parsed_url(rest_value, label, 'External REST')
  profile_host = profile.fetch('host').delete_prefix('[').delete_suffix(']')
  rest_host = rest.fetch('host').delete_prefix('[').delete_suffix(']')
  profile_loopback = loopback_host?(profile_host)
  rest_loopback = loopback_host?(rest_host)

  unless %w[http https].include?(profile['scheme']) &&
         ['/'].include?(profile['path']) && profile['query'].empty? && profile['fragment'].empty?
    raise "#{label}: Profile UI value is not a safe HTTP(S) origin"
  end
  if profile_loopback && !rest_loopback
    raise "#{label}: loopback Profile UI origin is paired with remote External REST"
  end
  if !profile_loopback && private_ip_host?(profile_host)
    raise "#{label}: private Profile UI IP origin is not permitted"
  end
  if profile['scheme'] == 'http' && !(profile_loopback && rest_loopback)
    raise "#{label}: HTTP Profile UI origin requires paired loopback services"
  end
  [profile, rest]
end

source = find_resource(documents, 'ConfigMap', 'control-plane', 'control-api-config', label)
target = find_resource(documents, 'ConfigMap', 'profiles', 'desktop-profile-ui-config', label)
source_url = source.dig('data', 'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL')
target_url = target.dig('data', 'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL')
if source.dig('data', 'DESKTOP_PROFILE_UI_PUBLIC_BASE_URL') ||
   target.dig('data', 'DESKTOP_PROFILE_UI_PUBLIC_BASE_URL')
  raise "#{label}: obsolete independent Profile UI URL alias is rendered"
end

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
  next if !only_service.empty? && deployment_name != only_service

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
  Array(container['env']).each do |entry|
    if entry['name'] == 'DESKTOP_PROFILE_UI_PUBLIC_BASE_URL'
      raise "#{label}: #{namespace}/#{deployment_name} declares an obsolete independent alias"
    end
  end
  effective = effective_env(
    documents, container, namespace, label, 'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL'
  )
  effective_value = effective['CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL']
  unless effective_value == source_url
    raise "#{label}: #{namespace}/#{deployment_name} effective canonical origin #{effective_value.inspect} differs from #{source_url.inspect}"
  end

  rest_variable = deployment_name == 'control-api' ?
    'CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL' : 'EXTERNAL_REST_API_PUBLIC_BASE_URL'
  rest_values = effective_env(documents, container, namespace, label, rest_variable)
  rest_value = rest_values[rest_variable]
  raise "#{label}: #{namespace}/#{deployment_name} effective #{rest_variable} is unresolved" unless rest_value.is_a?(String)
  validate_profile_origin(effective_value, rest_value, "#{label} #{namespace}/#{deployment_name}")
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

for overlay in minikube-no-uis minikube-ghcr minikube-no-uis-ghcr; do
  kubectl kustomize "$DEPLOY/overlays/$overlay" > "$FIXTURE_ROOT/$overlay.yaml"
  verify_projection "$FIXTURE_ROOT/$overlay.yaml" \
    'http://127.0.0.1:3001' "$overlay"
done

CUSTOM_OVERLAY="$DEPLOY/overlays/profile-ui-origin-regression"
mkdir -p "$CUSTOM_OVERLAY"
cat > "$CUSTOM_OVERLAY/profile-ui-config.patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.prod.example.test
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

# Existing operators patch only the established Control API setting. The final
# assembled manifests must project that same value to External REST.
LEGACY_OVERLAY="$DEPLOY/overlays/profile-ui-legacy-only-regression"
mkdir -p "$LEGACY_OVERLAY"
cat > "$LEGACY_OVERLAY/control-api-config.patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.legacy.example.test
YAML
cat > "$LEGACY_OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-config.patch.yaml
YAML

kubectl kustomize "$LEGACY_OVERLAY" > "$FIXTURE_ROOT/legacy-only.yaml"
verify_projection "$FIXTURE_ROOT/legacy-only.yaml" \
  'https://profile.legacy.example.test' 'legacy-only operator overlay'

# A direct workload override can defeat ConfigMap projection. The checker must
# fail closed on that assembled Deployment rather than pass on ConfigMap equality.
CONFLICT_OVERLAY="$DEPLOY/overlays/profile-ui-explicit-override-regression"
mkdir -p "$CONFLICT_OVERLAY"
cat > "$CONFLICT_OVERLAY/conflicting-origin.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: conflicting-profile-origin
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.conflict.example.test
YAML
cat > "$CONFLICT_OVERLAY/control-api.patch.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: control-api
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: control-api
          env:
            - name: CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
              valueFrom:
                configMapKeyRef:
                  name: conflicting-profile-origin
                  key: CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
YAML
cat > "$CONFLICT_OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - conflicting-origin.yaml
patches:
  - path: control-api.patch.yaml
YAML
kubectl kustomize "$CONFLICT_OVERLAY" > "$FIXTURE_ROOT/explicit-override.yaml"
if verify_projection "$FIXTURE_ROOT/explicit-override.yaml" \
  'http://127.0.0.1:3001' 'explicit conflicting Deployment override'; then
  echo 'explicit conflicting Deployment override escaped projection validation' >&2
  exit 1
else
  echo 'PASS explicit conflicting Deployment override is rejected'
fi

# Empty explicit env values override envFrom in Kubernetes. The checker must
# resolve the effective container value, not discard empty strings as nil.
EMPTY_OVERRIDE="$DEPLOY/overlays/profile-ui-empty-env-override-regression"
mkdir -p "$EMPTY_OVERRIDE"
cat > "$EMPTY_OVERRIDE/empty-origin.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: empty-profile-origin
  namespace: profiles
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: ''
YAML
cat > "$EMPTY_OVERRIDE/control-api.patch.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-rest-api
  namespace: profiles
spec:
  template:
    spec:
      containers:
        - name: external-rest-api
          env:
            - name: CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
              valueFrom:
                configMapKeyRef:
                  name: empty-profile-origin
                  key: CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
YAML
cat > "$EMPTY_OVERRIDE/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - empty-origin.yaml
patches:
  - path: control-api.patch.yaml
YAML
kubectl kustomize "$EMPTY_OVERRIDE" > "$FIXTURE_ROOT/empty-env-override.yaml"
if verify_projection "$FIXTURE_ROOT/empty-env-override.yaml" \
  'http://127.0.0.1:3001' 'empty explicit Deployment override'; then
  echo 'empty explicit Deployment override escaped projection validation' >&2
  exit 1
else
  echo 'PASS empty explicit Deployment override is rejected'
fi

# A later envFrom source overrides an earlier envFrom source. This overlay
# models an accidental second ConfigMap projection in the final workload.
ENVFROM_CONFLICT="$DEPLOY/overlays/profile-ui-envfrom-conflict-regression"
mkdir -p "$ENVFROM_CONFLICT"
cat > "$ENVFROM_CONFLICT/conflicting-origin.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: conflicting-profile-origin
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://wrong.example.test
YAML
cat > "$ENVFROM_CONFLICT/control-api.patch.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: control-api
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: control-api
          envFrom:
            - configMapRef:
                name: control-api-config
            - configMapRef:
                name: conflicting-profile-origin
YAML
cat > "$ENVFROM_CONFLICT/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - conflicting-origin.yaml
patches:
  - path: control-api.patch.yaml
YAML
kubectl kustomize "$ENVFROM_CONFLICT" > "$FIXTURE_ROOT/envfrom-conflict.yaml"
verify_projection "$FIXTURE_ROOT/envfrom-conflict.yaml" \
  'http://127.0.0.1:3001' 'conflicting envFrom is overridden by canonical explicit projection'

# An out-of-band Secret can contain unexpected keys. The Control API's
# explicit valueFrom projection must keep such a same-named Secret key from
# becoming a second Profile UI origin source.
SECRET_OVERRIDE="$DEPLOY/overlays/profile-ui-secret-shadow-regression"
mkdir -p "$SECRET_OVERRIDE"
cat > "$SECRET_OVERRIDE/control-api-secret.patch.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: control-api-internal-tokens
  namespace: control-plane
stringData:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://shadow.example.test
YAML
cat > "$SECRET_OVERRIDE/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-secret.patch.yaml
YAML
kubectl kustomize "$SECRET_OVERRIDE" > "$FIXTURE_ROOT/secret-shadow.yaml"
verify_projection "$FIXTURE_ROOT/secret-shadow.yaml" \
  'http://127.0.0.1:3001' 'Secret shadow cannot override canonical origin'

# An External REST Secret appended after its canonical ConfigMap can override
# the environment variable at runtime. Since the oracle never reads Secret
# data, it must reject this unresolved later source instead of passing based
# only on rendered ConfigMap equality.
LATE_REST_SECRET="$DEPLOY/overlays/profile-ui-late-rest-secret-regression"
mkdir -p "$LATE_REST_SECRET"
cat > "$LATE_REST_SECRET/rest-secret.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: external-rest-profile-shadow
  namespace: profiles
stringData:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://shadow.example.test
YAML
cat > "$LATE_REST_SECRET/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - rest-secret.yaml
patches:
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: external-rest-api
      namespace: profiles
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/envFrom/-
        value:
          secretRef:
            name: external-rest-profile-shadow
YAML
kubectl kustomize "$LATE_REST_SECRET" > "$FIXTURE_ROOT/late-rest-secret.yaml"
if verify_projection "$FIXTURE_ROOT/late-rest-secret.yaml" \
  'http://127.0.0.1:3001' 'later External REST Secret envFrom' \
  >"$FIXTURE_ROOT/late-rest-secret.log" 2>&1; then
  echo 'later External REST Secret envFrom escaped projection validation' >&2
  exit 1
fi
if ! grep -Fq 'effective canonical origin :unresolved_secret_override' \
  "$FIXTURE_ROOT/late-rest-secret.log"; then
  cat "$FIXTURE_ROOT/late-rest-secret.log" >&2
  echo 'later External REST Secret failed for an unexpected reason' >&2
  exit 1
fi
echo 'PASS later External REST Secret envFrom is rejected as unresolved precedence'

# Control API also imports Secrets after its configuration ConfigMap. Pin its
# REST pairing input to the existing ConfigMap explicitly so an unexpected
# same-named Secret key cannot change the value used by runtime validation.
LATE_CONTROL_SECRET="$DEPLOY/overlays/profile-ui-late-control-secret-regression"
mkdir -p "$LATE_CONTROL_SECRET"
cat > "$LATE_CONTROL_SECRET/control-secret.patch.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: control-api-internal-tokens
  namespace: control-plane
stringData:
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: https://api.remote.example.test
YAML
cat > "$LATE_CONTROL_SECRET/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-secret.patch.yaml
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: control-api
      namespace: control-plane
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/envFrom/-
        value:
          secretRef:
            name: control-api-internal-tokens
YAML
kubectl kustomize "$LATE_CONTROL_SECRET" > "$FIXTURE_ROOT/late-control-secret.yaml"
verify_projection "$FIXTURE_ROOT/late-control-secret.yaml" \
  'http://127.0.0.1:3001' 'Control API REST pairing is pinned against later Secret envFrom'

# A missing optional valueFrom does not prove that a prior envFrom Secret
# value disappears. Preserve that unknown effective value and fail closed.
OPTIONAL_REST_REFERENCE="$DEPLOY/overlays/profile-ui-optional-rest-reference-regression"
mkdir -p "$OPTIONAL_REST_REFERENCE"
cat > "$OPTIONAL_REST_REFERENCE/rest-secret.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: control-api-remote-rest
  namespace: control-plane
stringData:
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: https://api.remote.example.test
YAML
cat > "$OPTIONAL_REST_REFERENCE/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - rest-secret.yaml
patches:
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: control-api
      namespace: control-plane
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/env/1/valueFrom/configMapKeyRef/name
        value: missing-optional-rest-config
      - op: add
        path: /spec/template/spec/containers/0/env/1/valueFrom/configMapKeyRef/optional
        value: true
      - op: add
        path: /spec/template/spec/containers/0/envFrom/-
        value:
          secretRef:
            name: control-api-remote-rest
YAML
kubectl kustomize "$OPTIONAL_REST_REFERENCE" > "$FIXTURE_ROOT/optional-rest-reference.yaml"
if verify_projection "$FIXTURE_ROOT/optional-rest-reference.yaml" \
  'http://127.0.0.1:3001' 'missing optional REST reference' control-api \
  >"$FIXTURE_ROOT/optional-rest-reference.log" 2>&1; then
  echo 'missing optional REST reference erased a Secret override in the oracle' >&2
  exit 1
fi
if ! grep -Fq 'effective CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL is unresolved' \
  "$FIXTURE_ROOT/optional-rest-reference.log"; then
  cat "$FIXTURE_ROOT/optional-rest-reference.log" >&2
  echo 'optional REST reference failed for an unexpected reason' >&2
  exit 1
fi
echo 'PASS missing optional REST reference preserves unknown Secret precedence and fails closed'

MISSING_REQUIRED_KEY="$DEPLOY/overlays/profile-ui-missing-required-key-regression"
mkdir -p "$MISSING_REQUIRED_KEY"
cat > "$MISSING_REQUIRED_KEY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: control-api
      namespace: control-plane
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/env/1/valueFrom/configMapKeyRef/key
        value: MISSING_REQUIRED_REST_KEY
YAML
kubectl kustomize "$MISSING_REQUIRED_KEY" > "$FIXTURE_ROOT/missing-required-key.yaml"
if verify_projection "$FIXTURE_ROOT/missing-required-key.yaml" \
  'http://127.0.0.1:3001' 'missing required REST key' control-api \
  >"$FIXTURE_ROOT/missing-required-key.log" 2>&1; then
  echo 'missing required REST ConfigMap key passed projection validation' >&2
  exit 1
fi
if ! grep -Fq 'missing required ConfigMap key' "$FIXTURE_ROOT/missing-required-key.log"; then
  cat "$FIXTURE_ROOT/missing-required-key.log" >&2
  echo 'missing required REST key failed for an unexpected reason' >&2
  exit 1
fi
echo 'PASS missing required REST ConfigMap key is rejected'

expect_projection_rejection() {
  local case_name="$1"
  local profile_origin="$2"
  local expected_error="$3"
  local rest_origin="${4:-http://127.0.0.1:4000}"
  local overlay="$DEPLOY/overlays/profile-ui-invalid-${case_name}"
  mkdir -p "$overlay"
  cat > "$overlay/control-api-config.patch.yaml" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: '$profile_origin'
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: '$rest_origin'
YAML
  cat > "$overlay/external-rest-deployment.patch.yaml" <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-rest-api
  namespace: profiles
spec:
  template:
    spec:
      containers:
        - name: external-rest-api
          env:
            - name: EXTERNAL_REST_API_PUBLIC_BASE_URL
              value: '$rest_origin'
YAML
  cat > "$overlay/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-config.patch.yaml
  - path: external-rest-deployment.patch.yaml
YAML
  local rendered="$FIXTURE_ROOT/invalid-${case_name}.yaml"
  kubectl kustomize "$overlay" > "$rendered"
  for service in control-api external-rest-api; do
    local log="$FIXTURE_ROOT/invalid-${case_name}-${service}.log"
    if verify_projection "$rendered" '' "invalid $case_name" "$service" >"$log" 2>&1; then
      echo "invalid $case_name origin passed $service validation" >&2
      exit 1
    fi
    if ! grep -Fq "$expected_error" "$log"; then
      cat "$log" >&2
      echo "invalid $case_name failed in $service for an unexpected reason" >&2
      exit 1
    fi
  done
  echo "PASS invalid $case_name rejected by Control API and External REST: $expected_error"
}

# REST endpoint paths and queries are part of the full selected endpoint
# identity. They are not subject to Profile UI's origin-only restriction.
REST_PATH_OVERLAY="$DEPLOY/overlays/profile-ui-rest-path-regression"
mkdir -p "$REST_PATH_OVERLAY"
cat > "$REST_PATH_OVERLAY/control-api-config.patch.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.example.test
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: https://api.example.test/api/v1?region=west
YAML
cat > "$REST_PATH_OVERLAY/external-rest-deployment.patch.yaml" <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-rest-api
  namespace: profiles
spec:
  template:
    spec:
      containers:
        - name: external-rest-api
          env:
            - name: EXTERNAL_REST_API_PUBLIC_BASE_URL
              value: https://api.example.test/api/v1?region=west
YAML
cat > "$REST_PATH_OVERLAY/kustomization.yaml" <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: control-api-config.patch.yaml
  - path: external-rest-deployment.patch.yaml
YAML
kubectl kustomize "$REST_PATH_OVERLAY" > "$FIXTURE_ROOT/rest-path-query.yaml"
verify_projection "$FIXTURE_ROOT/rest-path-query.yaml" \
  'https://profile.example.test' 'REST path and query remain supported'

expect_projection_rejection unsafe-scheme 'javascript:alert(1)' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection path 'https://profile.example.test/path' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection dot-segment 'https://profile.example.test/..' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection empty-query 'https://profile.example.test/?' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection empty-fragment 'https://profile.example.test/#' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection trailing-backslash 'https://profile.example.test\' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection leading-whitespace ' https://profile.example.test' \
  'Profile UI URL is not a safe HTTP(S) origin'
expect_projection_rejection remote-http 'http://profile.example.test' \
  'HTTP Profile UI origin requires paired loopback services' 'https://api.example.test'
expect_projection_rejection remote-rest-loopback-ui 'http://127.0.0.1:3001' \
  'loopback Profile UI origin is paired with remote External REST' 'https://api.example.test'
expect_projection_rejection private-ip 'https://10.0.0.5' \
  'private Profile UI IP origin is not permitted'
expect_projection_rejection mapped-private-ip 'https://[::ffff:10.0.0.5]' \
  'private Profile UI IP origin is not permitted'
expect_projection_rejection ipv6-multicast 'https://[ff02::1]' \
  'private Profile UI IP origin is not permitted'
expect_projection_rejection ipv6-multicast-site 'https://[ff05::1]' \
  'private Profile UI IP origin is not permitted'
expect_projection_rejection decimal-loopback 'https://2130706433' \
  'loopback Profile UI origin is paired with remote External REST' \
  'https://api.example.test'
expect_projection_rejection hexadecimal-private-ip 'https://0x0a000005' \
  'private Profile UI IP origin is not permitted'
expect_projection_rejection percent-encoded-private-ip 'https://%31%30.0.0.5' \
  'private Profile UI IP origin is not permitted'
