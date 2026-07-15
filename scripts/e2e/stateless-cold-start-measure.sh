#!/usr/bin/env bash
# ======================================================================
# Phase 0 — Stateless host cold-start measurement (stateless-agents)
#
# Measures the cold-start latency of a stateless Host by cycling its
# Deployment between replicas=0 and replicas=1 and timing the Kubernetes
# pod milestones per cycle:
#
#   trigger            — the moment this script issues `kubectl scale --replicas=1`
#   PodScheduled       — pod condition (W2 proxy: scale → scheduled)
#   container started  — containerStatuses[0].state.running.startedAt
#   Ready              — pod Ready condition (W7 proxy: started → Ready)
#
# When host-context-controller emits `[StatelessWake] host=<h> generation=<g>
# phase=<phase> ts=<ms>` lines during a cycle they are captured and annotated
# with source=logs; pure scale cycles do not exercise the wake path, so their
# absence is tolerated. Kubernetes condition timestamps are annotated with
# source=k8s.
#
# GATE: p95 of total (trigger → Ready) must be < PHASE0_P95_TOTAL_BUDGET_MS
# (default 120000 ms). Per-phase budget targets (W2 < 1s scale→scheduled
# proxy, W7 < 5s started→Ready proxy) are reported as OVER_BUDGET:<phase>
# in the artifact and on stdout when exceeded — visible but not gate-fatal.
#
# CAVEATS (recorded in the artifact):
#   - Kubernetes condition timestamps have 1-second resolution; sub-second
#     phase budgets (W2 < 1s) can only be checked at that granularity.
#   - The trigger timestamp comes from the local clock while pod milestones
#     come from the API server clock; on minikube both run on one machine.
#   - minikube is NOT representative of cloud cold starts: image pull and
#     PD-attach latencies are ~0 on local-path storage. Treat absolute
#     numbers as a lower bound; the per-phase breakdown is the signal.
#
# Usage:
#   KUBECONTEXT=clerum-test bash scripts/e2e/stateless-cold-start-measure.sh
#   E2E_STATELESS_HOST_REF=chatllm-stateless PHASE0_CYCLES=10 \
#     PHASE0_ARTIFACT=.e2e-artifacts/phase0-cold-start.json ...
# ======================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/e2e-lib.sh"
require_safe_kube_context

STATELESS_HOST_REF="${E2E_STATELESS_HOST_REF:-chatllm-stateless}"
PHASE0_CYCLES="${PHASE0_CYCLES:-10}"
PHASE0_ARTIFACT="${PHASE0_ARTIFACT:-.e2e-artifacts/phase0-cold-start.json}"
PHASE0_P95_TOTAL_BUDGET_MS="${PHASE0_P95_TOTAL_BUDGET_MS:-120000}"
PHASE0_W2_BUDGET_MS="${PHASE0_W2_BUDGET_MS:-1000}"
PHASE0_W7_BUDGET_MS="${PHASE0_W7_BUDGET_MS:-5000}"
PHASE0_SCALE_DOWN_TIMEOUT="${PHASE0_SCALE_DOWN_TIMEOUT:-120}"
PHASE0_READY_TIMEOUT="${PHASE0_READY_TIMEOUT:-180}"
HCC_NS="${HCC_NS:-control-plane}"
HCC_DEPLOY="${HCC_DEPLOY:-host-context-controller}"

CYCLES_FILE="$(mktemp "${TMPDIR:-/tmp}/phase0-cycles.XXXXXX")"
cleanup_on_exit() {
  local status=$?
  rm -f "$CYCLES_FILE" >/dev/null 2>&1
  exit "$status"
}
trap cleanup_on_exit EXIT

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
now_rfc3339() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))'; }

