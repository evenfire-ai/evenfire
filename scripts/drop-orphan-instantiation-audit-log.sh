#!/usr/bin/env bash
# One-shot DROP of the orphan `instantiation_audit_log` table.
#
# Why this exists: the baseline schema in control-api/src/db.ts originally
# created `instantiation_audit_log` at STEP 4, but no production code path
# ever wrote to or read from it. As of 2026-04-23 the CREATE was removed
# from the baseline so fresh clusters never see the table. Clusters that
# had already bootstrapped prior to that edit retain the orphan — run this
# script once per such cluster to clean it up.
#
# Safety guarantees:
#   * Refuses to drop if the table contains ANY rows (defense against a future
#     code path that silently started writing to it).
#   * Idempotent: DROP TABLE IF EXISTS; re-running is a no-op.
#   * Prod gate: any context not ending in `-dev` requires CONFIRM=yes.
#   * Dry-run default path is supported via DRY_RUN=true.
#
# Usage:
#   # dev cluster
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_example-dev \
#     ./scripts/drop-orphan-instantiation-audit-log.sh
#
#   # prod cluster (requires CONFIRM=yes)
#   CONFIRM=yes CONTEXT=gke_${GCP_PROJECT}_us-central1-a_clerum \
#     ./scripts/drop-orphan-instantiation-audit-log.sh
#
#   # dry-run
#   DRY_RUN=true CONTEXT=... ./scripts/drop-orphan-instantiation-audit-log.sh

set -euo pipefail
umask 077

: "${CONTEXT:?must set CONTEXT to target kubectl context}"
NS="${NS:-control-plane}"
POD_SELECTOR="${POD_SELECTOR:-app=control-postgres}"
DB="${DB:-profiles}"
DRY_RUN="${DRY_RUN:-false}"

# Prod gate
if [[ "${CONTEXT}" != *-dev ]] && [[ "${DRY_RUN}" != "true" ]]; then
  if [[ "${CONFIRM:-}" != "yes" ]]; then
    echo "[drop-audit] ERROR: non-dev context '${CONTEXT}' requires CONFIRM=yes" >&2
    echo "[drop-audit] re-run with: CONFIRM=yes CONTEXT='${CONTEXT}' $0" >&2
    exit 1
  fi
fi

POD=$(kubectl --context "${CONTEXT}" -n "${NS}" get pod \
  -l "${POD_SELECTOR}" -o jsonpath='{.items[0].metadata.name}')
echo "[drop-audit] context: ${CONTEXT}  pod: ${POD}  db: ${DB}"

# Guard: skip cleanly if the table no longer exists (idempotent).
EXISTS=$(kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
  psql -U postgres -d "${DB}" -tAc \
  "SELECT to_regclass('public.instantiation_audit_log')::text;")
if [[ -z "${EXISTS}" || "${EXISTS}" == "NULL" ]]; then
  echo "[drop-audit] table does not exist on ${CONTEXT}; nothing to do"
  exit 0
fi

# Safety: refuse to drop if the table has rows. A reviewer-friendly failure
# beats silently losing data to a newly-added writer nobody flagged.
ROW_COUNT=$(kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
  psql -U postgres -d "${DB}" -tAc \
  "SELECT COUNT(*) FROM instantiation_audit_log;")
ROW_COUNT=$(echo "${ROW_COUNT}" | tr -d '[:space:]')
if [[ "${ROW_COUNT}" != "0" ]]; then
  echo "[drop-audit] ABORT: instantiation_audit_log has ${ROW_COUNT} rows on ${CONTEXT}." >&2
  echo "[drop-audit] Investigate the writer before dropping — grep for 'instantiation_audit_log'" >&2
  echo "[drop-audit] across all sibling repos. If the rows are known-safe to lose, truncate manually" >&2
  echo "[drop-audit] and re-run this script." >&2
  exit 1
fi

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[drop-audit] DRY_RUN=true → would execute: DROP TABLE IF EXISTS instantiation_audit_log;"
  exit 0
fi

kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
  psql -U postgres -d "${DB}" -c "DROP TABLE IF EXISTS instantiation_audit_log;"

echo "[drop-audit] instantiation_audit_log dropped from ${CONTEXT}"
