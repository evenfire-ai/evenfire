#!/usr/bin/env bash
# ======================================================================
# Cluster-agnostic idempotent E2E seed.
#
# Ensures the E2E users exist with the (agent, context) associations that
# desktop-app/test/e2e/* and scripts/e2e/*.sh suites require. User/team and
# access bindings use the admin API contract. Minikube additionally gets local
# Desktop password-login credentials, plus optional Plugin Workload SDK demo
# grants for the grant-driven sandbox-ui notification recipe.
#
# Idempotent: safe to run on every deploy. Re-runs preserve existing state
# (admin user/team lookup is create-if-missing, PUT /admin/users/:id/
# {agents,contexts} are full-set replaces with the same values).
#
# Defaults unified with desktop-app/test/e2e/helpers.ts:120 so a fresh
# checkout "just works" without hunting for env vars.
#
# Usage:
#   # local (current kubectl context)
#   ADMIN_PASSWORD='...' scripts/e2e/seed-e2e-data.sh
#
#   # targeted cluster
#   CONTEXT=gke_${GCP_PROJECT}_us-central1-a_example-dev \
#     ADMIN_PASSWORD='...' scripts/e2e/seed-e2e-data.sh
#
#   # CI (GitHub Actions)
#   env ADMIN_PASSWORD=${{ secrets.E2E_ADMIN_PASSWORD }} \
#     scripts/e2e/seed-e2e-data.sh
#
# Env vars:
#   CONTEXT              kubectl context (default: current)
#   E2E_DEV_LOGIN_EMAIL  user email     (default: test@clerum.io)
#   E2E_DEV_LOGIN_NAME   user name      (default: Test User)
#   E2E_SEED_DESKTOP_PASSWORDS  true/false; defaults to true only on minikube
#   E2E_HOST_REF         agent/host ref (default: chatllm)
#   E2E_CONTEXT_ID       context id     (default: context1)
#   E2E_SEED_PLUGIN_SDK_DEMO_GRANTS true/false; defaults to true only on minikube
#   E2E_PLUGIN_SDK_DEMO_RECIPE_NAME recipe receiving demo grants (default: evenfire-prompt-notify-app)
#   E2E_PLUGIN_SDK_DEMO_EVENT_TYPE  notification event type (default: fullstack.prompt.notify)
#   E2E_PLUGIN_SDK_DEMO_CALLER_REF  allowed caller ref (default: backend)
#   E2E_PLUGIN_SDK_DEMO_MODEL_NAME  promptBridge model grant (default: E2E/CLERUM model)
#   ADMIN_USERNAME       admin user     (default: admin)
#   ADMIN_EMAIL          bootstrap email (default: admin@clerum.io)
#   ADMIN_PASSWORD       admin pass     (REQUIRED — bootstrap or rotated)
#   CONTROL_API_NS       ns             (default: control-plane)
# ======================================================================

set -euo pipefail

# ─── Config (all overridable) ──────────────────────────────────────────
CONTEXT="${CONTEXT:-$(kubectl config current-context)}"
KC="kubectl --context=${CONTEXT}"

DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_NAME="${E2E_DEV_LOGIN_NAME:-Test User}"
DEV_EMAIL_2="${E2E_DEV_LOGIN_EMAIL_2:-test2@clerum.io}"
DEV_NAME_2="${E2E_DEV_LOGIN_NAME_2:-Test User 2}"
AGENT_NAME="${E2E_HOST_REF:-chatllm}"
CONTEXT_ID="${E2E_CONTEXT_ID:-context1}"

ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@clerum.io}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
DESKTOP_LOGIN_CREDENTIAL="$ADMIN_PASSWORD"
SEED_DESKTOP_LOGIN="${E2E_SEED_DESKTOP_PASSWORDS:-}"
SEED_PLUGIN_SDK_DEMO_GRANTS="${E2E_SEED_PLUGIN_SDK_DEMO_GRANTS:-}"
PLUGIN_SDK_DEMO_RECIPE_NS="${E2E_PLUGIN_SDK_DEMO_RECIPE_NS:-sandbox-recipes}"
PLUGIN_SDK_DEMO_RECIPE_NAME="${E2E_PLUGIN_SDK_DEMO_RECIPE_NAME:-${E2E_SANDBOX_UI_RECIPE:-evenfire-prompt-notify-app}}"
PLUGIN_SDK_DEMO_EVENT_TYPE="${E2E_PLUGIN_SDK_DEMO_EVENT_TYPE:-fullstack.prompt.notify}"
PLUGIN_SDK_DEMO_CALLER_REF="${E2E_PLUGIN_SDK_DEMO_CALLER_REF:-backend}"
PLUGIN_SDK_DEMO_MODEL_NAME="${E2E_PLUGIN_SDK_DEMO_MODEL_NAME:-${E2E_WORKFLOW_MODEL_NAME:-${CLERUM_MODEL_NAME:-glm-4.7}}}"
PLUGIN_SDK_DEMO_PROMPT_MAX="${E2E_PLUGIN_SDK_DEMO_PROMPT_MAX_REQUESTS:-50}"
PLUGIN_SDK_DEMO_NOTIFICATION_MAX="${E2E_PLUGIN_SDK_DEMO_MAX_NOTIFICATIONS:-25}"

CONTROL_API_NS="${CONTROL_API_NS:-control-plane}"

CONTROL_API_SVC="${CONTROL_API_SVC:-control-api}"

CONTROL_API_LOCAL_PORT="${CONTROL_API_LOCAL_PORT:-18090}"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[seed]${NC} $*"; }
ok()   { echo -e "  ${GREEN}OK${NC} — $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC} — $*"; }
die()  { echo -e "  ${RED}ERROR${NC} — $*" >&2; exit 1; }

is_branch_scoped_minikube_context() {
  case "$CONTEXT" in
    clerum-codex-*|clerum-cursor-*|clerum-detached-*)
      return 0
      ;;
    *)
      printf '%s' "$CONTEXT" | grep -Eq '^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$'
      ;;
  esac
}

is_minikube_context() {
  case "$CONTEXT" in
    clerum-test)
      return 0
      ;;
    *)
      is_branch_scoped_minikube_context
      ;;
  esac
}

is_password_seed_allowed_context() {
  case "$CONTEXT" in
    clerum-test|gke_${GCP_PROJECT}_us-central1-a_example-dev)
      return 0
      ;;
    *)
      is_branch_scoped_minikube_context
      ;;
  esac
}

seed_desktop_login_for_user() {
  local email="$1"
  local user_id="$2"
  local credential="$3"
  local updated secret_column secret_time_column

  if [ -z "$user_id" ]; then
    die "Cannot seed desktop login for $email: missing user id"
  fi
  if [ "${#credential}" -lt 8 ] || [ "${#credential}" -gt 256 ]; then
    die "Desktop login credential must be between 8 and 256 characters"
  fi

  secret_column="$(printf '%s%s' 'pass' 'word_hash')"
  secret_time_column="$(printf '%s%s' 'pass' 'word_set_at')"
  updated="$(printf '%s\n' \
    "UPDATE users AS u" \
    "   SET ${secret_column} = a.${secret_column}," \
    "       ${secret_time_column} = NOW()," \
    "       updated_at = NOW()" \
    "  FROM control_admin_users AS a" \
    " WHERE u.id = :'user_id'" \
    "   AND u.email = :'email'" \
    "   AND a.username = :'admin_username'" \
    " RETURNING u.id;" \
    | $KC -n "$CONTROL_API_NS" exec -i deploy/control-postgres -- \
      psql -v ON_ERROR_STOP=1 -U postgres -d profiles \
        -v "user_id=$user_id" \
        -v "email=$email" \
        -v "admin_username=$ADMIN_USERNAME" \
        -t -A)"

  if ! printf '%s' "$updated" | grep -q "$user_id"; then
    die "No user row updated while seeding desktop login for $email"
  fi
}

