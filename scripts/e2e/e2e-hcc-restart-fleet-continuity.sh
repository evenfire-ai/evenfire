#!/usr/bin/env bash
# ======================================================================
# E2E — an abrupt HCC restart must not disturb the fleet (issue #1338)
#
# The NetworkPolicy pass watchdog ends the controller with process.exit(1)
# when a pass outlives HCC_NETPOL_PASS_HARD_LIMIT_MS. This lane proves that
# such an exit, at rest or in the middle of a pass, leaves every workload the
# controller manages untouched and every consumer of its API in sync:
#
#   C1 no pod outside HCC is replaced or restarted (uid, restartCount);
#      new pods owned by a ReplicaSet are a rollout and fail too;
#   C2 no Deployment generation or pod-template hash changes. One exception,
#      for the suspended stateless fixture only: a suspended Host rewrites its
#      pod template on every scheduled token rotation (issue #1359). C2 admits
#      for that Deployment exactly one change: the template annotation
#      clerum.io/runtime-token-revision, with generation +1, whose new value is
#      the secret revision of a rotation C3 admitted for that Host. The
#      admission is logged as a NOTE. Any other template or spec difference
#      fails, and C2 stays strict for every other Deployment.
#      REMOVE THIS ADMISSION WHEN #1359 IS FIXED.
#   C3 a runtime-token Secret either stays unchanged (resourceVersion, data
#      hash) or is rotated on schedule. HCC rewrites these Secrets on a
#      schedule, restart or not, and with 1 h tokens no run window can be kept
#      free of such writes. A write is admitted only when its new issued-at is
#      at or after that Secret's earliest scheduled write, computed from
#      snapshot A (token_rules_py), and the HCC log carries the rotation line
#      for that Secret with the reason and rolloutRequired the schedule
#      predicts. Any other write fails C3: an early rotation, a second
#      rotation, an annotation-only write, a GFS-only renewal, a new Secret.
#      Token values are never printed or stored; only the refresh token's
#      exp claim is decoded;
#   C4 no HCC-managed NetworkPolicy is deleted, recreated or changed; an
#      external-egress policy keeps its uid, ports and protocol and stays
#      non-empty, and each /32 added or evicted by its DNS window is reported;
#   C5 Host and McpServer conditions and Host lifecycle states are unchanged;
#      the suspended stateless Host stays suspended;
#   C6 HCC's request lane is ready again before mcp-host's authority
#      staleness bound (HCC_AUTHORITY_MAX_STALENESS_MS, read from the live
#      mcp-host ConfigMap: 180 s on the minikube overlay and by default). This
#      is a necessary check only: successes are phase-locked to poll ticks, so
#      the recovery budget guaranteed from the disruption start is
#      floor((S - I - T - 1 s) / max(I, T)) * max(I, T), which is 120 s at
#      S = 180 s, I = 30 s and T = 10 s. C7 is the verdict;
#   C7 no Host pod logs a fleet revocation or a removed server; witness: the
#      HCC gateway serves Host inventory with 200 after the restart;
#   C8 the McpServer fixture's Ready condition, sampled every 2 s from the kill
#      to the end of the settle window, is never False;
#   C9 mcp-proxy's pod Ready condition, sampled over the same window, is never
#      False.
#
# Recovery witnesses (all required): the HCC pod keeps its uid and its
# restartCount grows by the number of kills; the new process logs a
# `certified` NetworkPolicy pass; the request lane answers 200.
#
# Precondition at snapshot A: no runtime-token Secret is overdue or has a
# pending write. Each Secret's earliest scheduled write must lie more than
# 30 s (clock skew) after the snapshot; the lane retakes snapshot A for one
# Host resync period plus 120 s until that holds. The schedule per Secret
# (class, earliest write, binding term) is written to token-schedule-A.tsv,
# and every C2/C3 admission decision to token-admissions.tsv.
#
# Vacuity:
#   roll-host-fixture  rolls the active stateless Host fixture between the
#                      snapshots. The lane must see C1 and C2 fail.
#   rotate-early       after snapshot A, removes clerum.io/runtime-token-issued-at
#                      from the active fixture's runtime-token Secret. HCC then
#                      rotates it (refresh_token_near_expiry) before its
#                      scheduled time. The lane's own edit is a write C3 does
#                      not admit either; it is recorded in vacuity-edit.json
#                      and reported in that Secret's C3 verdict. The lane must
#                      see exactly one failure: C3 on that Secret, with
#                      "rotated before its scheduled time".
# In both modes the lane prints E2E_HCC_RESTART_CONTINUITY_VACUITY=DETECTED
# and exits 0 only when the expected failure occurred.
#
# INPUTS (fail loud when missing or invalid)
#   KUBECONTEXT / E2E_K8S_CONTEXT  generated branch-owned minikube context
#   MINIKUBE_PROFILE               must equal that context
#   E2E_HCC_RESTART_CONTINUITY_FAULT_INJECTION=1
#                                  acknowledges the HCC kills and the temporary
#                                  stateless cadence change
#   E2E_CONTINUITY_MODE            idle | mid-pass
#   E2E_CONTINUITY_EVIDENCE_DIR    existing absolute directory for evidence
#   E2E_EXPECTED_HCC_IMAGE_ID      sha256 image id (or a 12+ hex prefix) the
#                                  running HCC container must use
# OPTIONAL
#   E2E_CONTINUITY_SETTLE_SEC      settle window after recovery (default 300,
#                                  one Host resync period)
#   E2E_CONTINUITY_VACUITY         empty | roll-host-fixture | rotate-early
#   E2E_CONTINUITY_MID_PASS_ATTEMPTS  default 3
#   E2E_CONTINUITY_PEER_CONTEXTS   extra Contexts selecting the McpServer
#                                  fixture (default 30 in mid-pass, 0 in idle).
#                                  A pass on a small fleet ends in tens of
#                                  milliseconds, faster than a kill can land;
#                                  each Context adds policy work to the pass.
#   MINIKUBE_BIN                   default minikube
#
# EXIT CODES
#   0  every assertion passed (or, in vacuity mode, the mutation was detected)
#      and teardown left no fixture behind
#   1  an assertion, precondition or teardown failed
#   2  usage error
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/e2e-lib.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/e2e-lib.sh"
# shellcheck source=scripts/e2e/_lib/hcc-ready-series.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-ready-series.sh"
# shellcheck source=scripts/e2e/_lib/hcc-watch-recovery-lock.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/hcc-watch-recovery-lock.sh"
# shellcheck source=scripts/e2e/_lib/host-log-window.sh
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_lib/host-log-window.sh"

usage() { echo "usage error: $*" >&2; exit 2; }
die() { echo -e "${RED}FATAL${NC} — $*" >&2; exit 1; }

# ─── Inputs ───────────────────────────────────────────────────────────
[ -n "$E2E_KUBECONTEXT" ] || usage "KUBECONTEXT or E2E_K8S_CONTEXT must name the branch-owned context"
is_branch_scoped_e2e_context "$E2E_KUBECONTEXT" ||
  usage "refusing fault injection on non-branch context '${E2E_KUBECONTEXT}'"
require_safe_kube_context
[ "${MINIKUBE_PROFILE:-}" = "$E2E_KUBECONTEXT" ] ||
  usage "MINIKUBE_PROFILE must equal ${E2E_KUBECONTEXT}, got '${MINIKUBE_PROFILE:-}'"
[ "${E2E_HCC_RESTART_CONTINUITY_FAULT_INJECTION:-0}" = 1 ] ||
  usage "set E2E_HCC_RESTART_CONTINUITY_FAULT_INJECTION=1 to acknowledge the HCC kills"
