#!/usr/bin/env bash
# HCC availability across a `strategy: Recreate` + `replicas: 1` ROLLOUT — the
# node-upgrade / config-rollout scenario behind decision D1/c4 (PR #382).
#
# SCOPE — deploy/base/control-plane/host-context-controller.yaml pins the HCC
# to Recreate with a single replica, so EVERY rollout (image bump, config
# change, or the recreate that follows a GKE node-upgrade drain) TERMINATES the
# old pod before the replacement starts. The availability gap is structural:
#   termination + reschedule + container start + initial LISTs over the whole
#   inventory + the NetworkPolicy revocation pass + readiness probe
#   (initialDelaySeconds: 10)
# It was estimated at ~30-90s in the D1/c4 audit but never MEASURED. This gate
# measures it against the wall clock, over a synthetic clerum-dev-scale fleet
# (the initial LISTs and the revocation pass are part of the window), and pins
# the D1b failure mode empirically: `progressDeadlineSeconds: 1200` is
# DETECTION only — a rollout whose new pod can never certify leaves the HCC
# control plane down until a manual `kubectl rollout undo`, because Recreate
# keeps zero old replicas to fall back on.
#
# Modes:
#   EXPECT_RECOVERY=1 — exclusive with EXPECT_STUCK. Botch the image, prove the
#     D1b 503 outage (same sustained-outage pins as EXPECT_STUCK: >=1 503,
#     zero 503->200, maxstreak > healthy budget), then run last-good revision
#     restore as the TEST ACTION (not cleanup). Recovery must recertify /ready
#     200, restore the original image and last-good revision, and replace the
#     botched pod. An undo no-op is FAIL. IMAGE_BROKEN stays 1 unless every
#     post-undo proof passed (e2e_fail==0), so a failed image/revision/uid/hold
#     still lets cleanup restore the original image. This is the evenfire#391
#     evidence path.
#   EXPECT_STUCK=0 (default) — healthy rollout via `kubectl rollout restart`.
#     rollout restart mutates the pod template (restartedAt annotation), which
#     drives the SAME Deployment machinery — terminate old, then create new —
#     that an image/config rollout or a node-upgrade recreate follows under
#     Recreate. A bare `kubectl delete pod` was rejected as the simulation: it
#     bypasses the Deployment controller entirely (no new pod-template
#     revision, no progress conditions) and could not host the botched-image
#     variant. VERDICT: the 503 window (wall-clock max 503 streak across the
#     rollout phase) MUST close within ROLLOUT_DOWNTIME_BUDGET_SEC; the
#     measured number is the deliverable, recorded in the evidence artifact.
#   EXPECT_STUCK=1 — botched rollout (D1b): roll to a same-repository image tag
#     that cannot exist (e2e-botched-<run>). Recreate terminates the old
#     (healthy) pod, the replacement pins in ImagePullBackOff, and /ready
#     flatlines at 503 with ZERO 503->200 transitions: the stuck rollout IS a
#     total outage, empirically. The sustained 503 streak — longer than the
#     healthy budget and still open at observation end — is the EXPECTED
#     evidence. The observation is bounded (STUCK_OBSERVE_SEC) and cleanup
#     performs the manual-operator recovery (restore the original image, wait
#     for re-certification), so the gate always terminates loudly instead of
#     hanging alongside the outage it reproduces.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-fixture.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-churn-fixture.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-ready-series.sh"

# ── Fail-closed guards (identical contract to the sibling HCC gates) ──
[ -n "$E2E_KUBECONTEXT" ] || {
  echo "KUBECONTEXT/E2E_K8S_CONTEXT must select a branch-scoped minikube context." >&2
  exit 1
}
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" || {
  echo "Refusing rollout fault injection on non-branch context '${E2E_KUBECONTEXT}'." >&2
  exit 1
}
require_safe_kube_context
command -v jq >/dev/null 2>&1 || {
  echo "jq is required" >&2
  exit 1
}
[ "${E2E_HCC_ROLLOUT_FAULT_INJECTION:-0}" = 1 ] || {
  echo "Set E2E_HCC_ROLLOUT_FAULT_INJECTION=1 to acknowledge that this gate rolls" >&2
  echo "(and, with EXPECT_STUCK=1 or EXPECT_RECOVERY=1, deliberately breaks) the HCC deployment." >&2
  exit 1
}
case "${EXPECT_STUCK:-0}" in
  0 | 1) ;;
  *)
    echo "EXPECT_STUCK must be 0 (measure a healthy rollout window) or 1 (reproduce the D1b botched-rollout outage)." >&2
    exit 1
    ;;
