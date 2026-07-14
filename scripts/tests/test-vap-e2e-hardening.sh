#!/usr/bin/env bash
set -u

FAIL=0
SCRIPT="scripts/e2e/e2e-vap-namespace-allowlist.sh"

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

contains() {
  grep -Fq -- "$1" "$SCRIPT"
}

if bash -n "$SCRIPT"; then
  pass "VAP E2E script has valid bash syntax"
else
  fail "VAP E2E script has invalid bash syntax"
fi

if contains 'E2E_ALLOWED_CONTEXTS="${E2E_ALLOWED_CONTEXTS:-minikube,clerum-test}"' &&
   contains 'KC=(kubectl --context "$CONTEXT")'; then
  pass "VAP E2E uses an explicit guarded kube context"
else
  fail "VAP E2E can run against an accidental kube context"
fi

if contains 'ownerReferences added by UPDATE with a live parent UID must be DENIED' &&
   contains 'workflow-recipes ServiceAccount can set controller ownerReferences' &&
   contains '--as=system:serviceaccount:control-plane:workflow-recipes' &&
   contains 'child fixture does not exist before ownerReference update test' &&
   contains 'live parent UID is empty before ownerReference update test'; then
  pass "VAP E2E covers malicious update denial and controller positive path"
else
  fail "VAP E2E does not cover the ownerReference attack path completely"
fi

delete_lines="$(grep -nE '(^|[[:space:]])(kubectl|[$][{]?KC|["][$][{]?KC).*(delete|--all|-l|--selector|pvc|xargs|`|[$][(])' "$SCRIPT" || true)"
if printf "%s\n" "$delete_lines" | grep -Eq -- '--all|-l|--selector|pvc|xargs|`|[$][(]'; then
  fail "VAP E2E cleanup contains broad delete syntax"
else
  pass "VAP E2E cleanup is limited to exact fixture names"
fi

if contains 'vap-ownerref-update-child' &&
   contains 'vap-ownerref-update-parent' &&
   contains 'vap-ownerref-wrc-child' &&
   contains 'vap-ownerref-wrc-parent' &&
   contains 'workflowrecipe/vap-negative-test -n control-plane'; then
  pass "VAP E2E cleanup tracks all ownerReference fixtures"
else
  fail "VAP E2E cleanup is missing ownerReference fixtures"
fi

if contains 'trap on_exit EXIT' &&
   contains 'FAIL: cleanup left VAP E2E resources behind' &&
   ! grep -Eq 'delete workflowrecipe/.*[|][|][[:space:]]*true' "$SCRIPT"; then
  pass "VAP E2E treats cleanup failure as fatal"
else
  fail "VAP E2E can hide cleanup failures"
fi

exit "$FAIL"