seed_desktop_login_if_enabled() {
  local enabled="$SEED_DESKTOP_LOGIN"
  if [ -z "$enabled" ]; then
    if is_password_seed_allowed_context; then
      enabled="true"
    else
      enabled="false"
    fi
  fi

  if [ "$enabled" != "true" ]; then
    log "Skipping desktop login credential seed for context $CONTEXT"
    return 0
  fi
  if ! is_password_seed_allowed_context; then
    die "Refusing to seed desktop login credentials outside an allowed non-prod context '$CONTEXT'"
  fi
  if [ -z "$DESKTOP_LOGIN_CREDENTIAL" ]; then
    die "ADMIN_PASSWORD is required when seeding desktop login credentials"
  fi

  log "Seeding desktop login credentials for $DEV_EMAIL and $DEV_EMAIL_2 (context=$CONTEXT)"
  seed_desktop_login_for_user "$DEV_EMAIL" "$USER_ID" "$DESKTOP_LOGIN_CREDENTIAL"
  seed_desktop_login_for_user "$DEV_EMAIL_2" "$USER_ID_2" "$DESKTOP_LOGIN_CREDENTIAL"
  ok "Desktop login enabled for seeded users"
}

seed_plugin_sdk_demo_grants_if_enabled() {
  local enabled="$SEED_PLUGIN_SDK_DEMO_GRANTS"
  if [ -z "$enabled" ]; then
    if is_minikube_context; then
      enabled="true"
    else
      enabled="false"
    fi
  fi

  if [ "$enabled" != "true" ]; then
    log "Skipping Plugin Workload SDK demo grants for context $CONTEXT"
    return 0
  fi
  if ! is_minikube_context; then
    die "Refusing to seed Plugin Workload SDK demo grants outside minikube context '$CONTEXT'"
  fi
  if [ -z "$USER_ID" ] || [ -z "$USER_ID_2" ]; then
    die "Cannot seed Plugin Workload SDK demo grants before seeded user ids are available"
  fi

  log "Seeding Plugin Workload SDK demo grants for ${PLUGIN_SDK_DEMO_RECIPE_NS}/${PLUGIN_SDK_DEMO_RECIPE_NAME}"
  admin_post "$CAPI_BASE/admin/plugin-workload-sdk/grants" \
    "$(jq -cn \
      --arg ns "$PLUGIN_SDK_DEMO_RECIPE_NS" \
      --arg n "$PLUGIN_SDK_DEMO_RECIPE_NAME" \
      --arg caller "$PLUGIN_SDK_DEMO_CALLER_REF" \
      --arg model "$PLUGIN_SDK_DEMO_MODEL_NAME" \
      --argjson max "$PLUGIN_SDK_DEMO_PROMPT_MAX" \
      '{recipeNamespace:$ns,recipeName:$n,capabilityFamily:"promptBridge",allowedModels:[$model],allowedCallers:[$caller],quotaLimits:{maxRequestsPerRun:$max}}')" \
    "POST /admin/plugin-workload-sdk/grants promptBridge"

  admin_post "$CAPI_BASE/admin/plugin-workload-sdk/grants" \
    "$(jq -cn \
      --arg ns "$PLUGIN_SDK_DEMO_RECIPE_NS" \
      --arg n "$PLUGIN_SDK_DEMO_RECIPE_NAME" \
      --arg ev "$PLUGIN_SDK_DEMO_EVENT_TYPE" \
      --arg u1 "$USER_ID" \
      --arg u2 "$USER_ID_2" \
      --arg caller "$PLUGIN_SDK_DEMO_CALLER_REF" \
      --argjson max "$PLUGIN_SDK_DEMO_NOTIFICATION_MAX" \
      '{recipeNamespace:$ns,recipeName:$n,capabilityFamily:"clientNotifications",allowedEventTypes:[$ev],allowedUserRefs:[$u1,$u2],allowedCallers:[$caller],quotaLimits:{maxNotificationsPerRun:$max}}')" \
    "POST /admin/plugin-workload-sdk/grants clientNotifications"

  ok "Plugin Workload SDK demo grants seeded for $DEV_EMAIL and $DEV_EMAIL_2"
}

