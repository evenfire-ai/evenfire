#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Workflow Schedules (Phase 5 — DB-backed schedule worker)
# ═══════════════════════════════════════════════════════════════════════
#
# Validates the Phase 5 refactor of the DB-first workflow runs plan:
# schedules no longer emit K8s CronJobs; instead, the control-api worker
# drains `workflow_schedules` and INSERTs rows into `workflow_runs` with
# actor_type='scheduled'.
#
# Plan reference:
#   .ralph/plans/serene-sauteeing-jellyfish.md → Fase 5 (Schedules worker)
#   Exit criteria:
#     a) workflow_schedules row UPSERTed by the reconciler
#     b) ≥2 workflow_runs rows fired with actor_type='scheduled' after 3 min
#     c) `kubectl get cronjob -A -l clerum.io/workflow-schedule-owner` → zero
#     d) schedule row's next_fire_at advanced at least once
#
# Cases (6):
#   0. Connectivity                       : postgres + kubectl
#   1. Apply WorkflowRecipe with schedule : "*/1 * * * *" trigger
#   2. Schedule UPSERT to DB              : workflow_schedules row exists
#   3. Zero CronJobs emitted              : no CronJob with schedule-owner label
#   4. ≥2 scheduled runs fire             : workflow_runs count ≥ 2 after 180s
#   5. next_fire_at advances              : worker advances cursor after fires
#
# Prerequisites:
#   - Cluster with the Phase 5 images deployed (control-api + workflow-recipes)
#   - Port-forward active: control-api :8090
#   - Postgres reachable via kubectl exec
#   - WRC reconciling (reconcileScheduling UPSERTs workflow_schedules row)
#
# Usage:
#   ./scripts/e2e/e2e-workflow-schedules.sh
#   ./scripts/e2e/e2e-workflow-schedules.sh --verbose
#   ./scripts/e2e/e2e-workflow-schedules.sh --wait-seconds=240
#
# Environment:
#   E2E_CONTROL_API_URL       (default: http://localhost:8090)
#   E2E_POSTGRES_NAMESPACE    (default: control-plane)
#   E2E_POSTGRES_POD_SELECTOR (default: app=control-postgres)
#   E2E_POSTGRES_DB           (default: profiles)
#   E2E_SCHEDULE_TEAM_ID      (optional UUID; default creates an E2E team row)
#   E2E_SCHEDULE_WAIT_SECONDS (default: 180  -- must cover ≥2 cron minute tops)
#   K8S_CONTEXT               (default: clerum-test)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-openai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-gpt-5.4-mini}}"

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

VERBOSE=false
WAIT_SECONDS="${E2E_SCHEDULE_WAIT_SECONDS:-180}"
for arg in "$@"; do
  case "$arg" in
    --verbose)              VERBOSE=true ;;
    --wait-seconds=*)       WAIT_SECONDS="${arg#--wait-seconds=}" ;;
  esac
done

PASS=0; FAIL=0; TOTAL=0
log()    { echo -e "${CYAN}[schedule-e2e]${NC} $*"; }
pass()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
detail() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }

# ─── Configuration ───────────────────────────────────────────────────
K8S_CONTEXT="${K8S_CONTEXT:-clerum-test}"
KC="kubectl --context=${K8S_CONTEXT}"
CONTROL_URL="${E2E_CONTROL_API_URL:-http://localhost:8090}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"
PG_DB="${E2E_POSTGRES_DB:-profiles}"
RECIPE_NS="${E2E_RECIPE_NAMESPACE:-sandbox-recipes}"

RECIPE_NAME="e2e-schedule-$(date +%s)"
CREATED_RECIPES=("$RECIPE_NAME")

