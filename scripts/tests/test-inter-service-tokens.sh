#!/usr/bin/env bash
set -euo pipefail

# Tests for deploy/scripts/apply-inter-service-tokens.sh and
# deploy/scripts/apply-workflow-approval-bot-secret.sh against a fake kubectl
# that keeps Secrets in a directory store ($KUBE_STORE/<ns>/<secret>/<key>).
# Merge patches write into the store, so a second run sees the first run's
# values exactly as it would in a cluster.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/inter-service-tokens-test.$$"
mkdir -p "$TMP/bin"
# On an unexpected exit (a script crash under `set -e`), show the last run's
# output before the store is removed.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "--- last run stdout/stderr (exit $rc) ---" >&2
    cat "$TMP/stdout" "$TMP/stderr" >&2 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap on_exit EXIT

# Runs must not inherit overrides from the caller's environment.
unset FORCE_CONSUMER_RESTART CONTROL_API_INTERNAL_TOKEN_EXT_REST CONTROL_API_INTERNAL_TOKEN_RPC \
  CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY CONTROL_API_INTERNAL_TOKEN_WA_READER \
  CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY \
  CHANNEL_READER_HANDOFF_TOKEN CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET CONTEXT

TOKENS_SCRIPT="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
BOT_SECRET_SCRIPT="$ROOT/deploy/scripts/apply-workflow-approval-bot-secret.sh"

HCC_OLD="aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
HCC_NEW="ff00ee11dd22cc33bb44aa5566778899ff00ee11dd22cc33bb44aa5566778899"
WRC_OLD="1111111111111111111111111111111111111111111111111111111111111111"
WRC_NEW="2222222222222222222222222222222222222222222222222222222222222222"
ROTATED="3333333333333333333333333333333333333333333333333333333333333333"
MEMBER_HMAC="test-member-registration-hmac"

ALL_TOKEN_CONSUMERS=(
  control-plane/control-api
  control-plane/codex-llm-proxy
  control-plane/grok-llm-proxy
  control-plane/workflow-recipes
  control-plane/host-context-controller
  profiles/external-rest-api
  rpc-proxy/rpc-proxy
  webhook-ingress/webhook-proxy
  channels/clerum-workflow-approval-request-reader
  channels/app=channel-reader
)
TOKEN_SECRETS=(
  control-plane/control-api-internal-tokens
  control-plane/internal-control-jwt-secrets
  control-plane/codex-llm-proxy-secrets
  control-plane/grok-llm-proxy-secrets
  profiles/external-rest-api-secrets
  rpc-proxy/rpc-proxy-secrets
  webhook-ingress/webhook-proxy-secrets
  channels/workflow-approval-request-reader-credentials
)

cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "rand" && "${2:-}" == "-hex" ]]; then
  count_file="${OPENSSL_RAND_COUNT_FILE:?}"
  count=0
  if [[ -s "$count_file" ]]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  # Offset by a per-run salt so two runs never generate the same value.
  printf '%064x\n' "$(( ${OPENSSL_RAND_SALT:-0} * 1000 + count ))"
  exit 0
fi
echo "unexpected openssl invocation" >&2
exit 1
SH

cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
store="${KUBE_STORE:?}"
args=("$@")
# Every call must name the context the script was given, never the current one.
if [[ "${args[0]:-}" != "--context" || "${args[1]:-}" != "${CONTEXT:?}" ]]; then
  echo "fake kubectl: expected --context ${CONTEXT}, got: $*" >&2
  exit 9
fi
args=("${args[@]:2}")
ns=""
if [[ "${args[0]:-}" == "-n" ]]; then
  ns="${args[1]}"
  args=("${args[@]:2}")
