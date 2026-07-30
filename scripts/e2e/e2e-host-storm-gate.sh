#!/usr/bin/env bash
# ======================================================================
# E2E — Host STORM gate (Issue #791 follow-up, plan Addendum 5)
# ======================================================================
#
# Reproduces the incident's *concurrency class* at realistic fleet scale
# against the branch HCC image: with the seeded fleet present, this gate
# OVERLAPS four storm ingredients in time (start timestamps are recorded
# and asserted, proving genuine concurrency rather than sequential phases):
#
#   (a) create STORM_CREATE_COUNT (>=10) fixture Hosts, mixed
#       stateful/stateless, storm-labeled;
#   (b) delete STORM_DELETE_COUNT (>=3) pre-created fixture Hosts
#       mid-storm (supported CR deletion path — never kubectl scale);
#   (c) trigger 1 wake of a suspended stateless Host through the SUPPORTED
#       rpc-proxy user route (POST /api/v1/rpc/hosts/:hostRef/wake with a
#       per-user RPC token minted the Desktop App way — the same helper
#       pattern as e2e-stateless-suspend-wake.sh);
#   (d) kill the HCC pod once mid-storm (kubectl delete pod — a supported
#       operational event forcing LIST->WATCH recovery under load).
#
# Assertions (each fail-loud with diagnostics), per plan §14.1/§14.2:
#   A1 concurrency: delete/wake/kill start timestamps all fall strictly
#      inside the Host-creation span (first create .. last create).
#      Framing (for PR evidence): the interleaving is enforced by
#      construction, so A1 is primarily a RECORDING of that evidence — it
#      can only fail if the harness itself degenerates into sequential
#      phases; the load-bearing falsifiable claims are A2-A8.
#   A2 urgent queue-wait coverage has two independent same-pod windows:
#      (a) the supported wake window immediately before the HCC kill requires
#      every completed urgent sample <= 5s, after proving the wake reconcile
#      finished and the urgent lane returned idle; and
#      (b) ten dedicated Host ADDED events issued only after the replacement
#      HCC completed LIST→WATCH recovery use a D - C1 p95 delta. A slow wake
#      can therefore never be diluted by later fast post-recovery probes, and
#      neither window crosses the intentional process restart.
#   A3 no starvation: EVERY created Host's Deployment materializes within
#      STORM_MATERIALIZATION_BUDGET_S (20s, §14.2 "New Host
#      materialization") of that Host's OWN metadata.creationTimestamp,
#      independent of the others. All deltas are listed; worst case printed.
#   A4 watch recovery <= 15s across the HCC kill, from the new pod's
#      clerum_hcc_host_watch_recovery_seconds{phase="total"} histogram
#      (scrape C1): zero failure samples, >=1 success sample, and every
#      success sample inside the le="15" bucket.
#   A5 every deleted Host's bundle fully cleaned: ownership-label
#      (clerum.io/managed-by + clerum.io/host) leftover check across the
#      three bundle namespaces (mcp-host, channels, rpc-proxy) — the same
#      predicate measure-host-bundle-reconcile.sh teardown uses. FAIL-
#      CLOSED: a kubectl read that cannot be verified (API error without
#      positive NotFound evidence) counts as failure, never as absence.
#   A6 delete-cleanup counters consistent (zero lost deletes):
#      clerum_hcc_host_delete_cleanup_total must be REGISTERED on the
#      branch image (TYPE line present) and its outcomes must be
#      consistent: retried == 0, superseded == 0, and
#      queued == confirmed == completed. Read from scrape C2 (taken after
#      A5 cleanup convergence, so the outcome counters are settled).
#      All-zero is legitimate (deletes fully handled by the direct
#      watch-DELETE path, which by design does not touch this counter) —
#      A5 remains the falsifiable cleanup proof.
#   A7 recovered fleet convergence is bounded, from
#      clerum_hcc_host_fleet_requests_total (scrape C2): failed == 0 in both
#      windows, exactly one background full pass starts after the replacement
#      LIST→WATCH, and trailing <= coalesced. Cold start produces one request,
#      so requiring a coalesced request here would invent a second signal; the
#      concurrent-request coalescing contract is covered deterministically by
#      hostFleetScheduler.test.ts.
#   A8 wake ingredient integrity: the woken Host leaves state=suspended and
#      reaches a Ready pod within STORM_WAKE_READY_BUDGET_S of the wake
#      POST. This is an ingredient-integrity bound (a silently no-op wake
#      would weaken the gate), NOT a §14.2 wake SLO measurement — the §14.2
#      45s wake clock assumes a healthy controller, and this gate kills the
#      controller seconds after the wake on purpose.
#
# HONEST SCOPE (plan Addendum 5.3 — recorded in the evidence): local
# minikube cannot reproduce API-server instability, which was the
# incident's amplifier. This gate validates scheduling fairness and
# convergence under realistic concurrency, NOT API degradation — that
# dimension remains covered by the bounded-deadline unit contracts and
# post-deploy telemetry.
#
# Fixtures are storm-labeled (e2e-storm=791 + e2e-storm-run=<run-id>) and
# torn down fail-loud; the profile and seeded data stay. Non-clerum.io
# label keys are used deliberately: clerum.io/* is platform-owned
# (HCC/WRC ownership semantics) and fixtures must never squat on it.
#
# Binding plan:
#   .ralph/plans/2026-07-22-issue-791-hcc-priority-reconciliation-wake-plan.md
#     Addendum 5 (storm shape + assertions), §14.1 (metric names),
#     §14.2 (measurement clocks — start/end points are BINDING).
#
# House style: self-contained like measure-host-bundle-reconcile.sh (kctl
# --context wrapper, strict local-profile CONTEXT guard, log/ok/fail
# helpers, python3 for RFC3339->epoch and histogram math) with the
# rpc-token/wake helpers of e2e-stateless-suspend-wake.sh.
#
# ----------------------------------------------------------------------
# INPUTS (environment; fail-loud if missing/invalid)
#   CONTEXT     kubectl context. REFUSED unless it matches
#               ^clerum-(test|codex-|detached-|claude-) — a local minikube
#               profile. Any GKE / *prod* context is rejected outright.
#
# OPTIONAL INPUTS
#   E2E_STORM_WAKE_HOST_REF  suspended-wake target (default chatllm-stateless,
#               the seeded stateless Host — it must exist with
#               spec.lifecycle.stateless=true and be associated to the E2E
#               user; seed via scripts/e2e/seed-stateless-host.sh).
#   EXTERNAL_REST_API_BASE_URL  default http://127.0.0.1:8091
#   RPC_PROXY_BASE_URL          default http://127.0.0.1:8094
#   E2E_DEV_LOGIN_EMAIL         default test@clerum.io
#   E2E_USER_PASSWORD           default ${ADMIN_PASSWORD:-changeme123!}
#   STORM_CONTEXT_REF           Context CR fixtures reference (default context1)
#   STORM_MODEL_PROVIDER / STORM_MODEL_NAME  fixture model (default zai/glm-5.1)
#   HCC_METRICS_LOCAL_PORT      ephemeral scrape port (default 18082)
#   KEEP_FIXTURES               set to 1 to skip teardown (diagnosis only)
#
# Prereqs (each a HARD FAIL with the concrete reason):
#   - branch HCC image deployed (clerum_hcc_host_delete_cleanup_total
#     registered — A6 proves it)
#   - seeded stateless Host present + E2E user associated (wake mintable)
#   - external-rest-api + rpc-proxy reachable (make minikube-pf-all)
#
# Usage:
#   CONTEXT=clerum-test bash scripts/e2e/e2e-host-storm-gate.sh
#
# EXIT CODES
#   0  every storm assertion passed and teardown left zero fixtures
#   1  an assertion, precondition, or teardown failed loud — never masked
#   2  usage / input error
# ======================================================================
set -euo pipefail

# ─── Constants mirrored from host-context-controller/src/{constants,config}.ts ──
readonly MANAGED_BY_LABEL='clerum.io/managed-by'
readonly MANAGED_BY_VALUE='host-context-controller'
readonly HOST_LABEL='clerum.io/host'
readonly OWNED_SELECTOR="${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}"

readonly MCP_HOST_NS='mcp-host'        # config.hostNamespace
readonly CHANNELS_NS='channels'        # config.channelsNamespace
readonly RPC_PROXY_NS='rpc-proxy'      # config.rpcProxyNamespace
readonly CONTROL_NS='control-plane'
readonly HCC_DEPLOY='host-context-controller'
readonly HCC_PORT='8081'               # containerPort http (deploy/base/control-plane)
readonly HCC_METRICS_PATH='/metrics'   # server.ts GET /metrics

# Owned-child kinds + namespaces of a per-Host bundle (mirrors
# measure-host-bundle-reconcile.sh — includes per-Host NetworkPolicies).
readonly BUNDLE_KINDS='deployment service serviceaccount secret persistentvolumeclaim networkpolicy role rolebinding configmap'
readonly BUNDLE_NAMESPACES="${MCP_HOST_NS} ${CHANNELS_NS} ${RPC_PROXY_NS}"

# §14.1 metric names (host-context-controller/src/metrics.ts).
# EXPORTED so the adjudication python reads them from the environment. They are
# `readonly`, so passing them as same-name command-prefix assignments
# (`QUEUE_WAIT_METRIC="$QUEUE_WAIT_METRIC" python3 …`) would fail as a readonly
# reassignment under `set -e` — export once here and drop the inline prefixes.
readonly QUEUE_WAIT_METRIC='clerum_hcc_host_reconcile_queue_wait_seconds'
readonly IN_FLIGHT_METRIC='clerum_hcc_host_reconcile_in_flight'
readonly WATCH_RECOVERY_METRIC='clerum_hcc_host_watch_recovery_seconds'
readonly FLEET_METRIC='clerum_hcc_host_fleet_requests_total'
readonly DELETE_CLEANUP_METRIC='clerum_hcc_host_delete_cleanup_total'
export QUEUE_WAIT_METRIC WATCH_RECOVERY_METRIC FLEET_METRIC DELETE_CLEANUP_METRIC

