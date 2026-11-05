#!/usr/bin/env bash
set -euo pipefail

# Tests for deploy/scripts/apply-inter-service-tokens.sh and
# deploy/scripts/apply-workflow-approval-bot-secret.sh against a fake kubectl
# that keeps Secrets ($KUBE_STORE/<ns>/<secret>/<key>) and Deployments
# ($KUBE_STORE/_deploy/<ns>/<name>/, with labels and annotations) in a
# directory store. Merge patches, annotations and restarts persist across runs,
# so a later run sees what an earlier run did, as in a cluster. Failures can be
# injected per object, persistent (every attempt) or transient (first attempt).

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
  WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET CONTEXT \
  TOKEN_STAMP_ATTEMPTS TOKEN_STAMP_RETRY_SECONDS

TOKENS_SCRIPT="$ROOT/deploy/scripts/apply-inter-service-tokens.sh"
BOT_SECRET_SCRIPT="$ROOT/deploy/scripts/apply-workflow-approval-bot-secret.sh"
TOKEN_STAMP_KEY="clerum.io/inter-service-tokens-sha256"
BOT_STAMP_KEY="clerum.io/workflow-approval-bot-secret-sha256"

HCC_OLD="aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
HCC_NEW="ff00ee11dd22cc33bb44aa5566778899ff00ee11dd22cc33bb44aa5566778899"
WRC_OLD="1111111111111111111111111111111111111111111111111111111111111111"
WRC_NEW="2222222222222222222222222222222222222222222222222222222222222222"
ROTATED="3333333333333333333333333333333333333333333333333333333333333333"
MEMBER_HMAC="test-member-registration-hmac"

