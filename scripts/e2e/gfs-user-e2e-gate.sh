#!/usr/bin/env bash
# Authenticated end-user GFS gate. It fails loud, uses no mocks, and must run
# only after deploy sync plus seed-test-data.sh on an allowed local profile.
# Proves singular delegation compatibility and atomic bulk grant/share behavior.
set -euo pipefail
CONTEXT="${CONTEXT:?set CONTEXT to an allowed branch/clerum-test profile (never a prod context)}"
GFS_NS="${GFS_NS:-gfs}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
PROFILES_NS="${PROFILES_NS:-profiles}"
GFS_NAME="${GFS_NAME:-gfs}"
GFSC_PORT="${GFSC_PORT:-8087}"
CONTROL_API_PORT="${CONTROL_API_PORT:-8090}"
EXT_PORT="${EXT_PORT:-8091}"
DRIVE="${DRIVE:-main}"
TIMEOUT="${TIMEOUT:-180}"
TEST_USER_EMAIL="${TEST_USER_EMAIL:-test@clerum.io}"
TEST_USER_PASSWORD="${TEST_USER_PASSWORD:-changeme123!}"
TAG="${GFS_E2E_TAG:-$(kubectl --context="$CONTEXT" -n "$CONTROL_NS" get ns "$CONTROL_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null | cut -c1-8 || echo run)}"
RUN_NONCE="${GFS_E2E_NONCE:-$(date +%s)}"
RUN_SUFFIX="$(printf '%s' "${TAG}-${RUN_NONCE}-$$" | shasum -a 256 | cut -c1-10)"
SCRATCH_NAME="user-scratch-e2e-${TAG}-${RUN_SUFFIX}"
DELEGATE_USER_ID="${GFS_E2E_DELEGATE_ID:-00000000-0000-4000-8000-$(printf '%012d' "$((RUN_NONCE % 1000000000000))")}"
SCRATCH_RID=""
CREATED_SCRATCH=0
USER_TEAM_ID=""
CREATED_TEAM=0
kc() { kubectl --context="$CONTEXT" "$@"; }
pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); }
die() {
  echo "FATAL: $1" >&2
  echo "--- gfs namespace pods ---" >&2
  kc -n "$GFS_NS" get pods -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo "--- profiles namespace pods ---" >&2
  kc -n "$PROFILES_NS" get pods -o wide 2>&1 | sed 's/^/  /' >&2 || true
  exit 1
}
wait_ready() {
  local ns="$1" sel="$2" deadline=$((SECONDS + TIMEOUT))
  while ((SECONDS < deadline)); do
    if kc -n "$ns" get pods -l "$sel" \
      -o 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null \
      | grep -q 'True'; then
      return 0
    fi
    sleep 3
  done
  die "no Ready pod for '$sel' in ns '$ns' within ${TIMEOUT}s"
}
ready_pod() {
  kc -n "$1" get pods -l "$2" --field-selector=status.phase=Running \
    -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
    | awk -F'\t' '$2=="True"{print $1; exit}'
}
echo "== gfs USER-delegation E2E gate (context=$CONTEXT) =="
case "$CONTEXT" in
  *prod*) die "CONTEXT '$CONTEXT' looks like production — refusing" ;;
