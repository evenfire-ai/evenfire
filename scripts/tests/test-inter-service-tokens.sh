#!/usr/bin/env bash
set -euo pipefail
trap 'echo "unexpected token-test failure at line ${LINENO}" >&2' ERR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOKEN_SCRIPT="${INTER_SERVICE_TOKENS_SCRIPT:-$ROOT/deploy/scripts/apply-inter-service-tokens.sh}"
TMP="${TMPDIR:-/tmp}/inter-service-tokens-test.$$"
mkdir -p "$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

HCC_OLD="aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900"
HCC_NEW="ff00ee11dd22cc33bb44aa5566778899ff00ee11dd22cc33bb44aa5566778899"
WRC_OLD="1111111111111111111111111111111111111111111111111111111111111111"
WRC_NEW="2222222222222222222222222222222222222222222222222222222222222222"
EDGE_OLD="3333333333333333333333333333333333333333333333333333333333333333"
GFSC_OLD="5555555555555555555555555555555555555555555555555555555555555555"
GFSC_NEW="6666666666666666666666666666666666666666666666666666666666666666"
WFC_OLD="7777777777777777777777777777777777777777777777777777777777777777"
WFC_NEW="8888888888888888888888888888888888888888888888888888888888888888"

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
if [[ "${args[0]:-}" == "--context" ]]; then
  args=("${args[@]:2}")
elif [[ "${args[0]:-}" == --context=* ]]; then
  args=("${args[@]:1}")
fi
ns=""
if [[ "${args[0]:-}" == "-n" ]]; then
  ns="${args[1]}"
  args=("${args[@]:2}")