# Consumers as <ns>/<deployment>; the last one is an HCC-built per-Host
# channel-reader (label app=channel-reader).
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
  channels/channel-reader-stubhost
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
if [[ "${1:-}" == "dgst" && "${2:-}" == "-sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    digest="$(sha256sum | awk '{print $1}')"
  else
    digest="$(shasum -a 256 | awk '{print $1}')"
  fi
  printf 'SHA2-256(stdin)= %s\n' "$digest"
  exit 0
fi
echo "unexpected openssl invocation: $*" >&2
exit 1
SH

cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
store="${KUBE_STORE:?}"
dstore="$store/_deploy"
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
has_arg() {
  local a
  for a in "${args[@]}"; do [[ "$a" == "$1" ]] && return 0; done
  return 1
}
# Injected failures: KUBE_<OP>_FAIL lists "<ns>/<name>" that always fail;
# KUBE_FLAKY lists "<op>:<ns>/<name>" that fail on their first attempt only.
inject() {
  local op="$1" target="$2" persistent="$3" marker
  if [[ " $persistent " == *" $target "* ]]; then
    echo "fake kubectl: injected $op failure for $target" >&2
    exit 1
  fi
  if [[ " ${KUBE_FLAKY:-} " == *" $op:$target "* ]]; then
    marker="${FLAKY_STATE:?}/$op-${target//\//_}"
    if [[ ! -e "$marker" ]]; then
      : > "$marker"
      echo "fake kubectl: transient $op failure for $target" >&2
      exit 1
    fi
  fi
}
annotation_file() { printf '%s/%s/%s/annotations/%s' "$dstore" "$ns" "$1" "${2//\//__}"; }
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
        if [[ "${args[2]:-}" == "-l" ]]; then
          label="${args[3]#app=}"
          inject get "$ns/app=$label" "${KUBE_GET_DEPLOY_FAIL:-}"
          for dir in "$dstore/$ns"/*/; do
            [[ -d "$dir" ]] || continue
            if [[ "$(cat "$dir/app" 2>/dev/null)" == "$label" ]]; then
              printf '%s\n' "$(basename "$dir")"
            fi
          done
          exit 0
        fi
        name="${args[2]:?}"
        inject get "$ns/$name" "${KUBE_GET_DEPLOY_FAIL:-}"
        if [[ ! -d "$dstore/$ns/$name" ]]; then
          has_arg --ignore-not-found && exit 0
          echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2
          exit 1
        fi
        output=""
        for ((i=0; i<${#args[@]}; i++)); do
          [[ "${args[$i]}" == "-o" ]] && output="${args[$((i+1))]:-}"
        done
        case "$output" in
          jsonpath=*metadata.annotations.*)
            key="${output##*metadata.annotations.}"
            key="${key%\}}"
            key="${key//\\./.}"
            stamp_file="$(annotation_file "$name" "$key")"
            printf '%s|%s' "$name" "$(cat "$stamp_file" 2>/dev/null || true)"
            ;;
          name) printf 'deployment.apps/%s\n' "$name" ;;
          *) echo "fake kubectl: unsupported get deploy output '$output'" >&2; exit 2 ;;
        esac
        exit 0
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
  annotate)
    [[ "${args[1]:-}" == "deploy" ]] || { echo "fake kubectl: unsupported annotate ${args[*]}" >&2; exit 2; }
    name="${args[2]:?}"
    inject annotate "$ns/$name" "${KUBE_ANNOTATE_FAIL:-}"
    [[ -d "$dstore/$ns/$name" ]] || { echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2; exit 1; }
    has_arg --overwrite || { echo "fake kubectl: annotate without --overwrite" >&2; exit 2; }
    pair="${args[$((${#args[@]} - 1))]}"
    mkdir -p "$dstore/$ns/$name/annotations"
    printf '%s' "${pair#*=}" > "$(annotation_file "$name" "${pair%%=*}")"
    printf '%s/%s %s\n' "$ns" "$name" "${pair%%=*}" >> "${ANNOTATE_LOG:?}"
    exit 0
    ;;
  rollout)
    if [[ "${args[1]:-}" == "restart" && "${args[2]:-}" == "deploy" ]]; then
      name="${args[3]:?}"
      inject rollout "$ns/$name" "${KUBE_ROLLOUT_FAIL:-}"
      [[ -d "$dstore/$ns/$name" ]] || { echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2; exit 1; }
      printf '%s/%s\n' "$ns" "$name" >> "${ROLLOUT_LOG:?}"
      exit 0
    fi
    echo "fake kubectl: unsupported rollout ${args[*]}" >&2
    exit 2
    ;;
  delete) exit 0 ;;
esac
echo "fake kubectl: unsupported ${args[*]}" >&2
exit 2
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

# An empty cluster: no Secrets, no Deployments.
new_store() {
  rm -rf "$TMP/store" "$TMP/flaky"
  mkdir -p "$TMP/store" "$TMP/flaky"
}

# An empty cluster with every consumer Deployment deployed (no stamps yet).
new_cluster() {
  local consumer
  new_store
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    mkdir -p "$TMP/store/_deploy/$consumer/annotations"
  done
  printf 'channel-reader' > "$TMP/store/_deploy/channels/channel-reader-stubhost/app"
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

# stamp_of <ns>/<deployment> [annotation] — prints the stored stamp, if any.
stamp_of() {
  local key="${2:-$TOKEN_STAMP_KEY}"
  cat "$TMP/store/_deploy/$1/annotations/${key//\//__}" 2>/dev/null || true
}

unstamp() {
  local key="${2:-$TOKEN_STAMP_KEY}"
  rm -f "$TMP/store/_deploy/$1/annotations/${key//\//__}"
}

RUN_SALT=0
# run_script <script> <rollout-log> [capture-file] -- env [VAR=value | -u VAR]...
run_script() {
  local script="$1" rollout="$2" capture="$3"
  shift 3
  RUN_SALT=$((RUN_SALT + 1))
  : > "$rollout"
  : > "$TMP/patches.log"
  : > "$TMP/annotations.log"
  : > "$TMP/openssl-rand-count"
  CAPTURE_FILE="$capture" ROLLOUT_LOG="$rollout" PATCH_LOG="$TMP/patches.log" \
    ANNOTATE_LOG="$TMP/annotations.log" FLAKY_STATE="$TMP/flaky" \
    KUBE_STORE="$TMP/store" PATH="$TMP/bin:$PATH" TOKEN_STAMP_RETRY_SECONDS=0 \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" OPENSSL_RAND_SALT="$RUN_SALT" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$script" >"$TMP/stdout" 2>"$TMP/stderr" </dev/null
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
    # openssl), as are real `openssl rand -hex 32` tokens and the stamps.
    if grep -E '[0-9a-f]{64}|member-registration-hmac|stale-|replace-with-|retired' "$log" >/dev/null; then
      echo "secret material leaked into $log" >&2
      cat "$log" >&2
      exit 1
    fi
  done
}

# assert_restarted_exactly <rollout-log> [<ns>/<deployment>]...
assert_restarted_exactly() {
  local rollout="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@" | sed '/^$/d' | sort)"
  actual="$(sort "$rollout")"
  if [[ "$expected" != "$actual" ]]; then
    fail "restarted consumers differ
expected:
${expected:-<none>}
actual:
${actual:-<none>}"
  fi
}

# Every consumer carries the stamp this run wrote or confirmed.
assert_all_stamped() {
  local consumer
  for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
    [[ "$(stamp_of "$consumer")" =~ ^[0-9a-f]{64}$ ]] || fail "$consumer has no token stamp"
  done
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
  [[ ! -s "$TMP/annotations.log" ]] || fail "a no-op run must not rewrite any stamp"
}

assert_openssl_rand_calls() {
  local expected="$1" actual
  actual="$(cat "$TMP/openssl-rand-count")"
  [[ "${actual:-0}" == "$expected" ]] || fail "expected $expected openssl rand calls, got ${actual:-0}"
}

# A run that left restarts pending: non-zero exit, before Done, naming each one
# with its restart command and the FORCE alternative.
assert_pending() {
  local item
  grep -q '\] Done\.$' "$TMP/stderr" && fail "a run with pending restarts must stop before Done."
  grep -qF 'restarts are pending' "$TMP/stderr" || fail "missing pending-restarts error"
  grep -qF 'the next run of this script restarts them automatically' "$TMP/stderr" \
    || fail "missing automatic-retry notice"
  grep -qF 'FORCE_CONSUMER_RESTART=true' "$TMP/stderr" || fail "missing FORCE recovery"
  for item in "$@"; do
    grep -qF "kubectl --context gke-dev -n ${item%%/*} rollout restart deploy ${item#*/}" "$TMP/stderr" \
      || fail "missing restart command for $item"
  done
}

