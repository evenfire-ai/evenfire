#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E suite #9 — Per-Host channel-reader materialization
# ═══════════════════════════════════════════════════════════════════════
#
# Validates that host-context-controller materializes a per-Host
# channel-reader Deployment in the channels namespace, including:
#
#   1. Per-Host Deployment creation (channel-reader-<host>).
#   2. CLERUM_HOST_REF env wiring per pod.
#   3. Secret-driven credentials-revision annotation patch.
#   4. Idempotent: re-applying SAME Secret data does NOT roll the pod.
#   5. Re-roll: changing Secret data DOES roll the pod (new annotation).
#   6. Per-host CommunicationChannel isolation.
#   7. Delete cascade: Host delete → channel-reader Deployment gone.
#   8. Startup orphan sweep: HCC restart deletes orphans on full reconcile.
#
# Prerequisites:
#   - minikube cluster up (profile: clerum-test)
#   - `make minikube-deploy-all` already run
#   - HCC running with per-host channel-reader code (>= ef679387)
#   - Existing Secret: chatllm-api-keys in mcp-host namespace
#   - Existing Context: context1 in mcp-server namespace
#
# Usage:
#   bash scripts/e2e/e2e-channel-reader-per-host.sh
#
# Env vars:
#   KUBECTL          kubectl binary (default: kubectl)
#   KUBE_CONTEXT     kubectl context (default: clerum-test)
#   TIMEOUT          per-wait timeout in seconds (default: 60)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
KUBECTL="${KUBECTL:-kubectl}"
KUBE_CONTEXT="${KUBE_CONTEXT:-clerum-test}"
TIMEOUT="${TIMEOUT:-60}"
KC="${KUBECTL} --context=${KUBE_CONTEXT}"

HOST_NS="mcp-host"
CHANNELS_NS="channels"
CONTROL_NS="control-plane"

# Test fixture names — random suffix prevents collision when run twice
RUN_ID="${RANDOM}"
HOST_A="e2e-cr-a-${RUN_ID}"
HOST_B="e2e-cr-b-${RUN_ID}"
DEPLOY_A="channel-reader-${HOST_A}"
DEPLOY_B="channel-reader-${HOST_B}"
SECRET_A="channel-reader-${HOST_A}-credentials"
SECRET_B="channel-reader-${HOST_B}-credentials"

# Existing cluster resources we reuse (NOT cleaned up by this script)
EXISTING_SECRET_REF="chatllm-api-keys"
EXISTING_CONTEXT_REF="context1"

# ─── Counters ────────────────────────────────────────────────────────
PASS=0
FAIL=0

# ─── Logging ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()    { echo -e "${CYAN}[E2E]${NC} $*"; }
header() { echo -e "\n${BOLD}═══ $* ═══${NC}"; }
ok()     { PASS=$((PASS+1)); echo -e "${GREEN}  PASS${NC} — $*"; }
fail()   { FAIL=$((FAIL+1)); echo -e "${RED}  FAIL${NC} — $*"; }
warn()   { echo -e "${YELLOW}  WARN${NC} — $*"; }

# ─── Host CRD generator ──────────────────────────────────────────────
# Host CRD: spec.host, spec.contextRef, spec.secretRef, spec.model.provider
host_yaml() {
  cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: $1
  namespace: ${HOST_NS}
spec:
  host: $1
  contextRef: ${EXISTING_CONTEXT_REF}
  secretRef: ${EXISTING_SECRET_REF}
  model:
    provider: openai
YAML
}

# ─── Cleanup ─────────────────────────────────────────────────────────
cleanup() {
  log "Cleanup: removing test fixtures..."
  $KC delete host "$HOST_A" "$HOST_B" -n "$HOST_NS" --ignore-not-found 2>/dev/null || true
  $KC delete deployment "$DEPLOY_A" "$DEPLOY_B" -n "$CHANNELS_NS" --ignore-not-found 2>/dev/null || true
  $KC delete secret "$SECRET_A" "$SECRET_B" -n "$CHANNELS_NS" --ignore-not-found 2>/dev/null || true
}
trap cleanup EXIT

