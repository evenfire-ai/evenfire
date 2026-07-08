#!/usr/bin/env bash
set -u

FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

assert_generate_keys_creates_output_dir() {
  local tmp project stubbin
  tmp="$(mktemp -d)"
  project="$tmp/project"
  stubbin="$tmp/bin"

  mkdir -p "$project/scripts/minikube" "$stubbin"
  cp scripts/minikube/generate-keys.sh "$project/scripts/minikube/generate-keys.sh"
  chmod +x "$project/scripts/minikube/generate-keys.sh"

  cat > "$stubbin/kubectl" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--context=clerum-test" ]]; then
  shift
fi
if [[ "${1:-}" == "get" && "${2:-}" == "secret" ]]; then
  exit 1
fi
if [[ "${1:-}" == "apply" ]]; then
  exit 0
fi
exit 0
STUB
  chmod +x "$stubbin/kubectl"

  if PATH="$stubbin:$PATH" \
     "$project/scripts/minikube/generate-keys.sh" >/dev/null 2>&1; then
    if [[ ! -f "$project/deploy/minikube/secrets/jwt-signing-keys.yaml" ]]; then
      fail "generate-keys did not create jwt-signing-keys.yaml"
    elif ! grep -q "CONTROL_API_OAUTH_STATE_HMAC_SECRET" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing CONTROL_API_OAUTH_STATE_HMAC_SECRET"
    elif ! grep -q "CONTROL_API_OAUTH_ENCRYPTION_KEY" "$project/deploy/minikube/secrets/jwt-signing-keys.yaml"; then
      fail "generate-keys output missing CONTROL_API_OAUTH_ENCRYPTION_KEY"
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

  rm -rf "$tmp"
}

assert_generate_keys_creates_output_dir

exit $FAIL