esac
EXPECT_STUCK="${EXPECT_STUCK:-0}"
EXPECT_RECOVERY="${EXPECT_RECOVERY:-0}"
case "${EXPECT_RECOVERY}" in
  0 | 1) ;;
  *)
    echo "EXPECT_RECOVERY must be 0 or 1." >&2
    exit 1
    ;;
esac
if [ "$EXPECT_STUCK" = 1 ] && [ "$EXPECT_RECOVERY" = 1 ]; then
  echo "EXPECT_STUCK=1 and EXPECT_RECOVERY=1 are exclusive." >&2
  exit 1
fi
kctl get nodes -o json | jq -e --arg c "$E2E_KUBECONTEXT" \
  'any(.items[]; .metadata.labels["minikube.k8s.io/name"] == $c)' >/dev/null ||
  {
    echo "Refusing rollout fault injection: target is not this profile's minikube node." >&2
    exit 1
  }

# ── Tunables ──
HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"
MCP_NS="${MCP_SERVER_NS:-mcp-server}"
HOST_NS="${MCP_HOST_NS:-mcp-host}"
# Wall-clock budget for the healthy-rollout 503 window. Deliberately generous:
# the point of EXPECT_STUCK=0 is to MEASURE the window, not to fail it — the
# observed number lands in the evidence artifact and in the verdict line.
ROLLOUT_DOWNTIME_BUDGET_SEC="${ROLLOUT_DOWNTIME_BUDGET_SEC:-120}"
# Total observation budget for the healthy rollout: pod termination (default
# grace 30s) + the downtime window + margin.
ROLLOUT_OBSERVE_BUDGET_SEC="${ROLLOUT_OBSERVE_BUDGET_SEC:-$((ROLLOUT_DOWNTIME_BUDGET_SEC + 120))}"
# Bounded observation of the botched rollout: must exceed the healthy budget so
# "the outage outlived the budget and never closed" is a provable claim.
STUCK_OBSERVE_SEC="${STUCK_OBSERVE_SEC:-$((ROLLOUT_DOWNTIME_BUDGET_SEC + 90))}"
BASELINE_SAMPLE_SEC="${BASELINE_SAMPLE_SEC:-10}"
STABILITY_WINDOW_SEC="${STABILITY_WINDOW_SEC:-30}"
BOOTSTRAP_READY_BUDGET_SEC="${BOOTSTRAP_READY_BUDGET_SEC:-360}"
# Synthetic clerum-dev-scale fleet (same shape as the watch-churn gate): the
# replacement pod's initial LISTs and revocation pass must run over a realistic
# inventory, or the measured window is a bare-cluster lower bound.
WITH_SYNTHETIC_FLEET="${WITH_SYNTHETIC_FLEET:-1}"
FLEET_CONTEXTS="${FLEET_CONTEXTS:-24}"
FLEET_MCPSERVERS="${FLEET_MCPSERVERS:-115}"
FLEET_HOSTS="${FLEET_HOSTS:-8}"
[ "$STUCK_OBSERVE_SEC" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC" ] || {
  echo "STUCK_OBSERVE_SEC (${STUCK_OBSERVE_SEC}) must exceed ROLLOUT_DOWNTIME_BUDGET_SEC (${ROLLOUT_DOWNTIME_BUDGET_SEC}):" >&2
  echo "the sustained-outage claim needs an observation longer than the budget it must exceed." >&2
  exit 1
}
case "$WITH_SYNTHETIC_FLEET" in
  0 | 1) ;;
  *)
    echo "WITH_SYNTHETIC_FLEET must be 0 or 1." >&2
    exit 1
    ;;
esac