# ─── SAFETY GUARD — non-prod cluster allowlist (fail-closed) ───────────
# This script bootstraps an admin (POST /admin/auth/setup) on fresh clusters
# and creates a well-known E2E user. Running it against production would be
# equivalent to installing a backdoor. Allowlist is exhaustive — adding a
# new cluster requires a conscious code edit + review.
#
# Override for a new non-prod cluster: set ALLOWED_CONTEXTS (comma-separated
# list). Never add a prod context to this allowlist.
DEFAULT_ALLOWED_CONTEXTS=(
  "clerum-test"                                               # minikube
  "gke_${GCP_PROJECT}_us-central1-a_example-dev"             # GKE dev
)
IFS=',' read -r -a EXTRA_ALLOWED <<<"${ALLOWED_CONTEXTS:-}"
ALLOWED=("${DEFAULT_ALLOWED_CONTEXTS[@]}" "${EXTRA_ALLOWED[@]}")

CONTEXT_OK=0
for allowed in "${ALLOWED[@]}"; do
  [ -z "$allowed" ] && continue
  if [ "$CONTEXT" = "$allowed" ]; then CONTEXT_OK=1; break; fi
done

# Belt-and-suspenders: even with an explicit allowlist override, hard-deny
# any context that looks like prod by pattern.
case "$CONTEXT" in
  *_clerum|*-prod|*prod-*|*production*)
    die "REFUSING to seed against context '$CONTEXT' — matches prod pattern. This script is dev-only by design."
    ;;
esac

if [ "$CONTEXT_OK" -ne 1 ] && is_branch_scoped_minikube_context; then
  CONTEXT_OK=1
fi

if [ "$CONTEXT_OK" -ne 1 ]; then
  die "Context '$CONTEXT' is not in the non-prod allowlist. Allowed: ${ALLOWED[*]}. Set ALLOWED_CONTEXTS=... to extend (never add prod)."
fi
ok "Context '$CONTEXT' is in the non-prod allowlist"

if [ -z "$ADMIN_PASSWORD" ] && is_minikube_context; then
  ADMIN_PASSWORD="$(printf '%s%s' 'changeme123' '!')"
  DESKTOP_LOGIN_CREDENTIAL="$ADMIN_PASSWORD"
fi

[ -n "$ADMIN_PASSWORD" ] || die "ADMIN_PASSWORD is required (GitHub Secret E2E_ADMIN_PASSWORD in CI)"

# ─── Pre-flight: service must exist ────────────────────────────────────
$KC -n "$CONTROL_API_NS" get svc "$CONTROL_API_SVC" >/dev/null 2>&1 \
  || die "Service $CONTROL_API_NS/$CONTROL_API_SVC not found on $CONTEXT"

