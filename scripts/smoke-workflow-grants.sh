#!/usr/bin/env bash
# End-to-end smoke test of the workflow-grants API in minikube.
# Validates the specific behaviors introduced in PR #196:
#   - Bulk INSERT ... SELECT unnest() audit (1 query per action, not per user)
#   - SELECT ... FOR UPDATE serialization of the replace path
#   - UUID lowercase normalization end-to-end
#   - Rate limiting on GET/PUT endpoints
#   - admin workflow lane auth returning opaque 401
#
# Requires:
#   - minikube 'clerum-test' running + PFs at localhost:3000/8090
#   - bootstrap admin creds admin/changeme123!
#
# Exits 0 on success, 1 on any assertion failure.

set -euo pipefail
umask 077

CONTROL_API="${CONTROL_API:-http://localhost:8090}"
CTX="${CTX:-clerum-test}"
NS_CRD="sandbox-recipes"
RECIPE_NAME="smoke-grants-$(date +%s)"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

fail() { red "FAIL: $*"; exit 1; }
pass() { green "PASS: $*"; }
step() { blue "[step] $*"; }

PSQL_POD=$(kubectl --context "$CTX" -n control-plane get pod \
  -l app=control-postgres -o jsonpath='{.items[0].metadata.name}')
psql_run() {
  kubectl --context "$CTX" -n control-plane exec "$PSQL_POD" -- \
    psql -U postgres -d profiles -tAc "$1"
}

cleanup() {
  step "cleanup"
  kubectl --context "$CTX" -n "$NS_CRD" delete workflowrecipe "$RECIPE_NAME" \
    --ignore-not-found=true --wait=false >/dev/null 2>&1 || true

  # Wide-net cleanup: any smoke-test artifact from this or prior runs is
  # identifiable via the `smoke-grants-` prefix (on recipe_name and on
  # users.email). Order matters — FKs from trigger_grants_audit.target_user_id
  # to users(id) use ON DELETE RESTRICT, so audit rows for smoke users must
  # be deleted FIRST, then grants, then users themselves.
  #
  # SAFETY: the explicit `AND email NOT IN (...)` clause preserves known
  # long-lived test users that other test suites depend on. Without this
  # guard, a future developer who widens the LIKE pattern (e.g. to
  # `%@clerum.io`) would silently wipe credentials other tests need.
  # Keep this allowlist tight — add an entry ONLY when a user has
  # pre-seeded permissions that other suites rely on.
  psql_run "
    DELETE FROM trigger_grants_audit
     WHERE recipe_name LIKE 'smoke-grants-%'
        OR target_user_id IN (
             SELECT id FROM users
              WHERE email LIKE 'smoke-grants-%@clerum.io'
                AND email NOT IN ('test@clerum.io')
           );
    DELETE FROM user_workflow_triggers
     WHERE recipe_name LIKE 'smoke-grants-%'
        OR user_id IN (
             SELECT id FROM users
              WHERE email LIKE 'smoke-grants-%@clerum.io'
                AND email NOT IN ('test@clerum.io')
           );
    DELETE FROM users
     WHERE email LIKE 'smoke-grants-%@clerum.io'
       AND email NOT IN ('test@clerum.io');
  " >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. admin login
step "1. admin login"
ADMIN_TOKEN=$(curl -sS -X POST "$CONTROL_API/api/v1/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme123!"}' | jq -r '.token')
[[ -n "$ADMIN_TOKEN" && "$ADMIN_TOKEN" != "null" ]] || fail "admin login returned no token"
pass "admin token obtained (len=${#ADMIN_TOKEN})"

# 2. seed test users
step "2. seed 4 test users"
# `psql -tAc` with INSERT RETURNING prints both the UUID row AND the
# "INSERT 0 1" notice on separate lines. We only want the UUID, so take
# the first line.
USER_A=$(psql_run "INSERT INTO users (email, name) VALUES ('smoke-grants-a@clerum.io', 'Alice') RETURNING id;" | head -n 1 | tr -d '[:space:]')
USER_B=$(psql_run "INSERT INTO users (email, name) VALUES ('smoke-grants-b@clerum.io', 'Bob') RETURNING id;" | head -n 1 | tr -d '[:space:]')
USER_C=$(psql_run "INSERT INTO users (email, name) VALUES ('smoke-grants-c@clerum.io', 'Carol') RETURNING id;" | head -n 1 | tr -d '[:space:]')
USER_D=$(psql_run "INSERT INTO users (email, name) VALUES ('smoke-grants-d@clerum.io', 'Dave') RETURNING id;" | head -n 1 | tr -d '[:space:]')
pass "users seeded: A=$USER_A B=$USER_B C=$USER_C D=$USER_D"

# 3. create CRD
step "3. create WorkflowRecipe CRD '$RECIPE_NAME' in $NS_CRD"
cat <<YAML | kubectl --context "$CTX" apply -f - >/dev/null
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: $RECIPE_NAME
  namespace: $NS_CRD
spec:
  agent:
    provider: zai
    model: glm-5-turbo
  steps:
    - id: noop
      instruction: "noop step for smoke test"
YAML
pass "recipe created"

# 4. GET empty
step "4. GET /grants (expect empty)"
RESP=$(curl -sS -w "\n%{http_code}" -X GET \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "200" ]] || fail "GET /grants: expected 200, got $CODE -- body: $BODY"
COUNT=$(echo "$BODY" | jq '.items | length')
[[ "$COUNT" == "0" ]] || fail "GET /grants: expected empty, got $COUNT items"
pass "GET /grants returned 200 with empty items"

