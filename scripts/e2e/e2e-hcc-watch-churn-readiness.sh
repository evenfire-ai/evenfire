#!/usr/bin/env bash
# HCC readiness under SUSTAINED apiserver watch churn (Premature close regime).
#
# SCOPE — this e2e proves ONLY the POSITIVE case: the content-identity fix
# (PR #382) certifies /ready THROUGH sustained watch churn in a REAL cluster,
# plus anti-vacuity (the churn actually cut every watch, repeatedly). It does
# NOT reproduce the pre-fix livelock as a NEGATIVE — that is STRUCTURALLY
# impossible in minikube. The pre-fix's authoritative NetworkPolicy revocation
# pass (where the watch generation matters) runs at connection age < the
# flapper's min-age (~0.3s on a local apiserver), so it is never cut; and any
# min-age small enough to cut it also kills the re-LIST/re-WATCH that BOTH the
# fixed and pre-fix builds need to recover — so both would livelock (a false
# positive), never a clean discrimination. Empirically confirmed: fix and
# pre-fix converge identically under 7s AND 3s churn.
#
# The livelock RED lives, hermetically and MUTATION-VERIFIED, in
#   host-context-controller/src/k8sClient.test.ts
#   "McpServerWatcher readiness under sustained watch churn (GKE Premature-close
#    regime)"
# which bumps the generation DURING each authoritative pass — the interleaving
# minikube cannot produce. RED there + GREEN here is the complete proof.
#
# The fail-closed contract means a cut watch drops /ready to 503 TRANSIENTLY
# (~recovery + re-LIST) and re-certifies with NO content change; under sustained
# churn the correct regime is a bounded 503/200 duty cycle, NOT an unbroken 200.
# The gate measures CONVERGENCE — bounded 503 streaks, repeated 503->200
# recoveries, and post-churn re-certification of the SAME non-restarted pod —
# never the absence of 503s. EXPECT_LIVELOCK=1 is refused (see the guard below).
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
# The NEGATIVE (pre-fix livelock) is not reproducible in minikube — see the SCOPE
# note above. Refuse EXPECT_LIVELOCK=1 rather than pretend to reproduce it.
[ "${EXPECT_LIVELOCK:-0}" != 1 ] || {
  echo "EXPECT_LIVELOCK=1 is not supported: the pre-fix livelock cannot be reproduced" >&2
  echo "in minikube (the authoritative pass is structurally uncuttable). The livelock" >&2
  echo "RED lives in host-context-controller/src/k8sClient.test.ts ('McpServerWatcher" >&2
  echo "readiness under sustained watch churn (GKE Premature-close regime)')." >&2
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
# Longest tolerated CONTINUOUS 503 streak under churn: immediate re-LIST +
# re-WATCH + a jittered backoff retry if that first attempt fails. A livelock
# produces an unbounded streak.
RECOVERY_BUDGET_SEC="${RECOVERY_BUDGET_SEC:-15}"
# 1Hz observation window under churn after first Ready (fix mode): ~8 cut
# cycles at the default 7s cadence, enough for repeated 503->200 evidence.
CHURN_OBSERVE_SEC="${CHURN_OBSERVE_SEC:-60}"
# Post-churn convergence budget once the proxy stops cutting: one recovery
# timer + LIST + margin. The absorbing-state detector.
POST_STOP_READY_SEC="${POST_STOP_READY_SEC:-15}"
# >= 2 full cycles x 3 informers (Context/McpServer/Host) must have been cut.
WATCH_CUT_MIN_LINES="${WATCH_CUT_MIN_LINES:-6}"
# Minimum distinct 503->200 transitions under churn: one recovery could be a
# fluke; repeated recovery refutes the livelock.
MIN_CHURN_RECOVERIES="${MIN_CHURN_RECOVERIES:-2}"
FLEET_CONTEXTS="${FLEET_CONTEXTS:-24}"
FLEET_MCPSERVERS="${FLEET_MCPSERVERS:-115}"
FLEET_HOSTS="${FLEET_HOSTS:-8}"

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
# 1Hz /ready sample series: "<epoch> <status> <phase>" per line. Streaks and
# transitions are derived from this file at verdict time.
READY_SERIES="$(mktemp "${TMPDIR:-/tmp}/hcc-watch-churn-series.XXXXXX")"
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
# Verdict-evidence counters; assigned by recount_churn_evidence() and the
# series readers before any read.
cuts=0 gen_pattern=0 total_watch_cut_lines=0
churn_total=0 churn_200=0 churn_503=0 churn_maxstreak=0 churn_transitions=0
hold_total=0 hold_503=0
post_converged=0 post_ready_secs=""
hcc_pod_at_stop="" hcc_restarts_at_stop=""
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

hcc_restart_count() {
  local pod=$1
  kctl get pod "$pod" -n "$HCC_NS" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="host-context-controller")].restartCount}' 2>/dev/null
}