esac
if [[ "$CONTEXT" == "clerum-test" || "$CONTEXT" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]; then
  :
else
  die "CONTEXT '$CONTEXT' is not an allowed local/branch profile for this gate"
fi
phase="$(kc -n "$GFS_NS" get globalfilesystem "$GFS_NAME" -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
[[ "$phase" == "Ready" ]] && ok "GlobalFileSystem phase=Ready" || bad "GlobalFileSystem phase='$phase' (want Ready)"
wait_ready "$GFS_NS" "app=gfs-controller" && ok "gfsc pod Ready"
wait_ready "$PROFILES_NS" "app=external-rest-api" && ok "external-rest-api pod Ready"
GFSC_POD="$(ready_pod "$GFS_NS" "app=gfs-controller,clerum.io/gfsc-role=writer")"
[[ -n "$GFSC_POD" ]] || die "no Ready gfsc WRITER pod"
CONTROL_POD="$(ready_pod "$CONTROL_NS" "app=control-api")"
[[ -n "$CONTROL_POD" ]] || CONTROL_POD="$(ready_pod "$CONTROL_NS" "app.kubernetes.io/name=control-api")"
[[ -n "$CONTROL_POD" ]] || die "no Ready control-api pod"
EXT_POD="$(ready_pod "$PROFILES_NS" "app=external-rest-api")"
[[ -n "$EXT_POD" ]] || die "no Ready external-rest-api pod"
http_status() { printf '%s' "$1" | cut -f1; }
http_body() { printf '%s' "$1" | cut -f2-; }
admin_http() {
  kc -n "$CONTROL_NS" exec "$CONTROL_POD" -- node -e '
    const [method, path, token, body] = process.argv.slice(1)
    fetch("http://localhost:'"$CONTROL_API_PORT"'" + path, {
      method,
      headers: { Cookie: "control_ui_admin_session=" + token, "Content-Type": "application/json" },
      body: body || undefined,
    }).then(async r => { process.stdout.write(r.status + "\t" + await r.text()) })
      .catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$1" "$2" "$E2E_ADMIN_TOKEN" "${3:-}"
}
ic_http() {
  kc -n "$CONTROL_NS" exec "$CONTROL_POD" -- node -e '
    const jwt = require("jsonwebtoken")
    const secret = process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
    if (!secret) { process.stderr.write("INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET not set"); process.exit(2) }
    const [method, path, body] = process.argv.slice(1)
    const ic = jwt.sign({ sub: "gfs-user-e2e", jti: "gfs-user-e2e-" + process.pid + "-" + process.hrtime.bigint() }, secret,
      { algorithm: "HS256", issuer: "hcc", audience: "control-api", expiresIn: 300 })
    fetch("http://localhost:'"$CONTROL_API_PORT"'" + path, {
      method,
      headers: { Authorization: "Bearer " + ic, "Content-Type": "application/json" },
      body: body || undefined,
    }).then(async r => { process.stdout.write(r.status + "\t" + await r.text()) })
      .catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$1" "$2" "${3:-}"
}
user_login() {
  kc -n "$PROFILES_NS" exec "$EXT_POD" -- node -e '
    const [email, password] = process.argv.slice(1)
    fetch("http://localhost:'"$EXT_PORT"'/api/v1/auth/password-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).then(async r => { process.stdout.write(r.status + "\t" + await r.text()) })
      .catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$1" "$2"
}
user_http() {
  kc -n "$PROFILES_NS" exec "$EXT_POD" -- node -e '
    const [token, method, path, body] = process.argv.slice(1)
    fetch("http://localhost:'"$EXT_PORT"'" + path, {
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: body || undefined,
    }).then(async r => { process.stdout.write(r.status + "\t" + await r.text()) })
      .catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$1" "$2" "$3" "${4:-}"
}
psql_one() {
  kc -n "$CONTROL_NS" exec deploy/control-postgres -- \
    psql -v ON_ERROR_STOP=1 -U postgres -d profiles -tA -c "$1" 2>/dev/null | tr -d '[:space:]'
}
fixture_uuid() { printf '00000000-0000-4000-8000-%s' "$(printf '%s' "${SCRATCH_NAME}-$1" | shasum -a 256 | cut -c1-12)"; }
stored_subject_count() { psql_one "SELECT count(*) FROM $1 WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID' AND (subject_type || ':' || subject_id) IN ($2);"; }
assert_bulk_success() {
  local label="$1" response="$2" expected="$3" status body
  status="$(http_status "$response")"
  body="$(http_body "$response")"
  if [[ "$status" =~ ^20 ]] && jq -e --arg rid "$SCRATCH_RID" --argjson expected "$expected" \
    '.ok == true and .resourceId == $rid and .count == ($expected|length) and [(.updated[]|{type,id})] == $expected' >/dev/null <<<"$body"; then
    ok "$label returned ordered updated subjects and count"
  else die "$label response contract failed (status=$status body=$body)"; fi
}
assert_correlated_audit() {
  local label="$1" subjects_sql="$2" expected_count="$3" op_prefix="${4:-grant.put}" summary
  summary="$(psql_one "SELECT count(*) || '|' || count(DISTINCT subject) || '|' || count(DISTINCT request_id) || '|' || count(*) FILTER (WHERE request_id IS NULL) FROM gfs_audit WHERE gfs_uri='gfs://$DRIVE/$SCRATCH_RID' AND outcome='allowed' AND op LIKE '$op_prefix%' AND subject IN ($subjects_sql);")"
  if [[ "$summary" == "$expected_count|$expected_count|1|0" ]]; then ok "$label wrote one correlated audit row per target"
  else bad "$label audit summary='$summary' (want $expected_count|$expected_count|1|0)"; fi
}
assert_rejected_atomic() {
  local table="$1" label="$2" response="$3" subjects_sql="$4" status code
  status="$(http_status "$response")"; code="$(http_body "$response" | jq -r '.error // empty')"
  if [[ "$status" == "400" && "$code" == "subjects_invalid" ]]; then ok "$label rejected the complete batch"
  else bad "$label expected 400 subjects_invalid: $response"; fi
  if [[ "$(stored_subject_count "$table" "$subjects_sql")" == "0" ]]; then ok "$label wrote no partial rows"
  else bad "$label persisted a partial row"; fi
}
assert_denied_atomic() {
  local label="$1" response="$2" subjects_sql="$3" expected="$4" status code summary
  status="$(http_status "$response")"; code="$(http_body "$response" | jq -r '.error // empty')"
  if [[ "$status" == "403" && "$code" == "escalation_rejected" ]]; then ok "$label returned exact escalation_rejected"
  else bad "$label expected 403 escalation_rejected: $response"; fi
  if [[ "$(stored_subject_count gfs_grants "$subjects_sql")" == "0" ]]; then ok "$label wrote no grant rows"
  else bad "$label persisted a denied grant"; fi
  summary="$(psql_one "SELECT count(*) || '|' || count(DISTINCT a.subject) || '|' || count(DISTINCT a.request_id) || '|' || count(e.event_id) FROM gfs_audit a LEFT JOIN administrative_events e ON e.source_audit_ref=('gfs_audit:' || a.sequence_no::text) AND e.request_id=a.request_id AND e.action='permission_grant' AND e.outcome='rejected' AND e.authorization_decision='deny' WHERE a.gfs_uri='gfs://$DRIVE/$SCRATCH_RID' AND a.outcome='denied' AND a.subject IN ($subjects_sql);")"
  if [[ "$summary" == "$expected|$expected|1|$expected" ]]; then ok "$label wrote correlated denial audit/events per target"
  else bad "$label denial evidence='$summary' (want $expected|$expected|1|$expected)"; fi
}
cleanup() {
  local exit_status=$?
  trap - EXIT
  if [[ "$CREATED_TEAM" == "1" && -n "$USER_TEAM_ID" ]]; then
    kc -n "$CONTROL_NS" exec deploy/control-postgres -- psql -v ON_ERROR_STOP=1 -U postgres -d profiles \
      -c "DELETE FROM team_members WHERE team_id='$USER_TEAM_ID'::uuid; DELETE FROM teams WHERE id='$USER_TEAM_ID'::uuid AND name='e2e-gfs-issue792-$RUN_SUFFIX';" \
      >/dev/null 2>&1 || echo "WARN: cleanup failed for owned E2E team $USER_TEAM_ID" >&2
  fi
  if [[ "$CREATED_SCRATCH" == "1" && -n "$SCRATCH_RID" ]]; then
    kc -n "$CONTROL_NS" exec deploy/control-postgres -- psql -v ON_ERROR_STOP=1 -U postgres -d profiles \
      -c "DELETE FROM gfs_shares WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID'; DELETE FROM gfs_grants WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID'; DELETE FROM gfs_resources WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID';" \
      >/dev/null 2>&1 || echo "WARN: cleanup failed for owned scratch resource $SCRATCH_RID" >&2
  fi
  exit "$exit_status"
}
trap cleanup EXIT
CONTROL_ADMIN_USER="${CONTROL_ADMIN_USER:-admin}"
operator_admin_password() {
  if [[ -n "${E2E_ADMIN_PASSWORD:-}" ]]; then printf '%s' "$E2E_ADMIN_PASSWORD"; return 0; fi
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then printf '%s' "$ADMIN_PASSWORD"; return 0; fi
  if [[ -n "${ADMIN_PASS:-}" ]]; then printf '%s' "$ADMIN_PASS"; return 0; fi
  if [[ -n "${TEST_ADMIN_PASSWORD:-}" ]]; then printf '%s' "$TEST_ADMIN_PASSWORD"; return 0; fi
  if [[ "$CONTEXT" == "clerum-test" || "$CONTEXT" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]; then
    printf '%s%s' 'changeme123' '!'
    return 0
  fi
  return 1
}
ensure_operator_session() {
  if [[ -n "${E2E_ADMIN_TOKEN:-}" ]]; then
    return 0
  fi
  local admin_password login_payload login_resp login_status login_body session_cookie
  admin_password="$(operator_admin_password)" || die "operator admin credential is required to acquire the Control UI session"
  login_payload="$(jq -cn --arg u "$CONTROL_ADMIN_USER" --arg p "$admin_password" '{username:$u,password:$p}')"
  login_resp="$(kc -n "$CONTROL_NS" exec -i "$CONTROL_POD" -- node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", chunk => { input += chunk })
    process.stdin.on("end", async () => {
      try {
        const payload = JSON.parse(input)
        const response = await fetch("http://localhost:'"$CONTROL_API_PORT"'/api/v1/admin/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const cookies = typeof response.headers.getSetCookie === "function"
          ? response.headers.getSetCookie()
          : [response.headers.get("set-cookie")].filter(Boolean)
        const raw = cookies.map(String).find(cookie => cookie.startsWith("control_ui_admin_session=")) || ""
        const value = raw ? raw.split(";")[0].split("=").slice(1).join("=") : ""
        process.stdout.write(response.status + "\t" + value + "\t" + await response.text())
      } catch (error) {
        process.stderr.write(error.message)
        process.exit(1)
      }
    })
  ' <<<"$login_payload")"
  login_status="$(http_status "$login_resp")"
  session_cookie="$(printf '%s' "$login_resp" | cut -f2)"
  login_body="$(printf '%s' "$login_resp" | cut -f3-)"
  [[ "$login_status" == "200" && -n "$session_cookie" ]] || die "operator admin login failed (status=$login_status body=$login_body)"
  export E2E_ADMIN_TOKEN="$session_cookie"
  ok "operator session obtained through seeded admin login"
}
ensure_operator_session
resp="$(ic_http POST /api/v1/gfs/seed "{\"drive\":\"$DRIVE\",\"rootDirectories\":[\"/$SCRATCH_NAME\"]}")"
case "$(http_status "$resp")" in
  200 | 201) CREATED_SCRATCH=1; ok "unique scratch root seeded (/$SCRATCH_NAME)" ;;
  409) die "unique scratch root unexpectedly existed before this run (/$SCRATCH_NAME)" ;;
  *) die "seed /$SCRATCH_NAME failed: $resp" ;;
