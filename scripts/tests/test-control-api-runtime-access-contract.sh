#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE_FILE="$ROOT_DIR/deploy/scripts/control-api-runtime-access-profiles.tsv"
PEER_FILE="$ROOT_DIR/deploy/scripts/workflow-recipes-runtime-access-profiles.tsv"
MIGRATION_SCRIPT="$ROOT_DIR/deploy/scripts/run-control-api-db-migration.sh"

relation_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$PROFILE_FILE")"
peer_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { count++ } END { print count + 0 }' "$PEER_FILE")"
duplicate_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ { seen[$1]++ } END { for (name in seen) if (seen[name] > 1) count++ } END { print count + 0 }' "$PROFILE_FILE")"
invalid_count="$(awk -F '\t' '!/^[[:space:]]*(#|$)/ && (NF != 2 || $1 !~ /^[a-z][a-z0-9_]*$/ || $2 !~ /^(legacy_dml|upsert|append|read|link_lifecycle|insert_delete|none)$/) { count++ } END { print count + 0 }' "$PROFILE_FILE")"
name_diff="$(comm -3 \
  <(awk -F '\t' '!/^[[:space:]]*(#|$)/ { print $1 }' "$PROFILE_FILE" | sort) \
  <(awk -F '\t' '!/^[[:space:]]*(#|$)/ { print $1 }' "$PEER_FILE" | sort))"

# Existing sentinel rows, plus the three session rows. The expected relation
# count is the peer workflow-recipes profile, not a handwritten literal.
sentinels=(
  $'dynamic_clients\tlegacy_dml'
  $'entity_change_feed\tnone'
  $'entity_change_outbox\tnone'
  $'entity_change_watermark\tnone'
  $'mcp_secret_rollback_permits\tlegacy_dml'
  $'gfs_desktop_operator_links\tlink_lifecycle'
  $'desktop_user_retirement_operations\tlink_lifecycle'
  $'llm_provider_catalog_settings\tupsert'
  $'llm_catalog_dismissed\tappend'
  $'password_identifier_state\tlegacy_dml'
  $'password_verification_pace\tlegacy_dml'
  $'password_verification_work\tinsert_delete'
  $'oidc_protocol_attempts\tlegacy_dml'
  $'external_user_sessions\tlegacy_dml'
  $'external_user_session_security_epochs\tupsert'
  $'external_v1_session_revocations\tappend'
)
missing_sentinels=()
for sentinel in "${sentinels[@]}"; do
  if ! grep -qx "$sentinel" "$PROFILE_FILE"; then
    missing_sentinels+=("$sentinel")
  fi
done

contract_fragments_ok=1
if ! grep -Fq '$2 !~ /^(legacy_dml|upsert|append|read|link_lifecycle|insert_delete|none)$/' "$MIGRATION_SCRIPT" || \
  ! grep -Fq 'has_any_column_privilege(' "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('INSERT', expected.access_profile IN ('legacy_dml', 'upsert', 'append', 'link_lifecycle', 'insert_delete'))" "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('UPDATE', expected.access_profile IN ('legacy_dml', 'upsert', 'link_lifecycle'))" "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('DELETE', expected.access_profile IN ('legacy_dml', 'insert_delete'))" "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('TRUNCATE', false)" "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('REFERENCES', false)" "$MIGRATION_SCRIPT" || \
  ! grep -Fq "('TRIGGER', false)" "$MIGRATION_SCRIPT"; then
  contract_fragments_ok=0
fi

if [[ "$relation_count" -le 0 || "$relation_count" != "$peer_count" || -n "$name_diff" || "$duplicate_count" != "0" || "$invalid_count" != "0" || ${#missing_sentinels[@]} -gt 0 || "$contract_fragments_ok" != "1" ]]; then
  printf 'FAIL: control-api runtime access contract is incomplete or not exact (%s has %s relations, %s has %s relations; duplicates=%s invalid=%s)\n' \
    "$PROFILE_FILE" "$relation_count" "$PEER_FILE" "$peer_count" "$duplicate_count" "$invalid_count" >&2
  if [[ -n "$name_diff" ]]; then
    printf 'relation name sets differ:\n%s\n' "$name_diff" >&2
  fi
  if [[ ${#missing_sentinels[@]} -gt 0 ]]; then
    printf 'missing sentinel rows:\n' >&2
    printf '%s\n' "${missing_sentinels[@]}" >&2
  fi
  exit 1
fi

printf 'PASS: control-api runtime access contract is explicit and least privilege (%s relations, peer %s relations)\n' \
  "$relation_count" "$peer_count"