# --- Member-registration HMAC resolution (unchanged behaviour) ---

new_store
minikube_capture="$TMP/minikube-control-api-internal-tokens.json"
run_tokens clerum-codex-member-registration-test "$TMP/rollout.log" "$minikube_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET and .stringData.CONTROL_API_INTERNAL_TOKENS and .stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("codex-llm-proxy=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("grok-llm-proxy=")' "$minikube_capture" >/dev/null
assert_no_secret_material

new_store
branch_profile_capture="$TMP/branch-profile-control-api-internal-tokens.json"
run_tokens clerum-cursor-46f812cd-185fc31b "$TMP/rollout.log" "$branch_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$branch_profile_capture" >/dev/null
assert_no_secret_material

new_store
detached_profile_capture="$TMP/detached-profile-control-api-internal-tokens.json"
run_tokens clerum-detached-rwo-abc12345 "$TMP/rollout.log" "$detached_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$detached_profile_capture" >/dev/null
assert_no_secret_material

new_store
non_minikube_capture="$TMP/non-minikube-control-api-internal-tokens.json"
if run_tokens gke-dev "$TMP/rollout.log" "$non_minikube_capture" env; then
  fail "expected non-minikube run without member-registration HMAC to fail"
fi
grep -q "is required when no existing control-api Secret value is present" "$TMP/stderr"
assert_no_secret_material

new_store
env_capture="$TMP/env-control-api-internal-tokens.json"
run_tokens gke-dev "$TMP/rollout.log" "$env_capture" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "test-member-registration-hmac"' "$env_capture" >/dev/null
assert_no_secret_material

# --- Token consumer restarts ---

# First deploy: every token is absent and no consumer has a stamp, so every
# consumer restarts and is stamped.
new_cluster
rollout="$TMP/rollout-first-deploy.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
assert_restarted_exactly "$rollout" "${ALL_TOKEN_CONSUMERS[@]}"
assert_all_stamped
assert_no_secret_material

# Normal redeploy (preserve path): identical values are written, nothing restarts.
rollout="$TMP/rollout-noop.log"
run_tokens gke-dev "$rollout" "" env -u CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
assert_restarted_exactly "$rollout"
assert_noop_witness
assert_openssl_rand_calls 0
assert_no_secret_material

# A Secret key edited out of band to a value no consumer runs (the flat token
# list): the run rewrites it; the pods already run the correct values (their
# stamps match), so nothing restarts.
store_set control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS stale-list
rollout="$TMP/rollout-secret-drift.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_noop_witness
[[ "$(store_get control-plane control-api-internal-tokens CONTROL_API_INTERNAL_TOKENS)" != "stale-list" ]] \
  || fail "the drifted Secret key was not rewritten"
assert_no_secret_material

