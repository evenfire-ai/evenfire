#!/usr/bin/env bash
# gfs USER-delegation E2E gate (plan P4-S07 / Phase E) — the end-user plane.
#
# Proves the Desktop/Profile delegation journey end-to-end THROUGH THE NEW
# user-session routes, reusing the EXISTING JWT scheme (no new auth):
#   external-rest-api /api/v1/me/gfs/*  →  control-api /external/gfs/*  (Session
#   JWT plane, service-gated)  →  gfsc.  The user gfs token is minted by the same
#   signGfsToken as operator/host tokens (only sub=users.id).
#
# Flow (fail-loud at every step; never skip, never mock-to-green):
#   1. GlobalFileSystem Ready (gfsc writer, control-api, external-rest-api pods).
#   2. Seed a scratch root (provisioner / InternalControl JWT).
#   3. Operator logs in with seeded admin credentials and grants the test USER
#      manage_acl+read on the scratch folder.
#   4. User logs in via external-rest-api password-login → real session token.
#   5. User mints a gfs token via /me/gfs/token (the new user-plane mint).
#   6. User reads the scratch folder it was granted via /me/gfs/resources/:id/
#      children (deny-by-default: it only sees what it was granted).
#   7. User affordances report held=[manage_acl,read], isOperator=false (the bits
#      the Desktop delegation panel renders).
#   8. User delegates read to a 2nd subject via /me/gfs/grants — accepted, and the
#      grant row is recorded with granted_by=user:<id> (resolveCaller user path).
#   9. No-escalation: user tries to grant `write` (a bit it does NOT hold) → 403
#      escalation_rejected (assertMayGrant enforced on the user plane).
#
# Scope note (no silent cap): step 8 asserts the delegation LANDS in the store
# (the governance proof for the user-caller path). That a granted subject then
# reads is gfsc authz, already proven by scripts/e2e/gfs-e2e-gate.sh; this gate
# does not spin a 2nd login to avoid a second seeded identity.
#
# NOT a CI unit test — needs a live cluster. Run ONLY after a deploy sync on a
# branch profile, with the test user seeded:
#   CONTEXT=clerum-test scripts/minikube/seed-test-data.sh
#
# Usage:
#   CONTEXT=clerum-<topic>-<sha> scripts/e2e/gfs-user-e2e-gate.sh
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
SCRATCH_NAME="user-scratch-e2e-${TAG}"
RUN_NONCE="${GFS_E2E_NONCE:-$(date +%s)}"
# A throwaway 2nd subject the user delegates read to (no login needed — the row
# landing is the governance proof). Stable per run.
DELEGATE_USER_ID="${GFS_E2E_DELEGATE_ID:-00000000-0000-4000-8000-$(printf '%012d' "$((RUN_NONCE % 1000000000000))")}"

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


# ─── 1. Pods Ready ───────────────────────────────────────────────────────────
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

# ─── helpers ─────────────────────────────────────────────────────────────────
http_status() { printf '%s' "$1" | cut -f1; }
http_body() { printf '%s' "$1" | cut -f2-; }

# operator session cookie → control-api admin endpoints.
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

# provisioner InternalControl JWT (iss=hcc), signed in-pod → control-api.
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

# user session: login (no Origin header in-pod → bearer token returned in body).
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

# user-plane call: external-rest-api /api/v1/me/gfs/* with the user bearer token.
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

# ─── 2. Seed scratch root (provisioner) ──────────────────────────────────────
resp="$(ic_http POST /api/v1/gfs/seed "{\"drive\":\"$DRIVE\",\"rootDirectories\":[\"/$SCRATCH_NAME\"]}")"
case "$(http_status "$resp")" in
  200 | 201 | 409) ok "scratch root seeded (/$SCRATCH_NAME)" ;;
  *) die "seed /$SCRATCH_NAME failed: $resp" ;;
esac
SCRATCH_RID="$(psql_one "SELECT resource_id FROM gfs_resources WHERE drive='$DRIVE' AND name='$SCRATCH_NAME' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;")"
[[ -n "$SCRATCH_RID" ]] && ok "resolved scratch rid ($SCRATCH_RID)" || die "scratch dir not found after seed"

# ─── 3. Operator grants the test USER manage_acl+read on the scratch folder ──
USER_ID="$(psql_one "SELECT id FROM users WHERE lower(email)=lower('$TEST_USER_EMAIL') LIMIT 1;")"
[[ -n "$USER_ID" ]] && ok "resolved test user id ($USER_ID)" \
  || die "test user '$TEST_USER_EMAIL' not found — run scripts/minikube/seed-test-data.sh first"

