#!/usr/bin/env bash
set -u
FAIL=0

SCRIPT="deploy/scripts/rotate-mcp-host-control-claims.sh"

pass() { echo "PASS: $1"; }
fail() {
  echo "FAIL: $1"
  FAIL=1
}

assert_syntax() {
  if bash -n "$SCRIPT"; then
    pass "rotation script has valid bash syntax"
  else
    fail "rotation script has invalid bash syntax"
  fi
}

assert_safety_defaults() {
  local body
  body="$(cat "$SCRIPT")"

  # shellcheck disable=SC2016
  if [[ "$body" == *'DRY_RUN="${DRY_RUN:-1}"'* ]] &&
     [[ "$body" == *'refusing to mutate without explicit CONTEXT'* ]] &&
     [[ "$body" == *'CONFIRM_RECREATE_WORKFLOW_PODS'* ]] &&
     [[ "$body" == *'is_prod_context'* ]] &&
     [[ "$body" == *'credential values are never printed'* ]] &&
     [[ "$body" == *'It must not mint JWTs locally.'* ]] &&
     [[ "$body" == *'It must not write full credential resources to disk.'* ]] &&
     [[ "$body" == *'It must not touch PVCs, WorkflowRecipe CRDs, workflow data, database data,'* ]]; then
    pass "rotation script keeps safe defaults and explicit confirmations"
  else
    fail "rotation script safety defaults regressed"
  fi
}

assert_scope_validation() {
  local body
  body="$(cat "$SCRIPT")"

  if [[ "$body" == *'"workflow:list", "workflow:read", "workflow:trigger"'* ]] &&
     [[ "$body" == *'valid_service_scopes'* ]] &&
     [[ "$body" == *'legacy_scope'* ]] &&
     [[ "$body" == *'FAIL_ON_INVALID'* ]]; then
    pass "rotation script validates new control claim shape"
  else
    fail "rotation script no longer validates control claim shape"
  fi
}

assert_service_readiness_checks() {
  local body
  body="$(cat "$SCRIPT")"

  if [[ "$body" == *'wait_control_plane'* ]] &&
     [[ "$body" == *'wait_first_party_hosts'* ]] &&
     [[ "$body" == *'wait_workflow_pods'* ]] &&
     [[ "$body" == *'Final service readiness confirmation'* ]]; then
    pass "rotation script confirms service readiness after rotation"
  else
    fail "rotation script readiness checks regressed"
  fi
}

assert_pod_manifest_sanitizer() {
  local body
  body="$(cat "$SCRIPT")"

  if [[ "$body" == *'kind: "List"'* ]] &&
     [[ "$body" == *'delete spec.nodeName'* ]] &&
     [[ "$body" == *'delete spec.hostname'* ]] &&
     [[ "$body" == *'delete spec.subdomain'* ]] &&
     [[ "$body" == *'delete annotations["kubectl.kubernetes.io/last-applied-configuration"]'* ]]; then
    pass "rotation script emits sanitized Pod List manifests"
  else
    fail "rotation script Pod manifest sanitizer regressed"
  fi
}

assert_syntax
assert_safety_defaults
assert_scope_validation
assert_service_readiness_checks
assert_pod_manifest_sanitizer

exit "$FAIL"
