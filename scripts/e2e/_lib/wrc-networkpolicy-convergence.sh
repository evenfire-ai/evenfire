#!/usr/bin/env bash
# Shared, fail-loud helpers for WRC NetworkPolicy live-convergence E2E gates.
# Source after e2e-lib.sh so kctl/ok/fail are available.

set -euo pipefail

wrc_np_spec_hash() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o json |
    python3 -c 'import hashlib,json,sys; spec=json.load(sys.stdin)["spec"]; payload=json.dumps(spec,sort_keys=True,separators=(",",":")).encode(); print(hashlib.sha256(payload).hexdigest())'
}

wrc_np_resource_version() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o jsonpath='{.metadata.resourceVersion}'
}

wrc_wait_for_np() {
  local namespace=$1 name=$2 timeout=${3:-120} elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if kctl get networkpolicy "$name" -n "$namespace" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "Timed out waiting for NetworkPolicy ${namespace}/${name}"
  return 1
}

wrc_wait_for_np_spec_hash() {
  local namespace=$1 name=$2 expected=$3 timeout=${4:-120} elapsed=0 actual
  while [ "$elapsed" -lt "$timeout" ]; do
    actual="$(wrc_np_spec_hash "$namespace" "$name" 2>/dev/null || true)"
    if [ -n "$actual" ] && [ "$actual" = "$expected" ]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "NetworkPolicy ${namespace}/${name} did not restore its baseline spec"
  return 1
}

wrc_inject_selector_drift() {
  local namespace=$1 name=$2
  kctl patch networkpolicy "$name" -n "$namespace" --type=merge \
    -p '{"spec":{"podSelector":{"matchLabels":{"e2e.clerum.io/forced-drift":"true"}}}}' \
    >/dev/null
}

wrc_trigger_recipe_reconcile() {
  local namespace=$1 name=$2 timeout=${3:-120}
  local before_generation after_generation marker patch since_time elapsed=0
  local controller_namespace=${WRC_CONTROLLER_NAMESPACE:-control-plane}
  local controller_deployment=${WRC_CONTROLLER_DEPLOYMENT:-workflow-recipes}
  local needle="[WR-Reconciler] Reconciling \"${name}\""

  before_generation="$(
    kctl get workflowrecipe "$name" -n "$namespace" -o jsonpath='{.metadata.generation}'
  )"
  [[ "$before_generation" =~ ^[0-9]+$ ]] || {
    fail "WorkflowRecipe ${namespace}/${name} has no numeric generation before reconcile trigger"
    return 1
  }

  WRC_NP_RECONCILE_SEQUENCE=${WRC_NP_RECONCILE_SEQUENCE:-0}
  WRC_NP_RECONCILE_SEQUENCE=$((WRC_NP_RECONCILE_SEQUENCE + 1))
  marker="np-e2e-${WRC_NP_RECONCILE_SEQUENCE}-$(date +%s)"
  patch="$(jq -cn --arg description "$marker" '{spec:{description:$description}}')"
  since_time="$(
    python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))'
  )"

  kctl patch workflowrecipe "$name" -n "$namespace" --type=merge -p "$patch" >/dev/null
  after_generation="$(
    kctl get workflowrecipe "$name" -n "$namespace" -o jsonpath='{.metadata.generation}'
  )"
  if [[ ! "$after_generation" =~ ^[0-9]+$ ]] || [ "$after_generation" -le "$before_generation" ]; then
    fail "WorkflowRecipe ${namespace}/${name} generation did not advance (${before_generation} -> ${after_generation})"
    return 1
  fi

  while [ "$elapsed" -lt "$timeout" ]; do
    if kctl logs -n "$controller_namespace" "deployment/${controller_deployment}" \
      --since-time="$since_time" 2>/dev/null | grep -Fq "$needle"; then
      ok "WorkflowRecipe ${namespace}/${name} entered reconcile at generation ${after_generation}"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "Timed out waiting for WRC to reconcile WorkflowRecipe ${namespace}/${name} generation ${after_generation}"
  return 1
}

wrc_assert_np_stable() {
  local namespace=$1 name=$2 settle_seconds=${3:-20}
  local before after
  before="$(wrc_np_resource_version "$namespace" "$name")"
  [ -n "$before" ] || {
    fail "NetworkPolicy ${namespace}/${name} has no resourceVersion before stability window"
    return 1
  }
  # This is an intentional no-churn observation window, not a readiness sleep:
  # the policy is already converged and the assertion is that later reconciles
  # do not update it.
  sleep "$settle_seconds"
  after="$(wrc_np_resource_version "$namespace" "$name")"
  if [ "$after" != "$before" ]; then
    fail "NetworkPolicy ${namespace}/${name} churned while converged (${before} -> ${after})"
    return 1
  fi
  ok "NetworkPolicy ${namespace}/${name} stayed at resourceVersion ${before}"
}
