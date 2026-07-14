#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Workflow Usage Attribution
# ═══════════════════════════════════════════════════════════════════════
#
# Run after executing the workflow-recipes E2E fixtures. It validates the
# business signal that powers /usage: new workflow LLM usage must carry a
# canonical run-id task_id plus non-null Team and LLM Secret dimensions.
#
# Environment:
#   K8S_CONTEXT                    (default: clerum-test)
#   E2E_POSTGRES_NAMESPACE         (default: control-plane)
#   E2E_POSTGRES_POD_SELECTOR      (default: app=control-postgres)
#   E2E_POSTGRES_DB                (default: profiles)
#   E2E_USAGE_RECIPE_LIKE          (default: e2e-%)
#   E2E_USAGE_LOOKBACK_HOURS       (default: 24)
#   E2E_USAGE_MIN_REQUESTS         (default: 1)
#   E2E_USAGE_ROLLUP_WAIT_SECONDS  (default: 90)
#   E2E_USAGE_TRIGGER_FIXTURES     (default: false; trigger seeded recipes first)
#   E2E_USAGE_EVENT_WAIT_SECONDS   (default: 300 when triggering fixtures)
#   E2E_EXTERNAL_REST_API_URL      (default: http://localhost:8091)
#   E2E_TEST_EMAIL                 (default: test@clerum.io)
#   E2E_USAGE_TRIGGER_RECIPES      (default: e2e-ondemand-simple e2e-retention-recipe e2e-scheduled-recipe)
#   E2E_USAGE_SCHEDULE_RECIPE      optional; only set when the schedule suite seeded that fixture
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${CYAN}[usage-attribution-e2e]${NC} $*"; }
pass() { echo -e "  ${GREEN}PASS${NC} $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC} $*"; }
fail() { echo -e "  ${RED}FAIL${NC} $*"; echo -e "${RED}ABORT${NC}"; exit 1; }

K8S_CONTEXT="${K8S_CONTEXT:-clerum-test}"
KC="kubectl --context=${K8S_CONTEXT}"
PG_NS="${E2E_POSTGRES_NAMESPACE:-control-plane}"
PG_SEL="${E2E_POSTGRES_POD_SELECTOR:-app=control-postgres}"
PG_DB="${E2E_POSTGRES_DB:-profiles}"
RECIPE_LIKE="${E2E_USAGE_RECIPE_LIKE:-e2e-%}"
LOOKBACK_HOURS="${E2E_USAGE_LOOKBACK_HOURS:-24}"
MIN_REQUESTS="${E2E_USAGE_MIN_REQUESTS:-1}"
ROLLUP_WAIT_SECONDS="${E2E_USAGE_ROLLUP_WAIT_SECONDS:-90}"
TRIGGER_FIXTURES="${E2E_USAGE_TRIGGER_FIXTURES:-false}"
EVENT_WAIT_SECONDS="${E2E_USAGE_EVENT_WAIT_SECONDS:-300}"
EXT_URL="${E2E_EXTERNAL_REST_API_URL:-http://localhost:8091}"
TEST_EMAIL="${E2E_TEST_EMAIL:-test@clerum.io}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-changeme123!}"
TRIGGER_RECIPES="${E2E_USAGE_TRIGGER_RECIPES:-e2e-ondemand-simple e2e-retention-recipe e2e-scheduled-recipe}"
SCHEDULE_RECIPE="${E2E_USAGE_SCHEDULE_RECIPE:-}"

[[ "$LOOKBACK_HOURS" =~ ^[0-9]+$ && "$LOOKBACK_HOURS" -gt 0 ]] \
  || fail "E2E_USAGE_LOOKBACK_HOURS must be a positive integer"
[[ "$MIN_REQUESTS" =~ ^[0-9]+$ && "$MIN_REQUESTS" -gt 0 ]] \
  || fail "E2E_USAGE_MIN_REQUESTS must be a positive integer"
[[ "$ROLLUP_WAIT_SECONDS" =~ ^[0-9]+$ ]] \
  || fail "E2E_USAGE_ROLLUP_WAIT_SECONDS must be a non-negative integer"
[[ "$EVENT_WAIT_SECONDS" =~ ^[0-9]+$ ]] \
  || fail "E2E_USAGE_EVENT_WAIT_SECONDS must be a non-negative integer"

sql_literal() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "$value"
}