fi
for ((index=0; index<${#args[@]}; index++)); do
  if [[ "${args[$index]}" == "-n" ]]; then
    ns="${args[$((index + 1))]:-}"
    break
  fi
done
case "${args[0]:-}" in
  config)
    if [[ "${args[1]:-}" == "current-context" ]]; then
      printf '%s\n' "${CONTEXT:-test-context}"
    fi
    exit 0
    ;;
  get)
    case "${args[1]:-}" in
      ns) exit 0 ;;
      pods)
        if [[ "${args[*]}" == *"-n rpc-proxy"* ]]; then
          printf '%s\n' '{"items":[{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'
        else
          printf '%s\n' '{"items":[]}'
        fi
        exit 0
        ;;
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
        if [[ "$ns" == "rpc-proxy" && "${args[2]:-}" == "rpc-proxy-secrets" && \
              "$jsonpath" == *RPC_PROXY_MCP_HOST_EDGE_TOKEN* && -n "${KUBE_SECRET_RPC_EDGE:-}" ]]; then
          printf '%s' "$KUBE_SECRET_RPC_EDGE" | base64 | tr -d '\n'
        fi
        if [[ "$ns" == "mcp-host" && "${args[2]:-}" == "rpc-proxy-edge-credentials" && \
              "$jsonpath" == *RPC_PROXY_MCP_HOST_EDGE_TOKEN* && -n "${KUBE_SECRET_MCP_EDGE:-}" ]]; then
          printf '%s' "$KUBE_SECRET_MCP_EDGE" | base64 | tr -d '\n'
        fi
        if [[ "$ns" == "gfs" && "${args[2]:-}" == "gfs-controller-service-token" && \
              "$jsonpath" == *token* && -n "${KUBE_SECRET_GFSC:-}" ]]; then
          printf '%s' "$KUBE_SECRET_GFSC" | base64 | tr -d '\n'
        fi
        if [[ "$ns" == "mcp-host" && "${args[2]:-}" == "workspace-files-controller-service-token" && \
              "$jsonpath" == *token* && -n "${KUBE_SECRET_WFC:-}" ]]; then
          printf '%s' "$KUBE_SECRET_WFC" | base64 | tr -d '\n'
        fi
        exit 0
        ;;
      deploy|deployment|deployments)
        if [[ "${args[1]:-}" == "deployment" && "${args[2]:-}" == "rpc-proxy" && \
              "${args[*]}" == *"-o json"* ]]; then
          printf '%s\n' '{"metadata":{"generation":1},"spec":{"replicas":1,"template":{"metadata":{"labels":{"clerum.io/rpc-proxy-edge-protocol":"dedicated-header-v1"}}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}'
          exit 0
        fi
        if [[ "${args[1]:-}" == "deployment" && "${args[2]:-}" == "host-context-controller" && \
              "${args[*]}" == *"-o json"* ]]; then
          printf '%s\n' '{"metadata":{"generation":1},"spec":{"replicas":1,"template":{"metadata":{"labels":{}},"spec":{"containers":[{"env":[{"name":"CONTEXT_MAPPER_HOST_RPC_PROXY_EDGE_PROTOCOL","value":"dedicated-header-v1"}]}]}}},"status":{"observedGeneration":1,"updatedReplicas":1,"readyReplicas":1,"availableReplicas":1}}'
          exit 0
        fi
        if [[ "${args[1]:-}" == "deployments" && "${args[*]}" == *"-o jsonpath="* ]]; then
          printf '%s\n' 'chatllm'
          exit 0
        fi
        selector=""
        for ((i=0; i<${#args[@]}; i++)); do
          if [[ "${args[$i]}" == "-l" || "${args[$i]}" == "--selector" ]]; then
            selector="${args[$((i+1))]:-}"
          fi
        done
        if [[ "${KUBE_NO_FS_DEPLOYMENTS:-}" == "1" && \
              ( "$selector" == "clerum.io/globalfilesystem" || \
                "$selector" == "clerum.io/sharedfilesystem" ) ]]; then
          exit 0
        fi
        if [[ "${args[1]:-}" == "deployments" && "$selector" == "clerum.io/globalfilesystem" ]]; then
          [[ -n "${ROLLOUT_LOG:-}" ]] && printf '%s %s\n' \
            "$ns" "${args[*]}" >> "$ROLLOUT_LOG"
          printf '%s\n' 'deployment.apps/gfsc-writer' 'deployment.apps/gfsc-reader'
          exit 0
        fi
        if [[ "${args[1]:-}" == "deployments" && "$selector" == "clerum.io/sharedfilesystem" ]]; then
          [[ -n "${ROLLOUT_LOG:-}" ]] && printf '%s %s\n' \
            "$ns" "${args[*]}" >> "$ROLLOUT_LOG"
          printf '%s\n' 'deployment.apps/wfc-8875e305b4' 'deployment.apps/wfc-a27f869132'
          exit 0
        fi
        if [[ "${KUBE_DEPLOY_EXISTS:-}" == "1" ]]; then
          if [[ "${args[1]:-}" == "deployments" ]]; then
            printf '%s\n' 'deployment.apps/chatllm'
          fi
          exit 0
        fi
        if [[ "${args[1]:-}" == "deployments" ]]; then
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
    if [[ "$ns" == "rpc-proxy" && "${args[1]:-}" == "secret" && \
          "${args[2]:-}" == "rpc-proxy-secrets" && -n "${RPC_CAPTURE_FILE:-}" ]]; then
      for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[$i]}" == "-p" ]]; then
          printf '%s' "${args[$((i+1))]}" > "$RPC_CAPTURE_FILE"
        fi
      done
    fi
    if [[ "$ns" == "mcp-host" && "${args[1]:-}" == "secret" && \
          "${args[2]:-}" == "rpc-proxy-edge-credentials" && -n "${EDGE_CAPTURE_FILE:-}" ]]; then
      for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[$i]}" == "-p" ]]; then
          printf '%s' "${args[$((i+1))]}" > "$EDGE_CAPTURE_FILE"
        fi
      done
    fi
    exit 0
    ;;
  rollout)
    if [[ "${args[1]:-}" == "restart" && -n "${ROLLOUT_LOG:-}" ]]; then
      printf '%s %s\n' "$ns" "${args[*]}" >> "$ROLLOUT_LOG"
    elif [[ "${args[1]:-}" == "status" && -n "${ROLLOUT_LOG:-}" ]]; then
      printf '%s %s\n' "$ns" "${args[*]}" >> "$ROLLOUT_LOG"
      if [[ "${DELAY_ROLLOUT_STATUS:-}" == "1" ]]; then
        sleep 1
      fi
      if [[ "${FAIL_ROLLOUT_RESOURCE:-}" == "${args[2]:-}" ]]; then
        exit 1
      fi
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
    if grep -E 'aa11bb22cc33dd44|ff00ee11dd22cc33|1111111111111111|2222222222222222|3333333333333333|4444444444444444|0123456789abcdef0123456789abcdef|5555555555555555|6666666666666666|7777777777777777|8888888888888888' "$log" >/dev/null; then
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
  if ! CAPTURE_FILE="$capture" RPC_CAPTURE_FILE="$TMP/rpc-secret.json" \
    EDGE_CAPTURE_FILE="$TMP/mcp-host-edge-secret.json" PATH="$TMP/bin:$PATH" CONTEXT="$context" \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$TOKEN_SCRIPT" >"$TMP/stdout" 2>"$TMP/stderr"; then
    cat "$TMP/stderr" >&2
    cat "$TMP/stdout" >&2
    return 1
  fi
}