# ─── Storm shape + budgets (each constant states its contract) ────────
# Addendum 5.1: ">=10" created fixture Hosts, mixed stateful/stateless.
readonly STORM_CREATE_COUNT=10
# A2's direct-watch probe is deliberately separate from the restart window:
# a cold-start LIST legitimately converges objects on the fleet lane. These
# ten ADDED events are emitted only once the replacement's LIST→WATCH recovery
# has succeeded, so their queue histogram is an unambiguous urgent-lane SLO.
readonly STORM_URGENT_PROBE_COUNT=10
# Addendum 5.1: ">=3" pre-created fixture Hosts deleted mid-storm.
readonly STORM_DELETE_COUNT=3
# §14.2 "urgent new/wake queue wait": local hard gate <= 5s (histogram
# bucket boundary le="5" exists in RECONCILE_LATENCY_BUCKETS).
readonly STORM_URGENT_P95_BUDGET_S=5
# The queue value itself is adjudicated against the 5s hard gate. This larger
# deadline bounds collection of the completed reconcile evidence and produces
# a loud operational failure if the wake never settles or telemetry is absent.
readonly STORM_WAKE_QUEUE_EVIDENCE_DEADLINE_S=60
# §14.2 "New Host materialization": Host CR -> Deployment <= 20s.
readonly STORM_MATERIALIZATION_BUDGET_S=20
# §14.2 "Watch recovery": recovery requested -> WATCH installed <= 15s
# (histogram bucket boundary le="15" exists).
readonly STORM_WATCH_RECOVERY_BUDGET_S=15
# A8 ingredient-integrity bound for the mid-storm wake: §14.2 wake budget
# (45s) + watch-recovery budget (15s, the controller is killed after the
# wake) + scheduling margin. NOT a §14.2 SLO measurement (see header).
readonly STORM_WAKE_READY_BUDGET_S=90
# Bounded discovery wait for ALL created Hosts' Deployments to exist before
# per-host deltas are adjudicated. Expiry is a HARD FAIL with diagnostics —
# the per-host 20s budget is judged from creationTimestamps regardless.
readonly STORM_CONVERGENCE_DEADLINE_S=120
# Bounded wait for a deleted Host's CR + full owned bundle to disappear.
readonly STORM_CLEANUP_DEADLINE_S=180
# Bounded wait for the delete-target fixtures' bundles to exist pre-storm
# (a delete of a bundle-less Host would prove nothing).
readonly STORM_PREP_MATERIALIZE_DEADLINE_S=90
# Bounded wait for the replacement HCC pod after the mid-storm kill.
readonly STORM_HCC_READY_DEADLINE_S=120
# Idle->suspend window for the wake target when it is not already
# suspended: emitter tick (~30s) + test idle floor (60s) + drain grace
# (20s) + HCC poll (5s) + slack (mirrors e2e-stateless-suspend-wake.sh
# SUSPEND_WINDOW rationale under the same shortened cadences).
readonly STORM_SUSPEND_WINDOW_S=210
# Bounded teardown wait before the fail-loud leftover check.
readonly STORM_TEARDOWN_DEADLINE_S=180
# Bounded EXTENSION for owned children that are already Terminating
# (deletionTimestamp set) at the leftover check — e.g. a workspace PVC whose
# kubernetes.io/pvc-protection finalizer drains for the deleting pod's
# termination grace. A leftover with NO deletionTimestamp is never given this
# extension (the delete was never issued → immediate fail).
readonly STORM_TEARDOWN_CONVERGE_S=120

# HCC test cadences applied ONLY when the wake target must first be driven
# to suspension (identical values to e2e-stateless-suspend-wake.sh; saved
# from the live deployment and restored in the cleanup trap).
readonly TEST_IDLE_MINUTES='1'
readonly TEST_IDLE_FLOOR_MINUTES='1'
readonly TEST_DRAIN_GRACE_MS='20000'
readonly TEST_POLL_MS='5000'

# Fixture provenance labels. Every object this gate creates carries BOTH so
# teardown deletes ONLY this run's fixtures. Deliberately NOT clerum.io/*
# (platform-owned label namespace — see header).
readonly FIXTURE_LABEL_KEY='e2e-storm'
readonly FIXTURE_LABEL_VAL='791'
readonly FIXTURE_RUN_KEY='e2e-storm-run'

# ─── Colors (mirrors e2e-lib.sh) ──────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# ─── Counters ─────────────────────────────────────────────────────────
g_pass=0; g_fail=0; g_total=0

# ─── Logging helpers (mirrors e2e-lib.sh / measure script) ────────────
log()    { echo -e "${CYAN}[STORM]${NC} $*"; }
ok()     { g_pass=$((g_pass+1)); g_total=$((g_total+1)); echo -e "${GREEN}  PASS${NC} — $*"; }
fail()   { g_fail=$((g_fail+1)); g_total=$((g_total+1)); echo -e "${RED}  FAIL${NC} — $*" >&2; }
warn()   { echo -e "${YELLOW}  WARN${NC} — $*" >&2; }
header() { echo -e "\n${BOLD}=== $* ===${NC}"; }
die()    { echo -e "${RED}[STORM] FATAL${NC} — ${1}" >&2; exit "${2:-1}"; }

print_results() {
  echo -e "\n${BOLD}=== Storm gate summary (run-id ${RUN_ID:-?}) ===${NC}"
  echo -e "  ${GREEN}pass=${g_pass}${NC} ${RED}fail=${g_fail}${NC} total=${g_total}"
  log "Honest scope (Addendum 5.3): local minikube cannot reproduce API-server"
  log "instability (the incident's amplifier); this gate validates scheduling"
  log "fairness and convergence under realistic concurrency, not API degradation."
}

# ─── kubectl wrapper — EVERY call carries --context (CLAUDE.md mandate) ──
kctl() { kubectl --context "$CONTEXT" "$@"; }

# ─── Portable time helper (python3; mirrors measure script) ───────────
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# ─── Strict local-profile context guard (fail-loud) ───────────────────
require_storm_context() {
  [[ -n "${CONTEXT:-}" ]] || die "CONTEXT is required (a local minikube profile context)." 2
  case "$CONTEXT" in
    *gke_*|*prod*)
      die "Refusing: CONTEXT='${CONTEXT}' looks like a GKE/production context. Local profiles only." 2 ;;
  esac
  if [[ ! "$CONTEXT" =~ ^clerum-(test|codex-|detached-|claude-) ]]; then
    die "Refusing: CONTEXT='${CONTEXT}' is not an allowed local profile. Must match ^clerum-(test|codex-|detached-|claude-)." 2
  fi
  if ! kctl get nodes -o name >/dev/null 2>&1; then
    die "CONTEXT='${CONTEXT}' is not reachable (kubectl get nodes failed). Start the profile and its port-forwards." 1
  fi
  log "context OK: ${CONTEXT}"
}

require_deps() {
  local missing=()
  for bin in kubectl jq python3 curl mktemp; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "missing required tools: ${missing[*]}" 2
}

# ─── Bounded wait helper: poll <fn> until success or <deadline_s>; on
# expiry dump <diag_fn> and return 1 (never silently continue) ────────
wait_until() {
  local deadline_s="$1" interval_s="$2" desc="$3" probe_fn="$4" diag_fn="${5:-:}"
  local start now
  start="$(now_ms)"
  while :; do
    if "$probe_fn"; then return 0; fi
    now="$(now_ms)"
    if (( (now - start) / 1000 >= deadline_s )); then
      warn "deadline ${deadline_s}s expired waiting for: ${desc}"
      "$diag_fn" || true
      return 1
    fi
    sleep "$interval_s"
  done
}

# ======================================================================
# Run state
# ======================================================================
RUN_ID=''; WORK_DIR=''
FIXTURE_SECRET=''
STORM_CREATED_HOSTS=()
STORM_DELETE_HOSTS=()
STORM_URGENT_PROBE_HOSTS=()
WAKE_HOST_REF="${E2E_STORM_WAKE_HOST_REF:-chatllm-stateless}"
EXT_BASE="${EXTERNAL_REST_API_BASE_URL:-http://127.0.0.1:8091}"
RPC_BASE="${RPC_PROXY_BASE_URL:-http://127.0.0.1:8094}"
DEV_EMAIL="${E2E_DEV_LOGIN_EMAIL:-test@clerum.io}"
DEV_PASSWORD="${E2E_USER_PASSWORD:-${ADMIN_PASSWORD:-changeme123!}}"
STORM_CTX_REF="${STORM_CONTEXT_REF:-context1}"
STORM_PROVIDER="${STORM_MODEL_PROVIDER:-zai}"
STORM_MODEL="${STORM_MODEL_NAME:-glm-5.1}"

# Storm timeline (epoch-ms; A1 concurrency evidence).
T_CREATE_FIRST_MS=''; T_DELETE_MS=''; T_WAKE_MS=''; T_KILL_MS=''; T_CREATE_LAST_MS=''

# ─── Cleanup trap: best-effort fixture removal + HCC cadence restore ──
PF_PID=''
HCC_ENV_SAVED=''
TEARDOWN_DONE=0

cleanup_portforward() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
  PF_PID=''
}

# Build the kubectl set env restore args from HCC_ENV_SAVED into the
# caller's `args` array (empty saved value => remove the key).
_hcc_restore_args() {
  args=()
  local key val
  while IFS='=' read -r key val; do
    [[ -n "$key" ]] || continue
    if [[ -n "$val" ]]; then args+=("${key}=${val}"); else args+=("${key}-"); fi
  done <<< "$HCC_ENV_SAVED"
}