RUN_ID="$(date +%s)-$$"
FLEET_PREFIX="$(truncate_rfc1123 "e2e-hcc-rollout-${RUN_ID}")"
FLEET_SECRET="$(truncate_rfc1123 "${FLEET_PREFIX}-llm")"
LOG_ARTIFACT="$(mktemp "${TMPDIR:-/tmp}/hcc-rollout-readiness.XXXXXX")"
# 1Hz /ready sample series: "<epoch> <status> <phase>" per line (baseline /
# rollout / stuck / post-hold). All window math derives from this file.
READY_SERIES="$(mktemp "${TMPDIR:-/tmp}/hcc-rollout-series.XXXXXX")"
ORIGINAL_REPLICAS=""
HCC_IMAGE=""
BOTCHED_IMAGE=""
FLEET_CREATED=0
HCC_SCALED_DOWN=0
ROLLOUT_TRIGGERED=0
IMAGE_BROKEN=0
ROLLOUT_CONVERGED=0
last_status=""
# Verdict-evidence counters; assigned by the series readers before any read.
baseline_total=0 baseline_200=0 baseline_503=0
roll_total=0 roll_200=0 roll_503=0 roll_maxstreak=0 roll_transitions=0
stuck_total=0 stuck_200=0 stuck_503=0 stuck_maxstreak=0 stuck_transitions=0
hold_total=0 hold_503=0
OLD_POD_NAME="" OLD_POD_UID="" NEW_POD_NAME="" NEW_POD_UID="" NEW_POD_RESTARTS=""
rollout_t0="" rollout_recovered_at=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0 HCC_GATE_LOCK_NAME="" HCC_GATE_LOCK_UID="" HCC_GATE_FINALIZATION_FAILURE=""

die() {
  fail "$*"
  exit 1
}

hcc_ready_now() {
  local pod
  pod="$(running_hcc_pod)" && [ -n "$pod" ] && [ "$(ready_status "$pod")" = 200 ]
}

# The rollout-phase sampler: records "<epoch> <status> <phase>" at ~1Hz like
# sample_ready_series, but converges only when a pod with a DIFFERENT uid
# serves 200 — a 200 from the not-yet-terminated OLD pod must not end the
# observation, and the same pod re-certifying would be the churn gate's claim,
# not a rollout. Sets NEW_POD_NAME / NEW_POD_UID on convergence.
sample_until_new_pod_ready() {
  local duration=$1 phase=$2 old_uid=$3
  local s_deadline t0 now pod status uid
  s_deadline=$(($(date +%s) + duration))
  while t0="$(date +%s)"; [ "$t0" -lt "$s_deadline" ]; do
    status=503 uid="" pod=""
    if pod="$(running_hcc_pod)" && [ -n "$pod" ]; then
      status="$(ready_status "$pod")"
      uid="$(kctl get pod "$pod" -n "$HCC_NS" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)"
    fi
    printf '%s %s %s\n' "$t0" "$status" "$phase" >>"$READY_SERIES"
    last_status="$status"
    if [ "$status" = 200 ] && [ -n "$uid" ] && [ "$uid" != "$old_uid" ]; then
      NEW_POD_NAME="$pod"
      NEW_POD_UID="$uid"
      return 0
    fi
    now="$(date +%s)"
    [ $((now - t0)) -ge 1 ] || sleep 1
  done
  return 1
}

# Same-repository tag that cannot exist: guaranteed ErrImagePull/
# ImagePullBackOff with zero foreign-image pulls — the least destructive and
# most faithful "bad rollout" (the Deployment machinery is exercised exactly as
# a real bad image bump would exercise it).
botched_image_ref() {
  local base="${HCC_IMAGE%%@*}" repo_tail
  repo_tail="${base##*/}"
  case "$repo_tail" in
    *:*) base="${base%:*}" ;;
  esac
  printf '%s:e2e-botched-%s' "$base" "$RUN_ID"
}

print_repair_instructions() {
  cat >&2 <<EOF
HCC rollout gate cleanup could not restore a verified healthy state.
Context: ${E2E_KUBECONTEXT}
HCC: ${HCC_NS}/${HCC_DEPLOY}
Original image: ${HCC_IMAGE:-unknown}
Synthetic fleet label: e2e.clerum.io/suite=hcc-watch-churn (run ${RUN_ID})

Inspect before changing anything:
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get deployment ${HCC_DEPLOY} -o yaml
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} get pods -l app=${HCC_DEPLOY} -o wide

Restore the HCC deployment (original image, original replicas, wait for readiness):
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} set image deployment/${HCC_DEPLOY} \\
    host-context-controller=${HCC_IMAGE:-<original image>}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} scale deployment/${HCC_DEPLOY} --replicas=${ORIGINAL_REPLICAS:-1}
  kubectl --context=${E2E_KUBECONTEXT} -n ${HCC_NS} rollout status deployment/${HCC_DEPLOY} --timeout=240s

Delete any leftover synthetic fleet:
  kubectl --context=${E2E_KUBECONTEXT} delete mcpserver,context,host -A -l e2e.clerum.io/suite=hcc-watch-churn
