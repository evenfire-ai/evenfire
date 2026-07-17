#!/usr/bin/env bash
set -u

FAIL=0

assert_succeeds_dry() {
  local target="$1"
  if make -n "$target" >/dev/null 2>&1; then
    echo "PASS: make -n $target parses"
  else
    echo "FAIL: make -n $target failed to parse"
    FAIL=1
  fi
}

assert_contains() {
  local target="$1" needle="$2"
  local out
  out="$(make -n "$target" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "PASS: make -n $target contains '$needle'"
  else
    echo "FAIL: make -n $target missing '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_make_contains() {
  local needle="$1"
  shift
  local out
  out="$(make -n "$@" 2>&1 || true)"
  if [[ "$out" == *"$needle"* ]]; then
    echo "PASS: make -n $* contains '$needle'"
  else
    echo "FAIL: make -n $* missing '$needle'"
    echo "---"
    echo "$out"
    echo "---"
    FAIL=1
  fi
}

assert_succeeds_dry minikube-start
assert_succeeds_dry minikube-deploy-all
assert_succeeds_dry minikube-sync-auth-key-if-present
assert_succeeds_dry minikube-verify-networkpolicies

assert_contains minikube-start "minikube-sync-auth-key-if-present"
assert_contains minikube-start "--context=clerum-test"
assert_contains minikube-deploy-all "minikube-sync-auth-key"
assert_contains minikube-sync-auth-key "--context=clerum-test"
assert_contains minikube-sync-auth-key "scripts/minikube/sync-auth-key.sh"
assert_contains minikube-verify-networkpolicies "verify-networkpolicies.sh --overlay minikube"
assert_contains minikube-sync-auth-key-if-present "rpc-proxy-secrets"

assert_make_contains "deployment/chatllm" minikube-deploy-service SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/chatllm" minikube-restart-deploy SVC=mcp-host NS=mcp-host
assert_make_contains "deployment/control-api" minikube-deploy-service SVC=control-api NS=control-plane
assert_make_contains "deployment/custom-host" minikube-deploy-service SVC=mcp-host NS=mcp-host DEPLOYMENT=custom-host

exit $FAIL
