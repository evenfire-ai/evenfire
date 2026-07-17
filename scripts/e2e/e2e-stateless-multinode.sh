#!/usr/bin/env bash
# ======================================================================
# E2E — Stateless multi-node lane (Stage 7 Part B)
#
# Meaningful checks for a minikube multi-node cluster with node-pinned
# local-path storage. This lane proves stateless suspend/wake sequencing
# and eviction/rescheduling behavior that a single-node profile cannot.
#
# It does NOT assert cross-node re-attach of the state PVC: node-pinned
# local-path storage has no cross-node re-attach; that behavior needs a
# zonal Persistent Disk and is a T3 gate on example-dev. When everything
# else passes, this lane emits the UNVERIFIED marker for that gap and exits 3.
#
# Opt-in only: run when STATELESS_MULTINODE_GATE=1. Without it, the lane
# refuses (exit 2) so the shared single-node profile is never mistaken for
# multi-node evidence.
#
# EXIT CODES:
#   0  all checks passed AND cross-node single-attach was somehow provable
#      (not expected on local-path; reserved for a future zonal-PD profile)
#   1  a real assertion failed (hard fail, loud reason)
#   2  precondition not met: gate not enabled, or < 2 schedulable nodes
#   3  all runnable checks passed; cross-node single-attach UNVERIFIED
#      (documented limitation on node-pinned local-path storage)
#
# Usage:
#   STATELESS_MULTINODE_GATE=1 KUBECONTEXT=clerum-codex-<topic>-<sha> \
#     bash scripts/e2e/e2e-stateless-multinode.sh
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

if [ "${STATELESS_MULTINODE_GATE:-0}" != "1" ]; then
  echo "[E2E] Stateless multi-node lane is opt-in. Set STATELESS_MULTINODE_GATE=1 to run it." >&2
  echo "[E2E] Refusing to run so a single-node profile is never mistaken for multi-node evidence." >&2
  exit 2
fi

HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"

E2E_TURN_TIMEOUT="${E2E_TURN_TIMEOUT:-120}"
POD_READY_TIMEOUT="${POD_READY_TIMEOUT:-240}"
SUSPEND_WINDOW="${SUSPEND_WINDOW:-180}"
WAKE_HOLD_DEADLINE="${WAKE_HOLD_DEADLINE:-270}"
RESCHEDULE_TIMEOUT="${RESCHEDULE_TIMEOUT:-180}"
BATCH_EVICT_TIMEOUT="${BATCH_EVICT_TIMEOUT:-180}"

HCC_DEPLOY="host-context-controller"
HCC_NS="${CONTROL_NS:-control-plane}"
RUN_ID="$(date +%s)-$$-${RANDOM}"
THREAD_ID="e2e-stateless-multinode-${RUN_ID}"
BATCH_POD="clerum-batch-${RUN_ID}"
BATCH_PRIORITY_CLASS="clerum-batch"
INTERACTIVE_PRIORITY_CLASS="clerum-interactive-host"

# ─── Cleanup trap ────────────────────────────────────────────────────
HCC_ENV_SAVED=""
CORDONED_NODE=""
TAINTED_NODE=""
BATCH_APPLIED=0
MULTIATTACH_APPLIED=0
MULTIATTACH_POD="clerum-multiattach-${RUN_ID}"