esac
SCRATCH_RID="$(psql_one "SELECT resource_id FROM gfs_resources WHERE drive='$DRIVE' AND name='$SCRATCH_NAME' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;")"
[[ -n "$SCRATCH_RID" ]] && ok "resolved scratch rid ($SCRATCH_RID)" || die "scratch dir not found after seed"
USER_ID="$(psql_one "SELECT id FROM users WHERE lower(email)=lower('$TEST_USER_EMAIL') LIMIT 1;")"
[[ -n "$USER_ID" ]] && ok "resolved test user id ($USER_ID)" \
  || die "test user '$TEST_USER_EMAIL' not found — run scripts/minikube/seed-test-data.sh first"
USER_TEAM_ID="$(fixture_uuid authority-team)"
kc -n "$CONTROL_NS" exec deploy/control-postgres -- psql -v ON_ERROR_STOP=1 -U postgres -d profiles \
  -c "INSERT INTO teams (id, name) VALUES ('$USER_TEAM_ID'::uuid, 'e2e-gfs-issue792-$RUN_SUFFIX'); INSERT INTO team_members (team_id, user_id, role, status) VALUES ('$USER_TEAM_ID'::uuid, '$USER_ID'::uuid, 'member', 'active');" >/dev/null
CREATED_TEAM=1
[[ "$(psql_one "SELECT count(*) FROM team_members WHERE team_id='$USER_TEAM_ID' AND user_id='$USER_ID' AND status='active';")" == "1" ]] \
  && ok "seeded isolated active team membership ($USER_TEAM_ID)" || die "failed to seed isolated active team membership"