grant_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg id "$USER_ID" \
  '{drive:$d, resourceId:$r, subject:{type:"user", id:$id}, permissions:["manage_acl","read"], inherit:true}')"
resp="$(admin_http PUT /api/v1/gfs/grants "$grant_body")"
[[ "$(http_status "$resp")" =~ ^20 ]] && ok "operator granted user manage_acl+read on scratch" \
  || die "operator grant to user failed: $resp"

# ─── 4. User logs in (real session token) ────────────────────────────────────
resp="$(user_login "$TEST_USER_EMAIL" "$TEST_USER_PASSWORD")"
[[ "$(http_status "$resp")" == "200" ]] || die "user password-login failed: $resp"
USER_TOKEN="$(http_body "$resp" | jq -r '.token')"
[[ -n "$USER_TOKEN" && "$USER_TOKEN" != "null" ]] && ok "user logged in (session token)" \
  || die "no bearer token in login response (in-pod exposure gate?): $resp"

# ─── 5. User mints a gfs token via the new user-plane route ──────────────────
resp="$(user_http "$USER_TOKEN" POST /api/v1/me/gfs/token '{"scopes":["gfs.read"]}')"
[[ "$(http_status "$resp")" == "200" ]] || die "user /me/gfs/token mint failed: $resp"
[[ -n "$(http_body "$resp" | jq -r '.token // empty')" ]] && ok "user minted a gfs token (/me/gfs/token)" \
  || die "no token in user mint: $resp"

# ─── 6. User reads the granted folder (deny-by-default honored) ──────────────
resp="$(user_http "$USER_TOKEN" GET "/api/v1/me/gfs/resources/$SCRATCH_RID/children?drive=$DRIVE")"
[[ "$(http_status "$resp")" == "200" ]] && ok "user listed the granted folder (/me/gfs/.../children)" \
  || bad "user children listing failed (granted read not honored?): $resp"

# ─── 7. User affordances reflect the held bits (drives the Desktop panel) ─────
resp="$(user_http "$USER_TOKEN" GET "/api/v1/me/gfs/resources/$SCRATCH_RID/affordances?drive=$DRIVE")"
if [[ "$(http_status "$resp")" == "200" ]]; then
  held="$(http_body "$resp" | jq -r '.held | sort | join(",")')"
  isop="$(http_body "$resp" | jq -r '.isOperator')"
  [[ "$held" == "manage_acl,read" && "$isop" == "false" ]] \
    && ok "user affordances = [manage_acl,read], isOperator=false" \
    || bad "unexpected affordances held='$held' isOperator='$isop': $resp"
else
  bad "user affordances failed: $resp"
fi

# ─── 8. User delegates read to a 2nd subject (resolveCaller user path) ────────
deleg_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg id "$DELEGATE_USER_ID" \
  '{drive:$d, resourceId:$r, subject:{type:"user", id:$id}, permissions:["read"], inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$deleg_body")"
[[ "$(http_status "$resp")" =~ ^20 ]] && ok "user delegated read to a 2nd subject (200)" \
  || die "user delegation failed: $resp"
gb="$(psql_one "SELECT granted_by FROM gfs_grants WHERE drive='$DRIVE' AND resource_id='$SCRATCH_RID' AND subject_type='user' AND subject_id='$DELEGATE_USER_ID' ORDER BY updated_at DESC LIMIT 1;")"
[[ "$gb" == "user:$USER_ID" ]] && ok "delegation recorded with granted_by=user:<id> (caller path)" \
  || bad "expected granted_by='user:$USER_ID', got '$gb'"

# ─── 9. No-escalation: user cannot grant a bit it does NOT hold (write) ──────
esc_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg id "$DELEGATE_USER_ID" \
  '{drive:$d, resourceId:$r, subject:{type:"user", id:$id}, permissions:["write"], inherit:false}')"
resp="$(user_http "$USER_TOKEN" PUT /api/v1/me/gfs/grants "$esc_body")"
status="$(http_status "$resp")"
code="$(http_body "$resp" | jq -r '.error // empty' 2>/dev/null || true)"
[[ "$status" == "403" ]] && ok "no-escalation: user grant of unheld 'write' denied (403, $code)" \
  || bad "expected 403 escalation_rejected, got status=$status: $resp"

echo "== gfs USER-delegation gate: ${pass} passed, ${fail} failed =="
[[ "$fail" -eq 0 ]] || exit 1
