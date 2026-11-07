#!/usr/bin/env bash
set -u

FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_no_context_violations() {
  if [[ -s "$1" ]]; then
    fail "kubectl called without --context=clerum-test: $(head -1 "$1")"
  fi
}

assert_generate_keys_creates_output_dir() {
  local tmp project stubbin violations
  tmp="$(mktemp -d)"
  project="$tmp/project"
  stubbin="$tmp/bin"
  violations="$tmp/context-violations"
  : > "$violations"

  mkdir -p "$project/scripts/minikube" "$project/deploy/scripts/lib" "$stubbin"
  cp scripts/minikube/generate-keys.sh "$project/scripts/minikube/generate-keys.sh"
  cp deploy/scripts/lib/restart-jwt-key-consumers.sh "$project/deploy/scripts/lib/"
  cp deploy/scripts/lib/token-consumer-stamp.sh "$project/deploy/scripts/lib/"
  chmod +x "$project/scripts/minikube/generate-keys.sh"

  cat > "$stubbin/kubectl" <<'STUB'
#!/usr/bin/env bash
# Every call must carry the profile's context, as in the other fake kubectls.
if [[ "${1:-}" != "--context=clerum-test" ]]; then
  echo "fake kubectl: expected --context=clerum-test first, got: $*" >&2
  printf '%s\n' "$*" >> "$STUB_CONTEXT_VIOLATIONS"
  exit 9
fi
shift
if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 1
fi
if [[ "${1:-}" == "apply" ]]; then
  exit 0
fi
exit 0
STUB
  chmod +x "$stubbin/kubectl"

  if PATH="$stubbin:$PATH" MINIKUBE_PROFILE=clerum-test STUB_CONTEXT_VIOLATIONS="$violations" \
     "$project/scripts/minikube/generate-keys.sh" >/dev/null 2>&1; then
    if [[ ! -f "$project/deploy/minikube/secrets/jwt-signing-keys.yaml" ]]; then
      fail "generate-keys did not create jwt-signing-keys.yaml"
    elif ! grep -q "CONTROL_API_OAUTH_STATE_HMAC_SECRET" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing CONTROL_API_OAUTH_STATE_HMAC_SECRET"
    elif ! grep -q "CONTROL_API_OAUTH_ENCRYPTION_KEY" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing CONTROL_API_OAUTH_ENCRYPTION_KEY"
    elif ! grep -q "TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing prompt-history encryption key"
    elif ! grep -q "name: control-ui-secrets" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing control-ui-secrets"
    elif ! grep -q "CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing CONTROL_UI_PUBLIC_TOKEN_CSRF_SECRET"
    else
      pass "generate-keys creates deploy/minikube/secrets in clean worktrees"
    fi
  else
    fail "generate-keys failed in clean-worktree test"
  fi

  assert_no_context_violations "$violations"
  rm -rf "$tmp"
}

assert_existing_secret_is_patched_once() {
  local tmp project stubbin state log violations
  tmp="$(mktemp -d)"
  project="$tmp/project"
  stubbin="$tmp/bin"
  violations="$tmp/context-violations"
  : > "$violations"
  state="$tmp/prompt-key-present"
  log="$tmp/kubectl.log"

  mkdir -p "$project/scripts/minikube" "$project/deploy/scripts/lib" "$stubbin"
  cp scripts/minikube/generate-keys.sh "$project/scripts/minikube/generate-keys.sh"
  cp deploy/scripts/lib/restart-jwt-key-consumers.sh "$project/deploy/scripts/lib/"
  cp deploy/scripts/lib/token-consumer-stamp.sh "$project/deploy/scripts/lib/"
  chmod +x "$project/scripts/minikube/generate-keys.sh"

  cat > "$stubbin/kubectl" <<'STUB'
#!/usr/bin/env bash
# Every call must carry the profile's context, as in the other fake kubectls.
if [[ "${1:-}" != "--context=clerum-test" ]]; then
  echo "fake kubectl: expected --context=clerum-test first, got: $*" >&2
  printf '%s\n' "$*" >> "$STUB_CONTEXT_VIOLATIONS"
  exit 9
fi
shift
if [[ "${1:-}" == "get" && "${2:-}" == "secret" && "$*" == *"-o name"* ]]; then
  echo "secret/control-api-secrets"
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "secret" && "$*" == *"go-template"* ]]; then
  [[ -f "$STUB_STATE" ]] && printf 'present'
  exit 0
fi
if [[ "${1:-}" == "get" && "${2:-}" == "secret" && "${3:-}" == "control-ui-secrets" ]]; then
  exit 0
fi
if [[ "${1:-}" == "patch" && "${2:-}" == "secret" && "${3:-}" == "control-api-secrets" ]]; then
  printf '%s\n' "$*" >> "$STUB_LOG"
  touch "$STUB_STATE"
  exit 0
fi
exit 0
STUB
  chmod +x "$stubbin/kubectl"

  if PATH="$stubbin:$PATH" MINIKUBE_PROFILE=clerum-test STUB_CONTEXT_VIOLATIONS="$violations" \
    STUB_STATE="$state" STUB_LOG="$log" \
    "$project/scripts/minikube/generate-keys.sh" >/dev/null 2>&1 && \
    PATH="$stubbin:$PATH" MINIKUBE_PROFILE=clerum-test STUB_CONTEXT_VIOLATIONS="$violations" \
    STUB_STATE="$state" STUB_LOG="$log" \
    "$project/scripts/minikube/generate-keys.sh" >/dev/null 2>&1; then
    if [[ "$(wc -l < "$log" | tr -d ' ')" != "1" ]]; then
      fail "existing control-api secret was not patched exactly once"
    elif ! grep -q -- '--type=merge' "$log" || ! grep -q -- '--patch-file=' "$log"; then
      fail "prompt-history key repair did not use a merge patch file"
    else
      pass "existing control-api secret receives one idempotent prompt-history key repair"
    fi
  else
    fail "generate-keys failed while repairing an existing control-api secret"
  fi

  assert_no_context_violations "$violations"
  rm -rf "$tmp"
}

assert_generic_cluster_generator_includes_prompt_key() {
  if grep -q 'TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY=$(openssl rand -hex 32)' deploy/scripts/gen-jwt-keys.sh && \
     grep -q -- '--from-literal="TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY=$TRACING_APPROVAL_PROMPT_HISTORY_ENCRYPTION_KEY"' deploy/scripts/gen-jwt-keys.sh; then
    pass "generic cluster key generator provisions prompt-history encryption"
  else
    fail "generic cluster key generator is missing prompt-history encryption provisioning"
  fi
}

assert_generate_keys_creates_output_dir
assert_existing_secret_is_patched_once
assert_generic_cluster_generator_includes_prompt_key

exit $FAIL