# sample_ready_series DURATION_SEC PHASE STOP_ON_READY
# Appends "<epoch> <status> <phase>" lines to READY_SERIES at ~1Hz (each probe
# is an exec round-trip, so real spacing is 1-2s; all streak math uses the
# recorded timestamps, never sample counts). A missing or terminating pod is
# recorded as 503: a crash-looping HCC is DOWN, and hiding that would let a
# livelock-by-crash impersonate recovery. STOP_ON_READY=1 returns at the first
# 200 sample (readiness search); 0 runs the full duration (observation).
sample_ready_series() {
  local duration=$1 phase=$2 stop_on_ready=$3
  local s_deadline t0 now pod status
  s_deadline=$(($(date +%s) + duration))
  while t0="$(date +%s)"; [ "$t0" -lt "$s_deadline" ]; do
    status=503
    if pod="$(running_hcc_pod)" && [ -n "$pod" ]; then
      status="$(ready_status "$pod")"
    fi
    printf '%s %s %s\n' "$t0" "$status" "$phase" >>"$READY_SERIES"
    last_status="$status"
    if [ "$status" = 200 ] && [ "$stop_on_ready" = 1 ]; then
      return 0
    fi
    now="$(date +%s)"
    [ $((now - t0)) -ge 1 ] || sleep 1
  done
  return 0
}

# series_metrics PHASE -> prints "total n200 n503 max503streak_sec transitions"
# for that phase slice. A 503 streak is measured in wall seconds from its first
# 503 sample to the next 200 sample (or to end-of-slice + 1s if it never
# closed); transitions counts distinct 503->200 recoveries.
series_metrics() {
  awk -v phase="$1" '
    $3 == phase {
      total += 1
      if ($2 == 200) {
        n200 += 1
        if (in503) {
          streak = $1 - streak_start
          if (streak > max_streak) max_streak = streak
          transitions += 1
          in503 = 0
        }
      } else {
        n503 += 1
        if (!in503) { in503 = 1; streak_start = $1 }
      }
      last_ts = $1
    }
    END {
      if (in503) {
        streak = last_ts + 1 - streak_start
        if (streak > max_streak) max_streak = streak
      }
      printf "%d %d %d %d %d\n", total + 0, n200 + 0, n503 + 0, max_streak + 0, transitions + 0
    }' "$READY_SERIES"
}

# first_200_epoch PHASE -> epoch of the first 200 sample in that phase, if any.
first_200_epoch() {
  awk -v phase="$1" '$3 == phase && $2 == 200 { print $1; exit }' "$READY_SERIES"
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
  rm -f "$HCC_LOG_BUFFER" "$READY_SERIES"
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

# Readiness search: sample at 1Hz until the first 200 or the budget expires.
# Every sample (including the pre-Ready 503s) lands in the churn-phase series.
last_status=""
churn_probe_t0="$(date +%s)"
sample_ready_series "$READINESS_BUDGET_SEC" churn 1
first_ready=""
first_ready_epoch="$(first_200_epoch churn)"
if [ -n "$first_ready_epoch" ]; then
  first_ready=$((first_ready_epoch - churn_probe_t0))
fi

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
  # first_ready/series metrics are computed before this runs), so every command
  # is deliberately best-effort: under `set -euo pipefail`, an empty grep in
  # this block aborted the whole gate BEFORE the verdict on the first live run.
  {
    echo "=== HCC deploy ==="
    kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o wide || true
    echo "=== last /ready: ${last_status}  cut-cycles=${cuts}  watch-cut-lines=${total_watch_cut_lines}  gen-diverge=${gen_pattern}  first-ready=${first_ready:-never} ==="
    echo "=== churn phase: samples=${churn_total} 200=${churn_200} 503=${churn_503} max-503-streak=${churn_maxstreak}s 503->200=${churn_transitions} ==="
    echo "=== post-churn: converged=${post_converged} ready-after=${post_ready_secs:-never}s  hold: samples=${hold_total} 503=${hold_503} ==="
    echo "=== /ready series (epoch status phase) ==="
    cat "$READY_SERIES" || true
    echo "=== HCC log tail ==="
    grep -E 'watch ended|authority changed|Recovered|inventory' "$HCC_LOG_BUFFER" | tail -60 || true
  } >"$LOG_ARTIFACT" 2>&1 || true
}

