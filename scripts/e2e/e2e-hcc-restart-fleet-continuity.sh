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
#   C2 no Deployment generation or pod-template hash changes;
#   C3 no mcp-host runtime-token Secret changes (resourceVersion, data hash;
#      values are never printed or stored);
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
# Vacuity: E2E_CONTINUITY_VACUITY=roll-host-fixture rolls the active
# stateless Host fixture between the snapshots. The lane must then see C1 and
# C2 fail; it prints E2E_HCC_RESTART_CONTINUITY_VACUITY=DETECTED and exits 0
# only in that case.
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
#   E2E_CONTINUITY_VACUITY         empty | roll-host-fixture
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
case "$VACUITY" in ''|roll-host-fixture) ;; *) usage "E2E_CONTINUITY_VACUITY must be empty or roll-host-fixture" ;; esac
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
# Bounds of the disruption phase. They also size the run window that no
# token rotation may fall into, so keep them tight: HCC recovers in seconds.
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

# 200 when the request lane serves the v1 inventory, else 503.
request_lane_status() {
  local pod=$1
  kctl exec "pod/$pod" -n "$HCC_NS" -c host-context-controller -- \
    wget -T 10 -t 1 -qO- http://127.0.0.1:8081/api/v1/mcpservers >/dev/null 2>&1 && echo 200 || echo 503
}