fi
case "${args[0]:-}" in
  get)
    case "${args[1]:-}" in
      ns) exit 0 ;;
      secret)
        name="${args[2]:?}"
        output=""
        for ((i=0; i<${#args[@]}; i++)); do
          if [[ "${args[$i]}" == "-o" ]]; then
            output="${args[$((i+1))]:-}"
          fi
        done
        [[ -d "$store/$ns/$name" ]] || exit 1
        case "$output" in
          "") exit 0 ;;
          json) printf '%s\n' '{"data":{}}'; exit 0 ;;
          jsonpath=\{.data.*\})
            key="${output#jsonpath=\{.data.}"
            key="${key%\}}"
            if [[ -f "$store/$ns/$name/$key" ]]; then
              base64 < "$store/$ns/$name/$key" | tr -d '\n'
            fi
            exit 0
            ;;
        esac
        echo "fake kubectl: unsupported get secret output '$output'" >&2
        exit 2
        ;;
      deploy|deployment)
        [[ "${KUBE_DEPLOY_EXISTS:-}" == "1" ]] && exit 0
        exit 1
        ;;
    esac
    ;;
  create)
    if [[ "${args[1]:-}" == "secret" && "${args[2]:-}" == "generic" ]]; then
      mkdir -p "$store/$ns/${args[3]:?}"
    fi
    exit 0
    ;;
  patch)
    if [[ "${args[1]:-}" == "secret" ]]; then
      name="${args[2]:?}"
      patch=""
      merge=false
      for ((i=0; i<${#args[@]}; i++)); do
        case "${args[$i]}" in
          -p) patch="${args[$((i+1))]}" ;;
          --type=merge) merge=true ;;
        esac
      done
      if [[ "$merge" == "true" ]]; then
        [[ -d "$store/$ns/$name" ]] || { echo "fake kubectl: secret $ns/$name not found" >&2; exit 1; }
        while IFS=$'\t' read -r key value; do
          printf '%s' "$value" | base64 --decode > "$store/$ns/$name/$key"
        done < <(printf '%s' "$patch" | jq -r '.stringData | to_entries[] | "\(.key)\t\(.value | @base64)"')
        printf '%s/%s\n' "$ns" "$name" >> "${PATCH_LOG:?}"
        if [[ "$ns" == "control-plane" && "$name" == "control-api-internal-tokens" && -n "${CAPTURE_FILE:-}" ]]; then
          printf '%s' "$patch" > "$CAPTURE_FILE"
        fi
      fi
    fi
    exit 0
    ;;
  rollout)
    if [[ "${args[1]:-}" == "restart" ]]; then
      printf '%s %s\n' "$ns" "${args[*]}" >> "${ROLLOUT_LOG:?}"
    fi
    exit 0
    ;;
esac
exit 0
SH

chmod +x "$TMP/bin/openssl" "$TMP/bin/kubectl"

mkdir -p "$TMP/sibling/scripts/minikube"
printf '%s\n' 'DEV_HMAC_SECRET="dev-member-registration-hmac-secret"' \
  > "$TMP/sibling/scripts/minikube/deploy-evenfire-member-registration.sh"

fail() {
  echo "FAIL: $*" >&2
  echo "--- stderr of the last run ---" >&2
  cat "$TMP/stderr" >&2 || true
  exit 1
}

new_store() {
  rm -rf "$TMP/store"
  mkdir -p "$TMP/store"
}

store_set() {
  local ns="$1" secret="$2" key="$3" value="$4"
  mkdir -p "$TMP/store/$ns/$secret"
  printf '%s' "$value" > "$TMP/store/$ns/$secret/$key"
}

store_get() {
  cat "$TMP/store/$1/$2/$3"
}

store_delete() {
  rm -f "$TMP/store/$1/$2/$3"
}

# Replace one caller's entry in control-api's stored service-token map.
store_set_map_entry() {
  local name="$1" value="$2" map entry out="" found=false entries=()
  map="$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS)"
  IFS=',' read -r -a entries <<<"$map"
  for entry in "${entries[@]}"; do
    if [[ "${entry%%=*}" == "$name" ]]; then
      entry="$name=$value"
      found=true
    fi
    out="${out:+$out,}$entry"
  done
  [[ "$found" == "true" ]] || fail "map entry $name not found"
  store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS "$out"
}