# ─── Helpers ─────────────────────────────────────────────────────────
pg_psql() {
  local sql="$1"
  local pod
  pod=$($KC -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found (ns=$PG_NS sel=$PG_SEL)"
  $KC -n "$PG_NS" exec "$pod" -- psql -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 -tAc "$sql"
}

# ─── Cleanup trap ────────────────────────────────────────────────────
cleanup() {
  local rc=$?
  set +e
  log "Running EXIT cleanup (rc=$rc)"

  for recipe in ${CREATED_RECIPES[@]+"${CREATED_RECIPES[@]}"}; do
    $KC delete workflowrecipe "$recipe" -n "$RECIPE_NS" --ignore-not-found --timeout=20s >/dev/null 2>&1 || true
    # Also purge any residual schedule + runs rows from the DB.
    pg_psql "DELETE FROM workflow_runs   WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${recipe}';" >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_schedules WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${recipe}';" >/dev/null 2>&1 || true
  done

  set -e
  exit "$rc"
}
trap cleanup EXIT

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E -- Workflow Schedules (Phase 5: DB-backed worker)${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo ""
log "Config: control-api=$CONTROL_URL"
log "Config: postgres=$PG_NS/$PG_SEL db=$PG_DB"
log "Config: k8s_context=$K8S_CONTEXT"
log "Config: recipe=$RECIPE_NAME (ns=$RECIPE_NS)"
log "Config: wait_seconds=$WAIT_SECONDS (cron is '*/1 * * * *')"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 0: connectivity
# ═════════════════════════════════════════════════════════════════════
log "Case 0: connectivity"

curl -sf --max-time 5 "${CONTROL_URL}/health" >/dev/null 2>&1 \
  && pass "control-api reachable at $CONTROL_URL" \
  || fail "control-api not reachable (run: make minikube-pf-all)"

PG_PING=$(pg_psql "SELECT 1;" 2>/dev/null || echo "")
[[ "$PG_PING" == "1" ]] \
  && pass "postgres reachable (db=$PG_DB)" \
  || fail "postgres not reachable (ns=$PG_NS sel=$PG_SEL db=$PG_DB)"

SCHED_TABLE_COUNT=$(pg_psql "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='workflow_schedules';" 2>/dev/null || echo "0")
[[ "$SCHED_TABLE_COUNT" == "1" ]] \
  && pass "workflow_schedules table present (Phase 1 schema applied)" \
  || fail "workflow_schedules table missing -- Phase 1 schema not applied"

RUNS_TABLE_COUNT=$(pg_psql "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='workflow_runs';" 2>/dev/null || echo "0")
[[ "$RUNS_TABLE_COUNT" == "1" ]] \
  && pass "workflow_runs table present" \
  || fail "workflow_runs table missing -- Phase 1 schema not applied"

SCHEDULE_TEAM_ID="${E2E_SCHEDULE_TEAM_ID:-}"
if [[ -z "$SCHEDULE_TEAM_ID" ]]; then
  SCHEDULE_TEAM_ID=$(pg_psql "INSERT INTO teams(name) VALUES ('E2E Schedule team') RETURNING id;" 2>/dev/null | head -1 | tr -d ' ' || echo "")
fi
[[ "$SCHEDULE_TEAM_ID" =~ ^[0-9a-fA-F-]{36}$ ]] \
  && pass "workflow team available for scheduled run attribution ($SCHEDULE_TEAM_ID)" \
  || fail "workflow team id missing/invalid for scheduled run attribution"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 1: Apply WorkflowRecipe with schedule trigger
# ═════════════════════════════════════════════════════════════════════
log "Case 1: Apply WorkflowRecipe with schedule '*/1 * * * *'"

CASE1_TMPDIR="$(mktemp -d -t clerum-schedule-case1-XXXX)"

cat > "$CASE1_TMPDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e-phase: "5"
    clerum.io/workflow-team-id: "${SCHEDULE_TEAM_ID}"
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    schedule:
      cron: "*/1 * * * *"
      timezone: UTC
  steps:
    - id: scheduled-step
      instruction: "Phase 5 scheduled E2E step."
      timeoutSeconds: 60
YAML

$KC apply -f "$CASE1_TMPDIR/recipe.yaml" >/dev/null 2>&1 \
  && pass "Case 1: WorkflowRecipe with schedule trigger applied" \
  || fail "Case 1: kubectl apply rejected scheduled WorkflowRecipe"
rm -rf "$CASE1_TMPDIR"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 2: WRC reconciler UPSERTs workflow_schedules row
# ═════════════════════════════════════════════════════════════════════
log "Case 2: workflow_schedules row UPSERTed by reconcileScheduling"

SCHED_ROWS=""
for i in $(seq 1 20); do
  SCHED_ROWS=$(pg_psql "SELECT cron_expression FROM workflow_schedules WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" 2>/dev/null || echo "")
  if [[ -n "$SCHED_ROWS" ]]; then
    break
  fi
  sleep 3
done

if [[ "$SCHED_ROWS" == "*/1 * * * *" ]]; then
  pass "Case 2: workflow_schedules row UPSERTed with cron='*/1 * * * *'"
else
  fail "Case 2: workflow_schedules row missing or cron mismatch: '$SCHED_ROWS'"
fi

INITIAL_NEXT_FIRE=$(pg_psql "SELECT next_fire_at FROM workflow_schedules WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" 2>/dev/null || echo "")
detail "Initial next_fire_at: $INITIAL_NEXT_FIRE"
[[ -n "$INITIAL_NEXT_FIRE" ]] \
  && pass "Case 2b: next_fire_at populated by reconciler ($INITIAL_NEXT_FIRE)" \
  || fail "Case 2b: next_fire_at empty"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 3: Zero CronJobs emitted (ADR-004 invariant)
# ═════════════════════════════════════════════════════════════════════
# After Phase 5, the reconciler must NOT emit a K8s CronJob for schedules.
# Both the new label (Phase 5) and the legacy label (pre-refactor) must be
# empty — if either has rows, the rollback to CronJob-emitter is still live.
log "Case 3: Zero CronJobs emitted for scheduled recipes"

CRONJOB_NEW=$($KC get cronjob -A -l "clerum.io/workflow-schedule-owner=${RECIPE_NAME}" \
  --no-headers 2>/dev/null | wc -l | tr -d ' ')
CRONJOB_LEGACY=$($KC get cronjob -A -l "clerum.io/recipe=${RECIPE_NAME}" \
  --no-headers 2>/dev/null | wc -l | tr -d ' ')

if [[ "$CRONJOB_NEW" == "0" && "$CRONJOB_LEGACY" == "0" ]]; then
  pass "Case 3: no CronJobs emitted (new_label=$CRONJOB_NEW, legacy_label=$CRONJOB_LEGACY)"
else
  fail "Case 3: CronJob still emitted (new_label=$CRONJOB_NEW legacy_label=$CRONJOB_LEGACY) -- Phase 5 rollback live"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 4: ≥2 scheduled runs fire within the wait window
# ═════════════════════════════════════════════════════════════════════
log "Case 4: wait ${WAIT_SECONDS}s for ≥2 scheduled runs"

START_TS=$(date +%s)
TARGET_TS=$((START_TS + WAIT_SECONDS))
RUN_COUNT=0

while [[ $(date +%s) -lt $TARGET_TS ]]; do
  RUN_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs \
    WHERE recipe_namespace='${RECIPE_NS}' \
      AND recipe_name='${RECIPE_NAME}' \
      AND actor_type='scheduled' \
      AND trigger_source='schedule';" 2>/dev/null || echo "0")
  detail "t=$(($(date +%s) - START_TS))s run_count=$RUN_COUNT"
  if [[ "$RUN_COUNT" -ge 2 ]]; then
    break
  fi
  sleep 10
done

if [[ "$RUN_COUNT" -ge 2 ]]; then
  pass "Case 4: ${RUN_COUNT} scheduled runs fired (actor_type='scheduled' trigger_source='schedule')"
else
  fail "Case 4: only ${RUN_COUNT} scheduled runs after ${WAIT_SECONDS}s (expected ≥2)"
fi

TEAM_RUN_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs \
  WHERE recipe_namespace='${RECIPE_NS}' \
    AND recipe_name='${RECIPE_NAME}' \
    AND actor_type='scheduled' \
    AND trigger_source='schedule' \
    AND team_id='${SCHEDULE_TEAM_ID}';" 2>/dev/null || echo "0")
if [[ "$TEAM_RUN_COUNT" -ge 2 ]]; then
  pass "Case 4a: scheduled runs carry workflow team_id snapshot"
else
  fail "Case 4a: scheduled runs missing workflow team_id snapshot (${TEAM_RUN_COUNT}/${RUN_COUNT})"
fi

# Verify idempotency key shape per workflowScheduleWorkerService contract
# Expected format: schedule/<schedule_id>/<fire_time ISO>
SAMPLE_KEY=$(pg_psql "SELECT idempotency_key FROM workflow_runs \
  WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}' \
    AND actor_type='scheduled' LIMIT 1;" 2>/dev/null || echo "")
detail "Sample idempotency_key: $SAMPLE_KEY"
if [[ "$SAMPLE_KEY" == schedule/* ]]; then
  pass "Case 4b: idempotency_key formatted as 'schedule/<id>/<iso>'"
else
  warn "Case 4b: idempotency_key shape unexpected: '$SAMPLE_KEY'"
fi
echo ""

# ═════════════════════════════════════════════════════════════════════
# Case 5: next_fire_at advances after fires
# ═════════════════════════════════════════════════════════════════════
log "Case 5: next_fire_at advances past initial cursor"

CURRENT_NEXT_FIRE=$(pg_psql "SELECT next_fire_at FROM workflow_schedules \
  WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" 2>/dev/null || echo "")
detail "Initial: $INITIAL_NEXT_FIRE"
detail "Current: $CURRENT_NEXT_FIRE"

if [[ -n "$CURRENT_NEXT_FIRE" && "$CURRENT_NEXT_FIRE" != "$INITIAL_NEXT_FIRE" ]]; then
  pass "Case 5: next_fire_at advanced ($INITIAL_NEXT_FIRE → $CURRENT_NEXT_FIRE)"
else
  fail "Case 5: next_fire_at did NOT advance (still '$CURRENT_NEXT_FIRE') -- worker not rolling cursor"
fi

LAST_FIRE_AT=$(pg_psql "SELECT last_fire_at FROM workflow_schedules \
  WHERE recipe_namespace='${RECIPE_NS}' AND recipe_name='${RECIPE_NAME}';" 2>/dev/null || echo "")
detail "last_fire_at: $LAST_FIRE_AT"
[[ -n "$LAST_FIRE_AT" ]] \
  && pass "Case 5b: last_fire_at stamped ($LAST_FIRE_AT)" \
  || warn "Case 5b: last_fire_at empty (worker may not stamp it)"
echo ""

# ═════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════
echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}=================================================================${NC}"
echo -e "  PASS:  ${GREEN}${PASS}${NC}"
echo -e "  FAIL:  ${RED}${FAIL}${NC}"
echo -e "  TOTAL: ${TOTAL}"
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}ALL WORKFLOW SCHEDULE E2E CASES PASSED${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}WORKFLOW SCHEDULE E2E FAILED${NC}"
  exit 1
fi
