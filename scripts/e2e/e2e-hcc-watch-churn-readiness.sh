#!/usr/bin/env bash
# HCC readiness under SUSTAINED apiserver watch churn (Premature close regime).
#
# Reproduces the PR #205 GKE livelock in minikube — a regime minikube does NOT
# exhibit by default (single stable apiserver, no balancer idle-timeout). A
# clerum-dev-scale synthetic fleet widens each NetworkPolicy revocation pass; a
# self-flapping API proxy resets the HCC watches mid-pass, bumping the watch
# generation so a generation-pinned isReadinessInventoryAuthoritative() could
# never certify. The content-identity fix must certify through the churn.
#
#   EXPECT_LIVELOCK=1  -> proves the reproducer: /ready stays 503 + divergent
#                         generation pattern (guards against a vacuous test).
#   EXPECT_LIVELOCK=0  -> proves the fix: /ready reaches 200 (1/1) under the
#                         SAME churn, and stays 200 through STABILITY_WINDOW_SEC.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-logs.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-churn-fixture.sh"

# ── Fail-closed guards (identical contract to the sibling HCC gates) ──
[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT/E2E_K8S_CONTEXT must select a branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing churn injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}
[ "${E2E_HCC_WATCH_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_WATCH_FAULT_INJECTION=1 to acknowledge fault injection." >&2
  exit 1
}
kctl get nodes -o json | jq -e --arg c "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $c)' >/dev/null ||
  {
    echo "Refusing churn injection: target is not this profile's minikube node." >&2
    exit 1
  }

# ── Tunables ──
HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
MCP_NS="${MCP_SERVER_NS:-mcp-server}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
CHURN_PERIOD_MS="${CHURN_PERIOD_MS:-7000}"
CHURN_MIN_AGE_MS="${CHURN_MIN_AGE_MS:-3000}"
CHURN_MIN_CUTS="${CHURN_MIN_CUTS:-3}"
READINESS_BUDGET_SEC="${READINESS_BUDGET_SEC:-360}"
STABILITY_WINDOW_SEC="${STABILITY_WINDOW_SEC:-30}"
FLEET_CONTEXTS="${FLEET_CONTEXTS:-24}"
FLEET_MCPSERVERS="${FLEET_MCPSERVERS:-115}"
FLEET_HOSTS="${FLEET_HOSTS:-8}"
EXPECT_LIVELOCK="${EXPECT_LIVELOCK:-0}"

RUN_ID="$(date +%s)-$$"
PROXY_NAME="$(truncate_rfc1123 "e2e-hcc-churn-proxy-${RUN_ID}")"
PROXY_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-api")"
HCC_PROXY_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-hcc")"
# The reused verify_hcc_proxy_network_policy runs a negative probe (a non-HCC pod
# that must NOT reach the proxy) and references these names.
PROBE_NAME="$(truncate_rfc1123 "${PROXY_NAME}-negative-probe")"
PROBE_EGRESS_NP="$(truncate_rfc1123 "${PROXY_NAME}-from-probe")"
FLEET_PREFIX="$(truncate_rfc1123 "e2e-hcc-churn-${RUN_ID}")"
FLEET_SECRET="$(truncate_rfc1123 "${FLEET_PREFIX}-llm")"
LOG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-churn.XXXXXX")"
ORIGINAL_REPLICAS=""
HCC_IMAGE=""
K8S_API_CIDR=""
PROXY_CREATED=0
PROBE_CREATED=0
FLEET_CREATED=0
HCC_PATCHED=0
# Log-stream state consumed by hcc-watch-recovery-logs.sh (start/stop_hcc_recovery_log_stream).
# Declared here so `set -u` never trips when the stream helper first touches them.
HCC_LOG_BUFFER="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-churn-stream.XXXXXX")"
HCC_LOG_STREAM_PID=""
START_TIME=""
# Verdict-evidence counters; assigned by recount_churn_evidence() before any read.
cuts=0 gen_pattern=0 total_watch_cut_lines=0 stable=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME="" HCC_GATE_LOCK_UID="" HCC_GATE_FINALIZATION_FAILURE=""

