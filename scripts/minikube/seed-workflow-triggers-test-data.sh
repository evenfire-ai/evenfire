#!/usr/bin/env bash
# ======================================================================
# Seed Workflow Triggers Test Data for Minikube
# ======================================================================
#
# Creates WorkflowRecipe CRDs with various trigger configurations and
# seeds users in the DB for the E2E trigger test suite.
#
# Recipes created:
#   1. e2e-ondemand-simple     -- basic onDemand trigger, no approval
#   2. e2e-ondemand-approval   -- onDemand with approval (policy: triggerer)
#   3. e2e-scheduled-recipe    -- onDemand fixture; schedule flows live in dedicated E2E
#   4. e2e-retention-recipe    -- onDemand with runRetention limits
#
# Users seeded (ON CONFLICT DO NOTHING):
#   - test@clerum.io              (trigger owner / default approver)
#   - trigger-outsider-e2e@clerum.io (outsider, no access)
#   - placeholder-cfo@clerum.io   (approval user for workflow-snippet-runtime-happy-path.test.ts)
#
# Prerequisites:
#   - Minikube cluster running with all services deployed
#   - CRDs installed (workflowrecipes.clerum.io)
#   - control-postgres running and healthy
#
# Usage:
#   scripts/minikube/seed-workflow-triggers-test-data.sh
#   CONTEXT=clerum-test scripts/minikube/seed-workflow-triggers-test-data.sh
#
# ======================================================================

set -euo pipefail

CONTEXT="${CONTEXT:-clerum-test}"
KC="kubectl --context=${CONTEXT}"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}"
E2E_WORKFLOW_SIMPLE_MODEL_NAME="${E2E_WORKFLOW_SIMPLE_MODEL_NAME:-glm-5}"
E2E_WORKFLOW_RETENTION_MODEL_NAME="${E2E_WORKFLOW_RETENTION_MODEL_NAME:-glm-5.1}"
E2E_WORKFLOW_SCHEDULED_MODEL_NAME="${E2E_WORKFLOW_SCHEDULED_MODEL_NAME:-glm-5-turbo}"

