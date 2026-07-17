#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E — Registry Decoupling
# ═══════════════════════════════════════════════════════════════════════
# Validates the centralized registry split:
#   - evenfire-registry (deployed side-by-side in `registry` namespace)
#     serves both npm-style (/:name, /-/v1/search, /:name/report-install)
#     and OCI-style (/api/v1/entries/...) routes.
#   - clerum control-plane consumers (control-api + workflow-recipes) can
#     reach it via the in-cluster URL, gated by NetworkPolicy.
#   - control-api's POST /api/v1/registry/identity-voucher signs a valid
#     RS256 JWT that the registry can exchange for a bearer token (auth
#     path; deferred wire test since minikube has CLERUM_REGISTRY_AUTH_ENABLED=false).
#   - WRC's clerumRegistryClient URL shape (encodeURIComponent of scoped
#     names) round-trips through the registry's :name route.
#
# Prerequisites:
#   make minikube-setup        # full stack incl. evenfire-registry side-by-side
#   # PFs (minikube path; on GKE set REGISTRY_API to the public URL instead):
#   kubectl --context=clerum-test -n control-plane port-forward svc/control-api 8090:8090 &
#   kubectl --context=clerum-test -n registry      port-forward svc/registry-api 8085:8085 &
#
# Env overrides:
#   KUBECONTEXT          — default clerum-test (allowlist enforced by e2e-lib.sh)
#   CONTROL_API          — default http://127.0.0.1:8090
#   REGISTRY_API         — default http://127.0.0.1:8085
#   REGISTRY_NS          — default registry
#   ADMIN_USER           — default admin
#   ADMIN_PASS           — default changeme123!
#
# Exit: 0 if all checks pass; non-zero with FAIL count otherwise.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

CONTROL_API="${CONTROL_API:-http://127.0.0.1:8090}"
REGISTRY_API="${REGISTRY_API:-http://127.0.0.1:8085}"
REGISTRY_NS="${REGISTRY_NS:-registry}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"

# When the registry is reached off-cluster (e.g. example.com on GKE),
# in-pod probes against the in-cluster URL fail and the registry-side ingress
# NP (registry-api-np) doesn't exist. Skip those checks in external mode.
is_external_registry() {
  [[ "${REGISTRY_API}" != *.svc.cluster.local* ]]
}

# Sample names: pick from the seeded catalog. Defaults to a stable seed entry,
# but auto-discovers a fallback via /-/v1/search at startup so the suite keeps
# working if the seed catalog renames things.
SAMPLE_ENTRY="${SAMPLE_ENTRY:-mcp-brave-search}"
SAMPLE_VERSION="${SAMPLE_VERSION:-1.0.0}"

