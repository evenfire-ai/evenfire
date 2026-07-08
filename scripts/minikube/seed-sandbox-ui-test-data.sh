#!/usr/bin/env bash
# ======================================================================
# Seed Sandbox UI Test Data for Minikube
# ======================================================================
#
# Installs the smallest UI-bearing WorkflowRecipe and grants the local
# desktop test user direct trigger access. The direct trigger grant is what
# control-api uses to issue the sandbox:ui:view RPC scope and what the
# sandbox-ui app picker uses to list visible apps.
#
# Usage:
#   scripts/minikube/seed-sandbox-ui-test-data.sh
#   CONTEXT=clerum-test scripts/minikube/seed-sandbox-ui-test-data.sh
#
# ======================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONTEXT="${CONTEXT:-${MINIKUBE_PROFILE:-clerum-test}}"
KC=(kubectl --context="$CONTEXT")
RECIPE_NS="${RECIPE_NS:-sandbox-recipes}"
SANDBOX_UI_NS="${SANDBOX_UI_NS:-sandbox-ui}"
RECIPE_NAME="${SANDBOX_UI_TEST_RECIPE_NAME:-sandbox-ui-hello}"
WORKLOAD_ID="${SANDBOX_UI_TEST_WORKLOAD_ID:-hello}"
RECIPE_FILE="${SANDBOX_UI_TEST_RECIPE_FILE:-${PROJECT_DIR}/workflow-recipes/samples/sandbox-ui-hello.yaml}"
TEST_USER_EMAIL="${CLERUM_TEST_USER_EMAIL:-${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}}"
TEST_USER_NAME="${E2E_DEV_LOGIN_NAME:-Test User}"
TEST_TEAM_NAME="${E2E_DEV_TEAM_NAME:-Test User team}"
TIMEOUT_SECONDS="${SANDBOX_UI_TEST_TIMEOUT_SECONDS:-180}"
POLL_INTERVAL="${SANDBOX_UI_TEST_POLL_INTERVAL:-3}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${CYAN}[SEED-SANDBOX-UI]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

sql_literal() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "$value"
}

psql_scalar() {
  local output first
  output="$("${KC[@]}" exec -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -t -A -c "$1" 2>&1)" || {
    printf '%s\n' "$output" >&2
    return 1
  }
  first="${output%%$'\n'*}"
  first="${first//$'\t'/}"
  first="${first// /}"
  printf '%s\n' "$first"
}

psql_exec() {
  "${KC[@]}" exec -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1
}