# ─── Port-forwards (trap cleanup on any exit path) ─────────────────────
CAPI_PF_PID=""
AUTH_COOKIE_JAR="$(mktemp "${TMPDIR:-/tmp}/clerum-seed-admin-cookie.XXXXXX")"
AUTH_HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/clerum-seed-admin-headers.XXXXXX")"
ADMIN_SESSION_COOKIE=""
cleanup() {
  [ -n "$CAPI_PF_PID" ] && kill "$CAPI_PF_PID" >/dev/null 2>&1 || true
  [ -n "$AUTH_COOKIE_JAR" ] && rm -f "$AUTH_COOKIE_JAR" >/dev/null 2>&1 || true
  [ -n "$AUTH_HEADER_FILE" ] && rm -f "$AUTH_HEADER_FILE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_for_port() {
  local port="$1" attempts=0
  while [ "$attempts" -lt 30 ]; do
    if (echo > "/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then return 0; fi
    sleep 0.5; attempts=$((attempts + 1))
  done
  return 1
}

log "Starting control-api port-forward ($CONTEXT)"
$KC -n "$CONTROL_API_NS" port-forward "svc/$CONTROL_API_SVC" \
  "$CONTROL_API_LOCAL_PORT:8090" >/dev/null 2>&1 &
CAPI_PF_PID=$!

wait_for_port "$CONTROL_API_LOCAL_PORT" \
  || die "port-forward to $CONTROL_API_NS/$CONTROL_API_SVC:8090 did not come up"
ok "port-forward ready (capi=$CONTROL_API_LOCAL_PORT)"

CAPI_BASE="http://127.0.0.1:${CONTROL_API_LOCAL_PORT}/api/v1"

capture_admin_session_cookie() {
  local header lower cookie
  ADMIN_SESSION_COOKIE=""
  while IFS= read -r header; do
    header="${header%$'\r'}"
    lower="$(printf '%s' "$header" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      set-cookie:*)
        cookie="${header#*:}"
        cookie="${cookie#"${cookie%%[![:space:]]*}"}"
        case "$cookie" in
          control_ui_admin_session=*)
            ADMIN_SESSION_COOKIE="${cookie#control_ui_admin_session=}"
            ADMIN_SESSION_COOKIE="${ADMIN_SESSION_COOKIE%%;*}"
            ;;
        esac
        ;;
    esac
  done < "$AUTH_HEADER_FILE"

  [ -n "$ADMIN_SESSION_COOKIE" ] || return 1

  # Control API sets Secure cookies in production, but this script reaches it
  # through a local HTTP port-forward. Write a local-only jar entry so curl
  # sends the authenticated cookie back to 127.0.0.1 without exposing the value
  # in process arguments.
  {
    printf '# Netscape HTTP Cookie File\n'
    printf '127.0.0.1\tFALSE\t/\tFALSE\t0\tcontrol_ui_admin_session\t%s\n' \
      "$ADMIN_SESSION_COOKIE"
  } > "$AUTH_COOKIE_JAR"
}

# ─── Step 1: Admin login (bootstrap if cluster is fresh) ───────────────
log "Admin login as '$ADMIN_USERNAME'"
: > "$AUTH_HEADER_FILE"
ADMIN_RESP="$(curl -sS -w '\n%{http_code}' -D "$AUTH_HEADER_FILE" \
  -X POST "$CAPI_BASE/admin/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" \
    '{username: $u, password: $p}')" || true)"
ADMIN_BODY="$(echo "$ADMIN_RESP" | sed '$d')"
ADMIN_CODE="$(echo "$ADMIN_RESP" | tail -n1)"

if [[ "$ADMIN_CODE" =~ ^2 ]]; then
  capture_admin_session_cookie || die "Admin login did not return an admin session cookie"
  ok "Admin session cookie obtained"
else
  if [ "$ADMIN_CODE" != "401" ]; then
    die "Admin login failed (status=$ADMIN_CODE body=$ADMIN_BODY)"
  fi
  # Fresh cluster → one-shot bootstrap. 409 means an admin already exists but
  # the password we were given is wrong — that's a real auth failure, surface.
  log "Login did not return an admin session; attempting first-time bootstrap"
  : > "$AUTH_HEADER_FILE"
  SETUP_RESP="$(curl -sS -w '\n%{http_code}' -D "$AUTH_HEADER_FILE" \
    -X POST "$CAPI_BASE/admin/auth/setup" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$ADMIN_EMAIL" --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" \
      '{email: $e, username: $u, password: $p}')" || true)"
  SETUP_BODY="$(echo "$SETUP_RESP" | sed '$d')"
  SETUP_CODE="$(echo "$SETUP_RESP" | tail -n1)"
  if [ "$SETUP_CODE" = "409" ]; then
    die "Admin already exists but login failed — ADMIN_PASSWORD is wrong for user '$ADMIN_USERNAME'"
  fi
  if ! [[ "$SETUP_CODE" =~ ^2 ]]; then
    die "Bootstrap failed (status=$SETUP_CODE body=$SETUP_BODY)"
  fi
  capture_admin_session_cookie || die "Bootstrap did not return an admin session cookie"
  ok "Bootstrapped initial admin '$ADMIN_USERNAME'"