# rpc-proxy token rotated: rpc-proxy and control-api (which holds it in its map).
rollout="$TMP/rollout-rpc-rotated.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
[[ "$(store_get rpc-proxy rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN)" == "$ROTATED" ]] \
  || fail "rotated rpc-proxy token was not written"
assert_no_secret_material

# Out-of-band rotation of a caller's Secret: the run preserves it, copies it into
# control-api's map, and both ends restart.
store_set profiles external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN "$WRC_NEW"
rollout="$TMP/rollout-out-of-band.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api profiles/external-rest-api
assert_no_secret_material

# One rotation per override: exactly the caller and control-api.
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
  channels/clerum-workflow-approval-request-reader channels/channel-reader-stubhost
assert_no_secret_material

# A legacy `replace-with-*` placeholder counts as absent: regenerated, restarted.
store_set control-plane codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN replace-with-codex-token
rollout="$TMP/rollout-placeholder.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/codex-llm-proxy
assert_openssl_rand_calls 1
assert_no_secret_material

# --- Self-healing: a restart that does not happen is retried by the next run ---

# Every service-token caller, as override-env-var|consumer.
SERVICE_TOKEN_CALLERS=(
  "CONTROL_API_INTERNAL_TOKEN_EXT_REST|profiles/external-rest-api"
  "CONTROL_API_INTERNAL_TOKEN_RPC|rpc-proxy/rpc-proxy"
  "CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY|webhook-ingress/webhook-proxy"
  "CONTROL_API_INTERNAL_TOKEN_CODEX_LLM_PROXY|control-plane/codex-llm-proxy"
  "CONTROL_API_INTERNAL_TOKEN_GROK_LLM_PROXY|control-plane/grok-llm-proxy"
  "CONTROL_API_INTERNAL_TOKEN_WA_READER|channels/clerum-workflow-approval-request-reader"
)
caller_index=0
for caller in "${SERVICE_TOKEN_CALLERS[@]}"; do
  IFS='|' read -r caller_env caller_consumer <<<"$caller"
  caller_index=$((caller_index + 1))
  new_token="$(printf '%064x' $((0xB000 + caller_index)))"

  # The caller's restart fails on every attempt: control-api still restarts,
  # the run fails naming the caller, and the caller keeps its old stamp.
  rollout="$TMP/rollout-rollout-fails-$caller_index.log"
  if run_tokens gke-dev "$rollout" "" env "$caller_env=$new_token" KUBE_ROLLOUT_FAIL="$caller_consumer"; then
    fail "a failed restart of $caller_consumer must fail the run"
  fi
  assert_restarted_exactly "$rollout" control-plane/control-api
  assert_pending "$caller_consumer"
  assert_no_secret_material

  # The next plain run, with no override and no FORCE, restarts only the caller.
  rollout="$TMP/rollout-self-heal-$caller_index.log"
  run_tokens gke-dev "$rollout" "" env || fail "the healing run for $caller_consumer failed"
  assert_restarted_exactly "$rollout" "$caller_consumer"
  grep -q '\] Done\.$' "$TMP/stderr" || fail "the healing run did not reach Done."
  assert_no_secret_material
done

# A failed Deployment read (not NotFound) during a rotation: the other end
# restarts, the run fails, and the next plain run restarts the unread one.
rollout="$TMP/rollout-read-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$WRC_OLD" \
     KUBE_GET_DEPLOY_FAIL="rpc-proxy/rpc-proxy"; then
  fail "a failed Deployment read must fail the run"
fi
assert_restarted_exactly "$rollout" control-plane/control-api
assert_pending rpc-proxy/rpc-proxy
grep -qF 'cannot read deployment rpc-proxy/rpc-proxy' "$TMP/stderr" || fail "missing read error line"
rollout="$TMP/rollout-read-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the healing run after a read failure failed"
assert_restarted_exactly "$rollout" rpc-proxy/rpc-proxy
assert_no_secret_material

# A failed stamp write after a successful restart: the run fails, and the next
# run restarts that consumer once more (an extra restart, never a missed one).
rollout="$TMP/rollout-stamp-fails.log"
if run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_EXT_REST="$HCC_OLD" \
     KUBE_ANNOTATE_FAIL="profiles/external-rest-api"; then
  fail "a failed stamp write must fail the run"
