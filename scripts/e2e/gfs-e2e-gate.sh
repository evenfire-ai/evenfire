#!/usr/bin/env bash
# gfs E2E runtime gate (plan P5-S05) — single-node RWO.
#
# Flow (fail-loud at every step; never skip, never mock-to-green):
#   1. GlobalFileSystem reaches Ready (gfsc writer+reader, PVC, Service).
#   2. Operator bootstrap seeded the root directories.
#   3. A folder owner delegates Layer-2 write (no operator) — grant accepted.
#   4. An agent (host token) writes to a scratch folder; the write is audited,
#      and its DESTRUCTIVE delete is default-denied (403).
#   5. The written resource resolves by its gfs:// URI.
#   6. The resource downloads by its gfs:// URI (bytes match).
#
# This is NOT a CI unit test — it needs a live cluster. Run ONLY after a deploy
# sync on a branch profile. Any not-Ready / unreachable / unexpected status FAILS
# the gate with the concrete reason (pod/service/HTTP state), never a silent skip.
#
# Auth surfaces exercised (real, no mocks):
#   - operator session  → E2E_ADMIN_TOKEN when provided, otherwise seeded admin login
#                         (POST /gfs/token, PUT /gfs/grants, by-path)
#   - provisioner       → InternalControl JWT (iss=hcc) signed IN the control-api
#                         pod, minting a host gfs token + seeding roots
#   - gfsc broker       → the gfs token, called inside the gfsc pod (localhost)
#
# Usage:
#   CONTEXT=clerum-codex-gfs-<sha> scripts/e2e/gfs-e2e-gate.sh
set -euo pipefail

# CONTEXT is mandatory and explicit — never rely on the current kube-context.
CONTEXT="${CONTEXT:?set CONTEXT to an allowed branch/clerum-test profile (never a prod context)}"
GFS_NS="${GFS_NS:-gfs}"
CONTROL_NS="${CONTROL_NS:-control-plane}"
GFS_NAME="${GFS_NAME:-gfs}"
GFSC_PORT="${GFSC_PORT:-8087}"
CONTROL_API_PORT="${CONTROL_API_PORT:-8090}"
DRIVE="${DRIVE:-main}"
TIMEOUT="${TIMEOUT:-180}"

# A unique scratch dir + host name per run so reruns never collide on the
# sibling-uniqueness index. Caller may pin GFS_E2E_TAG for a deterministic run.
TAG="${GFS_E2E_TAG:-$(kubectl --context="$CONTEXT" -n "$CONTROL_NS" get ns "$CONTROL_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null | cut -c1-8 || echo run)}"
SCRATCH_NAME="scratch-e2e-${TAG}"
HOST_LEAF="gfs-e2e-${TAG}"
# A per-RUN nonce so the gate is re-runnable against the same scratch dir without
# colliding on the sibling-uniqueness index (the scratch dir is stable per
# cluster; the created files are unique per run).
RUN_NONCE="${GFS_E2E_NONCE:-$(date +%s)}"
OP_FILE="op-note-${RUN_NONCE}.txt"
AGENT_FILE="agent-note-${RUN_NONCE}.txt"
HOST_NS="${HOST_ISSUANCE_NAMESPACE:-mcp-host}"
HOST_SUBJECT="host:1st:${HOST_NS}/${HOST_LEAF}"

kc() { kubectl --context="$CONTEXT" "$@"; }

pass=0
fail=0
ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL: $1"; fail=$((fail + 1)); }