run_hcc_apply() {
  local rollout="$1"
  shift
  : > "$rollout"
  : > "$TMP/openssl-rand-count"
  if ! CAPTURE_FILE="$TMP/hcc-capture.json" RPC_CAPTURE_FILE="$TMP/rpc-secret.json" \
    EDGE_CAPTURE_FILE="$TMP/mcp-host-edge-secret.json" ROLLOUT_LOG="$rollout" KUBE_DEPLOY_EXISTS=1 \
    PATH="$TMP/bin:$PATH" CONTEXT=gke-dev \
    OPENSSL_RAND_COUNT_FILE="$TMP/openssl-rand-count" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$TOKEN_SCRIPT" >"$TMP/stdout" 2>"$TMP/stderr"; then
    cat "$TMP/stderr" >&2
    cat "$TMP/stdout" >&2
    return 1
  fi
}

assert_other_consumers_restarted() {
  local rollout="$1"
  grep -q 'control-plane .*restart deploy control-api' "$rollout"
  grep -q 'control-plane .*restart deploy workflow-recipes' "$rollout"
  grep -q 'profiles .*restart deploy external-rest-api' "$rollout"
}

minikube_capture="$TMP/minikube-control-api-internal-tokens.json"
run_apply clerum-codex-member-registration-test "$minikube_capture" env
jq -e '.stringData.CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET and .stringData.CONTROL_API_INTERNAL_TOKENS and .stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("codex-llm-proxy=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("gfs-controller=")' "$minikube_capture" >/dev/null
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("workspace-files-controller=")' "$minikube_capture" >/dev/null
jq -e '.stringData.RPC_PROXY_MCP_HOST_EDGE_TOKEN | test("^[0-9a-f]{64}$")' "$TMP/rpc-secret.json" >/dev/null
jq -e '.stringData.RPC_PROXY_MCP_HOST_EDGE_TOKEN | test("^[0-9a-f]{64}$")' "$TMP/mcp-host-edge-secret.json" >/dev/null
test "$(jq -r '.stringData.RPC_PROXY_MCP_HOST_EDGE_TOKEN' "$TMP/rpc-secret.json")" = \
  "$(jq -r '.stringData.RPC_PROXY_MCP_HOST_EDGE_TOKEN' "$TMP/mcp-host-edge-secret.json")"

duplicate_capture="$TMP/duplicate-filesystem-token.json"
if run_apply clerum-codex-member-registration-test "$duplicate_capture" env \
  CONTROL_API_INTERNAL_TOKEN_GFSC=duplicate-filesystem-controller-token \
  CONTROL_API_INTERNAL_TOKEN_WFC=duplicate-filesystem-controller-token; then
  echo "expected duplicate filesystem controller identities to fail" >&2
  exit 1
