#!/usr/bin/env bash
#
# E2E smoke: control-api ↔ evenfire-registry publish/update/remove contract.
#
# Drives the round-trip a Control UI user takes when managing registry entries:
#   1. login as admin against control-api (POST /api/v1/admin/auth/login)
#   2. publish a transient entry (POST /api/v1/admin/registry/entries)
#   3. read it back (GET /api/v1/admin/registry/entries/:name/versions/:version)
#   4. update version metadata (PUT /api/v1/admin/registry/entries/:name/versions/:version)
#   5. read it back to confirm the update applied
#   6. soft-delete the version (DELETE /api/v1/admin/registry/entries/:name/versions/:version)
#   7. confirm the deletion (read returns 404, with status='removed' in DB)
#
# Catches the failure class from 2026-05-26 where control-api's registryClient
# was unauthenticated against the registry and every publish 401'd. Also catches
# regressions in the canPublish / scope-binding code (PR #5) by exercising the
# real publish path with a real Bearer.
#
# Usage:
#   CONTROL_API_BASE_URL=https://example.com \
#   CONTROL_API_ADMIN_USERNAME=admin \
#   CONTROL_API_ADMIN_PASSWORD='********' \
#   ./scripts/e2e/e2e-registry-publish-update-remove.sh
#
# Or against a local port-forward:
#   CONTROL_API_BASE_URL=http://127.0.0.1:8090 \
#   CONTROL_API_ADMIN_USERNAME=admin \
#   CONTROL_API_ADMIN_PASSWORD='...' \
#   ./scripts/e2e/e2e-registry-publish-update-remove.sh
#
# Idempotent cleanup: on success, the published version is soft-deleted; on
# failure, the trap prints what was left behind so the operator can clean up.
set -euo pipefail

BASE_URL="${CONTROL_API_BASE_URL:?must set CONTROL_API_BASE_URL (e.g. https://example.com)}"
ADMIN_USER="${CONTROL_API_ADMIN_USERNAME:?must set CONTROL_API_ADMIN_USERNAME}"
ADMIN_PASS="${CONTROL_API_ADMIN_PASSWORD:?must set CONTROL_API_ADMIN_PASSWORD}"

# Cap diagnostic output. Defaults to compact; export E2E_VERBOSE=1 to dump
# full HTTP bodies.
VERBOSE="${E2E_VERBOSE:-0}"

# Test entry — unscoped name so the machine OAuth path (control-api's
# registryClient) is the one being exercised. Suffix with a timestamp so the
# script is re-runnable without manual cleanup of orphaned rows.
TS="$(date +%s)"
ENTRY_NAME="e2e-registry-smoke-${TS}"
ENTRY_VERSION="0.1.0"

