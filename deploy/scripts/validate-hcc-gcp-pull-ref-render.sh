#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for overlay in gcp-dev gcp-prod; do
  kubectl kustomize "deploy/overlays/${overlay}" >"${tmp_dir}/${overlay}.yaml"
done

ruby -ryaml - "$tmp_dir/gcp-dev.yaml" "$tmp_dir/gcp-prod.yaml" <<'RUBY'
files = {
  "gcp-dev" => ARGV[0],
  "gcp-prod" => ARGV[1],
}

required_empty = [
  "CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET",
  "CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET",
]

# The gcp-dev/gcp-prod overlays patch CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES to
# the real Artifact Registry + example.com prefixes (see
# deploy/overlays/gcp-{dev,prod}/patches/hcc-allowed-image-prefixes.yaml).
# deploy/base only ships a vendor-neutral default — this asserts the overlay
# override actually lands in the rendered Deployment for BOTH clusters, so a
# base-genericization change can never silently regress gcp-dev/gcp-prod back
# to the neutral placeholder.
required_values = {
  "CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES" =>
    "ghcr.io/evenfire-ai/,example.com/,mongodb/,mcr.microsoft.com/,clerum/",
}

def fail!(overlay, message)
  warn "#{overlay}: #{message}"
  exit 1
end

files.each do |overlay, path|
  docs = YAML.load_stream(File.read(path)).compact
  deploy = docs.find do |doc|
    doc.is_a?(Hash) &&
      doc["kind"] == "Deployment" &&
      doc.dig("metadata", "namespace") == "control-plane" &&
      doc.dig("metadata", "name") == "host-context-controller"
  end
  fail!(overlay, "host-context-controller Deployment not rendered") unless deploy

  container = (deploy.dig("spec", "template", "spec", "containers") || [])
    .find { |c| c["name"] == "host-context-controller" }
  fail!(overlay, "host-context-controller container missing") unless container

  env = (container["env"] || []).each_with_object({}) do |entry, acc|
    acc[entry["name"]] = entry["value"] if entry.is_a?(Hash) && entry.key?("name")
  end

  required_empty.each do |name|
    fail!(overlay, "#{name} missing") unless env.key?(name)
    fail!(overlay, "#{name} must render as an explicit empty string") unless env[name] == ""
  end

  required_values.each do |name, expected|
    fail!(overlay, "#{name} missing") unless env.key?(name)
    unless env[name] == expected
      fail!(overlay, "#{name} expected #{expected.inspect}, got #{env[name].inspect}")
    end
  end
end

puts "HCC GCP pull-ref render contract OK"
RUBY
