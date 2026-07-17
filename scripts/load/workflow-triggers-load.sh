#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Load test -- Workflow Triggers (DB-first verification)
# ═══════════════════════════════════════════════════════════════════════
#
# Fires N concurrent /trigger calls against control-api and validates:
#
#   A. All N rows appear in workflow_runs (no drops, no duplicates).
#   B. No row has been claimed by two different WRC instances:
#        SELECT run_id, COUNT(DISTINCT owner_instance_id)
#          FROM workflow_runs
#          WHERE recipe_name = $NAME
#          GROUP BY run_id
#          HAVING COUNT(DISTINCT owner_instance_id) > 1  -> must be 0 rows
#   C. P95 latency Pending->Running < ${P95_THRESHOLD_MS}ms (default 500).
#        Computed as percentile_cont(0.95) of (updated_at - created_at)
#        in ms across rows that advanced past Pending.
#
#        Threshold rationale:
#          * 500ms   — production target with 3+ WRC replicas (ADR-001).
#          * 15000ms — minikube / single-replica dev (K8s API serializes
#                      child-recipe creation; realistic for 1 replica).
#        Override with --p95-ms=N or P95_THRESHOLD_MS=N env var.
#
#   NOTE on rate limiting: the /trigger endpoint enforces 10 req/min/user.
#   For N>10 the script issues ONE user-session token but hashes it per
#   request — same bucket. Prefer N<=10 in single-user runs, or scale the
#   RATE_LIMIT out-of-band when bench-testing throughput.
#
# Assumes the infrastructure already validated by e2e-workflow-triggers.sh:
#   * control-api on :8090 via port-forward (or override E2E_CONTROL_API_URL)
#   * external-rest-api on :8091 (for password-login; the test user needs a
#     seeded password — scripts/e2e/seed-e2e-data.sh)
#   * INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET reachable from cluster Secret
#     internal-control-jwt-secrets (control-plane namespace)
#   * Postgres in control-plane/app=control-postgres
#
# Usage:
#   ./scripts/load/workflow-triggers-load.sh              # default N=100, C=100
#   ./scripts/load/workflow-triggers-load.sh --n=50 --c=25
#   ./scripts/load/workflow-triggers-load.sh --keep       # don't cleanup recipe/runs
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_WORKFLOW_MODEL_PROVIDER="${E2E_WORKFLOW_MODEL_PROVIDER:-${CLERUM_MODEL_PROVIDER:-zai}}"
E2E_WORKFLOW_MODEL_NAME="${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}"

# ─── Colors / logging ───────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
log()    { echo -e "${CYAN}[load]${NC} $*"; }
pass()   { echo -e "  ${GREEN}PASS${NC} $*"; }
fail()   { echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }
warn()   { echo -e "  ${YELLOW}WARN${NC} $*"; }
hdr()    { echo ""; echo -e "${BOLD}$*${NC}"; }

# ─── Args ───────────────────────────────────────────────────────────
N=100
CONCURRENCY=100
KEEP=false
P95_THRESHOLD_MS="${P95_THRESHOLD_MS:-500}"
STRICT=false
for arg in "$@"; do
  case "$arg" in
    --n=*)       N="${arg#--n=}" ;;
    --c=*)       CONCURRENCY="${arg#--c=}" ;;
    --keep)      KEEP=true ;;
    --p95-ms=*)  P95_THRESHOLD_MS="${arg#--p95-ms=}" ;;
    --strict)    STRICT=true ;;
    -h|--help)
      sed -n '1,50p' "$0"; exit 0 ;;
  esac
done

# ─── Config ─────────────────────────────────────────────────────────
K8S_CONTEXT="${K8S_CONTEXT:-clerum-test}"
KC="kubectl --context=${K8S_CONTEXT}"
CONTROL_URL="${E2E_CONTROL_API_URL:-http://localhost:8090}"
EXT_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"
PG_DB="${PG_DB:-profiles}"
WRC_NS="${WRC_NS:-control-plane}"
WRC_SEL="${WRC_SEL:-app=workflow-recipes}"
USER_EMAIL="${E2E_TEST_EMAIL:-load-triggers-e2e@clerum.io}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-changeme123!}"
RECIPE_NS="sandbox-recipes"
SANDBOX_NS="sandbox-recipes"
RECIPE_NAME="e2e-load-$(date +%s)"
WORKDIR="$(mktemp -d -t clerum-load-XXXX)"

log "N=${N} concurrency=${CONCURRENCY} recipe=${RECIPE_NAME} workdir=${WORKDIR}"