RUN_SALT=0
# run_script <script> <rollout-log> [capture-file] -- env [VAR=value | -u VAR]...
run_script() {
  local script="$1" rollout="$2" capture="$3"
  shift 3
  RUN_SALT=$((RUN_SALT + 1))
  : > "$rollout"
  : > "$TMP/patches.log"
  : > "$TMP/openssl-rand-count"
  CAPTURE_FILE="$capture" ROLLOUT_LOG="$rollout" PATCH_LOG="$TMP/patches.log" \
    KUBE_STORE="$TMP/store" KUBE_DEPLOY_EXISTS=1 PATH="$TMP/bin:$PATH" \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" OPENSSL_RAND_SALT="$RUN_SALT" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$script" >"$TMP/stdout" 2>"$TMP/stderr"
}

# run_tokens <context> <rollout-log> [capture-file] env ...
run_tokens() {
  local context="$1" rollout="$2" capture="$3"
  shift 3
  run_script "$TOKENS_SCRIPT" "$rollout" "$capture" "$@" CONTEXT="$context"
}

run_bot_secret() {
  local rollout="$1"
  shift
  run_script "$BOT_SECRET_SCRIPT" "$rollout" "" "$@" CONTEXT=gke-dev
}

assert_no_secret_material() {
  local log
  for log in "$TMP/stdout" "$TMP/stderr"; do
    # Every token in these tests is 64 hex characters (fixtures and the fake
    # openssl), as are real `openssl rand -hex 32` tokens.
    if grep -E '[0-9a-f]{64}|member-registration-hmac' "$log" >/dev/null; then
      echo "secret material leaked into $log" >&2
      cat "$log" >&2
      exit 1
    fi
  done
}

# assert_restarted_exactly <rollout-log> [<ns>/<deployment-or-selector>]...
assert_restarted_exactly() {
  local rollout="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@" | sed '/^$/d' | sort)"
  actual="$(awk '{print $1 "/" $NF}' "$rollout" | sort)"
  if [[ "$expected" != "$actual" ]]; then
    fail "restarted consumers differ
expected:
${expected:-<none>}
actual:
${actual:-<none>}"
  fi
}

# Liveness witness for a run that restarted nothing: the script reached the
# end, patched every Secret it owns, and logged one skip line per consumer.
assert_noop_witness() {
  local consumer secret
  grep -q '\] Done\.$' "$TMP/stderr" || fail "script did not reach Done."
  for secret in "${TOKEN_SECRETS[@]}"; do
    grep -qx "$secret" "$TMP/patches.log" || fail "Secret $secret was not patched"
  done
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    grep -qF "Skipping rollout of ${consumer}: tokens unchanged" "$TMP/stderr" \
      || fail "missing skip line for $consumer"
  done
}

assert_openssl_rand_calls() {
  local expected="$1" actual
  actual="$(cat "$TMP/openssl-rand-count")"
  [[ "${actual:-0}" == "$expected" ]] || fail "expected $expected openssl rand calls, got ${actual:-0}"
}

# --- Member-registration HMAC resolution (unchanged behaviour) ---

new_store
minikube_capture="$TMP/minikube-control-api-internal-tokens.json"
run_tokens clerum-codex-member-registration-test "$TMP/rollout.log" "$minikube_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET and .stringData.CONTROL_API_INTERNAL_TOKENS and .stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("codex-llm-proxy=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("grok-llm-proxy=")' "$minikube_capture" >/dev/null

new_store
branch_profile_capture="$TMP/branch-profile-control-api-internal-tokens.json"
run_tokens clerum-cursor-46f812cd-185fc31b "$TMP/rollout.log" "$branch_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$branch_profile_capture" >/dev/null

new_store
detached_profile_capture="$TMP/detached-profile-control-api-internal-tokens.json"
run_tokens clerum-detached-rwo-abc12345 "$TMP/rollout.log" "$detached_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$detached_profile_capture" >/dev/null

new_store
non_minikube_capture="$TMP/non-minikube-control-api-internal-tokens.json"
if run_tokens gke-dev "$TMP/rollout.log" "$non_minikube_capture" env; then
  fail "expected non-minikube run without member-registration HMAC to fail"
