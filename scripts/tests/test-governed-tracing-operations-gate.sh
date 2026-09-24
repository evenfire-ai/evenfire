#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/e2e/e2e-governed-tracing-operations.sh"
STUB_CONTEXT='clerum-codex-governed-tracing-test-deadbeef'
STUB_API_URL='http://127.0.0.1:32101'
STUB_UI_URL='http://127.0.0.1:32102'
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

cat >"$TMP_ROOT/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${TEST_CONTEXT:?}"
[[ "${1:-}" == "--context=$TEST_CONTEXT" ]] || exit 90
shift
case "${1:-}" in
  cluster-info) exit 0 ;;
  get)
    [[ "${2:-}" == 'hosts.clerum.io' ]] || exit 91
    # The fourth field is metadata.uid. The script refuses to build a
    # hostLookupReference without one since #693, so a three-field stub would
    # abort the run before any tracing request went out.
    printf 'mcp-host|chatllm|7|3f6b1c28-9d4a-4f51-8c73-2b5e0a91d7ef'
    ;;
  *) exit 92 ;;
esac
STUB

cat >"$TMP_ROOT/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${TEST_API_URL:?}" "${TEST_UI_URL:?}" "${TEST_STATE:?}" "${TEST_CURL_LOG:?}"
: "${TEST_TELEMETRY_LOG:?}"
printf '%s\n' "$*" >>"$TEST_CURL_LOG"

output_file=''
url=''
config_file=''
body_file=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output_file="$2"; shift 2 ;;
    --config) config_file="$2"; shift 2 ;;
    --data-binary) body_file="${2#@}"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done

# The tracing arms answer by what the request actually carries, so the gate
# below can assert which rejection each body earned instead of trusting that
# the script sent the bodies it claims to send.
answer() {
  printf '%s\n' "$1" >>"$TEST_TELEMETRY_LOG"
  printf '%s' "$3" >"$output_file"
  printf '%s' "$2"
}

if [[ -n "$config_file" ]]; then
  [[ -f "$config_file" ]] || exit 93
  printf '%s\n' "$config_file" >>"${TEST_CONFIG_PATHS:?}"
fi

case "$url" in
  "$TEST_API_URL/health" | "$TEST_UI_URL") exit 0 ;;
  "$TEST_API_URL/metrics")
    count=0
    [[ -f "$TEST_STATE" ]] && count="$(cat "$TEST_STATE")"
    printf 'governed_trace_operational_errors_total{scope="agent_run",reason="body_too_large"} %s\n' "$count"
    ;;
  "$TEST_API_URL/api/v1/internal/tracing/agent-run-events")
    printf '1' >"$TEST_STATE"
    printf '{"error":"payload_too_large","maxBytes":524288}' >"$output_file"
    printf '413'
    ;;
  "$TEST_API_URL/api/v1/internal/tracing/infrastructure-telemetry-events")
    [[ -n "$body_file" && -f "$body_file" ]] || exit 98
    if grep -q '"resourceVersion"' "$body_file"; then
      answer unknown-key 400 \
        '{"error":"hostLookupReference carries a key the server does not read","code":"invalid_tracing_input","correlationId":"stub-unknown-key"}'
    elif ! grep -q '"uid":' "$body_file"; then
      answer missing-uid 400 \
        '{"error":"hostLookupReference requires uid","code":"invalid_tracing_input","correlationId":"stub-missing-uid"}'
    else
      # Idempotency is keyed on the request itself, as the server's is on the
      # payload hash: the replay answer has to be earned by resending the same
      # bytes, not by counting how many times this arm was reached.
      seen_file="$TEST_STATE.telemetry-seen"
      digest="$(cksum <"$body_file")"
      if [[ -f "$seen_file" ]] && grep -qxF "$digest" "$seen_file"; then
        answer replay 200 '{"accepted":0,"replayed":1}'
      else
        printf '%s\n' "$digest" >>"$seen_file"
        answer accepted 200 '{"accepted":1,"replayed":0}'
      fi
    fi
    ;;
  "$TEST_API_URL/api/v1/internal/tracing/administrative-events")
    [[ -n "$body_file" && -f "$body_file" ]] || exit 98
    # A sourceStatusRef without the `:uid=` suffix does not parse, so no
    # binding is resolved and the route answers 403 — the retryable refusal
    # that makes the control-api-first rollout order safe (#694).
    if grep -q ':uid=' "$body_file"; then
      answer admin-bound 200 '{"accepted":1,"replayed":0}'
    else
      answer admin-unbound 403 '{"error":"trusted operation binding is unavailable"}'
    fi
    ;;
  *) exit 94 ;;
esac
STUB