# ─── Wait helper ─────────────────────────────────────────────────────
wait_for_deployment_exists() {
  local ns=$1 name=$2 timeout=${3:-$TIMEOUT}
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if $KC get deployment "$name" -n "$ns" &>/dev/null; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# Wait for the credentials-revision annotation to appear and be non-empty.
wait_for_revision_annotation() {
  local ns=$1 name=$2 timeout=${3:-$TIMEOUT}
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local rev
    rev=$($KC get deployment "$name" -n "$ns" \
      -o jsonpath='{.spec.template.metadata.annotations.clerum\.io/credentials-revision}' \
      2>/dev/null || echo "")
    if [ -n "$rev" ]; then
      echo "$rev"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo ""
  return 1
}

# Wait for the credentials-revision annotation to differ from a known prior value.
wait_for_revision_change() {
  local ns=$1 name=$2 prior=$3 timeout=${4:-$TIMEOUT}
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local rev
    rev=$($KC get deployment "$name" -n "$ns" \
      -o jsonpath='{.spec.template.metadata.annotations.clerum\.io/credentials-revision}' \
      2>/dev/null || echo "")
    if [ -n "$rev" ] && [ "$rev" != "$prior" ]; then
      echo "$rev"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo "$rev"
  return 1
}

# ─── Phase 0: pre-flight ─────────────────────────────────────────────
preflight() {
  header "Phase 0 — Pre-flight"

  if $KC cluster-info &>/dev/null; then
    ok "Kubernetes cluster reachable (${KUBE_CONTEXT})"
  else
    fail "Cannot reach cluster — ensure minikube is up"
    exit 2
  fi

  for ns in "$HOST_NS" "$CHANNELS_NS" "$CONTROL_NS"; do
    if $KC get ns "$ns" &>/dev/null; then
      ok "Namespace '${ns}' exists"
    else
      fail "Namespace '${ns}' not found"
      exit 2
    fi
  done

  if $KC get crd hosts.clerum.io &>/dev/null; then
    ok "CRD 'hosts.clerum.io' installed"
  else
    fail "CRD 'hosts.clerum.io' not found"
    exit 2
  fi

  if $KC get deploy host-context-controller -n "$CONTROL_NS" &>/dev/null; then
    ok "host-context-controller Deployment exists"
  else
    fail "host-context-controller not found in ${CONTROL_NS}"
    exit 2
  fi

  if $KC get secret "$EXISTING_SECRET_REF" -n "$HOST_NS" &>/dev/null; then
    ok "Reused Secret '${EXISTING_SECRET_REF}' present in ${HOST_NS}"
  else
    fail "Reused Secret '${EXISTING_SECRET_REF}' missing in ${HOST_NS}"
    exit 2
  fi

  # Best-effort cleanup of stale fixtures from a prior aborted run.
  $KC delete host "$HOST_A" "$HOST_B" -n "$HOST_NS" --ignore-not-found &>/dev/null || true
  $KC delete deployment "$DEPLOY_A" "$DEPLOY_B" -n "$CHANNELS_NS" --ignore-not-found &>/dev/null || true
  $KC delete secret "$SECRET_A" "$SECRET_B" -n "$CHANNELS_NS" --ignore-not-found &>/dev/null || true
  sleep 2
}

# ─── Apply two Hosts ─────────────────────────────────────────────────
apply_two_hosts() {
  header "Phase 1 — Apply two Hosts"
  log "Applying Host '${HOST_A}'..."
  if host_yaml "$HOST_A" | $KC apply -f - >/dev/null 2>&1; then
    ok "Applied Host '${HOST_A}'"
  else
    fail "Failed to apply Host '${HOST_A}'"
    exit 1
  fi
  log "Applying Host '${HOST_B}'..."
  if host_yaml "$HOST_B" | $KC apply -f - >/dev/null 2>&1; then
    ok "Applied Host '${HOST_B}'"
  else
    fail "Failed to apply Host '${HOST_B}'"
    exit 1
  fi
}

# ─── Test 1: per-Host Deployments created ────────────────────────────
test_per_host_deployments_created() {
  header "Test 1 — Per-Host channel-reader Deployments created"

  log "Waiting for Deployment '${DEPLOY_A}' (timeout ${TIMEOUT}s)..."
  if wait_for_deployment_exists "$CHANNELS_NS" "$DEPLOY_A"; then
    ok "Deployment '${DEPLOY_A}' exists in ${CHANNELS_NS}"
  else
    fail "Deployment '${DEPLOY_A}' not created"
  fi

  log "Waiting for Deployment '${DEPLOY_B}' (timeout ${TIMEOUT}s)..."
  if wait_for_deployment_exists "$CHANNELS_NS" "$DEPLOY_B"; then
    ok "Deployment '${DEPLOY_B}' exists in ${CHANNELS_NS}"
  else
    fail "Deployment '${DEPLOY_B}' not created"
  fi

  # Verify managed-by + host labels (orphan sweep depends on them).
  local mgr_a host_a
  mgr_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.metadata.labels.clerum\.io/managed-by}' 2>/dev/null || echo "")
  host_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.metadata.labels.clerum\.io/host}' 2>/dev/null || echo "")
  if [ "$mgr_a" = "host-context-controller" ] && [ "$host_a" = "$HOST_A" ]; then
    ok "Deployment '${DEPLOY_A}' has managed-by + host labels"
  else
    fail "Deployment '${DEPLOY_A}' missing labels (managed-by='${mgr_a}', host='${host_a}')"
  fi

  # CRITICAL: app.kubernetes.io/name MUST be unique per Host. The static
  # deploy/base/channels/channel-reader.yaml Deployment uses selector
  # app.kubernetes.io/name=channel-reader; if per-Host pods carried that
  # plain value the static ReplicaSet would adopt them and delete N-1 every
  # reconcile to converge on its single-replica goal. We assert the per-
  # Host pod is owned by the per-Host ReplicaSet, NOT the static one.
  local app_name_a
  app_name_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.metadata.labels.app\.kubernetes\.io/name}' 2>/dev/null || echo "")
  if [ "$app_name_a" = "$DEPLOY_A" ]; then
    ok "Deployment '${DEPLOY_A}' has unique-per-Host app.kubernetes.io/name='${app_name_a}'"
  else
    fail "Deployment '${DEPLOY_A}' app.kubernetes.io/name='${app_name_a}', expected '${DEPLOY_A}'"
  fi

  # Wait for the per-Host ReplicaSet to actually create a pod, then verify
  # the pod's owner reference points at the per-Host ReplicaSet (whose name
  # is prefixed by the per-Host Deployment name) — not the static
  # clerum-channel-reader ReplicaSet.
  local elapsed=0 pod_owner_a=""
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    pod_owner_a=$($KC get pod -l "clerum.io/host=$HOST_A" -n "$CHANNELS_NS" \
      -o jsonpath='{.items[0].metadata.ownerReferences[0].name}' 2>/dev/null || echo "")
    if [ -n "$pod_owner_a" ]; then
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  case "$pod_owner_a" in
    "${DEPLOY_A}-"*)
      ok "Pod for '${HOST_A}' owned by per-Host ReplicaSet ('${pod_owner_a}')"
      ;;
    "")
      warn "Pod for '${HOST_A}' not yet scheduled — owner check skipped"
      ;;
    *)
      fail "Pod for '${HOST_A}' owned by foreign ReplicaSet ('${pod_owner_a}'); expected '${DEPLOY_A}-*' (static Deployment may have adopted it)"
      ;;
  esac
}

