#!/usr/bin/env bash
# ======================================================================
# Addendum 1 — Host-bundle reconciliation measurement (Issue #791)
# ======================================================================
#
# One invocation = ONE measured run for a single HCC image. Before/after
# comparison (baseline = origin/dev HCC image, fixed = branch HCC image) is
# produced by invoking this script twice under the two images, orchestrated
# EXTERNALLY (the T2 runner swaps the HCC image between invocations); this
# script never switches images itself.
#
# Binding plan:
#   .ralph/plans/2026-07-22-issue-791-hcc-priority-reconciliation-wake-plan.md
#     §1.2  chronology report format (Subject | created | first child |
#           Pod Ready | admission/bundle wait | per-child | interpretation)
#     §14.1 metric series scraped in phase 4
#     §14.2 measurement clocks (start/end points are BINDING; no substitution)
#     §17.3 T2 preconditions
#     Addendum 1 bundle-wide measurement mandate (ALL services this PR
#           touches: mcp-host bundle + channel-reader bundle + wake +
#           independent admission + non-regression side-clock)
#     Addendum 4.7 delete-while-pass-active runtime evidence (#827):
#           CR deletion issued while a full fleet pass is demonstrably
#           active must converge to exactly-one complete cleanup with no
#           resurrection (see the delete-during-pass step)
#
# House style: mirrors scripts/e2e/e2e-lib.sh (kctl wrapper, log/ok/fail
# helpers, truncate_rfc1123) and scripts/e2e/stateless-cold-start-measure.sh
# (python3 for RFC3339->epoch math, JSON artifact + per-phase timing). It is
# intentionally self-contained (does not source e2e-lib.sh) so it stays a
# portable single-file measurement tool with a stricter local-profile context
# guard than the shared library's default allowlist.
#
# ----------------------------------------------------------------------
# INPUTS (environment; fail-loud if missing/invalid)
#   CONTEXT     kubectl context. REFUSED unless it matches
#               ^clerum-(test|codex-|detached-|claude-) — a local minikube
#               profile. Any GKE / *prod* context is rejected outright.
#   RUN_LABEL   free label for this run (e.g. baseline | fixed). Sanitized
#               into fixture names and the output directory.
#   OUT_DIR     directory root for the report; results land in
#               OUT_DIR/<RUN_LABEL>-<UTC-timestamp>/
#
# OPTIONAL INPUTS
#   MEASURE_CONTEXT_REF   Context CR the fixture Hosts reference (default
#                         context1 — must already exist in the profile).
#   MEASURE_SECRET_REF    existing LLM Secret in mcp-host to reference. When
#                         unset the script creates a throwaway placeholder
#                         Secret (labeled with this run) and cleans it up.
#   MEASURE_MODEL_PROVIDER / MEASURE_MODEL_NAME  fixture model (default
#                         zai / glm-5.1, matching deploy/overlays/minikube).
#   READY_DEADLINE_S      per-Host Pod-Ready hard deadline (default 180).
#   MATERIALIZE_DEADLINE_S first-child materialization deadline (default 60).
#   HCC_METRICS_URL       pre-existing metrics URL; when set, scraped
#                         directly instead of starting a port-forward.
#   HCC_METRICS_LOCAL_PORT ephemeral port-forward local port (default 18081).
#   WAKE_HOST             (wake subcommand) hostRef of a stateless Host that
#                         the orchestrator has ALREADY suspended via
#                         scripts/e2e/e2e-stateless-suspend-wake.sh and then
#                         woken through the supported RPC/Desktop path.
#   WAKE_ACCEPT_MS        (wake subcommand, REQUIRED) epoch-ms the Control API
#                         accepted/incremented the wake generation — the
#                         authoritative §14.2 wake clock start. Per §14.2 the
#                         clerum.io/wake-requested annotation is a LOSSY
#                         projection and is NEVER used as the measurement
#                         source; this script records it as diagnostic only.
#   ADMISSION_BLOCKER_READY  (independent-admission subcommand) set to 1 to
#                         assert the orchestrator has engaged a deterministic
#                         HCC block/slow-pass. ADMISSION_BLOCKER describes it.
#   DELETE_DURING_PASS    set to 1 to run the Addendum 4.7
#                         delete-while-pass-active step inside `all`.
#                         Opt-in because it RESTARTS the HCC pod (a
#                         supported operational event) to force a
#                         demonstrable full fleet pass; existing callers
#                         are unaffected by default.
#   KEEP_FIXTURES         set to 1 to skip teardown (diagnosis).
#
# SUBCOMMANDS (default: all)
#   all                  bundle + independent-admission(if hook ready) +
#                        metrics + sideclock + delete-during-pass(if
#                        DELETE_DURING_PASS=1), then teardown.
#   bundle               phase 1 only (stateful control Host + stateless Host)
#   wake                 phase 2 only (orchestrator calls after suspend+wake)
#   independent-admission phase 3 only (needs ADMISSION_BLOCKER_READY=1)
#   metrics              phase 4 only (HCC §14.1 scrape)
#   sideclock            phase 5 only (Context/McpServer non-regression)
#   delete-during-pass   Addendum 4.7 step only (#827): delete a fixture
#                        Host WHILE a full fleet pass is demonstrably
#                        active (HCC restart -> 'initial Host
#                        reconciliation'); assert exactly-one complete
#                        cleanup + no resurrection. Restarts the HCC pod.
#   teardown             delete only this run's fixtures; fail-loud on leftover
#
# EXIT CODES
#   0  all requested measurements completed and gates passed
#   1  a measurement failed loud (infra unreachable, deadline expiry, leftover
#      fixtures, invalid input) — never masked
#   2  usage / precondition error
#
# ORCHESTRATOR RESPONSIBILITIES (what T2 must provide — see FINAL REPORT):
#   * swap the HCC image between the two invocations (baseline vs fixed);
#   * for `wake`: suspend + wake the stateless Host through the supported
#     path (owned by e2e-stateless-suspend-wake.sh) and pass WAKE_HOST +
#     WAKE_ACCEPT_MS;
#   * for `independent-admission`: engage a deterministic HCC block and set
#     ADMISSION_BLOCKER_READY=1;
#   * keep minikube/Docker/kubectl reachable with the branch profile context.
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

# Owned-child resource kinds enumerated for the bundle clock, and the
# namespaces the per-Host bundle spans.
readonly BUNDLE_KINDS='deployment service serviceaccount secret persistentvolumeclaim networkpolicy role rolebinding configmap'
readonly BUNDLE_NAMESPACES="${MCP_HOST_NS} ${CHANNELS_NS} ${RPC_PROXY_NS}"

# Fixture provenance labels. Every object this script creates carries BOTH so
# teardown deletes ONLY this run's fixtures.
readonly FIXTURE_LABEL_KEY='e2e-measure'
readonly FIXTURE_LABEL_VAL='791'
readonly FIXTURE_RUN_KEY='e2e-measure-run'

# §14.2 clocks (seconds) used for phase classification.
readonly SLO_MATERIALIZE_S=20   # Host creation -> Deployment creation
readonly SLO_READY_S=60         # Host creation -> Pod Ready (warm local gate)
readonly SLO_WAKE_S=45          # wake accepted -> Pod Ready

# Addendum 4.7 delete-while-pass-active budgets (each constant states its
# contract; expiry is a hard fail with diagnostics, never a silent skip).
readonly DELPASS_HCC_READY_DEADLINE_S=120     # replacement HCC pod Running after the restart
readonly DELPASS_PASS_ACTIVE_DEADLINE_S=60    # initial-pass START marker observed on the new pod
readonly DELPASS_PASS_COMPLETE_DEADLINE_S=180 # pass COMPLETED marker observed after the delete
readonly DELPASS_CLEANUP_DEADLINE_S=180       # deleted CR + owned bundle fully gone
readonly DELPASS_RESURRECTION_SETTLE_S=30     # quiet window before re-asserting nothing came back
# Bounded EXTENSION for owned children already Terminating (deletionTimestamp
# set) at the teardown leftover check — e.g. a workspace PVC whose
# kubernetes.io/pvc-protection finalizer drains for the deleting pod's
# termination grace. A child with NO deletionTimestamp never gets this
# extension (the delete was never issued → immediate fail).
readonly MEASURE_TEARDOWN_CONVERGE_S=120
# The startup marker is emitted immediately before the cold-start Host
# inventory/watch recovery. COMPLETE/FAIL below retain the precise
# 'initial Host reconciliation' reason supplied to the fleet pass.
readonly HCC_PASS_STARTED_MARKER='Starting initial Host background convergence'
readonly HCC_PASS_COMPLETED_MARKER='Completed Host reconciliation after initial Host reconciliation'
readonly HCC_PASS_FAILED_MARKER='Host reconciliation after initial Host reconciliation failed'

# ─── Colors (mirrors e2e-lib.sh) ──────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# ─── Counters ─────────────────────────────────────────────────────────
m_pass=0; m_fail=0; m_total=0

# ─── Logging helpers (mirrors e2e-lib.sh) ─────────────────────────────
log()    { echo -e "${CYAN}[MEASURE]${NC} $*"; }
ok()     { m_pass=$((m_pass+1)); m_total=$((m_total+1)); echo -e "${GREEN}  PASS${NC} — $*"; }
fail()   { m_fail=$((m_fail+1)); m_total=$((m_total+1)); echo -e "${RED}  FAIL${NC} — $*" >&2; }
warn()   { echo -e "${YELLOW}  WARN${NC} — $*" >&2; }
header() { echo -e "\n${BOLD}=== $* ===${NC}"; }
die()    { echo -e "${RED}[MEASURE] FATAL${NC} — ${1}" >&2; exit "${2:-1}"; }

