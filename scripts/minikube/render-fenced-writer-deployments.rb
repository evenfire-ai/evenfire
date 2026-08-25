#!/usr/bin/env ruby
# Render a complete Kubernetes manifest while preserving an explicit writer
# fence. Recovery must never apply the ordinary one-replica Deployment objects
# before the orchestrator has restored them deliberately.

require "optparse"
require "yaml"

targets = []
OptionParser.new do |parser|
  parser.on("--target NAMESPACE/NAME", "Deployment to keep at zero replicas") do |value|
    namespace, name = value.split("/", 2)
    abort "FENCED_RENDER_ERROR: target must be NAMESPACE/NAME" if namespace.nil? || name.nil? || namespace.empty? || name.empty?
    targets << [namespace, name]
  end
end.parse!

abort "FENCED_RENDER_ERROR: at least one target Deployment is required" if targets.empty?
abort "FENCED_RENDER_ERROR: duplicate target Deployment" unless targets.uniq.length == targets.length

documents = YAML.load_stream($stdin.read)
seen = Hash.new(0)

documents.each do |document|
  next unless document.is_a?(Hash) && document["kind"] == "Deployment"

  metadata = document["metadata"]
  namespace = metadata.is_a?(Hash) ? metadata["namespace"] : nil
  name = metadata.is_a?(Hash) ? metadata["name"] : nil
  key = [namespace, name]
  next unless targets.include?(key)

  spec = document["spec"]
  abort "FENCED_RENDER_ERROR: target #{namespace}/#{name} has no Deployment spec" unless spec.is_a?(Hash)
  spec["replicas"] = 0
  seen[key] += 1
end

missing = targets.reject { |target| seen[target] == 1 }
abort "FENCED_RENDER_ERROR: target Deployment missing or duplicated: #{missing.map { |namespace, name| "#{namespace}/#{name}" }.join(", ")}" unless missing.empty?

print YAML.dump_stream(*documents)