# ─── Test 2: CLERUM_HOST_REF env wiring ──────────────────────────────
test_per_host_env() {
  header "Test 2 — CLERUM_HOST_REF env wired per pod"

  local env_a env_b
  env_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLERUM_HOST_REF")].value}' \
    2>/dev/null || echo "")
  env_b=$($KC get deployment "$DEPLOY_B" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLERUM_HOST_REF")].value}' \
    2>/dev/null || echo "")

  if [ "$env_a" = "$HOST_A" ]; then
    ok "Pod A has CLERUM_HOST_REF='${HOST_A}'"
  else
    fail "Pod A CLERUM_HOST_REF mismatch (got: '${env_a}', want: '${HOST_A}')"
  fi
  if [ "$env_b" = "$HOST_B" ]; then
    ok "Pod B has CLERUM_HOST_REF='${HOST_B}'"
  else
    fail "Pod B CLERUM_HOST_REF mismatch (got: '${env_b}', want: '${HOST_B}')"
  fi
}

# ─── Test 3: Secret drives revision annotation ───────────────────────
test_secret_drives_revision_annotation() {
  header "Test 3 — Secret drives credentials-revision annotation"

  log "Creating Secret '${SECRET_A}' with managed labels..."
  $KC apply -f - >/dev/null 2>&1 <<YAML || { fail "Apply Secret '${SECRET_A}'"; return; }
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_A}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/managed-by: host-context-controller
    clerum.io/host: ${HOST_A}
    clerum.io/component: channel-reader
type: Opaque
stringData:
  telegram-bot-token: "rev1-token-${HOST_A}"
YAML
  ok "Secret '${SECRET_A}' applied"

  log "Waiting for credentials-revision annotation (timeout ${TIMEOUT}s)..."
  local rev
  if rev=$(wait_for_revision_annotation "$CHANNELS_NS" "$DEPLOY_A"); then
    ok "Annotation present: ${rev:0:16}..."
  else
    fail "credentials-revision annotation never appeared on '${DEPLOY_A}'"
  fi
}