EOF
}

write_evidence_artifact() {
  # Diagnostics ONLY — every verdict input is computed before this runs, so
  # every command here is deliberately best-effort (same rationale as the
  # sibling churn gate: an empty grep under `set -euo pipefail` must never
  # abort the gate before its verdict).
  {
    echo "=== mode: EXPECT_STUCK=${EXPECT_STUCK} EXPECT_RECOVERY=${EXPECT_RECOVERY}  fleet=${WITH_SYNTHETIC_FLEET} (${FLEET_CONTEXTS}/${FLEET_MCPSERVERS}/${FLEET_HOSTS}) ==="
    echo "=== HCC deploy ==="
    kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o wide || true
    echo "=== deployment conditions (progressDeadlineSeconds is DETECTION only) ==="
    kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}' || true
    echo ""
    echo "=== pods ==="
    kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o wide || true
    echo "=== pod identity: old ${OLD_POD_NAME:-none} (${OLD_POD_UID:-?}) -> new ${NEW_POD_NAME:-none} (${NEW_POD_UID:-?}) restarts=${NEW_POD_RESTARTS:-?} ==="
    echo "=== baseline: samples=${baseline_total} 200=${baseline_200} 503=${baseline_503} ==="
    echo "=== rollout: samples=${roll_total} 200=${roll_200} 503=${roll_503} MEASURED-window=${roll_maxstreak}s 503->200=${roll_transitions} budget=${ROLLOUT_DOWNTIME_BUDGET_SEC}s total-transition=${rollout_recovered_at:+$((rollout_recovered_at - rollout_t0))}s ==="
    echo "=== stuck: samples=${stuck_total} 200=${stuck_200} 503=${stuck_503} max-503-streak=${stuck_maxstreak}s 503->200=${stuck_transitions} observe=${STUCK_OBSERVE_SEC}s ==="
    echo "=== post-hold: samples=${hold_total} 503=${hold_503} ==="
    echo "=== /ready series (epoch status phase) ==="
    cat "$READY_SERIES" || true
  } >"$LOG_ARTIFACT" 2>&1 || true
}

cleanup() {
  local status=$? cleanup_failed=0 restore_ok=1
  trap - EXIT
  set +e
  if [ "$IMAGE_BROKEN" = 1 ]; then
    # This IS the manual operator action D1b forces: roll back to the last
    # good image, because Kubernetes will not do it on its own.
    kctl set image deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
      host-context-controller="$HCC_IMAGE" >/dev/null 2>&1 || restore_ok=0
  fi
  if [ "$HCC_SCALED_DOWN" = 1 ]; then
    kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas="${ORIGINAL_REPLICAS:-1}" >/dev/null 2>&1 || restore_ok=0
  fi
  if [ "$ROLLOUT_TRIGGERED" = 1 ] || [ "$IMAGE_BROKEN" = 1 ] || [ "$HCC_SCALED_DOWN" = 1 ]; then
    kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null 2>&1 || restore_ok=0
    wait_until 90 "HCC /ready after restore" hcc_ready_now >/dev/null 2>&1 || restore_ok=0
  fi
  [ "$FLEET_CREATED" = 1 ] && { delete_synthetic_fleet || cleanup_failed=1; }
  [ "$restore_ok" = 1 ] || {
    print_repair_instructions
    cleanup_failed=1
  }
  finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok" || cleanup_failed=1
  print_results || status=1
  [ "$cleanup_failed" = 0 ] || status=1
  rm -f "$READY_SERIES"
  exit "$status"
}
trap cleanup EXIT

# ── FASE A: branch-owned proof + single-writer lock + premise snapshot ──
require_branch_owned_hcc_gate "$HCC_NS"
acquire_hcc_watch_gate_lock
ORIGINAL_REPLICAS="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.replicas}')"
[ "$ORIGINAL_REPLICAS" = 1 ] || die "expected exactly one HCC replica, found ${ORIGINAL_REPLICAS:-unknown}"
strategy_type="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.strategy.type}')"
[ "$strategy_type" = Recreate ] ||
  die "expected strategy Recreate — the D1/c4 scenario under measurement — but found '${strategy_type:-unset}'; every number this gate reports would be meaningless"
[ -z "$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.strategy.rollingUpdate}')" ] ||
  die "deployment carries rollingUpdate parameters alongside Recreate; refusing to measure a mixed-strategy object"
HCC_IMAGE="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
[ -n "$HCC_IMAGE" ] || die "could not resolve the running HCC image"