restore_hcc_env() {
  [ -n "$HCC_ENV_SAVED" ] || return 0
  local args=() key val
  while IFS='=' read -r key val; do
    [ -n "$key" ] || continue
    if [ -n "$val" ]; then args+=("${key}=${val}"); else args+=("${key}-"); fi
  done <<< "$HCC_ENV_SAVED"
  [ ${#args[@]} -gt 0 ] || return 0
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null 2>&1 || \
    warn "failed to restore HCC env"
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 || \
    warn "HCC rollout did not settle after env restore"
}

cleanup_on_exit() {
  local status=$?
  set +e
  if [ "$BATCH_APPLIED" = "1" ]; then
    kctl delete pod "$BATCH_POD" -n "$MCP_HOST_NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
  fi
  if [ "$MULTIATTACH_APPLIED" = "1" ]; then
    kctl delete pod "$MULTIATTACH_POD" -n "$MCP_HOST_NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
  fi
  if [ -n "$TAINTED_NODE" ]; then
    kctl taint node "$TAINTED_NODE" node.kubernetes.io/out-of-service:NoExecute- >/dev/null 2>&1
  fi
  if [ -n "$CORDONED_NODE" ]; then
    kctl uncordon "$CORDONED_NODE" >/dev/null 2>&1
  fi
  restore_hcc_env
  exit "$status"
}
trap cleanup_on_exit EXIT

pod_diagnostics() {
  echo "--- diagnostics for app=${HOST_REF} in ${MCP_HOST_NS} ---" >&2
  kctl get pods -n "$MCP_HOST_NS" -l "app=${HOST_REF}" -o wide 2>/dev/null >&2 || true
  kctl get nodes -o wide 2>/dev/null >&2 || true
}

current_ready_pod() { ready_pod_name "$MCP_HOST_NS" "app=${HOST_REF}"; }

wait_for_ready_pod() {
  local timeout=$1 exclude="${2:-}" elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(current_ready_pod); then
      if [ -z "$exclude" ] || [ "$name" != "$exclude" ]; then printf "%s\n" "$name"; return 0; fi
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

pod_node() {
  kctl get pod "$1" -n "$MCP_HOST_NS" -o jsonpath='{.spec.nodeName}' 2>/dev/null || true
}

# wait_for_pod_running <pod> <ns> <timeout> -- succeed only when the pod phase
# is literally "Running". A kubectl error or any other phase keeps waiting;
# expiry returns non-zero so the caller can hard-fail.
wait_for_pod_running() {
  local pod=$1 ns=$2 timeout=$3 elapsed=0 phase
  while [ "$elapsed" -lt "$timeout" ]; do
    phase="$(kctl get pod "$pod" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")"
    if [ "$phase" = "Running" ]; then return 0; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# pod_is_absent <pod> <ns> -- return 0 ONLY when kubectl DEFINITIVELY reports the
# pod does not exist (NotFound). A transient API/get error (any other stderr or
# rc) returns 2 so it can NEVER be mistaken for an eviction. Pod present -> 1.
pod_is_absent() {
  local pod=$1 ns=$2 err rc
  err="$(kctl get pod "$pod" -n "$ns" -o name 2>&1 >/dev/null)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    return 1
  fi
  case "$err" in
    *NotFound*|*"not found"*) return 0 ;;
    *) return 2 ;;
  esac
}

# ─── RPC helpers (Desktop App auth path) ─────────────────────────────
SESSION_TOKEN=""; RPC_TOKEN=""
mint_session_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/auth/password-login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')") || {
    echo "password-login request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [ "$code" = "200" ] || { echo "password-login -> HTTP ${code}: ${body}" >&2; return 1; }
  SESSION_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$SESSION_TOKEN" ] || { echo "password-login returned no .token" >&2; return 1; }
}
mint_rpc_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg h "$HOST_REF" '{hostRefs:[$h],scopes:["host:message:invoke","host:session:read","host:status:read","host:health:read","host:wake:write"]}')") || {
    echo "rpc/token request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [ "$code" = "200" ] || { echo "rpc/token -> HTTP ${code}: ${body}" >&2; return 1; }
  RPC_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [ -n "$RPC_TOKEN" ] || { echo "rpc/token returned no .token" >&2; return 1; }
}
TURN_STATUS=""; TURN_BODY=""
send_turn_expect_ok() {
  local content=$1 deadline=$((SECONDS + WAKE_HOLD_DEADLINE)) resp
  while [ "$SECONDS" -lt "$deadline" ]; do
    mint_rpc_token || return 1
    resp=$(curl -sS -m "$E2E_TURN_TIMEOUT" -w '\n%{http_code}' -X POST \
      "${RPC_BASE}/api/v1/rpc/hosts/${HOST_REF}/messages" \
      -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json' \
      -d "$(jq -cn --arg c "$content" --arg t "$THREAD_ID" '{content:$c,threadId:$t}')") || {
      echo "message POST failed at ${RPC_BASE}" >&2; return 1; }
    TURN_STATUS="$(echo "$resp" | tail -n1)"; TURN_BODY="$(echo "$resp" | sed '$d')"
    if [ "$TURN_STATUS" = "200" ]; then return 0; fi
    if [ "$TURN_STATUS" = "503" ] && echo "$TURN_BODY" | grep -q 'host_waking'; then
      log "host_waking (retryable) — re-issuing within wake-hold deadline"; sleep 3; continue
    fi
    echo "turn returned non-retryable HTTP ${TURN_STATUS}: ${TURN_BODY}" >&2; return 1
  done
  echo "wake-and-hold deadline (${WAKE_HOLD_DEADLINE}s) exceeded" >&2; return 1
}
# ─── Lifecycle observables ───────────────────────────────────────────
lifecycle_state() { kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true; }
deployment_replicas() { kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo ""; }
wait_for_suspended() {
  local timeout=$1 elapsed=0 st reps running
  while [ "$elapsed" -lt "$timeout" ]; do
    st="$(lifecycle_state)"; reps="$(deployment_replicas)"
    if ! running="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
      echo "wait_for_suspended: failed to count Running pods for ${HOST_REF}" >&2
      return 1
    fi
    if [ "$st" = "suspended" ] && [ "${reps:-1}" = "0" ] && [ "${running:-1}" = "0" ]; then return 0; fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

# ====================================================================== #
#  (a) Hard requirement: >= 2 schedulable nodes
# ====================================================================== #
header "Multi-node lane — schedulable node requirement"
mapfile -t SCHEDULABLE_NODES < <(kctl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.unschedulable}{"\n"}{end}' 2>/dev/null \
  | awk -F'\t' '$2 != "true" {print $1}')
node_count=${#SCHEDULABLE_NODES[@]}
if [ "$node_count" -lt 2 ]; then
  echo "[E2E] EXIT 2 — this lane requires >= 2 schedulable nodes, found ${node_count}." >&2
  echo "[E2E] Node list:" >&2
  kctl get nodes -o wide >&2 2>/dev/null || true
  exit 2
fi
ok "found ${node_count} schedulable nodes: ${SCHEDULABLE_NODES[*]}"

# Prereqs — host + services reachable.
stateless_flag=$(kctl get host "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")
if [ "$stateless_flag" = "true" ]; then ok "Host '${HOST_REF}' is stateless"; else
  fail "Host '${HOST_REF}' missing or not stateless (got '${stateless_flag:-<absent>}')"; print_results; exit 1; fi
for svc in "external-rest-api ${EXT_BASE}" "rpc-proxy ${RPC_BASE}"; do
  name="${svc%% *}"; base="${svc##* }"
  curl -fsS -m 10 "${base}/health" >/dev/null 2>&1 && ok "${name} reachable" || { fail "${name} NOT reachable at ${base}"; print_results; exit 1; }
done
mint_session_token || { fail "cannot login as ${DEV_EMAIL}"; print_results; exit 1; }
ok "session token minted"
host_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || { fail "no Ready host pod"; pod_diagnostics; print_results; exit 1; }
HOST_NODE="$(pod_node "$host_pod")"
ok "host pod ${host_pod} on node ${HOST_NODE}"

# Speed up the idle gate on this lane too.
header "Setting HCC test cadences"
saved=""
for k in CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS; do
  cur="$(kctl get "deployment/${HCC_DEPLOY}" -n "$HCC_NS" -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${k}')].value}" 2>/dev/null || true)"
  saved+="${k}=${cur}"$'\n'
done
HCC_ENV_SAVED="$saved"
kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" \
  CONTEXT_MAPPER_STATELESS_IDLE_MINUTES=1 CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES=1 \
  CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS=20000 CONTEXT_MAPPER_HEARTBEAT_POLL_MS=5000 >/dev/null 2>&1 || {
  fail "failed to set HCC cadences"; print_results; exit 1; }
kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 || {
  fail "HCC rollout did not settle"; print_results; exit 1; }
ok "HCC test cadences applied"

# ====================================================================== #
#  (b) Suspend/wake sequencing + single-writer timeline
# ====================================================================== #
header "(b) suspend/wake sequencing + single-writer timeline"
if send_turn_expect_ok "Reply with exactly: MULTINODE_BASELINE_${RUN_ID}"; then ok "baseline turn served"; else
  fail "baseline turn failed"; print_results; exit 1; fi
if wait_for_suspended "$SUSPEND_WINDOW"; then ok "host suspended (replicas 0, pod gone)"; else
  fail "host did not suspend within ${SUSPEND_WINDOW}s (state=$(lifecycle_state))"; pod_diagnostics; print_results; exit 1; fi
if ! running_before="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
  fail "could not count Running pods before the multi-node wake"
  pod_diagnostics; print_results; exit 1
fi
if send_turn_expect_ok "Reply with exactly: MULTINODE_WAKE_${RUN_ID}"; then ok "wake-served turn"; else
  fail "wake turn failed"; pod_diagnostics; print_results; exit 1; fi
new_pod=$(wait_for_ready_pod "$POD_READY_TIMEOUT") || { fail "no Ready pod after wake"; print_results; exit 1; }
if ! running_after="$(running_pod_count "$MCP_HOST_NS" "app=${HOST_REF}")"; then
  fail "could not count Running pods after the multi-node wake"
  pod_diagnostics; print_results; exit 1
