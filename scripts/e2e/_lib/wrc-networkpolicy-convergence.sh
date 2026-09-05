#!/usr/bin/env bash
# Shared, fail-loud helpers for WRC NetworkPolicy live-convergence E2E gates.
# Source after e2e-lib.sh so kctl/ok/fail are available.

set -euo pipefail

WRC_NP_RECONCILE_BINDING='{}'
WRC_NP_OBSERVATION_SINCE=""
WRC_NP_OBSERVATION_PODS='[]'
WRC_NP_TRACKED='[]'

wrc_require_networkpolicy_lease() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
  if [ -z "${KUBECONTEXT:-}" ] || [ "$KUBECONTEXT" != "${MINIKUBE_PROFILE:-}" ] ||
     [ "$KUBECONTEXT" != "${T2_CONTEXT:-${CONTROL_API_REAL_PG_CONTEXT:-}}" ]; then
    printf 'PROFILE_LOCK_REQUIRED: WRC NetworkPolicy E2E needs the matching explicit owned profile/context\n' >&2
    return 1
  fi
  bash "$root/scripts/minikube/require-t2-mutation-lock.sh"
}

wrc_now() {
  python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))'
}

# Track every controller replica and container incarnation, so rolling/restarted
# observers cannot silently lose the beginning of a no-write window.
wrc_controller_snapshot() {
  local namespace=${WRC_CONTROLLER_NAMESPACE:-control-plane}
  local deployment=${WRC_CONTROLLER_DEPLOYMENT:-workflow-recipes} definition selector replicas
  definition="$(kctl get deployment "$deployment" -n "$namespace" -o json)" || return 1
  selector="$(printf '%s' "$definition" | jq -er '
    .spec.selector | select((.matchExpressions // [] | length) == 0)
    | .matchLabels | select(length > 0) | to_entries | sort_by(.key)
    | map(.key + "=" + .value) | join(",")')" || return 1
  replicas="$(printf '%s' "$definition" | jq -er '.spec.replicas // 1 | select(. > 0)')" || return 1
  kctl get pods -n "$namespace" -l "$selector" -o json | jq -ce --argjson replicas "$replicas" '
    .items | select(length == $replicas)
    | select(all(.[]; .metadata.deletionTimestamp == null and .status.phase == "Running"
        and (.status.containerStatuses | length > 0)
        and all(.status.containerStatuses[]; .ready == true and (.containerID | length > 0))))
    | map({name:.metadata.name,uid:.metadata.uid,
        containers:(.status.containerStatuses | sort_by(.name) | map({name,containerID,restartCount}))})
    | sort_by(.name)'
}

wrc_controller_logs() {
  local snapshot=$1 since=$2 pod logs
  local namespace=${WRC_CONTROLLER_NAMESPACE:-control-plane}
  while IFS= read -r pod; do
    [ -n "$pod" ] || return 1
    logs="$(kctl logs "$pod" -n "$namespace" --all-containers=true --timestamps=true \
      --since-time="$since")" || return 1
    printf '%s\n' "$logs"
  done < <(printf '%s' "$snapshot" | jq -r '.[].name')
}

# Kubernetes timestamps delimit the cursor; mixed legacy console lines are not
# JSON events. Rejecting writes is done over all events, never the first match.
wrc_log_events() {
  local since=$1
  jq -Rsc --arg since "$since" '
    def timestamp_key:
      sub("Z$"; "") | split(".")
      | .[0] + "." + (((.[1] // "") + "000000000")[0:9]);
    ($since | timestamp_key) as $start
    | split("\n") | map(
      try (capture("^(?<at>[0-9T:.+-]+Z) (?<payload>.*)$")
        | select((.at | timestamp_key) >= $start)
        | .payload | fromjson | select(type == "object")) catch empty)'
}

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
  local before_generation after_generation marker patch since_time started=$SECONDS
  local recipe uid snapshot events logs

  recipe="$(kctl get workflowrecipe "$name" -n "$namespace" -o json)" || return 1
  before_generation="$(printf '%s' "$recipe" | jq -er '.metadata.generation')" || return 1
  uid="$(printf '%s' "$recipe" | jq -er '.metadata.uid | select(length > 0)')" || return 1
  [[ "$before_generation" =~ ^[0-9]+$ ]] || {
    fail "WorkflowRecipe ${namespace}/${name} has no numeric generation before reconcile trigger"
    return 1
  }

  WRC_NP_RECONCILE_SEQUENCE=${WRC_NP_RECONCILE_SEQUENCE:-0}
  WRC_NP_RECONCILE_SEQUENCE=$((WRC_NP_RECONCILE_SEQUENCE + 1))
  marker="np-e2e-${WRC_NP_RECONCILE_SEQUENCE}-$(date +%s)"
  patch="$(jq -cn --arg description "$marker" '{spec:{description:$description}}')"
  snapshot="$(wrc_controller_snapshot)" || return 1
  since_time="$(wrc_now)"

  kctl patch workflowrecipe "$name" -n "$namespace" --type=merge -p "$patch" >/dev/null
  after_generation="$(
    kctl get workflowrecipe "$name" -n "$namespace" -o jsonpath='{.metadata.generation}'
  )"
  if [[ ! "$after_generation" =~ ^[0-9]+$ ]] || [ "$after_generation" -le "$before_generation" ]; then
    fail "WorkflowRecipe ${namespace}/${name} generation did not advance (${before_generation} -> ${after_generation})"
    return 1
  fi
  WRC_NP_RECONCILE_BINDING="$(jq -cn --arg recipe "$name" --arg namespace "$namespace" \
    --arg uid "$uid" --argjson generation "$after_generation" '{recipe:$recipe,namespace:$namespace,uid:$uid,generation:$generation}')"

  while [ "$((SECONDS - started))" -lt "$timeout" ]; do
    [ "$(wrc_controller_snapshot)" = "$snapshot" ] || {
      fail "WRC observer changed during the parent reconcile"
      return 1
    }
    logs="$(wrc_controller_logs "$snapshot" "$since_time")" || return 1
    events="$(printf '%s' "$logs" | wrc_log_events "$since_time")" || return 1
    if printf '%s' "$events" | jq -e --argjson binding "$WRC_NP_RECONCILE_BINDING" '
      any(.[]; .msg == "recipe reconciliation completed" and .recipe == $binding.recipe
        and .namespace == $binding.namespace and .uid == $binding.uid and .generation == $binding.generation)' >/dev/null; then
      ok "WorkflowRecipe ${namespace}/${name} completed reconcile at generation ${after_generation}"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done

  fail "Timed out waiting for WRC to reconcile WorkflowRecipe ${namespace}/${name} generation ${after_generation}"
  return 1
}

wrc_begin_np_observation() {
  WRC_NP_OBSERVATION_SINCE="$(wrc_now)"
  WRC_NP_OBSERVATION_PODS="$(wrc_controller_snapshot)" || return 1
  WRC_NP_TRACKED='[]'
  WRC_NP_RECONCILE_BINDING='{}'
}

wrc_track_np() {
  local namespace=$1 name=$2 family=$3 mode=${4:-apply} policy
  local message='network policy unchanged; skipping update'
  [ -n "$WRC_NP_OBSERVATION_SINCE" ] && [ "$WRC_NP_RECONCILE_BINDING" = '{}' ] || {
    fail 'NetworkPolicy baseline must be captured before the reconcile trigger'
    return 1
  }
  if [ "$mode" = "workload-egress-prefilter" ]; then
    message='network policy egress set unchanged; skipping live apply'
  elif [ "$mode" != "apply" ]; then
    fail "Unknown NetworkPolicy observation mode: ${mode}"
    return 1
  fi
  policy="$(kctl get networkpolicy "$name" -n "$namespace" -o json)" || return 1
  policy="$(printf '%s' "$policy" | jq -ce --arg namespace "$namespace" --arg policy "$name" \
    --arg family "$family" --arg message "$message" '
      select(.metadata.deletionTimestamp == null and (.metadata.uid | length > 0)
        and (.metadata.resourceVersion | length > 0))
      | {namespace:$namespace,policy:$policy,family:$family,message:$message,
          uid:.metadata.uid,rv:.metadata.resourceVersion}')" || return 1
  WRC_NP_TRACKED="$(printf '%s' "$WRC_NP_TRACKED" | jq -c --argjson policy "$policy" '. + [$policy]')"
}

wrc_assert_np_observation_clean() {
  local seconds=${1:-20} timeout=${2:-120} started=$SECONDS logs events row current missing
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] && [[ "$timeout" =~ ^[1-9][0-9]*$ ]] &&
    [ "$seconds" -le 300 ] && [ "$timeout" -le 600 ] && [ "$timeout" -ge "$seconds" ] || return 1
  [ -n "$WRC_NP_OBSERVATION_SINCE" ] && [ "$WRC_NP_TRACKED" != '[]' ] &&
    [ "$WRC_NP_RECONCILE_BINDING" != '{}' ] || {
    fail 'NetworkPolicy observation has no baseline, tracked policies, or completed trigger'
    return 1
  }
  while [ "$((SECONDS - started))" -le "$timeout" ]; do
    [ "$(wrc_controller_snapshot)" = "$WRC_NP_OBSERVATION_PODS" ] || {
      fail 'WRC observer changed; the NetworkPolicy window is incomplete'
      return 1
    }
    logs="$(wrc_controller_logs "$WRC_NP_OBSERVATION_PODS" "$WRC_NP_OBSERVATION_SINCE")" || {
      fail 'Unable to read the complete WRC observation window'
      return 1
    }
    events="$(printf '%s' "$logs" | wrc_log_events "$WRC_NP_OBSERVATION_SINCE")" || return 1
    # Match writes by namespace/name even if a broken writer mislabels family.
    if printf '%s' "$events" | jq -e --argjson tracked "$WRC_NP_TRACKED" '
      any(.[]; . as $event | any($tracked[]; .namespace == $event.namespace and .policy == $event.policy)
        and ((.msg // "") | test("^network policy (created|replaced|create failed|replace failed|read failed)$")))' >/dev/null; then
      fail 'NetworkPolicy window contains a write or failed operation, even if a no-op also occurred'
      return 1
    fi
    while IFS= read -r row; do
      current="$(kctl get networkpolicy "$(printf '%s' "$row" | jq -r '.policy')" \
        -n "$(printf '%s' "$row" | jq -r '.namespace')" -o json)" || return 1
      if ! printf '%s' "$current" | jq -e --argjson before "$row" '
        .metadata.uid == $before.uid and .metadata.resourceVersion == $before.rv
        and .metadata.deletionTimestamp == null' >/dev/null; then
        fail 'NetworkPolicy changed since its pre-trigger baseline'
        return 1
      fi
    done < <(printf '%s' "$WRC_NP_TRACKED" | jq -c '.[]')
    missing="$(printf '%s' "$events" | jq -r --argjson tracked "$WRC_NP_TRACKED" \
      --argjson binding "$WRC_NP_RECONCILE_BINDING" '
      . as $events | ([ $tracked[] | . as $p | select(any($events[];
        .policy == $p.policy and .namespace == $p.namespace and .family == $p.family and .msg == $p.message) | not)] | length)
      + (if any($events[]; .msg == "recipe reconciliation completed" and .recipe == $binding.recipe
          and .namespace == $binding.namespace and .uid == $binding.uid and .generation == $binding.generation
          and .phase == "active" and .requeueAfterMs == 0) then 0 else 1 end)')" || return 1
    if [ "$missing" = 0 ] && [ "$((SECONDS - started))" -ge "$seconds" ]; then
      ok 'Full NetworkPolicy window contains all no-op witnesses, no writes, and unchanged pre-trigger UID/resourceVersion'
      WRC_NP_OBSERVATION_SINCE=""
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail 'NetworkPolicy observation lacked an exact completed reconcile or a required no-op witness'
  return 1
}

# stdout carries a nonce-bound remote result; stderr/exec failure is a harness
# error. Only a completed connection timeout is a negative network observation.
wrc_http_probe() {
  local namespace=$1 target=$2 host=$3 port=$4 seconds=${E2E_CONNECT_TIMEOUT:-6}
  local nonce="np-$$-${RANDOM}-${RANDOM}" output begin end outcome encoded rest
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -gt 0 ] && [ "$port" -le 65535 ] &&
    [[ "$seconds" =~ ^[1-9][0-9]*$ ]] && [ "$seconds" -le 30 ] || return 1
  # shellcheck disable=SC2016
  if ! output="$(kctl exec "$target" -n "$namespace" -- sh -c '
    export LC_ALL=C
    for tool in nc grep base64 tr mktemp; do command -v "$tool" >/dev/null 2>&1 || exit 20; done
    nonce=$1; host=$2; port=$3; seconds=$4
    errors=$(mktemp) || exit 21
    trap '\''rm -f "$errors"'\'' EXIT HUP INT TERM
    printf "WRC_NP_BEGIN|%s\n" "$nonce"
    # BusyBox nc is silent on connect timeout unless verbose mode is enabled.
    # Keep stderr private and require a connection-specific diagnostic: neither
    # a silent exit nor a timeout after connecting proves NetworkPolicy denial.
    response=$(printf "GET / HTTP/1.0\r\nHost: e2e\r\nConnection: close\r\n\r\n" | nc -v -w "$seconds" "$host" "$port" 2>"$errors")
    status=$?
    if [ "$status" -eq 0 ] && printf "%s" "$response" | grep -Eq "^HTTP/1\.[01] [2345][0-9][0-9]"; then
      printf "WRC_NP_END|%s|http|" "$nonce"
      printf "%s" "$response" | base64 | tr -d "\n"
      printf "\n"
    elif [ "$status" -eq 1 ] && [ -z "$response" ] && grep -Eqi "connect(ion)? .*timed out" "$errors"; then
      printf "WRC_NP_END|%s|timeout|\n" "$nonce"
    else
      exit 22
    fi
  ' -- "$nonce" "$host" "$port" "$seconds")"; then
    fail "HTTP probe executor failed for ${namespace}/${target}; this is not NetworkPolicy denial" >&2
    return 1
  fi
  begin="$(printf '%s\n' "$output" | sed -n '1p')"
  end="$(printf '%s\n' "$output" | sed -n '2p')"
  rest="$(printf '%s\n' "$output" | sed -n '3,$p')"
  [ "$begin" = "WRC_NP_BEGIN|$nonce" ] && [ -z "$rest" ] &&
    [[ "$end" == "WRC_NP_END|${nonce}|"* ]] || return 1
  end="${end#WRC_NP_END|${nonce}|}"
  outcome="${end%%|*}"
  encoded="${end#*|}"
  case "$outcome" in
    http) [ -n "$encoded" ] || return 1 ;;
    timeout) [ -z "$encoded" ] || return 1 ;;
    *) return 1 ;;
  esac
  jq -cen --arg outcome "$outcome" --arg body "$encoded" '
    {outcome:$outcome,body:$body}
    | select((.outcome == "timeout" and .body == "") or
      (.outcome == "http" and (.body | test("^[A-Za-z0-9+/]+={0,2}$"))
        and ((.body | length) % 4 == 0)
        and (.body | @base64d | test("^HTTP/1\\.[01] [2345][0-9][0-9]"))))'
}

wrc_assert_http_allowed() {
  local description=$1 namespace=$2 target=$3 host=$4 port=$5 expected=${6:-} result
  local started=$SECONDS timeout=${E2E_PROBE_TIMEOUT:-30}
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] && [ "$timeout" -le 120 ] || return 1
  while [ "$((SECONDS - started))" -lt "$timeout" ]; do
    result="$(wrc_http_probe "$namespace" "$target" "$host" "$port")" || return 1
    if printf '%s' "$result" | jq -e --arg expected "$expected" '
      .outcome == "http" and ((.body | @base64d) | contains($expected))' >/dev/null; then
      ok "$description"
      return 0
    fi
    # Policy acknowledgement precedes CNI programming. Only valid remote
    # network outcomes may be retried; executor failures abort immediately.
    sleep "$POLL_INTERVAL"
  done
  fail "$description: expected an HTTP response from the reachable fixture"
  return 1
}

