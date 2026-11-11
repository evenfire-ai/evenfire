#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/inter-service-tokens-test.$$"
mkdir -p "$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

HCC_OLD="aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
HCC_NEW="ff00ee11dd22cc33bb44aa5566778899ff00ee11dd22cc33bb44aa5566778899"
WRC_OLD="1111111111111111111111111111111111111111111111111111111111111111"
WRC_NEW="2222222222222222222222222222222222222222222222222222222222222222"

cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "rand" && "${2:-}" == "-hex" ]]; then
  count_file="${OPENSSL_RAND_COUNT_FILE:?}"
  count=0
  if [[ -f "$count_file" ]]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  printf '%064x\n' "$count"
  exit 0
fi
echo "unexpected openssl invocation" >&2
exit 1
SH

cat > "$TMP/bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
context="none"
if [[ "${args[0]:-}" == "--context" ]]; then
  context="${args[1]:-}"
  args=("${args[@]:2}")
fi
ns=""
if [[ "${args[0]:-}" == "-n" ]]; then
  ns="${args[1]}"
  args=("${args[@]:2}")
fi
# Record what each call addresses: context, namespace, verb, kind and the next
# two words. Patch bodies and Secret values never reach these logs.
if [[ -n "${KUBE_CALL_LOG:-}" ]]; then
  printf 'ctx=%s ns=%s %s %s %s %s\n' "$context" "${ns:-none}" "${args[0]:-}" \
    "${args[1]:-}" "${args[2]:-}" "${args[3]:-}" >> "$KUBE_CALL_LOG"
fi
if [[ -n "${KUBE_PATCH_KEYS_LOG:-}" && "${args[0]:-}" == "patch" && "${args[1]:-}" == "secret" ]]; then
  for ((i=0; i<${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "-p" ]]; then
      printf '%s/%s %s\n' "$ns" "${args[2]:-}" \
        "$(jq -r 'if type == "object" then (.stringData // {} | keys | join(","))
          else "non-merge-patch" end' <<<"${args[$((i+1))]}")" >> "$KUBE_PATCH_KEYS_LOG"
    fi
  done
fi
case "${args[0]:-}" in
  get)
    case "${args[1]:-}" in
      ns) exit 0 ;;
      secret)
        jsonpath=""
        for ((i=0; i<${#args[@]}; i++)); do
          if [[ "${args[$i]}" == "-o" ]]; then
            jsonpath="${args[$((i+1))]:-}"
          elif [[ "${args[$i]}" == -ojsonpath=* ]]; then
            jsonpath="${args[$i]#-ojsonpath=}"
          elif [[ "${args[$i]}" == -ojson ]]; then
            jsonpath="json"
          fi
        done
        if [[ "$jsonpath" == "json" ]]; then
          printf '%s\n' '{"data":{}}'
          exit 0
        fi
        if [[ "$ns" == "control-plane" && "${args[2]:-}" == "internal-control-jwt-secrets" ]]; then
          if [[ "$jsonpath" == *INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET* && -n "${KUBE_SECRET_HCC:-}" ]]; then
            printf '%s' "$KUBE_SECRET_HCC" | base64 | tr -d '\n'
          elif [[ "$jsonpath" == *INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET* && -n "${KUBE_SECRET_WRC:-}" ]]; then
            printf '%s' "$KUBE_SECRET_WRC" | base64 | tr -d '\n'
          fi
        fi
        exit 0
        ;;
      deploy|deployment)
        if [[ "${KUBE_DEPLOY_EXISTS:-}" == "1" ]]; then
          exit 0
        fi
        exit 1
        ;;
    esac
    ;;
  create)
    exit 0
    ;;
  patch)
    if [[ "$ns" == "control-plane" && "${args[1]:-}" == "secret" && "${args[2]:-}" == "control-api-internal-tokens" ]]; then
      for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[$i]}" == "-p" ]]; then
          printf '%s' "${args[$((i+1))]}" > "${CAPTURE_FILE:?}"
        fi
      done
    fi
    exit 0
    ;;
  rollout)
    if [[ "${args[1]:-}" == "restart" && -n "${ROLLOUT_LOG:-}" ]]; then
      printf '%s %s\n' "$ns" "${args[*]}" >> "$ROLLOUT_LOG"
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