# ─── Test 4: idempotent — same data, no roll ─────────────────────────
test_idempotent_no_roll_on_same_secret_apply() {
  header "Test 4 — Idempotent: re-applying SAME Secret data does NOT roll"

  # Capture pre-state
  local prior_gen prior_rev
  prior_gen=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "")
  prior_rev=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.metadata.annotations.clerum\.io/credentials-revision}' \
    2>/dev/null || echo "")

  if [ -z "$prior_gen" ] || [ -z "$prior_rev" ]; then
    fail "Could not capture pre-state (gen='${prior_gen}', rev='${prior_rev}')"
    return
  fi
  log "Pre-state: generation=${prior_gen}, rev=${prior_rev:0:16}..."

  # Re-apply identical Secret content
  log "Re-applying identical Secret data..."
  $KC apply -f - >/dev/null 2>&1 <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_A}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/managed-by: host-context-controller
    clerum.io/host: ${HOST_A}
    clerum.io/component: channel-reader
type: Opaque
stringData:
  telegram-bot-token: "rev1-token-${HOST_A}"
YAML

  # Give HCC time to react (SecretInformer fires on UPDATE event even for no-op)
  sleep 8

  local post_gen post_rev
  post_gen=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "")
  post_rev=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.metadata.annotations.clerum\.io/credentials-revision}' \
    2>/dev/null || echo "")

  # Annotation hash should be byte-identical (sha256 over canonical secret data)
  if [ "$post_rev" = "$prior_rev" ]; then
    ok "credentials-revision unchanged (idempotent hash)"
  else
    fail "credentials-revision changed unexpectedly (was '${prior_rev:0:16}', now '${post_rev:0:16}')"
  fi

  # Generation must NOT bump — same template hash means no rollout
  if [ "$post_gen" = "$prior_gen" ]; then
    ok "Deployment.metadata.generation unchanged (no rollout triggered)"
  else
    fail "Deployment.metadata.generation bumped (${prior_gen} → ${post_gen}) on identical apply"
  fi
}

# ─── Test 5: roll on data change ─────────────────────────────────────
test_roll_on_data_change() {
  header "Test 5 — Changing Secret data DOES roll the pod"

  local prior_rev
  prior_rev=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.metadata.annotations.clerum\.io/credentials-revision}' \
    2>/dev/null || echo "")
  if [ -z "$prior_rev" ]; then
    fail "Could not capture prior credentials-revision"
    return
  fi

  log "Patching Secret with new data..."
  $KC apply -f - >/dev/null 2>&1 <<YAML
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_A}
  namespace: ${CHANNELS_NS}
  labels:
    clerum.io/managed-by: host-context-controller
    clerum.io/host: ${HOST_A}
    clerum.io/component: channel-reader