# Lenient restore — EXIT-trap path only: best-effort with warnings, so an
# abnormal exit still attempts to undo the cadence mutation.
# shellcheck disable=SC2329  # invoked from cleanup_on_exit (EXIT trap)
restore_hcc_env() {
  [[ -n "$HCC_ENV_SAVED" ]] || return 0
  local args=()
  _hcc_restore_args
  [[ ${#args[@]} -gt 0 ]] || { HCC_ENV_SAVED=''; return 0; }
  log "Restoring HCC cadence env on deployment/${HCC_DEPLOY}"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" "${args[@]}" >/dev/null 2>&1 || \
    warn "failed to restore HCC env (manual check advised)"
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" --timeout=180s >/dev/null 2>&1 || \
    warn "HCC rollout did not settle after env restore"
  HCC_ENV_SAVED=''
}

# Strict restore — SUCCESS path (M3): a failed cadence restore is real
# profile damage and must flip the gate to FAIL (counted via fail());
# HCC_ENV_SAVED is kept on failure so the EXIT trap retries best-effort.
# Always returns 0 so the final print_results/exit-code path still runs.
restore_hcc_env_strict() {
  [[ -n "$HCC_ENV_SAVED" ]] || return 0
  local args=()
  _hcc_restore_args
  [[ ${#args[@]} -gt 0 ]] || { HCC_ENV_SAVED=''; return 0; }
  log "Restoring HCC cadence env on deployment/${HCC_DEPLOY} (strict)"
  if ! kctl set env "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" "${args[@]}" >/dev/null 2>&1; then
    fail "cadence restore FAILED — the profile is left with test cadences on deployment/${HCC_DEPLOY} (the EXIT trap retries best-effort; verify manually)"
    return 0
  fi
  if ! kctl rollout status "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" --timeout=180s >/dev/null 2>&1; then
    fail "HCC rollout did not settle after the cadence restore — verify deployment/${HCC_DEPLOY} manually"
    return 0
  fi
  HCC_ENV_SAVED=''
  ok "HCC test cadences restored and rolled out"
}

# shellcheck disable=SC2329  # invoked via the EXIT trap below
cleanup_on_exit() {
  local status=$?
  set +e
  cleanup_portforward
  if [[ "$TEARDOWN_DONE" != '1' && -n "$RUN_ID" && "${KEEP_FIXTURES:-}" != '1' ]]; then
    local sel="${FIXTURE_LABEL_KEY}=${FIXTURE_LABEL_VAL},${FIXTURE_RUN_KEY}=${RUN_ID}"
    warn "abnormal exit — best-effort deletion of storm fixtures (${sel})"
    kctl -n "$MCP_HOST_NS" delete host -l "$sel" --wait=false >/dev/null 2>&1 || \
      warn "best-effort fixture Host deletion failed (manual check advised)"
    kctl -n "$MCP_HOST_NS" delete secret -l "$sel" --wait=false >/dev/null 2>&1 || \
      warn "best-effort fixture Secret deletion failed (manual check advised)"
  fi
  restore_hcc_env
  exit "$status"
}
trap cleanup_on_exit EXIT

# ======================================================================
# Fixture + observable helpers
# ======================================================================
init_run() {
  # Run discriminator: FULL epoch-ms plus a random suffix — no truncation,
  # so there is no periodic tail-collision window between runs. Longest
  # fixture name stays s791-<13ms>-<5rand>-c%02d = 28 chars, inside the
  # 34-char budget that keeps host-<name>-mcp-host-runtime-tokens <= 63.
  RUN_ID="$(now_ms)-${RANDOM}"
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/e2e-host-storm-${RUN_ID}.XXXXXX")"
  FIXTURE_SECRET="s791-${RUN_ID}-keys"
  local i
  for i in $(seq 1 "$STORM_CREATE_COUNT"); do
    STORM_CREATED_HOSTS+=("$(printf 's791-%s-c%02d' "$RUN_ID" "$i")")
  done
  for i in $(seq 1 "$STORM_DELETE_COUNT"); do
    STORM_DELETE_HOSTS+=("$(printf 's791-%s-d%d' "$RUN_ID" "$i")")
  done
  for i in $(seq 1 "$STORM_URGENT_PROBE_COUNT"); do
    STORM_URGENT_PROBE_HOSTS+=("$(printf 's791-%s-u%02d' "$RUN_ID" "$i")")
  done
  log "run-id ${RUN_ID}; work dir ${WORK_DIR}"
  log "create fixtures: ${STORM_CREATED_HOSTS[*]}"
  log "delete fixtures: ${STORM_DELETE_HOSTS[*]}"
}

ensure_fixture_secret() {
  # Throwaway placeholder Secret (mirrors measure script): the mcp-host
  # readiness probe is an HTTP health endpoint that never validates the LLM
  # key, so a placeholder is sufficient for materialization clocks.
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: ${FIXTURE_SECRET}
  namespace: ${MCP_HOST_NS}
  labels:
    ${FIXTURE_LABEL_KEY}: "${FIXTURE_LABEL_VAL}"
    ${FIXTURE_RUN_KEY}: "${RUN_ID}"
type: Opaque
stringData:
  ZAI_API_KEY: "placeholder-e2e-storm-not-a-real-key"
  OPENAI_API_KEY: "placeholder-e2e-storm-not-a-real-key"
YAML
  log "created placeholder Secret ${FIXTURE_SECRET}"
}

# apply_storm_host <name> <stateless:true|false>
apply_storm_host() {
  local name="$1" stateless="$2" lifecycle_block=''
  if [[ "$stateless" == 'true' ]]; then
    lifecycle_block=$'  lifecycle:\n    stateless: true'
  fi
  cat <<YAML | kctl apply -f - >/dev/null
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: ${name}
  namespace: ${MCP_HOST_NS}
  labels:
    ${FIXTURE_LABEL_KEY}: "${FIXTURE_LABEL_VAL}"
    ${FIXTURE_RUN_KEY}: "${RUN_ID}"
spec:
  host: ${name}
  contextRef: ${STORM_CTX_REF}
  secretRef: ${FIXTURE_SECRET}
  model:
    provider: ${STORM_PROVIDER}
    name: ${STORM_MODEL}
${lifecycle_block}
YAML
}

# Collect every owned child of <host> across the bundle namespaces —
# the authoritative HCC ownership selector (managed-by + host), same
# predicate as measure-host-bundle-reconcile.sh / HostReconciler.
#
# FAIL-CLOSED (B2): prints "ns/kind/name" lines to stdout and returns 0
# even when empty; returns 2 when ANY kubectl read FAILED (the error goes
# to stderr). Every label-selector list of these standard kinds returns
# exit 0 with empty output when nothing matches, so a nonzero kubectl exit
# is a real read failure (API outage, RBAC, unknown kind) — callers MUST
# treat rc=2 as "verification impossible" (a failure), never as "zero
# leftovers".
collect_children() {
  local host="$1" ns kind out rc=0
  for ns in $BUNDLE_NAMESPACES; do
    for kind in $BUNDLE_KINDS; do
      if ! out="$(kctl -n "$ns" get "$kind" \
        -l "${OWNED_SELECTOR},${HOST_LABEL}=${host}" -o name 2>"${WORK_DIR}/collect-children.err")"; then
        echo "collect_children: kubectl get ${kind} in ${ns} FAILED for host ${host}: $(cat "${WORK_DIR}/collect-children.err" 2>/dev/null)" >&2
        rc=2
        continue
      fi
      if [[ -n "$out" ]]; then
        printf '%s\n' "$out" | sed "s|^|${ns}/|"
      fi
    done
  done
  return "$rc"
}

# FAIL-CLOSED absence check (B2): returns 0 ONLY when the API positively
# answered NotFound for the Host. "Present" returns 1; any other kubectl
# failure (outage, RBAC, timeout) returns 2 with the error on stderr —
# absence must never be inferred from an unreadable API.
# shellcheck disable=SC2329  # invoked from _deleted_hosts_clean_probe (runs via wait_until)
host_absent_confirmed() {
  local h="$1" err
  if kctl -n "$MCP_HOST_NS" get host "$h" -o name >/dev/null 2>"${WORK_DIR}/host-absent.err"; then
    return 1
  fi
  err="$(cat "${WORK_DIR}/host-absent.err" 2>/dev/null || true)"
  # Anchored match: the API-server reason '(NotFound)' or the kubectl
  # trailing form naming EXACTLY the requested Host. A kubeconfig-level
  # error like `context "..." not found` must never confirm absence.
  if printf '%s' "$err" | grep -Eq "\(NotFound\)|\"${h}\" not found\$"; then
    return 0
  fi
  echo "host_absent_confirmed: kubectl get host ${h} FAILED without NotFound evidence: ${err}" >&2
  return 2
}

hcc_pod_name() {
  kctl -n "$CONTROL_NS" get pods -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null \
    | awk -F'\t' '$1 != "" && $2 == "" {print $1; exit}'
}

storm_diagnostics() {
  {
    echo "----- storm diagnostics (run-id ${RUN_ID}) -----"
    kctl -n "$MCP_HOST_NS" get host -l "${FIXTURE_LABEL_KEY}=${FIXTURE_LABEL_VAL},${FIXTURE_RUN_KEY}=${RUN_ID}" -o wide 2>&1 || true
    kctl -n "$MCP_HOST_NS" get deploy -l "$OWNED_SELECTOR" -o wide 2>&1 | head -40 || true
    kctl -n "$CONTROL_NS" get pods -l "app=${HCC_DEPLOY}" -o wide 2>&1 || true
    echo "----- recent HCC logs -----"
    kctl -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=60 2>&1 || true
  } >&2
}

# ─── Metrics scrape (ephemeral port-forward; mirrors measure script) ──
# scrape_hcc_metrics <outfile> <pod-name> — M1: the port-forward binds the
# POD BY NAME (never deploy/) so a scrape can never silently read a
# different pod (e.g. a terminating one during a rollout) than the one the
# identity guard checked; cross-pod counter deltas would false-PASS A4.
scrape_hcc_metrics() {
  local out="$1" pod="$2" lport="${HCC_METRICS_LOCAL_PORT:-18082}"
  local url="http://127.0.0.1:${lport}${HCC_METRICS_PATH}"
  kctl -n "$CONTROL_NS" port-forward "pod/${pod}" "${lport}:${HCC_PORT}" >"${WORK_DIR}/pf.log" 2>&1 &
  PF_PID=$!
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _scrape_probe() { curl -fsS --max-time 3 "$url" -o "$out" 2>/dev/null; }
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _scrape_diag()  { { echo '----- port-forward log -----'; cat "${WORK_DIR}/pf.log" 2>/dev/null; } >&2; }
  if ! wait_until 30 2 "HCC metrics scrape -> ${out}" _scrape_probe _scrape_diag; then
    cleanup_portforward
    return 1
  fi
  cleanup_portforward
}

# ─── Wake-target lifecycle observables ────────────────────────────────
wake_lifecycle_state() {
  kctl -n "$MCP_HOST_NS" get host "$WAKE_HOST_REF" -o jsonpath='{.status.lifecycle.state}' 2>/dev/null || true
}

# shellcheck disable=SC2329  # invoked from _wake_converged_probe (runs via wait_until)
wake_ready_pod_exists() {
  kctl -n "$MCP_HOST_NS" get pods -l "app=${WAKE_HOST_REF}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
    | grep -qx 'True'
}

# ─── RPC helpers (Desktop App auth path; mirrors e2e-stateless-suspend-wake.sh) ──
SESSION_TOKEN=''; RPC_TOKEN=''
RPC_SCOPES_JSON='["host:message:invoke","host:approval:write","host:session:read","host:status:read","host:health:read","host:wake:write"]'

mint_session_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/auth/password-login" \
    -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg e "$DEV_EMAIL" --arg p "$DEV_PASSWORD" '{email:$e,password:$p}')") || {
    echo "password-login request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [[ "$code" == '200' ]] || { echo "password-login -> HTTP ${code}: ${body}" >&2; return 1; }
  SESSION_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [[ -n "$SESSION_TOKEN" ]] || { echo "password-login returned no .token" >&2; return 1; }
}

mint_rpc_token() {
  local resp code body
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST "${EXT_BASE}/api/v1/rpc/token" \
    -H "Authorization: Bearer ${SESSION_TOKEN}" -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg h "$WAKE_HOST_REF" --argjson s "$RPC_SCOPES_JSON" '{hostRefs:[$h],scopes:$s}')") || {
    echo "rpc/token request failed at ${EXT_BASE}" >&2; return 1; }
  code="$(echo "$resp" | tail -n1)"; body="$(echo "$resp" | sed '$d')"
  [[ "$code" == '200' ]] || { echo "rpc/token -> HTTP ${code}: ${body}" >&2; return 1; }
  RPC_TOKEN="$(echo "$body" | jq -r '.token // empty')"
  [[ -n "$RPC_TOKEN" ]] || { echo "rpc/token returned no .token" >&2; return 1; }
}

# The wake route is the user-facing rpc-proxy endpoint Desktop uses;
# rpc-proxy owns the control-api hop. Never kubectl scale.
WAKE_STATUS=''; WAKE_BODY=''
post_wake() {
  local resp
  mint_rpc_token || return 1
  resp=$(curl -sS -m 30 -w '\n%{http_code}' -X POST \
    "${RPC_BASE}/api/v1/rpc/hosts/${WAKE_HOST_REF}/wake" \
    -H "Authorization: Bearer ${RPC_TOKEN}" -H 'Content-Type: application/json') || {
    echo "wake POST failed at ${RPC_BASE}" >&2; return 1; }
  WAKE_STATUS="$(echo "$resp" | tail -n1)"; WAKE_BODY="$(echo "$resp" | sed '$d')"
  case "$WAKE_STATUS" in
    200|202|204) return 0 ;;
    *) echo "wake POST returned HTTP ${WAKE_STATUS}: ${WAKE_BODY}" >&2; return 1 ;;
  esac
}

# ─── HCC cadence shortening (only when the wake target must suspend) ──
save_and_set_hcc_cadences() {
  header "Setting HCC test cadences (idle=${TEST_IDLE_MINUTES}m, drain=${TEST_DRAIN_GRACE_MS}ms, poll=${TEST_POLL_MS}ms)"
  local keys=(CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES \
    CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS)
  local k cur saved=''
  for k in "${keys[@]}"; do
    cur="$(kctl get "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${k}')].value}" 2>/dev/null || true)"
    saved+="${k}=${cur}"$'\n'
  done
  HCC_ENV_SAVED="$saved"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" \
    "CONTEXT_MAPPER_STATELESS_IDLE_MINUTES=${TEST_IDLE_MINUTES}" \
    "CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES=${TEST_IDLE_FLOOR_MINUTES}" \
    "CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS=${TEST_DRAIN_GRACE_MS}" \
    "CONTEXT_MAPPER_HEARTBEAT_POLL_MS=${TEST_POLL_MS}" >/dev/null 2>&1 || {
    fail "failed to set HCC test cadences via kubectl set env"; return 1; }
  if kctl rollout status "deployment/${HCC_DEPLOY}" -n "$CONTROL_NS" --timeout=180s >/dev/null 2>&1; then
    ok "HCC test cadences applied and rolled out"
  else
    fail "HCC rollout did not settle after cadence set"; storm_diagnostics; return 1
  fi
}