print_results() {
  echo -e "\n${BOLD}=== Measurement summary (${RUN_LABEL:-?}) ===${NC}"
  echo -e "  ${GREEN}pass=${m_pass}${NC} ${RED}fail=${m_fail}${NC} total=${m_total}"
}

# ─── kubectl wrapper — EVERY call carries --context (CLAUDE.md mandate) ──
kctl() { kubectl --context "$CONTEXT" "$@"; }

# ─── Portable time helpers (python3; mirrors stateless-cold-start-measure.sh) ──
now_ms()       { python3 -c 'import time;print(int(time.time()*1000))'; }
now_rfc3339()  { python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))'; }
now_stamp()    { python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))'; }

# truncate_rfc1123 (mirrors e2e-lib.sh) — clamp to 63 chars, trim trailing sep.
truncate_rfc1123() { printf '%.63s' "$1" | sed -E 's/[^a-z0-9]+$//'; }

# sanitize_label — lowercase, replace non [a-z0-9-] with '-', clamp to n chars.
sanitize_label() {
  local raw="$1" max="${2:-15}"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' \
    | sed -E 's/^-+//; s/-+$//' | cut -c1-"$max" | sed -E 's/-+$//'
}

# ─── Strict local-profile context guard (fail-loud) ───────────────────
require_measure_context() {
  [[ -n "${CONTEXT:-}" ]] || die "CONTEXT is required (a local minikube profile context)." 2
  case "$CONTEXT" in
    *gke_*|*prod*)
      die "Refusing: CONTEXT='${CONTEXT}' looks like a GKE/production context. Local profiles only." 2 ;;
  esac
  if [[ ! "$CONTEXT" =~ ^clerum-(test|codex-|detached-|claude-) ]]; then
    die "Refusing: CONTEXT='${CONTEXT}' is not an allowed local profile. Must match ^clerum-(test|codex-|detached-|claude-)." 2
  fi
  # Prove the context is reachable before any mutation.
  if ! kctl get nodes -o name >/dev/null 2>&1; then
    die "CONTEXT='${CONTEXT}' is not reachable (kubectl get nodes failed). Start the profile and its port-forwards." 1
  fi
  log "context OK: ${CONTEXT} ($(kctl config current-context 2>/dev/null || echo '?') is the shell default)"
}

require_deps() {
  local missing=()
  for bin in kubectl jq python3 curl; do
    command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "missing required tools: ${missing[*]}" 2
}

# ─── Bounded wait helper: poll <fn> until it succeeds or <deadline_s>. On
# expiry it dumps <diag_fn> and returns 1 (never silently continues). ──────
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

# ─── Port-forward lifecycle (metrics scrape) ──────────────────────────
PF_PID=''
cleanup_portforward() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
  PF_PID=''
}
trap cleanup_portforward EXIT

# ======================================================================
# Fixture management
# ======================================================================
# Populated by init_run(): unique, RFC1123-safe host names for this run.
RUN_ID=''; RUN_SLUG=''; RUN_DIR=''
HOST_CONTROL=''; HOST_STATELESS=''; HOST_PROBE=''; HOST_DELPASS=''; FIXTURE_SECRET=''

init_run() {
  [[ -n "${RUN_LABEL:-}" ]] || die "RUN_LABEL is required (e.g. baseline | fixed)." 2
  [[ -n "${OUT_DIR:-}" ]]  || die "OUT_DIR is required." 2
  RUN_SLUG="$(sanitize_label "$RUN_LABEL" 15)"
  [[ -n "$RUN_SLUG" ]] || die "RUN_LABEL '${RUN_LABEL}' sanitized to empty; pick an alphanumeric label." 2
  # Run discriminator: epoch-ms tail + 3-digit random suffix. Full epoch-ms
  # would blow the 34-char host-name budget below; the random suffix removes
  # the 16.7-minute tail-collision window between runs instead.
  RUN_ID="$(now_ms)"; RUN_ID="${RUN_ID: -6}$(printf '%03d' $((RANDOM % 1000)))"
  RUN_DIR="${OUT_DIR%/}/${RUN_SLUG}-$(now_stamp)"
  mkdir -p "$RUN_DIR"
  # Fixture names — keep host name <=34 chars so
  # host-<name>-mcp-host-runtime-tokens (5+34+24) stays within the 63-char
  # RFC1123 limit.
  local base
  base="$(truncate_rfc1123 "m791-${RUN_SLUG}-${RUN_ID}")"
  HOST_CONTROL="$(truncate_rfc1123 "${base}-ctl")"
  HOST_STATELESS="$(truncate_rfc1123 "${base}-sl")"
  HOST_PROBE="$(truncate_rfc1123 "${base}-pr")"
  HOST_DELPASS="$(truncate_rfc1123 "${base}-dp")"
  FIXTURE_SECRET="$(truncate_rfc1123 "${base}-keys")"
  log "run dir: ${RUN_DIR}"
  log "fixtures: control=${HOST_CONTROL} stateless=${HOST_STATELESS} probe=${HOST_PROBE} delpass=${HOST_DELPASS} run-id=${RUN_ID}"
}

ensure_fixture_secret() {
  if [[ -n "${MEASURE_SECRET_REF:-}" ]]; then
    if ! kctl -n "$MCP_HOST_NS" get secret "$MEASURE_SECRET_REF" >/dev/null 2>&1; then
      die "MEASURE_SECRET_REF='${MEASURE_SECRET_REF}' not found in ${MCP_HOST_NS}." 2
    fi
    log "using existing Secret ${MEASURE_SECRET_REF} for fixture Hosts"
    return 0
  fi
  # Throwaway placeholder Secret. The mcp-host readiness probe is an HTTP
  # health endpoint that does not validate the LLM key (readiness never waits
  # for MCP), so a placeholder is sufficient to time bundle+Ready. This is
  # recorded as a caveat in the report.
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
  ZAI_API_KEY: "placeholder-e2e-measure-not-a-real-key"
  OPENAI_API_KEY: "placeholder-e2e-measure-not-a-real-key"
YAML
  MEASURE_SECRET_REF="$FIXTURE_SECRET"
  log "created placeholder Secret ${FIXTURE_SECRET} (readiness caveat recorded)"
}

# apply_host <name> <stateless:true|false>
apply_host() {
  local name="$1" stateless="$2"
  local ctxref="${MEASURE_CONTEXT_REF:-context1}"
  local provider="${MEASURE_MODEL_PROVIDER:-zai}"
  local model="${MEASURE_MODEL_NAME:-glm-5.1}"
  local lifecycle_block=''
  if [[ "$stateless" == "true" ]]; then
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
  contextRef: ${ctxref}
  secretRef: ${MEASURE_SECRET_REF}
  model:
    provider: ${provider}
    name: ${model}
${lifecycle_block}
YAML
  log "applied Host ${name} (stateless=${stateless}, contextRef=${ctxref})"
}

# ======================================================================
# Kubernetes snapshot helpers (feed python for delta math)
# ======================================================================
host_created(){ kctl -n "$MCP_HOST_NS" get host "$1" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || true; }

# Collect every owned child of <host> across the bundle namespaces into a
# single JSON array [{namespace,kind,name,creationTimestamp}]. Uses the
# authoritative HCC ownership selector (managed-by + host) — the same
# predicate HostReconciler.isHccOwnedHostResource uses — so nothing is missed.
#
# FAIL-CLOSED (mirrors e2e-host-storm-gate.sh collect_children): emits the
# JSON array on stdout and returns 0 only when EVERY kubectl read
# succeeded; any read failure prints the captured stderr and flips the
# return code to 2 ("verification impossible"). Every label-selector list
# of these standard kinds returns exit 0 with an empty item list when
# nothing matches, so a nonzero kubectl exit is a real read failure (API
# outage, RBAC, unknown kind) — callers MUST treat rc=2 as failure, never
# as "no children".
collect_children_json() {
  local host="$1" ns kind items rc=0
  local combined='[]'
  for ns in $BUNDLE_NAMESPACES; do
    for kind in $BUNDLE_KINDS; do
      if ! items="$(kctl -n "$ns" get "$kind" \
            -l "${OWNED_SELECTOR},${HOST_LABEL}=${host}" \
            -o json 2>"${RUN_DIR}/collect-children.err")"; then
        echo "collect_children_json: kubectl get ${kind} in ${ns} FAILED for host ${host}: $(cat "${RUN_DIR}/collect-children.err" 2>/dev/null)" >&2
        rc=2
        continue
      fi
      combined="$(NS="$ns" KIND="$kind" ITEMS="$items" ACC="$combined" python3 -c '
import os,json,sys
acc=json.loads(os.environ["ACC"])
try:
    lst=json.loads(os.environ["ITEMS"]).get("items",[])
except Exception:
    lst=[]
for it in lst:
    md=it.get("metadata",{})
    acc.append({
        "namespace": os.environ["NS"],
        "kind": os.environ["KIND"],
        "name": md.get("name"),
        "creationTimestamp": md.get("creationTimestamp"),
        # Additive: lets the teardown check distinguish a CONVERGING child
        # (delete issued, finalizer draining) from one never deleted.
        "deletionTimestamp": md.get("deletionTimestamp"),
    })
print(json.dumps(acc))
')"
    done
  done
  printf '%s' "$combined"
  return "$rc"
}