MODE="${E2E_CONTINUITY_MODE:-}"
case "$MODE" in idle|mid-pass) ;; *) usage "E2E_CONTINUITY_MODE must be idle or mid-pass" ;; esac
EVIDENCE_DIR="${E2E_CONTINUITY_EVIDENCE_DIR:-}"
case "$EVIDENCE_DIR" in /*) ;; *) usage "E2E_CONTINUITY_EVIDENCE_DIR must be an absolute path" ;; esac
[ -d "$EVIDENCE_DIR" ] && [ -w "$EVIDENCE_DIR" ] || usage "evidence directory ${EVIDENCE_DIR} is missing or not writable"
EXPECTED_IMAGE_ID="${E2E_EXPECTED_HCC_IMAGE_ID:-}"
EXPECTED_IMAGE_ID="${EXPECTED_IMAGE_ID#sha256:}"
[[ "$EXPECTED_IMAGE_ID" =~ ^[0-9a-f]{12,64}$ ]] || usage "E2E_EXPECTED_HCC_IMAGE_ID must be a sha256 image id or a 12+ hex prefix"
SETTLE_SEC="${E2E_CONTINUITY_SETTLE_SEC:-300}"
[[ "$SETTLE_SEC" =~ ^[0-9]+$ ]] && [ "$SETTLE_SEC" -ge 60 ] || usage "E2E_CONTINUITY_SETTLE_SEC must be an integer >= 60"
VACUITY="${E2E_CONTINUITY_VACUITY:-}"
case "$VACUITY" in ''|roll-host-fixture|rotate-early) ;; *) usage "E2E_CONTINUITY_VACUITY must be empty, roll-host-fixture or rotate-early" ;; esac
MID_PASS_ATTEMPTS="${E2E_CONTINUITY_MID_PASS_ATTEMPTS:-3}"
[[ "$MID_PASS_ATTEMPTS" =~ ^[1-9]$ ]] || usage "E2E_CONTINUITY_MID_PASS_ATTEMPTS must be 1-9"
if [ "$MODE" = mid-pass ]; then PEER_CONTEXTS_DEFAULT=30; else PEER_CONTEXTS_DEFAULT=0; fi
PEER_CONTEXTS="${E2E_CONTINUITY_PEER_CONTEXTS:-$PEER_CONTEXTS_DEFAULT}"
[[ "$PEER_CONTEXTS" =~ ^[0-9]+$ ]] && [ "$PEER_CONTEXTS" -le 60 ] ||
  usage "E2E_CONTINUITY_PEER_CONTEXTS must be an integer 0-60"
MINIKUBE_BIN="${MINIKUBE_BIN:-minikube}"
for tool in jq python3 "$MINIKUBE_BIN"; do
  command -v "$tool" >/dev/null 2>&1 || usage "$tool is required"
done

# ─── Constants (mirrored from deploy/ and host-context-controller/src) ──
HCC_NS="control-plane"
HCC_DEPLOY="host-context-controller"
GATEWAY_DEPLOY="host-context-controller-api-gateway"
HOST_NS="mcp-host"
MCP_NS="mcp-server"
MCP_PROXY_DEPLOY="mcp-proxy"
SOURCE_HOST="chatllm"
# Every namespace whose workloads the restart must leave alone.
FLEET_NAMESPACES="mcp-host mcp-server channels rpc-proxy gfs control-plane profiles webhook-ingress"
SUITE="hcc-restart-continuity"
RUN_ID="$(date +%s)-$$"
RUN_LABEL="$(truncate_rfc1123 "$RUN_ID")"
MCP_FIXTURE="$(truncate_rfc1123 "e2e-hrc-mcp-${RUN_ID}")"
CONTEXT_FIXTURE="$(truncate_rfc1123 "e2e-hrc-ctx-${RUN_ID}")"
TRIGGER_CONTEXT="$(truncate_rfc1123 "e2e-hrc-trigger-${RUN_ID}")"
SUSPENDED_HOST="$(truncate_rfc1123 "e2e-hrc-susp-${RUN_ID}")"
ACTIVE_HOST="$(truncate_rfc1123 "e2e-hrc-act-${RUN_ID}")"
EGRESS_DNS="example.com"
# mcp-host revokes its fleet after HCC_AUTHORITY_MAX_STALENESS_MS without a
# successful poll; the value is read from the live ConfigMap in Preconditions.
AUTHORITY_STALENESS_SEC=""
# Stateless cadences used only to suspend the fixture (same values as
# e2e-stateless-suspend-wake.sh); restored before the first snapshot.
CADENCE_KEYS="CONTEXT_MAPPER_STATELESS_IDLE_MINUTES CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS CONTEXT_MAPPER_HEARTBEAT_POLL_MS"
CADENCE_TEST_VALUES="1 1 20000 5000"
# Bounds of the disruption phase; HCC recovers in seconds.
KILL_WATCH_SEC=60
RESTART_WAIT_SEC=60
RECOVERY_BETWEEN_SEC=120
RECOVERY_WAIT_SEC=300
NODE_KILL_SCRIPT="${SCRIPT_DIR}/_lib/hcc-node-kill.sh"
NODE_KILL_PATH="/tmp/e2e-hcc-node-kill-${RUN_LABEL}.sh"

# Read and written by the sourced lock helper.
# shellcheck disable=SC2034
HCC_GATE_LOCK_ACQUIRED=0
# shellcheck disable=SC2034
HCC_GATE_LOCK_NAME=""
# shellcheck disable=SC2034
HCC_GATE_LOCK_UID=""
# shellcheck disable=SC2034
HCC_GATE_FINALIZATION_FAILURE=""
CADENCE_SAVED=""
FIXTURES_CREATED=0
SAMPLER_PID=""
SAMPLER_STOP="${EVIDENCE_DIR}/sampler.stop"
SERIES="${EVIDENCE_DIR}/series.tsv"
KILL_EPOCH=""
KILLS=0

log "run ${RUN_ID} mode=${MODE} vacuity=${VACUITY:-none} evidence=${EVIDENCE_DIR}"

# ─── Helpers ──────────────────────────────────────────────────────────
hcc_pod() {
  local pod
  pod="$(running_hcc_pod)" || return 1
  [ -n "$pod" ] || return 1
  printf '%s\n' "$pod"
}

hcc_pod_uid() { kctl get pod "$1" -n "$HCC_NS" -o jsonpath='{.metadata.uid}'; }

hcc_image_id() {
  kctl get pod "$1" -n "$HCC_NS" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="host-context-controller")].imageID}'
}

# 200 when the HCC request lane serves the v1 inventory to its real consumer,
# else 503. The probe runs in the mcp-proxy pod with that pod's own
# HCC_API_URL, so it takes the consumer's path: the API gateway, then HCC.
# HCC's direct port admits only the gateway, and HCC evaluates the request
# lane per request, so a live request is the witness, not a past log line.
request_lane_status() {
  kctl exec "deployment/${MCP_PROXY_DEPLOY}" -n "$MCP_NS" -c mcp-proxy -- \
    sh -c 'wget -T 10 -t 1 -qO- "${HCC_API_URL}/api/v1/mcpservers"' >/dev/null 2>&1 && echo 200 || echo 503
}

# The probe above reads a 503 for any failure, so prove once that its
# configuration exists; otherwise every wait would time out as "not ready".
assert_request_lane_probe_configured() {
  kctl exec "deployment/${MCP_PROXY_DEPLOY}" -n "$MCP_NS" -c mcp-proxy -- \
    sh -c '[ -n "${HCC_API_URL:-}" ]' ||
    die "the mcp-proxy pod has no HCC_API_URL, so the HCC request lane cannot be probed"
}

request_lane_ready_now() {
  hcc_pod >/dev/null || return 1
  [ "$(request_lane_status)" = 200 ]
}

# hcc_restarted_past <pod> <count>: the HCC container restarted more than <count> times.
hcc_restarted_past() {
  local restarts
  restarts="$(hcc_restart_count "$1")" || return 1
  [ -n "$restarts" ] && [ "$restarts" -gt "$2" ]
}

# The last NetworkPolicy pass event of the current (or --previous) process:
# "start <passId>" or "result <passId> <result>".
last_pass_event() {
  local pod=$1 previous=${2:-}
  local args=(logs "pod/$pod" -n "$HCC_NS" -c host-context-controller)
  [ "$previous" = previous ] && args+=(--previous)
  kctl "${args[@]}" | python3 -I -c '
import json, sys
last = "none"
for raw in sys.stdin:
    start = raw.find("{")
    if start < 0 or "networkpolicy-pass-" not in raw:
        continue
    try:
        row = json.loads(raw[start:])
    except ValueError:
        continue
    if row.get("event") == "networkpolicy-pass-start":
        last = "start %s" % row.get("passId")
    elif row.get("event") == "networkpolicy-pass-result":
        last = "result %s %s" % (row.get("passId"), row.get("result"))
print(last)'
}

# The request lane opens when a pass records its safety certificate; the pass
# logs its result only after its additive phase, so callers wait for this.
# The log is read into a file with a checked status (a failed read is never
# "not yet") and matched without a pipe, because `grep -q` exiting early under
# pipefail can turn a match into a failure.
certified_pass_logged() {
  local pod=$1 log="${EVIDENCE_DIR}/hcc-restarted-${1}.log"
  kctl logs "pod/$pod" -n "$HCC_NS" -c host-context-controller >"$log" ||
    die "could not read the logs of HCC pod ${pod}"
  grep -qE '"event":"networkpolicy-pass-result".*"result":"certified"' "$log"
}

# C3 matches every token Secret write against the HCC rotation log, so the log
# of each killed container is kept: kubelet retains only the last one.
save_killed_hcc_log() {
  local pod=$1
  kctl logs "pod/$pod" -n "$HCC_NS" -c host-context-controller --previous >"${EVIDENCE_DIR}/hcc-killed-${KILLS}.log" ||
    die "could not read the log of the HCC container ended by kill ${KILLS}"
}

selector_of() {
  kctl get deployment "$1" -n "$2" -o json | jq -r '.spec.selector.matchLabels | to_entries | map("\(.key)=\(.value)") | join(",")'
}

condition_status() {
  # condition_status <kind> <name> <ns> <type> -> True|False|Unknown|none
  local value
  value="$(kctl get "$1" "$2" -n "$3" -o json |
    jq -r --arg t "$4" '[.status.conditions[]? | select(.type == $t)][0].status // "none"')" || return 1
  printf '%s\n' "$value"
}

host_state() { kctl get host "$1" -n "$HOST_NS" -o jsonpath='{.status.lifecycle.state}'; }

pod_ready_by_selector() {
  local value
  value="$(kctl get pods -n "$2" -l "$1" -o json |
    jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | ([.status.conditions[]? | select(.type == "Ready")][0].status // "none")] | if length == 0 then "none" else join(",") end')" || return 1
  printf '%s\n' "$value"
}

# ─── Snapshot and comparison ──────────────────────────────────────────
# Writes ${EVIDENCE_DIR}/snapshot-<label>.json. Secret values are hashed in a
# pipe and never written; only names, resourceVersions, digests and the
# refresh token's exp claim are kept. Every read is checked here because the
# snapshot also runs inside wait_until, where `set -e` does not apply.
snapshot() {
  local label=$1
  local dir="${EVIDENCE_DIR}/raw-${label}"
  mkdir -p "$dir" || die "could not create ${dir}"
  local ns
  for ns in $FLEET_NAMESPACES; do
    kctl get namespace "$ns" >/dev/null || die "fleet namespace ${ns} is missing"
  done
  kctl get pods,deployments -A -o json >"${dir}/workloads.json" ||
    die "snapshot ${label}: could not read pods and Deployments"
  kctl get networkpolicies -A -l 'clerum.io/managed-by=host-context-controller' -o json >"${dir}/netpols.json" ||
    die "snapshot ${label}: could not read the HCC NetworkPolicies"
  kctl get hosts -n "$HOST_NS" -o json >"${dir}/hosts.json" || die "snapshot ${label}: could not read the Hosts"
  kctl get mcpservers -n "$MCP_NS" -o json >"${dir}/mcpservers.json" ||
    die "snapshot ${label}: could not read the McpServers"
  # The token schedule compares each earliest write with this epoch.
  date +%s >"${dir}/read-epoch" || die "snapshot ${label}: could not record the read time"
  kctl get secrets -n "$HOST_NS" -o json | token_rules digests >"${dir}/token-digests.json" ||
    die "snapshot ${label}: could not read the runtime-token Secrets"
  FLEET_NAMESPACES="$FLEET_NAMESPACES" HCC_NS="$HCC_NS" HCC_DEPLOY="$HCC_DEPLOY" \
    python3 -I - "$dir" "${EVIDENCE_DIR}/snapshot-${label}.json" <<'PY' || die "snapshot ${label}: could not summarise the reads"
import hashlib, json, os, sys
src, dst = sys.argv[1], sys.argv[2]
namespaces = set(os.environ["FLEET_NAMESPACES"].split())
hcc_ns, hcc_deploy = os.environ["HCC_NS"], os.environ["HCC_DEPLOY"]
def load(name):
    with open(os.path.join(src, name)) as fh:
        return json.load(fh)
def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
def is_hcc(item):
    labels = item["metadata"].get("labels") or {}
    return item["metadata"]["namespace"] == hcc_ns and (
        labels.get("app") == hcc_deploy or item["metadata"]["name"] == hcc_deploy)
snap = {"pods": {}, "deployments": {}, "netpols": {}, "hosts": {}, "mcpservers": {},
        "tokens": load("token-digests.json")}
for item in load("workloads.json")["items"]:
    meta = item["metadata"]
    if meta["namespace"] not in namespaces or is_hcc(item):
        continue
    key = "%s/%s" % (meta["namespace"], meta["name"])
    if item["kind"] == "Pod":
        if meta.get("deletionTimestamp") or item["status"].get("phase") != "Running":
            continue
        owners = [o["kind"] for o in meta.get("ownerReferences") or []]
        snap["pods"][key] = {
            "uid": meta["uid"],
            "owner": owners[0] if owners else "",
            "restarts": {c["name"]: c.get("restartCount", 0)
                         for c in item["status"].get("containerStatuses") or []},
        }
    elif item["kind"] == "Deployment":
        snap["deployments"][key] = {
            "generation": meta.get("generation"),
            "templateSha256": sha(item["spec"]["template"]),
        }
for item in load("netpols.json")["items"]:
    meta = item["metadata"]
    key = "%s/%s" % (meta["namespace"], meta["name"])
    labels = meta.get("labels") or {}
    if labels.get("clerum.io/policy-type") == "external-egress":
        egress = item["spec"].get("egress") or []
        cidrs = sorted({peer["ipBlock"]["cidr"] for rule in egress
                        for peer in rule.get("to") or [] if "ipBlock" in peer})
        ports = sorted({"%s/%s" % (p.get("port"), p.get("protocol")) for rule in egress
                        for p in rule.get("ports") or []})
        snap["netpols"][key] = {"uid": meta["uid"], "external": True,
                                "cidrs": cidrs, "ports": ports}
    else:
        snap["netpols"][key] = {"uid": meta["uid"], "external": False,
                                "specSha256": sha(item["spec"])}
def conditions(item):
    return sorted("%s=%s/%s" % (c.get("type"), c.get("status"), c.get("reason", ""))
                  for c in (item.get("status") or {}).get("conditions") or [])
for item in load("hosts.json")["items"]:
    status = item.get("status") or {}
    snap["hosts"][item["metadata"]["name"]] = {
        "uid": item["metadata"]["uid"],
        "state": (status.get("lifecycle") or {}).get("state", ""),
        "conditions": conditions(item),
    }
for item in load("mcpservers.json")["items"]:
    snap["mcpservers"][item["metadata"]["name"]] = {
        "uid": item["metadata"]["uid"], "conditions": conditions(item)}
with open(dst, "w") as fh:
    json.dump(snap, fh, indent=1, sort_keys=True)
print("snapshot pods=%d deployments=%d netpols=%d hosts=%d mcpservers=%d tokens=%d" % (
    len(snap["pods"]), len(snap["deployments"]), len(snap["netpols"]),
    len(snap["hosts"]), len(snap["mcpservers"]), len(snap["tokens"])))
PY
}

# Prints "<check> PASS|FAIL|NOTE <detail>" lines; never prints values. C2 and
# C3 come from token_rules_py, which also writes token-admissions.tsv.
compare_snapshots() {
  local lane_edit=- hcc_logs
  [ "$VACUITY" != rotate-early ] || lane_edit="${EVIDENCE_DIR}/vacuity-edit.json"
  hcc_logs=("${EVIDENCE_DIR}"/hcc-killed-*.log)
  [ -f "${hcc_logs[0]}" ] || die "no log of a killed HCC container in ${EVIDENCE_DIR}"
  python3 -I - "${EVIDENCE_DIR}/snapshot-A.json" "${EVIDENCE_DIR}/snapshot-B.json" "$SUSPENDED_HOST" <<'PY' || die "the C1/C4/C5 comparison failed"
import json, sys
with open(sys.argv[1]) as fh:
    a = json.load(fh)
with open(sys.argv[2]) as fh:
    b = json.load(fh)
suspended_host = sys.argv[3]
def report(check, problems, ok_detail):
    if problems:
        for p in problems:
            print("%s FAIL %s" % (check, p))
    else:
        print("%s PASS %s" % (check, ok_detail))
# C1 pods
problems = []
for key, pa in a["pods"].items():
    pb = b["pods"].get(key)
    if pb is None:
        problems.append("pod %s disappeared" % key)
    elif pb["uid"] != pa["uid"]:
        problems.append("pod %s replaced" % key)
    elif pb["restarts"] != pa["restarts"]:
        problems.append("pod %s restarts %s -> %s" % (key, pa["restarts"], pb["restarts"]))
for key, pb in b["pods"].items():
    if key not in a["pods"] and pb["owner"] == "ReplicaSet":
        problems.append("new ReplicaSet pod %s (rollout)" % key)
report("C1", problems, "%d pods unchanged" % len(a["pods"]))
# C2 and C3: token_rules_py compare (called after this program).
# C4 NetworkPolicies
problems, notes = [], []
for key, na in a["netpols"].items():
    nb = b["netpols"].get(key)
    if nb is None:
        problems.append("NetworkPolicy %s deleted" % key)
    elif nb["uid"] != na["uid"]:
        problems.append("NetworkPolicy %s recreated" % key)
    elif na["external"]:
        if nb["ports"] != na["ports"]:
            problems.append("external egress %s ports %s -> %s" % (key, na["ports"], nb["ports"]))
        if not nb["cidrs"]:
            problems.append("external egress %s is empty" % key)
        added = sorted(set(nb["cidrs"]) - set(na["cidrs"]))
        evicted = sorted(set(na["cidrs"]) - set(nb["cidrs"]))
        if added or evicted:
            notes.append("%s added=%s evicted=%s" % (key, added, evicted))
    elif nb["specSha256"] != na["specSha256"]:
        problems.append("NetworkPolicy %s spec changed" % key)
for key in b["netpols"]:
    if key not in a["netpols"]:
        problems.append("NetworkPolicy %s created" % key)
for note in notes:
    print("C4 NOTE external egress DNS window: %s" % note)
report("C4", problems, "%d NetworkPolicies unchanged" % len(a["netpols"]))
# C5 Host and McpServer state
problems = []
for kind in ("hosts", "mcpservers"):
    for name, oa in a[kind].items():
        ob = b[kind].get(name)
        if ob is None:
            problems.append("%s %s disappeared" % (kind, name))
        elif ob != oa:
            problems.append("%s %s %s -> %s" % (kind, name, oa, ob))
if a["hosts"].get(suspended_host, {}).get("state") != "suspended":
    problems.append("suspended fixture %s was not suspended in snapshot A" % suspended_host)
report("C5", problems, "%d Hosts, %d McpServers unchanged" % (len(a["hosts"]), len(a["mcpservers"])))
PY
  token_rules compare "${EVIDENCE_DIR}/raw-A" "${EVIDENCE_DIR}/raw-B" \
    "${EVIDENCE_DIR}/snapshot-A.json" "${EVIDENCE_DIR}/snapshot-B.json" \
    "${EVIDENCE_DIR}/token-schedule-A.json" "$SUSPENDED_HOST" \
    "${EVIDENCE_DIR}/token-admissions.tsv" "$lane_edit" \
    "${hcc_logs[@]}" "${EVIDENCE_DIR}/hcc-at-B.log" || die "the C2/C3 comparison failed"
}

# ─── Runtime-token rules (C2 suspended admission, C3, precondition) ──
# One program, so the precondition at snapshot A, C3 and C2 apply the same
# schedule. It mirrors host-context-controller/src/hostReconciler.ts
# (runtimeTokenRefreshDecision, the preserve branch, the full rewrite and
# bootstrapObservationUpdates) and statelessDeployment.ts
# (effectiveRotateBeforeMs). Subcommands:
#   digests     stdin: Secrets list JSON -> per-Secret digests, annotations
#               and the refresh token's exp claim (no token value is kept)
#   hcc-env     stdin: HCC Deployment JSON -> "<rotate-before s> <resync s>"
#   schedule    <raw dir> <epoch> <skew s> <out prefix>: earliest write per
#               Secret; exit 0 settled, 1 overdue or pending, 2 bad input
#   compare     <raw A> <raw B> <snapshot A> <snapshot B> <schedule A json>
#               <suspended Host> <admissions tsv> <lane edit json|-> <HCC
#               logs...>: prints the C2 and C3 lines
# Earliest write E per Secret (A = Ready Deployment on the Secret's revision,
# B = Ready Deployment on an older revision, C = not Ready, 0 replicas or
# suspended); N is the rotate-before point exp - min(R, (exp - issued-at)/2):
#   class A, C: E = min(N, refresh-before, gfs-token-refresh-before)
#   class B:    E = min(gfs-token-refresh-before, refresh-expires-at)
# A Secret is not settled when an input annotation or the exp claim is
# missing, the Deployment's restartedAt is after issued-at, or a bootstrap
# observation write is pending; HCC would then write it at once.
token_rules() {
  HCC_NS="$HCC_NS" HCC_DEPLOY="$HCC_DEPLOY" HOST_NS="$HOST_NS" \
    python3 -I -c "$(token_rules_py)" "$@"
}

token_rules_py() {
  cat <<'TOKEN_RULES_PY'
import base64, datetime, hashlib, json, os, re, sys

ANN = "clerum.io/"
ISSUED = ANN + "runtime-token-issued-at"
REFRESH_BEFORE = ANN + "runtime-token-refresh-before"
REFRESH_EXPIRES = ANN + "runtime-token-refresh-expires-at"
GFS_REFRESH_BEFORE = ANN + "gfs-token-refresh-before"
GFS_EXPIRES = ANN + "gfs-token-expires-at"
SECRET_REVISION = ANN + "runtime-token-secret-revision"
BOOT_STATE = ANN + "runtime-token-bootstrap-state"
BOOT_UID = ANN + "runtime-token-bootstrap-deployment-uid"
BOOT_APPLIED = ANN + "runtime-token-bootstrap-applied-revision"
BOOT_READY = ANN + "runtime-token-bootstrap-ready-revision"
ROLLOUT = ANN + "runtime-token-rollout-required"
TEMPLATE_REVISION = ANN + "runtime-token-revision"
RESTARTED_AT = "kubectl.kubernetes.io/restartedAt"
REFRESH_KEY = "mcp-host-runtime-refresh-token"
PREFIX, SUFFIX = "host-", "-mcp-host-runtime-tokens"
ROTATED_MSG = "rotated mcp-host-runtime-token Secret"
ROTATE_BEFORE_ENV = ("CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S", 86400)
RESYNC_ENV = ("CONTEXT_MAPPER_HOST_RESYNC_SEC", 300)
# A rotation logs its line right after the Secret write, whose issued-at is
# the decision time; the line must follow issued-at within this bound.
LOG_MATCH_MS = 60000
NEAR, BEFORE, GFS = "refresh_token_near_expiry", "refresh_before_reached", "gfs_refresh_before_reached"
# Annotations a full rewrite sets or drops; any other moved key is not a rotation.
ROTATION_KEYS = {ISSUED, REFRESH_BEFORE, REFRESH_EXPIRES, GFS_REFRESH_BEFORE, GFS_EXPIRES,
                 SECRET_REVISION, BOOT_STATE, ROLLOUT, BOOT_UID, BOOT_APPLIED, BOOT_READY}

def bad_input(message):
    print("token rules: " + message, file=sys.stderr)
    sys.exit(2)

def load(path):
    with open(path) as fh:
        return json.load(fh)

def ms(value):
    if not value:
        return None
    try:
        return int(round(datetime.datetime.fromisoformat(
            value.replace("Z", "+00:00")).timestamp() * 1000))
    except ValueError:
        return None

def iso(value):
    if value is None:
        return "-"
    stamp = datetime.datetime.fromtimestamp(value // 1000, datetime.timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % (value % 1000)

def short(revision):
    return (revision or "-")[:12]

def items(doc):
    return doc["items"] if "items" in doc else [doc]

def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

def host_of(secret):
    if secret.startswith(PREFIX) and secret.endswith(SUFFIX):
        return secret[len(PREFIX):-len(SUFFIX)]
    return None

def host_deployments(doc):
    return {d["metadata"]["name"]: d for d in items(doc)
            if d.get("kind") == "Deployment" and d["metadata"]["namespace"] == os.environ["HOST_NS"]}

def template_annotations(dep):
    return (((dep.get("spec") or {}).get("template") or {}).get("metadata") or {}).get("annotations") or {}

def refresh_exp(data):
    # Decodes the exp claim only; the token and its other claims are dropped.
    raw = data.get(REFRESH_KEY)
    if not raw:
        return None
    try:
        payload = base64.b64decode(raw).decode("utf-8").split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("exp")
    except (ValueError, IndexError, AttributeError):
        return None
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        return None
    return exp

def cmd_digests():
    out = {}
    for item in json.load(sys.stdin)["items"]:
        name = item["metadata"]["name"]
        if not name.endswith(SUFFIX):
            continue
        data = item.get("data") or {}
        ann = item["metadata"].get("annotations") or {}
        out[name] = {
            "resourceVersion": item["metadata"]["resourceVersion"],
            "dataSha256": sha(data),
            "keySha256": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in data.items()},
            "refreshExp": refresh_exp(data),
            "refreshBefore": ann.get(REFRESH_BEFORE, ""),
            # Controller bookkeeping only (no credential material lives in
            # annotations); kept so a metadata-only write names the key it moved.
            "annotations": {k: v for k, v in ann.items() if k.startswith(ANN)},
        }
    json.dump(out, sys.stdout, sort_keys=True)

def hcc_env(doc):
    ns, name = os.environ["HCC_NS"], os.environ["HCC_DEPLOY"]
    found = [d for d in items(doc) if d.get("kind") == "Deployment"
             and d["metadata"]["namespace"] == ns and d["metadata"]["name"] == name]
    if len(found) != 1:
        bad_input("expected one %s/%s Deployment, found %d" % (ns, name, len(found)))
    containers = [c for c in found[0]["spec"]["template"]["spec"]["containers"] if c["name"] == name]
    if len(containers) != 1:
        bad_input("expected one %s container in the HCC Deployment" % name)
    env = {e["name"]: e for e in containers[0].get("env") or []}
    out = {}
    # Absent means the HCC default; anything but a plain integer is refused
    # instead of reproducing getEnvInt's silent fallback.
    for key, default in (ROTATE_BEFORE_ENV, RESYNC_ENV):
        entry = env.get(key)
        if entry is None:
            out[key] = default
        elif "valueFrom" in entry or not re.fullmatch(r"[0-9]+", str(entry.get("value", ""))):
            bad_input("%s on the HCC Deployment is not a plain integer value" % key)
        else:
            out[key] = int(entry["value"])
    return out

def cmd_hcc_env():
    env = hcc_env(json.load(sys.stdin))
    print(env[ROTATE_BEFORE_ENV[0]], env[RESYNC_ENV[0]])

def pending_observation(ann, revision, dep, template_revision):
    # bootstrapObservationUpdates: a fresh, applied bootstrap gets its binding,
    # rollout-required=false and consumed/ready-revision written once.
    if ann.get(BOOT_STATE) != "fresh":
        return []
    uid = dep["metadata"].get("uid", "")
    bound = ann.get(BOOT_UID)
    if bound:
        applied = bool(uid) and bound == uid and template_revision != "" and \
            ann.get(BOOT_APPLIED) == template_revision
    else:
        applied = revision != "" and template_revision == revision
    if not applied:
        return []
    spec, status = dep.get("spec") or {}, dep.get("status") or {}
    generation = dep["metadata"].get("generation") or 0
    observed = status.get("observedGeneration") or 0
    replicas = spec.get("replicas", 1)
    desired = {BOOT_UID: uid, BOOT_APPLIED: template_revision, ROLLOUT: "false"}
    if (generation > 0 and observed >= generation and replicas > 0
            and status.get("updatedReplicas") == replicas and status.get("readyReplicas") == replicas
            and status.get("replicas") == replicas):
        desired[BOOT_STATE] = "consumed"
    elif (replicas > 0 and generation > 0 and observed >= generation
            and (status.get("updatedReplicas") or 0) > 0 and (status.get("readyReplicas") or 0) > 0):
        desired[BOOT_READY] = template_revision
    return sorted(k for k, v in desired.items() if ann.get(k) != v)

def classify(name, token, dep, state, rotate_before_ms, now_ms, skew_ms):
    ann = token["annotations"]
    problems = []
    issued, rb = ms(ann.get(ISSUED)), ms(ann.get(REFRESH_BEFORE))
    gfs, re_at = ms(ann.get(GFS_REFRESH_BEFORE)), ms(ann.get(REFRESH_EXPIRES))
    revision = ann.get(SECRET_REVISION, "")
    for label, value in (("issued-at", issued), ("refresh-before", rb),
                         ("gfs-token-refresh-before", gfs), ("refresh-expires-at", re_at)):
        if value is None:
            problems.append("%s annotation missing or unparsable" % label)
    if token.get("refreshExp") is None:
        problems.append("refresh token exp claim missing or unparsable")
    if not revision:
        problems.append("secret-revision annotation missing")
    cls, template_revision, ready = "-", "", False
    if dep is None:
        problems.append("no Deployment for its Host")
    else:
        template_revision = template_annotations(dep).get(TEMPLATE_REVISION, "")
        replicas = (dep.get("spec") or {}).get("replicas", 1)
        ready = ((dep.get("status") or {}).get("readyReplicas") or 0) > 0
        if not ready or replicas == 0 or state == "suspended":
            cls = "C"
        elif not template_revision:
            problems.append("Ready Deployment has no runtime-token-revision")
        elif template_revision == revision:
            cls = "A"
        else:
            cls = "B"
        restarted = ms(template_annotations(dep).get(RESTARTED_AT))
        if restarted is not None and issued is not None and restarted > issued:
            problems.append("Deployment restartedAt %s is after issued-at" % iso(restarted))
        pending = pending_observation(ann, revision, dep, template_revision)
        if pending:
            problems.append("bootstrap observation write pending (%s)" % ", ".join(pending))
    n = None
    if token.get("refreshExp") is not None:
        exp_ms = int(round(token["refreshExp"] * 1000))
        if issued is None or issued >= exp_ms:
            n = exp_ms - rotate_before_ms
        else:
            n = exp_ms - min(rotate_before_ms, (exp_ms - issued) // 2)
    earliest, binding = None, "-"
    if cls in ("A", "C") and None not in (n, rb, gfs):
        earliest, binding = min((n, "rotate-before point"), (rb, "refresh-before"),
                                (gfs, "gfs-token-refresh-before"))
    elif cls == "B" and None not in (gfs, re_at):
        earliest, binding = min((gfs, "gfs-token-refresh-before"),
                                (re_at, "refresh-expires-at (template on an older revision)"))
    if earliest is not None and earliest <= now_ms + skew_ms:
        problems.append("overdue: earliest write %s is not after the snapshot plus %d s" % (
            iso(earliest), skew_ms // 1000))
    return {"host": host_of(name), "class": cls, "earliestMs": earliest, "binding": binding,
            "settled": earliest is not None and not problems, "problems": problems,
            "rotateBeforeMs": n, "refreshBeforeMs": rb, "gfsRefreshBeforeMs": gfs,
            "refreshExpiresMs": re_at, "issuedAtMs": issued, "templateRevision": template_revision,
            "secretRevision": revision, "ready": ready}

def cmd_schedule(raw, epoch, skew, prefix):
    if not re.fullmatch(r"[0-9]+", epoch) or not re.fullmatch(r"[0-9]+", skew):
        bad_input("schedule needs an integer epoch and skew")
    tokens = load(os.path.join(raw, "token-digests.json"))
    workloads = load(os.path.join(raw, "workloads.json"))
    hosts = {h["metadata"]["name"]: ((h.get("status") or {}).get("lifecycle") or {}).get("state", "")
             for h in load(os.path.join(raw, "hosts.json"))["items"]}
    env = hcc_env(workloads)
    deps = host_deployments(workloads)
    if not tokens:
        bad_input("no runtime-token Secret in %s" % raw)
    now_ms, skew_ms = int(epoch) * 1000, int(skew) * 1000
    rows = {}
    for name, token in sorted(tokens.items()):
        host = host_of(name)
        rows[name] = classify(name, token, deps.get(host), hosts.get(host, ""),
                              max(0, env[ROTATE_BEFORE_ENV[0]]) * 1000, now_ms, skew_ms)
    with open(prefix + ".json", "w") as fh:
        json.dump({"snapshotEpoch": int(epoch), "skewSec": int(skew),
                   "rotateBeforeSec": env[ROTATE_BEFORE_ENV[0]], "resyncSec": env[RESYNC_ENV[0]],
                   "secrets": rows}, fh, indent=1, sort_keys=True)
    with open(prefix + ".tsv", "w") as fh:
        fh.write("secret\tclass\tearliest_write\treason\tsettled\trotate_before_point"
                 "\trefresh_before\tgfs_refresh_before\trefresh_expires_at\ttemplate_revision"
                 "\tsecret_revision\n")
        for name, row in rows.items():
            fh.write("\t".join([name, row["class"], iso(row["earliestMs"]),
                                "; ".join(row["problems"]) or row["binding"],
                                "yes" if row["settled"] else "no", iso(row["rotateBeforeMs"]),
                                iso(row["refreshBeforeMs"]), iso(row["gfsRefreshBeforeMs"]),
                                iso(row["refreshExpiresMs"]), short(row["templateRevision"]),
                                short(row["secretRevision"])]) + "\n")
    unsettled = [name for name, row in rows.items() if not row["settled"]]
    for name in unsettled:
        print("%s: %s" % (name, "; ".join(rows[name]["problems"]) or "no schedule"), file=sys.stderr)
    scheduled = [(row["earliestMs"], name) for name, row in rows.items() if row["earliestMs"] is not None]
    first = min(scheduled) if scheduled else (None, "-")
    print("token schedule at %s: %d Secret(s), %d not settled, earliest write %s (%s)" % (
        iso(now_ms), len(rows), len(unsettled), iso(first[0]), first[1]))
    sys.exit(1 if unsettled else 0)

def rotation_lines(paths):
    seen, out = set(), {}
    for path in paths:
        with open(path) as fh:
            for raw in fh:
                if ROTATED_MSG not in raw:
                    continue
                try:
                    row = json.loads(raw[raw.index("{"):])
                except ValueError:
                    bad_input("unparsable rotation log line in %s" % path)
                if row.get("msg") != ROTATED_MSG:
                    continue
                stamp, name = ms(row.get("ts")), row.get("resourceName")
                if stamp is None or not name:
                    bad_input("rotation log line without ts or resourceName in %s" % path)
                key = (stamp, name, row.get("reason"), row.get("rolloutRequired"))
                if key not in seen:
                    seen.add(key)
                    out.setdefault(name, []).append(key)
    return out

def expected_reason(row, at):
    # runtimeTokenRefreshDecision order for the time-based reasons.
    if at >= row["rotateBeforeMs"]:
        return NEAR
    if at >= row["refreshBeforeMs"]:
        return BEFORE
    if at >= row["gfsRefreshBeforeMs"]:
        return GFS
    return None

def judge_write(name, ta, tb, row, lines, dep_b):
    """Returns (problems, admitted detail)."""
    problems = []
    t_w, t_a = ms(tb["annotations"].get(ISSUED)), ms(ta["annotations"].get(ISSUED))
    if t_w is None:
        return ["changed and its issued-at is missing (not an HCC rotation)"], None
    if t_a is not None and t_w == t_a:
        moved = sorted(k for k in set(ta["annotations"]) | set(tb["annotations"])
                       if ta["annotations"].get(k) != tb["annotations"].get(k))
        return ["written without a runtime rotation (issued-at unchanged; data %s; annotations moved: %s)" % (
            "same" if ta["dataSha256"] == tb["dataSha256"] else "CHANGED", ", ".join(moved) or "none")], None
    if row["earliestMs"] is None:
        return ["changed but snapshot A has no schedule for it (%s)" % "; ".join(row["problems"])], None
    cls = row["class"]
    if t_w < row["earliestMs"]:
        problems.append("rotated before its scheduled time (issued-at %s < earliest write %s, class %s, %s)" % (
            iso(t_w), iso(row["earliestMs"]), cls, row["binding"]))
    reason = expected_reason(row, t_w)
    if cls == "B" and reason in (NEAR, BEFORE) and t_w < row["refreshExpiresMs"]:
        problems.append("rotated before its scheduled time (class B keeps the Secret until "
                        "refresh-expires-at %s; issued-at %s)" % (iso(row["refreshExpiresMs"]), iso(t_w)))
    rollout = cls == "C"
    own = [l for l in lines if t_w <= l[0] <= t_w + LOG_MATCH_MS]
    after_a = [l for l in lines if t_a is None or l[0] >= t_a]
    if t_a is not None:
        after_a = [l for l in after_a if l[0] > t_a + LOG_MATCH_MS]
    extra = [l for l in after_a if l not in own]
    if extra:
        problems.append("rotated %d more time(s) between the snapshots (HCC log at %s)" % (
            len(extra), ", ".join(iso(l[0]) for l in extra)))
    if not own:
        problems.append("no HCC log line '%s' within %d s after its issued-at %s" % (
            ROTATED_MSG, LOG_MATCH_MS // 1000, iso(t_w)))
    elif not any(l[2] == reason and l[3] is rollout for l in own):
        problems.append("HCC logged %s, expected reason %s with rolloutRequired %s" % (
            ", ".join("reason %s rolloutRequired %s" % (l[2], str(l[3]).lower()) for l in own),
            reason or "none (no scheduled reason at that time)", str(rollout).lower()))
    ann_a, ann_b = ta["annotations"], tb["annotations"]
    outside = sorted(k for k in set(ann_a) | set(ann_b)
                     if ann_a.get(k) != ann_b.get(k) and k not in ROTATION_KEYS)
    if outside:
        problems.append("annotations outside a rotation changed: %s" % ", ".join(outside))
    revision = ann_b.get(SECRET_REVISION, "")
    if not revision or revision == ann_a.get(SECRET_REVISION):
        problems.append("secret-revision did not move")
    if ann_b.get(BOOT_STATE) != "fresh":
        problems.append("bootstrap-state is %r, a rotation leaves fresh" % ann_b.get(BOOT_STATE))
    if BOOT_READY in ann_b:
        problems.append("bootstrap-ready-revision present after a rotation")
    if rollout:
        uid = (dep_b or {}).get("metadata", {}).get("uid")
        if ann_b.get(BOOT_UID) != uid or ann_b.get(BOOT_APPLIED) != revision:
            problems.append("rollout rotation without a binding to the Deployment and its new revision")
    else:
        if BOOT_UID in ann_b or BOOT_APPLIED in ann_b or ann_b.get(ROLLOUT) != "false":
            problems.append("no-rollout rotation kept a bootstrap binding or rollout-required != false")
    if problems:
        return problems, None
    return [], "on-schedule rotation at %s (earliest write %s, class %s, %s; reason %s, rolloutRequired %s)" % (
        iso(t_w), iso(row["earliestMs"]), cls, row["binding"], reason, str(rollout).lower())

def spec_without_revision(dep):
    spec = json.loads(json.dumps(dep.get("spec") or {}))
    ((spec.get("template") or {}).get("metadata") or {}).get("annotations", {}).pop(TEMPLATE_REVISION, None)
    return spec

def judge_suspended(host, dep_a, dep_b, admitted):
    secret = PREFIX + host + SUFFIX
    revision = admitted.get(secret)
    if revision is None:
        return False, "C3 admitted no rotation of %s" % secret
    if dep_a is None or dep_b is None:
        return False, "Deployment missing from a raw snapshot"
    gen_a, gen_b = dep_a["metadata"].get("generation"), dep_b["metadata"].get("generation")
    if gen_a is None or gen_b != gen_a + 1:
        return False, "generation %s -> %s, one admitted rotation allows +1" % (gen_a, gen_b)
    rev_a = template_annotations(dep_a).get(TEMPLATE_REVISION, "")
    rev_b = template_annotations(dep_b).get(TEMPLATE_REVISION, "")
    if rev_b != revision:
        return False, "template runtime-token-revision %s is not the admitted secret revision %s" % (
            short(rev_b), short(revision))
    if sha(spec_without_revision(dep_a)) != sha(spec_without_revision(dep_b)):
        return False, "the template or spec changed beyond runtime-token-revision"
    return True, ("template runtime-token-revision %s -> %s, generation %s -> %s, matches the rotation "
                  "C3 admitted; suspended Hosts rewrite their template on each scheduled rotation (#1359)"
                  % (short(rev_a), short(rev_b), gen_a, gen_b))

def cmd_compare(argv):
    raw_a, raw_b, snap_a, snap_b, schedule, suspended, admissions, lane_edit = argv[:8]
    logs = argv[8:]
    if not logs:
        bad_input("compare needs at least one HCC log")
    tokens_a = load(os.path.join(raw_a, "token-digests.json"))
    tokens_b = load(os.path.join(raw_b, "token-digests.json"))
    rows = load(schedule)["secrets"]
    deps_a = host_deployments(load(os.path.join(raw_a, "workloads.json")))
    deps_b = host_deployments(load(os.path.join(raw_b, "workloads.json")))
    edit = load(lane_edit) if lane_edit != "-" else None
    lines = rotation_lines(logs)
    decisions, out = [], []
    # C3
    problems, unchanged, admitted = [], 0, {}
    if edit is not None:
        out.append("C3 NOTE lane vacuity edit removed %s on %s (resourceVersion %s); "
                   "a write C3 does not admit, reported with that Secret" % (
                       edit["removed"], edit["secret"], edit["resourceVersion"]))
        decisions.append(("C3", edit["secret"], "LANE-EDIT", "removed %s at resourceVersion %s" % (
            edit["removed"], edit["resourceVersion"])))
    if not tokens_a:
        problems.append("snapshot A holds no runtime-token Secret")
    for name, ta in sorted(tokens_a.items()):
        tb, row = tokens_b.get(name), rows.get(name)
        edited = edit is not None and edit["secret"] == name
        if tb is None:
            problems.append("token Secret %s disappeared" % name)
            decisions.append(("C3", name, "REJECTED", "disappeared"))
            continue
        if row is None:
            problems.append("token Secret %s has no schedule from snapshot A" % name)
            decisions.append(("C3", name, "REJECTED", "no schedule"))
            continue
        if tb["resourceVersion"] == ta["resourceVersion"] and tb["dataSha256"] == ta["dataSha256"]:
            if edited:
                problems.append("token Secret %s shows no write although the lane edited it" % name)
                decisions.append(("C3", name, "REJECTED", "lane edit not visible"))
            else:
                unchanged += 1
                decisions.append(("C3", name, "UNCHANGED", "resourceVersion %s" % ta["resourceVersion"]))
            continue
        if edited and tb["resourceVersion"] == edit["resourceVersion"]:
            reasons = ["changed only by the lane's vacuity edit (no HCC write followed)"]
        else:
            reasons, detail = judge_write(name, ta, tb, row, lines.get(name, []), deps_b.get(row["host"]))
            if edited:
                reasons.append("the lane's vacuity edit (resourceVersion %s) is part of this change and "
                               "is not admitted" % edit["resourceVersion"])
        if reasons:
            problems.append("token Secret %s: %s" % (name, "; ".join(reasons)))
            decisions.append(("C3", name, "REJECTED", "; ".join(reasons)))
        else:
            admitted[name] = tb["annotations"][SECRET_REVISION]
            out.append("C3 NOTE token Secret %s admitted: %s" % (name, detail))
            decisions.append(("C3", name, "ADMITTED", detail))
    for name in sorted(set(tokens_b) - set(tokens_a)):
        problems.append("token Secret %s created between the snapshots" % name)
        decisions.append(("C3", name, "REJECTED", "created between the snapshots"))
    if problems:
        out.extend("C3 FAIL %s" % p for p in problems)
    elif unchanged + len(admitted) != len(tokens_a):
        out.append("C3 FAIL classified %d of %d token Secrets" % (unchanged + len(admitted), len(tokens_a)))
    else:
        out.append("C3 PASS %d token Secrets: %d unchanged, %d admitted on-schedule rotation(s)" % (
            len(tokens_a), unchanged, len(admitted)))
    # C2
    a, b = load(snap_a)["deployments"], load(snap_b)["deployments"]
    problems, unchanged, admitted_c2 = [], 0, 0
    suspended_key = "%s/%s" % (os.environ["HOST_NS"], suspended)
    for key, da in sorted(a.items()):
        db = b.get(key)
        if db is None:
            problems.append("deployment %s disappeared" % key)
            continue
        if db == da:
            unchanged += 1
            continue
        change = "deployment %s generation %s -> %s template %s" % (
            key, da["generation"], db["generation"],
            "same" if da["templateSha256"] == db["templateSha256"] else "changed")
        if key != suspended_key:
            problems.append(change)
            decisions.append(("C2", key, "REJECTED", change))
            continue
        ok, why = judge_suspended(suspended, deps_a.get(suspended), deps_b.get(suspended), admitted)
        if ok:
            admitted_c2 += 1
            out.append("C2 NOTE suspended fixture %s admitted: %s" % (key, why))
            decisions.append(("C2", key, "ADMITTED", why))
        else:
            problems.append("%s; suspended fixture change not admitted: %s" % (change, why))
            decisions.append(("C2", key, "REJECTED", why))
    if problems:
        out.extend("C2 FAIL %s" % p for p in problems)
    else:
        out.append("C2 PASS %d deployments unchanged, %d suspended-fixture template change(s) admitted (#1359)" % (
            unchanged, admitted_c2))
    with open(admissions, "w") as fh:
        fh.write("check\tobject\tdecision\tdetail\n")
        for row in decisions:
            fh.write("\t".join(row) + "\n")
    print("\n".join(out))

def main():
    command, argv = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if command == "digests" and not argv:
        cmd_digests()
    elif command == "hcc-env" and not argv:
        cmd_hcc_env()
    elif command == "schedule" and len(argv) == 4:
        cmd_schedule(*argv)
    elif command == "compare" and len(argv) >= 9:
        cmd_compare(argv)
    else:
        bad_input("usage: digests | hcc-env | schedule <raw> <epoch> <skew> <prefix> | compare ...")

main()
TOKEN_RULES_PY
}

# ─── Sampler (C8, C9) ─────────────────────────────────────────────────
start_sampler() {
  local proxy_selector=$1
  rm -f "$SAMPLER_STOP"
  printf 'epoch\tmcp_proxy_ready\tmcp_fixture_ready\tsuspended_state\tactive_state\n' >"$SERIES"
  (
    while [ ! -e "$SAMPLER_STOP" ]; do
      t0="$(date +%s)"
      proxy="$(pod_ready_by_selector "$proxy_selector" "$MCP_NS" 2>/dev/null || echo error)"
      mcp="$(condition_status mcpserver "$MCP_FIXTURE" "$MCP_NS" Ready 2>/dev/null || echo error)"
      susp="$(host_state "$SUSPENDED_HOST" 2>/dev/null || echo error)"
      act="$(host_state "$ACTIVE_HOST" 2>/dev/null || echo error)"
      printf '%s\t%s\t%s\t%s\t%s\n' "$t0" "$proxy" "$mcp" "${susp:-none}" "${act:-none}" >>"$SERIES"
      [ $(($(date +%s) - t0)) -ge 2 ] || sleep 2
    done
  ) &
  SAMPLER_PID=$!
}

stop_sampler() {
  [ -n "$SAMPLER_PID" ] || return 0
  : >"$SAMPLER_STOP"
  wait "$SAMPLER_PID" || die "sampler exited with an error"
  SAMPLER_PID=""
}

# ─── Fixtures ─────────────────────────────────────────────────────────
apply_fixture_inputs() {
  FIXTURES_CREATED=1
  kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_FIXTURE}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  description: Gate-owned McpServer with external egress for HCC restart continuity.
  image: clerum/mock-mcp-server:test
  imagePullPolicy: IfNotPresent
  transport:
    type: streamableHttp
    url: http://${MCP_FIXTURE}.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
  - dns: ${EGRESS_DNS}
    port: 443
    protocol: TCP
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${CONTEXT_FIXTURE}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextId: ${CONTEXT_FIXTURE}
  description: Gate-owned Context selecting the continuity McpServer.
  mcpServers: [${MCP_FIXTURE}]
---
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${TRIGGER_CONTEXT}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextId: ${TRIGGER_CONTEXT}
  description: Gate-owned Context no Host uses; editing it starts a NetworkPolicy pass.
  mcpServers: []
EOF
  local index peer
  for ((index = 1; index <= PEER_CONTEXTS; index++)); do
    peer="$(peer_context_name "$index")"
    kctl apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: ${peer}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: ${SUITE}
    e2e.clerum.io/run: "${RUN_LABEL}"
spec:
  contextId: ${peer}
  description: Gate-owned peer Context that lengthens the NetworkPolicy pass.
  mcpServers: [${MCP_FIXTURE}]
EOF
  done
}

peer_context_name() {
  truncate_rfc1123 "e2e-hrc-p$(printf '%02d' "$1")-${RUN_ID}"
}

# Every peer Context has its HCC context policy, so the snapshot holds it and
# the triggered pass re-checks it.
peer_contexts_converged() {
  local index peer count
  for ((index = 1; index <= PEER_CONTEXTS; index++)); do
    peer="$(peer_context_name "$index")"
    count="$(kctl get networkpolicies -n "$MCP_NS" -l "clerum.io/context=${peer}" -o name | grep -c . || true)"
    [ "$count" -ge 1 ] || return 1
  done
}

# Clone of the seeded Host (as scripts/e2e/seed-stateless-host.sh does),
# stateless, bound to the fixture Context, without channels.
apply_stateless_host() {
  local name=$1 source_json
  source_json="$(kctl get host "$SOURCE_HOST" -n "$HOST_NS" -o json)" ||
    die "seeded Host ${SOURCE_HOST} is missing"
  jq --arg name "$name" --arg ctx "$CONTEXT_FIXTURE" --arg suite "$SUITE" --arg run "$RUN_LABEL" '{
    apiVersion, kind,
    metadata: {name: $name, namespace: .metadata.namespace,
      labels: {"e2e.clerum.io/suite": $suite, "e2e.clerum.io/run": $run}},
    spec: ((.spec + {host: $name, contextRef: $ctx,
      lifecycle: ((.spec.lifecycle // {}) + {stateless: true})}) | del(.channels))
  }' <<<"$source_json" | kctl apply -f - >/dev/null
}

mcp_fixture_converged() {
  local available ready egress
  available="$(kctl get deployment "$MCP_FIXTURE" -n "$MCP_NS" -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" || return 1
  [ "${available:-0}" -ge 1 ] || return 1
  ready="$(condition_status mcpserver "$MCP_FIXTURE" "$MCP_NS" Ready)" || return 1
  [ "$ready" = True ] || return 1
  egress="$(kctl get networkpolicies -n "$MCP_NS" \
    -l "clerum.io/mcpserver=${MCP_FIXTURE},clerum.io/policy-type=external-egress" -o json |
    jq '[.items[].spec.egress[]?.to[]? | select(.ipBlock)] | length')" || return 1
  [ "${egress:-0}" -ge 1 ]
}

host_active_and_ready() {
  local state available
  state="$(host_state "$1")" || return 1
  available="$(kctl get deployment "$1" -n "$HOST_NS" -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" || return 1
  [ "$state" = active ] && [ "${available:-0}" = 1 ]
}

host_suspended() {
  local state replicas pods
  state="$(host_state "$1")" || return 1
  replicas="$(kctl get deployment "$1" -n "$HOST_NS" -o jsonpath='{.spec.replicas}' 2>/dev/null)" || return 1
  pods="$(kctl get pods -n "$HOST_NS" -l "app=$1" -o name)" || return 1
  [ "$state" = suspended ] && [ "$replicas" = 0 ] && [ -z "$pods" ]
}

host_received_fixture_fleet() {
  kctl logs "deployment/$1" -n "$HOST_NS" --all-containers=true 2>/dev/null |
    grep -qF 'Received 1 authorized MCP server(s)'
}

save_and_accelerate_cadences() {
  local key current saved="" args=() values
  read -r -a values <<<"$CADENCE_TEST_VALUES"
  local i=0
  for key in $CADENCE_KEYS; do
    current="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${key}')].value}")"
    saved+="${key}=${current}"$'\n'
    args+=("${key}=${values[$i]}")
    i=$((i + 1))
  done
  CADENCE_SAVED="$saved"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null
}

restore_cadences() {
  [ -n "$CADENCE_SAVED" ] || return 0
  local key value args=() actual
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    if [ -n "$value" ]; then args+=("${key}=${value}"); else args+=("${key}-"); fi
  done <<<"$CADENCE_SAVED"
  kctl set env "deployment/${HCC_DEPLOY}" -n "$HCC_NS" "${args[@]}" >/dev/null || return 1
  kctl rollout status "deployment/${HCC_DEPLOY}" -n "$HCC_NS" --timeout=180s >/dev/null || return 1
  while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    actual="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" \
      -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name=='${key}')].value}")" || return 1
    [ "$actual" = "$value" ] || { echo "cadence ${key} readback '${actual}' != '${value}'" >&2; return 1; }
  done <<<"$CADENCE_SAVED"
  CADENCE_SAVED=""
}

fixture_objects_absent() {
  # Each read is checked on its own: an empty result means "none left" only
  # after a read that succeeded, so a failed read never verifies the cleanup.
  local labelled_hosts labelled_mcp host_deployments mcp_deployments
  labelled_hosts="$(kctl get hosts -n "$HOST_NS" -l "e2e.clerum.io/run=${RUN_LABEL}" -o name)" || return 1
  labelled_mcp="$(kctl get mcpservers,contexts -n "$MCP_NS" -l "e2e.clerum.io/run=${RUN_LABEL}" -o name)" || return 1
  host_deployments="$(kctl get deployments -n "$HOST_NS" -o name)" || return 1
  mcp_deployments="$(kctl get deployments -n "$MCP_NS" -o name)" || return 1
  [ -z "$labelled_hosts" ] || return 1
  [ -z "$labelled_mcp" ] || return 1
  if grep -qE "/(${SUSPENDED_HOST}|${ACTIVE_HOST})$" <<<"$host_deployments"; then return 1; fi
  if grep -qE "/${MCP_FIXTURE}$" <<<"$mcp_deployments"; then return 1; fi
  return 0
}

teardown() {
  local status=$? cleanup_failed=0 restore_ok=1
  set +e
  stop_sampler
  if [ "$FIXTURES_CREATED" = 1 ]; then
    kctl delete hosts -n "$HOST_NS" -l "e2e.clerum.io/run=${RUN_LABEL}" --wait=true --timeout=180s >/dev/null || cleanup_failed=1
    kctl delete mcpservers,contexts -n "$MCP_NS" -l "e2e.clerum.io/run=${RUN_LABEL}" --wait=true --timeout=180s >/dev/null || cleanup_failed=1
    wait_until 240 "fixture objects and their runtimes to be gone" fixture_objects_absent || cleanup_failed=1
  fi
  restore_cadences || restore_ok=0
  "$MINIKUBE_BIN" -p "$E2E_KUBECONTEXT" ssh -- sudo rm -f "$NODE_KILL_PATH" >/dev/null 2>&1 || cleanup_failed=1
  if ! finalize_hcc_watch_gate_lock "$cleanup_failed" "$restore_ok"; then
    echo "teardown: lock finalization failed (cleanup_failed=${cleanup_failed} restore_ok=${restore_ok})" >&2
    status=1
  fi
  if [ "$cleanup_failed" != 0 ] || [ "$restore_ok" != 1 ]; then
    echo -e "${RED}TEARDOWN FAILED${NC} cleanup_failed=${cleanup_failed} restore_ok=${restore_ok}" >&2
    echo "E2E_HCC_RESTART_CONTINUITY=FAIL"
    status=1
  fi
  exit "$status"
}
trap teardown EXIT

# ─── Kill ─────────────────────────────────────────────────────────────
copy_node_kill_script() {
  "$MINIKUBE_BIN" -p "$E2E_KUBECONTEXT" cp "$NODE_KILL_SCRIPT" "$NODE_KILL_PATH" >/dev/null
}

# kill_hcc <idle|mid-pass>: returns 0 when the controller was killed,
# 3 when mid-pass saw no pass start, 2 on lookup failure.
kill_hcc() {
  local kill_mode=$1 out="${EVIDENCE_DIR}/kill-$((KILLS + 1)).log" pid rc
  : >"$out"
  "$MINIKUBE_BIN" -p "$E2E_KUBECONTEXT" ssh -- sudo sh "$NODE_KILL_PATH" "$kill_mode" "$KILL_WATCH_SEC" >"$out" 2>&1 &
  pid=$!
  if [ "$kill_mode" = mid-pass ]; then
    wait_until 30 "node watcher to arm" grep -q '^ARMED' "$out" || { kill "$pid"; return 2; }
    kctl patch context "$TRIGGER_CONTEXT" -n "$MCP_NS" --type=merge \
      -p "{\"spec\":{\"description\":\"pass trigger $(date +%s%N)\"}}" >/dev/null
  fi
  rc=0
  wait "$pid" || rc=$?
  tr -d '\r' <"$out" >"${out}.clean" && mv "${out}.clean" "$out"
  if grep -q '^KILLED' "$out"; then
    KILLS=$((KILLS + 1))
    return 0
  fi
  grep -q '^NO_PASS_START' "$out" && return 3
  echo "node kill failed (ssh rc=${rc}): $(cat "$out")" >&2
  return 2
}

# ─── Preconditions ────────────────────────────────────────────────────
header "Preconditions"
acquire_hcc_watch_gate_lock || die "could not take the HCC fault-injection lock"
HCC_POD="$(hcc_pod)" || die "no running HCC pod"
image_id="$(hcc_image_id "$HCC_POD")"
[[ "$image_id" == *"$EXPECTED_IMAGE_ID"* ]] ||
  die "running HCC image ${image_id} does not match expected ${EXPECTED_IMAGE_ID}"
ok "HCC runs the expected image (${EXPECTED_IMAGE_ID:0:12})"
assert_request_lane_probe_configured
[ "$(request_lane_status)" = 200 ] || die "HCC request lane is not ready before the run"
staleness_ms="$(kctl get configmap mcp-host-config -n "$HOST_NS" \
  -o jsonpath='{.data.HCC_AUTHORITY_MAX_STALENESS_MS}')" ||
  die "could not read HCC_AUTHORITY_MAX_STALENESS_MS from ${HOST_NS}/mcp-host-config"
[[ "$staleness_ms" =~ ^[1-9][0-9]*$ ]] ||
  die "HCC_AUTHORITY_MAX_STALENESS_MS in ${HOST_NS}/mcp-host-config is '${staleness_ms}', not a positive integer"
AUTHORITY_STALENESS_SEC=$((staleness_ms / 1000))
ok "mcp-host authority staleness bound on this cluster: ${AUTHORITY_STALENESS_SEC} s"
PROXY_SELECTOR="$(selector_of "$MCP_PROXY_DEPLOY" "$MCP_NS")"
[ -n "$PROXY_SELECTOR" ] || die "could not read the mcp-proxy selector"
[ "$(pod_ready_by_selector "$PROXY_SELECTOR" "$MCP_NS")" = True ] || die "mcp-proxy is not Ready before the run"
copy_node_kill_script

# ─── Fixtures ─────────────────────────────────────────────────────────
header "Fixtures"
apply_fixture_inputs
wait_until 240 "McpServer fixture runtime, Ready condition and external egress" mcp_fixture_converged ||
  die "McpServer fixture did not converge (external egress needs ${EGRESS_DNS} to resolve from HCC)"
ok "McpServer fixture ${MCP_FIXTURE} Ready with external egress"
if [ "$PEER_CONTEXTS" -gt 0 ]; then
  wait_until 240 "${PEER_CONTEXTS} peer Contexts to get their context policies" peer_contexts_converged ||
    die "peer Contexts did not converge"
  ok "${PEER_CONTEXTS} peer Contexts converged"
fi

save_and_accelerate_cadences
apply_stateless_host "$SUSPENDED_HOST"
wait_until 420 "stateless fixture ${SUSPENDED_HOST} to suspend" host_suspended "$SUSPENDED_HOST" ||
  die "fixture ${SUSPENDED_HOST} did not suspend (state=$(host_state "$SUSPENDED_HOST" || true))"
restore_cadences || die "could not restore HCC stateless cadences"
ok "stateless fixture ${SUSPENDED_HOST} suspended; HCC cadences restored"

apply_stateless_host "$ACTIVE_HOST"
wait_until 420 "stateless fixture ${ACTIVE_HOST} to be active and Ready" host_active_and_ready "$ACTIVE_HOST" ||
  die "fixture ${ACTIVE_HOST} did not become active"
wait_until 180 "${ACTIVE_HOST} to receive its MCP fleet" host_received_fixture_fleet "$ACTIVE_HOST" ||
  die "fixture ${ACTIVE_HOST} never logged its authorized MCP server"
ok "stateless fixture ${ACTIVE_HOST} active and holding ${MCP_FIXTURE}"

wait_until 180 "HCC request lane after cadence restore" request_lane_ready_now ||
  die "HCC request lane not ready after cadence restore"
HCC_POD="$(hcc_pod)" || die "no running HCC pod after cadence restore"
CADENCE_RESTORED_EPOCH="$(date +%s)"

# Settle the fleet so snapshot A holds only state the kill can disturb.
#
# 1. A new Host's runtime-token Secret moves bootstrap-state fresh -> consumed on
#    the first reconcile that sees its Deployment converged
#    (hostReconciler.ts bootstrapObservationUpdates); wait for it.
fixture_bootstrap_consumed() {
  local state
  state="$(kctl get secret "host-${ACTIVE_HOST}-mcp-host-runtime-tokens" -n "$HOST_NS" \
    -o jsonpath='{.metadata.annotations.clerum\.io/runtime-token-bootstrap-state}')" || return 1
  [ "$state" = consumed ]
}
wait_until 420 "fixture ${ACTIVE_HOST} runtime-token bootstrap to be consumed" fixture_bootstrap_consumed ||
  die "fixture ${ACTIVE_HOST} bootstrap-state never reached consumed"

# 2. The cadence change and restore above are ordinary HCC rollouts. Let more
#    than mcp-host's staleness bound pass after them; a Host that revokes its
#    fleet here was disturbed by a rollout, which is reported on its own and
#    never blamed on the kill.
PRE_SNAPSHOT_SETTLE_SEC=$((AUTHORITY_STALENESS_SEC + 30))
settle_until=$((CADENCE_RESTORED_EPOCH + PRE_SNAPSHOT_SETTLE_SEC))
now="$(date +%s)"
[ "$now" -ge "$settle_until" ] || sleep $((settle_until - now))
since_restore="$(date -u -r "$CADENCE_RESTORED_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
for host in "$SOURCE_HOST" "$ACTIVE_HOST"; do
  # A failed or incomplete read must abort, never count as zero revocations (the
  # same rule as C7): the read must cover the only Host process of the window.
  settle_log="${EVIDENCE_DIR}/settle-host-${host}.log"
  read_host_log_window "$host" "$CADENCE_RESTORED_EPOCH" "$settle_log" ||
    die "precondition: could not prove a complete read of ${host} logs since the setup's HCC rollout (${since_restore})"
  if grep -qE 'MCP authority revoked|Removed server' "$settle_log"; then
    die "precondition: ${host} revoked or removed MCP servers after the setup's HCC rollout ($(grep -cE 'MCP authority revoked|Removed server' "$settle_log") line(s)); see ${settle_log}"
  fi
  ok "precondition: ${host} logged no fleet revocation since the setup's HCC rollout ($(wc -l <"$settle_log") lines read)"
done
ok "fleet settled: fixture bootstrap consumed, no Host revocation after the setup rollouts"

# 3. Runtime-token Secrets (issue #1338, plan Addendum A6). HCC rewrites them
#    on a schedule, restart or not: from the rotate-before point (half the
#    token lifetime by default), refresh-before or gfs-token-refresh-before,
#    and for a Ready Host whose template is on an older revision from
#    gfs-token-refresh-before or refresh-expires-at. With 1 h tokens no run
#    window stays free of these writes, so the lane does not wait for one.
#    Snapshot A must instead hold nothing overdue or pending; C3 then admits
#    only on-schedule rotations. An overdue Secret is rotated at HCC's next
#    resync and a pending bootstrap observation is written on the next
#    reconcile, so snapshot A is retaken for one resync period plus 120 s.
TOKEN_SKEW_SEC=30
hcc_token_env="$(kctl get deployment "$HCC_DEPLOY" -n "$HCC_NS" -o json | token_rules hcc-env)" ||
  die "could not read the HCC runtime-token settings"
read -r ROTATE_BEFORE_SEC RESYNC_SEC <<<"$hcc_token_env"
[[ "$ROTATE_BEFORE_SEC" =~ ^[0-9]+$ ]] && [[ "$RESYNC_SEC" =~ ^[0-9]+$ ]] ||
  die "unexpected HCC runtime-token settings '${hcc_token_env}'"
snapshot_a_settled() {
  local epoch rc=0
  snapshot A
  read -r epoch <"${EVIDENCE_DIR}/raw-A/read-epoch" || die "could not read the snapshot A read time"
  token_rules schedule "${EVIDENCE_DIR}/raw-A" "$epoch" "$TOKEN_SKEW_SEC" "${EVIDENCE_DIR}/token-schedule-A" \
    2>"${EVIDENCE_DIR}/token-schedule-A.reason" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) sleep 10; return 1 ;;
    *) die "runtime-token schedule failed: $(cat "${EVIDENCE_DIR}/token-schedule-A.reason")" ;;
  esac
}
wait_until $((RESYNC_SEC + 120)) "snapshot A with no runtime-token Secret overdue or pending" snapshot_a_settled ||
  die "precondition: a runtime-token Secret is overdue or has a pending write at snapshot A: $(cat "${EVIDENCE_DIR}/token-schedule-A.reason")"
ok "snapshot A: no runtime-token Secret overdue or pending (rotate-before ${ROTATE_BEFORE_SEC} s, resync ${RESYNC_SEC} s; schedule in token-schedule-A.tsv)"

[ "$(jq '.hosts | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 3 ] || die "snapshot A has fewer than 3 Hosts"
[ "$(jq '.mcpservers | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 1 ] || die "snapshot A has no McpServer"
[ "$(jq '[.netpols[] | select(.external)] | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 1 ] ||
  die "snapshot A has no external-egress NetworkPolicy"
ok "snapshot A taken"

HCC_UID="$(hcc_pod_uid "$HCC_POD")"
HCC_RESTARTS_BEFORE="$(hcc_restart_count "$HCC_POD")"

if [ "$VACUITY" = rotate-early ]; then
  # Without issued-at, HCC computes the rotate-before point from the
  # configured margin alone (effectiveRotateBeforeMs), which lies before now,
  # so it rotates this Secret with refresh_token_near_expiry ahead of the
  # schedule taken at snapshot A. The read-back is the object this edit wrote.
  vacuity_secret="host-${ACTIVE_HOST}-mcp-host-runtime-tokens"
  warn "vacuity mutation: removing clerum.io/runtime-token-issued-at from ${vacuity_secret}"
  vacuity_edit="$(kctl annotate secret "$vacuity_secret" -n "$HOST_NS" 'clerum.io/runtime-token-issued-at-' \
    -o jsonpath='{.metadata.resourceVersion}{"|"}{.metadata.annotations.clerum\.io/runtime-token-issued-at}')" ||
    die "vacuity: could not remove issued-at from ${vacuity_secret}"
  [[ "$vacuity_edit" =~ ^[0-9]+\|$ ]] ||
    die "vacuity: unexpected read-back after the edit of ${vacuity_secret}: '${vacuity_edit}'"
  jq -n --arg secret "$vacuity_secret" --arg rv "${vacuity_edit%|}" \
    --arg removed clerum.io/runtime-token-issued-at \
    '{secret: $secret, resourceVersion: $rv, removed: $removed}' >"${EVIDENCE_DIR}/vacuity-edit.json" ||
    die "vacuity: could not record the edit"
fi

# ─── Disruption ───────────────────────────────────────────────────────
header "Disruption (${MODE})"
start_sampler "$PROXY_SELECTOR"
if [ "$MODE" = idle ]; then
  [[ "$(last_pass_event "$HCC_POD")" == result* ]] || die "a NetworkPolicy pass is running; idle mode needs none"
  KILL_EPOCH="$(date +%s)"
  kill_hcc idle || die "idle kill failed"
  ok "HCC killed at rest"
else
  achieved=0
  for attempt in $(seq 1 "$MID_PASS_ATTEMPTS"); do
    HCC_POD="$(hcc_pod)" || die "no running HCC pod before mid-pass attempt ${attempt}"
    [ "$attempt" = 1 ] || copy_node_kill_script
    [ -n "$KILL_EPOCH" ] || KILL_EPOCH="$(date +%s)"
    rc=0
    kill_hcc mid-pass || rc=$?
    [ "$rc" = 0 ] || die "mid-pass kill attempt ${attempt} failed (rc=${rc})"
    wait_until "$RESTART_WAIT_SEC" "HCC container restart after attempt ${attempt}" \
      hcc_restarted_past "$HCC_POD" "$((HCC_RESTARTS_BEFORE + KILLS - 1))" ||
      die "HCC did not restart after attempt ${attempt}"
    save_killed_hcc_log "$HCC_POD"
    previous="$(last_pass_event "$HCC_POD" previous)"
    echo "attempt ${attempt}: last pass event of the killed process: ${previous}" | tee -a "${EVIDENCE_DIR}/mid-pass.log"
    if [[ "$previous" == start* ]]; then
      achieved=1
      break
    fi
    wait_until "$RECOVERY_BETWEEN_SEC" "HCC ready before the next attempt" request_lane_ready_now ||
      die "HCC request lane did not recover between attempts"
  done
  if [ "$achieved" = 1 ]; then
    ok "HCC killed inside a NetworkPolicy pass (${previous}) after ${KILLS} kill(s)"
  else
    fail "no attempt killed HCC inside a pass (${KILLS} kills); the mid-pass claim is not proven"
  fi
fi

# ─── Recovery witnesses ───────────────────────────────────────────────
header "Recovery witnesses"
READY_EPOCH=""
if wait_until "$RECOVERY_WAIT_SEC" "HCC request lane after the kill" request_lane_ready_now; then
  READY_EPOCH="$(date +%s)"
  ok "HCC request lane ready $((READY_EPOCH - KILL_EPOCH)) s after the first kill"
else
  fail "HCC request lane not ready within ${RECOVERY_WAIT_SEC} s of the kill"
fi
HCC_POD="$(hcc_pod)" || die "no running HCC pod after recovery"
if [ "$(hcc_pod_uid "$HCC_POD")" = "$HCC_UID" ] &&
  [ "$(hcc_restart_count "$HCC_POD")" = "$((HCC_RESTARTS_BEFORE + KILLS))" ]; then
  ok "same HCC pod, restartCount ${HCC_RESTARTS_BEFORE} -> $((HCC_RESTARTS_BEFORE + KILLS))"
else
  fail "HCC pod identity/restartCount unexpected (uid $(hcc_pod_uid "$HCC_POD"), restarts $(hcc_restart_count "$HCC_POD"), kills ${KILLS})"
fi
# Mid-pass mode saved the killed container's log after each attempt.
if [ "$MODE" = idle ]; then
  save_killed_hcc_log "$HCC_POD"
fi
if wait_until 60 "a certified NetworkPolicy pass from the restarted HCC" certified_pass_logged "$HCC_POD"; then
  ok "restarted HCC logged a certified NetworkPolicy pass"
else
  fail "restarted HCC logged no certified NetworkPolicy pass"
fi
if [ -n "$READY_EPOCH" ] && [ $((READY_EPOCH - KILL_EPOCH)) -lt "$AUTHORITY_STALENESS_SEC" ]; then
  ok "C6 request lane back before the ${AUTHORITY_STALENESS_SEC} s mcp-host staleness bound"
else
  fail "C6 request lane not back before the ${AUTHORITY_STALENESS_SEC} s mcp-host staleness bound"
fi

if [ "$VACUITY" = roll-host-fixture ]; then
  warn "vacuity mutation: rolling ${ACTIVE_HOST} between the snapshots"
  kctl rollout restart "deployment/${ACTIVE_HOST}" -n "$HOST_NS" >/dev/null
fi

log "settle window ${SETTLE_SEC} s"
sleep "$SETTLE_SEC"
stop_sampler
END_EPOCH="$(date +%s)"

# ─── Assertions ───────────────────────────────────────────────────────
header "Assertions"
snapshot B
# The current HCC process's log, read after snapshot B, covers every rotation
# it made since its start; the killed processes' logs were saved earlier.
kctl logs "pod/$HCC_POD" -n "$HCC_NS" -c host-context-controller >"${EVIDENCE_DIR}/hcc-at-B.log" ||
  die "could not read the log of HCC pod ${HCC_POD} after snapshot B"
compare_snapshots >"${EVIDENCE_DIR}/compare.log"
C1_FAILED=0
C2_FAILED=0
C3_FAIL_LINES=0
C3_EARLY_FIXTURE=0
while IFS= read -r line; do
  check="${line%% *}"
  rest="${line#* }"
  verdict="${rest%% *}"
  detail="${rest#* }"
  case "$verdict" in
    PASS) ok "${check} ${detail}" ;;
    FAIL)
      fail "${check} ${detail}"
      [ "$check" = C1 ] && C1_FAILED=1
      [ "$check" = C2 ] && C2_FAILED=1
      if [ "$check" = C3 ]; then
        C3_FAIL_LINES=$((C3_FAIL_LINES + 1))
        case "$detail" in
          "token Secret host-${ACTIVE_HOST}-mcp-host-runtime-tokens: "*"rotated before its scheduled time"*)
            C3_EARLY_FIXTURE=1 ;;
        esac
      fi
      ;;
    NOTE) warn "${check} ${detail}" ;;
    *) fail "unparsed comparison line: ${line}" ;;
  esac
done <"${EVIDENCE_DIR}/compare.log"

# C7: Host fleets. Hosts with a running pod: the seeded Host and the active fixture.
since="$(date -u -r "$KILL_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
for host in "$SOURCE_HOST" "$ACTIVE_HOST"; do
  host_log="${EVIDENCE_DIR}/host-${host}.log"
  read_host_log_window "$host" "$KILL_EPOCH" "$host_log" ||
    { fail "C7 could not prove a complete read of ${host} logs since the kill (${since})"; continue; }
  if grep -qE 'MCP authority revoked|Removed server' "$host_log"; then
    fail "C7 ${host} revoked or removed MCP servers after the kill: $(grep -cE 'MCP authority revoked|Removed server' "$host_log") line(s)"
  else
    ok "C7 ${host} logged no fleet revocation and no removed server ($(wc -l <"$host_log") lines read)"
  fi
done
gateway_log="${EVIDENCE_DIR}/gateway.log"
kctl logs "deployment/${GATEWAY_DEPLOY}" -n "$HCC_NS" --timestamps --since-time="$since" >"$gateway_log"
read -r inv_total inv_503 inv_200_after < <(python3 -I - "$gateway_log" "${READY_EPOCH:-0}" <<'PY'
import datetime, json, sys
ready = int(sys.argv[2])
total = s503 = ok_after = 0
for raw in open(sys.argv[1]):
    ts, _, body = raw.partition(" ")
    try:
        row = json.loads(body)
    except ValueError:
        continue
    if row.get("route_class") != "host_inventory":
        continue
    total += 1
    epoch = datetime.datetime.fromisoformat(ts[:26].rstrip("Z") + "+00:00").timestamp()
    if row.get("status") == 503:
        s503 += 1
    if row.get("status") == 200 and ready and epoch >= ready:
        ok_after += 1
print(total, s503, ok_after)
PY
)
if [ "${inv_200_after:-0}" -ge 1 ]; then
  ok "C7 witness: gateway served ${inv_200_after} Host inventory 200(s) after recovery (${inv_total} requests, ${inv_503} answered 503 during the restart)"
else
  fail "C7 witness missing: no Host inventory 200 through the gateway after recovery (${inv_total} requests, ${inv_503} 503)"
fi

# C8, C9: continuous samples from the kill to the end of the settle window.
python3 -I - "$SERIES" "$KILL_EPOCH" "$END_EPOCH" <<'PY' >"${EVIDENCE_DIR}/series-verdict.log"
import sys
rows = [line.rstrip("\n").split("\t") for line in open(sys.argv[1])][1:]
start, end = int(sys.argv[2]), int(sys.argv[3])
window = [r for r in rows if start <= int(r[0]) <= end]
def verdict(check, column, bad):
    hits = [r[0] for r in window if bad(r[column])]
    errors = [r[0] for r in window if r[column] == "error"]
    if not window:
        print("%s FAIL no samples in the window" % check)
    elif errors:
        print("%s FAIL %d samples could not be read" % (check, len(errors)))
    elif hits:
        print("%s FAIL %d of %d samples bad, first at %s" % (check, len(hits), len(window), hits[0]))
    else:
        print("%s PASS %d samples over %d s" % (check, len(window), end - start))
verdict("C8", 2, lambda v: v != "True")
verdict("C9", 1, lambda v: "False" in v or v == "none")
susp = sorted({r[3] for r in window})
print("C5 %s suspended fixture states during the window: %s" % ("PASS" if susp == ["suspended"] else "FAIL", susp))
PY
while IFS= read -r line; do
  check="${line%% *}"; rest="${line#* }"; verdict="${rest%% *}"; detail="${rest#* }"
  if [ "$verdict" = PASS ]; then ok "${check} ${detail}"; else fail "${check} ${detail}"; fi
done <"${EVIDENCE_DIR}/series-verdict.log"

# ─── Verdict ──────────────────────────────────────────────────────────
if [ "$VACUITY" = roll-host-fixture ]; then
  if [ "$C1_FAILED" = 1 ] && [ "$C2_FAILED" = 1 ]; then
    echo "E2E_HCC_RESTART_CONTINUITY_VACUITY=DETECTED"
    exit 0
  fi
  echo "E2E_HCC_RESTART_CONTINUITY_VACUITY=MISSED (C1 failed=${C1_FAILED}, C2 failed=${C2_FAILED})"
  exit 1
fi
if [ "$VACUITY" = rotate-early ]; then
  # Exactly one failure in the whole run: C3 on the edited Secret, rotated
  # before its scheduled time.
  if [ "$C3_FAIL_LINES" = 1 ] && [ "$C3_EARLY_FIXTURE" = 1 ] && [ "$e2e_fail" = 1 ]; then
    echo "E2E_HCC_RESTART_CONTINUITY_VACUITY=DETECTED"
    exit 0
  fi
  echo "E2E_HCC_RESTART_CONTINUITY_VACUITY=MISSED (C3 failure lines=${C3_FAIL_LINES}, early rotation of the fixture Secret=${C3_EARLY_FIXTURE}, failures=${e2e_fail})"
  exit 1
fi
if print_results; then
  echo "E2E_HCC_RESTART_CONTINUITY=PASS mode=${MODE}"
  exit 0
fi
echo "E2E_HCC_RESTART_CONTINUITY=FAIL mode=${MODE}"
exit 1