fi
grep -q "is required when no existing control-api Secret value is present" "$TMP/stderr"

new_store
env_capture="$TMP/env-control-api-internal-tokens.json"
run_tokens gke-dev "$TMP/rollout.log" "$env_capture" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "test-member-registration-hmac"' "$env_capture" >/dev/null

# --- Token consumer restarts ---

# First deploy: every token is absent, so every consumer restarts.
new_store
rollout="$TMP/rollout-first-deploy.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
assert_restarted_exactly "$rollout" "${ALL_TOKEN_CONSUMERS[@]}"
assert_no_secret_material

# Normal redeploy (preserve path): identical values are written, nothing restarts.
rollout="$TMP/rollout-noop.log"
run_tokens gke-dev "$rollout" "" env -u CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_openssl_rand_calls 0
assert_no_secret_material

# A key only control-api reads drifted (the flat token list): only control-api.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS stale-list
rollout="$TMP/rollout-control-api-only.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api
grep -qF 'Skipping rollout of rpc-proxy/rpc-proxy: tokens unchanged' "$TMP/stderr" || fail "rpc-proxy skip line missing"
assert_no_secret_material

# control-api's map holds an extra entry while every caller entry is current:
# only control-api, whose env changes when the map is rewritten.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS \
  "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS),retired-service=retired"
rollout="$TMP/rollout-map-extra-entry.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api
assert_no_secret_material

# rpc-proxy token rotated: rpc-proxy and control-api (which holds it in its map).
rollout="$TMP/rollout-rpc-rotated.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$ROTATED" ]] \
  || fail "rotated rpc-proxy token was not written"
assert_no_secret_material

# Out-of-band rotation of a caller's Secret: the run copies the new value into
# control-api's map, so both ends restart (the caller's own key is unchanged).
store_set profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN "$WRC_NEW"
rollout="$TMP/rollout-out-of-band.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api profiles/external-rest-api
assert_no_secret_material

# A previous run patched control-api-internal-tokens and died before patching
# the caller: every control-api key already holds the new token and only the
# caller's key differs, yet both ends restart (control-api's pods were never
# restarted onto the new map).
webhook_before="$(store_get webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN)"
run_tokens gke-dev "$TMP/rollout-setup.log" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$HCC_NEW"
store_set webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN "$webhook_before"
rollout="$TMP/rollout-half-applied.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$HCC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api webhook-ingress/webhook-proxy
assert_no_secret_material

# The map entry for one caller is stale while its Secret is current: both ends.
store_set_map_entry grok-llm-proxy stale-grok-entry
rollout="$TMP/rollout-stale-map-entry.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/grok-llm-proxy
assert_no_secret_material

# One rotation per remaining override: exactly the caller and control-api.
rotation_case() {
  local env_var="$1" value="$2" consumer="$3"
  local rollout="$TMP/rollout-rotate-$env_var.log"
  run_tokens gke-dev "$rollout" "" env "$env_var=$value"
  assert_restarted_exactly "$rollout" control-plane/control-api "$consumer"
  assert_no_secret_material
}
rotation_case CONTROL_API_INTERNAL_TOKEN_EXT_REST "$ROTATED" profiles/external-rest-api
rotation_case CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY "$WRC_OLD" webhook-ingress/webhook-proxy
rotation_case CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY "$HCC_OLD" control-plane/codex-llm-proxy
rotation_case CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY "$HCC_NEW" control-plane/grok-llm-proxy
# The reader's control-api token: the reader, not the channel-readers.
rotation_case CONTROL_API_INTERNAL_TOKEN_WA_READER "$WRC_NEW" channels/clerum-workflow-approval-request-reader

# Member-registration HMAC rotated: control-api only.
rollout="$TMP/rollout-member-hmac.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=rotated-member-registration-hmac
assert_restarted_exactly "$rollout" control-plane/control-api
assert_no_secret_material

# Reader handoff token rotated: the reader and the channel-readers only.
rollout="$TMP/rollout-handoff-rotated.log"
run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$ROTATED"
assert_restarted_exactly "$rollout" \
  channels/clerum-workflow-approval-request-reader channels/app=channel-reader
