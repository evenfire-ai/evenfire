#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E Runner — minikube (clerum-test) Registry Playwright suite
# ═══════════════════════════════════════════════════════════════════════
#
# Boots port-forwards against the local minikube cluster (`clerum-test`)
# and runs the 4 Registry Playwright specs that validate the full
# registry → install → CRD → HCC → workload pipeline.
#
# Specs executed (in order, serial):
#   1. e2e/registry-install.spec.ts        — Catalog + install/upgrade/uninstall lifecycle
#   2. e2e/registry-airtable-e2e.spec.ts   — Airtable MCP deploy + CRUD + XLSX artifact (skipped if creds missing)
#   3. e2e/registry-mythos-workflow.spec.ts — WorkflowRecipe 3-step agentic pipeline + PDF
#   4. e2e/registry-ssrf-attack.spec.ts    — Defense-in-depth SSRF rejection chain
#
# This wrapper is the MINIKUBE twin of `run-e2e-clerum-dev-*.sh` — same
# PF lifecycle, same readiness polling, same `--reporter=list` flushing
# pattern, same outer `timeout` wall-clock guard. Kept identical on
# purpose so the two environments don't diverge in tooling semantics.
#
# WHY A WRAPPER:
#   - `make minikube-pf-all` uses `wait` which blocks indefinitely
#   - Playwright in the background (no reporter) buffers stdout → log silence
#   - Without `trap cleanup` a failed run leaves orphan kubectl PFs
#     that block subsequent runs with "address already in use"
#
# Prerequisites:
#   - minikube profile `clerum-test` Running with registry + control-plane deployed
#     (typically `make minikube-setup` then `make minikube-deploy-all`)
#   - `npm ci` inside control-ui/ (Playwright + browsers installed)
#   - jq, curl, kubectl on PATH
#
# Env overrides:
#   CONTEXT            — kubectl context (default: clerum-test)
#   ADMIN_USER         — admin username (default: admin)
#   ADMIN_PASS         — admin password (default: changeme123!)
#   SPECS              — space-separated Playwright spec paths (default: all 4 registry specs)
#   AIRTABLE_API_KEY   — optional; if unset, airtable spec self-skips via test.skip()
#   AIRTABLE_BASE_ID   — optional (same)
#   WALL_TIMEOUT       — outer bash guard (default: 60m). Set to 0 to disable.
#   PLAYWRIGHT_TIMEOUT — per-test timeout in ms passed to --timeout (default: 900000 = 15m)
#
# Exit code: propagates Playwright's (or 124 if WALL_TIMEOUT fires).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── Auto-load .env ───────────────────────────────────────────────────
# The airtable spec (control-ui/e2e/registry-airtable-e2e.spec.ts) reads
# AIRTABLE_API_KEY and AIRTABLE_BASE_ID from process.env and self-skips
# via `test.skip()` when missing. Previously the runner never sourced
# `.env`, so the 13 airtable tests silently skipped — a SILENT NO-OP
# that masked real e2e coverage.
#
# Convention is: creds live in .env (see spec header line 17 and CLAUDE.md
# `.env` contract). The same pattern is used by Makefile target
# `minikube-apply-secrets` which sources .env for LLM API keys before
# kubectl. Mirroring it here means the 3 surfaces — Makefile secret
# apply, Playwright runner, and spec — all agree on a single source
# of truth for credentials: the local `.env`.
#
# `set -a` auto-exports every var defined by the sourced file; `set +a`
# stops that behavior right after so we don't pollute the rest of the
# script. Preserves caller-provided env vars (they win over .env).
if [ -f "$REPO_ROOT/.env" ]; then
  # Only export vars not already set by caller (precedence: CLI env > .env > defaults)
  set -a
  # shellcheck disable=SC1091  # intentional: .env path is known at runtime
  . "$REPO_ROOT/.env"
  set +a
fi

CONTEXT="${CONTEXT:-clerum-test}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-changeme123!}"
SPECS="${SPECS:-e2e/registry-install.spec.ts e2e/registry-airtable-e2e.spec.ts e2e/registry-mythos-workflow.spec.ts e2e/registry-ssrf-attack.spec.ts}"
WALL_TIMEOUT="${WALL_TIMEOUT:-60m}"
PLAYWRIGHT_TIMEOUT="${PLAYWRIGHT_TIMEOUT:-900000}"

# ─── Service topology (minikube == dev, only context differs) ──────────
UI_PORT=3000
API_PORT=8090
REGISTRY_PORT=8085
UI_NS=control-plane
API_NS=control-plane
REGISTRY_NS=registry
UI_SVC=control-ui
API_SVC=control-api
REGISTRY_SVC=registry-api

log() { printf '[e2e-minikube-registry] %s\n' "$*" >&2; }
die() { printf '[e2e-minikube-registry] ERROR: %s\n' "$*" >&2; exit 1; }

# ─── Prerequisite checks ──────────────────────────────────────────────
command -v kubectl >/dev/null 2>&1 || die "kubectl not on PATH"
command -v jq      >/dev/null 2>&1 || die "jq not on PATH"
command -v curl    >/dev/null 2>&1 || die "curl not on PATH"
command -v npx     >/dev/null 2>&1 || die "npx not on PATH"

# Context must exist; fail fast with a readable error.
if ! kubectl config get-contexts -o name | grep -Fxq "$CONTEXT"; then
  die "kubectl context '$CONTEXT' not found. Run 'make minikube-setup' first."
fi

