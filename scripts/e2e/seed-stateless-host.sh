#!/usr/bin/env bash
# ======================================================================
# Seed — dedicated stateless Host for the stateless-agents E2E lane.
#
# Creates/updates the Host CR `chatllm-stateless` (override with
# E2E_STATELESS_HOST_REF) as a clone of the existing `chatllm` seed Host:
#   - spec.contextRef / spec.secretRef mirrored from the source Host
#   - spec.lifecycle.stateless: true
#   - spec.host renamed to the new CR name (Host CRD identity)
#   - spec.channels dropped: two Hosts polling the same Telegram channel
#     would double-deliver; the stateless lane drives turns via rpc-proxy.
#
# Unless STATELESS_SEED_SKIP_ASSOCIATION=1, associates the new agent to the E2E
# user through the control-api admin API as a UNION with existing agents. The
# isolated mode creates only the Host and does not require admin credentials.
#
# Idempotent: `kubectl apply` + union PUTs; safe to run on every deploy.
# NOTE: the base seed (seed-e2e-data.sh) PUTs {agentNames:[chatllm]} as a
# full-set replace, so this script must run AFTER it (seed-test-data.sh
# already orders them correctly).
#
# Requires: the base seed has run (user exists), the Host CRD on the
# cluster includes spec.lifecycle (fails loudly otherwise), kubectl + jq.
# ======================================================================
set -euo pipefail

CONTEXT="${CONTEXT:-$(kubectl config current-context)}"
KC="kubectl --context=${CONTEXT}"

STATELESS_HOST="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
SOURCE_HOST="${E2E_HOST_REF:-chatllm}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
CONTROL_API_NS="${CONTROL_API_NS:-control-plane}"
CONTROL_API_SVC="${CONTROL_API_SVC:-control-api}"
CONTROL_API_LOCAL_PORT="${STATELESS_SEED_CAPI_LOCAL_PORT:-18092}"
ASSOC_ATTEMPTS="${STATELESS_SEED_ASSOC_ATTEMPTS:-10}"
SKIP_ASSOCIATION="${STATELESS_SEED_SKIP_ASSOCIATION:-0}"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
log()  { echo -e "${CYAN}[seed-stateless]${NC} $*"; }
ok()   { echo -e "  ${GREEN}OK${NC} — $*"; }
warn() { echo -e "  ${YELLOW}WARN${NC} — $*"; }
die()  { echo -e "  ${RED}ERROR${NC} — $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || die "jq is required"

# ─── Safety guard — non-prod cluster allowlist (fail-closed) ──────────
case "$CONTEXT" in
  *_clerum|*-prod|*prod-*|*production*)
    die "REFUSING to seed against context '$CONTEXT' — matches prod pattern. This script is dev-only by design."
    ;;
esac

is_branch_scoped_minikube_context() {
  case "$CONTEXT" in
    clerum-codex-*|clerum-cursor-*|clerum-detached-*|clerum-pr-*)
      return 0
      ;;
  esac
  return 1
}

CONTEXT_OK=0
DEFAULT_ALLOWED_CONTEXTS=(
  "clerum-test"                                    # minikube
  "gke_your-gcp-project_us-central1-a_example-dev"  # GKE dev
)
IFS=',' read -r -a EXTRA_ALLOWED <<<"${ALLOWED_CONTEXTS:-}"
for allowed in "${DEFAULT_ALLOWED_CONTEXTS[@]}" "${EXTRA_ALLOWED[@]}"; do
  [ -z "$allowed" ] && continue
  if [ "$CONTEXT" = "$allowed" ]; then CONTEXT_OK=1; break; fi
done
if [ "$CONTEXT_OK" -ne 1 ] && is_branch_scoped_minikube_context; then
  CONTEXT_OK=1
fi
[ "$CONTEXT_OK" -eq 1 ] || die "Context '$CONTEXT' is not in the non-prod allowlist. Set ALLOWED_CONTEXTS=... to extend (never add prod)."
ok "Context '$CONTEXT' is in the non-prod allowlist"

# ─── Step 1: Clone the source Host CR with the stateless lifecycle ────
log "Cloning Host '${SOURCE_HOST}' → '${STATELESS_HOST}' (ns=${HOST_NS})"
SRC_JSON="$($KC get host "$SOURCE_HOST" -n "$HOST_NS" -o json 2>/dev/null)" \
  || die "source Host '${SOURCE_HOST}' not found in ${HOST_NS} — deploy CRD instances first (make minikube-deploy-instances)"