wait_for_jsonpath_value() {
  local resource="$1" namespace="$2" jsonpath="$3" expected="$4" timeout="$5" elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local value
    value="$("${KC[@]}" get "$resource" -n "$namespace" -o "jsonpath=${jsonpath}" 2>/dev/null || true)"
    if [ "$value" = "$expected" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Seed Sandbox UI Test Data${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""

log "Checking prerequisites..."
if ! "${KC[@]}" get pods -n control-plane -l app=control-postgres --no-headers 2>/dev/null | grep -q "Running"; then
  err "control-postgres is not running. Run minikube setup first."
  exit 1
fi
ok "control-postgres is running"

if ! "${KC[@]}" get crd workflowrecipes.clerum.io >/dev/null 2>&1; then
  err "WorkflowRecipe CRD not installed."
  exit 1
fi
ok "WorkflowRecipe CRD installed"

if [ ! -f "$RECIPE_FILE" ]; then
  err "Recipe file not found: $RECIPE_FILE"
  exit 1
fi
ok "Recipe file found: ${RECIPE_FILE#$PROJECT_DIR/}"

for ns in "$RECIPE_NS" "$SANDBOX_UI_NS"; do
  if ! "${KC[@]}" get namespace "$ns" >/dev/null 2>&1; then
    warn "Namespace $ns does not exist -- creating"
    "${KC[@]}" create namespace "$ns" >/dev/null
  fi
done
ok "Namespaces verified ($RECIPE_NS, $SANDBOX_UI_NS)"

log "Applying sandbox-ui test recipe ${RECIPE_NS}/${RECIPE_NAME}..."
"${KC[@]}" apply -f "$RECIPE_FILE" >/dev/null
ok "WorkflowRecipe applied"

log "Resolving local desktop test user..."
user_email_sql=$(sql_literal "$TEST_USER_EMAIL")
user_name_sql=$(sql_literal "$TEST_USER_NAME")
team_name_sql=$(sql_literal "$TEST_TEAM_NAME")
recipe_ns_sql=$(sql_literal "$RECIPE_NS")
recipe_name_sql=$(sql_literal "$RECIPE_NAME")

TEST_USER_ID=$(psql_scalar "INSERT INTO users (email, name)
  VALUES (${user_email_sql}, ${user_name_sql})
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  RETURNING id;")
if [[ -z "$TEST_USER_ID" || "$TEST_USER_ID" == *ERROR* ]]; then
  err "Failed to resolve test user ${TEST_USER_EMAIL}: $TEST_USER_ID"
  exit 1
fi
ok "${TEST_USER_EMAIL} (id=${TEST_USER_ID:0:8}...)"
test_user_id_sql=$(sql_literal "$TEST_USER_ID")

TEST_TEAM_ID=$(psql_scalar "SELECT tm.team_id::text
  FROM team_members tm
  WHERE tm.user_id=${test_user_id_sql} AND tm.status='active'
  ORDER BY tm.created_at ASC, tm.team_id ASC
  LIMIT 1;")
if [[ -z "$TEST_TEAM_ID" || "$TEST_TEAM_ID" == *ERROR* ]]; then
  TEST_TEAM_ID=$(psql_scalar "WITH team AS (
    INSERT INTO teams(name) VALUES (${team_name_sql}) RETURNING id
  ), membership AS (
    INSERT INTO team_members(team_id, user_id, role, status)
    SELECT id, ${test_user_id_sql}, 'admin', 'active' FROM team
    ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'
    RETURNING team_id
  )
  SELECT team_id::text FROM membership;")
fi
if [[ -z "$TEST_TEAM_ID" || "$TEST_TEAM_ID" == *ERROR* ]]; then
  err "Failed to resolve active team for ${TEST_USER_EMAIL}: $TEST_TEAM_ID"
  exit 1
fi
ok "${TEST_TEAM_NAME} membership available (team=${TEST_TEAM_ID:0:8}...)"

log "Granting direct workflow trigger access for sandbox-ui listing..."
psql_exec "INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
  VALUES (${test_user_id_sql}, ${recipe_ns_sql}, ${recipe_name_sql})
  ON CONFLICT DO NOTHING;"
ok "Direct trigger grant present for ${RECIPE_NS}/${RECIPE_NAME}"

log "Waiting for WorkflowRecipe phase=active..."
if wait_for_jsonpath_value "workflowrecipe/${RECIPE_NAME}" "$RECIPE_NS" "{.status.phase}" "active" "$TIMEOUT_SECONDS"; then
  ok "WorkflowRecipe ${RECIPE_NS}/${RECIPE_NAME} is active"
else
  phase="$("${KC[@]}" get "workflowrecipe/${RECIPE_NAME}" -n "$RECIPE_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  err "WorkflowRecipe ${RECIPE_NS}/${RECIPE_NAME} did not become active (phase=${phase:-unknown})"
  exit 1
fi

DEPLOYMENT_NAME="$("${KC[@]}" get "workflowrecipe/${RECIPE_NAME}" -n "$RECIPE_NS" \
  -o "jsonpath={.status.workloadInstances.${WORKLOAD_ID}}" 2>/dev/null || true)"
DEPLOYMENT_NAME="${DEPLOYMENT_NAME:-$WORKLOAD_ID}"

log "Waiting for sandbox-ui workload deployment/${DEPLOYMENT_NAME}..."
if "${KC[@]}" -n "$SANDBOX_UI_NS" rollout status "deployment/${DEPLOYMENT_NAME}" --timeout="${TIMEOUT_SECONDS}s"; then
  ok "sandbox-ui deployment/${DEPLOYMENT_NAME} is ready"
else
  err "sandbox-ui deployment/${DEPLOYMENT_NAME} did not become ready"
  exit 1
fi

APP_GRANT_COUNT=$(psql_scalar "SELECT COUNT(*)
  FROM user_workflow_triggers
  WHERE user_id=${test_user_id_sql}
    AND recipe_namespace=${recipe_ns_sql}
    AND recipe_name=${recipe_name_sql};")
ok "Sandbox UI trigger grants for ${TEST_USER_EMAIL}: ${APP_GRANT_COUNT}"

echo ""
echo -e "${GREEN}${BOLD}Sandbox UI seed complete.${NC} ${TEST_USER_EMAIL} can list ${RECIPE_NS}/${RECIPE_NAME}."