fi
if [ "${running_before:-0}" = "0" ] && [ "${running_after:-0}" = "1" ]; then
  ok "single-writer: 0 running at suspend -> exactly 1 after wake (${new_pod})"
else
  fail "single-writer violated: running before=${running_before} after=${running_after}"; print_results; exit 1
fi
HOST_NODE="$(pod_node "$new_pod")"
ok "host now on node ${HOST_NODE}"

# ====================================================================== #
#  (c) Node-loss: cordon + out-of-service taint => loud, bounded reschedule
# ====================================================================== #
header "(c) node-loss reschedule (cordon + out-of-service taint)"
victim_pod=$(current_ready_pod) || { fail "no active host pod for node-loss test"; print_results; exit 1; }
VICTIM_NODE="$(pod_node "$victim_pod")"
[ -n "$VICTIM_NODE" ] || { fail "could not resolve node for pod ${victim_pod}"; print_results; exit 1; }
# There must be at least one OTHER schedulable node to reschedule onto.
other_schedulable=0
for n in "${SCHEDULABLE_NODES[@]}"; do [ "$n" != "$VICTIM_NODE" ] && other_schedulable=1; done
if [ "$other_schedulable" != "1" ]; then
  fail "(c): no schedulable node other than ${VICTIM_NODE} to reschedule onto"; print_results; exit 1
fi
CORDONED_NODE="$VICTIM_NODE"
kctl cordon "$VICTIM_NODE" >/dev/null 2>&1 || { fail "(c): cordon ${VICTIM_NODE} failed"; print_results; exit 1; }
TAINTED_NODE="$VICTIM_NODE"
kctl taint node "$VICTIM_NODE" node.kubernetes.io/out-of-service:NoExecute --overwrite >/dev/null 2>&1 \
  || { fail "(c): tainting ${VICTIM_NODE} out-of-service failed"; print_results; exit 1; }