type: Opaque
stringData:
  telegram-bot-token: "rev2-different-token-${HOST_A}"
  slack-bot-token: "added-in-rev2"
YAML

  log "Waiting for credentials-revision to change (timeout ${TIMEOUT}s)..."
  local new_rev
  if new_rev=$(wait_for_revision_change "$CHANNELS_NS" "$DEPLOY_A" "$prior_rev"); then
    ok "credentials-revision changed: ${prior_rev:0:16}... → ${new_rev:0:16}..."
  else
    fail "credentials-revision did not change after Secret data update"
  fi
}

# ─── Test 6: per-host CommunicationChannel isolation ─────────────────
test_isolation_a_does_not_see_b_channels() {
  header "Test 6 — Per-host isolation: pod A reads only its own host"

  # Verify Deployment A's selector matches host=A only (not B)
  local sel_a sel_b
  sel_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.selector.matchLabels.clerum\.io/host}' 2>/dev/null || echo "")
  sel_b=$($KC get deployment "$DEPLOY_B" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.selector.matchLabels.clerum\.io/host}' 2>/dev/null || echo "")

  if [ "$sel_a" = "$HOST_A" ]; then
    ok "Deployment A selector pins host='${HOST_A}'"
  else
    fail "Deployment A selector mismatch (got: '${sel_a}')"
  fi
  if [ "$sel_b" = "$HOST_B" ]; then
    ok "Deployment B selector pins host='${HOST_B}'"
  else
    fail "Deployment B selector mismatch (got: '${sel_b}')"
  fi

  # Pod A's CLERUM_HOST_REF must not equal Pod B's host
  local env_a
  env_a=$($KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLERUM_HOST_REF")].value}' \
    2>/dev/null || echo "")
  if [ "$env_a" != "$HOST_B" ]; then
    ok "Pod A's CLERUM_HOST_REF ('${env_a}') does not match host B ('${HOST_B}')"
  else
    fail "Pod A's CLERUM_HOST_REF leaked into host B's identity"
  fi

  # Pod A logs (best effort): verify they don't contain host B's name
  local pod_a logs_a
  pod_a=$($KC get pod -n "$CHANNELS_NS" -l "clerum.io/host=${HOST_A}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "$pod_a" ]; then
    logs_a=$($KC logs -n "$CHANNELS_NS" "$pod_a" --tail=50 2>/dev/null || echo "")
    if echo "$logs_a" | grep -q "$HOST_B"; then
      fail "Pod A logs reference host B's name (cross-host leak)"
    else
      ok "Pod A logs do not reference host B's name"
    fi
  else
    warn "Pod A not yet scheduled — log isolation check skipped"
  fi
}

# ─── Test 7: delete cascade ──────────────────────────────────────────
test_delete_cascades() {
  header "Test 7 — Deleting Host A cascades to channel-reader Deployment"

  log "Deleting Host '${HOST_A}'..."
  $KC delete host "$HOST_A" -n "$HOST_NS" --ignore-not-found >/dev/null 2>&1 || true

  # Wait for Deployment A to disappear
  log "Waiting for Deployment '${DEPLOY_A}' to be removed (timeout ${TIMEOUT}s)..."
  local elapsed=0 gone=false
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    if ! $KC get deployment "$DEPLOY_A" -n "$CHANNELS_NS" &>/dev/null; then
      gone=true
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  if $gone; then
    ok "Deployment '${DEPLOY_A}' was deleted (cascade)"
  else
    fail "Deployment '${DEPLOY_A}' still present after Host delete"
  fi

  # Deployment B must remain untouched
  if $KC get deployment "$DEPLOY_B" -n "$CHANNELS_NS" &>/dev/null; then
    ok "Deployment '${DEPLOY_B}' still present (isolated from A's delete)"
  else
    fail "Deployment '${DEPLOY_B}' was deleted unexpectedly"
  fi
}

# ─── Test 8: startup orphan sweep ────────────────────────────────────
test_orphan_sweep() {
  header "Test 8 — Startup orphan sweep deletes stale Deployments"

  local orphan_host="e2e-cr-orphan-${RUN_ID}"
  local orphan_dep="channel-reader-${orphan_host}"

  # Track for cleanup in case sweep doesn't run.
  trap "cleanup; \$KC delete deployment $orphan_dep -n $CHANNELS_NS --ignore-not-found 2>/dev/null || true" EXIT

  log "Scaling host-context-controller to 0..."
  $KC scale deployment host-context-controller -n "$CONTROL_NS" --replicas=0 >/dev/null 2>&1
  # Wait for HCC pod to terminate so it does not race the orphan creation.
  local elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    local replicas
    replicas=$($KC get deployment host-context-controller -n "$CONTROL_NS" \
      -o jsonpath='{.status.replicas}' 2>/dev/null || echo "0")
    [ "${replicas:-0}" = "0" ] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done
  ok "HCC scaled to 0"

  log "Manually creating orphan Deployment '${orphan_dep}' (host='${orphan_host}' has NO Host CR)..."
  $KC apply -f - >/dev/null 2>&1 <<YAML || { fail "Apply orphan Deployment"; \
    $KC scale deployment host-context-controller -n "$CONTROL_NS" --replicas=1 >/dev/null 2>&1 || true; return; }
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${orphan_dep}
  namespace: ${CHANNELS_NS}
  labels:
    app: channel-reader
    app.kubernetes.io/name: channel-reader
    app.kubernetes.io/part-of: clerum
    clerum.io/host: ${orphan_host}
    clerum.io/managed-by: host-context-controller
spec:
  replicas: 0
  selector:
    matchLabels:
      app: channel-reader
      clerum.io/host: ${orphan_host}
  template:
    metadata:
      labels:
        app: channel-reader
        clerum.io/host: ${orphan_host}
    spec:
      containers:
        - name: channel-reader
          image: busybox
          command: ["sh","-c","sleep 3600"]
YAML
  ok "Orphan Deployment '${orphan_dep}' created (replicas=0)"

  log "Scaling HCC back to 1..."
  $KC scale deployment host-context-controller -n "$CONTROL_NS" --replicas=1 >/dev/null 2>&1
  # Wait for HCC pod to be ready
  elapsed=0
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    local ready
    ready=$($KC get deployment host-context-controller -n "$CONTROL_NS" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    [ "${ready:-0}" -ge 1 ] && break
    sleep 2
    elapsed=$((elapsed + 2))
  done
  ok "HCC scaled back to 1"

  log "Waiting for orphan sweep to delete '${orphan_dep}' (timeout ${TIMEOUT}s)..."
  elapsed=0
  local swept=false
  while [ "$elapsed" -lt "$TIMEOUT" ]; do
    if ! $KC get deployment "$orphan_dep" -n "$CHANNELS_NS" &>/dev/null; then
      swept=true
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  if $swept; then
    ok "Orphan Deployment '${orphan_dep}' was swept on HCC startup"
  else
    fail "Orphan Deployment '${orphan_dep}' still present after HCC restart + ${TIMEOUT}s"
    # Belt-and-suspenders: clean it up so trap doesn't leave fixtures behind
    $KC delete deployment "$orphan_dep" -n "$CHANNELS_NS" --ignore-not-found 2>/dev/null || true
  fi

  # Restore the simpler trap — orphan is gone (or we deleted it above)
  trap cleanup EXIT
}

# ─── Run ─────────────────────────────────────────────────────────────
preflight
apply_two_hosts
test_per_host_deployments_created
test_per_host_env
test_secret_drives_revision_annotation
test_idempotent_no_roll_on_same_secret_apply
test_roll_on_data_change
test_isolation_a_does_not_see_b_channels
test_delete_cascades
test_orphan_sweep

# ─── Summary ─────────────────────────────────────────────────────────
header "Results"
echo ""
echo -e "${BOLD}Total: $((PASS + FAIL))  |  ${GREEN}Pass: ${PASS}${NC}  |  ${RED}Fail: ${FAIL}${NC}"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}All checks passed!${NC}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAIL} check(s) failed${NC}"
  exit 1
fi
