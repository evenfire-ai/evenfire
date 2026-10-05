# Select, from a rendered overlay, the NetworkPolicies that Evenfire's
# ValidatingAdmissionPolicy `managed-networkpolicy-label-immutability` lets only
# the HCC / WRC service accounts or the `system:masters` group CREATE: those
# labelled clerum.io/managed-by = host-context-controller | wrc | workflow-recipes.
#
# DOKS cluster admins are `cluster-admin` through a role binding, not members
# of `system:masters`, so the guide applies this subset once with
# `kubectl --as=evenfire-bootstrap --as-group=system:masters` before the normal
# apply. Later applies are UPDATEs, which the policy allows while the label is
# unchanged.
#
# Usage: ruby managed-netpols.rb < render.yaml > managed-netpols.yaml
require "yaml"

MANAGED = %w[host-context-controller wrc workflow-recipes].freeze

picked = YAML.load_stream($stdin.read).compact.select do |doc|
  doc["kind"] == "NetworkPolicy" &&
    MANAGED.include?((doc.dig("metadata", "labels") || {})["clerum.io/managed-by"])
end
abort "managed-netpols: no managed-labelled NetworkPolicies in the render" if picked.empty?
puts picked.map { |d| YAML.dump(d) }.join
