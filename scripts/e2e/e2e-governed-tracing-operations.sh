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
MISSING_UID_BODY="$TMP_ROOT/missing-uid.json"
UNKNOWN_KEY_BODY="$TMP_ROOT/unknown-key.json"
LEGACY_STATUS_REF_BODY="$TMP_ROOT/legacy-status-ref.json"
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

assert_ingestion_counts() {
  node - "$RESPONSE_BODY" "$1" "$2" <<'NODE'
const fs = require('node:fs')
const [target, accepted, replayed] = process.argv.slice(2)
const body = JSON.parse(fs.readFileSync(target, 'utf8'))
if (body.accepted !== Number(accepted) || body.replayed !== Number(replayed)) {
  throw new Error(
    `expected accepted:${accepted} replayed:${replayed}, got ${JSON.stringify(body)}`
  )
}
NODE
}

# A 400 only proves the request was refused; the code proves it was refused by
# the tracing input validation reached through the real route, which is the
# signal HCC keys its terminal-versus-retryable decision on (#693).
assert_rejection_code() {
  node - "$RESPONSE_BODY" "$1" <<'NODE'
const fs = require('node:fs')
const [target, expected] = process.argv.slice(2)
const body = JSON.parse(fs.readFileSync(target, 'utf8'))
if (body.code !== expected) {
  throw new Error(`expected code ${expected}, got ${JSON.stringify(body)}`)
}
NODE
}