pod_diagnostics() {
  echo "--- diagnostics for app=${STATELESS_HOST_REF} in ${MCP_HOST_NS} ---" >&2
  kctl get pods -n "$MCP_HOST_NS" -l "app=${STATELESS_HOST_REF}" -o wide 2>/dev/null >&2 || true
  kctl describe pod -n "$MCP_HOST_NS" -l "app=${STATELESS_HOST_REF}" 2>/dev/null | tail -30 >&2 || true
  kctl logs -n "$MCP_HOST_NS" -l "app=${STATELESS_HOST_REF}" --tail=30 2>/dev/null >&2 || true
}

wait_for_pods_gone() {
  local timeout=$1 elapsed=0 count
  while [ "$elapsed" -lt "$timeout" ]; do
    count=$(kctl get pods -n "$MCP_HOST_NS" -l "app=${STATELESS_HOST_REF}" \
      -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w | tr -d ' ')
    [ "${count:-1}" -eq 0 ] && return 0
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

wait_for_ready_pod_json() {
  # Prints the full pod JSON of the first Ready, non-deleting pod on success.
  local timeout=$1 elapsed=0 name
  while [ "$elapsed" -lt "$timeout" ]; do
    if name=$(ready_pod_name "$MCP_HOST_NS" "app=${STATELESS_HOST_REF}"); then
      kctl get pod "$name" -n "$MCP_HOST_NS" -o json
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  return 1
}

header "Phase 0 — Prerequisites"

if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 is required for timestamp math and the JSON artifact"
  print_results
  exit 1
fi

stateless_flag=$(kctl get host "$STATELESS_HOST_REF" -n "$MCP_HOST_NS" \
  -o jsonpath='{.spec.lifecycle.stateless}' 2>/dev/null || echo "")
if [ "$stateless_flag" = "true" ]; then
  ok "Host '${STATELESS_HOST_REF}' exists with spec.lifecycle.stateless=true"
else
  fail "Host '${STATELESS_HOST_REF}' missing or spec.lifecycle.stateless != true (got '${stateless_flag:-<absent>}'). Seed it first: CONTEXT=<ctx> scripts/minikube/seed-test-data.sh"
  print_results
  exit 1
fi

if kctl get deployment "$STATELESS_HOST_REF" -n "$MCP_HOST_NS" >/dev/null 2>&1; then
  ok "Deployment '${STATELESS_HOST_REF}' exists in ${MCP_HOST_NS}"
else
  fail "Deployment '${STATELESS_HOST_REF}' not found in ${MCP_HOST_NS} — HCC has not reconciled the Host CR"
  kctl get deployments -n "$MCP_HOST_NS" 2>/dev/null || true
  print_results
  exit 1
fi

header "Phase 0 — Cold-start cycles (${PHASE0_CYCLES})"

cycle=1
while [ "$cycle" -le "$PHASE0_CYCLES" ]; do
  log "Cycle ${cycle}/${PHASE0_CYCLES}: scaling ${STATELESS_HOST_REF} to 0..."
  kctl scale deployment "$STATELESS_HOST_REF" -n "$MCP_HOST_NS" --replicas=0 >/dev/null

  if wait_for_pods_gone "$PHASE0_SCALE_DOWN_TIMEOUT"; then
    ok "cycle ${cycle}: pods gone after scale-to-0"
  else
    fail "cycle ${cycle}: pods still present ${PHASE0_SCALE_DOWN_TIMEOUT}s after scale-to-0 (HCC may be re-scaling the deployment, or termination is stuck)"
    pod_diagnostics
    print_results
    exit 1
  fi

  # Detect interference: a pod re-appearing before WE scale up would corrupt
  # the trigger timestamp. Fail loudly instead of recording a bogus cycle.
  lingering=$(kctl get pods -n "$MCP_HOST_NS" -l "app=${STATELESS_HOST_REF}" \
    -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w | tr -d ' ')
  if [ "${lingering:-0}" -ne 0 ]; then
    fail "cycle ${cycle}: a pod re-appeared before scale-up was issued — an external actor (HCC?) is fighting the scale; measurement would be invalid"
    pod_diagnostics
    print_results
    exit 1
  fi

  cycle_log_since="$(now_rfc3339)"
  trigger_ms="$(now_ms)"
  kctl scale deployment "$STATELESS_HOST_REF" -n "$MCP_HOST_NS" --replicas=1 >/dev/null
  log "cycle ${cycle}: scale-to-1 issued at ${trigger_ms}"

  if ! pod_json=$(wait_for_ready_pod_json "$PHASE0_READY_TIMEOUT"); then
    fail "cycle ${cycle}: pod not Ready ${PHASE0_READY_TIMEOUT}s after scale-to-1"
    pod_diagnostics
    print_results
    exit 1
  fi

  hcc_wake_lines=$(kctl logs "deploy/${HCC_DEPLOY}" -n "$HCC_NS" \
    --since-time="$cycle_log_since" 2>/dev/null \
    | grep -F "[StatelessWake] host=${STATELESS_HOST_REF} " || true)

  if ! POD_JSON="$pod_json" TRIGGER_MS="$trigger_ms" CYCLE="$cycle" \
       HCC_WAKE_LINES="$hcc_wake_lines" python3 - >> "$CYCLES_FILE" <<'PY'
import json, os, re, sys
from datetime import datetime

def iso_ms(value):
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)