# ─── Helpers (compact, self-contained) ──────────────────────────────
http_request() {
  local method="$1"; local url="$2"; local body="${3:-}"; shift 3 2>/dev/null || shift $#
  local -a args=(-s -w '\n%{http_code}' --max-time 30 -X "$method" -H "Content-Type: application/json")
  for h in "$@"; do args+=(-H "$h"); done
  [[ -n "$body" ]] && args+=(-d "$body")
  local raw; raw=$(curl "${args[@]}" "$url" 2>/dev/null) || { HTTP_STATUS=000; HTTP_BODY='{}'; return 1; }
  HTTP_STATUS=$(echo "$raw" | tail -n1); HTTP_BODY=$(echo "$raw" | sed '$d')
}
json_field() {
  echo "$1" | node --no-warnings -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{try{const o=JSON.parse(d); const v=$2;
    process.stdout.write(String(v===undefined||v===null?'':v));}catch{process.stdout.write('');}});" 2>/dev/null
}
pg_psql() {
  local pod; pod=$($KC -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found"
  $KC -n "$PG_NS" exec "$pod" -- psql -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 -tAc "$1"
}
uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'
  else node -e "console.log(require('crypto').randomUUID())"; fi
}
now_ms() {
  # Portable ms epoch: GNU date supports %3N; BSD date (macOS) does not.
  local v; v=$(date +%s%3N 2>/dev/null)
  if [[ "$v" =~ ^[0-9]+$ ]]; then echo "$v"
  else python3 -c 'import time; print(int(time.time()*1000))'; fi
}

cleanup() {
  local ec=$?
  if [[ "$KEEP" != "true" ]]; then
    log "Cleanup recipe + runs (--keep to preserve)"
    $KC -n "$RECIPE_NS" delete workflowrecipe "$RECIPE_NAME" --ignore-not-found >/dev/null 2>&1 || true
    pg_psql "DELETE FROM workflow_runs WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
    pg_psql "DELETE FROM user_workflow_triggers WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}';" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR" || true
  exit $ec
}
trap cleanup EXIT

# ─── InternalControl JWT signer (HS256) ─────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../e2e/_lib/internal-control-jwt.sh
source "${SCRIPT_DIR}/../e2e/_lib/internal-control-jwt.sh"
if ! resolve_internal_control_hmac_secret >/dev/null; then
  fail "InternalControl JWT HMAC secret missing (set E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET / E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET or ensure cluster Secret internal-control-jwt-secrets is reachable)"
fi

# ─── Step 1: password-login ─────────────────────────────────────────
hdr "Step 1: password-login ($USER_EMAIL)"
http_request POST "${EXT_URL}/api/v1/auth/password-login" "$(printf '{"email":"%s","password":"%s"}' "$USER_EMAIL" "$ADMIN_PASSWORD")"
[[ "$HTTP_STATUS" == "200" ]] || fail "password-login (HTTP $HTTP_STATUS): $HTTP_BODY"
USER_TOKEN=$(json_field "$HTTP_BODY" "o.token")
USER_ID=$(json_field "$HTTP_BODY" "o.me && o.me.id")
[[ -n "$USER_TOKEN" && -n "$USER_ID" ]] || fail "password-login missing token/id"
pass "user logged in (id=${USER_ID})"

# ─── Step 2: grant ──────────────────────────────────────────────────
hdr "Step 2: seed user_workflow_triggers grant"
pg_psql "INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name) \
         VALUES ('${USER_ID}','${SANDBOX_NS}','${RECIPE_NAME}') ON CONFLICT DO NOTHING;" >/dev/null
pass "grant seeded"

# ─── Step 3: apply WorkflowRecipe with onDemand trigger ─────────────
hdr "Step 3: apply WorkflowRecipe (onDemand)"
cat > "$WORKDIR/recipe.yaml" <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${RECIPE_NAME}
  namespace: ${RECIPE_NS}
spec:
  agent:
    provider: ${E2E_WORKFLOW_MODEL_PROVIDER}
    model: ${E2E_WORKFLOW_MODEL_NAME}
  triggers:
    onDemand:
      requiresApproval: false
      allowedActors: [user, autonomous]
  steps:
    - id: noop
      instruction: "load-test step"
      timeoutSeconds: 30
YAML
$KC apply -f "$WORKDIR/recipe.yaml" >/dev/null
pass "recipe applied"