# shellcheck disable=SC2329  # invoked by name via wait_until
_wake_target_suspended_probe() {
  local st reps
  st="$(wake_lifecycle_state)"
  reps="$(kctl -n "$MCP_HOST_NS" get deployment "$WAKE_HOST_REF" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo '')"
  [[ "$st" == 'suspended' && "${reps:-1}" == '0' ]]
}

# shellcheck disable=SC2329  # invoked by name via wait_until
_wake_target_diag() {
  {
    echo "----- wake target diagnostics (${WAKE_HOST_REF}) -----"
    kctl -n "$MCP_HOST_NS" get host "$WAKE_HOST_REF" \
      -o jsonpath='{"lifecycle="}{.status.lifecycle}{"\n"}' 2>&1 || true
    kctl -n "$MCP_HOST_NS" get pods -l "app=${WAKE_HOST_REF}" -o wide 2>&1 || true
    kctl -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=40 2>&1 || true
  } >&2
}

# ======================================================================
# Prerequisites
# ======================================================================
require_deps
require_storm_context
init_run

header "Prerequisites"
if kctl get deployment "$HCC_DEPLOY" -n "$CONTROL_NS" >/dev/null 2>&1; then
  ok "HCC deployment present in ${CONTROL_NS}"
else
  fail "deployment/${HCC_DEPLOY} not found in ${CONTROL_NS}"; print_results; exit 1
fi

stateless_flag="$(kctl -n "$MCP_HOST_NS" get host "$WAKE_HOST_REF" -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo '')"
if [[ "$stateless_flag" == 'true' ]]; then
  ok "wake target '${WAKE_HOST_REF}' exists with spec.lifecycle.stateless=true"
else
  fail "wake target '${WAKE_HOST_REF}' missing or not stateless (got '${stateless_flag:-<absent>}'). Seed: bash scripts/e2e/seed-stateless-host.sh"
  print_results; exit 1
fi

if kctl -n "$MCP_HOST_NS" get context.clerum.io "$STORM_CTX_REF" >/dev/null 2>&1 \
  || kctl get context.clerum.io "$STORM_CTX_REF" -n mcp-server >/dev/null 2>&1; then
  ok "fixture contextRef '${STORM_CTX_REF}' exists"
else
  fail "fixture contextRef '${STORM_CTX_REF}' not found (set STORM_CONTEXT_REF to an existing Context CR)"
  print_results; exit 1
fi

for svc in "external-rest-api ${EXT_BASE}" "rpc-proxy ${RPC_BASE}"; do
  name="${svc%% *}"; base="${svc##* }"
  if curl -fsS -m 10 "${base}/health" >/dev/null 2>&1; then
    ok "${name} reachable at ${base}"
  else
    fail "${name} NOT reachable at ${base} -- start port-forwards (make minikube-pf-all)"; print_results; exit 1
  fi
done

if mint_session_token; then ok "session token minted for ${DEV_EMAIL}"; else
  fail "cannot login as ${DEV_EMAIL} on ${EXT_BASE}"; print_results; exit 1; fi
if mint_rpc_token; then
  ok "user RPC token minted for hostRef=${WAKE_HOST_REF} (host:wake:write among scopes)"
else
  fail "cannot mint RPC token for hostRef=${WAKE_HOST_REF} -- is ${DEV_EMAIL} associated to it? Seed: bash scripts/e2e/seed-stateless-host.sh"
  print_results; exit 1
fi

# ======================================================================
# Prep 1 — storm fixtures that will be DELETED mid-storm (bundles must
# exist first: deleting a bundle-less Host proves nothing)
# ======================================================================
header "Prep — pre-create ${STORM_DELETE_COUNT} delete-target fixture Hosts"
ensure_fixture_secret
for h in "${STORM_DELETE_HOSTS[@]}"; do
  apply_storm_host "$h" false
done
# shellcheck disable=SC2329  # invoked by name via wait_until
_delete_targets_materialized_probe() {
  local h
  for h in "${STORM_DELETE_HOSTS[@]}"; do
    kctl -n "$MCP_HOST_NS" get deployment "$h" >/dev/null 2>&1 || return 1
  done
}
if wait_until "$STORM_PREP_MATERIALIZE_DEADLINE_S" 3 \
  "delete-target bundles (Deployments) to materialize" \
  _delete_targets_materialized_probe storm_diagnostics; then
  ok "all ${STORM_DELETE_COUNT} delete-target Hosts have materialized bundles"
else
  fail "delete-target bundles did not materialize within ${STORM_PREP_MATERIALIZE_DEADLINE_S}s — cannot run a meaningful mid-storm delete"
  print_results; exit 1
fi

# ======================================================================
# Prep 2 — ensure the wake target is SUSPENDED (idle-driven, supported
# path; shortened cadences only if needed, restored in the trap)
# ======================================================================
header "Prep — wake target suspension (${WAKE_HOST_REF})"
if _wake_target_suspended_probe; then
  ok "wake target already suspended (state=suspended, replicas=0)"
else
  save_and_set_hcc_cadences || { print_results; exit 1; }
  if wait_until "$STORM_SUSPEND_WINDOW_S" 5 \
    "wake target ${WAKE_HOST_REF} to idle-suspend" \
    _wake_target_suspended_probe _wake_target_diag; then
    ok "wake target suspended via idle expiry (supported D8 path)"
  else
    fail "wake target did not suspend within ${STORM_SUSPEND_WINDOW_S}s (state=$(wake_lifecycle_state)) — cannot exercise the mid-storm wake ingredient"
    print_results; exit 1
  fi
