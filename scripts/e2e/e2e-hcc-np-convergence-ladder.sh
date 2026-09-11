#!/usr/bin/env bash
# HCC NetworkPolicy initial-convergence ladder after a swallowed unsynced pass.
#
# SCOPE — this probe proves ONLY that Change A can fire on a real HCC process
# in the owned Minikube profile: a rolling restart may hit caches-unsynced,
# the retry ladder re-arms, and /ready becomes 200 within 300s AFTER that
# swallow is observed. It does NOT reproduce the GKE 17–35 min watch-recycle
# livelock. Minikube often syncs both inventories before the first NP pass;
# a lucky /ready 200 without a swallow is FAIL (vacuous), not green. The RED
# for the silent-return bug lives in host-context-controller/src/k8sClient.test.ts.
#
# Action: kubectl rollout restart of host-context-controller. Do not change
# strategy, replicas, or PVCs. Do not Recreate the Deployment object. Do not
# switch the global current-context. Do not adopt another profile's port-forward;
# /ready and /metrics are probed with kubectl --context exec wget on :8081.
#
# Anti-vacuity: observe either the unsynced log or the swallowed{unsynced}
# metric increment, AND the retry-schedule log. If the window never appears,
# retry the restart once. Still unseen → exit 3 (HCC_NP_LADDER_VACUOUS).
# After /ready 200 on that same pod, scrape HTTP /metrics and require
# deferred-unsynced, swallowed{unsynced}, retries, certified, and last-success
# to agree on the Prometheus text. That does NOT attribute certification to
# the 5s timer (watch-recovery may certify first on minikube).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER_E2E_KUBECONTEXT="${E2E_KUBECONTEXT:-}"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# e2e-lib maps KUBECONTEXT / E2E_K8S_CONTEXT onto E2E_KUBECONTEXT and
# clobbers a pre-set value. Keep an explicit caller context when those
# aliases were empty.
if [ -z "${KUBECONTEXT:-}" ] && [ -z "${E2E_K8S_CONTEXT:-}" ] && [ -n "$CALLER_E2E_KUBECONTEXT" ]; then
  E2E_KUBECONTEXT="$CALLER_E2E_KUBECONTEXT"
fi
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-ready-series.sh"
# e2e-lib log() writes stdout. This probe captures helper output as pod names,
# so progress lines must not leak into those substitutions.
log() { echo -e "${CYAN}[E2E]${NC} $*" >&2; }
# Shared ready_status hardcodes loopback:8081. Keep /ready on the same
# HCC_PROBE_* pair as /metrics so an override cannot split the two probes.
ready_status() {
  local pod=$1
  kctl exec "pod/$pod" -n "$HCC_NS" -c host-context-controller -- \
    wget -T 10 -t 1 -qO- "http://${HCC_PROBE_HOST}:${HCC_PROBE_PORT}/ready" >/dev/null 2>&1 &&
    echo 200 || echo 503
}

OWNED_MINIKUBE_PROFILE="clerum-fix-447-hcc-certification-watchdog-45626152"
VACUOUS_EXIT=3

[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT/E2E_K8S_CONTEXT must select the owned branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing NP ladder probe on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
[ "$E2E_KUBECONTEXT" = "$OWNED_MINIKUBE_PROFILE" ] || {
  echo "Refusing NP ladder probe: this script targets only ${OWNED_MINIKUBE_PROFILE}," >&2
  echo "got '${E2E_KUBECONTEXT}'. Do not point it at another worktree's profile." >&2
  exit 1
}
[ "${MINIKUBE_PROFILE:-}" = "$E2E_KUBECONTEXT" ] || {
  echo "MINIKUBE_PROFILE must explicitly select ${E2E_KUBECONTEXT}, got ${MINIKUBE_PROFILE:-missing}." >&2
  exit 1
}
require_safe_kube_context
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}
[ "${E2E_HCC_NP_LADDER_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_NP_LADDER_FAULT_INJECTION=1 to acknowledge a rolling restart of HCC." >&2
  exit 1
}
[ "${EXPECT_LIVELOCK:-0}" != 1 ] || {
  echo "EXPECT_LIVELOCK=1 is not supported: this probe does not reproduce the GKE" >&2
  echo "watch-recycle livelock. The RED lives in host-context-controller/src/k8sClient.test.ts." >&2
  exit 1
}
kctl get nodes -o json | jq -e --arg c "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $c)' >/dev/null ||
  {
    echo "Refusing NP ladder probe: target is not this profile's minikube node." >&2
    exit 1
  }

HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
HCC_PROBE_HOST="${HCC_PROBE_HOST:-127.0.0.1}"
HCC_PROBE_PORT="${HCC_PROBE_PORT:-8081}"
SWALLOW_OBSERVE_SEC="${SWALLOW_OBSERVE_SEC:-90}"
READY_BUDGET_SEC="${READY_BUDGET_SEC:-300}"
ROLLOUT_TIMEOUT_SEC="${ROLLOUT_TIMEOUT_SEC:-180}"
RESTART_ATTEMPTS="${RESTART_ATTEMPTS:-2}"

RUN_ID="$(date +%s)-$$"
LOG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/hcc-np-convergence-ladder.XXXXXX")"
READY_SERIES="$(mktemp "${TMPDIR:-/tmp}/hcc-np-convergence-ladder-series.XXXXXX")"
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME="" HCC_GATE_LOCK_UID="" HCC_GATE_FINALIZATION_FAILURE=""
VACUOUS=0
ROLLOUT_TRIGGERED=0
OBSERVED_AT=""
OBSERVED_POD=""
OBSERVED_POD_UID=""
SWALLOW_SOURCE=""
READY_AT=""
ATTEMPT=0

die() {
  fail "$*"
  exit 1
}

hcc_pod_uid() {
  local pod=$1
  kctl get pod "$pod" -n "$HCC_NS" -o jsonpath='{.metadata.uid}'
}

hcc_pod_logs() {
  local pod=$1
  kctl logs "pod/$pod" -n "$HCC_NS" -c host-context-controller 2>/dev/null || true
}

hcc_pod_metrics() {
  local pod=$1
  kctl exec "pod/$pod" -n "$HCC_NS" -c host-context-controller -- \
    wget -T 10 -t 1 -qO- "http://${HCC_PROBE_HOST}:${HCC_PROBE_PORT}/metrics" 2>/dev/null || true
}

# Label order is not part of the Prometheus contract.
prom_labeled_value() {
  local metrics=$1 name=$2
  shift 2
  local label_spec="" pair
  for pair in "$@"; do
    label_spec="${label_spec}${pair}|"
  done
  awk -v metric_name="$name" -v label_spec="$label_spec" '
    BEGIN {
      n = split(label_spec, required, "|")
      while (n > 0 && required[n] == "") n--
    }
    index($1, metric_name "{") == 1 {
      ok = 1
      for (j = 1; j <= n; j++) {
        if (required[j] == "") continue
        split(required[j], kv, "=")
        needle = kv[1] "=\"" kv[2] "\""
        if (index($1, needle) == 0) ok = 0
      }
      if (ok) {
        print int($NF + 0)
        found = 1
        exit
      }
    }
    END { if (!found) print 0 }
  ' <<<"$metrics"
}

swallowed_unsynced_count() {
  prom_labeled_value "$1" 'clerum_hcc_initial_convergence_swallowed_total' \
    'lane=NetworkPolicy' 'sink=unsynced'
}

assert_convergence_metrics_closure() {
  local pod=$1
  local uid_now metrics deferred swallowed retries certified ts
  require_hcc_pod_name "$pod"
  uid_now="$(hcc_pod_uid "$pod")"
  [ -n "$OBSERVED_POD_UID" ] && [ "$uid_now" = "$OBSERVED_POD_UID" ] ||
    die "HCC pod uid changed before /metrics closure (${OBSERVED_POD_UID:-none} -> ${uid_now:-none})"
  metrics="$(hcc_pod_metrics "$pod")"
  [ -n "$metrics" ] || die "HCC /metrics scrape was empty on ${pod}"
  deferred="$(prom_labeled_value "$metrics" 'clerum_hcc_initial_convergence_pass_results_total' \
    'lane=NetworkPolicy' 'result=deferred-unsynced')"
  swallowed="$(prom_labeled_value "$metrics" 'clerum_hcc_initial_convergence_swallowed_total' \
    'lane=NetworkPolicy' 'sink=unsynced')"
  retries="$(prom_labeled_value "$metrics" 'clerum_hcc_initial_convergence_retries_total' \
    'lane=NetworkPolicy')"
  certified="$(prom_labeled_value "$metrics" 'clerum_hcc_initial_convergence_pass_results_total' \
    'lane=NetworkPolicy' 'result=certified')"
  ts="$(prom_labeled_value "$metrics" 'clerum_hcc_initial_convergence_last_success_timestamp_seconds' \
    'lane=NetworkPolicy')"
  if [ "${deferred:-0}" -lt 1 ]; then
    fail "INCONCLUSIVE: no deferred-unsynced pass on ${pod} — /metrics closure is vacuous for #447"
    return 1
  fi
  [ "${swallowed:-0}" -ge 1 ] &&
    ok "wire /metrics: swallowed{unsynced}=${swallowed}" ||
    fail "wire /metrics: swallowed{unsynced}=${swallowed} after deferred-unsynced>=1"
  [ "${retries:-0}" -ge 1 ] &&
    ok "wire /metrics: retries_total=${retries} (armed; not attributed to the 5s timer alone)" ||
    fail "wire /metrics: retries_total=${retries} after a deferred-unsynced pass"
  [ "${certified:-0}" -ge 1 ] &&
    ok "wire /metrics: certified=${certified} on the same pod that deferred" ||
    fail "wire /metrics: certified=${certified} after /ready 200 on a deferred pod"
  [ "$(printf '%s' "$ts" | awk '{ print ($1 > 0) }')" = 1 ] &&
    ok "wire /metrics: last_success_timestamp_seconds>0" ||
    fail "wire /metrics: last_success_timestamp_seconds=${ts} was not set by a certified pass"
}

