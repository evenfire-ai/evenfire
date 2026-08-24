#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
RENDERER="$ROOT/scripts/minikube/render-fenced-writer-deployments.rb"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-fenced-render.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT

cat >"$TMP_DIR/input.yaml" <<'EOF_YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  replicas: 1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-recipes
  namespace: control-plane
spec:
  replicas: 2
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: control-api
  namespace: control-plane
spec:
  replicas: 1
---
apiVersion: v1
kind: Service
metadata:
  name: control-api
  namespace: control-plane
EOF_YAML

output="$TMP_DIR/output.yaml"
ruby "$RENDERER" \
  --target control-plane/host-context-controller \
  --target control-plane/workflow-recipes \
  --target control-plane/control-api <"$TMP_DIR/input.yaml" >"$output"

ruby -ryaml -e '
docs = YAML.load_stream(File.read(ARGV.fetch(0)))
targets = %w[host-context-controller workflow-recipes control-api]
targets.each do |name|
  deployment = docs.find { |doc| doc.is_a?(Hash) && doc["kind"] == "Deployment" && doc.dig("metadata", "namespace") == "control-plane" && doc.dig("metadata", "name") == name }
  abort "missing #{name}" unless deployment
  abort "#{name} was not fenced" unless deployment.dig("spec", "replicas") == 0
end
service = docs.find { |doc| doc.is_a?(Hash) && doc["kind"] == "Service" }
abort "non-target resource was changed" unless service.dig("metadata", "name") == "control-api"
' "$output"

if ruby "$RENDERER" --target control-plane/missing <"$TMP_DIR/input.yaml" >"$TMP_DIR/missing.yaml" 2>"$TMP_DIR/missing.err"; then
  echo 'FAIL: renderer accepted a missing writer target' >&2
  exit 1
fi
grep -Fq 'FENCED_RENDER_ERROR' "$TMP_DIR/missing.err"

printf 'PASS: recovery overlay keeps every writer Deployment at zero replicas\n'
printf 'PASS: recovery overlay fails closed when a writer target is missing\n'