# Cleanup state — populated as we create probe pods so trap can tear them down
# on Ctrl+C / early exit.
_E2E_PROBE_PODS=()
cleanup_probes() {
  for entry in "${_E2E_PROBE_PODS[@]}"; do
    local ns="${entry%%/*}"
    local name="${entry##*/}"
    kctl -n "$ns" delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
trap cleanup_probes EXIT

# ─── HTTP helpers (no auth — minikube has CLERUM_REGISTRY_AUTH_ENABLED=false) ─
http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

http_body() {
  curl -sf "$@"
}

# Resolve SAMPLE_ENTRY against the live registry. If the env-supplied default
# is missing (e.g. seed changed names), fall back to the first hit from search.
discover_sample_entry() {
  local code
  code=$(http_status "${REGISTRY_API}/${SAMPLE_ENTRY}")
  if [ "$code" = "200" ]; then return 0; fi
  local fallback
  fallback=$(http_body "${REGISTRY_API}/-/v1/search?limit=1" 2>/dev/null \
    | jq -r '.results[0].name // empty')
  if [ -n "$fallback" ]; then
    SAMPLE_ENTRY="$fallback"
    local pack
    pack=$(http_body "${REGISTRY_API}/${SAMPLE_ENTRY}" 2>/dev/null)
    SAMPLE_VERSION=$(echo "$pack" | jq -r '."dist-tags".latest // empty')
    warn "SAMPLE_ENTRY env default not found; auto-discovered ${SAMPLE_ENTRY}@${SAMPLE_VERSION}"
  fi
}

# ─── Section 1: Registry health ──────────────────────────────────────
section_health() {
  header "Section 1: Registry health"

  local code
  code=$(http_status "${REGISTRY_API}/health")
  if [ "$code" = "200" ]; then
    ok "Registry /health returns 200 via port-forward"
  else
    fail "Registry /health expected 200, got $code"
  fi

  local body
  body=$(http_body "${REGISTRY_API}/health" || echo '')
  if echo "$body" | jq -e '.dbConnected == true' >/dev/null 2>&1; then
    ok "Registry reports dbConnected:true"
  else
    fail "Registry health body missing dbConnected:true (body=$body)"
  fi
}

# ─── Section 2: npm-style routes ─────────────────────────────────────
section_npm_routes() {
  header "Section 2: npm-style routes"

  # /-/v1/search ────────────────────────────────────────────────────
  local search_body
  search_body=$(http_body "${REGISTRY_API}/-/v1/search")
  if echo "$search_body" | jq -e '.results | type == "array"' >/dev/null 2>&1; then
    ok "GET /-/v1/search returns {results: [...]} array"
  else
    fail "GET /-/v1/search did not return results array"
  fi

  local total
  total=$(echo "$search_body" | jq -r '.total // 0')
  if [ "$total" -gt 0 ]; then
    ok "GET /-/v1/search returns total > 0 (got $total entries)"
  else
    fail "GET /-/v1/search returned total=0 — registry not seeded?"
  fi

  # Verify the npm SearchResponse shape matches what clerumRegistryClient
  # expects: { results: SearchResult[], total: number }
  if echo "$search_body" | jq -e '.results[0] | has("name") and has("version")' >/dev/null 2>&1; then
    ok "Search results have npm SearchResult shape (name + version)"
  else
    fail "Search results missing name/version fields"
  fi

  # /-/v1/search with query param
  local q_body
  q_body=$(http_body "${REGISTRY_API}/-/v1/search?q=mongo&limit=5")
  if echo "$q_body" | jq -e '.results | length <= 5' >/dev/null 2>&1; then
    ok "GET /-/v1/search?q=mongo&limit=5 honors limit"
  else
    fail "limit=5 did not constrain results"
  fi

  # GET /:name (packument) ──────────────────────────────────────────
  local pack_body
  pack_body=$(http_body "${REGISTRY_API}/${SAMPLE_ENTRY}")
  if echo "$pack_body" | jq -e --arg n "$SAMPLE_ENTRY" '.name == $n' >/dev/null 2>&1; then
    ok "GET /${SAMPLE_ENTRY} returns packument with matching name"
  else
    fail "Packument name mismatch (body=$(echo "$pack_body" | head -c 200))"
  fi

  if echo "$pack_body" | jq -e '."dist-tags".latest' >/dev/null 2>&1; then
    ok "Packument has dist-tags.latest"
  else
    fail "Packument missing dist-tags.latest"
  fi

  if echo "$pack_body" | jq -e --arg v "$SAMPLE_VERSION" '.versions[$v]' >/dev/null 2>&1; then
    ok "Packument versions map contains ${SAMPLE_VERSION}"
  else
    fail "Packument missing versions.${SAMPLE_VERSION}"
  fi

  # GET /:name/:version (manifest) ──────────────────────────────────
  local man_body
  man_body=$(http_body "${REGISTRY_API}/${SAMPLE_ENTRY}/${SAMPLE_VERSION}")
  if echo "$man_body" | jq -e --arg v "$SAMPLE_VERSION" '.version == $v' >/dev/null 2>&1; then
    ok "GET /${SAMPLE_ENTRY}/${SAMPLE_VERSION} returns version manifest"
  else
    fail "Version manifest mismatch"
  fi

  # Encoded scoped names round-trip (the npm convention WRC uses) ───
  # @scope/name → %40scope%2Fname → handled by Express :name param decode
  local enc_code
  enc_code=$(http_status "${REGISTRY_API}/$(printf '%%40acme%%2Fdefinitely-missing')")
  if [ "$enc_code" = "404" ]; then
    ok "GET /%40acme%2Fdefinitely-missing → 404 (URL-encoded scoped name routes correctly)"
  else
    fail "Expected 404 for missing scoped name, got $enc_code"
  fi

  # GET /:name (missing) → 404 ───────────────────────────────────────
  local miss_code
  miss_code=$(http_status "${REGISTRY_API}/this-name-does-not-exist-zzzz")
  if [ "$miss_code" = "404" ]; then
    ok "GET /missing-name → 404"
  else
    fail "Expected 404 for missing name, got $miss_code"
  fi

  # POST /:name/report-install — validation ─────────────────────────
  local ri_url="${REGISTRY_API}/${SAMPLE_ENTRY}/report-install"
  local code_no_corr
  code_no_corr=$(http_status -X POST -H 'Content-Type: application/json' \
    -d "{\"version\":\"${SAMPLE_VERSION}\"}" "$ri_url")
  if [ "$code_no_corr" = "400" ]; then
    ok "POST report-install without correlationId → 400 INVALID_INPUT"
  else
    fail "Expected 400 without correlationId, got $code_no_corr"
  fi

  local code_no_ver
  code_no_ver=$(http_status -X POST -H 'Content-Type: application/json' \
    -d '{"correlationId":"c1"}' "$ri_url")
  if [ "$code_no_ver" = "400" ]; then
    ok "POST report-install without version → 400 INVALID_INPUT"
  else
    fail "Expected 400 without version, got $code_no_ver"
  fi

  # report-install for missing entry+version → 404
  local missing_url="${REGISTRY_API}/this-name-does-not-exist-zzzz/report-install"
  local code_404
  code_404=$(http_status -X POST -H 'Content-Type: application/json' \
    -d '{"correlationId":"c-missing","version":"9.9.9"}' "$missing_url")
  if [ "$code_404" = "404" ]; then
    ok "POST report-install for missing entry → 404"
  else
    fail "Expected 404 for missing entry, got $code_404"
  fi

  # report-install — happy path with idempotency ────────────────────
  local corr_id="e2e-decoupling-$(date +%s)-$$"
  local first_body
  first_body=$(http_body -X POST -H 'Content-Type: application/json' \
    -d "{\"correlationId\":\"${corr_id}\",\"version\":\"${SAMPLE_VERSION}\"}" "$ri_url")
  if echo "$first_body" | jq -e '.acknowledged == true and .stored == true' >/dev/null 2>&1; then
    ok "POST report-install (first time) → acknowledged:true stored:true"
  else
    fail "First report-install did not store (body=$first_body)"
  fi

  local second_body
  second_body=$(http_body -X POST -H 'Content-Type: application/json' \
    -d "{\"correlationId\":\"${corr_id}\",\"version\":\"${SAMPLE_VERSION}\"}" "$ri_url")
  if echo "$second_body" | jq -e '.acknowledged == true and .stored == false' >/dev/null 2>&1; then
    ok "POST report-install (duplicate correlationId) → stored:false (idempotency)"
  else
    fail "Duplicate correlationId not idempotent (body=$second_body)"
  fi
}

# ─── Section 3: OCI-style backward compat ────────────────────────────
section_oci_compat() {
  header "Section 3: OCI-style backward compat (existing /api/v1/entries)"

  local entries
  entries=$(http_body "${REGISTRY_API}/api/v1/entries")
  if echo "$entries" | jq -e '.data | type == "array"' >/dev/null 2>&1; then
    ok "GET /api/v1/entries returns {data: [...]} (OCI shape preserved)"
  else
    fail "OCI /api/v1/entries shape regressed"
  fi

  local oci_v
  oci_v=$(http_body "${REGISTRY_API}/api/v1/entries/${SAMPLE_ENTRY}/versions/${SAMPLE_VERSION}")
  if echo "$oci_v" | jq -e --arg n "$SAMPLE_ENTRY" --arg v "$SAMPLE_VERSION" \
       '.name == $n and .version == $v' >/dev/null 2>&1; then
    ok "GET /api/v1/entries/:name/versions/:version returns the entry"
  else
    fail "OCI single-version endpoint regressed"
  fi
}

# ─── Section 4: NetworkPolicy enforcement ────────────────────────────
# Verifies the egress NPs that allow control-plane pods → registry:8085
# (runtime check) AND that the registry's ingress NP has the expected
# allowlist shape (static manifest check).
#
# Why the static check: a runtime deny-path probe (spin a pod in an
# un-allowed ns and watch it fail) sounds clean but is a tautology in
# practice — every Clerum namespace ships with a default-deny egress
# NP, so the probe gets blocked by SOURCE-side egress before the
# registry's ingress NP is ever evaluated. The static check directly
# inspects the registry-api-np allowlist, so a regression that widens
# (or removes) it would be caught at suite-runtime, not at
# probe-runtime.
section_networkpolicy() {
  header "Section 4: NetworkPolicy enforcement"

  if is_external_registry; then
    log "Skipping in-cluster probes — REGISTRY_API='${REGISTRY_API}' is off-cluster (no registry-api-np to check)."
    # In external mode (example.com on GKE) consumers reach the registry
    # over HTTPS:443 via their *-external-egress NPs — NOT an in-cluster :8085
    # egress NP. The legacy `*-to-in-cluster-registry` NPs were retired in the
    # decoupling (deploy/scripts/cleanup-legacy-in-cluster-registry.sh), so a check
    # for them can never pass. Assert the egress that actually carries external
    # registry traffic. Both NPs live in
    # deploy/base/control-plane/networkpolicies.yaml (present in every cluster).
    # PREFLIGHT — confirm we can actually READ NetworkPolicies before asserting any
    # are "missing". History: a context/auth-plugin/RBAC failure here used to be
    # swallowed (2>/dev/null) and reported as "NP missing" on EVERY deploy, hiding
    # a 5-layer stack (wrong kubecontext, allowlist, gke-gcloud-auth-plugin not
    # installed, RBAC). Surface the real error instead of masking it as "missing".
    local pf_out pf_rc
    pf_out=$(kctl -n control-plane get networkpolicy -o name 2>&1); pf_rc=$?
    if [ "$pf_rc" -ne 0 ]; then
      fail "Cannot READ NetworkPolicies in control-plane (context='${E2E_KUBECONTEXT:-<current>}') — this is NOT a real 'missing' result; the cluster lookup itself errored: $(printf '%s' "$pf_out" | tr '\n' ' ' | head -c 300)"
      return
    fi

    local ext_np_json np_err np_rc
    for np in control-api-external-egress workflow-recipes-external-egress; do
      np_err=$(mktemp)
      ext_np_json=$(kctl -n control-plane get networkpolicy "$np" -o json 2>"$np_err"); np_rc=$?
      if [ "$np_rc" -eq 0 ]; then
        if echo "$ext_np_json" | jq -e '[.spec.egress[].ports[]? | select(.port == 443 and .protocol == "TCP")] | length > 0' >/dev/null; then
          ok "Egress NP '${np}' permits TCP:443 (external registry reachable)"
        else
          fail "Egress NP '${np}' present but does not permit TCP:443 — external registry unreachable"
        fi
      elif grep -qiE 'not[ ]?found' "$np_err"; then
        # Clean NotFound = the NP is genuinely absent (a real regression).
        fail "Egress NP '${np}' is genuinely MISSING — consumer blocked by default-deny"
      else
        # Any other error (permission, context, transient) — do NOT report as
        # "missing"; surface the actual error so it self-diagnoses in one run.
        fail "Could not read Egress NP '${np}' (not a clean NotFound — likely access/transient, NOT a registry fault): $(tr '\n' ' ' < "$np_err" | head -c 300)"
      fi
      rm -f "$np_err"
    done
    return
  fi

  local registry_url="http://registry-api.registry.svc.cluster.local:8085/health"

  # ── Runtime allow paths ────────────────────────────────────────────
  local control_api_pod
  control_api_pod=$(kctl -n control-plane get pods -l app=control-api \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$control_api_pod" ]; then
    fail "control-api pod not found (cluster not deployed?)"
  else
    if kctl -n control-plane exec "$control_api_pod" -- \
         wget -qO- --timeout=5 "$registry_url" 2>/dev/null | jq -e '.status == "ok"' >/dev/null; then
      ok "control-api pod CAN reach registry-api:8085 (egress + ingress NP allow)"
    else
      fail "control-api pod cannot reach registry — egress NP missing?"
    fi
  fi

  local wrc_pod
  wrc_pod=$(kctl -n control-plane get pods -l app=workflow-recipes \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$wrc_pod" ]; then
    fail "workflow-recipes pod not found"
  else
    if kctl -n control-plane exec "$wrc_pod" -- \
         wget -qO- --timeout=5 "$registry_url" 2>/dev/null | jq -e '.status == "ok"' >/dev/null; then
      ok "workflow-recipes pod CAN reach registry-api:8085 (egress + ingress NP allow)"
    else
      fail "workflow-recipes pod cannot reach registry — egress NP missing?"
    fi
  fi

  # ── Static check on registry-side ingress NP ───────────────────────
  # Asserts the allowlist shape: ingress allowed FROM control-plane and
  # mcp-server, on port 8085 only. A future NP edit that widens to (e.g.)
  # `from: []` (open to everyone) or adds an unrelated port would fail.
  local np_json
  np_json=$(kctl -n registry get networkpolicy registry-api-np -o json 2>/dev/null || echo "")
  if [ -z "$np_json" ]; then
    fail "registry-api-np ingress NP missing — registry is open to all namespaces"
    return
  fi
  ok "registry-api-np ingress NP exists in registry namespace"

  local allowed_namespaces
  allowed_namespaces=$(echo "$np_json" | jq -r \
    '[.spec.ingress[].from[]?.namespaceSelector.matchLabels."kubernetes.io/metadata.name" | select(.)] | sort | unique | join(",")')
  if [ "$allowed_namespaces" = "control-plane,mcp-server" ]; then
    ok "registry-api-np allowlist is exactly [control-plane, mcp-server]"
  else
    fail "registry-api-np allowlist drift — got '${allowed_namespaces}', expected 'control-plane,mcp-server'"
  fi

  local allowed_ports
  allowed_ports=$(echo "$np_json" | jq -r \
    '[.spec.ingress[].ports[]?.port] | sort | unique | join(",")')
  if [ "$allowed_ports" = "8085" ]; then
    ok "registry-api-np ingress restricted to port 8085 only"
  else
    fail "registry-api-np port drift — got '${allowed_ports}', expected '8085'"
  fi

  # ── Static check on consumer-side egress NPs (the ones B1 had to ──
  # re-add). These are in clerum's base/control-plane.
  for np in control-api-to-in-cluster-registry workflow-recipes-to-in-cluster-registry; do
    if kctl -n control-plane get networkpolicy "$np" >/dev/null 2>&1; then
      ok "Egress NP '${np}' present in control-plane namespace"
    else
      fail "Egress NP '${np}' missing — consumers will be blocked by default-deny"
    fi
  done
}

# ─── Section 5: Identity voucher endpoint ────────────────────────────
# Validates control-api's POST /api/v1/registry/identity-voucher. In
# minikube, the registry-side voucher exchange isn't exercised (auth is
# off), so this section asserts:
#   - unauthenticated request → 401
#   - admin-authenticated request → 200 + valid RS256 JWT
#   - JWT has iss=control-api, aud=registry-api, jti, exp ~60s
section_voucher() {
  header "Section 5: Identity voucher endpoint"

  # Unauthenticated → 401
  local code
  code=$(http_status -X POST -H 'Content-Type: application/json' \
    -d '{}' "${CONTROL_API}/api/v1/registry/identity-voucher")
  if [ "$code" = "401" ]; then
    ok "POST /api/v1/registry/identity-voucher without auth → 401"
  else
    fail "Expected 401 for unauthenticated voucher request, got $code"
  fi

  # Authenticated → 200 + voucher
  local login_body
  login_body=$(curl -sf -X POST "${CONTROL_API}/api/v1/admin/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" 2>/dev/null || echo "")
  local admin_token
  admin_token=$(echo "$login_body" | jq -r '.token // empty')
  if [ -z "$admin_token" ]; then
    fail "Admin login failed (cannot mint voucher) — check ADMIN_PASS"
    return
  fi
  ok "Admin login succeeded (got session token)"

  local v_body
  v_body=$(curl -sf -X POST -H "Authorization: Bearer ${admin_token}" \
    -H 'Content-Type: application/json' -d '{}' \
    "${CONTROL_API}/api/v1/registry/identity-voucher" 2>/dev/null || echo "")
  local voucher
  voucher=$(echo "$v_body" | jq -r '.voucher // empty')
  if [ -n "$voucher" ]; then
    ok "POST /api/v1/registry/identity-voucher returns a voucher JWT"
  else
    fail "Voucher response missing voucher field (body=$v_body)"
    return
  fi

  # Decode the JWT payload (base64url) — no signature verification here
  # (the public key isn't easily reachable from the test harness); the
  # claim shape + TTL window is what we care about for wire compat.
  local payload_b64 payload
  payload_b64=$(echo "$voucher" | cut -d. -f2)
  # base64url → base64 (pad to multiple of 4)
  while [ $(( ${#payload_b64} % 4 )) -ne 0 ]; do payload_b64="${payload_b64}="; done
  payload_b64=$(echo "$payload_b64" | tr '_-' '/+')
  payload=$(echo "$payload_b64" | base64 -d 2>/dev/null || echo "")
  if [ -z "$payload" ]; then
    fail "Could not decode voucher JWT payload"
    return
  fi

  if echo "$payload" | jq -e '.iss == "control-api"' >/dev/null 2>&1; then
    ok "Voucher claim iss=control-api"
  else
    fail "Voucher iss is not 'control-api' (payload=$payload)"
  fi

  if echo "$payload" | jq -e '.aud == "registry-api"' >/dev/null 2>&1; then
    ok "Voucher claim aud=registry-api"
  else
    fail "Voucher aud is not 'registry-api'"
  fi

  if echo "$payload" | jq -e '.jti | type == "string" and length > 0' >/dev/null 2>&1; then
    ok "Voucher carries a non-empty jti (one-time-use)"
  else
    fail "Voucher missing jti"
  fi

  # v2: iat is dropped (payload is exactly {iss,aud,sub,jti,exp}); TTL is exp - now.
  local now ttl
  now=$(date -u +%s)
  ttl=$(echo "$payload" | jq -r --argjson now "$now" '(.exp - $now) // 0')
  if [ "$ttl" -le 60 ] && [ "$ttl" -gt 0 ]; then
    ok "Voucher TTL within (0, 60]s — got ${ttl}s"
  else
    fail "Voucher TTL out of bounds: ${ttl}s"
  fi

  # v2: payload must NOT carry email/username (INV-1 wire-format rule).
  if echo "$payload" | jq -e 'has("email") or has("username")' >/dev/null 2>&1; then
    fail "Voucher v2 must not carry email/username claims"
  else
    ok "Voucher v2 payload carries no email/username"
  fi

  # v2: header carries a kid (base64url-decode field 1 of the JWT).
  local hdr_b64 hdr
  hdr_b64=$(echo "$voucher" | cut -d. -f1)
  while [ $(( ${#hdr_b64} % 4 )) -ne 0 ]; do hdr_b64="${hdr_b64}="; done
  hdr=$(echo "$hdr_b64" | tr '_-' '/+' | base64 -d 2>/dev/null || echo "")
  if echo "$hdr" | jq -e '.kid | type == "string" and length > 0' >/dev/null 2>&1; then
    ok "Voucher v2 header carries a kid"
  else
    fail "Voucher v2 header missing kid (header=$hdr)"
  fi

  # ── Signature verification ──────────────────────────────────────
  # Prove the voucher was signed with EITHER:
  #   (a) config.registryVoucherPrivateKey (production path), if the dedicated
  #       public key Secret exists, OR
  #   (b) config.adminJwtPrivateKey (fallback path), if the dedicated key isn't
  #       configured.
  # Without this, a regression that signed with a different/wrong key would
  # mint a structurally-valid JWT and pass the claim checks above.
  local tmpdir
  tmpdir=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" RETURN

  # The voucher is signed with EITHER the dedicated voucher key (production —
  # CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY, which the registry verifies with its
  # matching CLERUM_REGISTRY_CONTROL_API_PUBLIC_KEY) OR the admin JWT key (fallback,
  # when no dedicated key is configured). The earlier version only verified against
  # the admin key, so it FALSE-failed every prod deploy (dedicated key in use).
  # We verify against the dedicated voucher pubkey FIRST (derived in-pod from the
  # signing key, the authoritative source — there's no published voucher pubkey
  # ConfigMap in this namespace), then the admin pubkey; pass if EITHER verifies.
  local admin_pub
  admin_pub=$(kctl -n control-plane get configmap control-api-public-key \
    -o jsonpath='{.data.CONTROL_API_PUBLIC_KEY_PEM}' 2>/dev/null || echo "")

  # Verify the signature in the control-api pod (it has jsonwebtoken + the
  # CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY in its env; avoids requiring
  # node/openssl-jose on the test host). Stream voucher + admin key via stdin.
  local ca_pod
  ca_pod=$(kctl -n control-plane get pods -l app=control-api \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$ca_pod" ]; then
    fail "control-api pod not found — cannot verify signature"
    return
  fi
  local sig_ok
  sig_ok=$(printf '%s\n___SEPARATOR___\n%s' "$voucher" "$admin_pub" \
    | kctl -n control-plane exec -i "$ca_pod" -- node -e '
        const jwt = require("jsonwebtoken");
        const crypto = require("crypto");
        const fs = require("fs");
        const input = fs.readFileSync(0, "utf8");
        const sep = "\n___SEPARATOR___\n";
        const idx = input.indexOf(sep);
        const voucher = input.slice(0, idx);
        const adminPub = input.slice(idx + sep.length);
        const opts = { algorithms: ["RS256"], issuer: "control-api", audience: "registry-api" };
        const candidates = [];
        // Production path: dedicated voucher key. Derive its public key from the
        // signing key in the pod env — this is the key the registry trusts.
        const vp = process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY;
        if (vp && vp.trim()) {
          try { candidates.push(["voucher", crypto.createPublicKey(vp).export({ type: "spki", format: "pem" })]); } catch (e) {}
        }
        if (adminPub && adminPub.trim()) candidates.push(["admin", adminPub]);
        let okWith = "";
        for (const [name, key] of candidates) {
          try { jwt.verify(voucher, key, opts); okWith = name; break; } catch (e) {}
        }
        console.log(okWith ? "SIG_OK " + okWith : "SIG_FAIL no configured key (voucher/admin) verified the signature");
      ' 2>&1 || echo "EXEC_FAIL")

  if echo "$sig_ok" | grep -q "^SIG_OK"; then
    ok "Voucher RS256 signature verifies (${sig_ok#SIG_OK } key path)"
  else
    fail "Voucher signature did NOT verify against the voucher or admin key — got: $sig_ok"
  fi
}

# ─── Section 6: clerumRegistryClient wire-format round-trip ──────────
# WRC's clerumRegistryClient.ts URL-encodes entry names via
# encodeURIComponent and uses the npm path layout. Execute the EXACT
# URLs WRC builds from INSIDE the real workflow-recipes pod (so the
# egress NP, DNS, and TLS path mirror prod behavior).
#
# We use `kubectl exec` + `node -e` rather than spinning a probe pod
# because:
#   (a) the WRC pod already has node + fetch (Node 18+); no apt/apk
#       network round-trip is needed at runtime,
#   (b) `kubectl exec` shows stderr (unlike `kubectl run --rm` which
#       swallows it), so failure diagnostics survive,
#   (c) running in the actual pod proves the WRC service-account /
#       NetworkPolicy / DNS path works — not a labeled probe with
#       different RBAC.
section_wrc_wire() {
  header "Section 6: WRC clerumRegistryClient wire-format round-trip"

  local registry_url="${REGISTRY_API}"
  local wrc_pod
  wrc_pod=$(kctl -n control-plane get pods -l app=workflow-recipes \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -z "$wrc_pod" ]; then
    fail "workflow-recipes pod not found — cannot run wire test"
    return
  fi

  # Build the JS payload — uses encodeURIComponent so the URLs match
  # exactly what clerumRegistryClient.ts produces at runtime.
  local node_script
  node_script=$(cat <<JS
(async () => {
  const REG = '${registry_url}';
  const name = '${SAMPLE_ENTRY}';
  const version = '${SAMPLE_VERSION}';
  const enc = encodeURIComponent;
  const checks = [
    { label: 'SEARCH', url: REG + '/-/v1/search?limit=1', check: b => Array.isArray(b.results) },
    { label: 'PACK',   url: REG + '/' + enc(name),       check: b => b.name === name && b['dist-tags'] && b['dist-tags'].latest },
    { label: 'MAN',    url: REG + '/' + enc(name) + '/' + enc(version), check: b => b.version === version },
  ];
  for (const c of checks) {
    try {
      const res = await fetch(c.url);
      if (!res.ok) { console.log(c.label + '_FAIL_HTTP_' + res.status); continue; }
      const body = await res.json();
      console.log(c.check(body) ? c.label + '_OK' : c.label + '_FAIL_SHAPE');
    } catch (e) { console.log(c.label + '_FAIL_ERR_' + (e && e.message || e)); }
  }
})();
JS
)

  local probe_out
  probe_out=$(kctl -n control-plane exec "$wrc_pod" -- node -e "$node_script" 2>&1 || echo "EXEC_FAIL")

  if echo "$probe_out" | grep -q '^SEARCH_OK$'; then
    ok "WRC wire: GET /-/v1/search?limit=1 returns valid {results: [...]}"
  else
    fail "WRC wire: search failed — $(echo "$probe_out" | grep -E 'SEARCH|EXEC' | head -1)"
  fi

  if echo "$probe_out" | grep -q '^PACK_OK$'; then
    ok "WRC wire: GET /<encoded-name> returns packument with dist-tags.latest"
  else
    fail "WRC wire: packument failed — $(echo "$probe_out" | grep -E 'PACK|EXEC' | head -1)"
  fi

  if echo "$probe_out" | grep -q '^MAN_OK$'; then
    ok "WRC wire: GET /<encoded-name>/<version> returns matching version manifest"
  else
    fail "WRC wire: manifest failed — $(echo "$probe_out" | grep -E 'MAN|EXEC' | head -1)"
  fi
}

# ─── Run all sections ────────────────────────────────────────────────
main() {
  log "Context:      $(current_e2e_context)"
  log "Registry URL: ${REGISTRY_API}"
  log "Control API:  ${CONTROL_API}"

  # Resolve sample entry against the live catalog (after health is up).
  section_health
  discover_sample_entry
  log "Sample entry: ${SAMPLE_ENTRY}@${SAMPLE_VERSION}"

  section_npm_routes
  section_oci_compat
  section_networkpolicy
  section_voucher
  section_wrc_wire

  echo
  header "Summary"
  echo -e "  ${GREEN}Passed:${NC} ${e2e_pass}"
  echo -e "  ${RED}Failed:${NC} ${e2e_fail}"
  echo -e "  Total:  ${e2e_total}"

  if [ "$e2e_fail" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