authority_subjects="$(jq -cn --arg u "$USER_ID" --arg t "$USER_TEAM_ID" '[{type:"user",id:$u},{type:"team",id:$t}]')"
authority_keys="'user:$USER_ID','team:$USER_TEAM_ID'"
grant_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --argjson s "$authority_subjects" \
  '{drive:$d, resourceId:$r, subjects:$s, permissions:["manage_acl","share","read","write"], inherit:true}')"
resp="$(admin_http PUT /api/v1/gfs/grants "$grant_body")"
assert_bulk_success "real user/team authority bulk grant" "$resp" "$authority_subjects"
[[ "$(stored_subject_count gfs_grants "$authority_keys")" == "2" ]] && ok "bulk authority stored real direct-user and active-team targets" || die "real user/team authority rows missing"
resp="$(user_login "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")"
[[ "$(http_status "$resp")" == "200" ]] || die "user password-login failed: $resp"
USER_TOKEN="$(http_body "$resp" | jq -r '.token')"
[[ -n "$USER_TOKEN" && "$USER_TOKEN" != "null" ]] && ok "user logged in (session token)" \
  || die "no bearer token in login response (in-pod exposure gate?): $resp"
resp="$(user_http "$USER_TOKEN" POST /api/v1/me/gfs/token '{"scopes":["gfs.read"]}')"
[[ "$(http_status "$resp")" == "200" ]] || die "user /me/gfs/token mint failed: $resp"
[[ -n "$(http_body "$resp" | jq -r '.token // empty')" ]] && ok "user minted a gfs token (/me/gfs/token)" \
  || die "no token in user mint: $resp"