log "cordoned + tainted ${VICTIM_NODE}; expecting reschedule onto another node within ${RESCHEDULE_TIMEOUT}s"
resched=0; r_elapsed=0
while [ "$r_elapsed" -lt "$RESCHEDULE_TIMEOUT" ]; do
  if np=$(current_ready_pod); then
    nn="$(pod_node "$np")"
    if [ -n "$nn" ] && [ "$nn" != "$VICTIM_NODE" ]; then resched=1; RESCHEDULED_NODE="$nn"; RESCHEDULED_POD="$np"; break; fi
  fi
  sleep "$POLL_INTERVAL"; r_elapsed=$((r_elapsed + POLL_INTERVAL))
done
if [ "$resched" = "1" ]; then
  ok "(c): pod rescheduled onto ${RESCHEDULED_NODE} (${RESCHEDULED_POD}) — loud + bounded (${r_elapsed}s)"
else
  fail "(c): pod did NOT reschedule off ${VICTIM_NODE} within ${RESCHEDULE_TIMEOUT}s (node-pinned local-path storage can bind the pod to the lost node — this is the expected T3 limitation, but the reschedule attempt must be loud, not silent)"
  pod_diagnostics; print_results; exit 1
fi
# Untaint + uncordon now that we proved reschedule.
kctl taint node "$VICTIM_NODE" node.kubernetes.io/out-of-service:NoExecute- >/dev/null 2>&1 || true
TAINTED_NODE=""
kctl uncordon "$VICTIM_NODE" >/dev/null 2>&1 || true
CORDONED_NODE=""
HOST_NODE="$RESCHEDULED_NODE"

# ====================================================================== #
#  (d) Preemption behavioral: filler evicted on wake, no mcp-server evicted
# ====================================================================== #
header "(d) preemption — wake evicts a low-priority filler, never an mcp-server"
# Suspend the host so the wake path has to schedule it fresh.
if wait_for_suspended "$SUSPEND_WINDOW"; then ok "host suspended for preemption test"; else
  fail "(d): host did not suspend before preemption test"; pod_diagnostics; print_results; exit 1; fi
host_priority="$(kctl get deployment "$HOST_REF" -n "$MCP_HOST_NS" -o jsonpath='{.spec.template.spec.priorityClassName}' 2>/dev/null || true)"
if [ "$host_priority" = "$INTERACTIVE_PRIORITY_CLASS" ]; then
  ok "(d): stateless host uses ${INTERACTIVE_PRIORITY_CLASS} before preemption"
else
  fail "(d): stateless host priorityClassName is '${host_priority:-<empty>}', expected ${INTERACTIVE_PRIORITY_CLASS}"; print_results; exit 1
fi
# Size the filler to consume the host node's allocatable headroom so the host
# pod can only schedule by EVICTING the (lower-priority) filler. Read the node's
# allocatable millicores and request nearly all of the remaining headroom for
# the filler, so a second real pod cannot fit without preemption. If we cannot
# parse a usable millicore value we fall back to a fixed 750m reservation and
# say so loudly (never silently).
ALLOC_CPU="$(kctl get node "$HOST_NODE" -o jsonpath='{.status.allocatable.cpu}' 2>/dev/null || echo "")"
[ -n "$ALLOC_CPU" ] || { fail "(d): could not read allocatable cpu for ${HOST_NODE}"; print_results; exit 1; }
# Normalize allocatable cpu ("4", "3920m") to millicores.
case "$ALLOC_CPU" in
  *m) alloc_milli="${ALLOC_CPU%m}" ;;
  *[!0-9]*) alloc_milli="" ;;
  *) alloc_milli=$((ALLOC_CPU * 1000)) ;;
