#!/usr/bin/env bash
# Whether control-api's LLM catalog sync has used the live models.dev catalog.
#
# Sourced library, shared by setup's catalog wait (scripts/minikube/host-model.sh)
# and the seed's model provisioning (scripts/e2e/llm-model-ensure.sh), so both
# apply one rule: the catalog has decided once ANY run was live. The latest run
# alone is not enough: a reused DB can hold an old live run followed by a
# vendored one (a later sync without egress), and its models were still decided.
#
# llm_catalog_sync_source
#   Prints `live` when a live run exists, else `vendored` when only vendored runs
#   exist, else nothing. Read-only. Needs KC (kubectl plus its --context).
#   Returns non-zero, printing nothing of its own, when the query cannot run.
llm_catalog_sync_source() {
  # $KC is a command plus its --context flag and must split into words.
  # shellcheck disable=SC2086
  $KC exec -i -n "${CONTROL_API_NS:-control-plane}" deployment/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 -Atq -f - <<'SQL'
SELECT source FROM llm_catalog_sync_runs
 ORDER BY (source = 'live') DESC, ran_at DESC
 LIMIT 1;
SQL
}