wrc_assert_http_blocked() {
  local description=$1 namespace=$2 target=$3 host=$4 port=$5 result
  local started=$SECONDS timeout=${E2E_PROBE_TIMEOUT:-30}
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] && [ "$timeout" -le 120 ] || return 1
  while [ "$((SECONDS - started))" -lt "$timeout" ]; do
    result="$(wrc_http_probe "$namespace" "$target" "$host" "$port")" || return 1
    if printf '%s' "$result" | jq -e '.outcome == "timeout"' >/dev/null; then
      ok "$description"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "$description: unexpected successful connection"
  return 1
}

# A fixture-owned permission for one direction, peer and port. Complementary
# controls isolate the boundary being tested without changing platform policy.
wrc_create_connection_policy() {
  local name=$1 direction=$2 namespace=$3 selector=$4 peer_namespace=$5 peer_selector=$6 port=$7
  case "$direction" in Ingress|Egress) ;; *) return 1 ;; esac
  jq -cn --arg name "$name" --arg direction "$direction" --arg namespace "$namespace" \
    --argjson selector "$selector" --arg peerNamespace "$peer_namespace" \
    --argjson peerSelector "$peer_selector" --argjson port "$port" '
    {namespaceSelector:{matchLabels:{"kubernetes.io/metadata.name":$peerNamespace}},
      podSelector:{matchLabels:$peerSelector}} as $peer
    | {ports:[{protocol:"TCP",port:$port}]} as $ports
    | {apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",
        metadata:{name:$name,namespace:$namespace},
        spec:({podSelector:{matchLabels:$selector},policyTypes:[$direction]} +
          if $direction == "Ingress" then {ingress:[($ports + {from:[$peer]})]}
          else {egress:[($ports + {to:[$peer]})]} end)}' | wrc_create_owned
}