# ── Churn observation window (fix mode) — the proxy keeps cutting while we
# sample at 1Hz. This is where the bounded-recovery evidence accumulates: 503
# streaks must close within RECOVERY_BUDGET_SEC and recovery must repeat
# (503->200 transitions). The pre-redesign zero-tolerance stability window
# asserted a property the fail-closed contract deliberately violates: a cut
# watch drops /ready to 503 transiently while it re-syncs, so "no 503 after
# first 200" failed the CORRECT regime and measured the wrong thing.
if [ -n "$first_ready" ]; then
  log "Observing /ready at 1Hz for ${CHURN_OBSERVE_SEC}s under continuous churn"
  sample_ready_series "$CHURN_OBSERVE_SEC" churn 0
fi

# ── Pause the churn WITHOUT restarting the proxy or the HCC ──
# The relay checks its pause flag on every tick, so pause_hcc_churn_proxy
# freezes the cut loop in place: no Deployment rollout, no final cut, no HCC
# restart. The post-churn phase must prove IN-SITU convergence (same process,
# no content change), so the HCC pod identity and restart count are pinned
# here and re-verified in the verdict.
hcc_pod_at_stop="$(running_hcc_pod || true)"
if [ -n "$hcc_pod_at_stop" ]; then
  hcc_restarts_at_stop="$(hcc_restart_count "$hcc_pod_at_stop" || true)"
fi
log "Pausing the churn proxy (flag file; proxy and HCC pods stay up)"
pause_hcc_churn_proxy || die "could not pause the churn proxy"
post_stop_t0="$(date +%s)"

# ── Post-churn convergence: the absorbing-state detector ──
# The fail-closed contract re-certifies from watch recovery alone — no content
# change is injected here, on purpose: convergence must not need one. A true
# livelock cannot pass this phase; a correct transient regime cannot fail it.
sample_ready_series "$POST_STOP_READY_SEC" post-reach 1
post_ready_epoch="$(first_200_epoch post-reach)"
if [ -n "$post_ready_epoch" ]; then
  post_converged=1
  post_ready_secs=$((post_ready_epoch - post_stop_t0))
  sample_ready_series "$STABILITY_WINDOW_SEC" post-hold 0
fi

# Snapshot the buffer only AFTER the observation and post-churn phases: with
# first_ready≈6s the readiness search alone has seen ~1 cut; CHURN_OBSERVE_SEC
# of further churn is what makes CHURN_MIN_CUTS and WATCH_CUT_MIN_LINES
# satisfiable in fix mode. In livelock mode the readiness search already
# consumed READINESS_BUDGET_SEC of churn.
require_hcc_recovery_log_stream ||
  warn "HCC log stream ended before the verdict; counting the frozen buffer (fail-closed: an undercount can only turn this gate RED)"
stop_hcc_recovery_log_stream
recount_churn_evidence
read -r churn_total churn_200 churn_503 churn_maxstreak churn_transitions <<<"$(series_metrics churn)"
read -r hold_total _ hold_503 _ _ <<<"$(series_metrics post-hold)"
write_evidence_artifact

# ── Verdict — POSITIVE case only ──
# EXPECT_LIVELOCK=1 is refused at the guard: the pre-fix livelock is not
# reproducible in minikube (see the SCOPE note). Its RED lives, mutation-verified,
# in host-context-controller/src/k8sClient.test.ts. This verdict proves the fix
# CONVERGES under real churn, plus anti-vacuity that the churn was real.
[ "$cuts" -ge "$CHURN_MIN_CUTS" ] &&
  ok "churn was real: ${cuts} Context-watch cuts (${total_watch_cut_lines} watch-ended lines) across readiness+observation" ||
  fail "fix validated WITHOUT churn (${cuts} Context-watch cuts) — result is worthless"