logs_show_unsynced() {
  local logs=$1
  grep -Eq 'caches unsynced|deferred: caches unsynced' <<<"$logs"
}

logs_show_retry() {
  local logs=$1
  grep -Fq 'Scheduling initial NetworkPolicy background convergence retry' <<<"$logs"
}

write_evidence_artifact() {
  {
    echo "=== HCC NP convergence ladder ==="
    echo "context=${E2E_KUBECONTEXT} attempt=${ATTEMPT} vacuous=${VACUOUS}"
    echo "observed_at=${OBSERVED_AT:-none} observed_pod=${OBSERVED_POD:-none} observed_uid=${OBSERVED_POD_UID:-none} swallow_source=${SWALLOW_SOURCE:-none} ready_at=${READY_AT:-none}"
    echo "=== deployment ==="
    kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o wide || true
    echo "=== pods ==="
    kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o wide || true
    if [ -n "${OBSERVED_POD:-}" ]; then
      echo "=== logs ${OBSERVED_POD} ==="
      hcc_pod_logs "$OBSERVED_POD" || true
      echo "=== metrics ${OBSERVED_POD} ==="
      hcc_pod_metrics "$OBSERVED_POD" || true
    fi
    echo "=== /ready series ==="
    cat "$READY_SERIES" || true
  } >"$LOG_ARTIFACT" 2>&1 || true
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  trap - EXIT INT TERM
  set +e
  if [ "$ROLLOUT_TRIGGERED" = 1 ]; then
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null 2>&1 || restore_ok=0
  fi
  [ "$restore_ok" = 1 ] || cleanup_failed=1
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  write_evidence_artifact
  log "Evidence artifact: ${LOG_ARTIFACT}"
  print_results || status=1
  [ "$cleanup_failed" = 0 ] || status=1
  rm -f "$READY_SERIES"
  if [ "$VACUOUS" = 1 ]; then
    echo "HCC_NP_LADDER_VACUOUS: unsynced swallow never observed after ${RESTART_ATTEMPTS} restart(s)." >&2
    exit "$VACUOUS_EXIT"
  fi
  exit "$status"
}

# Observe Change A on the replacement pod: unsynced swallow (log or metric)
# plus the retry-arming log. A 200 without this window is not evidence.
observe_unsynced_swallow() {
  local pod=$1
  local deadline now logs metrics swallowed
  local seen_swallow=0 seen_retry=0
  deadline=$(($(date +%s) + SWALLOW_OBSERVE_SEC))
  OBSERVED_POD="$pod"
  SWALLOW_SOURCE=""
  while :; do
    logs="$(hcc_pod_logs "$pod")"
    metrics="$(hcc_pod_metrics "$pod")"
    swallowed="$(swallowed_unsynced_count "$metrics")"
    if [ "$seen_swallow" = 0 ]; then
      if logs_show_unsynced "$logs"; then
        seen_swallow=1
        SWALLOW_SOURCE="log"
      elif [ "${swallowed:-0}" -gt 0 ]; then
        seen_swallow=1
        SWALLOW_SOURCE="metric"
      fi
    fi
    if [ "$seen_retry" = 0 ] && logs_show_retry "$logs"; then
      seen_retry=1
    fi
    if [ "$seen_swallow" = 1 ] && [ "$seen_retry" = 1 ]; then
      OBSERVED_AT="$(date +%s)"
      OBSERVED_POD_UID="$(hcc_pod_uid "$pod")"
      return 0
    fi
    now="$(date +%s)"
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  return 1
}

