#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Runner — example-dev (GKE) Mythos workflow suite
# ═══════════════════════════════════════════════════════════════════════
#
# Boots port-forwards against the example-dev GKE cluster, runs the
# Playwright Mythos workflow spec (control-ui/e2e/gke-workflow-mythos.spec.ts),
# then tears the port-forwards down — regardless of success or failure.
#
# The Mythos spec executes 4 long-running workflow recipes in series:
#   1. Agentic Workflow (PDF) — 3 steps
#   2. Competitive Intel (PDF) — 4 steps
#   3. Market Dashboard (XLSX) — 3 steps
#   4. Due Diligence (PDF + XLSX) — 5 steps
# Each workflow has WORKFLOW_TIMEOUT = 720_000 ms inside the spec; with
# per-step timeouts summing to 600s (300+180+120 for the agentic pipeline),
# a worst-case clean run can approach 52 min of wall-clock on GCP-dev
# (higher LLM + DuckDuckGo round-trip latency than minikube). We guard the
# whole thing with `timeout 60m` so a hung workflow still causes PFs to be
# reaped via the EXIT trap.
#
# WHY A WRAPPER (AND NOT `make gcp-dev-pf-all`):
#   The Makefile target uses `wait` which blocks indefinitely. This wrapper
#   owns the PF lifecycle so we can launch them, wait for readiness, run
#   Playwright, and reap them on exit via `trap`.
#
# Prerequisites:
#   - gcloud auth + `gcloud container clusters get-credentials example-dev`
#     has already populated the GKE_DEV context in kubeconfig
#   - `npm ci` inside control-ui/ (Playwright + browsers)
#   - jq, curl on PATH
#   - kubectl access to delete workflowrecipes in sandbox-recipes (the
#     Playwright test runs kubectl delete in cleanup hooks)
#   - clerum-model-secret-mapping + provider LLM API keys (zai used)
#   - web-search MCP image pullable: ghcr.io/aas-ee/open-web-search:latest
#
# Env overrides:
#   CONTEXT         — kubectl context (default: gke_your-gcp-project_us-central1-a_example-dev)
#   ADMIN_USER      — admin username (default: admin)       [propagated but spec hardcodes]
#   ADMIN_PASS      — admin password (default: changeme123!)   [propagated but spec hardcodes]
#   SPEC            — Playwright spec path (default: e2e/gke-workflow-mythos.spec.ts)
#   WALL_TIMEOUT    — outer bash guard (default: 60m). Set to 0 to disable.
#
# Exit code: propagates Playwright's (or 124 if WALL_TIMEOUT fires).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONTEXT="${CONTEXT:-gke_your-gcp-project_us-central1-a_example-dev}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"
SPEC="${SPEC:-e2e/gke-workflow-mythos.spec.ts}"
WALL_TIMEOUT="${WALL_TIMEOUT:-60m}"

UI_PORT=3000
API_PORT=8090
UI_NS=control-plane
API_NS=control-plane
UI_SVC=control-ui
API_SVC=control-api

log()  { printf '[e2e-example-dev-mythos] %s\n' "$*" >&2; }
die()  { printf '[e2e-example-dev-mythos] ERROR: %s\n' "$*" >&2; exit 1; }

# ─── Prerequisite checks ──────────────────────────────────────────────
command -v kubectl >/dev/null 2>&1 || die "kubectl not on PATH"
command -v jq      >/dev/null 2>&1 || die "jq not on PATH"
command -v curl    >/dev/null 2>&1 || die "curl not on PATH"
command -v npx     >/dev/null 2>&1 || die "npx not on PATH"

# Context must exist; fail fast with a readable error rather than a
# cryptic kubectl "context not found" later inside the PF loop.
if ! kubectl config get-contexts -o name | grep -Fxq "$CONTEXT"; then
  die "kubectl context '$CONTEXT' not found. Run 'gcloud container clusters get-credentials example-dev --zone us-central1-a --project your-gcp-project' first."
fi

# Reject if the literal dev services aren't reachable — typical on a
# freshly-torn-down cluster. Cheaper to fail here than during port-forward.
kubectl --context "$CONTEXT" get svc "$UI_SVC"  -n "$UI_NS"  >/dev/null 2>&1 || die "svc/$UI_SVC not found in $UI_NS on $CONTEXT"
kubectl --context "$CONTEXT" get svc "$API_SVC" -n "$API_NS" >/dev/null 2>&1 || die "svc/$API_SVC not found in $API_NS on $CONTEXT"