# ── FASE B: synthetic clerum-dev-scale fleet (HCC stopped while CRs land) ──
if [ "$WITH_SYNTHETIC_FLEET" = 1 ]; then
  log "Creating synthetic fleet: ${FLEET_CONTEXTS} Contexts / ${FLEET_MCPSERVERS} McpServers / ${FLEET_HOSTS} Hosts"
  kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=0 >/dev/null
  HCC_SCALED_DOWN=1
  wait_until 120 "HCC pods to stop" hcc_pods_absent || die "HCC did not stop before fleet creation"
  create_synthetic_fleet "$FLEET_CONTEXTS" "$FLEET_MCPSERVERS" "$FLEET_HOSTS"
  ok "synthetic fleet created (${FLEET_MCPSERVERS} McpServers)"
  kctl scale deployment "$HCC_DEPLOY" -n "$HCC_NS" --replicas=1 >/dev/null
  HCC_SCALED_DOWN=0
  kctl rollout status deployment "$HCC_DEPLOY" -n "$HCC_NS" --timeout="${BOOTSTRAP_READY_BUDGET_SEC}s" >/dev/null ||
    die "HCC did not bootstrap over the synthetic fleet within ${BOOTSTRAP_READY_BUDGET_SEC}s"
fi
wait_until 60 "HCC /ready before the rollout" hcc_ready_now ||
  die "HCC is not serving /ready 200; refusing to measure a rollout from an unhealthy baseline"

# ── FASE C: baseline — the window is only meaningful from a clean 200 floor ──
log "Baseline: sampling /ready at 1Hz for ${BASELINE_SAMPLE_SEC}s"
sample_ready_series "$BASELINE_SAMPLE_SEC" baseline 0
read -r baseline_total baseline_200 baseline_503 _ _ <<<"$(series_metrics baseline)"
if [ "$baseline_total" -gt 0 ] && [ "$baseline_503" -eq 0 ]; then
  ok "baseline stable: ${baseline_200}/${baseline_total} samples at 200 before the rollout"
else
  die "baseline unstable (${baseline_503}/${baseline_total} samples at 503) — refusing to mutate an unhealthy HCC"
fi
OLD_POD_NAME="$(running_hcc_pod)"
[ -n "$OLD_POD_NAME" ] || die "no running HCC pod after a clean baseline"
OLD_POD_UID="$(kctl get pod "$OLD_POD_NAME" -n "$HCC_NS" -o jsonpath='{.metadata.uid}')"
[ -n "$OLD_POD_UID" ] || die "could not pin the pre-rollout pod uid"


LAST_GOOD_REVISION="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
[ -n "$LAST_GOOD_REVISION" ] || die "could not capture the last-known-good HCC revision"

