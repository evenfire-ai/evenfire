#!/usr/bin/env bash
# Proves the governed tracing body-limit signal from a branch-owned minikube
# profile through the existing control-api metrics, admin snapshot, and Control
# UI. This gate does not require or deploy a Prometheus server.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

KCTX="${KUBECONTEXT:-${E2E_K8S_CONTEXT:-}}"
CONTROL_API_URL="${CONTROL_API_BASE_URL:-${CONTROL_API_URL:-}}"
CONTROL_UI_URL="${CONTROL_UI_BASE_URL:-${CONTROL_UI_URL:-}}"
BODY_LIMIT_BYTES=524288
PLAYWRIGHT_TEST='operator sees the real oversized tracing rejection prepared by the runtime gate'

log() { printf '[governed-tracing-operations] %s\n' "$*"; }
die() {
  printf '[governed-tracing-operations] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

require_loopback_url() {
  local name="$1"
  local value="${2%/}"
  if [[ ! "$value" =~ ^http://(127\.0\.0\.1|localhost):[0-9]{2,5}$ ]]; then
    die "$name must be an explicit loopback URL with a profile-owned port"
  fi
}

reject_shared_port() {
  local name="$1"
  local value="${2%/}"
  local shared_port="$3"
  if [[ "$value" =~ :${shared_port}$ ]]; then
    die "$name uses shared port $shared_port instead of a branch-profile port"
  fi
}

[[ -n "$KCTX" ]] || die 'set KUBECONTEXT or E2E_K8S_CONTEXT explicitly'
case "$KCTX" in
  clerum-codex-* | clerum-detached-*) ;;
  *) die "context $KCTX is not a dedicated branch/worktree minikube profile" ;;
esac
[[ -n "$CONTROL_API_URL" ]] || die 'set CONTROL_API_BASE_URL from the profile ports.env'
[[ -n "$CONTROL_UI_URL" ]] || die 'set CONTROL_UI_BASE_URL from the profile ports.env'
CONTROL_API_URL="${CONTROL_API_URL%/}"
CONTROL_UI_URL="${CONTROL_UI_URL%/}"
require_loopback_url CONTROL_API_BASE_URL "$CONTROL_API_URL"
require_loopback_url CONTROL_UI_BASE_URL "$CONTROL_UI_URL"
reject_shared_port CONTROL_API_BASE_URL "$CONTROL_API_URL" 8090
reject_shared_port CONTROL_UI_BASE_URL "$CONTROL_UI_URL" 3000

for command_name in curl kubectl node npm; do
  require_command "$command_name"
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/clerum-governed-tracing-operations.XXXXXX")"
AUTH_CONFIG="$TMP_ROOT/curl-auth.conf"
OVERSIZED_BODY="$TMP_ROOT/oversized.json"
VALID_BODY="$TMP_ROOT/valid.json"
RESPONSE_BODY="$TMP_ROOT/response.json"
PLAYWRIGHT_RESULT="$TMP_ROOT/playwright-result.json"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

write_auth_config() {
  local token="$1"
  chmod 700 "$TMP_ROOT"
  printf 'header = "Authorization: Bearer %s"\n' "$token" >"$AUTH_CONFIG"
  chmod 600 "$AUTH_CONFIG"
}

read_body_limit_count() {
  local metrics count
  metrics="$(curl --disable --fail --silent --show-error --max-time 10 "$CONTROL_API_URL/metrics")"
  count="$({
    printf '%s\n' "$metrics" | awk '
      $1 ~ /^governed_trace_operational_errors_total\{/ &&
      $1 ~ /scope="agent_run"/ &&
      $1 ~ /reason="body_too_large"/ { print $2; found = 1 }
      END { if (!found) print 0 }
    '
  })"
  [[ "$count" =~ ^[0-9]+$ ]] || die "body-limit metric is not an integer: $count"
  printf '%s' "$count"
}

post_json() {
  local url="$1"
  local body_file="$2"
  curl --disable --config "$AUTH_CONFIG" \
    --silent --show-error --max-time 30 \
    --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --request POST --header 'Content-Type: application/json' \
    --data-binary "@$body_file" "$url"
}

assert_oversized_response() {
  node - "$RESPONSE_BODY" "$BODY_LIMIT_BYTES" <<'NODE'
const fs = require('node:fs')
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const expectedMax = Number(process.argv[3])
if (body.error !== 'payload_too_large' || body.maxBytes !== expectedMax) {
  throw new Error(`unexpected oversized response: ${JSON.stringify(body)}`)
}
NODE
}

assert_valid_ingestion_response() {
  node - "$RESPONSE_BODY" <<'NODE'
const fs = require('node:fs')
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (body.accepted !== 1 || body.replayed !== 0) {
  throw new Error(`unexpected valid-ingestion response: ${JSON.stringify(body)}`)
}
NODE
}

log "preflight context=$KCTX control-api=$CONTROL_API_URL control-ui=$CONTROL_UI_URL"
kubectl --context="$KCTX" cluster-info >/dev/null
curl --disable --fail --silent --show-error --max-time 10 "$CONTROL_API_URL/health" >/dev/null
curl --disable --fail --silent --show-error --max-time 10 "$CONTROL_UI_URL" >/dev/null