# FAIL-CLOSED absence check (mirrors e2e-host-storm-gate.sh): returns 0
# ONLY when the API positively answered NotFound for the Host. "Present"
# returns 1; any other kubectl failure (outage, RBAC, timeout) returns 2
# with the error on stderr — absence must never be inferred from an
# unreadable API. The match is anchored on the API-server reason
# '(NotFound)' or the kubectl trailing form naming EXACTLY the requested
# Host, so a kubeconfig-level `context "..." not found` error can never
# read as absence-confirmation.
host_absent_confirmed() {
  local h="$1" err
  if kctl -n "$MCP_HOST_NS" get host "$h" -o name >/dev/null 2>"${RUN_DIR}/host-absent.err"; then
    return 1
  fi
  err="$(cat "${RUN_DIR}/host-absent.err" 2>/dev/null || true)"
  if printf '%s' "$err" | grep -Eq "\(NotFound\)|\"${h}\" not found\$"; then
    return 0
  fi
  echo "host_absent_confirmed: kubectl get host ${h} FAILED without NotFound evidence: ${err}" >&2
  return 2
}

# Ready-condition + phase for the mcp-host Pod of <host> (podSelector app=<host>).
host_pod_json() { kctl -n "$MCP_HOST_NS" get pods -l "app=$1" -o json 2>/dev/null || echo '{"items":[]}'; }

# shellcheck disable=SC2329  # invoked indirectly via _ready_probe / wait_until
host_pod_ready() {
  local host="$1"
  kctl -n "$MCP_HOST_NS" get pods -l "app=${host}" \
    -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
    2>/dev/null | grep -qx 'True'
}

pod_diagnostics() {
  local host="${1:-}"
  {
    echo "----- diagnostics: Host ${host} -----"
    kctl -n "$MCP_HOST_NS" get host "$host" -o wide 2>&1 || true
    kctl -n "$MCP_HOST_NS" get pods -l "app=${host}" -o wide 2>&1 || true
    kctl -n "$MCP_HOST_NS" describe pods -l "app=${host}" 2>&1 | tail -40 || true
    echo "----- recent HCC logs -----"
    kctl -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=40 2>&1 || true
  } >&2
}

# ======================================================================
# PHASE 1 — New-Host bundle clock (stateful control + stateless)
# ======================================================================
# Emit the per-host bundle record: children deltas vs Host creation, max
# (bundle-complete), Pod Ready delta, SLO classification (§14.2). Reads live
# cluster state so it is accurate even when readiness timed out.
_emit_bundle_record() {
  local host="$1" klass="$2" host_created="$3" note="$4"
  local children pod_json rec="${RUN_DIR}/bundle-${host}.json"
  # FAIL-CLOSED: a partial child enumeration would make the bundle record
  # silently under-report — refuse to emit it instead.
  if ! children="$(collect_children_json "$host")"; then
    fail "bundle[${host}]: could not enumerate owned children (kubectl read failed) — refusing to emit a partial record"
    return 1
  fi
  pod_json="$(host_pod_json "$host")"
  HOST="$host" KLASS="$klass" HOST_CREATED="$host_created" CHILDREN="$children" \
  POD_JSON="$pod_json" NOTE="$note" \
  SLO_MAT="$SLO_MATERIALIZE_S" SLO_RDY="$SLO_READY_S" REC="$rec" \
  python3 <<'PY'
import os,json,sys,datetime

def ms(v):
    if not v: return None
    try:
        return int(datetime.datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()*1000)
    except Exception:
        return None

host=os.environ["HOST"]; klass=os.environ["KLASS"]
host_ms=ms(os.environ["HOST_CREATED"])
children=json.loads(os.environ["CHILDREN"])
pod=json.loads(os.environ["POD_JSON"]).get("items",[])
slo_mat=int(os.environ["SLO_MAT"]); slo_rdy=int(os.environ["SLO_RDY"])

rows=[]
for c in children:
    cms=ms(c.get("creationTimestamp"))
    delta=None if (cms is None or host_ms is None) else round((cms-host_ms)/1000.0,3)
    rows.append({"namespace":c["namespace"],"kind":c["kind"],"name":c["name"],
                 "creationTimestamp":c.get("creationTimestamp"),"delta_s":delta})

deltas=[r["delta_s"] for r in rows if r["delta_s"] is not None]
first_child=min(deltas) if deltas else None
bundle_complete=max(deltas) if deltas else None   # max child delta = bundle done

# Deployment materialization delta (§14.2 New Host materialization clock).
dep=[r for r in rows if r["kind"]=="deployment" and r["name"]==host]
deploy_delta=dep[0]["delta_s"] if dep else (min([r["delta_s"] for r in rows if r["kind"]=="deployment" and r["delta_s"] is not None], default=None))

# Pod Ready delta from Host creation (§14.2 New Host Ready clock).
ready_ms=None; started_ms=None; scheduled_ms=None
for p in pod:
    for cond in p.get("status",{}).get("conditions",[]):
        if cond.get("type")=="Ready" and cond.get("status")=="True":
            ready_ms=ms(cond.get("lastTransitionTime"))
        if cond.get("type")=="PodScheduled":
            scheduled_ms=ms(cond.get("lastTransitionTime"))
    for cs in p.get("status",{}).get("containerStatuses",[]):
        st=cs.get("state",{}).get("running",{}).get("startedAt")
        if st: started_ms=ms(st)
ready_delta=None if (ready_ms is None or host_ms is None) else round((ready_ms-host_ms)/1000.0,3)

def classify(v,budget):
    if v is None: return "unmeasured"
    return "within" if v<=budget else "OVER_BUDGET"

record={
  "subject":host,"class":klass,"note":os.environ["NOTE"],
  "host_creationTimestamp":os.environ["HOST_CREATED"],
  "children":rows,"child_count":len(rows),
  "first_child_delta_s":first_child,
  "bundle_complete_delta_s":bundle_complete,
  "deploy_materialization_delta_s":deploy_delta,
  "pod_ready_delta_s":ready_delta,
  "clocks":{
    "new_host_materialization":{"value_s":deploy_delta,"budget_s":slo_mat,"class":classify(deploy_delta,slo_mat)},
    "new_host_ready":{"value_s":ready_delta,"budget_s":slo_rdy,"class":classify(ready_delta,slo_rdy)},
  },
}
with open(os.environ["REC"],"w") as f:
    json.dump(record,f,indent=2)

# §1.2-style one-line chronology row for the aggregate markdown table.
def fmt(v): return "-" if v is None else f"{v:.1f}s"
print("| `{subj}` | {klass} | {created} | first-child {fc} | Pod Ready {rd} | bundle-complete {bc} | dep {dep} ({depc}) | {n} owned children |".format(
    subj=host, klass=klass, created=os.environ["HOST_CREATED"],
    fc=fmt(first_child), rd=fmt(ready_delta), bc=fmt(bundle_complete),
    dep=fmt(deploy_delta), depc=record["clocks"]["new_host_materialization"]["class"], n=len(rows)))
PY
}

# Closure probes for wait_until (zero-arg, invoked by name). __cur_host is set
# before use. shellcheck cannot trace name-based invocation, hence SC2329.
# shellcheck disable=SC2329
_ready_probe() { host_pod_ready "$__cur_host"; }
# Lightweight first-materialization probe: one kubectl call across the earliest
# owned kinds in the Host namespace (SA/Deployment/Service/Secret/NP) rather
# than the full cross-namespace sweep, so the poll stays cheap.
# shellcheck disable=SC2329
_first_child_probe() {
  kctl -n "$MCP_HOST_NS" get serviceaccount,deployment,service,secret,networkpolicy \
    -l "${OWNED_SELECTOR},${HOST_LABEL}=${__cur_host}" -o name 2>/dev/null | grep -q .
}
# shellcheck disable=SC2329
_diag_probe() { pod_diagnostics "$__cur_host"; }

# measure_bundle_for <host> <class> — apply-independent: waits for the bundle to
# materialize and the Pod to become Ready (both bounded, diagnostics on expiry),
# then appends a §1.2 chronology row to bundle-rows.md and writes a per-host
# JSON record. Fails loud on materialization or readiness deadline expiry.
measure_bundle_for() {
  local host="$1" klass="$2"
  local materialize_deadline="${MATERIALIZE_DEADLINE_S:-60}"
  local ready_deadline="${READY_DEADLINE_S:-180}"
  __cur_host="$host"

  local host_created; host_created="$(host_created "$host")"
  [[ -n "$host_created" ]] || { fail "bundle[${host}]: Host has no creationTimestamp"; return 1; }

  if ! wait_until "$materialize_deadline" 2 "first owned child of ${host}" _first_child_probe _diag_probe; then
    fail "bundle[${host}]: no owned child materialized within ${materialize_deadline}s"
    _emit_bundle_record "$host" "$klass" "$host_created" "readiness=false phase=materialization_timeout" >>"${RUN_DIR}/bundle-rows.md" || \
      warn "bundle[${host}]: record emission failed on the materialization-timeout path (failure already counted)"
    return 1
  fi

  local ready_ok='true'
  if ! wait_until "$ready_deadline" 3 "Pod Ready for ${host}" _ready_probe _diag_probe; then
    ready_ok='false'
  fi

  if ! _emit_bundle_record "$host" "$klass" "$host_created" "readiness=${ready_ok}" >>"${RUN_DIR}/bundle-rows.md"; then
    return 1
  fi
  if [[ "$ready_ok" == 'true' ]]; then
    ok "bundle[${host}]: Pod Ready; bundle materialized (${klass})"
    return 0
  fi
  fail "bundle[${host}]: Pod not Ready within ${ready_deadline}s (${klass})"
  return 1
}