resp="$(user_http "$USER_TOKEN" GET "/api/v1/me/gfs/resources/$SCRATCH_RID/children?drive=$DRIVE")"
[[ "$(http_status "$resp")" == "200" ]] && ok "user listed the granted folder (/me/gfs/.../children)" \
  || bad "user children listing failed (granted read not honored?): $resp"
resp="$(user_http "$USER_TOKEN" GET "/api/v1/me/gfs/resources/$SCRATCH_RID/affordances?drive=$DRIVE")"
if [[ "$(http_status "$resp")" == "200" ]]; then
  held="$(http_body "$resp" | jq -r '.held | sort | join(",")')"
  isop="$(http_body "$resp" | jq -r '.isOperator')"
  [[ "$held" == "manage_acl,read,share,write" && "$isop" == "false" ]] \
    && ok "direct user plus active-team membership expose only requested bulk authority" \
    || bad "unexpected affordances held='$held' isOperator='$isop': $resp"
else
  bad "user affordances failed: $resp"
fi
deleg_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg id "$DELEGATE_USER_ID" \
  '{drive:$d, resourceId:$r, subject:{type:"user", id:$id}, permissions:["read"], inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$deleg_body")"
[[ "$(http_status "$resp")" =~ ^20 ]] && ok "user delegated read to a 2nd subject (200)" \
  || die "user delegation failed: $resp"
