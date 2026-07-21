#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT_DIR/scripts/e2e/seed-gfs-grant-workflow.sh"
FIXTURE="$ROOT_DIR/tests/e2e/fixtures/gfs-grant-e2e-plugin-recipe.yaml"

bash -n "$HELPER"
source "$HELPER"

rendered="$(render_gfs_grant_plugin_fixture "$FIXTURE")"
printf '%s' "$rendered" | jq -e '
  .apiVersion == "clerum.io/v1alpha1"
  and .kind == "WorkflowRecipe"
  and .metadata.name == "gfs-grant-e2e-plugin"
  and .metadata.namespace == "sandbox-recipes"
  and (.spec.inputContract.required | sort == ["resourceId", "updatedContent"])
  and (.spec.steps | length == 4)
  and (.spec.steps[0].id == "approval-held-gfs-read")
  and (.spec.steps[0].allowedTools.include == ["clerum__gfs_read"])
  and (.spec.steps[0].toolChoice == "required")
  and (.spec.steps[0].maxIterations == 3)
  and (.spec.steps[1].id == "gfs-stat-probe")
  and (.spec.steps[1].dependsOn == ["approval-held-gfs-read"])
  and (.spec.steps[1].allowedTools.include == ["clerum__gfs_stat"])
  and (.spec.steps[1].toolChoice == "required")
  and (.spec.steps[1].maxIterations == 3)
  and (.spec.steps[2].id == "gfs-write-probe")
  and (.spec.steps[2].dependsOn == ["gfs-stat-probe"])
  and (.spec.steps[2].allowedTools.include == ["clerum__gfs_write"])
  and (.spec.steps[2].toolChoice == "required")
  and (.spec.steps[2].maxIterations == 3)
  and (.spec.steps[2].instruction | contains("{{gfs-stat-probe:output}}"))
  and (.spec.steps[3].id == "read-back-gfs-probe")
  and (.spec.steps[3].dependsOn == ["gfs-write-probe"])
  and (.spec.steps[3].allowedTools.include == ["clerum__gfs_read"])
  and (.spec.steps[3].toolChoice == "required")
  and (.spec.steps[3].maxIterations == 3)
  and (.spec.workloads | any(
    .id == "mock-tools"
    and .transport == {type: "streamableHttp", path: "/mcp"}
  ))
  and (.spec.gfs.mounts | any(
    .drive == "main"
    and .target == "e2e/gfs-grant-e2e-plugin"
    and (.scopes | sort == ["gfs.read", "gfs.write"])
  ))
' >/dev/null

current_contract="$(printf '%s' "$rendered" | normalize_gfs_grant_plugin_contract)"
superseded_contract="$(printf '%s' "$rendered" | superseded_gfs_grant_plugin_contract)"
legacy_contract="$(printf '%s' "$rendered" | legacy_gfs_grant_plugin_contract)"
previous_contract="$(printf '%s' "$rendered" | previous_gfs_grant_plugin_contract)"
current_previous_contract="$(printf '%s' "$rendered" | current_previous_gfs_grant_plugin_contract)"
interim_contract="$(printf '%s' "$rendered" | interim_gfs_grant_plugin_contract)"
two_iteration_contract="$(printf '%s' "$rendered" | two_iteration_gfs_grant_plugin_contract)"
test "$current_contract" != "$legacy_contract"
test "$current_contract" != "$superseded_contract"
test "$current_contract" != "$previous_contract"
test "$current_contract" != "$current_previous_contract"
test "$current_contract" != "$interim_contract"
test "$current_contract" != "$two_iteration_contract"
printf '%s' "$two_iteration_contract" | jq -e '
  (.steps | length == 4)
  and all(.steps[]; .maxIterations == 2)
' >/dev/null
deployed_superseded_contract="$(printf '%s' "$superseded_contract" | jq -c '
  .agent.provider = "seeded-provider"
  | .agent.model = "seeded-model"
  | .steps[0].requiresApproval.target.userId = "11111111-1111-4111-8111-111111111111"
')"
test "$(printf '%s' "$deployed_superseded_contract" | jq -c '{spec: .}' | normalize_gfs_grant_plugin_contract)" = "$superseded_contract"
printf '%s' "$legacy_contract" | jq -e '
  (has("inputContract") | not)
  and (.steps[0].instruction == "Use the mock-tools MCP server only after the seeded user approves this E2E run.")
  and (.steps[0] | has("allowedTools") | not)
  and (.steps[0] | has("toolChoice") | not)
  and (.steps[0].maxIterations == 5)
  and (.steps | length == 1)
' >/dev/null
printf '%s' "$superseded_contract" | jq -e '
  (.steps | length == 2)
  and (.steps[0].id == "approval-held-gfs-probe")
  and (.steps[0].allowedTools.include | sort == [
    "clerum__gfs_read",
    "clerum__gfs_stat",
    "clerum__gfs_write"
  ])
  and (.steps[0].maxIterations == 6)
  and (.steps[1].id == "read-back-gfs-probe")
  and (.steps[1].dependsOn == ["approval-held-gfs-probe"])
' >/dev/null
printf '%s' "$previous_contract" | jq -e '
  .steps[0].maxIterations == 50
  and .steps[0].toolChoice == "required"
  and (.steps | length == 1)
  and (.inputContract.required | sort == ["resourceId", "updatedContent"])
' >/dev/null
printf '%s' "$current_previous_contract" | jq -e '
  .steps[0].maxIterations == 5
  and .steps[0].toolChoice == "required"
  and (.steps | length == 1)
  and (.inputContract.required | sort == ["resourceId", "updatedContent"])
' >/dev/null
printf '%s' "$interim_contract" | jq -e '
  .steps[0].maxIterations == 7
  and .steps[0].toolChoice == "required"
  and (.steps | length == 1)
  and (.inputContract.required | sort == ["resourceId", "updatedContent"])
' >/dev/null

echo "PASS: GFS grant WorkflowRecipe seed fixture renders through the helper contract"
