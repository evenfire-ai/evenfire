#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_FILE="$ROOT_DIR/deploy/scripts/control-api-runtime-access-profiles.tsv"
MIGRATION_SCRIPT="$ROOT_DIR/deploy/scripts/run-control-api-db-migration.sh"


# Existing Control API sentinels remain local; the shared helper owns profile
# shape, role-specific values, and the two exact OIDC rows.
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

if [[ ${#missing_sentinels[@]} -gt 0 || "$contract_fragments_ok" != "1" ]]; then
  printf 'FAIL: control-api runtime access privileges are incomplete or not exact\n' >&2
  if [[ ${#missing_sentinels[@]} -gt 0 ]]; then
    printf 'missing sentinel rows:\n' >&2
    printf '%s\n' "${missing_sentinels[@]}" >&2
  fi
  exit 1
fi

if ! bash "$SCRIPT_DIR/lib/runtime-access-profile-contract.sh"; then
  printf 'FAIL: shared runtime access-profile contract helper failed\n' >&2
  exit 1
fi

printf 'PASS: control-api runtime access contract is explicit and least privilege\n'
