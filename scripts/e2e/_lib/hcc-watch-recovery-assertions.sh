#!/usr/bin/env bash

# Runtime assertions shared by the HCC CommunicationChannel watch-recovery gate.
# The parent gate provides kctl/die and initializes the referenced fixture names.

current_hcc_identity() {
  local pods current count uid restarts
  pods="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running -o json)" || { echo invalid; return; }
  current="$(jq -c '[.items[] |
    select(.metadata.deletionTimestamp == null) |
    select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))]' <<<"$pods")"
  count="$(jq -r 'length' <<<"$current")"
  [ "$count" = 1 ] || { echo invalid; return; }
  uid="$(jq -r '.[0].metadata.uid' <<<"$current")"
  restarts="$(jq -r '.[0].status.containerStatuses[0].restartCount // 0' <<<"$current")"
  printf '%s %s\n' "$uid" "${restarts:-0}"
}

wait_for_hcc_identity() {
  local timeout=${1:-30} elapsed=0 identity
  while [ "$elapsed" -lt "$timeout" ]; do
    identity="$(current_hcc_identity)"
    if [ "$identity" != invalid ]; then
      printf '%s\n' "$identity"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

assert_hcc_identity() {
  local identity
  identity="$(current_hcc_identity)"
  [ "$identity" = "${HCC_UID} ${HCC_RESTARTS}" ] ||
    die "HCC restarted during recovery (expected ${HCC_UID}/${HCC_RESTARTS}, got ${identity})"
}

wait_host_mode() {
  local host=$1 expected=$2 timeout=${3:-150} elapsed=0 status reason stateless_env
  local host_doc
  while [ "$elapsed" -lt "$timeout" ]; do
    host_doc="$(kctl get host "$host" -n "$HOST_NS" -o json 2>/dev/null || printf '{}')"
    status="$(jq -r '[.status.conditions[]? | select(.type == "StatelessEnableRejected")][0].status // ""' <<<"$host_doc")"
    reason="$(jq -r '[.status.conditions[]? | select(.type == "StatelessEnableRejected")][0].reason // ""' <<<"$host_doc")"
    stateless_env="$(kctl get deployment "$host" -n "$HOST_NS" \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLERUM_STATELESS_LIFECYCLE")].value}' 2>/dev/null || true)"
    if [ "$expected" = accepted ] && [ "$status" = False ] &&
      [ "$reason" = StatelessEnabled ] && [ "$stateless_env" = true ]; then
      return 0
    fi
    if [ "$expected" = blocked ] && [ "$status" = True ] &&
      [ "$reason" = ActiveCommunicationChannels ] && [ "$stateless_env" != true ] &&
      host_runtime_is_always_on "$host"; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "Host mode timeout: host=${host}, expected=${expected}, status=${status:-}, reason=${reason:-}, statelessEnv=${stateless_env:-}" >&2
  return 1
}

assert_control_identity() {
  local actual
  actual="$(deployment_identity "$CONTROL_HOST")"
  [ "$actual" = "$CONTROL_IDENTITY" ] ||
    die "stateful control Deployment/pod identity changed during fleet recovery (expected ${CONTROL_IDENTITY}, got ${actual})"
}

assert_stateful_control() {
  local spec_stateless
  spec_stateless="$(kctl get host "$CONTROL_HOST" -n "$HOST_NS" \
    -o jsonpath='{.spec.lifecycle.stateless}')"
  [ "$spec_stateless" = false ] ||
    die "control Host is not explicitly stateful (spec.lifecycle.stateless=${spec_stateless:-missing})"
  if kctl get deployment "$CONTROL_HOST" -n "$HOST_NS" -o json | jq -e '
    any(.spec.template.spec.containers[].env[]?;
      .name == "CLERUM_STATELESS_LIFECYCLE")' >/dev/null; then
    die "stateful control Deployment unexpectedly contains CLERUM_STATELESS_LIFECYCLE"
  fi
  host_runtime_is_always_on "$CONTROL_HOST" || die "stateful control runtime is not active"
  assert_control_identity
}

scale_proxy() {
  local replicas=$1 elapsed=0 current
  kctl scale deployment "$PROXY_NAME" -n "$HCC_NS" --replicas="$replicas" >/dev/null
  if [ "$replicas" = 1 ]; then
    kctl rollout status deployment "$PROXY_NAME" -n "$HCC_NS" --timeout=90s >/dev/null
    return
  fi
  while [ "$elapsed" -lt 45 ]; do
    current="$(kctl get deployment "$PROXY_NAME" -n "$HCC_NS" \
      -o jsonpath='{.status.replicas}' 2>/dev/null || true)"
    { [ -z "$current" ] || [ "$current" = 0 ]; } && return 0
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}