RECIPE_LIKE_SQL=$(sql_literal "$RECIPE_LIKE")
UUID_RE="'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"

pg_psql() {
  local sql="$1"
  local pod
  pod=$($KC -n "$PG_NS" get pod -l "$PG_SEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ -n "$pod" ]] || fail "postgres pod not found (ns=$PG_NS sel=$PG_SEL)"
  $KC -n "$PG_NS" exec "$pod" -- psql -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 -tAc "$sql"
}

curl_config_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

HTTP_STATUS=""
HTTP_BODY=""
http_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  shift 3 2>/dev/null || shift $#

  local cfg body_file raw rc
  cfg=$(mktemp "${TMPDIR:-/tmp}/clerum-usage-curl.XXXXXX")
  chmod 600 "$cfg"
  body_file=""
  if [[ -n "$body" ]]; then
    body_file=$(mktemp "${TMPDIR:-/tmp}/clerum-usage-body.XXXXXX")
    chmod 600 "$body_file"
    printf '%s' "$body" >"$body_file"
  fi

  {
    printf 'silent\n'
    printf 'write-out = "\\n%%{http_code}"\n'
    printf 'max-time = 30\n'
    printf 'request = "%s"\n' "$(curl_config_quote "$method")"
    printf 'url = "%s"\n' "$(curl_config_quote "$url")"
    printf 'header = "Content-Type: application/json"\n'
    for hdr in "$@"; do
      printf 'header = "%s"\n' "$(curl_config_quote "$hdr")"
    done
    [[ -n "$body_file" ]] && printf 'data-binary = "@%s"\n' "$(curl_config_quote "$body_file")"
  } >"$cfg"

  raw=$(curl --config "$cfg" 2>/dev/null)
  rc=$?
  rm -f "$cfg" "$body_file"
  if [[ "$rc" -ne 0 ]]; then
    HTTP_STATUS="000"
    HTTP_BODY='{"error":"curl failed"}'
    return 1
  fi
  HTTP_STATUS=$(echo "$raw" | tail -n1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | node --no-warnings -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{
        const o=JSON.parse(d);
        const v=$field;
        process.stdout.write(String(v===undefined||v===null?'':v));
      }catch{process.stdout.write('');}
    });
  " 2>/dev/null
}

