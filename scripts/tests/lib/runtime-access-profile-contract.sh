#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CONTROL_PROFILE="$ROOT_DIR/deploy/scripts/control-api-runtime-access-profiles.tsv"
WORKFLOW_PROFILE="$ROOT_DIR/deploy/scripts/workflow-recipes-runtime-access-profiles.tsv"

validate_profile_file() {
  local role="$1" file="$2" expected_oidc_profile="$3"

  if [[ ! -r "$file" ]]; then
    printf 'FAIL: %s profile file is not readable: %s\n' "$role" "$file" >&2
    return 1
  fi

  awk -F '\t' -v role="$role" -v expected_oidc_profile="$expected_oidc_profile" '
    function fail(message) {
      print "FAIL: " message > "/dev/stderr"
      failed = 1
    }
    /^[[:space:]]*(#|$)/ { next }
    {
      if (NF != 2) {
        fail(role " profile has malformed row at line " FNR)
        next
      }
      if ($1 !~ /^[a-z][a-z0-9_]*$/) {
        fail(role " profile has invalid relation name at line " FNR)
      }
      if (role == "control-api") {
        allowed = ($2 == "legacy_dml" || $2 == "upsert" || $2 == "append" ||
          $2 == "read" || $2 == "link_lifecycle" || $2 == "insert_delete" || $2 == "none")
      } else if (role == "workflow-recipes") {
        allowed = ($2 == "legacy_dml" || $2 == "read" || $2 == "read_update" ||
          $2 == "upsert" || $2 == "delete" || $2 == "none")
      } else {
        fail("unknown runtime access-profile role: " role)
        allowed = 0
      }
      if (!allowed) {
        fail(role " profile has invalid access value at line " FNR ": " $2)
      }
      if (++seen[$1] > 1) {
        fail(role " profile has duplicate relation entry at line " FNR ": " $1)
      }
      if ($1 == "oidc_protocol_attempts") {
        oidc_count++
        oidc_profile = $2
      }
    }
    END {
      if (oidc_count != 1 || oidc_profile != expected_oidc_profile) {
        observed = oidc_count == 0 ? "missing" : oidc_profile
        fail(role " profile must declare oidc_protocol_attempts<TAB>" expected_oidc_profile \
          " (found " observed ")")
      }
      if (failed) {
        exit 1
      }
    }
  ' "$file"
}

expect_rejected() {
  local label="$1" role="$2" file="$3" expected_oidc_profile="$4"

  if validate_profile_file "$role" "$file" "$expected_oidc_profile" >/dev/null 2>&1; then
    printf 'FAIL: profile self-test accepted %s\n' "$label" >&2
    return 1
  fi
  printf 'PASS: profile self-test rejects %s\n' "$label"
}

seed_expected_oidc_profile() {
  local role="$1" source="$2" destination="$3" expected_profile="$4"

  awk -F '\t' '$1 != "oidc_protocol_attempts" { print }' "$source" > "$destination"
  printf 'oidc_protocol_attempts\t%s\n' "$expected_profile" >> "$destination"
}

self_test_profiles() {
  local temp_dir control_values workflow_values value index

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/evenfire-profile-contract.XXXXXX")"
  trap 'rm -rf -- "$temp_dir"' EXIT

  control_values=(legacy_dml upsert append read link_lifecycle insert_delete none)
  workflow_values=(legacy_dml read read_update upsert delete none)

  seed_expected_oidc_profile control-api "$CONTROL_PROFILE" \
    "$temp_dir/control-positive.tsv" legacy_dml
  for index in "${!control_values[@]}"; do
    printf 'contract_selftest_%s\t%s\n' "$index" "${control_values[$index]}" \
      >> "$temp_dir/control-positive.tsv"
  done
  validate_profile_file control-api "$temp_dir/control-positive.tsv" legacy_dml >/dev/null
  printf 'PASS: profile self-test accepts every Control API profile value\n'

  seed_expected_oidc_profile workflow-recipes "$WORKFLOW_PROFILE" \
    "$temp_dir/workflow-positive.tsv" none
  for index in "${!workflow_values[@]}"; do
    printf 'contract_selftest_%s\t%s\n' "$index" "${workflow_values[$index]}" \
      >> "$temp_dir/workflow-positive.tsv"
  done
  validate_profile_file workflow-recipes "$temp_dir/workflow-positive.tsv" none >/dev/null
  printf 'PASS: profile self-test accepts every Workflow Recipes profile value\n'

  seed_expected_oidc_profile control-api "$CONTROL_PROFILE" \
    "$temp_dir/control-cross-vocabulary.tsv" legacy_dml
  printf 'contract_selftest_invalid\tread_update\n' >> "$temp_dir/control-cross-vocabulary.tsv"
  expect_rejected 'Control API WRC-only read_update' control-api \
    "$temp_dir/control-cross-vocabulary.tsv" legacy_dml
  printf 'contract_selftest_invalid_delete\tdelete\n' >> "$temp_dir/control-cross-vocabulary.tsv"
  expect_rejected 'Control API WRC-only delete' control-api \
    "$temp_dir/control-cross-vocabulary.tsv" legacy_dml

  seed_expected_oidc_profile workflow-recipes "$WORKFLOW_PROFILE" \
    "$temp_dir/workflow-cross-vocabulary.tsv" none
  printf 'contract_selftest_invalid\tlink_lifecycle\n' >> "$temp_dir/workflow-cross-vocabulary.tsv"
  expect_rejected 'Workflow Recipes Control API-only link_lifecycle' workflow-recipes \
    "$temp_dir/workflow-cross-vocabulary.tsv" none
  printf 'contract_selftest_invalid_append\tappend\n' >> "$temp_dir/workflow-cross-vocabulary.tsv"
  expect_rejected 'Workflow Recipes Control API-only append' workflow-recipes \
    "$temp_dir/workflow-cross-vocabulary.tsv" none
  printf 'contract_selftest_invalid_insert_delete\tinsert_delete\n' \
    >> "$temp_dir/workflow-cross-vocabulary.tsv"
  expect_rejected 'Workflow Recipes Control API-only insert_delete' workflow-recipes \
    "$temp_dir/workflow-cross-vocabulary.tsv" none

  seed_expected_oidc_profile control-api "$CONTROL_PROFILE" \
    "$temp_dir/control-duplicate.tsv" legacy_dml
  printf 'oidc_protocol_attempts\tlegacy_dml\n' >> "$temp_dir/control-duplicate.tsv"
  expect_rejected 'duplicate Control API relation' control-api \
    "$temp_dir/control-duplicate.tsv" legacy_dml

  seed_expected_oidc_profile workflow-recipes "$WORKFLOW_PROFILE" \
    "$temp_dir/workflow-malformed.tsv" none
  printf 'malformed-row\nrelation_with_extra_field\tnone\textra\n' \
    >> "$temp_dir/workflow-malformed.tsv"
  expect_rejected 'malformed Workflow Recipes rows' workflow-recipes \
    "$temp_dir/workflow-malformed.tsv" none

  seed_expected_oidc_profile control-api "$CONTROL_PROFILE" \
    "$temp_dir/control-malformed.tsv" legacy_dml
  printf 'malformed-row\nrelation_with_extra_field\tnone\textra\n' \
    >> "$temp_dir/control-malformed.tsv"
  expect_rejected 'malformed Control API rows' control-api \
    "$temp_dir/control-malformed.tsv" legacy_dml

  seed_expected_oidc_profile workflow-recipes "$WORKFLOW_PROFILE" \
    "$temp_dir/workflow-duplicate.tsv" none
  printf 'oidc_protocol_attempts\tnone\n' >> "$temp_dir/workflow-duplicate.tsv"
  expect_rejected 'duplicate Workflow Recipes relation' workflow-recipes \
    "$temp_dir/workflow-duplicate.tsv" none

  awk -F '\t' '$1 != "oidc_protocol_attempts" { print }' "$WORKFLOW_PROFILE" \
    > "$temp_dir/workflow-missing-oidc.tsv"
  expect_rejected 'missing Workflow Recipes OIDC none sentinel' workflow-recipes \
    "$temp_dir/workflow-missing-oidc.tsv" none

  awk -F '\t' '$1 != "oidc_protocol_attempts" { print }' "$CONTROL_PROFILE" \
    > "$temp_dir/control-missing-oidc.tsv"
  expect_rejected 'missing Control API OIDC legacy_dml sentinel' control-api \
    "$temp_dir/control-missing-oidc.tsv" legacy_dml

  seed_expected_oidc_profile workflow-recipes "$WORKFLOW_PROFILE" \
    "$temp_dir/workflow-wrong-oidc.tsv" none
  awk -F '\t' 'BEGIN { OFS = "\t" } $1 == "oidc_protocol_attempts" { $2 = "read" } { print }' \
    "$temp_dir/workflow-wrong-oidc.tsv" > "$temp_dir/workflow-wrong-oidc-rewritten.tsv"
  mv "$temp_dir/workflow-wrong-oidc-rewritten.tsv" "$temp_dir/workflow-wrong-oidc.tsv"
  expect_rejected 'incorrect Workflow Recipes OIDC sentinel' workflow-recipes \
    "$temp_dir/workflow-wrong-oidc.tsv" none

  seed_expected_oidc_profile control-api "$CONTROL_PROFILE" \
    "$temp_dir/control-wrong-oidc.tsv" legacy_dml
  awk -F '\t' 'BEGIN { OFS = "\t" } $1 == "oidc_protocol_attempts" { $2 = "none" } { print }' \
    "$temp_dir/control-wrong-oidc.tsv" > "$temp_dir/control-wrong-oidc-rewritten.tsv"
  mv "$temp_dir/control-wrong-oidc-rewritten.tsv" "$temp_dir/control-wrong-oidc.tsv"
  expect_rejected 'incorrect Control API OIDC sentinel' control-api \
    "$temp_dir/control-wrong-oidc.tsv" legacy_dml

  rm -rf -- "$temp_dir"
  trap - EXIT
}

self_test_profiles
validate_profile_file control-api "$CONTROL_PROFILE" legacy_dml
validate_profile_file workflow-recipes "$WORKFLOW_PROFILE" none