assert_no_secret_material() {
  local log
  for log in "$TMP/stdout" "$TMP/stderr"; do
    if grep -E 'aa11bb22cc33dd44|ff00ee11dd22cc33|1111111111111111|2222222222222222|0123456789abcdef0123456789abcdef' "$log" >/dev/null; then
      echo "secret material leaked into $log" >&2
      cat "$log" >&2
      exit 1
    fi
  done
}

run_apply() {
  local context="$1" capture="$2"
  shift 2
  : > "$TMP/openssl-rand-count"
  : > "$TMP/kube-calls.log"
  : > "$TMP/patch-keys.log"
  CAPTURE_FILE="$capture" PATH="$TMP/bin:$PATH" CONTEXT="$context" \
    KUBE_CALL_LOG="$TMP/kube-calls.log" KUBE_PATCH_KEYS_LOG="$TMP/patch-keys.log" \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$ROOT/deploy/scripts/apply-inter-service-tokens.sh" >"$TMP/stdout" 2>"$TMP/stderr"
}

run_hcc_apply() {
  local rollout="$1"
  shift
  : > "$rollout"
  : > "$TMP/openssl-rand-count"
  : > "$TMP/kube-calls.log"
  : > "$TMP/patch-keys.log"
  CAPTURE_FILE="$TMP/hcc-capture.json" ROLLOUT_LOG="$rollout" KUBE_DEPLOY_EXISTS=1 \
    KUBE_CALL_LOG="$TMP/kube-calls.log" KUBE_PATCH_KEYS_LOG="$TMP/patch-keys.log" \
    PATH="$TMP/bin:$PATH" CONTEXT=gke-dev \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$ROOT/deploy/scripts/apply-inter-service-tokens.sh" >"$TMP/stdout" 2>"$TMP/stderr"
}

assert_other_consumers_restarted() {
  local rollout="$1"
  grep -q 'control-plane .*restart deploy control-api' "$rollout"
  grep -q 'control-plane .*restart deploy workflow-recipes' "$rollout"
  grep -q 'profiles .*restart deploy external-rest-api' "$rollout"
  # rpc-proxy reads RPC_PROXY_CONTROL_API_SERVICE_TOKEN at process start, and
  # control-api restarts on every run, so rpc-proxy must restart with it.
  if ! grep -q '^rpc-proxy rollout restart deploy rpc-proxy$' "$rollout"; then
    echo "rpc-proxy must restart on every run so it reloads its control-api token" >&2
    cat "$rollout" >&2
    exit 1
  fi
}

# Compare a log with the expected lines, whole: a missing line and an extra
# line both fail. The expected list is the liveness witness of every absence
# it implies (no other Secret, namespace or Deployment was touched).
assert_exact_lines() {
  local label="$1" actual="$2"
  shift 2
  printf '%s\n' "$@" > "$TMP/expected-lines"
  if ! diff "$TMP/expected-lines" "$actual" >&2; then
    echo "unexpected $label (expected on the left, actual on the right)" >&2
    exit 1
  fi
}

EXPECTED_RESTARTS=(
  'control-plane rollout restart deploy control-api'
  'control-plane rollout restart deploy codex-llm-proxy'
  'control-plane rollout restart deploy grok-llm-proxy'
  'control-plane rollout restart deploy workflow-recipes'
  'profiles rollout restart deploy external-rest-api'
  'rpc-proxy rollout restart deploy rpc-proxy'
  'webhook-ingress rollout restart deploy webhook-proxy'
  'channels rollout restart deploy clerum-workflow-approval-request-reader'
  'channels rollout restart deploy -l app=channel-reader'
)
EXPECTED_RESTARTS_WITH_HCC=(
  'control-plane rollout restart deploy control-api'
  'control-plane rollout restart deploy codex-llm-proxy'
  'control-plane rollout restart deploy grok-llm-proxy'
  'control-plane rollout restart deploy workflow-recipes'
  'control-plane rollout restart deploy host-context-controller'
  'profiles rollout restart deploy external-rest-api'
  'rpc-proxy rollout restart deploy rpc-proxy'
  'webhook-ingress rollout restart deploy webhook-proxy'
  'channels rollout restart deploy clerum-workflow-approval-request-reader'
  'channels rollout restart deploy -l app=channel-reader'
)

