#!/usr/bin/env bash
# Exercise the real cleanup: API transport alone models parent recreation and
# deletion failure. A nonzero cleanup status must never hide a foreign delete.
# shellcheck disable=SC2329
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CASE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wrc-fixture-parents.XXXXXX")"
trap 'rm -rf -- "$CASE_ROOT"' EXIT

run_case() (
  local scenario=$1 status=0 expected_status=1 expected_deleted=0 records
  # shellcheck source=../e2e/_lib/wrc-fixtures.sh
  source "$ROOT/scripts/e2e/_lib/wrc-fixtures.sh"
  WRC_FIXTURE_DIR="$CASE_ROOT/$scenario"
  mkdir "$WRC_FIXTURE_DIR"
  WRC_FIXTURE_LEDGER="$WRC_FIXTURE_DIR/owned.jsonl"
  local fixture_parent='{"apiVersion":"clerum.io/v1alpha1","kind":"WorkflowRecipe","metadata":{"name":"fixture","namespace":"sandbox-recipes","uid":"old-parent","labels":{"e2e.clerum.io/run":"oldrun"}}}'
  local fixture_child='{"apiVersion":"v1","kind":"Service","metadata":{"name":"child","namespace":"sandbox-ui","uid":"child-uid","labels":{"clerum.io/recipe-namespace":"sandbox-recipes","clerum.io/recipe-name":"fixture"}}}'
  printf '%s\n' "$fixture_parent" > "$WRC_FIXTURE_LEDGER"
  if [ "$scenario" = corrupt-ledger ]; then printf '{' > "$WRC_FIXTURE_LEDGER"; fi
  if [ "$scenario" = absent-recorded ]; then printf '%s\n' "$fixture_child" | wrc_record_owned; fi
  kctl() {
    case "$1:$2" in
      get:workflowrecipe|get:WorkflowRecipe)
        [ "$scenario" != read-error ] || return 1
        if [[ "$scenario" == absent* ]] || [ -f "$WRC_FIXTURE_DIR/parent-gone" ]; then return 0; fi
        if [ "$scenario" = replaced ] || [ -f "$WRC_FIXTURE_DIR/swapped" ]; then
          printf '%s' "$fixture_parent" | jq '.metadata.uid="new-parent" | .metadata.labels["e2e.clerum.io/run"]="newrun"'
        else
          printf '%s\n' "$fixture_parent"
        fi ;;
      get:deployment,service,configmap,networkpolicy)
        if [ "$scenario" = swap-during-list ]; then : > "$WRC_FIXTURE_DIR/swapped"; fi
        if [ "$4" = sandbox-ui ]; then jq -cn --argjson child "$fixture_child" '{items:[$child]}'
        else printf '{"items":[]}\n'; fi ;;
      get:Service)
        [ ! -f "$WRC_FIXTURE_DIR/child-deleted" ] || return 0
        printf '%s\n' "$fixture_child" ;;
      delete:--raw)
        case "$3" in
          /apis/clerum.io/v1alpha1/namespaces/sandbox-recipes/workflowrecipes/fixture)
            [ "$scenario" != parent-delete-fails ] || return 1
            jq -e '.preconditions.uid=="old-parent"' "$6" >/dev/null || return 1
            : > "$WRC_FIXTURE_DIR/parent-gone" ;;
          /api/v1/namespaces/sandbox-ui/services/child)
            jq -e '.preconditions.uid=="child-uid"' "$6" >/dev/null || return 1
            : > "$WRC_FIXTURE_DIR/child-deleted" ;;
          *) return 1 ;;
        esac ;;
      wait:*) return 0 ;;
      *) return 1 ;;
    esac
  }
  wrc_cleanup_owned || status=$?
  case "$scenario" in
    healthy|absent-recorded) expected_status=0; expected_deleted=1 ;;
    absent) expected_status=0 ;;
  esac
  local deleted=0
  [ ! -f "$WRC_FIXTURE_DIR/child-deleted" ] || deleted=1
  [ "$status" -eq "$expected_status" ] && [ "$deleted" -eq "$expected_deleted" ] || {
    printf 'FAIL: %s cleanup=%s child_deleted=%s\n' "$scenario" "$status" "$deleted" >&2
    return 1
  }
  case "$scenario" in
    replaced|swap-during-list|read-error|absent)
      records="$(jq -s 'length' "$WRC_FIXTURE_LEDGER")"
      [ "$records" -eq 1 ] || { printf 'FAIL: %s polluted the ownership ledger\n' "$scenario" >&2; return 1; }
      ;;
    absent-recorded)
      [ "$(jq -s 'length' "$WRC_FIXTURE_LEDGER")" -eq 2 ] || return 1
      ;;
    corrupt-ledger)
      [ "$(cat "$WRC_FIXTURE_LEDGER")" = '{' ] || return 1
      ;;
  esac
)

failed=0
for scenario in healthy replaced swap-during-list read-error absent absent-recorded parent-delete-fails corrupt-ledger; do
  if run_case "$scenario"; then
    printf 'PASS: cleanup parent boundary %s\n' "$scenario"
  else
    failed=1
  fi
done
exit "$failed"
