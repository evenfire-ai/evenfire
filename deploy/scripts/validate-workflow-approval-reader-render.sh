#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for overlay in minikube gcp-dev gcp-prod; do
  kubectl kustomize "deploy/overlays/${overlay}" >"${tmp_dir}/${overlay}.yaml"
done

ruby -ryaml - "$tmp_dir/minikube.yaml" "$tmp_dir/gcp-dev.yaml" "$tmp_dir/gcp-prod.yaml" <<'RUBY'
files = {
  "minikube" => ARGV[0],
  "gcp-dev" => ARGV[1],
  "gcp-prod" => ARGV[2],
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
      doc.dig("metadata", "namespace") == "channels" &&
      doc.dig("metadata", "name") == "clerum-workflow-approval-request-reader"
  end
  fail!(overlay, "workflow approval reader Deployment not rendered in channels") unless deploy

  pod_spec = deploy.dig("spec", "template", "spec") || {}
  fail!(overlay, "serviceAccountName mismatch") unless pod_spec["serviceAccountName"] == "clerum-workflow-approval-request-reader"

  container = (pod_spec["containers"] || []).find { |c| c["name"] == "workflow-approval-request-reader" }
  fail!(overlay, "workflow approval reader container missing") unless container

  image = container["image"].to_s
  pull_policy = container["imagePullPolicy"].to_s
  if overlay == "minikube"
    fail!(overlay, "unexpected image #{image}") unless image == "clerum/workflow-approval-request-reader:test"
    fail!(overlay, "unexpected imagePullPolicy #{pull_policy}") unless pull_policy == "IfNotPresent"
  else
    expected_prefix = "us-central1-docker.pkg.dev/${GCP_PROJECT}/clerum/workflow-approval-request-reader:"
    fail!(overlay, "image is not rewritten to Artifact Registry: #{image}") unless image.start_with?(expected_prefix)
    fail!(overlay, "unexpected imagePullPolicy #{pull_policy}") unless pull_policy == "Always"
  end

  env_from_config = (container["envFrom"] || []).any? do |entry|
    entry.dig("configMapRef", "name") == "clerum-workflow-approval-request-reader-config"
  end
  fail!(overlay, "config map envFrom missing") unless env_from_config

  config_map = docs.find do |doc|
    doc.is_a?(Hash) &&
      doc["kind"] == "ConfigMap" &&
      doc.dig("metadata", "namespace") == "channels" &&
      doc.dig("metadata", "name") == "clerum-workflow-approval-request-reader-config"
  end
  fail!(overlay, "workflow approval reader ConfigMap not rendered in channels") unless config_map

  config_data = config_map["data"] || {}
  fail!(overlay, "reader ConfigMap must not set CONTROL_API_BASE_URL") if config_data.key?("CONTROL_API_BASE_URL")
  fail!(overlay, "reader ConfigMap must not set WORKFLOW_APPROVAL_READER_MCP_HOST_BASE_URL") if config_data.key?("WORKFLOW_APPROVAL_READER_MCP_HOST_BASE_URL")
  fail!(overlay, "reader ConfigMap must not set WORKFLOW_APPROVAL_READER_MCP_HOST_REF") if config_data.key?("WORKFLOW_APPROVAL_READER_MCP_HOST_REF")
  fail!(overlay, "reader ConfigMap must not set Telegram delivery API root") if config_data.key?("WORKFLOW_APPROVAL_READER_TELEGRAM_API_ROOT")
  fail!(overlay, "reader ConfigMap must not set Slack delivery API root") if config_data.key?("WORKFLOW_APPROVAL_READER_SLACK_API_ROOT")
  fail!(overlay, "reader ConfigMap must not poll notification deliveries") if config_data.key?("WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_INTERVAL_MS")
  fail!(overlay, "reader ConfigMap must not poll notification deliveries") if config_data.key?("WORKFLOW_APPROVAL_READER_NOTIFICATION_POLL_LIMIT")
  if config_data.values.any? { |value| value.to_s.include?("chatllm") }
    fail!(overlay, "reader ConfigMap must not default to chatllm")
  end

  env = container["env"] || []
  env_names = env.map { |entry| entry["name"] }
  fail!(overlay, "reader must not mount CONTROL_API_BASE_URL") if env_names.include?("CONTROL_API_BASE_URL")
  fail!(overlay, "reader must not mount WORKFLOW_APPROVAL_READER_SERVICE_TOKEN") if env_names.include?("WORKFLOW_APPROVAL_READER_SERVICE_TOKEN")
  fail!(overlay, "reader must not mount CONTROL_API_INTERNAL_SERVICE_TOKENS") if env_names.include?("CONTROL_API_INTERNAL_SERVICE_TOKENS")
  fail!(overlay, "reader must not mount Telegram bot token") if env_names.include?("WORKFLOW_APPROVAL_READER_TELEGRAM_BOT_TOKEN")
  fail!(overlay, "reader must not mount Slack bot token") if env_names.include?("WORKFLOW_APPROVAL_READER_SLACK_BOT_TOKEN")
  fail!(overlay, "reader must not mount Discord provider keys in Figure D") if env_names.include?("WORKFLOW_APPROVAL_READER_DISCORD_PUBLIC_KEY")

  secret_names = env.map { |entry| entry.dig("valueFrom", "secretKeyRef", "name") }.compact.uniq
  unless secret_names == ["workflow-approval-request-reader-credentials"]
    fail!(overlay, "unexpected secret refs: #{secret_names.inspect}")
  end
end

puts "workflow approval reader deployment contract OK"
RUBY