fi

# ======================================================================
# Prep 3 — metrics baseline (scrape A) + pre-storm HCC pod identity
# ======================================================================
header "Prep — metrics baseline (scrape A)"
SCRAPE_A="${WORK_DIR}/metrics-A.prom"
SCRAPE_B="${WORK_DIR}/metrics-B.prom"
SCRAPE_C1="${WORK_DIR}/metrics-C1.prom"
SCRAPE_C2="${WORK_DIR}/metrics-C2.prom"
SCRAPE_D="${WORK_DIR}/metrics-D.prom"
SCRAPE_WAKE_PRE="${WORK_DIR}/metrics-wake-pre.prom"
SCRAPE_WAKE_POST="${WORK_DIR}/metrics-wake-post.prom"
HCC_POD_A="$(hcc_pod_name)"
if [[ -z "$HCC_POD_A" ]]; then
  fail "no Running HCC pod found for baseline identity"; storm_diagnostics; print_results; exit 1
fi
if scrape_hcc_metrics "$SCRAPE_A" "$HCC_POD_A"; then
  ok "baseline scrape A captured (pod ${HCC_POD_A})"
else
  fail "could not scrape HCC ${HCC_METRICS_PATH} for baseline"; print_results; exit 1
fi

# ======================================================================
# STORM — overlapped ingredients (timestamps recorded for A1)
# ======================================================================
header "STORM — overlapped create/delete/wake/kill (run-id ${RUN_ID})"
STORM_HALF=$(( STORM_CREATE_COUNT / 2 ))

T_CREATE_FIRST_MS="$(now_ms)"
i=0
for h in "${STORM_CREATED_HOSTS[@]}"; do
  i=$((i + 1))
  [[ $i -gt $STORM_HALF ]] && break
  # Mixed lifecycle: even index stateless, odd stateful (Addendum 5.1).
  if (( i % 2 == 0 )); then apply_storm_host "$h" true; else apply_storm_host "$h" false; fi
done
log "storm: first ${STORM_HALF} Host creations issued"

T_DELETE_MS="$(now_ms)"
for h in "${STORM_DELETE_HOSTS[@]}"; do
  kctl -n "$MCP_HOST_NS" delete host "$h" --wait=false >/dev/null || {
    fail "storm: mid-storm delete of Host ${h} failed"; print_results; exit 1; }
done
log "storm: ${STORM_DELETE_COUNT} mid-storm Host deletions issued"

# Isolate the supported wake on the pre-kill pod. Samples from the first half
# of Host creation may still settle inside this window; they are valid urgent
# traffic and the hard-gate assertion below requires every one of them, not
# only a percentile, to remain within budget.
HCC_POD_WAKE="$(hcc_pod_name)"
if [[ -z "$HCC_POD_WAKE" || "$HCC_POD_WAKE" != "$HCC_POD_A" ]]; then
  fail "storm: HCC pod changed before the wake metric baseline (${HCC_POD_A} -> ${HCC_POD_WAKE:-<none>})"
  storm_diagnostics; print_results; exit 1
fi
if ! scrape_hcc_metrics "$SCRAPE_WAKE_PRE" "$HCC_POD_WAKE"; then
  fail "storm: could not capture the same-pod wake metric baseline"
  print_results; exit 1
fi

T_WAKE_MS="$(now_ms)"
if post_wake; then
  log "storm: wake POST accepted for ${WAKE_HOST_REF} (HTTP ${WAKE_STATUS})"
else
  fail "storm: mid-storm wake POST failed for ${WAKE_HOST_REF}"; print_results; exit 1
fi

# Prove that the supported wake reached HCC, completed its urgent reconcile,
# published at least one new queue sample, and left no urgent reconcile in
# flight. This closes the old process-death measurement gap for the wake: the
# pre-kill scrape is accepted only after its queue observation is durable.
# shellcheck disable=SC2329  # invoked by name via wait_until
_wake_urgent_evidence_recorded() {
  local current_pod lifecycle_state pre_count post_count in_flight
  current_pod="$(hcc_pod_name)"
  [[ -n "$current_pod" && "$current_pod" == "$HCC_POD_WAKE" ]] || return 1
  lifecycle_state="$(wake_lifecycle_state)"
  [[ -n "$lifecycle_state" && "$lifecycle_state" != 'suspended' ]] || return 1
  scrape_hcc_metrics "$SCRAPE_WAKE_POST" "$HCC_POD_WAKE" || return 1
  pre_count="$(awk -v metric="${QUEUE_WAIT_METRIC}_bucket" '
    index($0, metric "{") == 1 && $0 ~ /lane="urgent"/ && $0 ~ /le="\+Inf"/ { total += $NF }
    END { print total + 0 }
  ' "$SCRAPE_WAKE_PRE")"
  post_count="$(awk -v metric="${QUEUE_WAIT_METRIC}_bucket" '
    index($0, metric "{") == 1 && $0 ~ /lane="urgent"/ && $0 ~ /le="\+Inf"/ { total += $NF }
    END { print total + 0 }
  ' "$SCRAPE_WAKE_POST")"
  in_flight="$(awk -v metric="${IN_FLIGHT_METRIC}" '
    index($0, metric "{") == 1 && $0 ~ /lane="urgent"/ { total += $NF }
    END { print total + 0 }
  ' "$SCRAPE_WAKE_POST")"
  awk -v before="$pre_count" -v after="$post_count" -v active="$in_flight" \
    'BEGIN { exit !((after - before) >= 1 && active == 0) }'
}
if wait_until "$STORM_WAKE_QUEUE_EVIDENCE_DEADLINE_S" 1 \
  "supported wake urgent reconcile + same-pod queue evidence" \
  _wake_urgent_evidence_recorded _wake_target_diag; then
  ok "A2 wake input: supported wake reconcile completed and published same-pod urgent queue evidence"
else
  fail "A2 wake input: wake did not complete with durable same-pod urgent queue evidence within ${STORM_WAKE_QUEUE_EVIDENCE_DEADLINE_S}s"
  print_results; exit 1
fi

# Scrape B is the already-validated final wake-window scrape on the pre-kill
# pod. Reuse it rather than opening a second race between evidence and kill.
HCC_POD_B="$(hcc_pod_name)"
if [[ "$HCC_POD_B" != "$HCC_POD_A" ]]; then
  fail "storm: HCC pod changed unexpectedly before the kill (${HCC_POD_A} -> ${HCC_POD_B:-<none>}) — counter deltas would be invalid"
  storm_diagnostics; print_results; exit 1
fi
cp "$SCRAPE_WAKE_POST" "$SCRAPE_B"
log "storm: pre-kill scrape B captured (pod ${HCC_POD_B})"

T_KILL_MS="$(now_ms)"
kctl -n "$CONTROL_NS" delete pod "$HCC_POD_B" --wait=false >/dev/null || {
  fail "storm: could not delete HCC pod ${HCC_POD_B}"; print_results; exit 1; }
log "storm: HCC pod ${HCC_POD_B} kill issued (forces LIST->WATCH recovery under load)"

i=0
for h in "${STORM_CREATED_HOSTS[@]}"; do
  i=$((i + 1))
  [[ $i -le $STORM_HALF ]] && continue
  if (( i % 2 == 0 )); then apply_storm_host "$h" true; else apply_storm_host "$h" false; fi
done
T_CREATE_LAST_MS="$(now_ms)"
log "storm: remaining $(( STORM_CREATE_COUNT - STORM_HALF )) Host creations issued"

# ─── A1: concurrency evidence ─────────────────────────────────────────
header "A1 — storm concurrency (recorded start timestamps)"
printf '  %-28s %s\n' 'ingredient' 'start (epoch-ms)'
printf '  %-28s %s\n' 'create[first]'  "$T_CREATE_FIRST_MS"
printf '  %-28s %s\n' 'delete[batch]'  "$T_DELETE_MS"
printf '  %-28s %s\n' 'wake[POST]'     "$T_WAKE_MS"
printf '  %-28s %s\n' 'hcc-kill'       "$T_KILL_MS"
printf '  %-28s %s\n' 'create[last]'   "$T_CREATE_LAST_MS"
if [[ "$T_CREATE_FIRST_MS" -lt "$T_DELETE_MS" && "$T_DELETE_MS" -lt "$T_WAKE_MS" \
   && "$T_WAKE_MS" -lt "$T_KILL_MS" && "$T_KILL_MS" -lt "$T_CREATE_LAST_MS" ]]; then
  ok "A1: deletes, wake, and HCC kill all started strictly inside the creation span (genuinely overlapped, not sequential phases)"
else
  fail "A1: storm ingredient timestamps are not interleaved (first=${T_CREATE_FIRST_MS} delete=${T_DELETE_MS} wake=${T_WAKE_MS} kill=${T_KILL_MS} last=${T_CREATE_LAST_MS})"
  print_results; exit 1
fi

# ======================================================================
# Convergence — replacement HCC pod, then all created Hosts' Deployments
# ======================================================================
header "Convergence — replacement HCC pod + created-Host materialization"
# shellcheck disable=SC2329  # invoked by name via wait_until
_new_hcc_pod_probe() {
  local name; name="$(hcc_pod_name)"
  [[ -n "$name" && "$name" != "$HCC_POD_B" ]]
}
if wait_until "$STORM_HCC_READY_DEADLINE_S" 2 "replacement HCC pod after the kill" \
  _new_hcc_pod_probe storm_diagnostics; then
  HCC_POD_C="$(hcc_pod_name)"
  ok "replacement HCC pod Running: ${HCC_POD_C}"
else
  fail "no replacement HCC pod within ${STORM_HCC_READY_DEADLINE_S}s of the kill"
  print_results; exit 1
fi