phase_bundle() {
  header "PHASE 1 — new-Host bundle clock (stateful control + stateless)"
  ensure_fixture_secret
  : >"${RUN_DIR}/bundle-rows.md"
  local rc=0
  apply_host "$HOST_CONTROL"  false
  apply_host "$HOST_STATELESS" true
  measure_bundle_for "$HOST_CONTROL"  stateful  || rc=1
  measure_bundle_for "$HOST_STATELESS" stateless || rc=1
  return "$rc"
}

# ======================================================================
# PHASE 2 — Wake clock (measurement only; suspend+wake owned externally)
# ======================================================================
# The caller (T2 orchestrator) suspends and wakes WAKE_HOST through the
# supported RPC/Desktop path (e2e-stateless-suspend-wake.sh) and passes:
#   WAKE_HOST       hostRef of the suspended stateless Host
#   WAKE_ACCEPT_MS  epoch-ms Control API accepted/incremented the wake
#                   generation (authoritative §14.2 clock start; the atomic
#                   host_wake_generations row / Control API response time —
#                   NOT the clerum.io/wake-requested annotation).
# It measures: replicas patch time (managedFields + observe loop) and Pod
# Ready. Fails loud if preconditions are absent.
phase_wake() {
  header "PHASE 2 — wake clock (accepted wake -> Pod Ready)"
  local host="${WAKE_HOST:-}"
  [[ -n "$host" ]] || die "wake: WAKE_HOST is required (the stateless Host the orchestrator suspended+woke)." 2
  [[ -n "${WAKE_ACCEPT_MS:-}" ]] || die "wake: WAKE_ACCEPT_MS is required — the authoritative §14.2 wake-accept epoch-ms. The clerum.io/wake-requested annotation is a lossy projection and is never the measurement source." 2
  if ! [[ "$WAKE_ACCEPT_MS" =~ ^[0-9]+$ ]]; then
    die "wake: WAKE_ACCEPT_MS='${WAKE_ACCEPT_MS}' is not an epoch-ms integer." 2
  fi
  if ! kctl -n "$MCP_HOST_NS" get host "$host" >/dev/null 2>&1; then
    die "wake: Host '${host}' not found in ${MCP_HOST_NS}." 1
  fi

  __cur_host="$host"
  local ready_deadline="${READY_DEADLINE_S:-180}"

  # Observe the Deployment 0->>=1 replicas transition (wall-clock) with a
  # bounded deadline; the managedFields time is the authoritative K8s-side
  # patch clock and is read after the transition is observed.
  local observe_ms=''
  _replicas_up_probe() {
    local reps; reps="$(kctl -n "$MCP_HOST_NS" get deploy "$host" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
    [[ "${reps:-0}" -ge 1 ]]
  }
  if _replicas_up_probe; then
    observe_ms="$(now_ms)"
  elif wait_until "$ready_deadline" 2 "Deployment ${host} replicas>=1" _replicas_up_probe _diag_probe; then
    observe_ms="$(now_ms)"
  else
    fail "wake[${host}]: Deployment never scaled to >=1 within ${ready_deadline}s"
    pod_diagnostics "$host"
    return 1
  fi

  # Wait for Pod Ready (bounded).
  local ready_ok='true'
  if ! wait_until "$ready_deadline" 3 "Pod Ready for ${host}" _ready_probe _diag_probe; then
    ready_ok='false'
  fi

  local dep_json pod_json
  dep_json="$(kctl -n "$MCP_HOST_NS" get deploy "$host" -o json)"
  pod_json="$(host_pod_json "$host")"

  HOST="$host" ACCEPT_MS="$WAKE_ACCEPT_MS" OBSERVE_MS="$observe_ms" \
  DEP_JSON="$dep_json" POD_JSON="$pod_json" SLO_WAKE="$SLO_WAKE_S" \
  REC="${RUN_DIR}/wake-${host}.json" \
  ANNOTATION="$(kctl -n "$MCP_HOST_NS" get host "$host" -o jsonpath='{.metadata.annotations.clerum\.io/wake-requested}' 2>/dev/null || true)" \
  python3 >>"${RUN_DIR}/wake-rows.md" <<'PY'
import os,json,datetime
def ms(v):
    if not v: return None
    try: return int(datetime.datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()*1000)
    except Exception: return None
host=os.environ["HOST"]; accept=int(os.environ["ACCEPT_MS"])
observe=os.environ.get("OBSERVE_MS") or ""
observe=int(observe) if observe.isdigit() else None
dep=json.loads(os.environ["DEP_JSON"]); pod=json.loads(os.environ["POD_JSON"]).get("items",[])
slo=int(os.environ["SLO_WAKE"])

# Authoritative K8s-side replicas patch time from managedFields: latest
# managedFields entry that touched spec.replicas / the scale subresource.
patch_ms=None
for mf in dep.get("metadata",{}).get("managedFields",[]):
    fields=json.dumps(mf.get("fieldsV1",{}))
    if '"f:replicas"' in fields or mf.get("subresource")=="scale":
        t=ms(mf.get("time"))
        if t is not None and (patch_ms is None or t>patch_ms): patch_ms=t

ready_ms=None
for p in pod:
    for c in p.get("status",{}).get("conditions",[]):
        if c.get("type")=="Ready" and c.get("status")=="True":
            ready_ms=ms(c.get("lastTransitionTime"))

def d(a,b): return None if (a is None or b is None) else round((b-a)/1000.0,3)
patch_delta=d(accept, patch_ms if patch_ms is not None else observe)
wake_to_ready=d(accept, ready_ms)

rec={
 "subject":host,
 "wake_accept_ms":accept,
 "replicas_patch_ms_managedFields":patch_ms,
 "replicas_up_observed_ms":observe,
 "pod_ready_ms":ready_ms,
 "accept_to_replicas_patch_s":patch_delta,
 "accept_to_pod_ready_s":wake_to_ready,
 "wake_to_ready_clock":{"value_s":wake_to_ready,"budget_s":slo,
   "class":("unmeasured" if wake_to_ready is None else ("within" if wake_to_ready<=slo else "OVER_BUDGET"))},
 "diagnostics_only__wake_requested_annotation":os.environ.get("ANNOTATION") or None,
 "note":"annotation is a lossy projection (§14.2) — recorded for diagnosis, NOT used as the clock source",
}
with open(os.environ["REC"],"w") as f: json.dump(rec,f,indent=2)
def fmt(v): return "-" if v is None else f"{v:.1f}s"
print("| `{h}` | wake | accept+{p} (replicas patch) | Pod Ready accept+{r} | budget {b}s | {c} |".format(
    h=host, p=fmt(patch_delta), r=fmt(wake_to_ready), b=slo, c=rec["wake_to_ready_clock"]["class"]))
PY

  if [[ "$ready_ok" == 'true' ]]; then
    ok "wake[${host}]: Pod Ready after accepted wake"
    return 0
  fi
  fail "wake[${host}]: Pod not Ready within ${ready_deadline}s after accepted wake"
  return 1
}

# ======================================================================
# PHASE 3 — Independent-admission probe (admission under load)
# ======================================================================
# Requires the orchestrator to have engaged a deterministic HCC block/slow
# pass, asserted via ADMISSION_BLOCKER_READY=1 (ADMISSION_BLOCKER describes
# it). Creates a second Host and records its bundle clock while blocked —
# proving a new Host is admitted while another Host / full pass is stalled.
phase_independent_admission() {
  header "PHASE 3 — independent-admission probe (bundle clock while HCC blocked)"
  if [[ "${ADMISSION_BLOCKER_READY:-}" != '1' ]]; then
    die "independent-admission: ADMISSION_BLOCKER_READY=1 is required. The orchestrator MUST engage a deterministic HCC block/slow-pass (e.g. a Host whose reconcile is deterministically stalled, or a fleet pass in flight) and describe it in ADMISSION_BLOCKER before this phase runs. Refusing to fabricate an admission-under-load result without the block." 2
  fi
  log "admission blocker asserted: ${ADMISSION_BLOCKER:-<unspecified — set ADMISSION_BLOCKER to describe it>}"
  ensure_fixture_secret
  : >>"${RUN_DIR}/bundle-rows.md"
  apply_host "$HOST_PROBE" false
  if measure_bundle_for "$HOST_PROBE" stateful-probe; then
    ok "independent-admission: probe Host admitted + bundle materialized while blocked"
    return 0
  fi
  fail "independent-admission: probe Host did not materialize/ready while blocked (HOL regression?)"
  return 1
}