if [ "$EXPECT_STUCK" = 0 ] && [ "$EXPECT_RECOVERY" = 0 ]; then
  # ── FASE D (healthy): Recreate rollout, sampled at 1Hz end to end ──
  log "Triggering a Recreate rollout (kubectl rollout restart) and sampling /ready at 1Hz"
  kctl rollout restart deployment/"$HCC_DEPLOY" -n "$HCC_NS" >/dev/null
  ROLLOUT_TRIGGERED=1
  rollout_t0="$(date +%s)"
  if sample_until_new_pod_ready "$ROLLOUT_OBSERVE_BUDGET_SEC" rollout "$OLD_POD_UID"; then
    ROLLOUT_CONVERGED=1
    rollout_recovered_at="$(date +%s)"
    NEW_POD_RESTARTS="$(hcc_restart_count "$NEW_POD_NAME" || true)"
    log "Post-rollout hold: sampling /ready at 1Hz for ${STABILITY_WINDOW_SEC}s"
    sample_ready_series "$STABILITY_WINDOW_SEC" post-hold 0
  fi
  read -r roll_total roll_200 roll_503 roll_maxstreak roll_transitions <<<"$(series_metrics rollout)"
  read -r hold_total _ hold_503 _ _ <<<"$(series_metrics post-hold)"
  write_evidence_artifact

  # ── Verdict (healthy rollout): measure the window, prove it was a rollout ──
  [ "$roll_total" -gt 0 ] && ok "sampled /ready ${roll_total}x across the rollout" ||
    fail "ZERO /ready samples across the rollout — the sampler never ran, and a zero-sample run must never pass"
  if [ "$ROLLOUT_CONVERGED" = 1 ]; then
    ok "replacement pod certified /ready ${rollout_recovered_at:+$((rollout_recovered_at - rollout_t0))}s after the rollout was triggered"
  else
    fail "no replacement pod certified /ready within ${ROLLOUT_OBSERVE_BUDGET_SEC}s — the rollout never recovered (see ${LOG_ARTIFACT})"
  fi
  if [ -n "$NEW_POD_UID" ] && [ "$NEW_POD_UID" != "$OLD_POD_UID" ] && [ "$NEW_POD_NAME" != "$OLD_POD_NAME" ]; then
    ok "pod was REPLACED: ${OLD_POD_NAME} -> ${NEW_POD_NAME} (uid changed) — the Recreate rollout was real"
  else
    fail "pod did not change across the rollout (${OLD_POD_NAME} -> ${NEW_POD_NAME:-none}) — nothing was measured"
  fi
  [ "${NEW_POD_RESTARTS:-}" = 0 ] &&
    ok "replacement pod is a fresh boot: restartCount 0" ||
    fail "replacement pod restartCount is '${NEW_POD_RESTARTS:-unknown}' — expected a fresh pod, not a restarted container"
  [ "$roll_503" -ge 1 ] &&
    ok "the rollout actually cut availability: ${roll_503} sample(s) at 503 (Recreate closes the old pod before the new one certifies)" ||
    fail "zero 503 samples across a Recreate rollout — either RollingUpdate crept in or the measurement is broken; the window claim is VACUOUS"
  [ "$roll_maxstreak" -le "$ROLLOUT_DOWNTIME_BUDGET_SEC" ] &&
    ok "MEASURED rollout downtime window: ${roll_maxstreak}s wall-clock 503 streak <= ${ROLLOUT_DOWNTIME_BUDGET_SEC}s budget" ||
    fail "MEASURED rollout downtime window ${roll_maxstreak}s EXCEEDS the ${ROLLOUT_DOWNTIME_BUDGET_SEC}s budget (see ${LOG_ARTIFACT})"
  [ "$hold_total" -gt 0 ] && [ "$hold_503" -eq 0 ] &&
    ok "post-rollout hold: ${hold_total} samples over ${STABILITY_WINDOW_SEC}s, zero 503 — the replacement is stable" ||
    fail "post-rollout hold saw ${hold_503} 503(s) across ${hold_total} sample(s) — the replacement did not stabilize"
