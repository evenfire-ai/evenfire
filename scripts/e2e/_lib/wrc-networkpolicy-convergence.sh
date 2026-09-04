#!/usr/bin/env bash
# Shared, fail-loud helpers for WRC NetworkPolicy live-convergence E2E gates.
# Source after e2e-lib.sh so kctl/ok/fail are available.

set -euo pipefail

WRC_NP_LAST_RECONCILE_SINCE_TIME=""

wrc_np_spec_hash() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o json |
    python3 -c 'import hashlib,json,sys; spec=json.load(sys.stdin)["spec"]; payload=json.dumps(spec,sort_keys=True,separators=(",",":")).encode(); print(hashlib.sha256(payload).hexdigest())'
}

wrc_np_resource_version() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o jsonpath='{.metadata.resourceVersion}'
}

wrc_np_uid() {
  local namespace=$1 name=$2
  kctl get networkpolicy "$name" -n "$namespace" -o jsonpath='{.metadata.uid}'
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

wrc_wait_for_np_recreated() {
  local namespace=$1 name=$2 previous_uid=$3 expected_hash=$4 timeout=${5:-120} elapsed=0
  local current_uid deletion_timestamp current_hash
  while [ "$elapsed" -lt "$timeout" ]; do
    current_uid="$(wrc_np_uid "$namespace" "$name" 2>/dev/null || true)"
    deletion_timestamp="$(
      kctl get networkpolicy "$name" -n "$namespace" \
        -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null || true
    )"
    current_hash="$(wrc_np_spec_hash "$namespace" "$name" 2>/dev/null || true)"
    if [ -n "$current_uid" ] && [ "$current_uid" != "$previous_uid" ] &&
       [ -z "$deletion_timestamp" ] && [ "$current_hash" = "$expected_hash" ]; then
      ok "NetworkPolicy ${namespace}/${name} was recreated by the scheduled retry"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  fail "NetworkPolicy ${namespace}/${name} was not recreated after its terminating race"
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
  WRC_NP_LAST_RECONCILE_SINCE_TIME="$since_time"

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

wrc_wait_for_np_noop_witness() {
  local namespace=$1 name=$2 family=$3 mode=${4:-apply} timeout=${5:-120} elapsed=0
  local controller_namespace=${WRC_CONTROLLER_NAMESPACE:-control-plane}
  local controller_deployment=${WRC_CONTROLLER_DEPLOYMENT:-workflow-recipes}
  local message='network policy unchanged; skipping update'

  [ -n "$WRC_NP_LAST_RECONCILE_SINCE_TIME" ] || {
    fail "No parent reconcile timestamp is available for NetworkPolicy ${namespace}/${name}"
    return 1
  }
  if [ "$mode" = "workload-egress-prefilter" ]; then
    message='network policy egress set unchanged; skipping live apply'
  elif [ "$mode" != "apply" ]; then
    fail "Unknown NetworkPolicy no-op witness mode: ${mode}"
    return 1
  fi

  while [ "$elapsed" -lt "$timeout" ]; do
    if kctl logs -n "$controller_namespace" "deployment/${controller_deployment}" \
      --since-time="$WRC_NP_LAST_RECONCILE_SINCE_TIME" 2>/dev/null |
      jq -Rse --arg message "$message" --arg policy "$name" --arg namespace "$namespace" \
        --arg family "$family" '
          split("\n")
          | map(try fromjson catch null)
          | any(
              . != null and
              .msg == $message and
              .policy == $policy and
              .namespace == $namespace and
              .family == $family
            )
        ' >/dev/null; then
      ok "NetworkPolicy ${namespace}/${name} emitted its ${family} no-op witness"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  fail "NetworkPolicy ${namespace}/${name} emitted no ${family} no-op witness after the parent reconcile"
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