die() {
  fail "$*"
  exit 1
}

wait_until() {
  local timeout=$1 description=$2
  shift 2
  local deadline now
  deadline=$(($(date +%s) + timeout))
  while :; do
    "$@" && return 0
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  echo "Timed out after ${timeout}s waiting for ${description}" >&2
  return 1
}

running_hcc_pod() {
  local rows
  rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' \
    2>/dev/null)" || return 1
  awk -F '\t' '$1 != "" && $2 == "" { print $1; exit }' <<<"$rows"
}

hcc_pods_absent() {
  local pods
  pods="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o name 2>/dev/null)" || return 1
  [ -z "$pods" ]
}

ready_status() {
  local pod=$1
  kctl exec "pod/$pod" -n "$HCC_NS" -c host-context-controller -- \
    wget -T 10 -t 1 -qO- http://127.0.0.1:8081/ready >/dev/null 2>&1 && echo 200 || echo 503
}

print_repair_instructions() {
  cat >&2 <<EOF
HCC watch-churn gate cleanup could not restore a verified clean state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Churn proxy: ${HCC_NS}/${PROXY_NAME}
Synthetic fleet label: e2e.clerum.io/suite=hcc-watch-churn (run ${RUN_ID})

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment,service,networkpolicy -l e2e.clerum.io/suite=hcc-watch-churn

Restore the HCC deployment (remove redirect env + hostAliases, restore replicas):
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} set env deployment/${HCC_DEPLOY} \\
    KUBERNETES_SERVICE_HOST- KUBERNETES_SERVICE_PORT- CONTEXT_MAPPER_K8S_API_CIDRS-
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} patch deployment/${HCC_DEPLOY} --type=merge \\
    -p '{"spec":{"template":{"spec":{"hostAliases":null}}}}'
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=180s
EOF
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  trap - EXIT
  set +e
  stop_hcc_recovery_log_stream
  if [ "$HCC_PATCHED" = 1 ]; then
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null 2>&1
    wait_until 120 "HCC stop" hcc_pods_absent >/dev/null 2>&1 || restore_ok=0
  fi
  [ "$FLEET_CREATED" = 1 ] && { delete_synthetic_fleet || cleanup_failed=1; }
  if [ "$HCC_PATCHED" = 1 ]; then
    restore_hcc_after_churn || restore_ok=0
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=180s >/dev/null 2>&1 || restore_ok=0
  fi
  [ "$PROXY_CREATED" = 1 ] && kctl delete deployment,service "$PROXY_NAME" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1
  [ "$PROBE_CREATED" = 1 ] && kctl delete pod "$PROBE_NAME" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1
  kctl delete networkpolicy "$PROXY_EGRESS_NP" "$HCC_PROXY_NP" "$PROBE_EGRESS_NP" -n "$HCC_NS" --ignore-not-found >/dev/null 2>&1
  [ "$restore_ok" = 1 ] || {
    print_repair_instructions
    cleanup_failed=1
  }
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  print_results || status=1
  [ "$cleanup_failed" = 0 ] || status=1
  rm -f "$HCC_LOG_BUFFER"
  exit "$status"
}
trap cleanup EXIT

# ── FASE A: guards + snapshot ──
require_branch_owned_hcc_gate "$HCC_NS"
acquire_hcc_watch_gate_lock
ORIGINAL_REPLICAS="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] || die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
[ -z "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.hostAliases}')" ] ||
  die "HCC already has hostAliases; refusing a non-restorable injection"
HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
[ -n "$HCC_IMAGE" ] || die "could not resolve the running HCC image"
api_ip="$(kctl exec deployment/"$HCC_DEPLOY" -n "$HCC_NS" -c host-context-controller -- \
  printenv KUBERNETES_SERVICE_HOST)" || die "could not read API service IP"
K8S_API_CIDR="${api_ip}/32"