# ======================================================================
# PHASE 4 — HCC §14.1 metrics scrape
# ======================================================================
phase_metrics() {
  header "PHASE 4 — HCC metrics scrape (§14.1 series)"
  local raw="${RUN_DIR}/hcc-metrics.raw.prom"
  local url="${HCC_METRICS_URL:-}"

  if [[ -n "$url" ]]; then
    log "scraping provided HCC_METRICS_URL=${url}"
    if ! curl -fsS --max-time 15 "$url" -o "$raw"; then
      fail "metrics: HCC_METRICS_URL unreachable: ${url}"
      return 1
    fi
  else
    local lport="${HCC_METRICS_LOCAL_PORT:-18081}"
    log "starting ephemeral port-forward deploy/${HCC_DEPLOY} ${lport}:${HCC_PORT} in ${CONTROL_NS}"
    kctl -n "$CONTROL_NS" port-forward "deploy/${HCC_DEPLOY}" "${lport}:${HCC_PORT}" >"${RUN_DIR}/pf.log" 2>&1 &
    PF_PID=$!
    url="http://127.0.0.1:${lport}${HCC_METRICS_PATH}"
    # Bounded wait for the forward to answer.
    # shellcheck disable=SC2329  # invoked by name via wait_until
    _pf_probe() { curl -fsS --max-time 3 "$url" -o "$raw" 2>/dev/null; }
    # shellcheck disable=SC2329  # invoked by name via wait_until
    _pf_diag()  { { echo '----- port-forward log -----'; cat "${RUN_DIR}/pf.log" 2>/dev/null; } >&2; }
    if ! wait_until 30 2 "HCC metrics via port-forward" _pf_probe _pf_diag; then
      fail "metrics: HCC ${HCC_METRICS_PATH} not reachable via port-forward within 30s"
      cleanup_portforward
      return 1
    fi
    cleanup_portforward
  fi

  # Endpoint reachable => raw dump captured. Now extract the §14.1 series.
  # Absent NEW series is a RECORDED observation (expected on a baseline image
  # that predates the metrics), not a hard failure; unreachable endpoint above
  # IS a hard failure.
  RAW="$raw" REC="${RUN_DIR}/hcc-metrics.summary.json" python3 <<'PY'
import os,json,re
series=[
 "clerum_hcc_host_reconcile_queue_wait_seconds",
 "clerum_hcc_host_reconcile_duration_seconds",
 "clerum_hcc_host_reconcile_in_flight",
 "clerum_hcc_host_watch_recovery_seconds",
 "clerum_hcc_host_fleet_requests_total",
 "clerum_hcc_host_cleanup_deferred_total",
]
raw=open(os.environ["RAW"],encoding="utf-8",errors="replace").read().splitlines()
def parse(line):
    if not line or line.startswith("#"): return None
    m=re.match(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(.+)$',line)
    if not m: return None
    name,labels,val=m.group(1),(m.group(2) or ""),m.group(3).split()[0]
    try: v=float(val)
    except ValueError: v=None
    return name,labels,v
out={}
for s in series:
    out[s]={"present":False,"samples":[]}
for line in raw:
    p=parse(line)
    if not p: continue
    name,labels,v=p
    base=name
    for suf in ("_bucket","_sum","_count"):
        if name.endswith(suf): base=name[:-len(suf)]; break
    if base in out:
        out[base]["present"]=True
        # Skip individual histogram buckets in the summary; keep _sum/_count
        # and non-histogram samples so the summary stays compact.
        if name.endswith("_bucket"): continue
        out[base]["samples"].append({"metric":name,"labels":labels,"value":v})
summary={"series":out,
  "present":[s for s in series if out[s]["present"]],
  "absent":[s for s in series if not out[s]["present"]]}
with open(os.environ["REC"],"w") as f: json.dump(summary,f,indent=2)
print("§14.1 series present: "+(", ".join(summary["present"]) or "(none)"))
print("§14.1 series absent : "+(", ".join(summary["absent"]) or "(none)"))
PY

  local present absent
  present="$(jq -r '.present | length' "${RUN_DIR}/hcc-metrics.summary.json")"
  absent="$(jq -r '.absent  | length' "${RUN_DIR}/hcc-metrics.summary.json")"
  ok "metrics: HCC /metrics reachable; §14.1 present=${present} absent=${absent} (raw: ${raw})"
  if [[ "$absent" -gt 0 ]]; then
    warn "metrics: ${absent} §14.1 series absent — expected on a baseline image predating the metrics; a regression on the fixed image. Recorded in hcc-metrics.summary.json."
  fi
  return 0
}

# ======================================================================
# PHASE 5 — Non-regression side-clock (Context / McpServer)
# ======================================================================
# Honest scope: this measures WITHOUT mutating McpServers/Contexts. Creation
# is not triggered here, so it records the reconcile-touch surface (existing
# McpServer/Context objects + their HCC-managed resources) via resourceVersion
# and creationTimestamp, and states the limit explicitly. A true before/after
# for these flows is obtained by comparing this record across the two runs.
phase_sideclock() {
  header "PHASE 5 — non-regression side-clock (Context/McpServer, read-only)"
  local rec="${RUN_DIR}/sideclock.json"
  local mcp_json ctx_json np_json
  mcp_json="$(kctl -n "$MCP_HOST_NS" get mcpservers.clerum.io -o json 2>/dev/null || kctl get mcpservers.clerum.io -A -o json 2>/dev/null || echo '{"items":[]}')"
  ctx_json="$(kctl get contexts.clerum.io -A -o json 2>/dev/null || echo '{"items":[]}')"
  np_json="$(kctl -n "$MCP_HOST_NS" get networkpolicy -l "${OWNED_SELECTOR}" -o json 2>/dev/null || echo '{"items":[]}')"

  MCP_JSON="$mcp_json" CTX_JSON="$ctx_json" NP_JSON="$np_json" REC="$rec" \
  STAMP="$(now_rfc3339)" python3 <<'PY'
import os,json
def summarize(js,kind):
    items=json.loads(js).get("items",[])
    out=[]
    for it in items:
        md=it.get("metadata",{})
        out.append({"kind":kind,"namespace":md.get("namespace"),"name":md.get("name"),
                    "resourceVersion":md.get("resourceVersion"),
                    "creationTimestamp":md.get("creationTimestamp"),
                    "generation":md.get("generation")})
    return out
rec={
 "observed_at":os.environ["STAMP"],
 "limitation":"read-only snapshot: McpServers/Contexts are NOT mutated, so no creation clock is triggered here. Cross-run diff of resourceVersion/generation on these objects + their HCC-managed NetworkPolicies detects reconcile churn / material slowdown under the bounded fleet. Absolute per-object reconcile latency is not measurable without a controlled mutation, which this phase deliberately avoids.",
 "mcpservers":summarize(os.environ["MCP_JSON"],"McpServer"),
 "contexts":summarize(os.environ["CTX_JSON"],"Context"),
 "hcc_managed_networkpolicies_mcp_host":summarize(os.environ["NP_JSON"],"NetworkPolicy"),
}
with open(os.environ["REC"],"w") as f: json.dump(rec,f,indent=2)
print("side-clock: mcpservers={m} contexts={c} owned-NPs(mcp-host)={n}".format(
  m=len(rec["mcpservers"]), c=len(rec["contexts"]), n=len(rec["hcc_managed_networkpolicies_mcp_host"])))
PY
  ok "sideclock: recorded read-only Context/McpServer reconcile surface (see ${rec})"
  return 0
}

# ======================================================================
# STEP (Addendum 4.7) — delete-while-pass-active convergence (#827)
# ======================================================================
# Proves the #827 integration property: a Host CR deleted WHILE a full
# fleet pass is demonstrably active converges to exactly-one complete
# cleanup (CR gone + zero ownership-labeled leftovers across the bundle
# namespaces — the same predicate teardown uses) and is never resurrected
# by the in-flight pass or a stale queued reconcile.
#
# The full pass is triggered through a supported operational event:
# deleting the HCC pod. The replacement pod always runs the
# 'initial Host reconciliation' full pass on startup (k8sClient.ts), so
# the pass window is deterministic and log-anchored:
#   ACTIVE   = START marker present, COMPLETED marker absent
#   the delete is issued only inside that window; the COMPLETED marker is
#   then observed AFTER the delete.
# Overlap is proven with TWO belts, because the pass can complete inside
# the ~0.5-2s window between the active-probe read and the delete landing:
#   belt 1 — immediately after the delete succeeds, the logs are re-read
#            once and the step HARD-FAILS if COMPLETED is already present;
#   belt 2 — the COMPLETED line's own `kubectl logs --timestamps` stamp
#            must postdate the delete-issued epoch-ms in the final
#            adjudication.
# A pass that completes before the delete could be issued is a HARD FAIL
# ("overlap not established" — re-run), never silently accepted; a pass
# that FAILS is a hard fail with the controller logs.
phase_delete_during_pass() {
  header "STEP — delete-while-pass-active (#827, plan Addendum 4.7)"
  ensure_fixture_secret

  # 1. Fixture Host with a real bundle (deleting a bundle-less Host would
  # prove nothing about cleanup).
  apply_host "$HOST_DELPASS" false
  __cur_host="$HOST_DELPASS"
  local materialize_deadline="${MATERIALIZE_DEADLINE_S:-60}"
  if ! wait_until "$materialize_deadline" 2 "first owned child of ${HOST_DELPASS}" _first_child_probe _diag_probe; then
    fail "delete-during-pass: fixture bundle did not materialize within ${materialize_deadline}s"
    return 1
  fi
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_deploy_probe() { kctl -n "$MCP_HOST_NS" get deployment "$HOST_DELPASS" >/dev/null 2>&1; }
  if ! wait_until "$materialize_deadline" 2 "Deployment ${HOST_DELPASS}" _delpass_deploy_probe _diag_probe; then
    fail "delete-during-pass: fixture Deployment did not materialize within ${materialize_deadline}s"
    return 1
  fi
  log "fixture ${HOST_DELPASS} bundle materialized"

  # 2. Trigger the full fleet pass: restart HCC (supported operational
  # event; the replacement pod runs 'initial Host reconciliation').
  local old_pod
  old_pod="$(kctl -n "$CONTROL_NS" get pods -l "app=${HCC_DEPLOY}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$old_pod" ]]; then
    fail "delete-during-pass: no Running HCC pod to restart"
    return 1
  fi
  local t_restart_ms; t_restart_ms="$(now_ms)"
  if ! kctl -n "$CONTROL_NS" delete pod "$old_pod" --wait=false >/dev/null; then
    fail "delete-during-pass: could not delete HCC pod ${old_pod}"
    return 1
  fi
  log "HCC pod ${old_pod} deleted to force the full fleet pass"

  local new_pod=''
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_new_pod_probe() {
    local name
    name="$(kctl -n "$CONTROL_NS" get pods -l "app=${HCC_DEPLOY}" \
      --field-selector=status.phase=Running \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}' 2>/dev/null \
      | awk -F'\t' -v old="$old_pod" '$1 != "" && $1 != old && $2 == "" {print $1; exit}')"
    [[ -n "$name" ]] && new_pod="$name"
  }
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_hcc_diag() {
    { echo '----- HCC pods -----'
      kctl -n "$CONTROL_NS" get pods -l "app=${HCC_DEPLOY}" -o wide 2>&1 || true
    } >&2
  }
  if ! wait_until "$DELPASS_HCC_READY_DEADLINE_S" 2 "replacement HCC pod after restarting ${old_pod}" \
    _delpass_new_pod_probe _delpass_hcc_diag; then
    fail "delete-during-pass: no replacement HCC pod within ${DELPASS_HCC_READY_DEADLINE_S}s"
    return 1
  fi
  log "replacement HCC pod: ${new_pod}"

  # 3. Wait until the pass is demonstrably ACTIVE on the replacement pod.
  local pass_state=''
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_pass_active_probe() {
    local logs
    logs="$(kctl -n "$CONTROL_NS" logs "pod/${new_pod}" 2>/dev/null || true)"
    if grep -Fq -- "$HCC_PASS_FAILED_MARKER" <<<"$logs"; then pass_state='failed'; return 0; fi
    if grep -Fq -- "$HCC_PASS_COMPLETED_MARKER" <<<"$logs"; then pass_state='completed'; return 0; fi
    if grep -Fq -- "$HCC_PASS_STARTED_MARKER" <<<"$logs"; then pass_state='active'; return 0; fi
    return 1
  }
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_logs_diag() {
    { echo "----- replacement HCC pod logs (${new_pod}) -----"
      kctl -n "$CONTROL_NS" logs "pod/${new_pod}" --tail=80 2>&1 || true
    } >&2
  }
  if ! wait_until "$DELPASS_PASS_ACTIVE_DEADLINE_S" 1 "initial full pass to start on ${new_pod}" \
    _delpass_pass_active_probe _delpass_logs_diag; then
    fail "delete-during-pass: replacement pod never logged '${HCC_PASS_STARTED_MARKER}' within ${DELPASS_PASS_ACTIVE_DEADLINE_S}s"
    return 1
  fi
  local t_pass_active_ms=''
  case "$pass_state" in
    active)
      t_pass_active_ms="$(now_ms)"
      log "initial full pass ACTIVE on ${new_pod} (started, not completed)"
      ;;
    completed)
      fail "delete-during-pass: the initial pass completed before the delete could be issued — pass-active overlap NOT established in this environment (fleet reconciled too fast); re-run"
      _delpass_logs_diag
      return 1
      ;;
    failed)
      fail "delete-during-pass: the initial pass FAILED on the replacement pod — fix the controller before measuring"
      _delpass_logs_diag
      return 1
      ;;
  esac

  # 4. Delete the fixture Host WHILE the pass is active.
  local t_delete_ms; t_delete_ms="$(now_ms)"
  if ! kctl -n "$MCP_HOST_NS" delete host "$HOST_DELPASS" --wait=false >/dev/null; then
    fail "delete-during-pass: Host deletion failed for ${HOST_DELPASS}"
    return 1
  fi
  log "Host ${HOST_DELPASS} deleted while the pass is active"

  # B1 belt 1: the pass can log COMPLETED inside the ~0.5-2s window between
  # the active-probe read and the delete landing. Re-read the logs ONCE,
  # immediately; if COMPLETED is already present the delete cannot be
  # proven to have landed mid-pass — hard fail, never silently accepted.
  local post_delete_logs
  if ! post_delete_logs="$(kctl -n "$CONTROL_NS" logs "pod/${new_pod}" 2>/dev/null)"; then
    fail "delete-during-pass: could not re-read HCC logs immediately after the delete — overlap cannot be verified (fail-closed)"
    return 1
  fi
  if grep -Fq -- "$HCC_PASS_COMPLETED_MARKER" <<<"$post_delete_logs"; then
    fail "delete-during-pass: pass logged COMPLETED within the probe->delete window — overlap NOT established; re-run"
    return 1
  fi
  log "belt 1: COMPLETED still absent immediately after the delete"

  # 5. The pass must COMPLETE after the delete (a pass that fails instead
  # would mask the property under test behind an unrelated error).
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_pass_completed_probe() {
    local logs
    logs="$(kctl -n "$CONTROL_NS" logs "pod/${new_pod}" 2>/dev/null || true)"
    if grep -Fq -- "$HCC_PASS_FAILED_MARKER" <<<"$logs"; then pass_state='failed'; return 0; fi
    grep -Fq -- "$HCC_PASS_COMPLETED_MARKER" <<<"$logs" && pass_state='completed'
  }
  if ! wait_until "$DELPASS_PASS_COMPLETE_DEADLINE_S" 2 "initial full pass completion after the delete" \
    _delpass_pass_completed_probe _delpass_logs_diag; then
    fail "delete-during-pass: pass did not complete within ${DELPASS_PASS_COMPLETE_DEADLINE_S}s of the delete"
    return 1
  fi
  if [[ "$pass_state" == 'failed' ]]; then
    fail "delete-during-pass: the fleet pass FAILED after the mid-pass delete"
    _delpass_logs_diag
    return 1
  fi
  local t_pass_completed_ms; t_pass_completed_ms="$(now_ms)"
  ok "delete-during-pass: observed sequence pass-active@${t_pass_active_ms}ms -> delete@${t_delete_ms}ms -> completed-observed@${t_pass_completed_ms}ms (belt 1 passed at the delete)"

  # B1 belt 2: adjudicate overlap from the COMPLETED line's OWN log
  # timestamp (kubectl --timestamps stamps each line at write time),
  # closing the window the poll-granular reads cannot see. Clock note: the
  # log stamp is the node's clock while t_delete_ms is the runner's; on
  # minikube both derive from the host clock. A node clock ahead of the
  # runner could only mask a completion belt 1 already catches; a lagging
  # clock produces a LOUD false-fail, never a false-pass.
  local completed_line completed_ts completed_ms
  completed_line="$(kctl -n "$CONTROL_NS" logs "pod/${new_pod}" --timestamps 2>/dev/null \
    | grep -F "$HCC_PASS_COMPLETED_MARKER" | head -n1 || true)"
  if [[ -z "$completed_line" ]]; then
    fail "delete-during-pass: could not re-read the COMPLETED line with --timestamps for overlap adjudication"
    return 1
  fi
  completed_ts="${completed_line%% *}"
  if ! completed_ms="$(python3 -c '