esac
if [ -n "$alloc_milli" ] && [ "$alloc_milli" -gt 500 ] 2>/dev/null; then
  # Reserve headroom minus a small slack so the filler fits now but the host
  # wake genuinely needs to preempt it. Floor at 750m to stay meaningful.
  FILLER_CPU=$((alloc_milli - 300))
  [ "$FILLER_CPU" -lt 750 ] && FILLER_CPU=750
  FILLER_CPU="${FILLER_CPU}m"
  ok "(d): sized filler to ${FILLER_CPU} from ${HOST_NODE} allocatable ${ALLOC_CPU} (headroom-consuming)"
else
  FILLER_CPU="750m"
  warn "(d): could not parse allocatable cpu '${ALLOC_CPU}' to millicores -- using fixed ${FILLER_CPU} filler reservation"
fi
# Emit the filler manifest with a chosen priorityClassName ($1 empty = none).
render_filler() {
  local pcl="$1"
  printf '%s\n' \
"apiVersion: v1" \
"kind: Pod" \
"metadata:" \
"  name: ${BATCH_POD}" \
"  namespace: ${MCP_HOST_NS}" \
"  labels:" \
"    clerum.io/role: batch-filler" \
"spec:"
  [ -n "$pcl" ] && printf '  priorityClassName: %s\n' "$pcl"
  printf '%s\n' \
"  nodeName: ${HOST_NODE}" \
"  terminationGracePeriodSeconds: 0" \
"  containers:" \
"    - name: filler" \
"      image: registry.k8s.io/pause:3.9" \
"      resources:" \
"        requests:" \
"          cpu: \"${FILLER_CPU}\"" \
"          memory: \"128Mi\""
}
# Reserve the headroom with the required lower-priority class. Do not fall back
# to the default priority: that would let this test pass without proving the
# deployed PriorityClass contract.
BATCH_APPLIED=1
render_filler "$BATCH_PRIORITY_CLASS" | kctl apply -f - >/dev/null 2>&1 || {
  fail "(d): could not create a ${BATCH_PRIORITY_CLASS} filler pod; PriorityClass deployment is a prerequisite"
  print_results
  exit 1
}
# The filler MUST actually be scheduled and Running before the wake, otherwise a
# "filler is gone" assertion after the wake would be vacuous (it was never
# there). Hard-fail if it does not reach Running in a bounded window.
if wait_for_pod_running "$BATCH_POD" "$MCP_HOST_NS" "$POD_READY_TIMEOUT"; then
  ok "(d): filler pod is Running on ${HOST_NODE} before the wake (preemption target established)"
else
  fail "(d): filler pod never reached Running within ${POD_READY_TIMEOUT}s -- cannot prove preemption against a pod that never ran"; pod_diagnostics; print_results; exit 1
fi
# Record mcp-server pods before wake so we can prove none are evicted.
mapfile -t MCP_SERVER_PODS_BEFORE < <(kctl get pods -n "${MCP_SERVER_NS:-mcp-server}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
# Wake the host -- it must land Ready, the filler must be evicted/gone.
if send_turn_expect_ok "Reply with exactly: PREEMPT_${RUN_ID}"; then ok "(d): host woke and served under node pressure"; else
  fail "(d): host did not wake under node pressure"; pod_diagnostics; print_results; exit 1; fi
wait_for_ready_pod "$POD_READY_TIMEOUT" >/dev/null || { fail "(d): host pod not Ready after wake under pressure"; pod_diagnostics; print_results; exit 1; }
# The filler must be gone/evicted within a bounded window. Distinguish a genuine
# eviction (Failed phase OR definitive NotFound) from a transient kubectl get
# error: pod_is_absent returns 0 ONLY on NotFound, never on an API glitch, so a
# `kctl` error can no longer score as eviction evidence.
evicted=0; b_elapsed=0
while [ "$b_elapsed" -lt "$BATCH_EVICT_TIMEOUT" ]; do
  phase="$(kctl get pod "$BATCH_POD" -n "$MCP_HOST_NS" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")"
  if [ "$phase" = "Failed" ]; then evicted=1; break; fi
  if pod_is_absent "$BATCH_POD" "$MCP_HOST_NS"; then evicted=1; break; fi
  sleep "$POLL_INTERVAL"; b_elapsed=$((b_elapsed + POLL_INTERVAL))