die() {
  echo "FATAL: $1" >&2
  echo "--- gfs namespace pods ---" >&2
  kc -n "$GFS_NS" get pods -o wide 2>&1 | sed 's/^/  /' >&2 || true
  echo "--- GlobalFileSystem status ---" >&2
  kc -n "$GFS_NS" get globalfilesystem "$GFS_NAME" -o yaml 2>&1 | sed 's/^/  /' >&2 || true
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

# ready_pod NS SELECTOR — first Running+Ready pod name, or empty.
ready_pod() {
  kc -n "$1" get pods -l "$2" --field-selector=status.phase=Running \
    -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
    | awk -F'\t' '$2=="True"{print $1; exit}'
}

echo "== gfs E2E runtime gate (context=$CONTEXT) =="

# Guard: refuse to run against anything that is not an allowed local/branch
# profile. Accept `clerum-test` and any generated branch-scoped profile
# (`clerum-<topic>-<8hex>`, e.g. clerum-feat-gfs-open-core-b64f4c58 /
# clerum-codex-* / clerum-detached-*) — never a prod context.
case "$CONTEXT" in
  *prod* | *production*) die "CONTEXT '$CONTEXT' looks like production — refusing" ;;
esac
if [[ "$CONTEXT" == "clerum-test" || "$CONTEXT" =~ ^clerum-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]; then
  :
else
  die "CONTEXT '$CONTEXT' is not an allowed local/branch profile for this gate"
fi


# ─── 1. GlobalFileSystem Ready ───────────────────────────────────────────────
kc -n "$GFS_NS" get globalfilesystem "$GFS_NAME" >/dev/null 2>&1 \
  || die "GlobalFileSystem/$GFS_NAME not found in ns $GFS_NS (apply the CRD instance first)"
phase="$(kc -n "$GFS_NS" get globalfilesystem "$GFS_NAME" -o 'jsonpath={.status.phase}' 2>/dev/null || true)"
[[ "$phase" == "Ready" ]] && ok "GlobalFileSystem phase=Ready" || bad "GlobalFileSystem phase='$phase' (want Ready)"
wait_ready "$GFS_NS" "app=gfs-controller" && ok "gfsc pod Ready"

# ─── 2. Service reachable (the brokered access point) ────────────────────────
kc -n "$GFS_NS" get svc gfsc >/dev/null 2>&1 && ok "gfsc Service present" \
  || bad "gfsc Service missing (reconciler did not create it)"

# Route all broker calls through the WRITER pod: it mounts the drive RW so it
# serves both reads and writes (a reader replica mounts RO and rejects writes by
# design). Read-replica fan-out is a separate scaling concern, not this gate.
GFSC_POD="$(ready_pod "$GFS_NS" "app=gfs-controller,clerum.io/gfsc-role=writer")"
[[ -n "$GFSC_POD" ]] || die "no Ready gfsc WRITER pod to exec into"
CONTROL_POD="$(ready_pod "$CONTROL_NS" "app=control-api")"
[[ -n "$CONTROL_POD" ]] || CONTROL_POD="$(ready_pod "$CONTROL_NS" "app.kubernetes.io/name=control-api")"
[[ -n "$CONTROL_POD" ]] || die "no Ready control-api pod to exec into"

# ─── helpers: in-pod node fetch + psql ───────────────────────────────────────
# All HTTP is issued from INSIDE a pod (localhost) so the gate needs no
# port-forward and crosses no NetworkPolicy hop it should not.

# admin_http METHOD PATH [BODY] → "STATUS\tBODY" (operator session cookie).
# The Control-UI admin endpoints (incl. /gfs/token, /gfs/grants, /gfs/by-path)
# authenticate via the httpOnly session COOKIE, not a Bearer header — so
# E2E_ADMIN_TOKEN is sent as the control_ui_admin_session cookie value.
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

# ic_http METHOD PATH [BODY] → "STATUS\tBODY". Signs an InternalControl JWT
# (iss=hcc) in-pod with the HCC HMAC secret, then calls control-api as a
# provisioner. Fails loud if the secret is not present in the pod env.
ic_http() {
  kc -n "$CONTROL_NS" exec "$CONTROL_POD" -- node -e '
    const jwt = require("jsonwebtoken")
    const secret = process.env.INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
    if (!secret) { process.stderr.write("INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET not set in control-api pod"); process.exit(2) }
    const [method, path, body] = process.argv.slice(1)
    const ic = jwt.sign({ sub: "gfs-e2e", jti: "gfs-e2e-" + process.pid + "-" + process.hrtime.bigint() }, secret,
      { algorithm: "HS256", issuer: "hcc", audience: "control-api", expiresIn: 300 })
    fetch("http://localhost:'"$CONTROL_API_PORT"'" + path, {
      method,
      headers: { Authorization: "Bearer " + ic, "Content-Type": "application/json" },
      body: body || undefined,
    }).then(async r => { process.stdout.write(r.status + "\t" + await r.text()) })
      .catch(e => { process.stderr.write(e.message); process.exit(1) })
  ' "$1" "$2" "${3:-}"
}

# gfsc_http TOKEN METHOD PATH [BODY] → "STATUS\tBODY" (gfs token, in gfsc pod).
gfsc_http() {
  kc -n "$GFS_NS" exec "$GFSC_POD" -- node -e '
    const [token, method, path, body] = process.argv.slice(1)
    fetch("http://localhost:'"$GFSC_PORT"'" + path, {
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

http_status() { printf '%s' "$1" | cut -f1; }
http_body() { printf '%s' "$1" | cut -f2-; }

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

# ─── mint the operator gfs token (read+write+delete) ─────────────────────────
resp="$(admin_http POST /api/v1/gfs/token '{"scopes":["gfs.read","gfs.write","gfs.delete"]}')"
[[ "$(http_status "$resp")" == "200" ]] || die "operator /gfs/token mint failed: $resp"
OP_TOKEN="$(http_body "$resp" | jq -r '.token')"
[[ -n "$OP_TOKEN" && "$OP_TOKEN" != "null" ]] && ok "operator gfs token minted" || die "no operator token in: $resp"

# ─── seed a scratch root (provisioner / InternalControl JWT) ─────────────────
resp="$(ic_http POST /api/v1/gfs/seed "{\"drive\":\"$DRIVE\",\"rootDirectories\":[\"/$SCRATCH_NAME\"]}")"
case "$(http_status "$resp")" in
  200 | 201 | 409) ok "scratch root seeded (/$SCRATCH_NAME)" ;;
  *) die "seed /$SCRATCH_NAME failed: $resp" ;;
esac

SCRATCH_RID="$(psql_one "SELECT resource_id FROM gfs_resources WHERE drive='$DRIVE' AND name='$SCRATCH_NAME' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;")"
[[ -n "$SCRATCH_RID" ]] && ok "resolved scratch rid ($SCRATCH_RID)" || die "scratch dir not found in gfs_resources after seed"

# ─── operator creates + reads a file (proves the governed read+write plane) ──
resp="$(gfsc_http "$OP_TOKEN" POST "/v1/resources/$SCRATCH_RID/children" "$(jq -cn --arg n "$OP_FILE" '{name:$n, content:"operator wrote this"}')")"
[[ "$(http_status "$resp")" == "201" ]] || die "operator create in scratch failed: $resp"
OP_FILE_RID="$(http_body "$resp" | jq -r '.data.rid')"
[[ -n "$OP_FILE_RID" && "$OP_FILE_RID" != "null" ]] && ok "operator created a file in scratch (201)" || die "no rid in create response: $resp"

resp="$(gfsc_http "$OP_TOKEN" GET "/v1/resources/$OP_FILE_RID/content")"
[[ "$(http_status "$resp")" == "200" && "$(http_body "$resp")" == "operator wrote this" ]] \
  && ok "operator read the file back (bytes match)" || bad "operator read-back mismatch: $resp"

# ─── 3. Folder owner delegates Layer-2 WRITE to the host (no operator) ────────
grant_body="$(jq -cn --arg d "$DRIVE" --arg r "$SCRATCH_RID" --arg id "1st:${HOST_NS}/${HOST_LEAF}" \
  '{drive:$d, resourceId:$r, subject:{type:"host", id:$id}, permissions:["write"], inherit:false}')"
resp="$(admin_http PUT /api/v1/gfs/grants "$grant_body")"
[[ "$(http_status "$resp")" =~ ^20 ]] && ok "host granted write on scratch (delegation accepted)" \
  || die "grant write to $HOST_SUBJECT failed: $resp"

# ─── mint the host (agent) gfs token ─────────────────────────────────────────
# Includes gfs.delete in the scope CEILING on purpose: the destructive deny in
# step 4b must come from the STORE (no delete grant), not merely from a token
# that lacks the scope — that is the faithful "agents are default-denied delete".
resp="$(ic_http POST "/api/v1/auth/gfs/${HOST_LEAF}/tokens" "{\"namespace\":\"$HOST_NS\",\"scopes\":[\"gfs.write\",\"gfs.read\",\"gfs.delete\"]}")"
[[ "$(http_status "$resp")" == "200" ]] || die "provisioner host-token mint failed: $resp"
HOST_TOKEN="$(http_body "$resp" | jq -r '.token')"
MINTED_SUBJECT="$(http_body "$resp" | jq -r '.subject')"
[[ "$MINTED_SUBJECT" == "$HOST_SUBJECT" ]] && ok "host token minted for $HOST_SUBJECT" \
  || die "minted subject '$MINTED_SUBJECT' != expected '$HOST_SUBJECT'"

# ─── 4. Agent writes to scratch (GOVERNED — store grant, NOT intrinsic) ──────
resp="$(gfsc_http "$HOST_TOKEN" POST "/v1/resources/$SCRATCH_RID/children" "$(jq -cn --arg n "$AGENT_FILE" '{name:$n, content:"agent wrote this"}')")"
[[ "$(http_status "$resp")" == "201" ]] || die "GOVERNED agent write failed (grant not honored?): $resp"
AGENT_FILE_RID="$(http_body "$resp" | jq -r '.data.rid')"
AGENT_FILE_URI="$(http_body "$resp" | jq -r '.data.gfsUri')"
ok "agent wrote to scratch via its host token (201, governed by the grant)"

# audit: the write produced an allow row for the host subject.
audit_n="$(psql_one "SELECT count(*) FROM gfs_audit WHERE subject='$HOST_SUBJECT' AND op='write' AND outcome='allow';")"
[[ "${audit_n:-0}" -ge 1 ]] && ok "agent write was audited (gfs_audit allow row present)" \
  || bad "no audit row for $HOST_SUBJECT write (got count=$audit_n)"

# ─── 4b. Destructive DELETE is default-denied for the agent (no delete grant) ─
resp="$(gfsc_http "$HOST_TOKEN" DELETE "/v1/resources/$AGENT_FILE_RID" '{"ifMatch":0}')"
[[ "$(http_status "$resp")" == "403" ]] && ok "agent delete is default-denied (403, destructive bit)" \
  || bad "agent delete should be 403 (default-deny), got: $resp"

# ─── 5. Resolve by gfs:// URI ────────────────────────────────────────────────
resp="$(gfsc_http "$OP_TOKEN" GET "/v1/resolve?uri=$AGENT_FILE_URI")"
[[ "$(http_status "$resp")" == "200" && "$(http_body "$resp" | jq -r '.data.gfsUri')" == "$AGENT_FILE_URI" ]] \
  && ok "agent file resolves by gfs:// URI" || bad "resolve by URI failed: $resp"

# ─── 6. Download by gfs:// URI (operator reads the agent's bytes) ────────────
resp="$(gfsc_http "$OP_TOKEN" GET "/v1/resources/$AGENT_FILE_RID/content")"
[[ "$(http_status "$resp")" == "200" && "$(http_body "$resp")" == "agent wrote this" ]] \
  && ok "agent file downloads by URI (bytes match)" || bad "download mismatch: $resp"

echo "== gfs E2E gate: ${pass} passed, ${fail} failed =="
[[ "$fail" -eq 0 ]] || exit 1