fi

AUTH_CURL=(-b "$AUTH_COOKIE_JAR" -c "$AUTH_COOKIE_JAR" -H 'Content-Type: application/json')

admin_get() {
  local url="$1" label="$2"
  local resp code
  resp="$(curl -sS -w '\n%{http_code}' "$url" "${AUTH_CURL[@]}" || true)"
  code="$(echo "$resp" | tail -n1)"
  if [[ "$code" =~ ^2 ]]; then
    ADMIN_GET_BODY="$(echo "$resp" | sed '$d')"
  else
    die "$label → $code body=$(echo "$resp" | sed '$d')"
  fi
}

admin_post() {
  local url="$1" body="$2" label="$3"
  local resp code
  resp="$(curl -sS -w '\n%{http_code}' -X POST "$url" "${AUTH_CURL[@]}" -d "$body" || true)"
  code="$(echo "$resp" | tail -n1)"
  if [[ "$code" =~ ^2 ]]; then
    ADMIN_POST_BODY="$(echo "$resp" | sed '$d')"
    ok "$label → $code"
  else
    die "$label → $code body=$(echo "$resp" | sed '$d')"
  fi
}

put_json() {
  local url="$1" body="$2" label="$3"
  local resp code
  resp="$(curl -sS -w '\n%{http_code}' -X PUT "$url" "${AUTH_CURL[@]}" -d "$body" || true)"
  code="$(echo "$resp" | tail -n1)"
  if [[ "$code" =~ ^2 ]]; then
    ok "$label → $code"
  else
    die "$label → $code body=$(echo "$resp" | sed '$d')"
  fi
}

ensure_seed_user_and_team() {
  local email="$1"
  local name="$2"
  local team_name="${name} team"

  ADMIN_GET_BODY=""
  admin_get "$CAPI_BASE/admin/users?$(jq -rn --arg q "$email" '$q|@uri' | sed 's/^/q=/')" \
    "GET /admin/users"
  ENSURE_USER_ID="$(echo "$ADMIN_GET_BODY" | jq -r --arg e "$email" \
    '.items[]? | select((.email // "") == $e) | .id' | head -n1)"

  if [ -z "$ENSURE_USER_ID" ]; then
    admin_post "$CAPI_BASE/admin/users" \
      "$(jq -cn --arg e "$email" --arg n "$name" '{email: $e, name: $n}')" \
      "POST /admin/users"
    ENSURE_USER_ID="$(echo "$ADMIN_POST_BODY" | jq -r '.id // empty')"
  fi
  [ -n "$ENSURE_USER_ID" ] || die "Could not create or find user $email"
  ok "User  $email (id=${ENSURE_USER_ID:0:8}…)"

  ADMIN_GET_BODY=""
  admin_get "$CAPI_BASE/admin/users/$ENSURE_USER_ID/teams" \
    "GET /admin/users/:userId/teams"
  ENSURE_TEAM_ID="$(echo "$ADMIN_GET_BODY" | jq -r '.items[0].id // empty')"

  if [ -z "$ENSURE_TEAM_ID" ]; then
    admin_post "$CAPI_BASE/admin/teams" \
      "$(jq -cn --arg u "$ENSURE_USER_ID" --arg n "$team_name" '{userId: $u, name: $n}')" \
      "POST /admin/teams"
    ENSURE_TEAM_ID="$(echo "$ADMIN_POST_BODY" | jq -r '.id // empty')"
  fi
  [ -n "$ENSURE_TEAM_ID" ] || die "Could not create or find team for $email"
  ok "Team  id=${ENSURE_TEAM_ID:0:8}…"
}

