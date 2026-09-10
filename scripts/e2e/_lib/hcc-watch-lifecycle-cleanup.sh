#!/usr/bin/env bash

HCC_CLEANUP_COMMAND_RUNNER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/hcc-cleanup-command.mjs"

# Each request consumes the remaining phase budget, including transport stalls.
# Never start a nested detached deadline runner in the cleanup process group.
hcc_cleanup_kctl() {
  local remaining request_seconds command_seconds arg is_delete=false is_rollout=false
  remaining=$((HCC_CLEANUP_PHASE_DEADLINE - SECONDS))
  [ "$remaining" -gt 0 ] || return 124
  request_seconds=$remaining
  [ "$request_seconds" -le 30 ] || request_seconds=30
  command_seconds=$request_seconds
  local args=()
  for arg in "$@"; do
    case "$arg" in
      --request-timeout=*|--timeout=*|--wait=*) ;;
      *) args+=("$arg") ;;
    esac
    [ "$arg" != delete ] || is_delete=true
    [ "$arg" != rollout ] || is_rollout=true
  done
  # Acceptance is followed by absence checks below; finalizers must not spend
  # the restoration budget. This override applies only inside lifecycle cleanup.
  if [ "$is_delete" = true ]; then args+=(--wait=false); fi
  if [ "$is_rollout" = true ]; then
    command_seconds=$remaining
    request_seconds=$remaining
    args+=(--timeout="${remaining}s")
  fi
  node "$HCC_CLEANUP_COMMAND_RUNNER" "$command_seconds" "$KUBECTL_BIN" \
    --context "$E2E_KUBECONTEXT" "${args[@]}" \
    --request-timeout="${request_seconds}s"
}

hcc_cleanup_wait_until() {
  local requested=$1 description=$2 deadline remaining
  shift 2
  deadline=$((SECONDS + requested))
  [ "$deadline" -le "$HCC_CLEANUP_PHASE_DEADLINE" ] || deadline=$HCC_CLEANUP_PHASE_DEADLINE
  while [ "$SECONDS" -lt "$deadline" ]; do
    "$@" && return 0
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    sleep 1
  done
  printf 'HCC cleanup deadline reached: %s\n' "$description" >&2
  return 1
}

hcc_lifecycle_fixture_absent() {
  local remaining host
  if [ "$NP604_CREATED" = 1 ]; then
    np604_resources_absent || return 1
    remaining="$(kctl get mcpserver,secret -n "$MCP_NS" \
      -l "e2e.clerum.io/suite=hcc-np604,e2e.clerum.io/run=${RUN_ID}" -o name)" || return 1
    [ -z "$remaining" ] || return 1
  fi
  remaining="$(kctl get mcpserver,context,host -A \
    -l "e2e.clerum.io/suite=hcc-watch-churn,e2e.clerum.io/run=${RUN_ID}" -o name)" || return 1
  [ -z "$remaining" ] || return 1
  while IFS= read -r host; do
    [ -n "$host" ] || continue
    remaining="$(kctl get pod,deployment,service,serviceaccount,role,rolebinding,secret,pvc,networkpolicy \
      -A -l "clerum.io/host=${host}" -o name)" || return 1
    [ -z "$remaining" ] || return 1
  done <<<"$HCC_CLEANUP_HOSTS"
  if [ "$FLEET_CREATED" = 1 ]; then
    remaining="$(kctl get secret "$FLEET_SECRET" -n "$HOST_NS" --ignore-not-found -o name)" || return 1
    [ -z "$remaining" ] || return 1
  fi
  if [ "$PROXY_CREATED" = 1 ]; then
    remaining="$(kctl get deployment,service "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found -o name)" || return 1
    [ -z "$remaining" ] || return 1
    remaining="$(kctl get pod -n "$HCC_NS" -l "app=${PROXY_NAME}" -o name)" || return 1
    [ -z "$remaining" ] || return 1
  fi
  if [ "$PROBE_CREATED" = 1 ]; then
    remaining="$(kctl get pod "$PROBE_NAME" -n "$HCC_NS" --ignore-not-found -o name)" || return 1
    [ -z "$remaining" ] || return 1
  fi
  if [ "$PROXY_CREATED" = 1 ] || [ "$PROBE_CREATED" = 1 ]; then
    remaining="$(kctl get networkpolicy "$PROXY_EGRESS_NP" "$HCC_PROXY_NP" "$PROBE_EGRESS_NP" \
      -n "$HCC_NS" --ignore-not-found -o name)" || return 1
    [ -z "$remaining" ] || return 1
  fi
  return 0
}