cat >"$TMP_ROOT/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${E2E_TRACING_BODY_TOO_LARGE_COUNT:?}" "${E2E_TRACING_BODY_TOO_LARGE_STARTED_AT_MS:?}"
[[ "$E2E_TRACING_BODY_TOO_LARGE_COUNT" == '1' ]] || exit 95
[[ "$E2E_TRACING_BODY_TOO_LARGE_STARTED_AT_MS" =~ ^[0-9]+$ ]] || exit 96
[[ -z "${TEST_NPM_LOG:-}" ]] || exit 97
stub_root="$(cd -- "$(dirname -- "$0")" && pwd)"
printf '%s\n' "$*" >"$stub_root/npm.log"
printf '{"stats":{"expected":1,"skipped":0,"unexpected":0}}\n'
STUB

chmod +x "$TMP_ROOT/kubectl" "$TMP_ROOT/curl" "$TMP_ROOT/npm"
: >"$TMP_ROOT/curl.log"
: >"$TMP_ROOT/config-paths.log"
: >"$TMP_ROOT/telemetry.log"

for unsafe_context in \
  'clerum-test' \
  'gke_your-gcp-project_us-central1-a_example-dev'; do
  if PATH="$TMP_ROOT:$PATH" \
    KUBECONTEXT="$unsafe_context" \
    CONTROL_API_BASE_URL="$STUB_API_URL" \
    CONTROL_UI_BASE_URL="$STUB_UI_URL" \
    bash "$SCRIPT" >"$TMP_ROOT/unsafe-context.out" 2>&1; then
    fail "non-dedicated context was accepted: $unsafe_context"
  fi
  grep -q 'not a dedicated branch/worktree minikube profile' "$TMP_ROOT/unsafe-context.out" || \
    fail "context did not fail with the expected reason: $unsafe_context"
done
pass 'gate rejects shared minikube and example-dev contexts before making requests'

if PATH="$TMP_ROOT:$PATH" \
  KUBECONTEXT="$STUB_CONTEXT" \
  CONTROL_API_BASE_URL='http://127.0.0.1:8090' \
  CONTROL_UI_BASE_URL='http://127.0.0.1:3000' \
  bash "$SCRIPT" >"$TMP_ROOT/shared-ports.out" 2>&1; then
  fail 'shared localhost ports were accepted for a branch profile'
fi
grep -q 'uses shared port' "$TMP_ROOT/shared-ports.out" || \
  fail 'shared ports did not fail with the expected reason'
pass 'gate rejects shared localhost ports for branch-owned profiles'

PATH="$TMP_ROOT:$PATH" \
  TEST_CONTEXT="$STUB_CONTEXT" \
  TEST_API_URL="$STUB_API_URL" \
  TEST_UI_URL="$STUB_UI_URL" \
  TEST_STATE="$TMP_ROOT/metric-count" \
  TEST_CURL_LOG="$TMP_ROOT/curl.log" \
  TEST_TELEMETRY_LOG="$TMP_ROOT/telemetry.log" \
  TEST_CONFIG_PATHS="$TMP_ROOT/config-paths.log" \
  TEST_NPM_LOG='must-not-reach-playwright' \
  E2E_INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET='wrc-test-secret' \
  E2E_INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET='hcc-test-secret' \
  KUBECONTEXT="$STUB_CONTEXT" \
  CONTROL_API_BASE_URL="$STUB_API_URL" \
  CONTROL_UI_BASE_URL="$STUB_UI_URL" \
  bash "$SCRIPT" >"$TMP_ROOT/gate.out" 2>&1

grep -q 'agent-run-events' "$TMP_ROOT/curl.log" || fail 'oversized request was not sent'
grep -q 'infrastructure-telemetry-events' "$TMP_ROOT/curl.log" || \
  fail 'valid post-rejection tracing request was not sent'
# The stub answered each request by reading its body, so this sequence is the
# proof that the script sent a uid-bearing reference, resent the identical
# event, and then sent the two references control-api must refuse. A missing
# arm here means the script stopped exercising a contract the gate claims to
# cover, which no status-code assertion inside the script would reveal.
EXPECTED_TELEMETRY='accepted
replay
missing-uid
unknown-key
admin-unbound'
[[ "$(cat "$TMP_ROOT/telemetry.log")" == "$EXPECTED_TELEMETRY" ]] || \
  fail "tracing arms exercised: $(tr '\n' ',' <"$TMP_ROOT/telemetry.log")"
grep -q -- '--grep operator sees the real oversized tracing rejection prepared by the runtime gate' \
  "$TMP_ROOT/npm.log" || fail 'focused Playwright journey was not launched'
grep -q -- '--reporter=json' "$TMP_ROOT/npm.log" || \
  fail 'focused Playwright journey did not request machine-checkable results'
if grep -q 'wrc-test-secret\|hcc-test-secret' "$TMP_ROOT/curl.log" "$TMP_ROOT/gate.out"; then
  fail 'credential material leaked to command arguments or output'
fi
while IFS= read -r config_path; do
  [[ ! -e "$config_path" ]] || fail 'ephemeral curl auth config was not removed'
done <"$TMP_ROOT/config-paths.log"
pass 'gate proves 413, metric increment, valid ingestion, and focused UI handoff'
pass 'gate proves the uid-bearing replay and the three refusals the object-identity contract requires'
pass 'credentials stay outside browser inputs and are removed with the ephemeral temp directory'
