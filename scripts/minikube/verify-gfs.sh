#!/usr/bin/env bash
# Verify the gfs permission-store credential wiring (issue #775).
#
# Proves, WITHOUT decoding or printing any credential value, that:
#   1. The gfs-controller-db Secret has a non-empty connection-string key.
#   2. The gfsc deployments (reader + writer) exist and are rolled out.
#   3. Every gfsc pod was created AFTER the Secret's last server-side update
#      (its newest managedFields timestamp — stamped by the API server, the
#      SAME clock that stamps pod creationTimestamps, so operator clock skew
#      cannot fake or break this check). Env vars from secretKeyRef resolve at
#      pod creation, so an older pod may hold a stale credential even when the
#      Secret looks correct. The human-readable clerum.io/gfs-dsn-rotated-at
#      annotation is informational only.
#   4. Every gfsc pod is Ready — the readiness probe IS /readyz, which pings
#      the store and (with the fresh-connection probe) re-authenticates, so
#      Ready implies the credential actually works.
#
# FAIL LOUD: every check exits non-zero with a concrete, actionable message —
# including when kubectl itself cannot answer (API/RBAC errors are reported,
# never conflated with "check passed" or silently aborted by set -e). The only
# exit-0 skip is a cluster without the GFS stack (no gfs-config).
#
# Usage:
#   CONTEXT=<kube-context> [GFS_NS=gfs] [GFS_DB_SECRET=gfs-controller-db] \
#   scripts/minikube/verify-gfs.sh
set -euo pipefail

CONTEXT="${CONTEXT:?set CONTEXT to the target kube-context}"
GFS_NS="${GFS_NS:-gfs}"
GFS_DB_SECRET="${GFS_DB_SECRET:-gfs-controller-db}"
GFS_DEPLOY_SELECTOR="${GFS_DEPLOY_SELECTOR:-clerum.io/managed-by=host-context-controller}"
# Pods do NOT inherit the deployment's managed-by label — the pod template
# carries the deployment's spec.selector labels (see gfsFactory commonLabels vs
# selector), so pod queries need their own selector.
GFS_POD_SELECTOR="${GFS_POD_SELECTOR:-app=gfs-controller}"
# Bounded convergence window: pre-gate flows may verify right after a rollout.
VERIFY_ROLLOUT_TIMEOUT="${VERIFY_ROLLOUT_TIMEOUT:-60s}"

kc() { kubectl --context="$CONTEXT" "$@"; }
log() { printf '[verify-gfs] %s\n' "$*"; }
fail() {
  printf '[verify-gfs] FAIL: %s\n' "$*" >&2
  exit 1
}
# kc wrapper for reads whose OUTPUT we consume: a kubectl failure must produce
# an actionable FAIL, never a silent set -e abort inside a $() substitution.
kc_read() {
  local out
  if ! out="$(kc "$@" 2>&1)"; then
    fail "kubectl ${*} failed: ${out}"
  fi
  printf '%s' "$out"
}

if ! kc get configmap gfs-config -n "$GFS_NS" >/dev/null 2>&1; then
  log "gfs-config not found in namespace ${GFS_NS} — GFS stack not deployed, nothing to verify"
  exit 0
fi

# ── 1. Secret populated (length only — never decode the value) ──────────────
DSN_B64="$(kc_read -n "$GFS_NS" get secret "$GFS_DB_SECRET" -o jsonpath='{.data.connection-string}')"
DSN_B64_LEN="$(printf '%s' "$DSN_B64" | wc -c | tr -d ' ')"
if [[ "${DSN_B64_LEN}" -eq 0 ]]; then
  fail "Secret ${GFS_NS}/${GFS_DB_SECRET} has an empty or missing connection-string key — run: CONTEXT=${CONTEXT} deploy/scripts/provision-gfs-db.sh"
fi
log "Secret ${GFS_NS}/${GFS_DB_SECRET}.connection-string is populated (${DSN_B64_LEN} base64 chars)"

