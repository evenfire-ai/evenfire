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

# Runs a registry e2e script's install no-binding assertion against stubbed
# Context listings and McpServer spec; prints ok:/fail: lines. The install script
# lists Contexts through control-api and the lifecycle script through kubectl, so
# both sources are stubbed with the same listings.
run_install_binding_check() {
  local script=$1 contexts_after=$2 server_spec=$3
  E2E_REGISTRY_INSTALL_LIB_ONLY=true E2E_REGISTRY_LIFECYCLE_LIB_ONLY=true \
    SCRIPT="$script" CONTEXTS_AFTER="$contexts_after" SERVER_SPEC="$server_spec" bash -c '
    source "$SCRIPT"
    FAIL=0
    ok(){ echo "ok:$1"; }
    fail(){ echo "fail:$1"; FAIL=1; }
    kubectl(){
      if [ "$2" = contexts ]; then printf "%s\n" "$CONTEXTS_LISTING"
      else printf "{\"spec\":%s}\n" "$SERVER_SPEC"; fi
    }
    KC=(kubectl)
    api(){ printf "%s\n" "$CONTEXTS_LISTING"; }
    CONTEXTS_LISTING="{\"items\":[{\"metadata\":{\"name\":\"ctx-a\"},\"spec\":{\"mcpServers\":[\"other\"]}},{\"metadata\":{\"name\":\"ctx-b\"},\"spec\":{\"mcpServers\":[\"x\"]}}]}"
    before=$(contexts_snapshot)
    CONTEXTS_LISTING="$CONTEXTS_AFTER"
    assert_install_left_contexts_untouched e2e-new "$before"
    exit $FAIL
  ' 2>&1 || true
}

assert_registry_install_leaves_contexts_untouched() {
  local script=$1 label unchanged foreign_churn allowlisted new_context with_field
  label=$(basename "$script")
  unchanged='{"items":[{"metadata":{"name":"ctx-a"},"spec":{"mcpServers":["other"]}},{"metadata":{"name":"ctx-b"},"spec":{"mcpServers":["x"]}}]}'
  foreign_churn='{"items":[{"metadata":{"name":"ctx-a"},"spec":{"mcpServers":["other","y"]}}]}'
  allowlisted='{"items":[{"metadata":{"name":"ctx-a"},"spec":{"mcpServers":["other","e2e-new"]}},{"metadata":{"name":"ctx-b"},"spec":{"mcpServers":["x"]}}]}'
  new_context='{"items":[{"metadata":{"name":"ctx-a"},"spec":{"mcpServers":["other"]}},{"metadata":{"name":"ctx-b"},"spec":{"mcpServers":["x"]}},{"metadata":{"name":"e2e-new-private"},"spec":{"mcpServers":[]}}]}'
  with_field='{"image":"x","contextRef":"ctx-a"}'

  local out
  out="$(run_install_binding_check "$script" "$unchanged" '{"image":"x"}')"
  if [[ "$out" != *"fail:"* ]] && [[ "$(grep -c '^ok:' <<<"$out")" = 3 ]]; then
    pass "$label: install check accepts an install that leaves Contexts untouched"
  else
    fail "$label: install check rejected an unbound install"
    echo "$out"
  fi

  out="$(run_install_binding_check "$script" "$foreign_churn" '{"image":"x"}')"
  if [[ "$out" != *"fail:"* ]] && [[ "$(grep -c '^ok:' <<<"$out")" = 3 ]]; then
    pass "$label: install check ignores a foreign Context deleted or re-allowlisted without the server"
  else
    fail "$label: install check blamed the install for foreign Context churn"
    echo "$out"
  fi

  out="$(run_install_binding_check "$script" "$allowlisted" '{"image":"x"}')"
  if [[ "$out" == *"fail:e2e-new is in a Context allowlist right after install"* ]]; then
    pass "$label: install check rejects an install that writes an allowlist"
  else
    fail "$label: install check accepted an install that writes an allowlist"
    echo "$out"
  fi

  out="$(run_install_binding_check "$script" "$new_context" '{"image":"x"}')"
  if [[ "$out" == *"fail:Install of e2e-new created Context(s): e2e-new-private"* ]]; then
    pass "$label: install check rejects an install that creates a Context"
  else
    fail "$label: install check accepted an install that creates a Context"
    echo "$out"
  fi

  out="$(run_install_binding_check "$script" "$unchanged" "$with_field")"
  if [[ "$out" == *"fail:e2e-new is missing or carries spec.contextRef"* ]]; then
    pass "$label: install check rejects an McpServer that carries spec.contextRef"
  else
    fail "$label: install check accepted an McpServer with spec.contextRef"
    echo "$out"
  fi

  out="$(run_install_binding_check "$script" '{"error":"request_failed"}' '{"image":"x"}')"
  if [[ "$out" == *"fail:Could not list Contexts to verify the install of e2e-new"* ]]; then
    pass "$label: install check fails closed when Contexts cannot be listed"
  else
    fail "$label: install check passed without a Context listing"
    echo "$out"
  fi
}

# A leftover McpServer must go through the uninstall API (which strips it from
# Context allowlists) before kubectl deletes it: once the CR is gone the API
# reports not_found and leaves the allowlists alone. A failing uninstall must
# still fall through to kubectl delete.
run_lifecycle_cleanup() {
  local api_status=$1 calls
  calls="$(mktemp)"
  E2E_REGISTRY_LIFECYCLE_LIB_ONLY=true CALLS="$calls" API_STATUS="$api_status" bash -c '
    source scripts/e2e/e2e-registry-lifecycle.sh
    kubectl(){
      if [ "$1" = get ]; then printf "mcpserver.clerum.io/mcp-e2e-mock-mcp-v1-0-0-abcd1234\nmcpserver.clerum.io/unrelated\n"
      else echo "kubectl $*" >>"$CALLS"; fi
    }
    api(){ echo "api $*" >>"$CALLS"; return "$API_STATUS"; }
    cleanup_stale_mcpservers
  ' >/dev/null 2>&1 || true
  cat "$calls"
  rm -f "$calls"
}

assert_lifecycle_cleanup_uninstalls_before_deleting() {
  local expected out
  expected="api DELETE /api/v1/admin/registry/uninstall/mcp-e2e-mock-mcp-v1-0-0-abcd1234
kubectl delete mcpserver.clerum.io/mcp-e2e-mock-mcp-v1-0-0-abcd1234 -n mcp-server --ignore-not-found"

  out="$(run_lifecycle_cleanup 0)"
  if [[ "$out" == "$expected" ]]; then
    pass "lifecycle cleanup uninstalls leftover servers through the API before deleting them"
  else
    fail "lifecycle cleanup does not uninstall leftover servers through the API first"
    echo "$out"
  fi

  out="$(run_lifecycle_cleanup 1)"
  if [[ "$out" == "$expected" ]]; then
    pass "lifecycle cleanup still deletes leftover servers when the uninstall API fails"
  else
    fail "lifecycle cleanup skipped the kubectl fallback after a failed uninstall"
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
assert_registry_install_leaves_contexts_untouched scripts/e2e/e2e-registry-install.sh
assert_registry_install_leaves_contexts_untouched scripts/e2e/e2e-registry-lifecycle.sh
assert_lifecycle_cleanup_uninstalls_before_deleting
assert_registry_e2e_uses_wrapped_kubectl

exit $FAIL