# ── FASE B: redirect through the self-flapping proxy (HCC still healthy) ──
log "Creating self-flapping API proxy (period=${CHURN_PERIOD_MS}ms, min-age=${CHURN_MIN_AGE_MS}ms)"
create_hcc_churn_proxy "$CHURN_PERIOD_MS" "$CHURN_MIN_AGE_MS"
verify_hcc_proxy_network_policy
proxy_ip="$(kctl get service "$PROXY_NAME" -n "$HCC_NS" -o jsonpath='{.spec.clusterIP}')"
[ -n "$proxy_ip" ] || die "proxy Service has no ClusterIP"
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null
wait_until 120 "HCC pods to stop" hcc_pods_absent || die "HCC did not stop before fleet creation"

# ── FASE C: synthetic clerum-dev-scale fleet (HCC stopped) ──
log "Creating synthetic fleet: ${FLEET_CONTEXTS} Contexts / ${FLEET_MCPSERVERS} McpServers / ${FLEET_HOSTS} Hosts"
create_synthetic_fleet "$FLEET_CONTEXTS" "$FLEET_MCPSERVERS" "$FLEET_HOSTS"
ok "synthetic fleet created (${FLEET_MCPSERVERS} McpServers)"

# ── FASE D: start HCC under churn and poll /ready ──
log "Redirecting HCC through the churn proxy and starting it under load"
patch="$(jq -cn --arg ip "$proxy_ip" --arg cidr "$K8S_API_CIDR" '{spec:{template:{spec:{
  hostAliases:[{ip:$ip,hostnames:["kubernetes.default.svc"]}],
  containers:[{name:"host-context-controller",env:[
    {name:"KUBERNETES_SERVICE_HOST",value:"kubernetes.default.svc"},
    {name:"KUBERNETES_SERVICE_PORT",value:"443"},
    {name:"CONTEXT_MAPPER_K8S_API_CIDRS",value:$cidr}]}]}}}}')"
kctl patch deployment "$HCC_DEPLOY" -n "$HCC_NS" --type=strategic -p "$patch" >/dev/null
HCC_PATCHED=1
kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1 >/dev/null
# Anchor the log stream to now so recovery-cycle assertions only see churn-era logs.
START_TIME="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
start_hcc_recovery_log_stream

deadline=$(($(date +%s) + READINESS_BUDGET_SEC))
first_ready=""
last_status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  pod="$(running_hcc_pod)" || {
    sleep 2
    continue
  }
  [ -n "$pod" ] || {
    sleep 2
    continue
  }
  last_status="$(ready_status "$pod")"
  if [ "$last_status" = 200 ]; then
    first_ready="$((READINESS_BUDGET_SEC - (deadline - $(date +%s))))"
    break
  fi
  sleep 3
done
# ── Churn accounting over the FULL raw stream ──
# hcc_recovery_logs() pre-filters the buffer with the RECOVERY gate's patterns
# (CommunicationChannel/Listing all Hosts/...). The McpServer, Context and Host
# "watch ended" lines — and the "authority changed before ... admission"
# divergence line — contain none of those tokens and were dropped before
# counting. This gate counts on $HCC_LOG_BUFFER directly.
count_buffer() { grep -Ec "$1" "$HCC_LOG_BUFFER" || true; }

recount_churn_evidence() {
  # One Context-watch line per proxy cut cycle: the Context watch generation is
  # what pinned the pre-fix safety certificate, and a single proxy tick cuts
  # ALL watches at once (a raw 'watch ended' line count would let ONE real cut
  # satisfy CHURN_MIN_CUTS). cuts therefore counts churn CYCLES, not lines.
  cuts="$(count_buffer '\[K8s\] Context watch ended; recovering authoritative inventory')"
  total_watch_cut_lines="$(count_buffer 'watch ended')"
  gen_pattern="$(count_buffer 'authority changed before .* admission')"
}