done
if [ "$evicted" = "1" ]; then
  ok "(d): batch filler evicted/gone to make room for the host wake"
else
  fail "(d): batch filler still present after ${BATCH_EVICT_TIMEOUT}s -- the host wake did not preempt the low-priority filler"; pod_diagnostics; print_results; exit 1
fi
# No mcp-server pod may have been evicted. Same NotFound-safe rule: only a
# Failed phase or a DEFINITIVE absence counts, never a transient get error.
mcp_evicted=""
for msp in "${MCP_SERVER_PODS_BEFORE[@]}"; do
  [ -z "$msp" ] && continue
  ph="$(kctl get pod "$msp" -n "${MCP_SERVER_NS:-mcp-server}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")"
  if [ "$ph" = "Failed" ] || pod_is_absent "$msp" "${MCP_SERVER_NS:-mcp-server}"; then
    mcp_evicted="${mcp_evicted} ${msp}"
  fi
done
if [ -z "$mcp_evicted" ]; then
  ok "(d): no mcp-server pod was evicted by the host wake"
else
  fail "(d): mcp-server pod(s) were evicted by the host wake:${mcp_evicted} — the host must never preempt an MCP server"; print_results; exit 1
fi
kctl delete pod "$BATCH_POD" -n "$MCP_HOST_NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
BATCH_APPLIED=0

# ====================================================================== #
#  (e) NEGATIVE: RWO Multi-Attach surfaces (never a silent hang)
# ====================================================================== #
# §15 demands a negative test alongside the UNVERIFIED cross-node marker: force
# a SECOND pod to mount the host's RWO state PVC on a DIFFERENT node while the
# host pod still holds it, and assert Kubernetes surfaces a Multi-Attach /
# FailedAttachVolume event within a bounded window (rather than the new pod
# hanging silently). RWO can be co-mounted on the SAME node, so the overlapping
# pod MUST land on a node other than the host pod's node to trigger the error.
header "(e-neg) RWO Multi-Attach surfaces on a cross-node overlapping mount"
# The host must be RUNNING (PVC attached to its node) for the overlap to
# conflict. Wake it and confirm Ready + capture its node.
if send_turn_expect_ok "Reply with exactly: MULTIATTACH_SETUP_${RUN_ID}"; then
  ok "(e-neg): host running for the overlap test"
else
  fail "(e-neg): host did not wake to hold the RWO PVC"; pod_diagnostics; print_results; exit 1
fi
host_pod_e="$(wait_for_ready_pod "$POD_READY_TIMEOUT")" || { fail "(e-neg): no Ready host pod to hold the PVC"; pod_diagnostics; print_results; exit 1; }
HOST_NODE_E="$(pod_node "$host_pod_e")"
[ -n "$HOST_NODE_E" ] || { fail "(e-neg): could not resolve host pod node"; print_results; exit 1; }
HOST_PVC="${HOST_REF}-workspace"
if ! kctl get pvc "$HOST_PVC" -n "$MCP_HOST_NS" >/dev/null 2>&1; then
  fail "(e-neg): host RWO PVC '${HOST_PVC}' not found in ${MCP_HOST_NS} — cannot run the Multi-Attach negative"; print_results; exit 1
fi
# Pick a schedulable node that is NOT the host's node.
OTHER_NODE=""
for n in "${SCHEDULABLE_NODES[@]}"; do
  if [ "$n" != "$HOST_NODE_E" ]; then OTHER_NODE="$n"; break; fi