[ "$total_watch_cut_lines" -ge "$WATCH_CUT_MIN_LINES" ] &&
  ok "every informer was cut repeatedly: ${total_watch_cut_lines} watch-ended lines (>= ${WATCH_CUT_MIN_LINES} = 2 cycles x 3 watches)" ||
  fail "only ${total_watch_cut_lines} watch-ended lines (< ${WATCH_CUT_MIN_LINES}) — churn did not cut all three informers at least twice"
[ "$churn_total" -gt 0 ] && ok "sampled /ready ${churn_total}x under churn" ||
  fail "ZERO /ready samples under churn — the sampler never ran, and a zero-sample run must never pass"
if [ -n "$first_ready" ]; then
  ok "fix converged to Ready under sustained Premature close (time-to-Ready=${first_ready}s)"
else
  fail "fix did NOT reach Ready under churn within ${READINESS_BUDGET_SEC}s — livelock regression (see ${LOG_ARTIFACT})"
fi
# Anti-vacuity: the proxy must actually have bitten the readiness path. A
# transient 503 under churn is the fail-closed CONTRACT working, not a bug;
# an observation window with zero 503s means the cuts never reached the
# watches and the bounded-recovery claim below would be vacuously true.
[ "$churn_503" -ge 1 ] &&
  ok "churn bit the readiness path: ${churn_503} sample(s) at 503 (transient fail-closed is the contract)" ||
  fail "zero 503 samples under churn — the proxy never bit the watches; bounded-recovery evidence is VACUOUS"
[ "$churn_transitions" -ge "$MIN_CHURN_RECOVERIES" ] &&
  ok "repeated in-churn recovery: ${churn_transitions} distinct 503->200 transitions (>= ${MIN_CHURN_RECOVERIES})" ||
  fail "only ${churn_transitions} 503->200 transition(s) under churn — a livelock is not refuted by fewer than ${MIN_CHURN_RECOVERIES} recoveries"
[ "$churn_maxstreak" -le "$RECOVERY_BUDGET_SEC" ] &&
  ok "every in-churn 503 outage closed within budget: max streak ${churn_maxstreak}s <= ${RECOVERY_BUDGET_SEC}s" ||
  fail "a 503 streak lasted ${churn_maxstreak}s (> ${RECOVERY_BUDGET_SEC}s recovery budget) — recovery is not bounded under churn"
# Post-churn: absorbing-state detector (the decisive livelock/transient split).
if [ "$post_converged" = 1 ]; then
  ok "post-churn: /ready re-certified in ${post_ready_secs}s with NO content change injected"
  [ "$hold_total" -gt 0 ] && [ "$hold_503" -eq 0 ] &&
    ok "post-churn hold: ${hold_total} samples over ${STABILITY_WINDOW_SEC}s, zero 503 — no absorbing state" ||
    fail "post-churn hold saw ${hold_503} 503(s) across ${hold_total} sample(s) — readiness did not stabilize once the churn stopped"
else
  fail "post-churn: /ready did NOT converge within ${POST_STOP_READY_SEC}s after the churn was paused — absorbing state (livelock signature)"
fi
# In-situ guarantee: the convergence above must belong to the SAME process
# that lived through the churn. A restarted or replaced pod proves fresh-boot
# readiness, which the bootstrap gate already covers — not in-situ recovery.
hcc_pod_now="$(running_hcc_pod || true)"
hcc_restarts_now=""
if [ -n "$hcc_pod_now" ]; then
  hcc_restarts_now="$(hcc_restart_count "$hcc_pod_now" || true)"
fi
if [ -n "$hcc_pod_at_stop" ] && [ "$hcc_pod_now" = "$hcc_pod_at_stop" ] &&
  [ -n "$hcc_restarts_at_stop" ] && [ "$hcc_restarts_now" = "$hcc_restarts_at_stop" ]; then
  ok "post-churn recovery was in-situ: pod ${hcc_pod_at_stop} unchanged, restartCount ${hcc_restarts_now}"
else
  fail "HCC pod changed or restarted across the post-churn phase (${hcc_pod_at_stop:-none}/restarts=${hcc_restarts_at_stop:-?} -> ${hcc_pod_now:-none}/restarts=${hcc_restarts_now:-?}) — convergence could be a fresh boot, not in-situ recovery"
fi
log "Evidence artifact: ${LOG_ARTIFACT}"
# cleanup() (EXIT trap) restores HCC, deletes the fleet, and runs print_results.