CLEANUP_NEEDED=1
cleanup() {
  local status=$?
  if [ "$CLEANUP_NEEDED" -eq 1 ]; then
    echo
    echo "[cleanup] removing entry ${ENTRY_NAME}@${ENTRY_VERSION} (best-effort)"
    curl -sS -o /dev/null -w "  HTTP %{http_code}\n" \
      -X DELETE "${BASE_URL}/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}" \
      -H "Authorization: Bearer ${SESSION_JWT:-}" || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

log_step() { echo; echo "── $1"; }

http_call() {
  local method="$1"; shift
  local path="$1"; shift
  local body="${1:-}"
  local resp
  if [ -n "$body" ]; then
    resp=$(curl -sS -w "\n__HTTP__%{http_code}" -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${SESSION_JWT}" \
      -H "Content-Type: application/json" \
      -d "$body")
  else
    resp=$(curl -sS -w "\n__HTTP__%{http_code}" -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${SESSION_JWT}")
  fi
  HTTP_CODE="${resp##*__HTTP__}"
  HTTP_BODY="${resp%__HTTP__*}"
  if [ "$VERBOSE" = "1" ]; then
    echo "  → ${method} ${path}: ${HTTP_CODE}"
    echo "${HTTP_BODY}" | head -c 500
    echo
  fi
}

assert_status() {
  local expected="$1" stepname="$2"
  if [ "$HTTP_CODE" != "$expected" ]; then
    echo "FAIL: ${stepname} expected HTTP ${expected}, got ${HTTP_CODE}" >&2
    echo "body:" >&2
    echo "${HTTP_BODY}" | head -c 1000 >&2
    exit 1
  fi
  echo "  ✓ HTTP ${HTTP_CODE}"
}

extract_json_field() {
  # extract_json_field <field>
  # Reads HTTP_BODY, prints body[field] via node.
  node -e "
    let raw = '';
    process.stdin.on('data', d => raw += d);
    process.stdin.on('end', () => {
      try { process.stdout.write(String(JSON.parse(raw)['$1'] ?? '')) }
      catch (e) { process.stdout.write('') }
    });
  " <<<"${HTTP_BODY}"
}

# ── 1. Admin login ─────────────────────────────────────────────────────────────
log_step "1. POST /api/v1/admin/auth/login as ${ADMIN_USER}"
LOGIN_BODY=$(jq -cn --arg u "$ADMIN_USER" --arg p "$ADMIN_PASS" '{username: $u, password: $p}')
LOGIN_RESP=$(curl -sS -w "\n__HTTP__%{http_code}" -X POST \
  "${BASE_URL}/api/v1/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d "${LOGIN_BODY}")
LOGIN_CODE="${LOGIN_RESP##*__HTTP__}"
LOGIN_BODY_TEXT="${LOGIN_RESP%__HTTP__*}"
if [ "$LOGIN_CODE" != "200" ]; then
  echo "FAIL: login expected 200, got ${LOGIN_CODE}" >&2
  echo "${LOGIN_BODY_TEXT}" | head -c 500 >&2
  CLEANUP_NEEDED=0
  exit 1
fi
SESSION_JWT=$(echo "${LOGIN_BODY_TEXT}" | node -e "
  let r='';process.stdin.on('data',d=>r+=d);
  process.stdin.on('end',()=>{
    const j=JSON.parse(r);
    process.stdout.write(j.token || j.accessToken || j.jwt || '');
  });
")
if [ -z "$SESSION_JWT" ]; then
  echo "FAIL: login response had no token/accessToken/jwt field" >&2
  echo "${LOGIN_BODY_TEXT}" | head -c 500 >&2
  CLEANUP_NEEDED=0
  exit 1
fi
echo "  ✓ login OK (jwt len=${#SESSION_JWT})"

# ── 2. Publish ─────────────────────────────────────────────────────────────────
log_step "2. POST /api/v1/admin/registry/entries (publish ${ENTRY_NAME}@${ENTRY_VERSION})"
PUBLISH_BODY=$(cat <<EOF
{
  "name": "${ENTRY_NAME}",
  "version": "${ENTRY_VERSION}",
  "description": "e2e-registry smoke",
  "author": "e2e-smoke",
  "entryType": "mcp-server",
  "origin": "agent-generated",
  "category": "uncategorized",
  "tags": ["e2e", "smoke"],
  "contentCreatorTag": "community",
  "configCreatorTag": "community",
  "mcpServer": {
    "serverMode": "local",
    "transport": "streamableHttp",
    "imageRef": "registry.example.com/e2e-smoke:0.1.0",
    "port": 3000
  }
}
EOF
)
http_call POST "/api/v1/admin/registry/entries" "$PUBLISH_BODY"
assert_status 201 "publish"

# ── 3. Read back the version ───────────────────────────────────────────────────
log_step "3. GET /api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
http_call GET "/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
assert_status 200 "read after publish"
ENTRY_ID=$(extract_json_field id)
if [ -z "$ENTRY_ID" ]; then
  echo "FAIL: read-after-publish returned no id field" >&2
  echo "${HTTP_BODY}" | head -c 500 >&2
  exit 1
fi
echo "  ✓ entry id=${ENTRY_ID}"

# ── 4. Update version metadata ─────────────────────────────────────────────────
# Update path: PUT /:name/versions/:version replaces metadata for the version.
# Setting `deprecated` is the lowest-risk change to verify the write path.
log_step "4. PUT /api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION} (set description)"
UPDATE_BODY='{"description":"e2e-registry smoke — updated"}'
http_call PUT "/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}" "$UPDATE_BODY"
assert_status 200 "update"

# ── 5. Read back to confirm update applied ─────────────────────────────────────
log_step "5. GET version again, expect updated description"
http_call GET "/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
assert_status 200 "read after update"
NEW_DESC=$(extract_json_field description)
if [ "$NEW_DESC" != "e2e-registry smoke — updated" ]; then
  echo "FAIL: description did not update — got: ${NEW_DESC}" >&2
  exit 1
fi
echo "  ✓ description updated"

# ── 6. Delete the version ──────────────────────────────────────────────────────
log_step "6. DELETE /api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
http_call DELETE "/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
# Soft-delete returns 200 with {deleted:true} or 204
case "$HTTP_CODE" in
  200|204) echo "  ✓ HTTP ${HTTP_CODE}" ;;
  *)
    echo "FAIL: delete expected 200/204, got ${HTTP_CODE}" >&2
    echo "${HTTP_BODY}" | head -c 500 >&2
    exit 1
    ;;
esac

# ── 7. Read back; expect not-found (status='removed' filter) ───────────────────
log_step "7. GET version after delete, expect 404"
http_call GET "/api/v1/admin/registry/entries/${ENTRY_NAME}/versions/${ENTRY_VERSION}"
assert_status 404 "read after delete"

# Mark cleanup as no-longer-needed before the trap fires.
CLEANUP_NEEDED=0

echo
echo "──────────────────────────────────────────────────────────────────────────"
echo "✓ E2E PASS: publish → read → update → read → delete → 404"
echo "  entry: ${ENTRY_NAME}@${ENTRY_VERSION}"
echo "  base : ${BASE_URL}"
echo "──────────────────────────────────────────────────────────────────────────"
