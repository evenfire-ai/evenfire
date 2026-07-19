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
    printf 'mcp-host|chatllm|7'
    ;;
  *) exit 92 ;;
esac
STUB

cat >"$TMP_ROOT/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${TEST_API_URL:?}" "${TEST_UI_URL:?}" "${TEST_STATE:?}" "${TEST_CURL_LOG:?}"
printf '%s\n' "$*" >>"$TEST_CURL_LOG"

output_file=''
url=''
config_file=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output_file="$2"; shift 2 ;;
    --config) config_file="$2"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done

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
    printf '{"accepted":1,"replayed":0}' >"$output_file"
    printf '200'
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
pass 'credentials stay outside browser inputs and are removed with the ephemeral temp directory'
