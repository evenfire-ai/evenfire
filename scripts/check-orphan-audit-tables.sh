#!/usr/bin/env bash
# Check which audit/grant tables actually exist in a target postgres cluster.
# Read-only: only SELECTs against information_schema.
#
# Usage:
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_example-dev \
#     ./scripts/check-orphan-audit-tables.sh

set -euo pipefail
umask 077

: "${CONTEXT:?must set CONTEXT}"
NS="${NS:-control-plane}"
POD_SELECTOR="${POD_SELECTOR:-app=control-postgres}"

POD=$(kubectl --context "${CONTEXT}" -n "${NS}" get pod \
  -l "${POD_SELECTOR}" -o jsonpath='{.items[0].metadata.name}')
echo "[check] pod: ${POD}"

echo "[check] databases:"
kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
  psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate = false;"

echo ""
echo "[check] tables of interest in each non-template DB:"
DBS=$(kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
  psql -U postgres -tAc "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres';")

for DB in ${DBS}; do
  echo "--- DB: ${DB} ---"
  kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
    psql -U postgres -d "${DB}" -tAc "
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'instantiation_audit_log',
           'trigger_grants_audit',
           'user_workflow_triggers',
           'user_agents',
           'user_contexts',
           'role_changes_audit'
         )
       ORDER BY table_name;
    " || echo "  (no access or empty)"

  echo "  row counts:"
  kubectl --context "${CONTEXT}" -n "${NS}" exec "${POD}" -- \
    psql -U postgres -d "${DB}" -tAc "
      SELECT
        'instantiation_audit_log=' || COUNT(*) FROM instantiation_audit_log
      UNION ALL
      SELECT 'trigger_grants_audit=' || COUNT(*) FROM trigger_grants_audit
      UNION ALL
      SELECT 'user_workflow_triggers=' || COUNT(*) FROM user_workflow_triggers;
    " 2>/dev/null || echo "  (counts unavailable)"
done