# shellcheck disable=SC2329  # invoked by name via wait_until
_all_created_deploys_probe() {
  local h
  for h in "${STORM_CREATED_HOSTS[@]}"; do
    kctl -n "$MCP_HOST_NS" get deployment "$h" >/dev/null 2>&1 || return 1
  done
}
if wait_until "$STORM_CONVERGENCE_DEADLINE_S" 3 \
  "all ${STORM_CREATE_COUNT} created Hosts' Deployments to exist" \
  _all_created_deploys_probe storm_diagnostics; then
  ok "all ${STORM_CREATE_COUNT} created Hosts have Deployments"
else
  fail "created-Host Deployments incomplete after ${STORM_CONVERGENCE_DEADLINE_S}s — starvation or lost events"
  print_results; exit 1
fi

# ─── Scrape C1 (M2): taken IMMEDIATELY after created-Host convergence so
# post-storm quiet-period samples cannot dilute the urgent p95 (A2) —
# recovery (A4) necessarily completed before any post-kill Deployment
# materialized. A6/A7 counters are read later from scrape C2, after the
# A5 cleanup convergence, so their outcome counters are settled. ─────────
header "Metrics — early post-convergence scrape C1 (replacement pod)"
HCC_POD_C_NOW="$(hcc_pod_name)"
if [[ -z "$HCC_POD_C_NOW" || "$HCC_POD_C_NOW" != "$HCC_POD_C" ]]; then
  fail "replacement HCC pod changed again before scrape C1 (${HCC_POD_C} -> ${HCC_POD_C_NOW:-<none>}) — an unexpected second restart invalidates the counter windows"
  storm_diagnostics; print_results; exit 1
fi
if ! scrape_hcc_metrics "$SCRAPE_C1" "$HCC_POD_C"; then
  fail "could not scrape HCC metrics (C1) on replacement pod ${HCC_POD_C}"; print_results; exit 1
fi
log "scrape C1 captured (replacement pod ${HCC_POD_C})"

# ─── A2 input: direct-watch urgent probe after replacement LIST→WATCH ──
# The storm's second half is intentionally issued immediately after pod
# deletion, when a cold-start LIST may legitimately own those Hosts on the
# fleet lane. C1 proves the replacement has completed LIST→WATCH recovery;
# issue a fresh, independent set now so every observed sample is a direct
# watch ADDED admission on the urgent lane.
header "A2 input — urgent direct-watch probe (${STORM_URGENT_PROBE_COUNT} Hosts)"
for i in $(seq 1 "${#STORM_URGENT_PROBE_HOSTS[@]}"); do
  h="${STORM_URGENT_PROBE_HOSTS[$((i - 1))]}"
  if (( i % 2 == 0 )); then apply_storm_host "$h" true; else apply_storm_host "$h" false; fi
done
log "urgent probe: ${STORM_URGENT_PROBE_COUNT} Host ADDED events issued after replacement LIST→WATCH"

# shellcheck disable=SC2329  # invoked by name via wait_until
_urgent_probe_deploys_probe() {
  local h
  for h in "${STORM_URGENT_PROBE_HOSTS[@]}"; do
    kctl -n "$MCP_HOST_NS" get deployment "$h" >/dev/null 2>&1 || return 1
  done
}
if wait_until "$STORM_CONVERGENCE_DEADLINE_S" 3 \
  "all ${STORM_URGENT_PROBE_COUNT} urgent-probe Hosts' Deployments to exist" \
  _urgent_probe_deploys_probe storm_diagnostics; then
  ok "A2 input: every direct-watch urgent-probe Host materialized"
else
  fail "A2 input: urgent-probe Host materialization incomplete after ${STORM_CONVERGENCE_DEADLINE_S}s"
  print_results; exit 1
fi
HCC_POD_C_NOW="$(hcc_pod_name)"
if [[ -z "$HCC_POD_C_NOW" || "$HCC_POD_C_NOW" != "$HCC_POD_C" ]]; then
  fail "replacement HCC pod changed before urgent-probe scrape D (${HCC_POD_C} -> ${HCC_POD_C_NOW:-<none>}) — urgent counter window is invalid"
  storm_diagnostics; print_results; exit 1
fi

# Deployment existence can precede the end of reconcileCore, where the queue
# histogram is observed. Poll the metric itself instead of sleeping, otherwise
# a fast API server can make this gate race its own telemetry.
# shellcheck disable=SC2329  # invoked by name via wait_until
_urgent_probe_metrics_recorded() {
  local current_pod pre_count post_count
  current_pod="$(hcc_pod_name)"
  [[ -n "$current_pod" && "$current_pod" == "$HCC_POD_C" ]] || return 1
  scrape_hcc_metrics "$SCRAPE_D" "$HCC_POD_C" || return 1
  pre_count="$(awk -v metric="${QUEUE_WAIT_METRIC}_bucket" '
    index($0, metric "{") == 1 && $0 ~ /lane="urgent"/ && $0 ~ /le="\+Inf"/ { total += $NF }
    END { print total + 0 }
  ' "$SCRAPE_C1")"
  post_count="$(awk -v metric="${QUEUE_WAIT_METRIC}_bucket" '
    index($0, metric "{") == 1 && $0 ~ /lane="urgent"/ && $0 ~ /le="\+Inf"/ { total += $NF }
    END { print total + 0 }
  ' "$SCRAPE_D")"
  awk -v before="$pre_count" -v after="$post_count" -v required="$STORM_URGENT_PROBE_COUNT" \
    'BEGIN { exit !((after - before) >= required) }'
}
if ! wait_until 60 2 \
  "at least ${STORM_URGENT_PROBE_COUNT} direct-watch urgent metric samples" \
  _urgent_probe_metrics_recorded storm_diagnostics; then
  fail "urgent-probe reconciles did not publish ${STORM_URGENT_PROBE_COUNT} queue samples within 60s"
  print_results; exit 1
fi
log "scrape D captured (replacement pod ${HCC_POD_C}; direct-watch urgent window C1→D)"

# ─── A3: per-host materialization <= 20s from ITS OWN creation ───────
header "A3 — per-host materialization (budget ${STORM_MATERIALIZATION_BUDGET_S}s, §14.2)"
MAT_ROWS="${WORK_DIR}/materialization.rows"
: >"$MAT_ROWS"
for h in "${STORM_CREATED_HOSTS[@]}"; do
  hc="$(kctl -n "$MCP_HOST_NS" get host "$h" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true)"
  dc="$(kctl -n "$MCP_HOST_NS" get deployment "$h" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true)"
  if [[ -z "$hc" || -z "$dc" ]]; then
    fail "A3: missing creationTimestamp for ${h} (host='${hc}' deploy='${dc}')"
    print_results; exit 1
  fi
  printf '%s %s %s\n' "$h" "$hc" "$dc" >>"$MAT_ROWS"
done
if MAT_ROWS="$MAT_ROWS" BUDGET_S="$STORM_MATERIALIZATION_BUDGET_S" python3 <<'PY'
import datetime, os, sys

def ms(v):
    return int(datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)

budget = int(os.environ["BUDGET_S"])
rows = []
for line in open(os.environ["MAT_ROWS"], encoding="utf-8"):
    host, host_ts, dep_ts = line.split()
    delta = round((ms(dep_ts) - ms(host_ts)) / 1000.0, 3)
    rows.append((host, delta))
    print(f"  {host}: Host->Deployment {delta:.1f}s ({'within' if delta <= budget else 'OVER_BUDGET'})")
worst = max(rows, key=lambda r: r[1])
print(f"  worst case: {worst[0]} at {worst[1]:.1f}s (budget {budget}s)")
offenders = [r for r in rows if r[1] > budget]
if offenders:
    print("  OVER BUDGET: " + ", ".join(f"{h}={d:.1f}s" for h, d in offenders))
    sys.exit(1)
PY
then
  ok "A3: every created Host materialized <= ${STORM_MATERIALIZATION_BUDGET_S}s from its own creation (no starvation)"
else
  fail "A3: at least one created Host exceeded the ${STORM_MATERIALIZATION_BUDGET_S}s materialization budget (offenders listed above)"
  storm_diagnostics; print_results; exit 1
fi

# ─── A8: wake ingredient integrity ────────────────────────────────────
header "A8 — mid-storm wake converges (bound ${STORM_WAKE_READY_BUDGET_S}s)"
# shellcheck disable=SC2329  # invoked by name via wait_until
_wake_converged_probe() {
  local st; st="$(wake_lifecycle_state)"
  [[ -n "$st" && "$st" != 'suspended' ]] || return 1
  wake_ready_pod_exists
}
wake_elapsed_s=$(( ( $(now_ms) - T_WAKE_MS ) / 1000 ))
wake_remaining_s=$(( STORM_WAKE_READY_BUDGET_S - wake_elapsed_s ))
[[ "$wake_remaining_s" -lt 1 ]] && wake_remaining_s=1
if wait_until "$wake_remaining_s" 3 "woken host ${WAKE_HOST_REF} to leave suspended + reach a Ready pod" \
  _wake_converged_probe _wake_target_diag; then
  ok "A8: wake converged $(( ( $(now_ms) - T_WAKE_MS ) / 1000 ))s after the wake POST (state=$(wake_lifecycle_state))"
else
  fail "A8: woken host did not reach Ready within ${STORM_WAKE_READY_BUDGET_S}s of the wake POST (state=$(wake_lifecycle_state)) — the wake ingredient did not complete"
  print_results; exit 1
fi

