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
  printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
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
fi
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
  CAPTURE_FILE="$capture" PATH="$TMP/bin:$PATH" CONTEXT="$context" \
    CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$ROOT/deploy/scripts/apply-inter-service-tokens.sh" >"$TMP/stdout" 2>"$TMP/stderr"
}

run_hcc_apply() {
  local rollout="$1"
  shift
  : > "$rollout"
  CAPTURE_FILE="$TMP/hcc-capture.json" ROLLOUT_LOG="$rollout" KUBE_DEPLOY_EXISTS=1 \
    PATH="$TMP/bin:$PATH" CONTEXT=gke-dev CLERUM_PROJECT_DIR="$TMP/sibling" "$@" \
    bash "$ROOT/deploy/scripts/apply-inter-service-tokens.sh" >"$TMP/stdout" 2>"$TMP/stderr"
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
assert_no_secret_material

echo "inter-service token patch tests passed"