fi
grep -q 'filesystem controller service tokens must be distinct' "$TMP/stderr"
jq -e '.stringData.CONTROL_API_INTERNAL_SERVICE_TOKENS | contains("grok-llm-proxy=")' "$minikube_capture" >/dev/null

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
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$unchanged_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_OLD" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_OLD" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
grep -q 'Skipping rollout of control-plane/host-context-controller: hcc-hmac unchanged' "$TMP/stderr"
if grep -q 'host-context-controller' "$unchanged_rollout"; then
  echo "unchanged HCC HMAC must not restart host-context-controller" >&2
  cat "$unchanged_rollout" >&2
  exit 1
fi
assert_other_consumers_restarted "$unchanged_rollout"
if grep -E 'gfs .*rollout restart|mcp-host .*rollout restart deployment.apps/wfc-' "$unchanged_rollout"; then
  echo "unchanged GFSC/WFC credentials must not restart their consumers" >&2
  exit 1
fi
assert_no_secret_material

# R33-M4: the dedicated tokens are injected into process-start environment
# variables. Rotating either Secret must restart and verify every matching
# producer deployment, with no token value present in logs.
filesystem_rotation_rollout="$TMP/rollout-filesystem-token-rotation.log"
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$filesystem_rotation_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_NEW" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_NEW" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
for resource in deployment.apps/gfsc-writer deployment.apps/gfsc-reader; do
  grep -q "gfs rollout restart $resource" "$filesystem_rotation_rollout"
  grep -q "gfs rollout status $resource" "$filesystem_rotation_rollout"
done
for resource in deployment.apps/wfc-8875e305b4 deployment.apps/wfc-a27f869132; do
  grep -q "mcp-host rollout restart $resource" "$filesystem_rotation_rollout"
  grep -q "mcp-host rollout status $resource" "$filesystem_rotation_rollout"
done
grep -E 'rollout status .*--timeout=[1-9][0-9]*s' "$filesystem_rotation_rollout" >/dev/null
grep -E 'get deployments -l clerum.io/globalfilesystem .*--request-timeout=[1-9][0-9]*s' \
  "$filesystem_rotation_rollout" >/dev/null
grep -E 'rollout restart .*--request-timeout=[1-9][0-9]*s' \
  "$filesystem_rotation_rollout" >/dev/null
grep -E 'rollout status .*--request-timeout=[1-9][0-9]*s' \
  "$filesystem_rotation_rollout" >/dev/null
assert_no_secret_material

shared_deadline_rollout="$TMP/rollout-shared-deadline.log"
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$shared_deadline_rollout" env \
  DELAY_ROLLOUT_STATUS=1 \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_NEW" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_NEW" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
shared_deadline_timeouts=()
while IFS= read -r timeout; do
  shared_deadline_timeouts+=("$timeout")