import datetime, re, sys
ts = re.sub(r"\.(\d{1,6})\d*", r".\1", sys.argv[1]).replace("Z", "+00:00")
print(int(datetime.datetime.fromisoformat(ts).timestamp() * 1000))
' "$completed_ts" 2>/dev/null)"; then
    fail "delete-during-pass: could not parse COMPLETED log timestamp '${completed_ts}'"
    return 1
  fi
  if [[ "$completed_ms" -gt "$t_delete_ms" ]]; then
    ok "delete-during-pass: overlap established — COMPLETED log stamp postdates the delete (belt 2: completed-log=${completed_ms}ms > delete-issued=${t_delete_ms}ms)"
  else
    fail "delete-during-pass: COMPLETED log stamp (${completed_ms}ms) does NOT postdate the delete (${t_delete_ms}ms) — overlap NOT established; re-run"
    return 1
  fi

  # 6. Exactly-one complete cleanup converges: CR gone + zero ownership-
  # labeled leftovers across the bundle namespaces (teardown's predicate).
  # FAIL-CLOSED: the probe succeeds ONLY on positive evidence — confirmed
  # NotFound for the CR and a fully-readable, empty children enumeration.
  # A kubectl read failure keeps the probe failing, so an API blip ends in
  # the bounded deadline FAILING, never in a false "cleanup converged".
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _delpass_clean_probe() {
    host_absent_confirmed "$HOST_DELPASS" || return 1
    local children n
    children="$(collect_children_json "$HOST_DELPASS")" || return 1
    n="$(printf '%s' "$children" | jq 'length' 2>/dev/null || echo -1)"
    [[ "${n:--1}" -eq 0 ]]
  }
  if ! wait_until "$DELPASS_CLEANUP_DEADLINE_S" 3 "complete cleanup of ${HOST_DELPASS}" \
    _delpass_clean_probe _diag_probe; then
    fail "delete-during-pass: cleanup did not converge within ${DELPASS_CLEANUP_DEADLINE_S}s (lingering CR or owned leftovers)"
    return 1
  fi
  local t_clean_ms; t_clean_ms="$(now_ms)"
  ok "delete-during-pass: cleanup converged (CR gone, 0 owned children across ${BUNDLE_NAMESPACES})"

  # 7. No resurrection: the completed pass (and any stale queued reconcile)
  # must not recreate the deleted Host's resources. Quiet settle, re-assert.
  log "resurrection settle: ${DELPASS_RESURRECTION_SETTLE_S}s"
  sleep "$DELPASS_RESURRECTION_SETTLE_S"
  # FAIL-CLOSED: absence must be a confirmed NotFound and the children
  # enumeration fully readable — an unverifiable state fails exactly like
  # a resurrection would.
  local res_absent_rc=0 res_children children
  host_absent_confirmed "$HOST_DELPASS" || res_absent_rc=$?
  if children="$(collect_children_json "$HOST_DELPASS")"; then
    res_children="$(printf '%s' "$children" | jq 'length' 2>/dev/null || echo -1)"
  else
    res_children=-1
  fi
  if [[ "$res_absent_rc" -eq 0 && "$res_children" -eq 0 ]]; then
    ok "delete-during-pass: no resurrection after ${DELPASS_RESURRECTION_SETTLE_S}s settle (CR NotFound-confirmed, 0 owned children)"
  else
    fail "delete-during-pass: RESURRECTION or unverifiable state after cleanup (host_absence_rc=${res_absent_rc}: 0=confirmed-absent 1=present 2=read-failed; owned_children=${res_children}: -1=unverifiable)"
    pod_diagnostics "$HOST_DELPASS"
    return 1
  fi

  # 8. Machine-readable record for the report roll-up.
  jq -n \
    --arg host "$HOST_DELPASS" \
    --arg old_pod "$old_pod" --arg new_pod "$new_pod" \
    --argjson t_hcc_restart_ms "$t_restart_ms" \
    --argjson t_pass_active_seen_ms "$t_pass_active_ms" \
    --argjson t_delete_issued_ms "$t_delete_ms" \
    --argjson t_pass_completed_seen_ms "$t_pass_completed_ms" \
    --argjson t_pass_completed_log_ts_ms "$completed_ms" \
    --argjson t_cleanup_converged_ms "$t_clean_ms" \
    --argjson settle_s "$DELPASS_RESURRECTION_SETTLE_S" \
    '{subject:$host, trigger:"HCC pod restart -> initial full fleet pass",
      hcc_pod_restarted:$old_pod, hcc_pod_replacement:$new_pod,
      t_hcc_restart_ms:$t_hcc_restart_ms,
      t_pass_active_seen_ms:$t_pass_active_seen_ms,
      t_delete_issued_ms:$t_delete_issued_ms,
      t_pass_completed_seen_ms:$t_pass_completed_seen_ms,
      t_pass_completed_log_ts_ms:$t_pass_completed_log_ts_ms,
      t_cleanup_converged_ms:$t_cleanup_converged_ms,
      resurrection_settle_s:$settle_s,
      note:"overlap proven with two belts: (1) COMPLETED absent in a re-read immediately after the delete; (2) the COMPLETED line own --timestamps stamp (t_pass_completed_log_ts_ms) postdates t_delete_issued_ms; cleanup predicate = CR gone + zero ownership-labeled leftovers across the bundle namespaces; re-asserted after the settle window"}' \
    >"${RUN_DIR}/delete-during-pass.json"
  log "record: ${RUN_DIR}/delete-during-pass.json"
  return 0
}

