#!/usr/bin/env bash
set -u

FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

make_stub_repo() {
  local tmp="$1"
  mkdir -p "$tmp/scripts/e2e" "$tmp/mcp-servers/airtable" \
    "$tmp/deploy/overlays/minikube/instances"
  cp scripts/e2e/playwright-preflight-dev.sh "$tmp/scripts/e2e/playwright-preflight-dev.sh"
  cat > "$tmp/mcp-servers/airtable/mcpserver.yaml" <<'YAML'
apiVersion: clerum.io/v1
kind: McpServer
metadata:
  name: airtable-server
  namespace: mcp-server
spec:
  transport:
    type: streamableHttp
YAML
  cat > "$tmp/deploy/overlays/minikube/instances/airtable-server.yaml" <<'YAML'
apiVersion: clerum.io/v1
kind: McpServer
metadata:
  name: airtable-server
  namespace: mcp-server
spec:
  image: clerum/airtable-mcp-server:test
  transport:
    type: streamableHttp
YAML
}

make_stub_kubectl() {
  local path="$1"
  cat > "$path" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
}

if [[ "${1:-}" == "config" && "${2:-}" == "current-context" ]]; then
  echo "stub-context"
  exit 0
fi

if [[ "${1:-}" == "--context" ]]; then
  shift 2
fi

if [[ "${1:-}" == "-n" ]]; then
  shift 2
fi

log "$*"

if [[ "${1:-}" == "apply" ]]; then
  cat >/dev/null || true
  echo "applied"
  exit 0
fi

if [[ "${1:-}" == "create" && "${2:-}" == "secret" ]]; then
  cat <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: mcp-airtable-credentials
YAML
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  if [[ "$*" == *"jsonpath={.data.api-key}"* ]]; then
    printf '%s' "${TEST_EXISTING_SECRET_B64:-}"
    exit 0
  fi
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "context" ]]; then
  printf '%s' "${TEST_CONTEXT_LIST:-[]}"
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "deployment" ]]; then
  exit 0
fi

if [[ "${1:-}" == "patch" ]]; then
  exit 0
fi

if [[ "${1:-}" == "wait" ]]; then
  exit 0
fi

if [[ "${1:-}" == "rollout" ]]; then
  exit 0
fi

exit 0
STUB
  chmod +x "$path"
}

assert_no_chatllm_restart_when_preflight_is_already_current() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  make_stub_repo "$tmp/repo"
  make_stub_kubectl "$tmp/kubectl"

  PATH="$tmp:$PATH" \
  TEST_LOG_FILE="$log_file" \
  TEST_EXISTING_SECRET_B64="$(printf '%s' 'real-key' | base64)" \
  TEST_CONTEXT_LIST='["airtable-server"]' \
  KUBECONTEXT="stub-context" \
  AIRTABLE_API_KEY="real-key" \
  bash "$tmp/repo/scripts/e2e/playwright-preflight-dev.sh" >/dev/null 2>&1

  if grep -q "rollout restart deployment/chatllm" "$log_file"; then
    fail "preflight restarted chatllm even though secret and allowlist were already current"
  else
    pass "preflight skips chatllm restart when cluster state is already current"
  fi

  if grep -q "rollout restart deployment/airtable-server" "$log_file"; then
    fail "preflight restarted airtable-server even though secret already matched"
  else
    pass "preflight skips airtable-server restart when secret already matches"
  fi

  rm -rf "$tmp"
}

assert_chatllm_restart_when_allowlist_changes() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  make_stub_repo "$tmp/repo"
  make_stub_kubectl "$tmp/kubectl"

  PATH="$tmp:$PATH" \
  TEST_LOG_FILE="$log_file" \
  TEST_EXISTING_SECRET_B64="$(printf '%s' 'real-key' | base64)" \
  TEST_CONTEXT_LIST='["mongodb-only"]' \
  KUBECONTEXT="stub-context" \
  AIRTABLE_API_KEY="real-key" \
  bash "$tmp/repo/scripts/e2e/playwright-preflight-dev.sh" >/dev/null 2>&1

  if grep -q "patch " "$log_file" && \
     grep -q "rollout restart deployment/chatllm" "$log_file"; then
    pass "preflight restarts chatllm when the workflow allowlist changes"
  else
    fail "preflight did not restart chatllm after updating the allowlist"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_chatllm_restart_when_secret_changes() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  make_stub_repo "$tmp/repo"
  make_stub_kubectl "$tmp/kubectl"

  PATH="$tmp:$PATH" \
  TEST_LOG_FILE="$log_file" \
  TEST_EXISTING_SECRET_B64="$(printf '%s' 'old-key' | base64)" \
  TEST_CONTEXT_LIST='["airtable-server"]' \
  KUBECONTEXT="stub-context" \
  AIRTABLE_API_KEY="new-key" \
  bash "$tmp/repo/scripts/e2e/playwright-preflight-dev.sh" >/dev/null 2>&1

  if grep -q "rollout restart deployment/airtable-server" "$log_file" && \
     grep -q "rollout restart deployment/chatllm" "$log_file"; then
    pass "preflight restarts airtable-server and chatllm when Airtable credentials change"
  else
    fail "preflight did not restart dependent deployments after secret change"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_branch_scoped_clerum_profile_uses_minikube_manifest() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  make_stub_repo "$tmp/repo"
  make_stub_kubectl "$tmp/kubectl"

  PATH="$tmp:$PATH" \
  TEST_LOG_FILE="$log_file" \
  TEST_EXISTING_SECRET_B64="$(printf '%s' 'real-key' | base64)" \
  TEST_CONTEXT_LIST='["airtable-server"]' \
  KUBECONTEXT="clerum-security-review-exec-pod-feature-3b5a3652" \
  AIRTABLE_API_KEY="real-key" \
  bash "$tmp/repo/scripts/e2e/playwright-preflight-dev.sh" >/dev/null 2>&1

  if grep -q "deploy/overlays/minikube/instances/airtable-server.yaml" "$log_file"; then
    pass "preflight uses the minikube Airtable manifest for branch-scoped clerum profiles"
  else
    fail "preflight did not use the minikube Airtable manifest for branch-scoped clerum profiles"
    cat "$log_file"
  fi

  rm -rf "$tmp"
}

assert_no_chatllm_restart_when_preflight_is_already_current
assert_chatllm_restart_when_allowlist_changes
assert_chatllm_restart_when_secret_changes
assert_branch_scoped_clerum_profile_uses_minikube_manifest

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi

echo "All playwright preflight tests passed"
