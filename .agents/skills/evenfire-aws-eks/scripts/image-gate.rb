# Render gate for the customer overlay: every image must be an official
# ghcr.io/evenfire-ai/<name>:<RELEASE_TAG> pin or one of the third-party images
# deploy/base pins by exact tag/digest, and every HCC spawned-image env var
# whose code default is an unqualified clerum/* (docker.io) name must be set.
#
# Usage:
#   kubectl kustomize deploy/overlays/aws-eks | RELEASE_TAG=v0.8.0 ruby image-gate.rb
require "yaml"

tag = ENV.fetch("RELEASE_TAG")
third_party = %w[postgres:16-alpine nginx:1.30.1-alpine busybox:1.36]
third_party_re = %r{\Acloudflare/cloudflared@sha256:[0-9a-f]{64}\z}
# Unset HCC env vars fall back to code defaults such as
# clerum/mcp-host-desktop:latest, which resolve to Docker Hub.
required_hcc = %w[
  CONTEXT_MAPPER_HOST_IMAGE CONTEXT_MAPPER_DESKTOP_IMAGE CONTEXT_MAPPER_CHANNEL_READER_IMAGE
  CONTEXT_MAPPER_GFSC_IMAGE CONTEXT_MAPPER_EGRESS_PROXY_IMAGE CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE
  CONTEXT_MAPPER_WFC_IMAGE
]

bad = []
seen_hcc = {}
YAML.load_stream(STDIN.read).compact.each do |doc|
  next unless doc["kind"] == "Deployment"

  pod = doc.dig("spec", "template", "spec") || {}
  (Array(pod["containers"]) + Array(pod["initContainers"])).each do |c|
    refs = [["image", c["image"]]]
    Array(c["env"]).each { |e| refs << [e["name"], e["value"]] if e["name"].to_s.end_with?("_IMAGE") }
    refs.each do |name, ref|
      seen_hcc[name] = ref if doc.dig("metadata", "name") == "host-context-controller"
      next if ref.nil? || ref.empty? || ref !~ %r{[:/@]}

      ok = (ref.start_with?("ghcr.io/evenfire-ai/") && ref.end_with?(":#{tag}")) ||
           third_party.include?(ref) || ref.match?(third_party_re)
      bad << "#{doc["metadata"]["namespace"]}/#{doc["metadata"]["name"]} #{name}=#{ref}" unless ok
    end
  end
end
(required_hcc - seen_hcc.keys).each { |n| bad << "host-context-controller missing #{n}" }

if bad.empty?
  puts "image gate: OK"
else
  puts(bad.map { |b| "image gate FAIL: #{b}" })
  exit 1
end