# ── 2. gfsc deployments exist and are rolled out ─────────────────────────────
DEPLOYS="$(kc_read -n "$GFS_NS" get deployment -l "$GFS_DEPLOY_SELECTOR" -o name)"
if [[ -z "$DEPLOYS" ]]; then
  fail "no gfsc deployments matching '${GFS_DEPLOY_SELECTOR}' in ${GFS_NS} — the GFS stack is deployed (gfs-config exists) but host-context-controller has not reconciled gfsc"
fi
while IFS= read -r deploy; do
  if ! kc -n "$GFS_NS" rollout status "$deploy" --timeout="$VERIFY_ROLLOUT_TIMEOUT" >/dev/null 2>&1; then
    fail "${deploy} is not rolled out — check: kubectl --context=${CONTEXT} -n ${GFS_NS} describe ${deploy}"
  fi
  log "${deploy} rolled out"
done <<< "$DEPLOYS"

# ── 3. Pods postdate the Secret's last server-side update ────────────────────
# managedFields[].time is stamped by the kube-apiserver — the same clock as pod
# creationTimestamps — so this comparison is immune to operator-machine skew.
# Any Secret update (the provisioning patch included) advances it; comparing
# against the NEWEST entry errs in the fail-loud direction.
ROTATED_AT="$(kc_read -n "$GFS_NS" get secret "$GFS_DB_SECRET" \
  -o jsonpath='{range .metadata.managedFields[*]}{.time}{"\n"}{end}' | sort | tail -1)"
if [[ -z "$ROTATED_AT" ]]; then
  fail "Secret ${GFS_NS}/${GFS_DB_SECRET} exposes no managedFields timestamps — cannot prove pods postdate the credential; re-run: CONTEXT=${CONTEXT} deploy/scripts/provision-gfs-db.sh"
fi
# '|' separator keeps EMPTY fields (a pod with no Ready condition or no
# deletionTimestamp must not collapse the column count).
POD_ROWS="$(kc_read -n "$GFS_NS" get pods -l "$GFS_POD_SELECTOR" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.metadata.creationTimestamp}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"\n"}{end}')"
LIVE_PODS="$(printf '%s\n' "$POD_ROWS" | awk -F'|' 'NF >= 3 && $4 == "" { print }')"
if [[ -z "$LIVE_PODS" ]]; then
  fail "no (non-terminating) gfsc pods matching '${GFS_POD_SELECTOR}' in ${GFS_NS}"
fi
while IFS='|' read -r pod created _ready _deleting; do
  [[ -z "$pod" ]] && continue
  # RFC3339 UTC timestamps in the same format compare lexicographically.
  if [[ "$created" < "$ROTATED_AT" ]]; then
    fail "pod ${pod} (created ${created}) predates the Secret's last update (${ROTATED_AT}) — it may hold a stale credential. Roll it: kubectl --context=${CONTEXT} -n ${GFS_NS} rollout restart deployment -l '${GFS_DEPLOY_SELECTOR}'"
  fi
done <<< "$LIVE_PODS"
log "all gfsc pods postdate the Secret's last update (${ROTATED_AT})"

# ── 4. Pods Ready (readiness probe IS /readyz — store reachable + coherent) ──
# A pod with NO Ready condition yet (Pending/unscheduled) counts as NOT ready.
NOT_READY="$(printf '%s\n' "$LIVE_PODS" | awk -F'|' '$3 != "True" { print $1 }')"
if [[ -n "$NOT_READY" ]]; then
  while IFS= read -r pod; do
    [[ -z "$pod" ]] && continue
    printf '[verify-gfs] pod %s NOT Ready — recent events:\n' "$pod" >&2
    kc -n "$GFS_NS" get events --field-selector "involvedObject.name=${pod}" \
      --sort-by=.lastTimestamp -o custom-columns='TIME:.lastTimestamp,REASON:.reason,MESSAGE:.message' 2>/dev/null | tail -5 >&2 || true
  done <<< "$NOT_READY"
  fail "gfsc pods not Ready: $(echo "$NOT_READY" | tr '\n' ' ')— /readyz is failing (permission store unreachable, credential invalid, or storage unmounted)"
fi
log "all gfsc pods Ready (/readyz green — permission store reachable and credential valid)"

log "OK — gfs permission-store wiring verified"