gb="$(psql_one "SELECT granted_by FROM gfs_grants WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID' AND subject_type='user' AND subject_id='$DELEGATE_USER_ID' ORDER BY updated_at DESC LIMIT 1;")"
[[ "$gb" == "user:$USER_ID" ]] && ok "delegation recorded with granted_by=user:<id> (caller path)" \
  || bad "expected granted_by='user:$USER_ID', got '$gb'"
BULK_USER_ID="$(fixture_uuid grant-user)"; BULK_TEAM_ID="$(fixture_uuid grant-team)"; REJECT_USER_ID="$(fixture_uuid reject-user)"
FIRST_HOST="1st:mcp-host/bulk-${RUN_SUFFIX}"; THIRD_HOST="3rd:sandbox-recipes/bulk-${RUN_SUFFIX}"
grant_subjects="$(jq -cn --arg u "$BULK_USER_ID" --arg t "$BULK_TEAM_ID" --arg h1 "$FIRST_HOST" --arg h3 "$THIRD_HOST" '[{type:"user",id:$u},{type:"team",id:$t},{type:"host",id:$h1},{type:"host",id:$h3}]')"
grant_keys="'user:$BULK_USER_ID','team:$BULK_TEAM_ID','host:$FIRST_HOST','host:$THIRD_HOST'"
bulk_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --argjson s "$grant_subjects" '{drive:$d,resourceId:$r,subjects:$s,permissions:["read","write"],inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$bulk_body")"
assert_bulk_success "mixed bulk grant" "$resp" "$grant_subjects"
if [[ "$(stored_subject_count gfs_grants "$grant_keys")" == "4" ]]; then ok "mixed bulk grant stored all targets"
else bad "mixed bulk grant did not store exactly four targets"; fi
assert_correlated_audit "mixed bulk grant" "$grant_keys" 4
HOST_READ="1st:mcp-host/read-${RUN_SUFFIX}"; HOST_WRITE="3rd:sandbox-recipes/write-${RUN_SUFFIX}"
MULTI_FIRST="1st:mcp-host/multi-${RUN_SUFFIX}"; MULTI_THIRD="3rd:sandbox-recipes/multi-${RUN_SUFFIX}"
host_labels=("host-only read grant" "host-only write grant" "multi-host read+write grant")
host_permissions=('["read"]' '["write"]' '["read","write"]')
host_subject_sets=("$(jq -cn --arg h "$HOST_READ" '[{type:"host",id:$h}]')" "$(jq -cn --arg h "$HOST_WRITE" '[{type:"host",id:$h}]')" "$(jq -cn --arg h1 "$MULTI_FIRST" --arg h3 "$MULTI_THIRD" '[{type:"host",id:$h1},{type:"host",id:$h3}]')")
host_key_sets=("'host:$HOST_READ'" "'host:$HOST_WRITE'" "'host:$MULTI_FIRST','host:$MULTI_THIRD'"); host_counts=(1 1 2)
for host_index in 0 1 2; do
  host_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --argjson s "${host_subject_sets[$host_index]}" --argjson p "${host_permissions[$host_index]}" '{drive:$d,resourceId:$r,subjects:$s,permissions:$p,inherit:false}')"
  resp="$(admin_http PUT /api/v1/gfs/grants "$host_body")"; label="${host_labels[$host_index]}"; keys="${host_key_sets[$host_index]}"; expected="${host_counts[$host_index]}"
  assert_bulk_success "$label" "$resp" "${host_subject_sets[$host_index]}"
  if [[ "$(stored_subject_count gfs_grants "$keys")" == "$expected" ]]; then ok "$label stored all targets"; else bad "$label stored an unexpected target count"; fi
  assert_correlated_audit "$label" "$keys" "$expected"