# ─── A5: deleted bundles fully cleaned (ownership-label leftover check) ──
header "A5 — deleted-Host bundle cleanup across ${BUNDLE_NAMESPACES}"
# FAIL-CLOSED (B2): the probe succeeds ONLY on positive evidence — the CR
# absence must be a confirmed NotFound and every leftover list must have
# been readable. A kubectl error keeps the probe failing, so an API outage
# ends in the bounded deadline FAILING (with the read errors on stderr),
# never in a false "cleanup complete".
# shellcheck disable=SC2329  # invoked by name via wait_until
_deleted_hosts_clean_probe() {
  local h leftovers
  for h in "${STORM_DELETE_HOSTS[@]}"; do
    host_absent_confirmed "$h" || return 1
    leftovers="$(collect_children "$h")" || return 1
    [[ -z "$leftovers" ]] || return 1
  done
}
# shellcheck disable=SC2329  # invoked by name via wait_until
_deleted_hosts_diag() {
  local h
  {
    echo "----- deleted-host leftover diagnostics -----"
    for h in "${STORM_DELETE_HOSTS[@]}"; do
      echo "host ${h}:"
      kctl -n "$MCP_HOST_NS" get host "$h" -o wide 2>&1 || true
      collect_children "$h" 2>&1 || true
    done
    kctl -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=60 2>&1 || true
  } >&2
}
if wait_until "$STORM_CLEANUP_DEADLINE_S" 3 \
  "deleted Hosts' CRs + owned bundles to disappear" \
  _deleted_hosts_clean_probe _deleted_hosts_diag; then
  ok "A5: every deleted Host's CR and owned bundle fully cleaned (confirmed NotFound + zero ownership-labeled leftovers in ${BUNDLE_NAMESPACES})"
else
  fail "A5: deleted-Host cleanup incomplete OR unverifiable after ${STORM_CLEANUP_DEADLINE_S}s (leftovers/read failures listed above) — lost delete, cleanup regression, or an API read that could not be verified (fail-closed)"
  print_results; exit 1
fi

# ======================================================================
# Metrics adjudication (scrape C2 after cleanup convergence, then A2/A4/A6/A7)
# ======================================================================
header "Metrics — settled scrape C2 + §14.1 adjudication"
HCC_POD_C_NOW="$(hcc_pod_name)"
if [[ -z "$HCC_POD_C_NOW" || "$HCC_POD_C_NOW" != "$HCC_POD_C" ]]; then
  fail "replacement HCC pod changed between scrapes C1 and C2 (${HCC_POD_C} -> ${HCC_POD_C_NOW:-<none>}) — an unexpected second restart invalidates the counter windows"
  storm_diagnostics; print_results; exit 1
fi
if ! scrape_hcc_metrics "$SCRAPE_C2" "$HCC_POD_C"; then
  fail "could not scrape HCC metrics (C2) on replacement pod ${HCC_POD_C}"; print_results; exit 1
fi
log "scrape C2 captured (replacement pod ${HCC_POD_C}; A6/A7 counters settled post-A5)"

# One python pass performs the five metric assertions and emits one
# VERDICT|<name>|PASS/FAIL|<detail> line each. python exits nonzero only
# when it cannot parse its inputs (a hard failure of the gate itself).
METRIC_VERDICTS="${WORK_DIR}/metric-verdicts.txt"
if ! SCRAPE_A="$SCRAPE_A" SCRAPE_B="$SCRAPE_B" SCRAPE_C1="$SCRAPE_C1" SCRAPE_C2="$SCRAPE_C2" SCRAPE_D="$SCRAPE_D" \
  SCRAPE_WAKE_PRE="$SCRAPE_WAKE_PRE" SCRAPE_WAKE_POST="$SCRAPE_WAKE_POST" \
  P95_BUDGET_S="$STORM_URGENT_P95_BUDGET_S" RECOVERY_BUDGET_S="$STORM_WATCH_RECOVERY_BUDGET_S" \
  MIN_URGENT_SAMPLES="$STORM_URGENT_PROBE_COUNT" \
  python3 >"$METRIC_VERDICTS" <<'PY'
import os, re, sys
from collections import defaultdict

LINE = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)')
LABEL = re.compile(r'(\w+)="([^"]*)"')

def load(path):
    samples, types = [], set()
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("# TYPE "):
            types.add(line.split()[2])
            continue
        if line.startswith("#"):
            continue
        m = LINE.match(line)
        if not m:
            continue
        labels = dict(LABEL.findall(m.group(2) or ""))
        try:
            value = float(m.group(3))
        except ValueError:
            continue
        samples.append((m.group(1), labels, value))
    return samples, types

# Two replacement-pod windows (M2): C1 is scraped immediately after
# created-Host convergence (A2 p95 undiluted by quiet-period samples; A4
# recovery necessarily recorded by then); C2 is scraped after the A5
# cleanup convergence (A6/A7 outcome counters settled). Pod identity for
# A/B and C1/C2 is guarded in bash before this adjudication runs.
a, _ = load(os.environ["SCRAPE_A"])
b, _ = load(os.environ["SCRAPE_B"])
c1, _ = load(os.environ["SCRAPE_C1"])
c2, c2_types = load(os.environ["SCRAPE_C2"])
d, _ = load(os.environ["SCRAPE_D"])
wake_pre, _ = load(os.environ["SCRAPE_WAKE_PRE"])
wake_post, _ = load(os.environ["SCRAPE_WAKE_POST"])

def buckets(samples, metric, match):
    """Cumulative histogram buckets {le: count} summed over matching series."""
    out = defaultdict(float)
    for name, labels, value in samples:
        if name != metric + "_bucket":
            continue
        if any(labels.get(k) != v for k, v in match.items()):
            continue
        out[labels.get("le", "")] += value
    return out

def counter(samples, metric, label, value):
    total = 0.0
    for name, labels, val in samples:
        if name == metric and labels.get(label) == value:
            total += val
    return total

def le_key(le):
    return float("inf") if le == "+Inf" else float(le)

verdicts = []

# ── A2a: every completed urgent reconcile in the supported wake window ─
qm = os.environ["QUEUE_WAIT_METRIC"]
budget = float(os.environ["P95_BUDGET_S"])
wake_before = buckets(wake_pre, qm, {"lane": "urgent"})
wake_after = buckets(wake_post, qm, {"lane": "urgent"})
wake_delta = defaultdict(float)
wake_reset = False
for le in set(wake_before) | set(wake_after):
    delta = wake_after.get(le, 0.0) - wake_before.get(le, 0.0)
    if delta < 0:
        wake_reset = True
    wake_delta[le] = delta
if wake_reset:
    verdicts.append(("A2-wake-urgent-hard-gate", False,
                     "negative bucket delta in the same-pod wake window"))
else:
    wake_total = wake_delta.get("+Inf", 0.0)
    wake_within = wake_delta.get(str(int(budget)), wake_delta.get(str(budget), 0.0))
    wake_dist = " ".join(
        f"le{le}={wake_delta[le]:.0f}" for le in sorted(wake_delta, key=le_key)
    )
    if wake_total < 1:
        verdicts.append(("A2-wake-urgent-hard-gate", False,
                         "no completed urgent queue sample in the supported wake window"))
    elif wake_within != wake_total:
        verdicts.append(("A2-wake-urgent-hard-gate", False,
                         f"{wake_total - wake_within:.0f} of {wake_total:.0f} urgent sample(s) exceeded "
                         f"{budget:.0f}s in the supported wake window ({wake_dist})"))
    else:
        verdicts.append(("A2-wake-urgent-hard-gate", True,
                         f"all {wake_total:.0f} urgent sample(s) <= {budget:.0f}s in the supported "
                         f"same-pod wake window ({wake_dist})"))

# ── A2b: urgent queue-wait p95 across direct-watch window D-C1 ────────
window_note = "window: replacement-pod direct-watch probe delta (D-C1) after LIST→WATCH recovery"
pre = buckets(c1, qm, {"lane": "urgent"})
post = buckets(d, qm, {"lane": "urgent"})
combined = defaultdict(float)
reset = False
for le in set(pre) | set(post):
    delta = post.get(le, 0.0) - pre.get(le, 0.0)
    if delta < 0:
        reset = True
    combined[le] = delta
if reset:
    verdicts.append(("A2-direct-watch-urgent-p95", False,
                     "negative bucket delta between scrapes C1 and D (unexpected counter reset)"))
else:
    total = combined.get("+Inf", 0.0)
    min_samples = float(os.environ["MIN_URGENT_SAMPLES"])
    if total < min_samples:
        verdicts.append(("A2-direct-watch-urgent-p95", False,
                         f"only {total:.0f} direct-watch urgent samples (need >= {min_samples:.0f} — "
                         "the urgent probe did not exercise its declared lane)"))
    else:
        p95_ub = None
        for le in sorted(combined, key=le_key):
            if total > 0 and combined[le] / total >= 0.95:
                p95_ub = le
                break
        dist = " ".join(f"le{le}={combined[le]:.0f}" for le in sorted(combined, key=le_key))
        if p95_ub is not None and le_key(p95_ub) <= budget:
            verdicts.append(("A2-direct-watch-urgent-p95", True,
                             f"p95 <= {p95_ub}s over {total:.0f} samples (budget {budget:.0f}s; {dist}; {window_note})"))
        else:
            verdicts.append(("A2-direct-watch-urgent-p95", False,
                             f"p95 bucket upper bound {p95_ub} exceeds {budget:.0f}s over {total:.0f} samples ({dist}; {window_note})"))

# ── A4: watch recovery <= budget on the replacement pod (C1) ──────────
wm = os.environ["WATCH_RECOVERY_METRIC"]
rbudget = os.environ["RECOVERY_BUDGET_S"]
succ = buckets(c1, wm, {"phase": "total", "outcome": "success"})
failed_total = buckets(c1, wm, {"phase": "total", "outcome": "failure"}).get("+Inf", 0.0)
succ_total = succ.get("+Inf", 0.0)
within = succ.get(rbudget, 0.0)
if failed_total > 0:
    verdicts.append(("A4-watch-recovery", False,
                     f"{failed_total:.0f} failed recovery attempt(s) on the replacement pod"))
elif succ_total < 1:
    verdicts.append(("A4-watch-recovery", False,
                     "no successful LIST->WATCH recovery sample on the replacement pod"))
elif within != succ_total:
    verdicts.append(("A4-watch-recovery", False,
                     f"{succ_total - within:.0f} of {succ_total:.0f} recovery sample(s) exceeded {rbudget}s"))
else:
    bound = next((le for le in sorted(succ, key=le_key) if succ[le] == succ_total), "+Inf")
    verdicts.append(("A4-watch-recovery", True,
                     f"{succ_total:.0f} recovery sample(s), all <= {bound}s (budget {rbudget}s)"))