# ======================================================================
# Teardown — delete ONLY this run's fixtures (by run label). Fail-loud on
# leftover after a bounded wait.
# ======================================================================
teardown_fixtures() {
  header "Teardown — deleting this run's fixtures (${FIXTURE_RUN_KEY}=${RUN_ID})"
  if [[ "${KEEP_FIXTURES:-}" == '1' ]]; then
    warn "KEEP_FIXTURES=1 — leaving fixtures in place for diagnosis (run-id ${RUN_ID})"
    return 0
  fi
  local sel="${FIXTURE_LABEL_KEY}=${FIXTURE_LABEL_VAL},${FIXTURE_RUN_KEY}=${RUN_ID}"

  # Delete Hosts first — HCC finalizers cascade-delete the owned bundle
  # (Deployment/Service/SA/Secret/PVC/NetworkPolicies + channel-reader). This
  # is the supported deletion path (§17.3: teardown through supported paths).
  kctl -n "$MCP_HOST_NS" delete host -l "$sel" --wait=false >/dev/null 2>&1 || true
  # Delete the throwaway Secret we created (not HCC-owned, so not cascaded).
  kctl -n "$MCP_HOST_NS" delete secret -l "$sel" --wait=false >/dev/null 2>&1 || true

  # Bounded wait for the Hosts to disappear, then verify no owned children of
  # our fixture hosts linger.
  # FAIL-CLOSED (mirrors e2e-host-storm-gate.sh): a kubectl list failure
  # must never read as "all gone" — the probe fails (error on stderr)
  # until the API positively returns an empty list.
  # shellcheck disable=SC2329  # invoked by name via wait_until
  _hosts_gone() {
    local out
    if ! out="$(kctl -n "$MCP_HOST_NS" get host -l "$sel" -o name 2>"${RUN_DIR}/hosts-gone.err")"; then
      echo "_hosts_gone: kubectl list FAILED: $(cat "${RUN_DIR}/hosts-gone.err" 2>/dev/null)" >&2
      return 1
    fi
    [[ -z "$out" ]]
  }
  if ! wait_until "${TEARDOWN_DEADLINE_S:-120}" 3 "fixture Hosts (${sel}) deletion" _hosts_gone teardown_diagnostics; then
    fail "teardown: fixture Hosts still present after deadline (run-id ${RUN_ID})"
    return 1
  fi

  # Verify no owned children of any of this run's hosts remain.
  # Convergence-aware (identical semantics to e2e-host-storm-gate.sh): a child
  # carrying a deletionTimestamp is CONVERGING — its delete WAS issued and a
  # finalizer (e.g. a workspace PVC's kubernetes.io/pvc-protection, held for the
  # deleting pod's termination grace) is draining — so it gets a bounded
  # extension. A child with NO deletionTimestamp means the delete was NEVER
  # issued (a real cleanup gap) and fails immediately, no wait. An unverifiable
  # read/parse is FAIL-CLOSED (verification impossible != "no children").
  local leftover=0 host orphan=0 unverifiable=0 leftover_report=''
  local converge_deadline=$(( SECONDS + MEASURE_TEARDOWN_CONVERGE_S ))
  while :; do
    leftover=0; orphan=0; unverifiable=0; leftover_report=''
    for host in "$HOST_CONTROL" "$HOST_STATELESS" "$HOST_PROBE" "$HOST_DELPASS"; do
      [[ -n "$host" ]] || continue
      local children n_conv n_orph
      if ! children="$(collect_children_json "$host")"; then
        leftover_report+="  ${host}: kubectl read FAILED (unverifiable, fail-closed)"$'\n'
        leftover=$((leftover+1)); unverifiable=1
        continue
      fi
      n_conv="$(printf '%s' "$children" | jq '[.[] | select(.deletionTimestamp != null)] | length' 2>/dev/null || echo -1)"
      n_orph="$(printf '%s' "$children" | jq '[.[] | select(.deletionTimestamp == null)] | length' 2>/dev/null || echo -1)"
      if [[ "${n_conv:--1}" -lt 0 || "${n_orph:--1}" -lt 0 ]]; then
        leftover_report+="  ${host}: owned-children JSON unparsable (jq failed, fail-closed)"$'\n'
        leftover=$((leftover+1)); unverifiable=1
        continue
      fi
      if [[ "$n_conv" -gt 0 ]]; then
        leftover_report+="  ${host}: ${n_conv} owned child(ren) Terminating (converging)"$'\n'
        leftover=$((leftover+n_conv))
      fi
      if [[ "$n_orph" -gt 0 ]]; then
        leftover_report+="  ${host}: ${n_orph} owned child(ren) with NO deletionTimestamp (delete never issued — REAL cleanup gap)"$'\n'
        leftover=$((leftover+n_orph)); orphan=1
      fi
    done
    if [[ "$leftover" -eq 0 ]]; then break; fi
    # A never-issued delete or an unverifiable read is a hard finding — do not wait.
    if [[ "$orphan" -eq 1 || "$unverifiable" -eq 1 ]]; then break; fi
    if [[ "$SECONDS" -ge "$converge_deadline" ]]; then break; fi
    sleep 3
  done
  if [[ "$leftover" -gt 0 ]]; then
    warn "teardown: owned-children leftovers after up to ${MEASURE_TEARDOWN_CONVERGE_S}s convergence extension:"
    printf '%s' "$leftover_report" >&2
  fi
  # Verify our fixture Secret is gone — FAIL-CLOSED on unreadable API.
  local sec_out
  if ! sec_out="$(kctl -n "$MCP_HOST_NS" get secret -l "$sel" -o name 2>"${RUN_DIR}/secret-gone.err")"; then
    warn "teardown: could not verify fixture Secret deletion: $(cat "${RUN_DIR}/secret-gone.err" 2>/dev/null) — counting as leftover"
    leftover=$((leftover+1))
  elif [[ -n "$sec_out" ]]; then
    warn "teardown: fixture Secret still present (${sel})"
    leftover=$((leftover+1))
  fi
  if [[ "$leftover" -gt 0 ]]; then
    fail "teardown: ${leftover} fixture resource(s) left over (run-id ${RUN_ID}) — investigate before trusting results"
    return 1
  fi
  ok "teardown: all fixtures for run-id ${RUN_ID} removed via supported paths"
  return 0
}