write_evidence_artifact() {
  # Diagnostics ONLY — nothing here feeds the verdict (cuts/gen_pattern/
  # first_ready/stable are computed before this runs), so every command is
  # deliberately best-effort: under `set -euo pipefail`, an empty grep in this
  # block aborted the whole gate BEFORE the verdict on the first live run.
  {
    echo "=== HCC deploy ==="
    kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o wide || true
    echo "=== last /ready: ${last_status}  cut-cycles=${cuts}  watch-cut-lines=${total_watch_cut_lines}  gen-diverge=${gen_pattern}  first-ready=${first_ready:-never} ==="
    grep -E 'watch ended|authority changed|Recovered|inventory' "$HCC_LOG_BUFFER" | tail -60 || true
  } >"$LOG_ARTIFACT" 2>&1 || true
}

# ── Stability window (fix mode only) — the churn keeps cutting while we hold ──
if [ "$EXPECT_LIVELOCK" = 0 ] && [ -n "$first_ready" ]; then
  stable=1
  s_deadline=$(($(date +%s) + STABILITY_WINDOW_SEC))
  while [ "$(date +%s)" -lt "$s_deadline" ]; do
    pod="$(running_hcc_pod)" || { stable=0; break; }
    [ -n "$pod" ] || { stable=0; break; }
    [ "$(ready_status "$pod")" = 200 ] || { stable=0; break; }
    sleep 3
  done
fi

# Snapshot the buffer only AFTER the stability window: with first_ready≈6s the
# readiness loop alone has seen ~1 cut; the window adds STABILITY_WINDOW_SEC of
# further churn, which is what makes CHURN_MIN_CUTS satisfiable in fix mode.
# In livelock mode the readiness loop already consumed READINESS_BUDGET_SEC.
require_hcc_recovery_log_stream ||
  warn "HCC log stream ended before the verdict; counting the frozen buffer (fail-closed: an undercount can only turn this gate RED)"
stop_hcc_recovery_log_stream
recount_churn_evidence
write_evidence_artifact

# ── Verdict ──
if [ "$EXPECT_LIVELOCK" = 1 ]; then
  [ "$cuts" -ge "$CHURN_MIN_CUTS" ] &&
    ok "churn cut the Context watch ${cuts}x (>= ${CHURN_MIN_CUTS}; ${total_watch_cut_lines} watch-ended lines total)" ||
    fail "churn cut the Context watch only ${cuts}x — reproducer is VACUOUS"
  [ "$gen_pattern" -ge 1 ] && ok "observed divergent-generation admission pattern ${gen_pattern}x" ||
    fail "no divergent-generation pattern — bug mechanism NOT exercised"
  if [ -z "$first_ready" ]; then
    # Cross-check the exec probe against the kubelet's own view: a broken
    # ready_status (wrong container/port) reports 503 forever and would fake
    # the livelock. readyReplicas is omitted from status when it is 0.
    ready_replicas="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
    if [ -z "$ready_replicas" ] || [ "$ready_replicas" = 0 ]; then
      ok "livelock reproduced: /ready stayed 503 for ${READINESS_BUDGET_SEC}s under churn (kubelet agrees: 0 ready replicas)"
    else
      fail "exec probe reported 503 but the Deployment shows ${ready_replicas} ready replica(s) — probe is broken, reproducer VACUOUS"
    fi
  else
    fail "expected livelock but /ready reached 200 at ${first_ready}s — reproducer does not exercise the bug"
  fi
else
  [ "$cuts" -ge "$CHURN_MIN_CUTS" ] &&
    ok "churn was real: ${cuts} Context-watch cuts (${total_watch_cut_lines} watch-ended lines) across readiness+stability" ||
    fail "fix validated WITHOUT churn (${cuts} Context-watch cuts) — result is worthless"
  if [ -n "$first_ready" ]; then
    ok "fix converged to Ready under sustained Premature close (time-to-Ready=${first_ready}s)"
    [ "$stable" = 1 ] && ok "readiness stable for ${STABILITY_WINDOW_SEC}s under continuous churn" ||
      fail "readiness oscillated 200->503 under churn — fix not stable"
  else
    fail "fix did NOT reach Ready under churn within ${READINESS_BUDGET_SEC}s — livelock regression (see ${LOG_ARTIFACT})"
  fi
fi
log "Evidence artifact: ${LOG_ARTIFACT}"
# cleanup() (EXIT trap) restores HCC, deletes the fleet, and runs print_results.