# Reject if the literal services aren't reachable.
kubectl --context "$CONTEXT" get svc "$UI_SVC"       -n "$UI_NS"       >/dev/null 2>&1 || die "svc/$UI_SVC not found in $UI_NS on $CONTEXT"
kubectl --context "$CONTEXT" get svc "$API_SVC"      -n "$API_NS"      >/dev/null 2>&1 || die "svc/$API_SVC not found in $API_NS on $CONTEXT"
kubectl --context "$CONTEXT" get svc "$REGISTRY_SVC" -n "$REGISTRY_NS" >/dev/null 2>&1 || die "svc/$REGISTRY_SVC not found in $REGISTRY_NS on $CONTEXT"

# The specs invoke `kubectl delete` against the current default context
# during cleanup. Warn if mismatched and switch for this run.
CURRENT_CTX="$(kubectl config current-context 2>/dev/null || echo '')"
if [ "$CURRENT_CTX" != "$CONTEXT" ]; then
  log "WARN: current-context is '$CURRENT_CTX' (wanted '$CONTEXT')."
  log "WARN: The specs' cleanup hooks call 'kubectl delete' against current-context."
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
kubectl --context "$CONTEXT" port-forward "svc/$UI_SVC"       -n "$UI_NS"       "${UI_PORT}:${UI_PORT}"             >/tmp/pf-control-ui.log   2>&1 &
PF_PIDS+=($!)
kubectl --context "$CONTEXT" port-forward "svc/$API_SVC"      -n "$API_NS"      "${API_PORT}:${API_PORT}"           >/tmp/pf-control-api.log  2>&1 &
PF_PIDS+=($!)
kubectl --context "$CONTEXT" port-forward "svc/$REGISTRY_SVC" -n "$REGISTRY_NS" "${REGISTRY_PORT}:${REGISTRY_PORT}" >/tmp/pf-registry-api.log 2>&1 &
PF_PIDS+=($!)

# Wait for PFs to bind. We poll all three endpoints because kubectl's
# PID appears immediately but the TCP bind happens a few ms later, and
# the first Playwright request would race and get ECONNREFUSED.
log "Waiting for port-forwards to become ready..."
for i in $(seq 1 40); do
  ui_ok=0 api_ok=0 registry_ok=0
  curl -fsS -o /dev/null --max-time 2 "http://localhost:${UI_PORT}"           && ui_ok=1        || true
  curl -fsS -o /dev/null --max-time 2 "http://localhost:${API_PORT}/health"   && api_ok=1       || true
  curl -fsS -o /dev/null --max-time 2 "http://localhost:${REGISTRY_PORT}/health" && registry_ok=1 || true
  if [ "$ui_ok" = 1 ] && [ "$api_ok" = 1 ] && [ "$registry_ok" = 1 ]; then
    log "  OK UI=:${UI_PORT} API=:${API_PORT} REGISTRY=:${REGISTRY_PORT} are reachable"
    break
  fi
  if [ "$i" = 40 ]; then
    log "Port-forwards did not become ready in 20s. Logs:"
    log "--- /tmp/pf-control-ui.log ---";   tail -n 20 /tmp/pf-control-ui.log   >&2 || true
    log "--- /tmp/pf-control-api.log ---";  tail -n 20 /tmp/pf-control-api.log  >&2 || true
    log "--- /tmp/pf-registry-api.log ---"; tail -n 20 /tmp/pf-registry-api.log >&2 || true
    die "Port-forward readiness timeout"
  fi
  sleep 0.5
done

# ─── Run Playwright ───────────────────────────────────────────────────
cd "$REPO_ROOT/control-ui"

# Airtable spec self-skips via test.skip() when credentials are absent.
# After the .env auto-load above, warn loud if still missing — this is
# the only way the user learns they're about to ship a 13-test no-op
# slice instead of the 64-test full Registry suite.
if [ -z "${AIRTABLE_API_KEY:-}" ] || [ -z "${AIRTABLE_BASE_ID:-}" ]; then
  log "NOTE: AIRTABLE_API_KEY / AIRTABLE_BASE_ID not found in env nor $REPO_ROOT/.env"
  log "  Airtable spec (13 tests) will self-skip. Install + Mythos + SSRF still run."
  log "  To run the full suite: add AIRTABLE_API_KEY=... and AIRTABLE_BASE_ID=... to .env"
else
  log "Airtable credentials detected (base=${AIRTABLE_BASE_ID:0:8}…) — airtable spec will execute."
fi

log "Running Playwright specs: $SPECS"
log "  Per-test timeout: ${PLAYWRIGHT_TIMEOUT}ms"
log "  Outer wall-clock guard: $WALL_TIMEOUT"

# Env vars for the Playwright process. Exported (not inline) so they
# survive a `bash -c` re-shell when wrapped by `timeout`. AIRTABLE_*
# are exported even when empty so the child process sees the same
# "unset vs empty" shape the Playwright spec expects.
export CONTROL_API_URL="http://localhost:${API_PORT}"
export CONTROL_UI_URL="http://localhost:${UI_PORT}"
export REGISTRY_URL="http://localhost:${REGISTRY_PORT}"
export KUBECTL_CONTEXT="$CONTEXT"
export ADMIN_USER ADMIN_PASS SPECS PLAYWRIGHT_TIMEOUT
# Airtable creds — forwarded only if set. `${VAR+x}` keeps unset vars
# unset in the child (instead of exporting them as empty strings).
[ -n "${AIRTABLE_API_KEY+x}" ] && export AIRTABLE_API_KEY
[ -n "${AIRTABLE_BASE_ID+x}" ] && export AIRTABLE_BASE_ID

run_playwright() {
  # shellcheck disable=SC2086  # intentional word-splitting of SPECS
  npx playwright test $SPECS --reporter=list --timeout="$PLAYWRIGHT_TIMEOUT"
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