# shellcheck disable=SC2329  # invoked by name via wait_until
teardown_diagnostics() {
  {
    echo "----- teardown diagnostics -----"
    kctl -n "$MCP_HOST_NS" get host -l "${FIXTURE_LABEL_KEY}=${FIXTURE_LABEL_VAL},${FIXTURE_RUN_KEY}=${RUN_ID}" -o wide 2>&1 || true
  } >&2
}

# ======================================================================
# Report assembly (§1.2 chronology style: JSON + human markdown)
# ======================================================================
write_report() {
  local md="${RUN_DIR}/report.md" js="${RUN_DIR}/report.json"
  {
    echo "# Host-bundle reconciliation measurement — run \`${RUN_LABEL}\`"
    echo
    echo "- Context: \`${CONTEXT}\`"
    echo "- Run id: \`${RUN_ID}\`  •  UTC: $(now_rfc3339)"
    echo "- HCC image under test is selected EXTERNALLY by the orchestrator (baseline vs fixed)."
    echo
    echo "## §1.2 chronology — new-Host bundle"
    echo
    echo "| Subject | Class | Host created | First HCC child | Pod Ready | Bundle complete | Deployment (materialization class) | Interpretation |"
    echo "|---|---|---|---:|---:|---:|---:|---|"
    if [[ -s "${RUN_DIR}/bundle-rows.md" ]]; then cat "${RUN_DIR}/bundle-rows.md"; else echo "| _(no bundle phase run)_ |||||||"; fi
    echo
    if ls "${RUN_DIR}"/wake-*.json >/dev/null 2>&1; then
      echo "## §14.2 wake clock (accepted wake -> Pod Ready, budget ${SLO_WAKE_S}s)"
      echo
      echo "| Subject | Phase | Replicas patch | Pod Ready | Budget | Class |"
      echo "|---|---|---:|---:|---:|---|"
      cat "${RUN_DIR}"/wake-rows.md 2>/dev/null || true
      echo
    fi
    echo "## §14.2 clock coverage"
    echo
    echo "| Clock (§14.2) | Where measured | Source |"
    echo "|---|---|---|"
    echo "| New Host materialization (Host create -> Deployment) <=${SLO_MATERIALIZE_S}s | phase 1 bundle | K8s creationTimestamps |"
    echo "| New Host Ready (Host create -> Pod Ready) <=${SLO_READY_S}s | phase 1 bundle | Pod Ready condition |"
    echo "| Wake-to-Ready (accepted wake -> Pod Ready) <=${SLO_WAKE_S}s | phase 2 wake | WAKE_ACCEPT_MS (authoritative) + managedFields + Pod Ready |"
    echo "| Independent-Host admission while blocked | phase 3 | probe-Host bundle clock under asserted blocker |"
    echo "| HCC §14.1 histograms | phase 4 | /metrics scrape |"
    echo "| Context/McpServer non-regression | phase 5 | read-only resourceVersion/creationTimestamp snapshot |"
    echo "| Delete-while-pass-active convergence (#827, Addendum 4.7) | delete-during-pass step | HCC pass logs + ownership-label leftover check + resurrection settle |"
    echo
    if [[ -s "${RUN_DIR}/delete-during-pass.json" ]]; then
      echo "## Addendum 4.7 — delete-while-pass-active (#827)"
      echo
      jq -r '"- subject: `\(.subject)`\n- pass active -> delete -> pass completed (epoch-ms): \(.t_pass_active_seen_ms) -> \(.t_delete_issued_ms) -> \(.t_pass_completed_seen_ms)\n- cleanup converged at (epoch-ms): \(.t_cleanup_converged_ms)\n- no resurrection after \(.resurrection_settle_s)s settle"' \
        "${RUN_DIR}/delete-during-pass.json"
      echo
    fi
    echo "## Caveats"
    echo
    echo "- K8s object timestamps have 1-second resolution; sub-second deltas are reported at that granularity."
    echo "- Fixture Hosts use a placeholder LLM key; mcp-host readiness is an HTTP health probe that does not wait for MCP/LLM validity, so Pod-Ready timing is valid."
    echo "- The \`clerum.io/wake-requested\` annotation is recorded diagnostic-only; per §14.2 it is never the wake clock source."
    echo "- §14.1 series absent on a run indicate an HCC image predating the metrics (expected for baseline)."
  } >"$md"

  # Machine-readable roll-up: fold every per-phase JSON into one object.
  RUN_DIR="$RUN_DIR" RUN_LABEL="$RUN_LABEL" CONTEXT="$CONTEXT" RUN_ID="$RUN_ID" \
  STAMP="$(now_rfc3339)" python3 <<'PY'
import os,json,glob
rd=os.environ["RUN_DIR"]
def load(pat):
    out=[]
    for f in sorted(glob.glob(os.path.join(rd,pat))):
        try: out.append(json.load(open(f)))
        except Exception as e: out.append({"file":os.path.basename(f),"error":str(e)})
    return out
report={
 "run_label":os.environ["RUN_LABEL"],
 "context":os.environ["CONTEXT"],
 "run_id":os.environ["RUN_ID"],
 "generated_at":os.environ["STAMP"],
 "bundle":load("bundle-*.json"),
 "wake":load("wake-*.json"),
 "metrics":(load("hcc-metrics.summary.json") or [None])[0],
 "sideclock":(load("sideclock.json") or [None])[0],
 "delete_during_pass":(load("delete-during-pass.json") or [None])[0],
}
json.dump(report,open(os.path.join(rd,"report.json"),"w"),indent=2)
print("report.json + report.md written to "+rd)
PY
  log "report: ${md}"
  log "report: ${js}"
}

# ======================================================================
# Main
# ======================================================================
usage() {
  sed -n '2,160p' "$0" | sed -n '1,/^set -euo/p' >&2
  echo "Usage: CONTEXT=<clerum-...> RUN_LABEL=<label> OUT_DIR=<dir> $0 [all|bundle|wake|independent-admission|metrics|sideclock|delete-during-pass|teardown]" >&2
}

main() {
  local cmd="${1:-all}"
  case "$cmd" in
    -h|--help|help) usage; exit 0 ;;
  esac
  require_deps
  require_measure_context
  init_run

  local rc=0
  case "$cmd" in
    all)
      phase_bundle || rc=1
      if [[ "${ADMISSION_BLOCKER_READY:-}" == '1' ]]; then
        phase_independent_admission || rc=1
      else
        log "independent-admission phase NOT requested (ADMISSION_BLOCKER_READY!=1). The orchestrator must engage a deterministic HCC block and set ADMISSION_BLOCKER_READY=1 to run phase 3."
      fi
      phase_metrics   || rc=1
      phase_sideclock || rc=1
      if [[ -n "${WAKE_HOST:-}" ]]; then
        # Optional inline wake measurement when the orchestrator has already
        # suspended+woken a host and passed WAKE_HOST/WAKE_ACCEPT_MS.
        phase_wake || rc=1
      else
        log "wake phase NOT requested in 'all' (WAKE_HOST unset). Call the 'wake' subcommand after suspending+waking a stateless Host via e2e-stateless-suspend-wake.sh."
      fi
      if [[ "${DELETE_DURING_PASS:-}" == '1' ]]; then
        # Runs LAST among the measurement phases: it restarts the HCC pod,
        # which resets the §14.1 counters phase 4 already scraped.
        phase_delete_during_pass || rc=1
      else
        log "delete-during-pass step NOT requested in 'all' (DELETE_DURING_PASS!=1). It restarts the HCC pod to force a demonstrable full fleet pass; set DELETE_DURING_PASS=1 to opt in (Addendum 4.7)."
      fi
      write_report
      teardown_fixtures || rc=1
      ;;
    bundle)                phase_bundle || rc=1; write_report ;;
    wake)                  phase_wake   || rc=1; write_report ;;
    independent-admission) phase_independent_admission || rc=1; write_report ;;
    metrics)               phase_metrics   || rc=1; write_report ;;
    sideclock)             phase_sideclock || rc=1; write_report ;;
    delete-during-pass)    phase_delete_during_pass || rc=1; write_report ;;
    teardown)              teardown_fixtures || rc=1 ;;
    *) usage; die "unknown subcommand: ${cmd}" 2 ;;
  esac

  print_results
  if [[ "$rc" -ne 0 || "$m_fail" -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