export K8S_CONTEXT="$KCTX"
# Resolved relative to this script at runtime.
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib/internal-control-jwt.sh"

node - "$OVERSIZED_BODY" "$BODY_LIMIT_BYTES" <<'NODE'
const fs = require('node:fs')
const target = process.argv[2]
const limit = Number(process.argv[3])
const body = JSON.stringify({ events: [{ payload: 'x'.repeat(limit) }] })
if (Buffer.byteLength(body) <= limit) throw new Error('oversized fixture did not exceed the limit')
fs.writeFileSync(target, body, { mode: 0o600 })
NODE

WRC_TOKEN="$(sign_internal_control_jwt wrc)"
[[ -n "$WRC_TOKEN" ]] || die 'could not mint the WRC InternalControl JWT'
write_auth_config "$WRC_TOKEN"
unset WRC_TOKEN

COUNT_BEFORE="$(read_body_limit_count)"
REQUEST_STARTED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
STATUS="$(post_json "$CONTROL_API_URL/api/v1/internal/tracing/agent-run-events" "$OVERSIZED_BODY")"
[[ "$STATUS" == '413' ]] || die "oversized authenticated request returned HTTP $STATUS instead of 413"
assert_oversized_response
COUNT_AFTER="$(read_body_limit_count)"
[[ "$COUNT_AFTER" -eq $((COUNT_BEFORE + 1)) ]] || \
  die "body-limit metric changed from $COUNT_BEFORE to $COUNT_AFTER; expected exactly one increment"
log "authenticated 413 incremented the existing body-limit metric to $COUNT_AFTER"

HOST_RECORD="$(
  kubectl --context="$KCTX" get hosts.clerum.io -A \
    -o jsonpath='{.items[0].metadata.namespace}{"|"}{.items[0].metadata.name}{"|"}{.items[0].metadata.generation}'
)"
IFS='|' read -r HOST_NAMESPACE HOST_NAME HOST_GENERATION <<<"$HOST_RECORD"
[[ -n "$HOST_NAMESPACE" && -n "$HOST_NAME" ]] || die 'the profile has no Host for valid tracing ingestion'
[[ "$HOST_GENERATION" =~ ^[1-9][0-9]*$ ]] || die 'the selected Host has no valid generation'

node - "$VALID_BODY" "$HOST_NAMESPACE" "$HOST_NAME" "$HOST_GENERATION" "$REQUEST_STARTED_AT_MS" <<'NODE'
const fs = require('node:fs')
const [target, namespace, name, generation, startedAt] = process.argv.slice(2)
const body = {
  events: [
    {
      telemetryType: 'health_transition',
      sourceEventId: `e2e-governed-tracing-operations-${startedAt}`,
      occurredAt: new Date().toISOString(),
      hostLookupReference: { namespace, name, generation: Number(generation) },
    },
  ],
}
fs.writeFileSync(target, JSON.stringify(body), { mode: 0o600 })
NODE

HCC_TOKEN="$(sign_internal_control_jwt hcc)"
[[ -n "$HCC_TOKEN" ]] || die 'could not mint the HCC InternalControl JWT'
write_auth_config "$HCC_TOKEN"
unset HCC_TOKEN
STATUS="$(post_json "$CONTROL_API_URL/api/v1/internal/tracing/infrastructure-telemetry-events" "$VALID_BODY")"
[[ "$STATUS" == '200' ]] || die "valid tracing request returned HTTP $STATUS instead of 200"
assert_valid_ingestion_response
[[ "$(read_body_limit_count)" == "$COUNT_AFTER" ]] || \
  die 'valid tracing unexpectedly changed the body-limit error count'
log "valid tracing ingestion succeeded immediately after the rejected request"

# The browser receives only the non-sensitive count and timestamp. Delete the
# authenticated-request artifacts and launch Playwright with a minimal env.
rm -f "$AUTH_CONFIG" "$OVERSIZED_BODY" "$VALID_BODY" "$RESPONSE_BODY"

log 'launching the focused Control UI operator journey'
(
  cd "$REPO_ROOT/control-ui"
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    CONTROL_UI_URL="$CONTROL_UI_URL" \
    E2E_TRACING_BODY_TOO_LARGE_COUNT="$COUNT_AFTER" \
    E2E_TRACING_BODY_TOO_LARGE_STARTED_AT_MS="$REQUEST_STARTED_AT_MS" \
    npm exec --offline -- playwright test e2e/governed-trace-cost-operator-journey.spec.ts \
      --grep "$PLAYWRIGHT_TEST" --project=chromium --reporter=json >"$PLAYWRIGHT_RESULT"
)

node - "$PLAYWRIGHT_RESULT" <<'NODE'
const fs = require('node:fs')
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const stats = report.stats || {}
if (stats.expected !== 1 || stats.skipped !== 0 || stats.unexpected !== 0) {
  throw new Error(`focused Playwright journey did not pass exactly once: ${JSON.stringify(stats)}`)
}
NODE

log 'PASS: 413, existing metric, valid ingestion, admin snapshot, and Control UI agree'