# ── A7: recovered fleet convergence remains bounded (settled C2) ─────
fm = os.environ["FLEET_METRIC"]
pre_failed = counter(b, fm, "result", "failed") - counter(a, fm, "result", "failed")
post_started = counter(c2, fm, "result", "started")
post_coalesced = counter(c2, fm, "result", "coalesced")
post_trailing = counter(c2, fm, "result", "trailing")
post_failed = counter(c2, fm, "result", "failed")
problems = []
if pre_failed > 0 or post_failed > 0:
    problems.append(f"fleet pass failures (pre={pre_failed:.0f} post={post_failed:.0f})")
if post_started != 1:
    problems.append(f"expected exactly one recovery fleet pass on the replacement pod, got started={post_started:.0f}")
if post_trailing > post_coalesced:
    problems.append(f"trailing={post_trailing:.0f} > coalesced={post_coalesced:.0f} (violates the single-pending-slot structure)")
detail = (f"started={post_started:.0f} coalesced={post_coalesced:.0f} "
          f"trailing={post_trailing:.0f} failed={post_failed:.0f} (pre-kill failed delta={pre_failed:.0f})")
if problems:
    verdicts.append(("A7-fleet-recovery-bounded", False, "; ".join(problems) + f" [{detail}]"))
else:
    verdicts.append(("A7-fleet-recovery-bounded", True, detail))

# ── A6: delete-cleanup counters consistent (settled window C2) ────────
dm = os.environ["DELETE_CLEANUP_METRIC"]
if dm not in c2_types:
    verdicts.append(("A6-delete-cleanup-counters", False,
                     f"{dm} not registered on the running image — is the branch HCC image deployed?"))
else:
    queued = counter(c2, dm, "outcome", "queued")
    confirmed = counter(c2, dm, "outcome", "confirmed")
    completed = counter(c2, dm, "outcome", "completed")
    retried = counter(c2, dm, "outcome", "retried")
    superseded = counter(c2, dm, "outcome", "superseded")
    detail = (f"queued={queued:.0f} confirmed={confirmed:.0f} completed={completed:.0f} "
              f"retried={retried:.0f} superseded={superseded:.0f}")
    if retried == 0 and superseded == 0 and queued == confirmed == completed:
        note = "" if queued > 0 else " (all-zero: deletes handled by the direct watch-DELETE path; A5 proved cleanup)"
        verdicts.append(("A6-delete-cleanup-counters", True, detail + note))
    else:
        verdicts.append(("A6-delete-cleanup-counters", False,
                         f"inconsistent outcomes — lost or failed delete cleanup [{detail}]"))

for name, passed, detail in verdicts:
    print(f"VERDICT|{name}|{'PASS' if passed else 'FAIL'}|{detail}")
PY
then
  fail "metric adjudication crashed (could not parse the §14.1 scrapes) — see ${WORK_DIR}"
  print_results; exit 1
fi

VERDICT_COUNT=0
while IFS='|' read -r tag name verdict detail; do
  [[ "$tag" == 'VERDICT' ]] || continue
  VERDICT_COUNT=$((VERDICT_COUNT + 1))
  if [[ "$verdict" == 'PASS' ]]; then
    ok "${name}: ${detail}"
  else
    fail "${name}: ${detail}"
  fi
done <"$METRIC_VERDICTS"
if [[ "$VERDICT_COUNT" -ne 5 ]]; then
  fail "metric adjudication emitted ${VERDICT_COUNT}/5 verdicts — truncated output is a failure, not a pass"
fi

# ======================================================================
# Teardown — delete ONLY this run's fixtures; fail-loud leftover check.
# The profile and seeded data (including the wake target) stay.
# ======================================================================
header "Teardown — storm fixtures (${FIXTURE_RUN_KEY}=${RUN_ID})"
if [[ "${KEEP_FIXTURES:-}" == '1' ]]; then
  warn "KEEP_FIXTURES=1 — leaving fixtures in place for diagnosis (run-id ${RUN_ID})"
  TEARDOWN_DONE=1
else
  STORM_SEL="${FIXTURE_LABEL_KEY}=${FIXTURE_LABEL_VAL},${FIXTURE_RUN_KEY}=${RUN_ID}"
  kctl -n "$MCP_HOST_NS" delete host -l "$STORM_SEL" --wait=false >/dev/null 2>&1 || \
    warn "teardown: label-selector Host deletion returned nonzero (leftover check below is authoritative)"
  kctl -n "$MCP_HOST_NS" delete secret -l "$STORM_SEL" --wait=false >/dev/null 2>&1 || \
    warn "teardown: label-selector Secret deletion returned nonzero (leftover check below is authoritative)"

  # FAIL-CLOSED (B2): a kubectl list failure must never read as "all
  # gone" — the probe fails (with the error on stderr) until the API
  # positively returns an empty list, and the bounded deadline then FAILS.
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _storm_hosts_gone_probe() {
    local out
    if ! out="$(kctl -n "$MCP_HOST_NS" get host -l "$STORM_SEL" -o name 2>"${WORK_DIR}/hosts-gone.err")"; then
      echo "_storm_hosts_gone_probe: kubectl list FAILED: $(cat "${WORK_DIR}/hosts-gone.err" 2>/dev/null)" >&2
      return 1
    fi
    [[ -z "$out" ]]
  }
  if wait_until "$STORM_TEARDOWN_DEADLINE_S" 3 "storm fixture Hosts (${STORM_SEL}) deletion" \
    _storm_hosts_gone_probe storm_diagnostics; then
    ok "teardown: all storm fixture Hosts deleted via the supported CR path"
  else
    fail "teardown: storm fixture Hosts still present after ${STORM_TEARDOWN_DEADLINE_S}s (run-id ${RUN_ID})"
  fi

  # FAIL-CLOSED (B2): an unverifiable read counts as a leftover — the teardown
  # check may only pass on positive evidence of absence. Convergence-aware: a
  # leftover with a deletionTimestamp is CONVERGING (its delete WAS issued; a
  # finalizer like a workspace PVC's kubernetes.io/pvc-protection is draining for
  # the deleting pod's grace) — allow it a bounded extension. A leftover with NO
  # deletionTimestamp means the delete was NEVER issued (a real cleanup gap) —
  # fail immediately, no wait. An unverifiable read is fail-closed.
  TEARDOWN_LEFTOVER=0
  teardown_converge_deadline=$((SECONDS + STORM_TEARDOWN_CONVERGE_S))
  while :; do
    TEARDOWN_LEFTOVER=0; teardown_orphan=0; teardown_unverifiable=0; teardown_report=''
    for h in "${STORM_CREATED_HOSTS[@]}" "${STORM_URGENT_PROBE_HOSTS[@]}" "${STORM_DELETE_HOSTS[@]}"; do
      if ! leftovers="$(collect_children "$h")"; then
        teardown_report+="  ${h}: kubectl read FAILED (unverifiable, fail-closed)"$'\n'
        TEARDOWN_LEFTOVER=$((TEARDOWN_LEFTOVER + 1)); teardown_unverifiable=1
        continue
      fi
      if [[ -z "$leftovers" ]]; then
        continue
      fi
      while IFS= read -r res; do
        if [[ -z "$res" ]]; then
          continue
        fi
        r_ns="${res%%/*}"; r_kn="${res#*/}"
        if dts="$(kctl -n "$r_ns" get "$r_kn" -o jsonpath='{.metadata.deletionTimestamp}' 2>/dev/null)"; then
          if [[ -n "$dts" ]]; then
            teardown_report+="  ${res} — Terminating since ${dts} (converging)"$'\n'
            TEARDOWN_LEFTOVER=$((TEARDOWN_LEFTOVER + 1))
          else
            teardown_report+="  ${res} — NO deletionTimestamp (delete never issued — REAL cleanup gap)"$'\n'
            TEARDOWN_LEFTOVER=$((TEARDOWN_LEFTOVER + 1)); teardown_orphan=1
          fi
        fi
        # get failed (NotFound between collect and read) => converged; not a leftover
      done <<< "$leftovers"
    done
    if [[ "$TEARDOWN_LEFTOVER" -eq 0 ]]; then
      break
    fi
    # A never-issued delete or an unverifiable read is a hard finding — do not wait.
    if [[ "$teardown_orphan" -eq 1 || "$teardown_unverifiable" -eq 1 ]]; then
      break
    fi
    if [[ "$SECONDS" -ge "$teardown_converge_deadline" ]]; then
      break
    fi
    sleep 3
  done
  if [[ "$TEARDOWN_LEFTOVER" -gt 0 ]]; then
    warn "teardown: ownership-labeled leftovers after up to ${STORM_TEARDOWN_CONVERGE_S}s convergence extension:"
    printf '%s' "$teardown_report" >&2
  fi
  if ! sec_out="$(kctl -n "$MCP_HOST_NS" get secret -l "$STORM_SEL" -o name 2>"${WORK_DIR}/secret-gone.err")"; then
    warn "teardown: could not verify fixture Secret deletion: $(cat "${WORK_DIR}/secret-gone.err" 2>/dev/null) — counting as leftover"
    TEARDOWN_LEFTOVER=$((TEARDOWN_LEFTOVER + 1))
  elif [[ -n "$sec_out" ]]; then
    warn "teardown: fixture Secret still present (${STORM_SEL})"
    TEARDOWN_LEFTOVER=$((TEARDOWN_LEFTOVER + 1))
  fi
  if [[ "$TEARDOWN_LEFTOVER" -eq 0 ]]; then
    ok "teardown: zero storm-fixture leftovers across ${BUNDLE_NAMESPACES} (profile and seeded data untouched)"
  else
    fail "teardown: ${TEARDOWN_LEFTOVER} storm fixture subject(s) left resources behind (run-id ${RUN_ID}) — investigate before trusting results"
  fi
  TEARDOWN_DONE=1
fi

# M3: on the success path a failed cadence restore must FAIL the gate
# (restore_hcc_env_strict registers fail() and leaves HCC_ENV_SAVED for
# the trap's best-effort retry); the EXIT trap keeps the lenient restore.
restore_hcc_env_strict

print_results
if [[ "$g_fail" -gt 0 ]]; then
  exit 1
fi
exit 0