request_lane_ready_now() {
  local pod
  pod="$(hcc_pod)" || return 1
  [ "$(request_lane_status "$pod")" = 200 ]
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
# pipe and never written; only names, resourceVersions and digests are kept.
snapshot() {
  local label=$1
  local dir="${EVIDENCE_DIR}/raw-${label}"
  mkdir -p "$dir"
  local ns
  for ns in $FLEET_NAMESPACES; do
    kctl get namespace "$ns" >/dev/null || die "fleet namespace ${ns} is missing"
  done
  kctl get pods,deployments -A -o json >"${dir}/workloads.json"
  kctl get networkpolicies -A -l 'clerum.io/managed-by=host-context-controller' -o json >"${dir}/netpols.json"
  kctl get hosts -n "$HOST_NS" -o json >"${dir}/hosts.json"
  kctl get mcpservers -n "$MCP_NS" -o json >"${dir}/mcpservers.json"
  kctl get secrets -n "$HOST_NS" -o json | python3 -I -c '
import hashlib, json, sys
out = {}
for item in json.load(sys.stdin)["items"]:
    name = item["metadata"]["name"]
    if not name.endswith("-mcp-host-runtime-tokens"):
        continue
    data = item.get("data") or {}
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    ann = item["metadata"].get("annotations") or {}
    out[name] = {
        "resourceVersion": item["metadata"]["resourceVersion"],
        "dataSha256": digest,
        "refreshBefore": ann.get("clerum.io/runtime-token-refresh-before", ""),
        # Controller bookkeeping only (no credential material lives in
        # annotations); kept so a metadata-only write names the key it moved.
        "annotations": {k: v for k, v in ann.items() if k.startswith("clerum.io/")},
    }
json.dump(out, sys.stdout, sort_keys=True)' >"${dir}/token-digests.json"
  FLEET_NAMESPACES="$FLEET_NAMESPACES" HCC_NS="$HCC_NS" HCC_DEPLOY="$HCC_DEPLOY" \
    python3 -I - "$dir" "${EVIDENCE_DIR}/snapshot-${label}.json" <<'PY'
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

# Prints one "<check> PASS|FAIL <detail>" line per check; never prints values.
compare_snapshots() {
  python3 -I - "${EVIDENCE_DIR}/snapshot-A.json" "${EVIDENCE_DIR}/snapshot-B.json" "$SUSPENDED_HOST" <<'PY'
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
# C2 deployments
problems = []
for key, da in a["deployments"].items():
    db = b["deployments"].get(key)
    if db is None:
        problems.append("deployment %s disappeared" % key)
    elif db != da:
        problems.append("deployment %s generation %s -> %s template %s" % (
            key, da["generation"], db["generation"],
            "same" if da["templateSha256"] == db["templateSha256"] else "changed"))
report("C2", problems, "%d deployments unchanged" % len(a["deployments"]))
# C3 runtime-token Secrets
problems = []
for name, ta in a["tokens"].items():
    tb = b["tokens"].get(name)
    if tb is None:
        problems.append("token Secret %s disappeared" % name)
    elif tb["resourceVersion"] != ta["resourceVersion"] or tb["dataSha256"] != ta["dataSha256"]:
        moved = sorted(k for k in set(ta["annotations"]) | set(tb["annotations"])
                       if ta["annotations"].get(k) != tb["annotations"].get(k))
        problems.append("token Secret %s changed (resourceVersion %s -> %s, data %s, annotations %s)" % (
            name, ta["resourceVersion"], tb["resourceVersion"],
            "same" if ta["dataSha256"] == tb["dataSha256"] else "CHANGED",
            ", ".join("%s: %r -> %r" % (k, ta["annotations"].get(k), tb["annotations"].get(k))
                      for k in moved) or "none"))
report("C3", problems, "%d token Secrets unchanged" % len(a["tokens"]))
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
[ "$(request_lane_status "$HCC_POD")" = 200 ] || die "HCC request lane is not ready before the run"
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

# 2. For a healthy Deployment HCC keeps the runtime-token Secret until its
#    refresh-expires-at, then rotates it on the next reconcile, restart or not
#    (hasFreshBootstrapSecretNewerThanHealthyDeployment). Wait until no token
#    (runtime or GFS) expires inside the run window, so a rotation during the
#    run is a defect and never a scheduled one. The window starts here, so it
#    also covers the pre-snapshot settle of step 3 (staleness bound + 30 s).
PRE_SNAPSHOT_SETTLE_SEC=$((AUTHORITY_STALENESS_SEC + 30))
if [ "$MODE" = idle ]; then
  RUN_WINDOW_SEC=$((PRE_SNAPSHOT_SETTLE_SEC + RECOVERY_WAIT_SEC + SETTLE_SEC + 60))
else
  RUN_WINDOW_SEC=$((PRE_SNAPSHOT_SETTLE_SEC + MID_PASS_ATTEMPTS * (KILL_WATCH_SEC + RESTART_WAIT_SEC + RECOVERY_BETWEEN_SEC) + RECOVERY_WAIT_SEC + SETTLE_SEC + 60))
fi
tokens_clear_of_run_window() {
  kctl get secrets -n "$HOST_NS" -o json | python3 -I -c '
import datetime, json, sys
horizon = int(sys.argv[1])
seen = 0
for item in json.load(sys.stdin)["items"]:
    name = item["metadata"]["name"]
    if not name.endswith("-mcp-host-runtime-tokens"):
        continue
    seen += 1
    ann = item["metadata"].get("annotations") or {}
    for key in ("clerum.io/runtime-token-refresh-expires-at", "clerum.io/gfs-token-expires-at"):
        raw = ann.get(key, "")
        if not raw:
            print("%s has no %s" % (name, key), file=sys.stderr)
            sys.exit(1)
        due = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        if due <= horizon:
            print("%s %s at %s" % (name, key, raw), file=sys.stderr)
            sys.exit(1)
sys.exit(0 if seen > 0 else 1)' "$(( $(date +%s) + RUN_WINDOW_SEC ))" 2>"${EVIDENCE_DIR}/token-window.reason"
}
wait_until $((RUN_WINDOW_SEC + 420)) "no token expiring inside the ${RUN_WINDOW_SEC} s run window" \
  tokens_clear_of_run_window ||
  die "a runtime or GFS token still expires inside the ${RUN_WINDOW_SEC} s run window: $(cat "${EVIDENCE_DIR}/token-window.reason")"

# 3. The cadence change and restore above are ordinary HCC rollouts. Let more
#    than mcp-host's staleness bound pass after them; a Host that revokes its
#    fleet here was disturbed by a rollout, which is reported on its own and
#    never blamed on the kill.
settle_until=$((CADENCE_RESTORED_EPOCH + PRE_SNAPSHOT_SETTLE_SEC))
now="$(date +%s)"
[ "$now" -ge "$settle_until" ] || sleep $((settle_until - now))
since_restore="$(date -u -r "$CADENCE_RESTORED_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
for host in "$SOURCE_HOST" "$ACTIVE_HOST"; do
  # A failed read must abort, never count as zero revocations (the same rule as C7).
  settle_log="${EVIDENCE_DIR}/settle-host-${host}.log"
  kctl logs "deployment/${host}" -n "$HOST_NS" --all-containers=true --since-time="$since_restore" >"$settle_log" ||
    die "precondition: could not read ${host} logs since the setup's HCC rollout"
  if grep -qE 'MCP authority revoked|Removed server' "$settle_log"; then
    die "precondition: ${host} revoked or removed MCP servers after the setup's HCC rollout ($(grep -cE 'MCP authority revoked|Removed server' "$settle_log") line(s)); see ${settle_log}"
  fi
  ok "precondition: ${host} logged no fleet revocation since the setup's HCC rollout ($(wc -l <"$settle_log") lines read)"
done
ok "fleet settled: fixture bootstrap consumed, no token expiring in the run window, no Host revocation after the setup rollouts"

snapshot A
[ "$(jq '.hosts | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 3 ] || die "snapshot A has fewer than 3 Hosts"
[ "$(jq '.mcpservers | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 1 ] || die "snapshot A has no McpServer"
[ "$(jq '[.netpols[] | select(.external)] | length' "${EVIDENCE_DIR}/snapshot-A.json")" -ge 1 ] ||
  die "snapshot A has no external-egress NetworkPolicy"
ok "snapshot A taken"

HCC_UID="$(hcc_pod_uid "$HCC_POD")"
HCC_RESTARTS_BEFORE="$(hcc_restart_count "$HCC_POD")"

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
C1_FAILED=0
C2_FAILED=0
while IFS= read -r line; do
  echo "$line" >>"${EVIDENCE_DIR}/compare.log"
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
      ;;
    NOTE) warn "${check} ${detail}" ;;
    *) fail "unparsed comparison line: ${line}" ;;
  esac
done < <(compare_snapshots)

# C7: Host fleets. Hosts with a running pod: the seeded Host and the active fixture.
since="$(date -u -r "$KILL_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"
for host in "$SOURCE_HOST" "$ACTIVE_HOST"; do
  host_log="${EVIDENCE_DIR}/host-${host}.log"
  kctl logs "deployment/${host}" -n "$HOST_NS" --all-containers=true --since-time="$since" >"$host_log" ||
    { fail "C7 could not read ${host} logs"; continue; }
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
if print_results; then
  echo "E2E_HCC_RESTART_CONTINUITY=PASS mode=${MODE}"
  exit 0
fi
echo "E2E_HCC_RESTART_CONTINUITY=FAIL mode=${MODE}"
exit 1
