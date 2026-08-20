#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/inter-service-tokens-test.$$"
mkdir -p "$TMP/bin"
trap 'rm -rf "$TMP"' EXIT

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
        # Existing Secret reads return empty in this harness so the script must
        # use minikube fallback or explicit env depending on CONTEXT.
        exit 0
        ;;
      deploy|deployment)
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
    exit 0
    ;;
esac
exit 0
SH

chmod +x "$TMP/bin/openssl" "$TMP/bin/kubectl"

run_apply() {
  local context="$1" capture="$2"
  shift 2
  CAPTURE_FILE="$capture" PATH="$TMP/bin:$PATH" CONTEXT="$context" "$@" bash "$ROOT/deploy/scripts/apply-inter-service-tokens.sh" >"$TMP/stdout" 2>"$TMP/stderr"
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

echo "inter-service token patch tests passed"