# The suspend/wake gate needs a deterministic approval-required native tool
# so it can park a turn in AwaitingApproval without mutating the shared chatllm seed.
NEW_JSON="$(echo "$SRC_JSON" | jq --arg name "$STATELESS_HOST" '{
  apiVersion,
  kind,
  metadata: { name: $name, namespace: .metadata.namespace },
  spec: ((.spec
    + { host: $name,
        lifecycle: ((.spec.lifecycle // {}) + { stateless: true }),
        approval: ((.spec.approval // {})
          + { tools: (((.spec.approval // {}).tools // {}) + { shell_exec: true }) }) })
    | del(.channels))
}')"

echo "$NEW_JSON" | $KC apply -f - >/dev/null \
  || die "kubectl apply of Host '${STATELESS_HOST}' failed"

if [ "$SKIP_ASSOCIATION" = "1" ]; then
  isolated_flag="$($KC get host "$STATELESS_HOST" -n "$HOST_NS" \
    -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")"
  [ "$isolated_flag" = "true" ] || die "isolated Host did not retain stateless lifecycle"
  ok "Host '${STATELESS_HOST}' created for isolated runtime validation"
  exit 0
fi

is_minikube_context() {
  case "$CONTEXT" in
    clerum-test) return 0 ;;
    *) is_branch_scoped_minikube_context ;;
  esac
}
if [ -z "$ADMIN_PASSWORD" ] && is_minikube_context; then
  ADMIN_PASSWORD="$(printf '%s%s' 'changeme123' '!')"
fi
[ -n "$ADMIN_PASSWORD" ] || die "ADMIN_PASSWORD is required"

applied_flag="$($KC get host "$STATELESS_HOST" -n "$HOST_NS" \
  -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")"
if [ "$applied_flag" != "true" ]; then
  die "Host '${STATELESS_HOST}' applied but spec.lifecycle.stateless is '${applied_flag:-<absent>}' — the cluster's Host CRD predates the stateless lifecycle (apply the updated clerum-crds chart first)"
fi
ok "Host '${STATELESS_HOST}' present with spec.lifecycle.stateless=true (contextRef=$(echo "$NEW_JSON" | jq -r '.spec.contextRef') secretRef=$(echo "$NEW_JSON" | jq -r '.spec.secretRef'))"

# ─── Step 2: control-api admin session ────────────────────────────────
CAPI_PF_PID=""
HEADER_FILE="$(mktemp "${TMPDIR:-/tmp}/seed-stateless-headers.XXXXXX")"
cleanup() {
  [ -n "$CAPI_PF_PID" ] && kill "$CAPI_PF_PID" >/dev/null 2>&1 || true
  rm -f "$HEADER_FILE" >/dev/null 2>&1 || true
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

log "Starting control-api port-forward (${CONTEXT})"
$KC -n "$CONTROL_API_NS" port-forward "svc/$CONTROL_API_SVC" \
  "$CONTROL_API_LOCAL_PORT:8090" >/dev/null 2>&1 &
CAPI_PF_PID=$!
wait_for_port "$CONTROL_API_LOCAL_PORT" \
  || die "port-forward to ${CONTROL_API_NS}/${CONTROL_API_SVC}:8090 did not come up"
CAPI_BASE="http://127.0.0.1:${CONTROL_API_LOCAL_PORT}/api/v1"

: > "$HEADER_FILE"
LOGIN_RESP="$(curl -sS -w '\n%{http_code}' -D "$HEADER_FILE" \
  -X POST "$CAPI_BASE/admin/auth/login" \
  -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" '{username: $u, password: $p}')" || true)"
LOGIN_CODE="$(echo "$LOGIN_RESP" | tail -n1)"
[[ "$LOGIN_CODE" =~ ^2 ]] || die "admin login failed (status=${LOGIN_CODE}) — run the base seed first (scripts/e2e/seed-e2e-data.sh bootstraps the admin)"

ADMIN_COOKIE=""
while IFS= read -r header; do
  header="${header%$'\r'}"
  case "$(printf '%s' "$header" | tr '[:upper:]' '[:lower:]')" in
    set-cookie:*)
      cookie="${header#*:}"
      cookie="${cookie#"${cookie%%[![:space:]]*}"}"
      case "$cookie" in
        control_ui_admin_session=*)
          ADMIN_COOKIE="${cookie#control_ui_admin_session=}"
          ADMIN_COOKIE="${ADMIN_COOKIE%%;*}"
          ;;
      esac
      ;;
  esac
done < "$HEADER_FILE"
[ -n "$ADMIN_COOKIE" ] || die "admin login did not return a control_ui_admin_session cookie"
ok "admin session obtained"

AUTH_HDR=(-H "Cookie: control_ui_admin_session=${ADMIN_COOKIE}" -H 'Content-Type: application/json')

admin_call() {
  # admin_call METHOD URL [BODY] → ADMIN_BODY on 2xx, dies otherwise.
  local method="$1" url="$2" body="${3:-}" resp code
  if [ -n "$body" ]; then
    resp="$(curl -sS -w '\n%{http_code}' -X "$method" "$url" "${AUTH_HDR[@]}" -d "$body" || true)"
  else
    resp="$(curl -sS -w '\n%{http_code}' -X "$method" "$url" "${AUTH_HDR[@]}" || true)"
  fi
  code="$(echo "$resp" | tail -n1)"
  ADMIN_BODY="$(echo "$resp" | sed '$d')"
  [[ "$code" =~ ^2 ]] || die "$method $url → $code body=$ADMIN_BODY"
}

# ─── Step 3: Associate the stateless agent to the E2E user (union) ────
log "Associating agent '${STATELESS_HOST}' to ${DEV_EMAIL} (union, preserves '${SOURCE_HOST}')"

admin_call GET "$CAPI_BASE/admin/users?$(jq -rn --arg q "$DEV_EMAIL" '$q|@uri' | sed 's/^/q=/')"
USER_ID="$(echo "$ADMIN_BODY" | jq -r --arg e "$DEV_EMAIL" \
  '.items[]? | select((.email // "") == $e) | .id' | head -n1)"
[ -n "$USER_ID" ] || die "E2E user ${DEV_EMAIL} not found — run the base seed first (scripts/e2e/seed-e2e-data.sh)"
ok "user ${DEV_EMAIL} (id=${USER_ID:0:8}…)"

associate_agents_union() {
  # associate_agents_union <GET/PUT base url> <label>
  # PUT /admin/.../agents filters names against the ACTIVE agent set, so a
  # just-applied Host CR can lag. Retry until the response echoes the new
  # agent back; die loudly if it never does (silent filtering is a failure).
  local url="$1" label="$2" attempt=1 union
  while :; do
    admin_call GET "$url"
    union="$(echo "$ADMIN_BODY" | jq -c --arg a "$STATELESS_HOST" \
      '((.agentNames // []) + [$a]) | unique')"
    admin_call PUT "$url" "$(jq -cn --argjson names "$union" '{agentNames: $names}')"
    if echo "$ADMIN_BODY" | jq -e --arg a "$STATELESS_HOST" \
        '(.agentNames // []) | index($a) != null' >/dev/null; then
      ok "$label now includes '${STATELESS_HOST}'"
      return 0
    fi
    if [ "$attempt" -ge "$ASSOC_ATTEMPTS" ]; then
      die "$label: control-api filtered out '${STATELESS_HOST}' after ${ASSOC_ATTEMPTS} attempts — the Host CR is not registering as an active agent (last agentNames: $(echo "$ADMIN_BODY" | jq -c '.agentNames // []'))"
    fi
    warn "$label: '${STATELESS_HOST}' not active yet (attempt ${attempt}/${ASSOC_ATTEMPTS}) — retrying in 3s"
    attempt=$((attempt + 1))
    sleep 3
  done
}

associate_agents_union "$CAPI_BASE/admin/users/$USER_ID/agents" "user agents"

admin_call GET "$CAPI_BASE/admin/users/$USER_ID/teams"
TEAM_ID="$(echo "$ADMIN_BODY" | jq -r '.items[0].id // empty')"
if [ -n "$TEAM_ID" ]; then
  associate_agents_union "$CAPI_BASE/admin/teams/$TEAM_ID/agents" "team agents"
else
  warn "user ${DEV_EMAIL} has no team — skipping team-level agent binding (base seed creates one; user-level binding above is sufficient for rpc access)"
fi

ok "stateless host seed complete: Host '${STATELESS_HOST}' + association for ${DEV_EMAIL}"