pod = json.loads(os.environ["POD_JSON"])
trigger_ms = int(os.environ["TRIGGER_MS"])
conds = {c.get("type"): c for c in pod.get("status", {}).get("conditions", [])}
scheduled = conds.get("PodScheduled", {})
ready = conds.get("Ready", {})
if scheduled.get("status") != "True" or ready.get("status") != "True":
    print(f"pod conditions incomplete: PodScheduled={scheduled.get('status')} Ready={ready.get('status')}", file=sys.stderr)
    raise SystemExit(1)
statuses = pod.get("status", {}).get("containerStatuses", [])
started_at = None
if statuses:
    started_at = statuses[0].get("state", {}).get("running", {}).get("startedAt")
if not started_at:
    print("containerStatuses[0].state.running.startedAt missing — container not running?", file=sys.stderr)
    raise SystemExit(1)

scheduled_ms = iso_ms(scheduled.get("lastTransitionTime"))
started_ms = iso_ms(started_at)
ready_ms = iso_ms(ready.get("lastTransitionTime"))
if scheduled_ms is None or ready_ms is None:
    print("missing lastTransitionTime on PodScheduled/Ready condition", file=sys.stderr)
    raise SystemExit(1)

wake_phases = []
pattern = re.compile(r"\[StatelessWake\] host=\S+ generation=(\S+) phase=(\S+) ts=(\d+)")
for line in os.environ.get("HCC_WAKE_LINES", "").splitlines():
    m = pattern.search(line)
    if m:
        wake_phases.append({
            "generation": m.group(1),
            "phase": m.group(2),
            "ts_ms": int(m.group(3)),
            "source": "logs",
        })

record = {
    "cycle": int(os.environ["CYCLE"]),
    "pod": pod.get("metadata", {}).get("name"),
    "trigger_ms": trigger_ms,
    "scheduled_ms": scheduled_ms,
    "started_ms": started_ms,
    "ready_ms": ready_ms,
    "phases_ms": {
        "scale_to_scheduled": scheduled_ms - trigger_ms,
        "scheduled_to_started": started_ms - scheduled_ms,
        "started_to_ready": ready_ms - started_ms,
        "total": ready_ms - trigger_ms,
    },
    "phase_sources": {
        "scale_to_scheduled": "k8s",
        "scheduled_to_started": "k8s",
        "started_to_ready": "k8s",
        "total": "k8s",
    },
    "hcc_wake_phases": wake_phases,
}
print(json.dumps(record))
PY
  then
    fail "cycle ${cycle}: could not extract pod milestone timestamps"
    pod_diagnostics
    print_results
    exit 1
  fi
  ok "cycle ${cycle}: recorded"
  cycle=$((cycle + 1))