elif [ "$EXPECT_STUCK" = 1 ]; then
  # ── FASE D (botched, D1b): roll to an unpullable image and watch the outage ──
  BOTCHED_IMAGE="$(botched_image_ref)"
  log "Botched rollout (D1b): rolling to unpullable image ${BOTCHED_IMAGE}; observing /ready for ${STUCK_OBSERVE_SEC}s"
  kctl set image deployment/"$HCC_DEPLOY" -n "$HCC_NS" \
    host-context-controller="$BOTCHED_IMAGE" >/dev/null
  ROLLOUT_TRIGGERED=1
  IMAGE_BROKEN=1
  sample_ready_series "$STUCK_OBSERVE_SEC" stuck 0
  read -r stuck_total stuck_200 stuck_503 stuck_maxstreak stuck_transitions <<<"$(series_metrics stuck)"
  deployed_image_now="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}' 2>/dev/null || true)"
  old_uid_live="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}' 2>/dev/null | grep -cxF "$OLD_POD_UID" || true)"
  stuck_pod_rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.status.phase}{"\t"}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}' 2>/dev/null || true)"
  replacement_row="$(awk -F '\t' -v old="$OLD_POD_UID" '$2 != old && $2 != "" { print; exit }' <<<"$stuck_pod_rows")"
  write_evidence_artifact

  # ── Verdict (botched rollout): the sustained outage is the EXPECTED result ──
  [ "$stuck_total" -gt 0 ] && ok "sampled /ready ${stuck_total}x across the botched rollout" ||
    fail "ZERO /ready samples across the botched rollout — the sampler never ran, and a zero-sample run must never pass"
  [ "$deployed_image_now" = "$BOTCHED_IMAGE" ] &&
    ok "the botched image is what the Deployment is actually rolling (${BOTCHED_IMAGE})" ||
    fail "deployment image is '${deployed_image_now:-unset}', not the injected ${BOTCHED_IMAGE} — the outage (if any) has a different cause"
  [ "$old_uid_live" = 0 ] &&
    ok "Recreate terminated the old HEALTHY pod before any viable replacement existed — zero fallback replicas (the D1b mechanism)" ||
    fail "old pod ${OLD_POD_NAME} is still alive under a Recreate rollout — the terminate-before-create premise did not hold"
  if [ -n "$replacement_row" ] && grep -Eq 'ErrImagePull|ImagePullBackOff' <<<"$replacement_row"; then
    ok "replacement pod is pinned by the injected image failure: ${replacement_row}"
  else
    fail "no replacement pod pinned in ErrImagePull|ImagePullBackOff (rows: ${stuck_pod_rows:-none}) — the outage is not attributable to the injected bad rollout"
  fi
  [ "$stuck_503" -ge 1 ] &&
    ok "the botched rollout bit the readiness path: ${stuck_503} sample(s) at 503" ||
    fail "zero 503 samples under a botched Recreate rollout — the outage claim is VACUOUS"
  [ "$stuck_transitions" -eq 0 ] &&
    ok "no 503->200 transition ever closed the outage — Kubernetes did NOT self-heal the botched Recreate rollout" ||
    fail "the outage closed on its own (${stuck_transitions} 503->200 transition(s)) — the D1b manual-undo premise is refuted; investigate before trusting this gate"
  [ "$stuck_maxstreak" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC" ] &&
    ok "SUSTAINED outage measured: ${stuck_maxstreak}s continuous 503 (> ${ROLLOUT_DOWNTIME_BUDGET_SEC}s healthy budget) and still open at observation end — recovery requires the manual image rollback cleanup performs (D1b reproduced)" ||
    fail "outage lasted only ${stuck_maxstreak}s and did not exceed the ${ROLLOUT_DOWNTIME_BUDGET_SEC}s healthy budget — the botched rollout did not produce the D1b total outage"
else
  # ── FASE D (recovery, evenfire#391): botch, prove the outage, then undo ──
  BOTCHED_IMAGE="$(botched_image_ref)"
  PRE_BOTCH_UID="$OLD_POD_UID"
  log "Botched rollout (EXPECT_RECOVERY): observing /ready for ${STUCK_OBSERVE_SEC}s"
  kctl set image deployment/"$HCC_DEPLOY" -n "$HCC_NS" host-context-controller="$BOTCHED_IMAGE" >/dev/null
  ROLLOUT_TRIGGERED=1
  IMAGE_BROKEN=1
  sample_ready_series "$STUCK_OBSERVE_SEC" stuck 0
  read -r stuck_total stuck_200 stuck_503 stuck_maxstreak stuck_transitions <<<"$(series_metrics stuck)"
  deployed_image_now="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}' 2>/dev/null || true)"
  old_uid_live="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o jsonpath='{range .items[*]}{.metadata.uid}{"\n"}{end}' 2>/dev/null | grep -cxF "$OLD_POD_UID" || true)"
  stuck_pod_rows="$(kctl get pods -n "$HCC_NS" -l "app=${HCC_DEPLOY}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.status.phase}{"\t"}{.status.containerStatuses[*].state.waiting.reason}{"\n"}{end}' 2>/dev/null || true)"
  replacement_row="$(awk -F '\t' -v old="$OLD_POD_UID" '$2 != old && $2 != "" { print; exit }' <<<"$stuck_pod_rows")"
  BOTCHED_POD_UID="$(awk -F '\t' '{ print $2; exit }' <<<"$replacement_row")"

  [ "$stuck_total" -gt 0 ] && ok "sampled /ready ${stuck_total}x across the botched rollout" ||
    fail "ZERO /ready samples across the botched rollout — the sampler never ran, and a zero-sample run must never pass"
  [ "$deployed_image_now" = "$BOTCHED_IMAGE" ] &&
    ok "the botched image is what the Deployment is actually rolling (${BOTCHED_IMAGE})" ||
    fail "deployment image is '${deployed_image_now:-unset}', not the injected ${BOTCHED_IMAGE}"
  [ "$old_uid_live" = 0 ] &&
    ok "Recreate terminated the old HEALTHY pod before any viable replacement existed" ||
    fail "old pod ${OLD_POD_NAME} is still alive under a Recreate rollout"
  if [ -n "$replacement_row" ] && grep -Eq 'ErrImagePull|ImagePullBackOff' <<<"$replacement_row"; then
    ok "replacement pod is pinned by the injected image failure: ${replacement_row}"
  else
    fail "no replacement pod pinned in ErrImagePull|ImagePullBackOff (rows: ${stuck_pod_rows:-none})"
  fi
  [ "$stuck_503" -ge 1 ] &&
    ok "the botched rollout bit the readiness path: ${stuck_503} sample(s) at 503" ||
    fail "zero 503 samples under a botched Recreate rollout — the outage claim is VACUOUS"
  [ "$stuck_transitions" -eq 0 ] &&
    ok "no 503->200 transition closed the outage before undo — Kubernetes did NOT self-heal" ||
    fail "the outage closed on its own (${stuck_transitions} 503->200 transition(s)) before undo"
  [ "$stuck_maxstreak" -gt "$ROLLOUT_DOWNTIME_BUDGET_SEC" ] &&
    ok "SUSTAINED outage before undo: ${stuck_maxstreak}s continuous 503 (> ${ROLLOUT_DOWNTIME_BUDGET_SEC}s healthy budget) — undo recovers D1b, not a blip" ||
    fail "outage lasted only ${stuck_maxstreak}s and did not exceed the ${ROLLOUT_DOWNTIME_BUDGET_SEC}s healthy budget — undo would recover a blip, not D1b"

  live_revision_before_undo="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
  [ "$live_revision_before_undo" != "$LAST_GOOD_REVISION" ] ||
    fail "live revision ${live_revision_before_undo} still equals last-good ${LAST_GOOD_REVISION} — undo would be a no-op"

  log "TEST ACTION (evenfire#391): rollout undo --to-revision=${LAST_GOOD_REVISION}"
  kctl rollout undo deployment/"$HCC_DEPLOY" -n "$HCC_NS" --to-revision="$LAST_GOOD_REVISION" >/dev/null ||
    fail "rollout undo --to-revision=${LAST_GOOD_REVISION} failed"
  kctl rollout status deployment/"$HCC_DEPLOY" -n "$HCC_NS" --timeout=240s >/dev/null ||
    fail "last-known-good revision ${LAST_GOOD_REVISION} did not become Ready"
  wait_until 90 "HCC /ready after undo" hcc_ready_now ||
    fail "HCC /ready did not return 200 after last-good restore"

  recovered_image="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="host-context-controller")].image}')"
  recovered_revision="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')"
  NEW_POD_NAME="$(running_hcc_pod)"
  NEW_POD_UID="$(kctl get pod "$NEW_POD_NAME" -n "$HCC_NS" -o jsonpath='{.metadata.uid}')"
  sample_ready_series "$STABILITY_WINDOW_SEC" post-hold 0
  read -r hold_total _ hold_503 _ _ <<<"$(series_metrics post-hold)"
  write_evidence_artifact

  [ "$recovered_image" = "$HCC_IMAGE" ] &&
    ok "undo restored the original image ${HCC_IMAGE}" ||
    fail "image after undo is '${recovered_image:-unset}', expected ${HCC_IMAGE}"
  [ "$recovered_revision" != "$live_revision_before_undo" ] &&
    ok "undo created a new revision ${recovered_revision} from last-good ${LAST_GOOD_REVISION} (was ${live_revision_before_undo})" ||
    fail "revision after undo is still ${recovered_revision:-unset} — undo was a no-op"
  if [ -n "$NEW_POD_UID" ] && [ "$NEW_POD_UID" != "$PRE_BOTCH_UID" ] && [ "$NEW_POD_UID" != "$BOTCHED_POD_UID" ]; then
    ok "recovered pod uid ${NEW_POD_UID} is neither the pre-botch nor the botched pod"
  else
    fail "recovered pod uid '${NEW_POD_UID:-none}' matches pre-botch ${PRE_BOTCH_UID} or botched ${BOTCHED_POD_UID:-none} — undo was a no-op"
  fi
  [ "$hold_total" -gt 0 ] && [ "$hold_503" -eq 0 ] &&
    ok "post-undo hold: ${hold_total} samples over ${STABILITY_WINDOW_SEC}s, zero 503" ||
    fail "post-undo hold saw ${hold_503} 503(s) across ${hold_total} sample(s)"
  # fail() records and continues, so only clear the broken-image flag when
  # every post-undo proof above actually passed. Otherwise cleanup must still
  # restore the original image.
  [ "$e2e_fail" -eq 0 ] && IMAGE_BROKEN=0
fi


log "Evidence artifact: ${LOG_ARTIFACT}"
# cleanup() (EXIT trap) restores the image if broken, waits for re-certification,
# deletes the fleet, finalizes the single-writer lock, and runs print_results.