# The spec invokes `kubectl delete workflowrecipe` against the current
# default context. Make sure kubectl's active context is the dev cluster
# so cleanup hooks don't hit the wrong cluster if the user forgot to
# switch. We set it explicitly for the process tree via KUBECONFIG-level
# mutation is too intrusive; instead, warn if mismatched.
CURRENT_CTX="$(kubectl config current-context 2>/dev/null || echo '')"
if [ "$CURRENT_CTX" != "$CONTEXT" ]; then
  log "WARN: current-context is '$CURRENT_CTX' (wanted '$CONTEXT')."
  log "WARN: The spec's cleanup hooks call 'kubectl delete workflowrecipe' against current-context."
  log "WARN: Switching current-context to '$CONTEXT' for this run."
  kubectl config use-context "$CONTEXT" >/dev/null
fi

# ─── Port-forward lifecycle ───────────────────────────────────────────
PF_PIDS=()
cleanup() {
  local ec=$?
  if [ ${#PF_PIDS[@]} -gt 0 ]; then
    log "Tearing down ${#PF_PIDS[@]} port-forward(s)"
    for pid in "${PF_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
    # Give kubectl a moment to close sockets before the script exits;
    # avoids "address already in use" on rapid re-runs.
    wait 2>/dev/null || true
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

log "Starting port-forwards against $CONTEXT"
kubectl --context "$CONTEXT" port-forward "svc/$UI_SVC"  -n "$UI_NS"  "${UI_PORT}:${UI_PORT}"   >/tmp/pf-control-ui.log  2>&1 &
PF_PIDS+=($!)
kubectl --context "$CONTEXT" port-forward "svc/$API_SVC" -n "$API_NS" "${API_PORT}:${API_PORT}" >/tmp/pf-control-api.log 2>&1 &
PF_PIDS+=($!)

# Wait for PFs to bind. We poll both endpoints because kubectl's PID
# appears immediately but the TCP bind happens a few ms later, and the
# first Playwright request would race and get ECONNREFUSED.
log "Waiting for port-forwards to become ready..."
for i in $(seq 1 40); do
  ui_ok=0 api_ok=0
  curl -fsS -o /dev/null --max-time 2 "http://localhost:${UI_PORT}"           && ui_ok=1 || true
  # /health is public; prefer it over /api/* which requires auth
  curl -fsS -o /dev/null --max-time 2 "http://localhost:${API_PORT}/health"   && api_ok=1 || true
  if [ "$ui_ok" = 1 ] && [ "$api_ok" = 1 ]; then
    log "  OK UI=:${UI_PORT} API=:${API_PORT} are reachable"
    break
  fi
  if [ "$i" = 40 ]; then
    log "Port-forwards did not become ready in 20s. Logs:"
    log "--- /tmp/pf-control-ui.log ---"
    tail -n 20 /tmp/pf-control-ui.log >&2 || true
    log "--- /tmp/pf-control-api.log ---"
    tail -n 20 /tmp/pf-control-api.log >&2 || true
    die "Port-forward readiness timeout"
  fi
  sleep 0.5
done

# ─── Run Playwright ───────────────────────────────────────────────────
cd "$REPO_ROOT/control-ui"

log "Running Playwright Mythos spec: $SPEC"
log "  Expected duration: up to ~52 min worst case (4 workflows x 13 min each)"
log "  Outer wall-clock guard: $WALL_TIMEOUT"

# Env vars for the Playwright process. Exported (not inline on the npx
# line) so they survive a `bash -c` re-shell when wrapped by `timeout`.
# Previously these were inline-assigned on the run_playwright function
# body; `declare -f` preserved the textual body but `bash -c` launched
# a fresh shell where $SPEC / $API_PORT / etc. were unset. Result: spec
# filter silently became empty and Playwright ran the entire testDir.
export CONTROL_API_URL="http://localhost:${API_PORT}"
export CONTROL_UI_URL="http://localhost:${UI_PORT}"
export ADMIN_USER ADMIN_PASS SPEC

run_playwright() {
  npx playwright test "$SPEC" --reporter=list
}

if [ "$WALL_TIMEOUT" = "0" ] || [ -z "$WALL_TIMEOUT" ]; then
  run_playwright
else
  # `timeout` on macOS requires coreutils (gtimeout). Fall back gracefully.
  if command -v timeout >/dev/null 2>&1; then
    timeout --preserve-status --signal=TERM --kill-after=30s "$WALL_TIMEOUT" bash -c "$(declare -f run_playwright); run_playwright"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --preserve-status --signal=TERM --kill-after=30s "$WALL_TIMEOUT" bash -c "$(declare -f run_playwright); run_playwright"
  else
    log "WARN: neither 'timeout' nor 'gtimeout' on PATH — running without outer wall-clock guard"
    run_playwright
  fi
fi