minikube_capture="$TMP/minikube-control-api-internal-tokens.json"
run_apply clerum-codex-member-registration-test "$minikube_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET and .stringData.CONTROL_API_INTERNAL_TOKENS and .stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("codex-llm-proxy=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("grok-llm-proxy=")' "$minikube_capture" >/dev/null

# The helper provisions these credentials and no others. A service gets a
# static control-api token here only when it has a live call to control-api.
jq -r '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | split(",") | map(split("=")[0]) | .[]' \
  "$minikube_capture" > "$TMP/service-token-names"
assert_exact_lines 'control-api service-token map names' "$TMP/service-token-names" \
  external-rest-api rpc-proxy webhook-proxy workflow-approval-reader codex-llm-proxy grok-llm-proxy
jq -e '.stringData.CONTROL_API_INTERNAL_TOKENS | split(",") | length == 6' "$minikube_capture" >/dev/null
assert_exact_lines 'patched Secrets and keys' "$TMP/patch-keys.log" \
  'control-plane/control-api-internal-tokens CONTROL_API_INTERNAL_SERVICE_TOKENS,CONTROL_API_INTERNAL_TOKENS,CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET' \
  'control-plane/internal-control-jwt-secrets INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET,INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET' \
  'profiles/external-rest-api-secrets EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN' \
  'rpc-proxy/rpc-proxy-secrets RPC_PROXY_CONTROL_API_SERVICE_TOKEN' \
  'webhook-ingress/webhook-proxy-secrets WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN' \
  'control-plane/codex-llm-proxy-secrets CODEX_LLM_PROXY_CONTROL_API_TOKEN' \
  'control-plane/grok-llm-proxy-secrets GROK_LLM_PROXY_CONTROL_API_TOKEN' \
  'channels/workflow-approval-request-reader-credentials channel-reader-handoff-token,control-api-token'
sed -E 's/^ctx=[^ ]+ ns=([^ ]+) .*/\1/' "$TMP/kube-calls.log" | sort -u > "$TMP/namespaces-touched"
assert_exact_lines 'namespaces addressed' "$TMP/namespaces-touched" \
  channels control-plane none profiles rpc-proxy webhook-ingress
sed -nE 's/^ctx=[^ ]+ ns=none get ns ([^ ]+) $/\1/p' "$TMP/kube-calls.log" > "$TMP/namespaces-ensured"
assert_exact_lines 'namespaces ensured' "$TMP/namespaces-ensured" \
  control-plane profiles rpc-proxy channels webhook-ingress
sed -E 's/^ctx=[^ ]+ ns=[^ ]+ ([^ ]+) ([^ ]+).*/\1 \2/' "$TMP/kube-calls.log" | sort -u > "$TMP/verbs-used"
assert_exact_lines 'kubectl verbs and kinds' "$TMP/verbs-used" \
  'delete secret' 'get deploy' 'get ns' 'get secret' 'patch secret'

branch_profile_capture="$TMP/branch-profile-control-api-internal-tokens.json"
run_apply clerum-cursor-46f812cd-185fc31b "$branch_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$branch_profile_capture" >/dev/null

detached_profile_capture="$TMP/detached-profile-control-api-internal-tokens.json"
run_apply clerum-detached-rwo-abc12345 "$detached_profile_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "dev-member-registration-hmac-secret"' "$detached_profile_capture" >/dev/null

non_minikube_capture="$TMP/non-minikube-control-api-internal-tokens.json"
if run_apply gke-dev "$non_minikube_capture" env; then
  echo "expected non-minikube run without member-registration HMAC to fail" >&2
  exit 1
fi
grep -q "is required when no existing control-api Secret value is present" "$TMP/stderr"

env_capture="$TMP/env-control-api-internal-tokens.json"
run_apply gke-dev "$env_capture" env CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET == "test-member-registration-hmac"' "$env_capture" >/dev/null

unchanged_rollout="$TMP/rollout-unchanged.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$unchanged_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
grep -q 'Skipping rollout of control-plane/host-context-controller: hcc-hmac unchanged' "$TMP/stderr"
if grep -q 'host-context-controller' "$unchanged_rollout"; then
  echo "unchanged HCC HMAC must not restart host-context-controller" >&2
  cat "$unchanged_rollout" >&2
  exit 1