require_hcc_pod_name() {
  local pod=$1
  [[ "$pod" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
    die "refusing to use a malformed HCC pod name: ${pod}"
}

restart_hcc_and_wait() {
  local old_pod=$1 old_uid=$2
  local new_pod new_uid
  log "Rolling restart of ${HCC_NS}/${HCC_DEPLOY} (attempt ${ATTEMPT})"
  kctl rollout restart "deployment/${HCC_DEPLOY}" -n "$HCC_NS" >/dev/null
  ROLLOUT_TRIGGERED=1
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout="${ROLLOUT_TIMEOUT_SEC}s" >/dev/null ||
    die "HCC rollout did not become Ready within ${ROLLOUT_TIMEOUT_SEC}s"
  new_pod="$(running_hcc_pod)" || true
  require_hcc_pod_name "${new_pod:-}"
  new_uid="$(hcc_pod_uid "$new_pod")"
  [ -n "$new_uid" ] || die "could not read replacement pod uid"
  if [ "$new_pod" = "$old_pod" ] && [ "$new_uid" = "$old_uid" ]; then
    die "HCC pod did not change after rollout restart (${old_pod}/${old_uid})"
  fi
  NEW_POD="$new_pod"
}

wait_ready_after_observation() {
  local pod=$1
  local deadline now status
  deadline=$((OBSERVED_AT + READY_BUDGET_SEC))
  while :; do
    now="$(date +%s)"
    status="$(ready_status "$pod")"
    printf '%s %s after-swallow\n' "$now" "$status" >>"$READY_SERIES"
    if [ "$status" = 200 ]; then
      READY_AT="$now"
      return 0
    fi
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  return 1
}

trap cleanup EXIT INT TERM

acquire_hcc_watch_gate_lock

replicas="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}')"
[ "$replicas" = 1 ] || die "expected exactly one HCC replica, found ${replicas:-unknown}"
ready_replicas="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.status.readyReplicas}')"
[ "$ready_replicas" = 1 ] || die "HCC Deployment is not Ready (readyReplicas=${ready_replicas:-unknown})"
strategy_type="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.strategy.type}')"
[ "$strategy_type" = Recreate ] ||
  die "refusing to mutate a non-Recreate HCC (found '${strategy_type:-unset}'); this probe must not change strategy"

header "HCC NP convergence ladder (owned Minikube only)"
log "This probe does not claim to reproduce GKE watch-recycle. Vacuous swallow = fail-closed."

old_pod="$(running_hcc_pod)" || true
[ -n "$old_pod" ] || die "no Running HCC pod before restart"
old_uid="$(hcc_pod_uid "$old_pod")"
[ -n "$old_uid" ] || die "could not pin the pre-restart pod uid"

swallow_seen=0
new_pod=""
NEW_POD=""
require_hcc_pod_name "$old_pod"
while [ "$ATTEMPT" -lt "$RESTART_ATTEMPTS" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  restart_hcc_and_wait "$old_pod" "$old_uid"
  new_pod="$NEW_POD"
  require_hcc_pod_name "$new_pod"
  if observe_unsynced_swallow "$new_pod"; then
    swallow_seen=1
    ok "observed unsynced swallow (${SWALLOW_SOURCE}) and retry log on ${new_pod}"
    break
  fi
  log "unsynced swallow not observed on ${new_pod} within ${SWALLOW_OBSERVE_SEC}s"
  old_pod="$new_pod"
  old_uid="$(hcc_pod_uid "$new_pod")"
done

if [ "$swallow_seen" != 1 ]; then
  VACUOUS=1
  fail "VACUOUS: never saw caches-unsynced swallow or swallowed{unsynced} increment plus retry log after ${RESTART_ATTEMPTS} restart(s) — a lucky /ready 200 is not a pass (see ${LOG_ARTIFACT})"
  exit "$VACUOUS_EXIT"
fi

if wait_ready_after_observation "$new_pod"; then
  ok "/ready 200 ${READY_AT}s epoch, $((READY_AT - OBSERVED_AT))s after the observed swallow (budget ${READY_BUDGET_SEC}s)"
  assert_convergence_metrics_closure "$new_pod"
else
  fail "/ready did not become 200 within ${READY_BUDGET_SEC}s after the observed swallow on ${new_pod} (see ${LOG_ARTIFACT})"
fi