done
share_subjects="$(jq -cn --arg u "$USER_ID" --arg t "$USER_TEAM_ID" '[{type:"user",id:$u},{type:"team",id:$t}]')"
share_keys="'user:$USER_ID','team:$USER_TEAM_ID'"
share_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --argjson s "$share_subjects" '{drive:$d,resourceId:$r,subjects:$s,permissions:["read"],includeDescendants:false}')"
resp="$(user_http "$USER_TOKEN" POST /api/v1/me/gfs/shares "$share_body")"
assert_bulk_success "mixed bulk share" "$resp" "$share_subjects"
if [[ "$(stored_subject_count gfs_shares "$share_keys")" == "2" ]]; then ok "mixed bulk share stored both targets"
else bad "mixed bulk share did not store exactly two targets"; fi
assert_correlated_audit "mixed bulk share" "$share_keys" 2 share.create
reject_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg u "$REJECT_USER_ID" '{drive:$d,resourceId:$r,subjects:[{type:"user",id:$u},{type:"context",id:"bulk-context"}],permissions:["read"],inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$reject_body")"
assert_rejected_atomic gfs_grants "plural context grant" "$resp" "'user:$REJECT_USER_ID','context:bulk-context'"
reject_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg u "$REJECT_USER_ID" '{drive:$d,resourceId:$r,subjects:[{type:"user",id:$u},{type:"operator"}],permissions:["read"],inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$reject_body")"
assert_rejected_atomic gfs_grants "plural operator grant" "$resp" "'user:$REJECT_USER_ID','operator:'"
reject_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg u "$REJECT_USER_ID" --arg h "$FIRST_HOST" '{drive:$d,resourceId:$r,subjects:[{type:"user",id:$u},{type:"host",id:$h}],permissions:["read"],includeDescendants:false}')"
resp="$(user_http "$USER_TOKEN" POST /api/v1/me/gfs/shares "$reject_body")"
assert_rejected_atomic gfs_shares "plural host share" "$resp" "'user:$REJECT_USER_ID','host:$FIRST_HOST'"
for rejected_type in context operator; do
  rejected_subject="$(jq -cn --arg type "$rejected_type" '{type:$type} + if $type == "context" then {id:"bulk-context"} else {} end')"
  [[ "$rejected_type" == "context" ]] && rejected_key="context:bulk-context" || rejected_key="operator:"
  reject_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg u "$REJECT_USER_ID" --argjson invalid "$rejected_subject" '{drive:$d,resourceId:$r,subjects:[{type:"user",id:$u},$invalid],permissions:["read"],includeDescendants:false}')"
  resp="$(admin_http POST /api/v1/gfs/shares "$reject_body")"
  assert_rejected_atomic gfs_shares "plural $rejected_type share" "$resp" "'user:$REJECT_USER_ID','$rejected_key'"
done
ESCALATION_USER_ID="$(fixture_uuid escalation-user)"; ESCALATION_TEAM_ID="$(fixture_uuid escalation-team)"; escalation_keys="'user:$ESCALATION_USER_ID','team:$ESCALATION_TEAM_ID'"
esc_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg u "$ESCALATION_USER_ID" --arg t "$ESCALATION_TEAM_ID" \
  '{drive:$d,resourceId:$r,subjects:[{type:"user",id:$u},{type:"team",id:$t}],permissions:["delete"],inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$esc_body")"
assert_denied_atomic "no-escalation mixed bulk grant" "$resp" "$escalation_keys" 2
echo "== gfs USER-delegation gate: ${pass} passed, ${fail} failed =="
[[ "$fail" -eq 0 ]] || exit 1