fi
assert_other_consumers_restarted "$unchanged_rollout"
# An unchanged run restarts this consumer list and nothing else: no Host,
# filesystem-controller or selector-wide restart, and no rollout wait.
assert_exact_lines 'restarts on an unchanged run' "$unchanged_rollout" "${EXPECTED_RESTARTS[@]}"
sed -E 's/^ctx=([^ ]+) .*/\1/' "$TMP/kube-calls.log" | sort -u > "$TMP/contexts-used"
assert_exact_lines 'kubectl contexts' "$TMP/contexts-used" gke-dev
if grep -E ' rollout (status|undo) | get (pods|deployments) ' "$TMP/kube-calls.log" >&2; then
  echo "the helper must not wait on rollouts or inspect workload cohorts" >&2
  exit 1
fi
assert_no_secret_material

# CONTEXT is optional: without it every call goes to the current context.
no_context_rollout="$TMP/rollout-no-context.log"
if ! KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$no_context_rollout" env -u CONTEXT \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac; then
  echo "the helper must run against the current context when CONTEXT is unset" >&2
  cat "$TMP/stderr" >&2
  exit 1
fi
grep -q 'Resolving inter-service tokens (context: <current>)' "$TMP/stderr"
sed -E 's/^ctx=([^ ]+) .*/\1/' "$TMP/kube-calls.log" | sort -u > "$TMP/contexts-used"
assert_exact_lines 'kubectl contexts without CONTEXT' "$TMP/contexts-used" none
assert_exact_lines 'restarts without CONTEXT' "$no_context_rollout" "${EXPECTED_RESTARTS[@]}"
assert_no_secret_material

# Dominant CI redeploy path: no INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET override.
# Both resolve_token and HCC_HMAC_BEFORE read KUBE_SECRET_HCC.
preserve_rollout="$TMP/rollout-preserve-or-generate.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$preserve_rollout" env \
  -u INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET \
  -u INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac
grep -q 'Skipping rollout of control-plane/host-context-controller: hcc-hmac unchanged' "$TMP/stderr"
if grep -q 'host-context-controller' "$preserve_rollout"; then
  echo "preserve-or-generate HCC HMAC must not restart host-context-controller" >&2
  cat "$preserve_rollout" >&2
  exit 1
fi
assert_other_consumers_restarted "$preserve_rollout"
assert_no_secret_material

changed_rollout="$TMP/rollout-changed.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$changed_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
if grep -q 'hcc-hmac unchanged' "$TMP/stderr"; then
  echo "changed HCC HMAC must not skip HCC restart" >&2
  exit 1
fi
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr"
grep -q 'host-context-controller' "$changed_rollout"
assert_exact_lines 'restarts when the HCC HMAC changes' "$changed_rollout" \
  "${EXPECTED_RESTARTS_WITH_HCC[@]}"
assert_no_secret_material

wrc_only_rollout="$TMP/rollout-wrc-only.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$wrc_only_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_NEW"
grep -q 'Skipping rollout of control-plane/host-context-controller: hcc-hmac unchanged' "$TMP/stderr"
if grep -q 'host-context-controller' "$wrc_only_rollout"; then
  echo "WRC-only rotation must not restart host-context-controller" >&2
  cat "$wrc_only_rollout" >&2
  exit 1
fi
assert_other_consumers_restarted "$wrc_only_rollout"
assert_no_secret_material

empty_before_rollout="$TMP/rollout-empty-before.log"
run_hcc_apply "$empty_before_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW"
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr"
grep -q 'host-context-controller' "$empty_before_rollout"
assert_no_secret_material

force_rollout="$TMP/rollout-force.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  run_hcc_apply "$force_rollout" env \
  FORCE_CONSUMER_RESTART=true \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
if grep -q 'hcc-hmac unchanged' "$TMP/stderr"; then
  echo "FORCE_CONSUMER_RESTART must restart HCC even when HMAC is unchanged" >&2
  exit 1
fi
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr"
grep -q 'host-context-controller' "$force_rollout"
assert_exact_lines 'restarts under FORCE_CONSUMER_RESTART' "$force_rollout" \
  "${EXPECTED_RESTARTS_WITH_HCC[@]}"
assert_no_secret_material

echo "inter-service token patch tests passed"
