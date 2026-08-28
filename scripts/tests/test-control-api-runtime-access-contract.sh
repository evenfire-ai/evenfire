#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE_FILE="$ROOT_DIR/deploy/scripts/control-api-runtime-access-profiles.tsv"
MIGRATION_SCRIPT="$ROOT_DIR/deploy/scripts/run-control-api-db-migration.sh"

relation_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$PROFILE_FILE")"
duplicate_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { seen[$1]++ } END { for (name in seen) if (seen[name] > 1) count++ } END { print count + 0 }' "$PROFILE_FILE")"
invalid_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ && (NF != 2 || $1 !~ /^[a-z][a-z0-9_]*$/ || $2 !~ /^(legacy_dml|upsert|append|read|link_lifecycle|none)$/) { count++ } END { print count + 0 }' "$PROFILE_FILE")"

[[ "$relation_count" == "85" ]]
[[ "$duplicate_count" == "0" ]]
[[ "$invalid_count" == "0" ]]
grep -qx $'gfs_desktop_operator_links\tlink_lifecycle' "$PROFILE_FILE"
grep -qx $'desktop_user_retirement_operations\tlink_lifecycle' "$PROFILE_FILE"
grep -qx $'mcp_secret_rollback_permits\tlegacy_dml' "$PROFILE_FILE"

grep -Fq '$2 !~ /^(legacy_dml|upsert|append|read|link_lifecycle|none)$/' "$MIGRATION_SCRIPT"
grep -Fq "('INSERT', expected.access_profile IN ('legacy_dml', 'upsert', 'append', 'link_lifecycle'))" "$MIGRATION_SCRIPT"
grep -Fq "('UPDATE', expected.access_profile IN ('legacy_dml', 'upsert', 'link_lifecycle'))" "$MIGRATION_SCRIPT"
grep -Fq "('DELETE', expected.access_profile IN ('legacy_dml'))" "$MIGRATION_SCRIPT"
grep -Fq "('TRUNCATE', false)" "$MIGRATION_SCRIPT"
grep -Fq "('REFERENCES', false)" "$MIGRATION_SCRIPT"
grep -Fq "('TRIGGER', false)" "$MIGRATION_SCRIPT"

printf 'PASS: control-api runtime link_lifecycle contract is explicit and least privilege\n'