done

header "Phase 0 — Aggregate + gate"

mkdir -p "$(dirname "$PHASE0_ARTIFACT")"
if CYCLES_FILE="$CYCLES_FILE" ARTIFACT="$PHASE0_ARTIFACT" \
   HOST_REF="$STATELESS_HOST_REF" \
   TOTAL_BUDGET_MS="$PHASE0_P95_TOTAL_BUDGET_MS" \
   W2_BUDGET_MS="$PHASE0_W2_BUDGET_MS" \
   W7_BUDGET_MS="$PHASE0_W7_BUDGET_MS" python3 - <<'PY'
import json, math, os, sys

records = []
with open(os.environ["CYCLES_FILE"]) as fh:
    for line in fh:
        line = line.strip()
        if line:
            records.append(json.loads(line))
if not records:
    print("no cycle records collected", file=sys.stderr)
    raise SystemExit(1)

def percentile(values, pct):
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]

phases = ["scale_to_scheduled", "scheduled_to_started", "started_to_ready", "total"]
summary = {}
for phase in phases:
    values = [r["phases_ms"][phase] for r in records]
    summary[phase] = {
        "p50_ms": percentile(values, 50),
        "p95_ms": percentile(values, 95),
        "min_ms": min(values),
        "max_ms": max(values),
    }

budgets = {
    "scale_to_scheduled": {"budget_ms": int(os.environ["W2_BUDGET_MS"]), "wake_phase": "W2"},
    "started_to_ready": {"budget_ms": int(os.environ["W7_BUDGET_MS"]), "wake_phase": "W7"},
}
over_budget = []
for phase, meta in budgets.items():
    if summary[phase]["p95_ms"] > meta["budget_ms"]:
        over_budget.append(
            f"OVER_BUDGET:{phase} ({meta['wake_phase']} proxy) p95={summary[phase]['p95_ms']}ms budget={meta['budget_ms']}ms"
        )

total_budget = int(os.environ["TOTAL_BUDGET_MS"])
gate_pass = summary["total"]["p95_ms"] < total_budget

artifact = {
    "suite": "stateless-cold-start-measure",
    "host_ref": os.environ["HOST_REF"],
    "cycles": records,
    "summary_ms": summary,
    "gate": {
        "metric": "total.p95_ms",
        "budget_ms": total_budget,
        "observed_ms": summary["total"]["p95_ms"],
        "pass": gate_pass,
    },
    "over_budget": over_budget,
    "notes": [
        "Kubernetes condition timestamps have 1-second resolution; sub-second budgets (W2 < 1s) are checked at that granularity.",
        "trigger_ms uses the local clock; pod milestones use the API server clock (same machine on minikube).",
        "minikube is not representative of cloud cold starts: image pull and PD-attach are ~0 on local-path storage.",
        "hcc_wake_phases entries are parsed from host-context-controller logs (source=logs) and are absent for pure scale cycles.",
    ],
}
with open(os.environ["ARTIFACT"], "w") as fh:
    json.dump(artifact, fh, indent=2)
    fh.write("\n")

for phase in phases:
    s = summary[phase]
    print(f"  {phase}: p50={s['p50_ms']}ms p95={s['p95_ms']}ms min={s['min_ms']}ms max={s['max_ms']}ms")
for entry in over_budget:
    print(f"  {entry}")
print(f"  gate total.p95={summary['total']['p95_ms']}ms budget={total_budget}ms pass={gate_pass}")
raise SystemExit(0 if gate_pass else 1)
PY
then
  ok "cold-start gate passed (artifact: ${PHASE0_ARTIFACT})"
else
  fail "cold-start gate FAILED: p95 total >= ${PHASE0_P95_TOTAL_BUDGET_MS}ms — see artifact: ${PHASE0_ARTIFACT}"
fi

print_results
