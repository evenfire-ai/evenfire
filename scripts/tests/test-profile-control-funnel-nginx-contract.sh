#!/usr/bin/env bash
# Pins the public surface of the profile-control-funnel nginx (the hop between
# external-rest-api and control-api). Everything not listed here must stay 403.
#
# The remote MCP-OAuth CIMD client_id is <public origin>/api/v1/.well-known/evenfire-mcp-client
# (control-api/src/oauth/cimdIdentity.ts). A remote Authorization Server fetches it
# through external-rest-api and this funnel, so the funnel must forward that exact
# path, read-only, and nothing broader under /.well-known/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${1:-${ROOT}/deploy/base/profiles/configmaps.yaml}"
CIMD_PATH='/api/v1/.well-known/evenfire-mcp-client'

failed=0
fail() {
  echo "FAIL: $*" >&2
  failed=1
}

# Print the body of the first nginx block whose opening line matches $1 exactly
# (after trimming leading whitespace), up to its matching closing brace.
block_of() {
  awk -v want="$1" '
    !inside {
      line = $0
      sub(/^[ \t]+/, "", line)
      if (line == want) { inside = 1; depth = 1; next }
      next
    }
    {
      line = $0
      depth += gsub(/\{/, "", line)
      depth -= gsub(/\}/, "", line)
      if (depth == 0) exit
      print
    }
  ' "${CONFIG}"
}

[[ -f "${CONFIG}" ]] || {
  echo "FAIL: missing ${CONFIG}" >&2
  exit 1
}

# 1. Exact-match CIMD location, GET/HEAD only, fixed upstream URI.
cimd_block="$(block_of "location = ${CIMD_PATH} {")"
if [[ -z "${cimd_block}" ]]; then
  fail "no exact-match 'location = ${CIMD_PATH}' block"
else
  grep -Eq '^[[:space:]]*limit_except GET \{' <<<"${cimd_block}" ||
    fail "CIMD location must restrict methods with 'limit_except GET'"
  grep -Eq '^[[:space:]]*deny all;' <<<"${cimd_block}" ||
    fail "CIMD location limit_except must 'deny all'"
  grep -Fq "proxy_pass http://\$control_api_origin${CIMD_PATH};" <<<"${cimd_block}" ||
    fail "CIMD location must proxy to the fixed control-api CIMD path"
  if grep -Fq '$request_uri' <<<"${cimd_block}"; then
    fail "CIMD location must not forward the caller's request URI or query"
  fi
fi

# 2. No other location may expose anything under /.well-known/.
other_well_known="$(grep -E '^[[:space:]]*location[[:space:]]' "${CONFIG}" |
  grep -F '.well-known' |
  grep -vF "location = ${CIMD_PATH} {" || true)"
if [[ -n "${other_well_known}" ]]; then
  fail "unexpected /.well-known location(s): ${other_well_known}"
fi

# 3. The existing public surface and the deny-all fallback stay in place.
grep -Eq '^[[:space:]]*location ~ \^/api/v1/external/ \{' "${CONFIG}" ||
  fail "missing /api/v1/external/ location"
grep -Eq '^[[:space:]]*location ~ \^/api/v1/oauth-callback/ \{' "${CONFIG}" ||
  fail "missing /api/v1/oauth-callback/ location"
fallback_block="$(block_of 'location / {')"
grep -Eq '^[[:space:]]*return 403;' <<<"${fallback_block}" ||
  fail "fallback 'location /' must return 403"

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi
echo "PASS: profile-control-funnel nginx public surface"