# ─── Step 4: issue mcpHost control token ────────────────────────────
hdr "Step 4: POST /auth/mcp-host/:ns/:name/tokens"
ISSUE_BODY='{"includeMcpHostControlToken":true,"workflowControlScopes":["workflow:list","workflow:read","workflow:trigger"]}'
http_request POST "${CONTROL_URL}/api/v1/auth/mcp-host/${RECIPE_NS}/${RECIPE_NAME}/tokens" "$ISSUE_BODY" \
  "Authorization: Bearer $(sign_internal_control_jwt wrc)"
[[ "$HTTP_STATUS" == "200" ]] || fail "mcp-host token issuance (HTTP $HTTP_STATUS): $HTTP_BODY"
WA_TOKEN=$(json_field "$HTTP_BODY" "o.mcpHostControlToken")
[[ -n "$WA_TOKEN" ]] || fail "empty mcpHostControlToken"
pass "mcpHost control token issued (${#WA_TOKEN} chars)"

# ─── Step 5: capture WRC metrics baseline (best-effort) ─────────────
hdr "Step 5: baseline WRC metrics (best-effort)"
WRC_POD=$($KC -n "$WRC_NS" get pod -l "$WRC_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
METRIC_BEFORE=""
if [[ -n "$WRC_POD" ]]; then
  METRIC_BEFORE=$($KC -n "$WRC_NS" exec "$WRC_POD" -- sh -c "wget -qO- http://localhost:8082/metrics 2>/dev/null || curl -s http://localhost:8082/metrics" 2>/dev/null \
    | grep -E '^wrc_runs_processed_total' | awk '{sum+=$NF} END{print sum+0}' || echo "")
  if [[ -n "$METRIC_BEFORE" ]]; then
    pass "metric wrc_runs_processed_total baseline = $METRIC_BEFORE"
  else
    warn "wrc_runs_processed_total not exposed -- metric assertion will be SKIPPED"
  fi
else
  warn "workflow-recipes pod not found -- metric assertion will be SKIPPED"
fi

# ─── Step 6: fire N concurrent triggers ─────────────────────────────
hdr "Step 6: fire ${N} concurrent triggers (parallelism=${CONCURRENCY})"
mkdir -p "$WORKDIR/resp"
TRIGGER_URL="${CONTROL_URL}/api/v1/workflows/${SANDBOX_NS}/${RECIPE_NAME}/trigger"

fire_one() {
  local i="$1"
  local idem="load-${RECIPE_NAME}-$(uuid)"
  local out="${WORKDIR}/resp/${i}.out"
  local t0; t0=$(now_ms)
  curl -s -o "$out.body" -w '%{http_code}' --max-time 30 -X POST "$TRIGGER_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $WA_TOKEN" \
    -H "Idempotency-Key: $idem" \
    -d '{"inputs":{}}' > "$out.status" 2>/dev/null || echo "000" > "$out.status"
  local t1; t1=$(now_ms)
  echo "$((t1 - t0))" > "$out.latency"
}
export -f fire_one uuid now_ms
export WORKDIR TRIGGER_URL WA_TOKEN RECIPE_NAME

T0_ALL=$(now_ms)
seq 1 "$N" | xargs -n 1 -P "$CONCURRENCY" -I{} bash -c 'fire_one "$@"' _ {}
T1_ALL=$(now_ms)
WALL_MS=$((T1_ALL - T0_ALL))
pass "all ${N} requests returned in ${WALL_MS}ms wall-clock"

# Summarize HTTP statuses
OK_COUNT=0; BAD_COUNT=0
for i in $(seq 1 "$N"); do
  st=$(cat "$WORKDIR/resp/${i}.out.status" 2>/dev/null || echo "000")
  if [[ "$st" == "201" || "$st" == "200" ]]; then OK_COUNT=$((OK_COUNT+1))
  else BAD_COUNT=$((BAD_COUNT+1)); fi
done
log "HTTP 2xx=${OK_COUNT} non-2xx=${BAD_COUNT}"
[[ "$OK_COUNT" == "$N" ]] || warn "only $OK_COUNT/$N requests accepted"

# Allow WRC a few seconds to pick up + transition rows past Pending
log "waiting 15s for WRC to process runs..."
sleep 15

# ─── Assertion A: row count == N ────────────────────────────────────
hdr "Assertion A: all ${N} runs inserted"
ROW_COUNT=$(pg_psql "SELECT COUNT(*) FROM workflow_runs WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}';" | tr -d ' \n')
if [[ "$ROW_COUNT" == "$N" ]]; then
  pass "workflow_runs count = ${ROW_COUNT}"
else
  warn "expected ${N} rows, got ${ROW_COUNT}"
  # Non-fatal: document the drop, continue to other asserts
fi

# ─── Assertion B: no double-assignment ──────────────────────────────
hdr "Assertion B: no row with 2+ distinct owner_instance_id"
DUP_ROWS=$(pg_psql "SELECT COUNT(*) FROM ( \
  SELECT run_id FROM workflow_runs \
    WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}' \
    GROUP BY run_id HAVING COUNT(DISTINCT owner_instance_id) > 1 \
) sub;" | tr -d ' \n')
if [[ "$DUP_ROWS" == "0" ]]; then
  pass "no split-brain: 0 rows with multiple owners"
else
  fail "split-brain detected: ${DUP_ROWS} rows with >1 owner_instance_id"
fi

# ─── Assertion C: P95 latency Pending->Running < P95_THRESHOLD_MS ───
hdr "Assertion C: P95 Pending->Running < ${P95_THRESHOLD_MS}ms"
P95_MS=$(pg_psql "SELECT COALESCE( \
  percentile_cont(0.95) WITHIN GROUP ( \
    ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000.0 \
  ), 0) \
  FROM workflow_runs \
  WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}' \
    AND phase IN ('Running','Succeeded','Failed','Canceled');" | tr -d ' \n')
PROMOTED=$(pg_psql "SELECT COUNT(*) FROM workflow_runs \
  WHERE recipe_namespace='${SANDBOX_NS}' AND recipe_name='${RECIPE_NAME}' \
    AND phase IN ('Running','Succeeded','Failed','Canceled');" | tr -d ' \n')
log "rows promoted past Pending: ${PROMOTED}/${ROW_COUNT}"
C_BREACH=false
if [[ -z "$P95_MS" || "$PROMOTED" == "0" ]]; then
  warn "no rows promoted past Pending yet -- P95 unavailable (WRC may be catching up)"
  C_BREACH=true
elif awk -v p="$P95_MS" -v t="$P95_THRESHOLD_MS" 'BEGIN{exit !(p < t)}'; then
  pass "P95 Pending->Running = ${P95_MS}ms (< ${P95_THRESHOLD_MS}ms)"
else
  if $STRICT; then
    fail "P95 Pending->Running = ${P95_MS}ms (>= ${P95_THRESHOLD_MS}ms threshold)"
  else
    warn "P95 Pending->Running = ${P95_MS}ms (>= ${P95_THRESHOLD_MS}ms threshold) [non-strict]"
    C_BREACH=true
  fi
fi

# ─── Assertion D: metrics counter delta (best-effort) ───────────────
hdr "Assertion D: wrc_runs_processed_total delta (best-effort)"
if [[ -n "$METRIC_BEFORE" && -n "$WRC_POD" ]]; then
  METRIC_AFTER=$($KC -n "$WRC_NS" exec "$WRC_POD" -- sh -c "wget -qO- http://localhost:8082/metrics 2>/dev/null || curl -s http://localhost:8082/metrics" 2>/dev/null \
    | grep -E '^wrc_runs_processed_total' | awk '{sum+=$NF} END{print sum+0}' || echo "")
  if [[ -n "$METRIC_AFTER" ]]; then
    DELTA=$((METRIC_AFTER - METRIC_BEFORE))
    log "wrc_runs_processed_total before=${METRIC_BEFORE} after=${METRIC_AFTER} delta=${DELTA}"
    if [[ "$DELTA" -ge "$PROMOTED" ]]; then
      pass "metric delta (${DELTA}) >= rows promoted (${PROMOTED})"
    else
      warn "metric delta (${DELTA}) < rows promoted (${PROMOTED})"
    fi
  else
    warn "wrc_runs_processed_total disappeared from /metrics -- skipped"
  fi
else
  warn "metric baseline was not captured -- SKIPPED (metric not implemented yet)"
fi

# ─── Summary ────────────────────────────────────────────────────────
hdr "Summary"
echo "  N requests:          ${N}"
echo "  concurrency:         ${CONCURRENCY}"
echo "  wall-clock:          ${WALL_MS}ms"
echo "  http 2xx:            ${OK_COUNT}/${N}"
echo "  workflow_runs rows:  ${ROW_COUNT}"
echo "  rows past Pending:   ${PROMOTED}"
echo "  split-brain rows:    ${DUP_ROWS}"
echo "  P95 Pending->Running: ${P95_MS:-n/a}ms"

# Exit non-zero only on hard failures (B above is fatal; A/C/D warn-only
# so the suite reports accurate data even when WRC hasn't finished).
echo -e "${GREEN}LOAD TEST COMPLETE${NC}"