done < <(sed -nE 's/.*rollout status .*--timeout=([0-9]+)s.*/\1/p' "$shared_deadline_rollout")
[[ "${#shared_deadline_timeouts[@]}" -eq 4 ]]
for ((index=1; index<${#shared_deadline_timeouts[@]}; index++)); do
  [[ "${shared_deadline_timeouts[$index]}" -lt "${shared_deadline_timeouts[$((index-1))]}" ]]
done
assert_no_secret_material

gfsc_only_rollout="$TMP/rollout-gfsc-only.log"
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$gfsc_only_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_NEW" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_OLD" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
grep -q 'gfs rollout restart deployment.apps/gfsc-writer' "$gfsc_only_rollout"
if grep -q 'mcp-host rollout restart deployment.apps/wfc-' "$gfsc_only_rollout"; then
  echo "GFSC-only rotation must not restart WFC deployments" >&2
  exit 1
fi
assert_no_secret_material

wfc_only_rollout="$TMP/rollout-wfc-only.log"
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$wfc_only_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_OLD" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_NEW" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
grep -q 'mcp-host rollout restart deployment.apps/wfc-8875e305b4' "$wfc_only_rollout"
if grep -q 'gfs rollout restart' "$wfc_only_rollout"; then
  echo "WFC-only rotation must not restart GFSC deployments" >&2
  exit 1
fi
assert_no_secret_material

missing_fs_rollout="$TMP/rollout-no-filesystem-deployments.log"
KUBE_NO_FS_DEPLOYMENTS=1 KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$missing_fs_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_NEW" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_NEW" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
grep -q 'No GFSC deployments exist' "$TMP/stderr"
grep -q 'No WFC deployments exist' "$TMP/stderr"
assert_no_secret_material

failed_readiness_rollout="$TMP/rollout-failed-readiness.log"
if KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
  KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
  KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  FAIL_ROLLOUT_RESOURCE=deployment.apps/wfc-8875e305b4 \
  run_hcc_apply "$failed_readiness_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_NEW" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_NEW" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"; then
  echo "expected failed WFC readiness to fail credential application" >&2
  exit 1
fi
grep -q 'credential rollout did not become ready for WFC deployment wfc-8875e305b4' "$TMP/stderr"
assert_no_secret_material

# Dominant CI redeploy path: no INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET override.
# Both resolve_token and HCC_HMAC_BEFORE read KUBE_SECRET_HCC.
preserve_rollout="$TMP/rollout-preserve-or-generate.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
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
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$changed_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_NEW" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
if grep -q 'hcc-hmac unchanged' "$TMP/stderr"; then
  echo "changed HCC HMAC must not skip HCC restart" >&2
  exit 1
fi
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr"
grep -q 'control-plane rollout restart deployment/host-context-controller' "$changed_rollout"
assert_no_secret_material

wrc_only_rollout="$TMP/rollout-wrc-only.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$wrc_only_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
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
KUBE_SECRET_GFSC="$GFSC_OLD" KUBE_SECRET_WFC="$WFC_OLD" \
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$force_rollout" env \
  FORCE_CONSUMER_RESTART=true \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  CONTROL_API_INTERNAL_TOKEN_GFSC="$GFSC_OLD" \
  CONTROL_API_INTERNAL_TOKEN_WFC="$WFC_OLD" \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN="$EDGE_OLD" \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
if grep -q 'hcc-hmac unchanged' "$TMP/stderr"; then
  echo "FORCE_CONSUMER_RESTART must restart HCC even when HMAC is unchanged" >&2
  exit 1
fi
grep -q 'Rolling deployment control-plane/host-context-controller' "$TMP/stderr"
grep -q 'host-context-controller' "$force_rollout"
grep -q 'gfs rollout restart deployment.apps/gfsc-writer' "$force_rollout"
grep -q 'mcp-host rollout restart deployment.apps/wfc-8875e305b4' "$force_rollout"
assert_no_secret_material

edge_rotation_rollout="$TMP/rollout-edge-token-rotation.log"
KUBE_SECRET_HCC="$HCC_OLD" KUBE_SECRET_WRC="$WRC_OLD" \
KUBE_SECRET_RPC_EDGE="$EDGE_OLD" KUBE_SECRET_MCP_EDGE="$EDGE_OLD" \
  run_hcc_apply "$edge_rotation_rollout" env \
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=test-member-registration-hmac \
  RPC_PROXY_MCP_HOST_EDGE_TOKEN=4444444444444444444444444444444444444444444444444444444444444444 \
  INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET="$HCC_OLD" \
  INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET="$WRC_OLD"
proxy_restart_line="$(grep -n 'rpc-proxy rollout restart deployment/rpc-proxy' "$edge_rotation_rollout" | cut -d: -f1)"
host_restart_line="$(grep -n 'mcp-host rollout restart deployment/chatllm' "$edge_rotation_rollout" | cut -d: -f1)"
if [[ -z "$proxy_restart_line" || -z "$host_restart_line" || \
      "$proxy_restart_line" -ge "$host_restart_line" ]]; then
  echo "edge token rotation must use the ordered Proxy-before-Host coordinator" >&2
  cat "$edge_rotation_rollout" >&2
  exit 1
fi
assert_no_secret_material

echo "inter-service token patch tests passed"