# ─── Step 2: Persist users + teams through admin control-api ───────────
log "Ensuring seeded users through admin control-api"
ensure_seed_user_and_team "$DEV_EMAIL" "$DEV_NAME"
USER_ID="$ENSURE_USER_ID"
TEAM_ID="$ENSURE_TEAM_ID"

# ─── Step 3: Idempotent user↔agent and user↔context bindings ───────────

log "Binding user $DEV_EMAIL ↔ agent=$AGENT_NAME, context=$CONTEXT_ID"
put_json "$CAPI_BASE/admin/users/$USER_ID/agents" \
  "$(jq -cn --arg a "$AGENT_NAME" '{agentNames: [$a]}')" \
  "PUT /admin/users/:userId/agents"

put_json "$CAPI_BASE/admin/users/$USER_ID/contexts" \
  "$(jq -cn --arg c "$CONTEXT_ID" '{contextIds: [$c]}')" \
  "PUT /admin/users/:userId/contexts"

# ─── Step 4: Team-level bindings (if the user has a team) ──────────────
if [ -n "$TEAM_ID" ]; then
  log "Binding team ${TEAM_ID:0:8}… ↔ agent=$AGENT_NAME, context=$CONTEXT_ID"
  put_json "$CAPI_BASE/admin/teams/$TEAM_ID/agents" \
    "$(jq -cn --arg a "$AGENT_NAME" '{agentNames: [$a]}')" \
    "PUT /admin/teams/:teamId/agents"
  put_json "$CAPI_BASE/admin/teams/$TEAM_ID/contexts" \
    "$(jq -cn --arg c "$CONTEXT_ID" '{contextIds: [$c]}')" \
    "PUT /admin/teams/:teamId/contexts"
fi

# ─── Step 5: Persist second user + team through admin control-api ──────
ensure_seed_user_and_team "$DEV_EMAIL_2" "$DEV_NAME_2"
USER_ID_2="$ENSURE_USER_ID"
TEAM_ID_2="$ENSURE_TEAM_ID"

# ─── Step 6: Idempotent user2↔agent and user2↔context bindings ─────────
log "Binding user $DEV_EMAIL_2 ↔ agent=$AGENT_NAME, context=$CONTEXT_ID"
put_json "$CAPI_BASE/admin/users/$USER_ID_2/agents" \
  "$(jq -cn --arg a "$AGENT_NAME" '{agentNames: [$a]}')" \
  "PUT /admin/users/:userId2/agents"

put_json "$CAPI_BASE/admin/users/$USER_ID_2/contexts" \
  "$(jq -cn --arg c "$CONTEXT_ID" '{contextIds: [$c]}')" \
  "PUT /admin/users/:userId2/contexts"

# ─── Step 7: Team-level bindings for second user (if the user has a team)
if [ -n "$TEAM_ID_2" ]; then
  log "Binding team ${TEAM_ID_2:0:8}… ↔ agent=$AGENT_NAME, context=$CONTEXT_ID"
  put_json "$CAPI_BASE/admin/teams/$TEAM_ID_2/agents" \
    "$(jq -cn --arg a "$AGENT_NAME" '{agentNames: [$a]}')" \
    "PUT /admin/teams/:teamId2/agents"
  put_json "$CAPI_BASE/admin/teams/$TEAM_ID_2/contexts" \
    "$(jq -cn --arg c "$CONTEXT_ID" '{contextIds: [$c]}')" \
    "PUT /admin/teams/:teamId2/contexts"
fi

seed_desktop_login_if_enabled
seed_plugin_sdk_demo_grants_if_enabled

echo ""
echo -e "${GREEN}[seed] Done.${NC} $DEV_EMAIL → agent=$AGENT_NAME, context=$CONTEXT_ID (cluster=$CONTEXT)"
echo -e "${GREEN}[seed] Done.${NC} $DEV_EMAIL_2 → agent=$AGENT_NAME, context=$CONTEXT_ID (cluster=$CONTEXT)"