fi
assert_restarted_exactly "$rollout" control-plane/control-api profiles/external-rest-api
assert_pending profiles/external-rest-api
rollout="$TMP/rollout-stamp-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the run after a failed stamp write failed"
assert_restarted_exactly "$rollout" profiles/external-rest-api
rollout="$TMP/rollout-stamp-settled.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_no_secret_material

# A failure on the first attempt only is retried within the run.
rollout="$TMP/rollout-transient.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$HCC_NEW" \
  KUBE_FLAKY="get:control-plane/control-api rollout:rpc-proxy/rpc-proxy annotate:rpc-proxy/rpc-proxy" \
  || fail "transient failures must be absorbed by the retries"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
grep -q '\] Done\.$' "$TMP/stderr" || fail "the run with transient failures did not reach Done."
[[ -e "$TMP/flaky/rollout-rpc-proxy_rpc-proxy" ]] || fail "the transient rollout failure was never injected"
assert_no_secret_material

# The channel-reader list cannot be read during a handoff rotation: the reader
# restarts, the run fails, and the next plain run restarts the channel-readers.
rollout="$TMP/rollout-selector-fails.log"
if run_tokens gke-dev "$rollout" "" env CHANNEL_READER_HANDOFF_TOKEN="$WRC_NEW" \
     KUBE_GET_DEPLOY_FAIL="channels/app=channel-reader"; then
  fail "a failed channel-reader list must fail the run"
fi
assert_restarted_exactly "$rollout" channels/clerum-workflow-approval-request-reader
grep -qF 'restarts are pending: channels/app=channel-reader' "$TMP/stderr" || fail "missing selector pending entry"
rollout="$TMP/rollout-selector-heals.log"
run_tokens gke-dev "$rollout" "" env || fail "the healing run after a selector failure failed"
assert_restarted_exactly "$rollout" channels/channel-reader-stubhost
assert_no_secret_material

# --- Stamps missing (first run with stamps, or a recreated Deployment) ---

# Nothing changed in this run: every consumer is stamped, none restarts.
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-unchanged.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_all_stamped
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do
  grep -qF "Recording token stamp on ${consumer}: tokens unchanged, no restart" "$TMP/stderr" \
    || fail "missing stamp-recording line for $consumer"
done
assert_no_secret_material

# A value changed in this run: its consumers restart; the others are stamped only.
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-changed.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_RPC="$ROTATED"
assert_restarted_exactly "$rollout" control-plane/control-api rpc-proxy/rpc-proxy
assert_all_stamped
assert_no_secret_material

# No stamps and a run that died between the control-api patch and the caller
# patch (control-api's Secret already holds the new token, the caller's does
# not): both ends count as changed, so both restart.
run_tokens gke-dev "$TMP/rollout-setup.log" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$HCC_OLD"
webhook_before="$(store_get webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN)"
run_tokens gke-dev "$TMP/rollout-setup.log" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$WRC_NEW"
store_set webhook-ingress webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN "$webhook_before"
for consumer in "${ALL_TOKEN_CONSUMERS[@]}"; do unstamp "$consumer"; done
rollout="$TMP/rollout-bootstrap-half-applied.log"
run_tokens gke-dev "$rollout" "" env CONTROL_API_INTERNAL_TOKEN_WEBHOOK_PROXY="$WRC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api webhook-ingress/webhook-proxy
assert_all_stamped
assert_no_secret_material

# HCC rebuilt a channel-reader Deployment without the stamp: it is re-stamped.
unstamp channels/channel-reader-stubhost
rollout="$TMP/rollout-rebuilt-channel-reader.log"
run_tokens gke-dev "$rollout" "" env
assert_restarted_exactly "$rollout"
assert_all_stamped
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
# Bring the stamps in line with these values.
run_tokens gke-dev "$TMP/rollout-hmac-setup.log" "" env

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
rollout="$TMP/rollout-wrc-only.log"
run_tokens gke-dev "$rollout" "" env \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_NEW"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/workflow-recipes
grep -qF 'Skipping rollout of control-plane/host-context-controller: tokens unchanged' "$TMP/stderr" \
  || fail "HCC skip line missing on WRC-only rotation"
assert_no_secret_material

# HCC key absent before the run: HCC restarts.
store_delete control-plane internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET
rollout="$TMP/rollout-hcc-empty-before.log"
run_tokens gke-dev "$rollout" "" env INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD"
assert_restarted_exactly "$rollout" control-plane/control-api control-plane/host-context-controller
assert_no_secret_material