trigger_seeded_fixtures() {
  log "Triggering seeded workflow recipes to generate fresh usage"

  curl -sf --max-time 5 "${EXT_URL}/health" >/dev/null 2>&1 \
    && pass "external-rest-api reachable at $EXT_URL" \
    || fail "external-rest-api not reachable at $EXT_URL"

  local login_body user_token user_id
  login_body=$(TEST_EMAIL="$TEST_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node --no-warnings -e \
    'process.stdout.write(JSON.stringify({email: process.env.TEST_EMAIL, password: process.env.ADMIN_PASSWORD}))')
  http_json POST "${EXT_URL}/api/v1/auth/password-login" "$login_body"
  [[ "$HTTP_STATUS" == "200" ]] || fail "password-login ${TEST_EMAIL} failed (HTTP $HTTP_STATUS): $HTTP_BODY"
  user_token=$(json_field "$HTTP_BODY" "o.token")
  user_id=$(json_field "$HTTP_BODY" "o.me && o.me.id")
  [[ -n "$user_token" && -n "$user_id" ]] || fail "password-login response missing token/user id"
  pass "password-login succeeded for usage trigger user"

  local recipe idempotency body run_id status
  for recipe in $TRIGGER_RECIPES; do
    $KC -n sandbox-recipes get workflowrecipe "$recipe" >/dev/null 2>&1 \
      || fail "seeded WorkflowRecipe missing: sandbox-recipes/${recipe}"

    idempotency="usage-attribution-${recipe}-$(date +%s)-${RANDOM}"
    body='{"inputs":{"source":"usage-attribution-e2e"}}'
    http_json POST "${EXT_URL}/api/v1/workflows/sandbox-recipes/${recipe}/trigger" "$body" \
      "Authorization: Bearer ${user_token}" \
      "Idempotency-Key: ${idempotency}"
    status="$HTTP_STATUS"
    [[ "$status" == "201" || "$status" == "200" ]] \
      || fail "trigger ${recipe} failed (HTTP $status): $HTTP_BODY"
    run_id=$(json_field "$HTTP_BODY" "o.id")
    [[ -n "$run_id" ]] || fail "trigger ${recipe} response missing run id"
    pass "triggered ${recipe} (run_id=${run_id})"
  done

  if [[ -n "$SCHEDULE_RECIPE" ]]; then
    local schedule_rows
    schedule_rows=$(pg_psql "UPDATE workflow_schedules
      SET next_fire_at = now() - interval '1 second', updated_at = now()
      WHERE recipe_namespace='sandbox-recipes'
        AND recipe_name='${SCHEDULE_RECIPE}'
        AND team_id IS NOT NULL
      RETURNING 1;" | wc -l | tr -d ' ')
    [[ "$schedule_rows" -gt 0 ]] \
      && pass "forced scheduled fixture ${SCHEDULE_RECIPE} with non-null team snapshot" \
      || fail "scheduled fixture ${SCHEDULE_RECIPE} missing or has null team snapshot"
  fi
}

wait_for_usage_events() {
  local deadline event_count
  deadline=$((SECONDS + EVENT_WAIT_SECONDS))
  while true; do
    event_count=$(pg_psql "SELECT COUNT(*)
      FROM usage_events e
     WHERE e.source_kind='workflow'
       AND e.recipe_name LIKE ${RECIPE_LIKE_SQL}
       AND e.ts >= now() - make_interval(hours => ${LOOKBACK_HOURS});" | tr -d ' \n')
    if [[ "$event_count" -ge "$MIN_REQUESTS" || "$SECONDS" -ge "$deadline" ]]; then
      EVENT_COUNT="$event_count"
      return 0
    fi
    sleep 5
  done
}

echo -e "${BOLD}=================================================================${NC}"
echo -e "${BOLD}  Clerum E2E -- Workflow Usage Attribution${NC}"
echo -e "${BOLD}=================================================================${NC}"
log "Config: k8s_context=$K8S_CONTEXT postgres=$PG_NS/$PG_SEL db=$PG_DB"
log "Config: recipe_like=$RECIPE_LIKE lookback_hours=$LOOKBACK_HOURS min_requests=$MIN_REQUESTS"
echo ""

PG_PING=$(pg_psql "SELECT 1;" 2>/dev/null || echo "")
[[ "$PG_PING" == "1" ]] && pass "postgres reachable" || fail "postgres not reachable"

if [[ "$TRIGGER_FIXTURES" == "true" ]]; then
  trigger_seeded_fixtures
  wait_for_usage_events
else
  EVENT_COUNT=$(pg_psql "SELECT COUNT(*)
    FROM usage_events e
   WHERE e.source_kind='workflow'
     AND e.recipe_name LIKE ${RECIPE_LIKE_SQL}
     AND e.ts >= now() - make_interval(hours => ${LOOKBACK_HOURS});" | tr -d ' \n')
fi
[[ "$EVENT_COUNT" -ge "$MIN_REQUESTS" ]] \
  && pass "workflow usage_events present ($EVENT_COUNT requests)" \
  || fail "workflow usage_events below minimum ($EVENT_COUNT < $MIN_REQUESTS)"

BAD_EVENT_COUNT=$(pg_psql "SELECT COUNT(*)
  FROM usage_events e
 WHERE e.source_kind='workflow'
   AND e.recipe_name LIKE ${RECIPE_LIKE_SQL}
   AND e.ts >= now() - make_interval(hours => ${LOOKBACK_HOURS})
   AND (
     e.team_id IS NULL
     OR e.team_id !~* ${UUID_RE}
     OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id::text = e.team_id)
     OR e.llm_secret_name IS NULL
     OR e.task_id IS NULL
     OR split_part(e.task_id, ':', 1) !~* ${UUID_RE}
     OR NOT (
       EXISTS (SELECT 1 FROM workflow_runs wr WHERE wr.run_id::text = split_part(e.task_id, ':', 1))
       OR EXISTS (SELECT 1 FROM workflow_runs_audit wra WHERE wra.run_id::text = split_part(e.task_id, ':', 1))
     )
   );" | tr -d ' \n')
[[ "$BAD_EVENT_COUNT" == "0" ]] \
  && pass "workflow usage_events have canonical team/secret/task attribution" \
  || fail "workflow usage_events with missing or invalid attribution: $BAD_EVENT_COUNT"

BAD_USER_EVENT_COUNT=$(pg_psql "WITH user_runs AS (
  SELECT DISTINCT run_id::text AS run_id, actor_id::text AS actor_id
    FROM workflow_runs
   WHERE actor_type='user'
     AND actor_id IS NOT NULL
  UNION
  SELECT DISTINCT run_id::text AS run_id, triggerer_user_id::text AS actor_id
    FROM workflow_runs_audit
   WHERE triggerer_actor_type='user'
     AND triggerer_user_id IS NOT NULL
)
SELECT COUNT(*)
  FROM usage_events e
  JOIN user_runs r ON r.run_id = split_part(e.task_id, ':', 1)
 WHERE e.source_kind='workflow'
   AND e.recipe_name LIKE ${RECIPE_LIKE_SQL}
   AND e.ts >= now() - make_interval(hours => ${LOOKBACK_HOURS})
   AND COALESCE(e.user_id, '') <> r.actor_id;" | tr -d ' \n')
[[ "$BAD_USER_EVENT_COUNT" == "0" ]] \
  && pass "user-triggered workflow usage_events carry workflow actor user_id" \
  || fail "user-triggered workflow usage_events with missing or mismatched user_id: $BAD_USER_EVENT_COUNT"

ROLLUP_REQUESTS=0
deadline=$((SECONDS + ROLLUP_WAIT_SECONDS))
while true; do
  ROLLUP_REQUESTS=$(pg_psql "SELECT COALESCE(SUM(request_count), 0)::bigint
    FROM usage_5min
   WHERE source_kind='workflow'
     AND recipe_name LIKE ${RECIPE_LIKE_SQL}
     AND bucket >= now() - make_interval(hours => ${LOOKBACK_HOURS});" | tr -d ' \n')
  if [[ "$ROLLUP_REQUESTS" -ge "$MIN_REQUESTS" || "$SECONDS" -ge "$deadline" ]]; then
    break
  fi
  sleep 5
done

[[ "$ROLLUP_REQUESTS" -ge "$MIN_REQUESTS" ]] \
  && pass "usage_5min rollup present ($ROLLUP_REQUESTS requests)" \
  || fail "usage_5min rollup did not materialize within ${ROLLUP_WAIT_SECONDS}s"

BAD_ROLLUP_COUNT=$(pg_psql "WITH bad AS (
  SELECT request_count FROM usage_5min
   WHERE source_kind='workflow'
     AND recipe_name LIKE ${RECIPE_LIKE_SQL}
     AND bucket >= now() - make_interval(hours => ${LOOKBACK_HOURS})
     AND (team_id IS NULL OR llm_secret_name IS NULL)
  UNION ALL
  SELECT request_count FROM usage_hourly
   WHERE source_kind='workflow'
     AND recipe_name LIKE ${RECIPE_LIKE_SQL}
     AND bucket >= now() - make_interval(hours => ${LOOKBACK_HOURS})
     AND (team_id IS NULL OR llm_secret_name IS NULL)
  UNION ALL
  SELECT request_count FROM usage_daily
   WHERE source_kind='workflow'
     AND recipe_name LIKE ${RECIPE_LIKE_SQL}
     AND bucket >= now() - make_interval(hours => ${LOOKBACK_HOURS})
     AND (team_id IS NULL OR llm_secret_name IS NULL)
)
SELECT COALESCE(SUM(request_count), 0)::bigint FROM bad;" | tr -d ' \n')
[[ "$BAD_ROLLUP_COUNT" == "0" ]] \
  && pass "workflow rollups have non-null Team and LLM Secret dimensions" \
  || fail "workflow rollup requests with null Team or LLM Secret: $BAD_ROLLUP_COUNT"

log "Workflow usage attribution sample:"
pg_psql "SELECT COALESCE(t.name, e.team_id) AS team, e.llm_secret_name, e.model, e.recipe_name, COUNT(*) AS requests
  FROM usage_events e
  LEFT JOIN teams t ON t.id::text = e.team_id
 WHERE e.source_kind='workflow'
   AND e.recipe_name LIKE ${RECIPE_LIKE_SQL}
   AND e.ts >= now() - make_interval(hours => ${LOOKBACK_HOURS})
 GROUP BY 1, 2, 3, 4
 ORDER BY requests DESC, team ASC, e.recipe_name ASC
 LIMIT 20;"

echo ""
pass "workflow usage attribution gate complete"