# The administrative 403 carries no machine-readable code, so the message is
# what tells a refused binding from a refused credential. Without it an
# authentication failure would satisfy the same status assertion.
assert_rejection_message() {
  node - "$RESPONSE_BODY" "$1" <<'NODE'
const fs = require('node:fs')
const [target, expected] = process.argv.slice(2)
const body = JSON.parse(fs.readFileSync(target, 'utf8'))
if (typeof body.error !== 'string' || !body.error.includes(expected)) {
  throw new Error(`expected an error mentioning ${expected}, got ${JSON.stringify(body)}`)
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
    -o jsonpath='{.items[0].metadata.namespace}{"|"}{.items[0].metadata.name}{"|"}{.items[0].metadata.generation}{"|"}{.items[0].metadata.uid}'
)"
IFS='|' read -r HOST_NAMESPACE HOST_NAME HOST_GENERATION HOST_UID <<<"$HOST_RECORD"
[[ -n "$HOST_NAMESPACE" && -n "$HOST_NAME" ]] || die 'the profile has no Host for valid tracing ingestion'
[[ "$HOST_GENERATION" =~ ^[1-9][0-9]*$ ]] || die 'the selected Host has no valid generation'
# The uid is mandatory since #693: namespace/name/generation alone can name a
# Host and its same-name successor, so control-api refuses the reference.
[[ "$HOST_UID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || \
  die 'the selected Host has no valid metadata.uid'

write_host_telemetry_body() {
  node - "$1" "$HOST_NAMESPACE" "$HOST_NAME" "$HOST_GENERATION" "$HOST_UID" \
    "$REQUEST_STARTED_AT_MS" "$2" "$3" <<'NODE'
const fs = require('node:fs')
const [target, namespace, name, generation, uid, startedAt, suffix, variant] =
  process.argv.slice(2)
const reference = { namespace, name, generation: Number(generation), uid }
// A misspelled variant would otherwise write the valid body and the caller
// would assert a rejection against a request that deserves none.
if (!['full', 'missing-uid', 'unknown-key'].includes(variant)) {
  throw new Error(`unknown hostLookupReference variant: ${variant}`)
}
if (variant === 'missing-uid') delete reference.uid
if (variant === 'unknown-key') reference.resourceVersion = '1'
const body = {
  events: [
    {
      telemetryType: 'health_transition',
      sourceEventId: `e2e-governed-tracing-operations-${startedAt}${suffix}`,
      occurredAt: new Date().toISOString(),
      hostLookupReference: reference,
    },
  ],
}
fs.writeFileSync(target, JSON.stringify(body), { mode: 0o600 })
NODE
}

write_host_telemetry_body "$VALID_BODY" '' 'full'
write_host_telemetry_body "$MISSING_UID_BODY" '-missing-uid' 'missing-uid'
write_host_telemetry_body "$UNKNOWN_KEY_BODY" '-unknown-key' 'unknown-key'

node - "$LEGACY_STATUS_REF_BODY" "$HOST_NAMESPACE" "$HOST_NAME" "$HOST_GENERATION" \
  "$REQUEST_STARTED_AT_MS" <<'NODE'
const fs = require('node:fs')
const [target, namespace, name, generation, startedAt] = process.argv.slice(2)
// The pre-#694 sourceStatusRef, without the `:uid=` suffix. It needs no
// durable intent: the reference never parses, so the binding is refused first.
const body = {
  events: [
    {
      kind: 'linked_outcome',
      sourceEventId: `e2e-governed-tracing-operations-${startedAt}-legacy-status-ref`,
      occurredAt: new Date().toISOString(),
      reasonCode: 'e2e_legacy_status_ref',
      sourceStatusRef: `host:${namespace}/${name}:generation=${generation}`,
      payload: { resource_class: 'Host', status: 'succeeded' },
    },
  ],
}
fs.writeFileSync(target, JSON.stringify(body), { mode: 0o600 })
NODE

HCC_TOKEN="$(sign_internal_control_jwt hcc)"
[[ -n "$HCC_TOKEN" ]] || die 'could not mint the HCC InternalControl JWT'
write_auth_config "$HCC_TOKEN"
unset HCC_TOKEN
TELEMETRY_URL="$CONTROL_API_URL/api/v1/internal/tracing/infrastructure-telemetry-events"
STATUS="$(post_json "$TELEMETRY_URL" "$VALID_BODY")"
[[ "$STATUS" == '200' ]] || die "valid tracing request returned HTTP $STATUS instead of 200"
assert_ingestion_counts 1 0
[[ "$(read_body_limit_count)" == "$COUNT_AFTER" ]] || \
  die 'valid tracing unexpectedly changed the body-limit error count'
log "valid tracing ingestion succeeded immediately after the rejected request"

# A 200 alone would also come back if the row were stored under some other
# identity. Resending the identical event proves the stored identity is the one
# the uid-bearing reference produces: the server recognises it as a replay.
STATUS="$(post_json "$TELEMETRY_URL" "$VALID_BODY")"
[[ "$STATUS" == '200' ]] || die "replayed tracing request returned HTTP $STATUS instead of 200"
assert_ingestion_counts 0 1
log 'resending the identical event was recorded as a replay, not a second row'

STATUS="$(post_json "$TELEMETRY_URL" "$MISSING_UID_BODY")"
[[ "$STATUS" == '400' ]] || die "hostLookupReference without uid returned HTTP $STATUS instead of 400"
assert_rejection_code invalid_tracing_input
log 'hostLookupReference without uid was refused as invalid_tracing_input'

STATUS="$(post_json "$TELEMETRY_URL" "$UNKNOWN_KEY_BODY")"
[[ "$STATUS" == '400' ]] || \
  die "hostLookupReference with an unknown key returned HTTP $STATUS instead of 400"
assert_rejection_code invalid_tracing_input
log 'hostLookupReference with an unknown key was refused as invalid_tracing_input'

# The administrative route refuses an unparseable reference with 403
# `tracing_binding_unavailable`, which HCC retries rather than dropping: that is
# what makes the control-api-first rollout order safe (#694). The paired
# positive — the same outcome with `:uid=` binding and storing — needs a durable
# administrative intent that this lane does not create, so it lives in
# control-api/test/routes.tracingSubmissionBoundary.test.ts against the real
# router. Here the message assertion below is what separates a refused binding
# from a refused credential.
STATUS="$(
  post_json "$CONTROL_API_URL/api/v1/internal/tracing/administrative-events" \
    "$LEGACY_STATUS_REF_BODY"
)"
[[ "$STATUS" == '403' ]] || \
  die "sourceStatusRef without :uid= returned HTTP $STATUS instead of 403"
assert_rejection_message 'trusted operation binding is unavailable'
log 'administrative outcome with the pre-uid sourceStatusRef was refused with 403'

# The browser receives only the non-sensitive count and timestamp. Delete the
# authenticated-request artifacts and launch Playwright with a minimal env.
rm -f "$AUTH_CONFIG" "$OVERSIZED_BODY" "$VALID_BODY" "$MISSING_UID_BODY" \
  "$UNKNOWN_KEY_BODY" "$LEGACY_STATUS_REF_BODY" "$RESPONSE_BODY"

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

log 'PASS: 413, metric, uid-bound ingestion, replay, both reference rejections, the administrative 403, and the Control UI agree'