# Canonical WorkflowRecipe CRD storage per Phase-8 §4.8 namespace split
# (docs/architecture/diagrams/mcp-delegation-phase8.html). WorkflowRecipes +
# coordinator + mcp-host + non-MCP workloads all live in sandbox-recipes (the
# orchestration plane). mcp-server is reserved for McpServer CRDs + transport
# Services (the MCP data plane). Matches control-api admin/recipes.ts:56
# (RECIPE_CRD_NAMESPACE = config.sandboxNamespace) and control-ui
# DEFAULT_WORKFLOW_RECIPE_NAMESPACE. Legacy stragglers in mcp-server are
# covered by findRecipeNamespace's dual-probe, regression-tested in
# scripts/e2e/e2e-workflow-triggers.sh Case 10.
RECIPE_NS="sandbox-recipes"
SANDBOX_NS="sandbox-recipes"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log()  { echo -e "${CYAN}[SEED-TRIGGERS]${NC} $*"; }
ok()   { echo -e "${GREEN}  OK${NC} -- $*"; }
warn() { echo -e "${YELLOW}  WARN${NC} -- $*"; }
err()  { echo -e "${RED}  ERROR${NC} -- $*"; }

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Seed Workflow Triggers Test Data${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""

# ── Step 1: Verify prerequisites ──────────────────────────────────────
log "Checking prerequisites..."

if ! $KC get pods -n control-plane -l app=control-postgres --no-headers 2>/dev/null | grep -q "Running"; then
  err "control-postgres is not running. Run 'make minikube-setup' first."
  exit 1
fi
ok "control-postgres is running"

if ! $KC get crd workflowrecipes.clerum.io >/dev/null 2>&1; then
  err "WorkflowRecipe CRD not installed. Run 'make minikube-deploy-crds' first."
  exit 1
fi
ok "WorkflowRecipe CRD installed"

verify_model_secret_mapping() {
  local provider="$1"
  local model="$2"
  local mapping_key="${provider}__${model}"
  local mapping secret_name secret_key
  mapping="$($KC -n mcp-host get configmap clerum-model-secret-mapping -o "go-template={{ index .data \"${mapping_key}\" }}" 2>/dev/null || true)"
  if [ -z "$mapping" ] || [[ "$mapping" != */* ]]; then
    err "Model secret mapping missing or invalid for ${mapping_key}"
    exit 1
  fi
  secret_name="${mapping%%/*}"
  secret_key="${mapping#*/}"
  if ! $KC -n mcp-host get secret "$secret_name" -o "go-template={{ index .data \"${secret_key}\" }}" 2>/dev/null | grep -q .; then
    err "Mapped LLM Secret key not found: ${secret_name}/${secret_key}"
    exit 1
  fi
  ok "Workflow E2E model ${provider}/${model} uses ${secret_name}/${secret_key}"
}

verify_model_secret_mapping "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_WORKFLOW_MODEL_NAME"
verify_model_secret_mapping "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_WORKFLOW_SIMPLE_MODEL_NAME"
verify_model_secret_mapping "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_WORKFLOW_RETENTION_MODEL_NAME"
verify_model_secret_mapping "$E2E_WORKFLOW_MODEL_PROVIDER" "$E2E_WORKFLOW_SCHEDULED_MODEL_NAME"

# Ensure target namespaces exist
for ns in "$RECIPE_NS" "$SANDBOX_NS"; do
  if ! $KC get namespace "$ns" >/dev/null 2>&1; then
    warn "Namespace $ns does not exist -- creating"
    $KC create namespace "$ns" 2>/dev/null || true
  fi
done
ok "Namespaces verified ($RECIPE_NS, $SANDBOX_NS)"
echo ""

# ── Step 2: Seed users ────────────────────────────────────────────────
log "Seeding users..."

psql_scalar() {
  local output first
  output="$($KC exec -n control-plane deployment/control-postgres -- \
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
  $KC exec -n control-plane deployment/control-postgres -- \
    psql -U postgres -d profiles -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1
}

sql_literal() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "$value"
}

# Seed users (ON CONFLICT DO NOTHING)
TRIGGER_USER_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
TRIGGER_USER_NAME="${E2E_DEV_LOGIN_NAME:-Test User}"
TRIGGER_USER_EMAIL_SQL=$(sql_literal "$TRIGGER_USER_EMAIL")
TRIGGER_USER_NAME_SQL=$(sql_literal "$TRIGGER_USER_NAME")
TRIGGER_USER_ID=$(psql_scalar "INSERT INTO users (email, name) VALUES (${TRIGGER_USER_EMAIL_SQL}, ${TRIGGER_USER_NAME_SQL}) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id;")
if [[ -z "$TRIGGER_USER_ID" || "$TRIGGER_USER_ID" == *ERROR* ]]; then
  err "Failed to seed trigger user ${TRIGGER_USER_EMAIL}: $TRIGGER_USER_ID"
  exit 1
fi
ok "${TRIGGER_USER_EMAIL} (id=${TRIGGER_USER_ID:0:8}...)"

TRIGGER_TEAM_NAME="${E2E_DEV_TEAM_NAME:-Test User team}"
TRIGGER_TEAM_NAME_SQL=$(sql_literal "$TRIGGER_TEAM_NAME")
TRIGGER_TEAM_ID=$(psql_scalar "SELECT tm.team_id::text FROM team_members tm WHERE tm.user_id='${TRIGGER_USER_ID}' AND tm.status='active' ORDER BY tm.created_at ASC, tm.team_id ASC LIMIT 1;")
if [[ -z "$TRIGGER_TEAM_ID" || "$TRIGGER_TEAM_ID" == *ERROR* ]]; then
  TRIGGER_TEAM_ID=$(psql_scalar "WITH team AS (
    INSERT INTO teams(name) VALUES (${TRIGGER_TEAM_NAME_SQL}) RETURNING id
  ), membership AS (
    INSERT INTO team_members(team_id, user_id, role, status)
    SELECT id, '${TRIGGER_USER_ID}', 'admin', 'active' FROM team
    ON CONFLICT (team_id, user_id) DO UPDATE SET status='active'
    RETURNING team_id
  )
  SELECT team_id::text FROM membership;")
fi
if [[ -z "$TRIGGER_TEAM_ID" || "$TRIGGER_TEAM_ID" == *ERROR* ]]; then
  err "Failed to resolve trigger team for ${TRIGGER_USER_EMAIL}: $TRIGGER_TEAM_ID"
  exit 1
fi
ok "${TRIGGER_TEAM_NAME} (id=${TRIGGER_TEAM_ID:0:8}...)"

OUTSIDER_USER_ID=$(psql_scalar "INSERT INTO users (email, name) VALUES ('trigger-outsider-e2e@clerum.io', 'E2E Trigger Outsider') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id;")
if [[ -z "$OUTSIDER_USER_ID" || "$OUTSIDER_USER_ID" == *ERROR* ]]; then
  err "Failed to seed outsider user: $OUTSIDER_USER_ID"
  exit 1
fi
ok "trigger-outsider-e2e@clerum.io (id=${OUTSIDER_USER_ID:0:8}...)"

CFO_USER_ID=$(psql_scalar "INSERT INTO users (email, name) VALUES ('placeholder-cfo@clerum.io', 'E2E CFO') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id;")
if [[ -z "$CFO_USER_ID" || "$CFO_USER_ID" == *ERROR* ]]; then
  err "Failed to seed CFO user: $CFO_USER_ID"
  exit 1
fi
ok "placeholder-cfo@clerum.io (id=${CFO_USER_ID:0:8}...)"
echo ""

# ── Step 3: Seed workflow trigger grants + approval team allowlists ──
log "Granting workflow trigger access..."

RECIPES_FOR_USER_A=(
  "e2e-ondemand-simple"
  "e2e-ondemand-approval"
  "e2e-scheduled-recipe"
  "e2e-retention-recipe"
)

for recipe in "${RECIPES_FOR_USER_A[@]}"; do
  psql_exec "INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name) \
             VALUES ('${TRIGGER_USER_ID}', '${RECIPE_NS}', '${recipe}') \
             ON CONFLICT DO NOTHING;" || true
  psql_exec "INSERT INTO workflow_recipe_allowed_teams (recipe_namespace, recipe_name, team_id) \
             VALUES ('${RECIPE_NS}', '${recipe}', '${TRIGGER_TEAM_ID}') \
             ON CONFLICT DO NOTHING;" || true
done
ok "Trigger owner granted + team approval allowlisted on ${#RECIPES_FOR_USER_A[@]} recipes"
echo ""

# ── Step 4: Apply WorkflowRecipe CRDs ────────────────────────────────
log "Applying WorkflowRecipe CRDs..."

TMPDIR="$(mktemp -d -t clerum-seed-triggers-XXXX)"

# 1. e2e-ondemand-simple: basic onDemand, no approval
cat > "$TMPDIR/e2e-ondemand-simple.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-ondemand-simple
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/trigger-suite: "true"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_SIMPLE_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
  steps:
    - id: greet
      instruction: "Say hello. This is a simple on-demand E2E test."
      timeoutSeconds: 60
YAML

# 2. e2e-ondemand-approval: onDemand with approval (policy: triggerer)
cat > "$TMPDIR/e2e-ondemand-approval.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-ondemand-approval
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/trigger-suite: "true"
    clerum.io/e2e-negative-fixture: "true"
  annotations:
    clerum.io/e2e-expected-phase: "failed"
    clerum.io/e2e-expected-failure-reason: "approval-timeout-no-decision"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: true
      allowedActors:
        - user
  steps:
    - id: gated-step
      instruction: "Execute after approval. E2E test."
      timeoutSeconds: 120
      requiresApproval:
        target:
          userId: "${TRIGGER_USER_ID}"
        message: "E2E ondemand-approval: approve to proceed"
        timeoutSeconds: 300
YAML

# 3. e2e-scheduled-recipe: manual fixture for usage/UI checks.
# Dedicated schedule coverage lives in scripts/e2e/e2e-workflow-triggers.sh and
# scripts/e2e/e2e-workflow-schedules.sh so the base seed does not create
# background schedule state during unrelated tests.
cat > "$TMPDIR/e2e-scheduled-recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-scheduled-recipe
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/trigger-suite: "true"
    clerum.io/workflow-team-id: "${TRIGGER_TEAM_ID}"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_SCHEDULED_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
  steps:
    - id: weekly-report
      instruction: |
        You MUST call clerum__generate_pdf exactly once with this payload:
        filename: "weekly-summary-report.pdf"
        title: "Weekly Summary Report"
        body: |
          # Weekly Summary Report

          This PDF was generated by the e2e-scheduled-recipe agentic workflow.
          It validates that a Desktop-triggered WorkflowRecipe run produces a
          run-scoped downloadable artifact from /output.
      allowedTools:
        include:
          - clerum__generate_pdf
      timeoutSeconds: 120
  output:
    destination: pvc
    name: weekly-summary-report
    format: pdf
    storageSize: 64Mi
YAML

# 4. e2e-retention-recipe: onDemand with runRetention limits
cat > "$TMPDIR/e2e-retention-recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: e2e-retention-recipe
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/trigger-suite: "true"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_RETENTION_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors:
        - user
  runRetention:
    successfulHistoryLimit: 2
    failedHistoryLimit: 1
    maxRunDurationSeconds: 86400
    ttlSecondsAfterFinished: 60
  steps:
    - id: ephemeral
      instruction: "Say hello. This is a retention E2E test."
      timeoutSeconds: 60
YAML

# Apply all recipes
APPLIED=0
FAILED=0
for manifest in "$TMPDIR"/e2e-*.yaml; do
  recipe_name=$(basename "$manifest" .yaml)
  if $KC apply -f "$manifest" 2>/dev/null; then
    ok "$recipe_name applied"
    APPLIED=$((APPLIED + 1))
  else
    err "$recipe_name failed to apply"
    FAILED=$((FAILED + 1))
  fi
done

rm -rf "$TMPDIR"
echo ""

# The base seed must not leave DB-backed schedule rows behind. Dedicated
# schedule suites install their own scheduled fixtures and force next_fire_at.
SCHEDULE_TEAM_ROWS=1
for attempt in {1..12}; do
  SCHEDULE_TEAM_ROWS=$(psql_scalar "SELECT COUNT(*)
   FROM workflow_schedules
   WHERE recipe_namespace='${RECIPE_NS}'
     AND recipe_name='e2e-scheduled-recipe';")
  if [[ "$SCHEDULE_TEAM_ROWS" =~ ^[0-9]+$ && "$SCHEDULE_TEAM_ROWS" -eq 0 ]]; then
    break
  fi
  sleep 5
done
if [[ ! "$SCHEDULE_TEAM_ROWS" =~ ^[0-9]+$ || "$SCHEDULE_TEAM_ROWS" -ne 0 ]]; then
  err "Base E2E seed left a workflow_schedules row for e2e-scheduled-recipe"
  exit 1
fi
ok "Base seed has no DB-backed schedule row for e2e-scheduled-recipe"

# ── Step 5: Clean non-canonical workflow usage from replaced E2E runs ────────
log "Cleaning non-canonical/stale E2E workflow usage rows..."

ORPHAN_USAGE_COUNT=$(psql_scalar "WITH orphan AS (
  SELECT e.request_id
  FROM usage_events e
  WHERE e.source_kind = 'workflow'
    AND e.recipe_name LIKE 'e2e-%'
    AND NOT EXISTS (
      SELECT 1 FROM workflow_runs wr
      WHERE wr.run_id::text = split_part(e.task_id, ':', 1)
    )
    AND NOT EXISTS (
      SELECT 1 FROM workflow_runs_audit wra
      WHERE wra.run_id::text = split_part(e.task_id, ':', 1)
    )
), deleted AS (
  DELETE FROM usage_events e
  USING orphan o
  WHERE e.request_id = o.request_id
  RETURNING 1
)
SELECT COUNT(*) FROM deleted;")

NULL_ROLLUP_COUNT=$(psql_scalar "WITH d5 AS (
  DELETE FROM usage_5min
  WHERE source_kind = 'workflow'
    AND recipe_name LIKE 'e2e-%'
    AND (team_id IS NULL OR llm_secret_name IS NULL)
  RETURNING 1
), dh AS (
  DELETE FROM usage_hourly
  WHERE source_kind = 'workflow'
    AND recipe_name LIKE 'e2e-%'
    AND (team_id IS NULL OR llm_secret_name IS NULL)
  RETURNING 1
), dd AS (
  DELETE FROM usage_daily
  WHERE source_kind = 'workflow'
    AND recipe_name LIKE 'e2e-%'
    AND (team_id IS NULL OR llm_secret_name IS NULL)
  RETURNING 1
)
SELECT (SELECT COUNT(*) FROM d5) + (SELECT COUNT(*) FROM dh) + (SELECT COUNT(*) FROM dd);")

ok "Orphan workflow usage rows removed: $ORPHAN_USAGE_COUNT"
ok "Null-dimension workflow rollups removed: $NULL_ROLLUP_COUNT"
echo ""

# ── Step 6: Verify ───────────────────────────────────────────────────
log "Verifying..."

RECIPE_COUNT=$($KC get workflowrecipes -n "$RECIPE_NS" -l "clerum.io/trigger-suite=true" --no-headers 2>/dev/null | wc -l | tr -d ' ')
ok "WorkflowRecipes with trigger-suite label: $RECIPE_COUNT"

TRIGGER_GRANT_COUNT=$(psql_scalar "SELECT COUNT(*) FROM user_workflow_triggers WHERE recipe_name LIKE 'e2e-%' AND recipe_namespace='${RECIPE_NS}';")
TEAM_ALLOWLIST_COUNT=$(psql_scalar "SELECT COUNT(*) FROM workflow_recipe_allowed_teams WHERE recipe_name LIKE 'e2e-%' AND recipe_namespace='${RECIPE_NS}';")
NEGATIVE_FIXTURE_COUNT=$($KC get workflowrecipes -n "$RECIPE_NS" -l "clerum.io/e2e-negative-fixture=true" --no-headers 2>/dev/null | wc -l | tr -d ' ')
ok "Trigger grants seeded: $TRIGGER_GRANT_COUNT"
ok "Team approval allowlist rows seeded: $TEAM_ALLOWLIST_COUNT"
ok "Expected negative fixtures: $NEGATIVE_FIXTURE_COUNT"

USER_COUNT=$(psql_scalar "SELECT COUNT(*) FROM users WHERE email IN ('${TRIGGER_USER_EMAIL}', 'trigger-outsider-e2e@clerum.io', 'placeholder-cfo@clerum.io');")
ok "E2E users in DB: $USER_COUNT"
echo ""

# ── Summary ──────────────────────────────────────────────────────────
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Seed Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  Recipes applied:  ${GREEN}${APPLIED}${NC}"
echo -e "  Recipes failed:   ${RED}${FAILED}${NC}"
echo -e "  Users seeded:     3 (trigger-e2e, outsider, CFO)"
echo -e "  Trigger grants:   ${TRIGGER_GRANT_COUNT}"
echo -e "  Team allowlists:  ${TEAM_ALLOWLIST_COUNT}"
echo -e "  Negative fixtures:${YELLOW} ${NEGATIVE_FIXTURE_COUNT}${NC}"
echo ""

if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}Seed complete.${NC} Run ./scripts/e2e/e2e-workflow-triggers.sh to execute E2E tests."
else
  echo -e "${YELLOW}${BOLD}Seed completed with $FAILED failures.${NC} Some recipes may need CRD updates."
fi