# Fixed budget: restore150 + fixtures100 + finalization20 = 270 seconds.
# The lifecycle target reserves 300 seconds of runner grace. Restoring HCC
# always precedes owner-driven fixture removal, which may never converge.
cleanup_hcc_lifecycle() (
  local status=$1 cleanup_failed=0 restore_ok=1 started=$SECONDS
  local HCC_CLEANUP_PHASE_DEADLINE=$((SECONDS + 150)) HCC_CLEANUP_HOSTS=''
  trap - EXIT
  trap ':' TERM INT HUP QUIT
  set +e
  kctl() { hcc_cleanup_kctl "$@"; }
  wait_until() { hcc_cleanup_wait_until "$@"; }

  # These are this shell's own capture children. Do not wait on a stalled stream.
  [ -z "${HCC_LOG_STREAM_PID:-}" ] || kill "$HCC_LOG_STREAM_PID" 2>/dev/null
  [ -z "${NP604_WATCH_PID:-}" ] || kill "$NP604_WATCH_PID" 2>/dev/null
  NP604_WATCH_PID=''
  if [ "$HCC_PATCHED" = 1 ]; then
    restore_hcc_after_churn || restore_ok=0
  fi
  if [ "$HCC_SCALED_DOWN" = 1 ] || [ "$HCC_PATCHED" = 1 ]; then
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 || restore_ok=0
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      --timeout=150s >/dev/null 2>&1 || restore_ok=0
  fi
  if [ "$restore_ok" != 1 ]; then
    print_repair_instructions
    cleanup_failed=1
  fi

  # Preserve the proxy if HCC might still depend on its redirected API route.
  if [ "$restore_ok" = 1 ]; then
    HCC_CLEANUP_PHASE_DEADLINE=$((started + 250))
    if [ "$FLEET_CREATED" = 1 ]; then
      HCC_CLEANUP_HOSTS="$(kctl get host -A \
        -l "e2e.clerum.io/suite=hcc-watch-churn,e2e.clerum.io/run=${RUN_ID}" \
        -o 'jsonpath={range .items[*]}{.metadata.name}{"\n"}{end}')" || cleanup_failed=1
    fi
    np604_cleanup || cleanup_failed=1
    [ "$FLEET_CREATED" != 1 ] || delete_synthetic_fleet || cleanup_failed=1
    [ "$PROXY_CREATED" != 1 ] || kctl delete deployment,service "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    [ "$PROBE_CREATED" != 1 ] || kctl delete pod "$PROBE_NAME" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    if [ "$PROXY_CREATED" = 1 ] || [ "$PROBE_CREATED" = 1 ]; then
      kctl delete networkpolicy "$PROXY_EGRESS_NP" "$HCC_PROXY_NP" "$PROBE_EGRESS_NP" \
        -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1 || cleanup_failed=1
    fi
    wait_until 100 'lifecycle fixture resources removed' hcc_lifecycle_fixture_absent || cleanup_failed=1
  fi

  HCC_CLEANUP_PHASE_DEADLINE=$((started + 270))
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  print_results || cleanup_failed=1
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" != 0 ]; then status=1; fi
  rm -f "$HCC_LOG_BUFFER" "$READY_SERIES"
  return "$status"
)