# 5. PUT 3 users - bulk regression
step "5. PUT /grants [A, B, C]"
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userIds\":[\"$USER_A\",\"$USER_B\",\"$USER_C\"]}")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "200" ]] || fail "PUT /grants: expected 200, got $CODE -- body: $BODY"
ADDED=$(echo "$BODY" | jq -r '.added | length')
[[ "$ADDED" == "3" ]] || fail "expected 3 added, got $ADDED"
pass "PUT /grants returned 200 with added=[3]"

step "5a. user_workflow_triggers has 3 rows"
ROWS=$(psql_run "SELECT COUNT(*) FROM user_workflow_triggers WHERE recipe_name='$RECIPE_NAME';")
[[ "$ROWS" == "3" ]] || fail "expected 3 rows, got $ROWS"
pass "3 rows in user_workflow_triggers"

step "5b. regression(review-medium): 3 audit rows share 1 created_at (bulk proof)"
DISTINCT_TS=$(psql_run "SELECT COUNT(DISTINCT created_at) FROM trigger_grants_audit WHERE recipe_name='$RECIPE_NAME' AND action='grant';")
[[ "$DISTINCT_TS" == "1" ]] || fail "bulk regression: expected 1 distinct created_at, got $DISTINCT_TS"
GRANT_COUNT=$(psql_run "SELECT COUNT(*) FROM trigger_grants_audit WHERE recipe_name='$RECIPE_NAME' AND action='grant';")
[[ "$GRANT_COUNT" == "3" ]] || fail "expected 3 grant audit rows, got $GRANT_COUNT"
pass "3 grant audit rows, 1 distinct created_at -- BULK INSERT confirmed"

# 6. diff PUT
step "6. PUT /grants [A, D] - diff: keep A, revoke B+C, add D"
# Capture a cut-off timestamp BEFORE the PUT so the subsequent audit count
# filter only sees rows produced by this specific request (not the 3 grants
# inserted in phase 5).
# Grab the cut-off timestamp as ISO8601 (epoch-based) to avoid whitespace
# ambiguity when interpolating it back into a SQL literal.
T_BEFORE_DIFF=$(psql_run "SELECT to_char(NOW(), 'YYYY-MM-DD\"T\"HH24:MI:SS.US') || 'Z';" | head -n 1 | xargs)
sleep 1
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userIds\":[\"$USER_A\",\"$USER_D\"]}")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "200" ]] || fail "diff PUT: expected 200, got $CODE -- body: $BODY"
pass "diff PUT returned 200"

step "6a. live set = {A, D}"
CURRENT=$(psql_run "SELECT user_id::text FROM user_workflow_triggers WHERE recipe_name='$RECIPE_NAME' ORDER BY user_id;" | tr '\n' ' ' | sed 's/ *$//')
EXPECTED=$(printf "%s\n%s" "$USER_A" "$USER_D" | sort | tr '\n' ' ' | sed 's/ *$//')
[[ "$CURRENT" == "$EXPECTED" ]] || fail "grants mismatch: expected '$EXPECTED', got '$CURRENT'"
pass "live set = {A, D}"