assert_no_secret_material

# A legacy `replace-with-*` placeholder counts as absent: regenerated, restarted.
store_set control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN replace-with-codex-token
rollout="$TMP/rollout-placeholder.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/codex-llm-proxy
assert_openssl_rand_calls 1
assert_no_secret_material

# FORCE_CONSUMER_RESTART=true restarts every consumer although nothing changed.
rollout="$TMP/rollout-force.log"
run_tokens gke-dev "$rollout" "" env FORCE_CONSUMER_RESTART=true
assert_restarted_exactly "$rollout" "${ALL_TOKEN_CONSUMERS[@]}"
if grep -q 'tokens unchanged' "$TMP/stderr"; then
  fail "FORCE_CONSUMER_RESTART must not skip any consumer"
fi
assert_no_secret_material

# --- InternalControl JWT HMACs (WRC / HCC share one Secret) ---

store_set control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET "$HCC_OLD"
store_set control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET "$WRC_OLD"

# Overrides equal to the stored values: nothing restarts.
rollout="$TMP/rollout-hmac-unchanged.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_no_secret_material

# Dominant CI redeploy path: no HMAC override, values preserved from the Secret.
rollout="$TMP/rollout-hmac-preserve.log"
run_tokens gke-dev "$rollout" "" env \
  -u INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  -u INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_no_secret_material

# HCC HMAC rotated: HCC and control-api, not WRC.
rollout="$TMP/rollout-hcc-rotated.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/host-context-controller
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr" || fail "HCC roll line missing"
assert_no_secret_material

# WRC-only rotation: WRC and control-api, HCC skipped.
store_set control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET "$HCC_OLD"
rollout="$TMP/rollout-wrc-only.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/workflow-recipes
grep -qF 'Skipping rollout of control-plane/host-context-controller: tokens unchanged' "$TMP/stderr" \
  || fail "HCC skip line missing on WRC-only rotation"
assert_no_secret_material

# HCC key absent before the run: HCC restarts.
store_delete control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
rollout="$TMP/rollout-hcc-empty-before.log"
run_tokens gke-dev "$rollout" "" env INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/host-context-controller
assert_no_secret_material

# --- apply-workflow-approval-bot-secret.sh ---

READER=channels/clerum-workflow-approval-request-reader
READER_SKIP="Skipping rollout of ${READER}: tokens unchanged"

new_store
rollout="$TMP/rollout-bot-first.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout" "$READER"
assert_openssl_rand_calls 1
assert_no_secret_material

rollout="$TMP/rollout-bot-noop.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout"
grep -qF "$READER_SKIP" "$TMP/stderr" || fail "bot-secret skip line missing"
grep -qx 'channels/workflow-approval-request-reader-credentials' "$TMP/patches.log" \
  || fail "bot-secret no-op run did not patch the reader Secret"
grep -q '\] Done\.$' "$TMP/stderr" || fail "bot-secret script did not reach Done."
assert_openssl_rand_calls 0
assert_no_secret_material

rollout="$TMP/rollout-bot-rotated.log"
run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$ROTATED"
assert_restarted_exactly "$rollout" "$READER"
[[ "$(store_get channels workflow-approval-request-reader-credentials telegram-webhook-secret)" == "$ROTATED" ]] \
  || fail "rotated telegram-webhook-secret was not written"
assert_no_secret_material

store_set channels workflow-approval-request-reader-credentials telegram-webhook-secret replace-with-telegram-secret
rollout="$TMP/rollout-bot-placeholder.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout" "$READER"
assert_openssl_rand_calls 1
assert_no_secret_material

rollout="$TMP/rollout-bot-force.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET FORCE_CONSUMER_RESTART=true
assert_restarted_exactly "$rollout" "$READER"
if grep -qF "$READER_SKIP" "$TMP/stderr"; then
  fail "FORCE_CONSUMER_RESTART must not skip the reader"
fi
assert_no_secret_material

echo "inter-service token and bot-secret restart tests passed"
