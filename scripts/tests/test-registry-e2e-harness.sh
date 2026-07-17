#!/usr/bin/env bash
set -u

FAIL=0

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

wait_for_file() {
  local file=$1
  local i
  for i in $(seq 1 20); do
    [[ -s "$file" ]] && return 0
    sleep 0.1
  done
  return 1
}

assert_pf_registry_uses_explicit_context() {
  local tmp log_file
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
exit 0
STUB

  cat > "$tmp/curl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  chmod +x "$tmp/kubectl" "$tmp/curl"

  if PATH="$tmp:$PATH" TEST_LOG_FILE="$log_file" MINIKUBE_PROFILE=clerum-test \
    bash scripts/minikube/pf-registry.sh >/dev/null 2>&1; then
    if wait_for_file "$log_file" &&
      grep -q -- '--context=clerum-test -n registry port-forward --address=127.0.0.1 svc/registry-api 8085:8085' "$log_file"; then
      pass "pf-registry pins the minikube kube context"
    else
      fail "pf-registry did not pin the kube context"
      cat "$log_file"
    fi
  else
    fail "pf-registry harness test failed"
  fi

  rm -rf "$tmp"
}

assert_pf_registry_uses_branch_profile_port() {
  local tmp log_file ports_env
  tmp="$(mktemp -d)"
  log_file="$tmp/kubectl.log"
  ports_env="$tmp/ports.env"

  cat > "$tmp/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${TEST_LOG_FILE:?}"
exit 0
STUB

  cat > "$tmp/curl" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  printf 'REGISTRY_API_PORT=31812\n' >"$ports_env"
  chmod +x "$tmp/kubectl" "$tmp/curl"

  if PATH="$tmp:$PATH" TEST_LOG_FILE="$log_file" MINIKUBE_PROFILE=clerum-feat-gfs-open-core-c1ec92d2 CLERUM_PROFILE_PORTS_ENV="$ports_env" \
    bash scripts/minikube/pf-registry.sh >/dev/null 2>&1; then
    if wait_for_file "$log_file" &&
      grep -q -- '--context=clerum-feat-gfs-open-core-c1ec92d2 -n registry port-forward --address=127.0.0.1 svc/registry-api 31812:8085' "$log_file"; then
      pass "pf-registry uses branch profile registry port"
    else
      fail "pf-registry did not use the branch profile registry port"
      cat "$log_file"
    fi
  else
    fail "pf-registry branch profile harness test failed"
  fi

  rm -rf "$tmp"
}

assert_registry_cleanup_rejects_warning_only_uninstalls() {
  local out
  out="$(
    E2E_REGISTRY_INSTALL_LIB_ONLY=true bash -lc '
      source scripts/e2e/e2e-registry-install.sh
      FAIL=0
      ok(){ echo "ok:$1"; }
      fail(){ echo "fail:$1"; FAIL=1; }
      api(){ echo "{\"resourceName\":\"e2e-test\",\"resourceType\":\"mcp-server\",\"deleted\":[],\"warnings\":[\"McpServer/e2e-test: not found\"]}"; }
      cleanup_registry_resource e2e-test mcp-server
      exit $FAIL
    ' 2>&1 || true
  )"

  if [[ "$out" == *"fail:Cleanup via uninstall API failed for mcp-server e2e-test"* ]]; then
    pass "registry cleanup fails when uninstall only returns warnings"
  else
    fail "registry cleanup accepted warning-only uninstall output"
    echo "$out"
  fi
}

assert_registry_cleanup_accepts_real_deletions() {
  local out
  out="$(
    E2E_REGISTRY_INSTALL_LIB_ONLY=true bash -lc '
      source scripts/e2e/e2e-registry-install.sh
      FAIL=0
      ok(){ echo "ok:$1"; }
      fail(){ echo "fail:$1"; FAIL=1; }
      api(){ echo "{\"resourceName\":\"e2e-test\",\"resourceType\":\"recipe\",\"deleted\":[\"WorkflowRecipe/e2e-test\"],\"warnings\":[]}"; }
      cleanup_registry_resource e2e-test recipe
      exit $FAIL
    ' 2>&1 || true
  )"

  if [[ "$out" == *"ok:Cleanup via uninstall API completed for recipe e2e-test"* ]]; then
    pass "registry cleanup accepts successful uninstall output"
  else
    fail "registry cleanup rejected successful uninstall output"
    echo "$out"
  fi
}

assert_registry_e2e_uses_wrapped_kubectl() {
  local matches
  matches="$(grep -nE '^[[:space:]]*kubectl[[:space:]]' scripts/e2e/e2e-registry-install.sh || true)"
  if [[ -z "$matches" ]]; then
    pass "registry e2e script has no raw kubectl calls"
  else
    fail "registry e2e script still has raw kubectl calls"
    echo "$matches"
  fi
}

assert_pf_registry_uses_explicit_context
assert_pf_registry_uses_branch_profile_port
assert_registry_cleanup_rejects_warning_only_uninstalls
assert_registry_cleanup_accepts_real_deletions
assert_registry_e2e_uses_wrapped_kubectl

exit $FAIL