done
[ -n "$OTHER_NODE" ] || { fail "(e-neg): no schedulable node other than ${HOST_NODE_E} to force a cross-node overlap"; print_results; exit 1; }
# Create an overlapping pod on the OTHER node mounting the same RWO PVC.
MULTIATTACH_APPLIED=1
printf '%s\n' \
"apiVersion: v1" \
"kind: Pod" \
"metadata:" \
"  name: ${MULTIATTACH_POD}" \
"  namespace: ${MCP_HOST_NS}" \
"  labels:" \
"    clerum.io/role: multiattach-probe" \
"spec:" \
"  nodeName: ${OTHER_NODE}" \
"  terminationGracePeriodSeconds: 0" \
"  restartPolicy: Never" \
"  containers:" \
"    - name: probe" \
"      image: registry.k8s.io/pause:3.9" \
"      volumeMounts:" \
"        - name: workspace" \
"          mountPath: /mnt/workspace" \
"  volumes:" \
"    - name: workspace" \
"      persistentVolumeClaim:" \
"        claimName: ${HOST_PVC}" \
  | kctl apply -f - >/dev/null 2>&1 || { fail "(e-neg): could not create overlapping Multi-Attach probe pod on ${OTHER_NODE}"; print_results; exit 1; }
ok "(e-neg): overlapping pod ${MULTIATTACH_POD} scheduled on ${OTHER_NODE} (host holds ${HOST_PVC} on ${HOST_NODE_E})"
# Assert a Multi-Attach / FailedAttachVolume event surfaces within a bound.
MULTIATTACH_TIMEOUT="${MULTIATTACH_TIMEOUT:-180}"
ma_seen=0; ma_elapsed=0
while [ "$ma_elapsed" -lt "$MULTIATTACH_TIMEOUT" ]; do
  ev="$(kctl get events -n "$MCP_HOST_NS" \
    --field-selector "involvedObject.name=${MULTIATTACH_POD}" \
    -o jsonpath='{range .items[*]}{.reason}{"|"}{.message}{"\n"}{end}' 2>/dev/null || true)"
  if printf '%s' "$ev" | grep -qiE 'Multi-Attach|FailedAttachVolume|Volume is already (exclusively )?attached'; then
    ma_seen=1; break
  fi
  sleep "$POLL_INTERVAL"; ma_elapsed=$((ma_elapsed + POLL_INTERVAL))
done
if [ "$ma_seen" = "1" ]; then
  ok "(e-neg): Multi-Attach/FailedAttachVolume surfaced within ${ma_elapsed}s — RWO conflict fails loud, no silent hang"
else
  echo "--- (e-neg) diagnostics: no Multi-Attach event within ${MULTIATTACH_TIMEOUT}s ---" >&2
  kctl describe pod "$MULTIATTACH_POD" -n "$MCP_HOST_NS" 2>/dev/null | tail -40 >&2 || true
  kctl get events -n "$MCP_HOST_NS" --field-selector "involvedObject.name=${MULTIATTACH_POD}" -o wide 2>/dev/null >&2 || true
  fail "(e-neg): expected a Multi-Attach/FailedAttachVolume event for the cross-node overlapping RWO mount within ${MULTIATTACH_TIMEOUT}s — the conflict did not surface"; print_results; exit 1
fi
kctl delete pod "$MULTIATTACH_POD" -n "$MCP_HOST_NS" --ignore-not-found --grace-period=0 --force >/dev/null 2>&1
MULTIATTACH_APPLIED=0

# ====================================================================== #
#  (e) Cross-node re-attach: NOT asserted here (UNVERIFIED, exit 3)
# ====================================================================== #
header "(e) cross-node single-attach — UNVERIFIED on local-path"
print_results
echo
echo "UNVERIFIED: cross-node single-attach (requires zonal PD — T3 gate on example-dev)"
echo "  Node-pinned local-path storage cannot re-attach the state PVC on a"
echo "  different node, so this lane deliberately does not assert cross-node"
echo "  single-writer re-attach. Every other multi-node check passed."
exit 3