# --- No consumer deployed yet (first apply before any workload) ---
new_store
rollout="$TMP/rollout-no-deployments.log"
run_tokens gke-dev "$rollout" "" env FORCE_CONSUMER_RESTART=true CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
assert_restarted_exactly "$rollout"
grep -q '\] Done\.$' "$TMP/stderr" || fail "run without deployments did not reach Done."
grep -qF 'Skipping rollout of channels/app=channel-reader: none deployed' "$TMP/stderr" \
  || fail "missing channel-reader none-deployed line"
for consumer in "${ALL_TOKEN_CONSUMERS[@]:0:9}"; do
  grep -qF "Skipping rollout of ${consumer}: not deployed yet" "$TMP/stderr" \
    || fail "missing not-deployed line for $consumer"
done
assert_no_secret_material

# --- apply-workflow-approval-bot-secret.sh ---

READER=channels/clerum-workflow-approval-request-reader
READER_SKIP="Skipping rollout of ${READER}: tokens unchanged"

new_cluster
rollout="$TMP/rollout-bot-first.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout" "$READER"
assert_openssl_rand_calls 1
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" =~ ^[0-9a-f]{64}$ ]] || fail "reader has no bot-secret stamp"
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

# The two scripts keep separate stamps on the reader: the token script's run
# neither reads nor rewrites the bot-secret stamp.
bot_stamp_before="$(stamp_of "$READER" "$BOT_STAMP_KEY")"
run_tokens gke-dev "$TMP/rollout-tokens-on-reader.log" "" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$MEMBER_HMAC"
[[ "$(stamp_of "$READER" "$BOT_STAMP_KEY")" == "$bot_stamp_before" ]] || fail "the token script changed the bot-secret stamp"
[[ "$(stamp_of "$READER")" =~ ^[0-9a-f]{64}$ ]] || fail "reader has no token stamp"
rollout="$TMP/rollout-bot-after-tokens.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET
assert_restarted_exactly "$rollout"

rollout="$TMP/rollout-bot-rotated.log"
run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$ROTATED"
assert_restarted_exactly "$rollout" "$READER"
[[ "$(store_get channels workflow-approval-request-reader-credentials telegram-webhook-secret)" == "$ROTATED" ]] \
  || fail "rotated telegram-webhook-secret was not written"
assert_no_secret_material

# A failed reader restart heals on the next plain run.
rollout="$TMP/rollout-bot-fails.log"
if run_bot_secret "$rollout" env WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET="$HCC_OLD" KUBE_ROLLOUT_FAIL="$READER"; then
  fail "a failed reader restart must fail the bot-secret run"
fi
assert_restarted_exactly "$rollout"
assert_pending "$READER"
rollout="$TMP/rollout-bot-heals.log"
run_bot_secret "$rollout" env -u WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET || fail "the bot-secret healing run failed"
assert_restarted_exactly "$rollout" "$READER"
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

# --- deploy/base contract: token Secrets ship an empty stringData canary ---
# A value in a base manifest is re-applied by every `kubectl apply` (server-side
# and client-side), overwriting the token this script patched.
canary_checked=0
for pair in "${TOKEN_SECRETS[@]}"; do
  secret="${pair#*/}"
  while IFS= read -r manifest; do
    verdict="$(awk -v name="$secret" '
      /^---/ { if (is_secret && named) print (bad ? "BAD" : "OK"); is_secret=0; named=0; bad=0; in_sd=0; next }
      /^kind: Secret/ { is_secret=1 }
      $0 ~ "^  name: " name "$" { named=1 }
      /^stringData:/ { in_sd=1; if ($0 !~ /\{\}[[:space:]]*$/) bad=1; next }
      /^data:/ { bad=1 }
      in_sd && /^  [^ ]/ { bad=1 }
      /^[^ ]/ && !/^stringData:/ { in_sd=0 }
      END { if (is_secret && named) print (bad ? "BAD" : "OK") }
    ' "$manifest")"
    case "$verdict" in
      *BAD*) fail "$manifest ships a value for $secret; base token Secrets must use stringData: {}" ;;
      *OK*) canary_checked=$((canary_checked + 1)) ;;
    esac
  done < <(grep -rl --include='*.yaml' -E "^  name: ${secret}\$" "$ROOT/deploy/base" || true)
done
[[ "$canary_checked" -ge 6 ]] || fail "expected at least 6 token Secrets declared in deploy/base, checked $canary_checked"

echo "inter-service token and bot-secret restart tests passed"