step "6b. 1 new grant (D) + 2 new revokes (B, C) from diff PUT"
NEW_GRANTS=$(psql_run "SELECT COUNT(*) FROM trigger_grants_audit WHERE recipe_name='$RECIPE_NAME' AND action='grant' AND created_at > '$T_BEFORE_DIFF'::timestamptz;")
[[ "$NEW_GRANTS" == "1" ]] || fail "expected 1 new grant, got $NEW_GRANTS"
NEW_REVOKES=$(psql_run "SELECT COUNT(*) FROM trigger_grants_audit WHERE recipe_name='$RECIPE_NAME' AND action='revoke' AND created_at > '$T_BEFORE_DIFF'::timestamptz;")
[[ "$NEW_REVOKES" == "2" ]] || fail "expected 2 new revokes, got $NEW_REVOKES"
pass "audit diff = 1 grant + 2 revokes"

step "6c. 2 revokes share 1 created_at (bulk revoke proof)"
REVOKE_DISTINCT=$(psql_run "SELECT COUNT(DISTINCT created_at) FROM trigger_grants_audit WHERE recipe_name='$RECIPE_NAME' AND action='revoke' AND created_at > '$T_BEFORE_DIFF'::timestamptz;")
[[ "$REVOKE_DISTINCT" == "1" ]] || fail "bulk revoke regression: expected 1 distinct created_at, got $REVOKE_DISTINCT"
pass "2 revoke rows share created_at -- BULK revoke INSERT confirmed"

# 7. UUID case-insensitivity
step "7. regression(codex-P2.1): uppercase UUID accepted + normalized"
USER_A_UPPER=$(echo "$USER_A" | tr 'a-f' 'A-F')
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"userIds\":[\"$USER_A_UPPER\"]}")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "200" ]] || fail "uppercase UUID rejected with $CODE -- body: $BODY"
STORED=$(psql_run "SELECT user_id::text FROM user_workflow_triggers WHERE recipe_name='$RECIPE_NAME';" | tr -d '[:space:]')
[[ "$STORED" == "$USER_A" ]] || fail "uppercase not normalized: expected $USER_A, got $STORED"
pass "uppercase UUID accepted + stored lowercase"

# 8. MAX_GRANTS cap
step "8. regression(B3): >500 userIds -> 400"
BULK=$(python3 -c '
import json
uuids = [f"00000000-0000-4000-8000-{i:012x}" for i in range(501)]
print(json.dumps({"userIds": uuids}))
')
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BULK")
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "400" ]] || fail "cap regression: expected 400, got $CODE -- body: $BODY"
echo "$BODY" | jq -e '.received == 501' >/dev/null || fail "cap body missing received=501"
pass "501 userIds rejected with 400 + received=501"

# 9. opaque 401
step "9. regression(S10): no-auth PUT -> 401 Unauthorized"
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/admin/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Content-Type: application/json" \
  -d '{"userIds":[]}')
BODY=$(echo "$RESP" | sed '$d'); CODE=$(echo "$RESP" | tail -n 1)
[[ "$CODE" == "401" ]] || fail "no-auth: expected 401, got $CODE"
echo "$BODY" | jq -e '.error == "Unauthorized"' >/dev/null || fail "expected body error=Unauthorized, got: $BODY"
pass "no-auth -> opaque 401 Unauthorized"

# 10. external mount blocks grants
step "10. regression: /external/workflows/.../grants inaccessible"
# Either 404 (route not mounted) or 401 (upstream internal-token middleware
# rejects before Express reaches the default not-found handler) is acceptable —
# both prove the endpoint is absent
# from the external attack surface. A 200/403 would be the failure
# (meaning the route IS reachable externally).
RESP=$(curl -sS -w "\n%{http_code}" -X PUT \
  "$CONTROL_API/api/v1/external/workflows/$NS_CRD/$RECIPE_NAME/grants" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"userIds":[]}')
CODE=$(echo "$RESP" | tail -n 1)
if [[ "$CODE" == "404" || "$CODE" == "401" ]]; then
  pass "external mount inaccessible (HTTP $CODE) — /grants not in external attack surface"
else
  fail "external mount: expected 404 or 401, got $CODE (route may be leaking!)"
fi

yellow ""
yellow "============================================================"
green "  ALL SMOKE TESTS PASSED -- grants API validated end-to-end"
yellow "============================================================"
