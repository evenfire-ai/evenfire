#!/usr/bin/env bash
# ======================================================================
# e2e-637-secret-ownership-bypass.sh — Issue #637 fail-closed E2E gate
#
# Proves, end-to-end against a live cluster, that the WRC reconciler refuses
# to project a Secret owned by a DIFFERENT recipe into a third-party workload,
# across every Secret-projection surface — the cross-recipe credential-exfil
# bypass class of Issue #637. The WRC is the sole trust boundary (HCC does not
# re-validate ownership), so this gate asserts WRC behavior on the cluster.
#
# Ownership model: a recipe Secret in the workload's namespace must carry
#   clerum.io/owner-recipe=<recipe>   OR   clerum.io/shared=true
# An unlabeled/foreign Secret is deny-by-default at the reconciler.
#
# Tests (fail-closed unless noted):
#   1. TRANSPORT denied  — transport workload envSecret → foreign Secret in
#      mcp-server ⇒ NO McpServer CRD created (HCC never sees the credential).
#   2. TRANSPORT control — shared Secret ⇒ McpServer CRD created WITH envSecret
#      (no false-positive lockout).
#   3. NON-TRANSPORT denied — deployment envSecret → foreign Secret in
#      sandbox-recipes ⇒ NO Deployment + EnvSecretOwnershipDenied=True.
#   4. NON-TRANSPORT control — shared Secret ⇒ Deployment rendered with the env.
#   5. SNIPPET denied — run.capabilities.secrets → foreign Secret ⇒ reconcile
#      fails BEFORE the snippet-runner pod is created.
#
# Surfaces covered: Fix 0 (per-workload namespace), Fix #1+#2 (transport
# McpServer copy), Fix #3 (snippet). Fix #4 (StatefulSet revocation) and Fix #5
# (workflow-path condition) are covered by unit tests (reconciler.test.ts) —
# StatefulSet pod-restart timing is not a reliable cluster assertion.
#
# Exit codes: 0 all passed · 1 ≥1 assertion failed · 2 pre-flight failed.
#
# Usage (assumes the cluster is up; no port-forward / control-api needed):
#   KUBE_CONTEXT=clerum-codex-<topic>-<sha> scripts/e2e/e2e-637-secret-ownership-bypass.sh
#
# Env vars:
#   KUBE_CONTEXT      kubectl context (default: clerum-test)
#   MCP_NAMESPACE     transport McpServer namespace (default: mcp-server)
#   SANDBOX_NAMESPACE non-transport workload namespace (default: sandbox-recipes)
#   RECONCILE_TIMEOUT seconds to wait for the WRC to reconcile (default: 120)
#   KUBECTL_TIMEOUT   per-kubectl-call timeout (default: 30s)
# ======================================================================

umask 077
set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────
# Honor the workflow-runtime-gate's vars (KUBECONTEXT / MINIKUBE_PROFILE) so the
# suite drops into that runner unchanged, while a direct KUBE_CONTEXT still wins.
KUBE_CONTEXT="${KUBE_CONTEXT:-${KUBECONTEXT:-${MINIKUBE_PROFILE:-clerum-test}}}"
E2E_LABEL="clerum.io/e2e637"
MCP_NAMESPACE="${MCP_NAMESPACE:-mcp-server}"
SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE:-sandbox-recipes}"
RECONCILE_TIMEOUT="${RECONCILE_TIMEOUT:-120}"
KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-30s}"

RUN_ID="$$-${RANDOM}"
VICTIM_OWNER="victim-637-${RUN_ID}"

# Fixtures (tracked for cleanup).
T_VICTIM_SECRET="victim-transport-${RUN_ID}"
T_SHARED_SECRET="shared-transport-${RUN_ID}"
T_ATTACKER="attacker-tp-${RUN_ID}"
T_CONTROL="control-tp-${RUN_ID}"
N_VICTIM_SECRET="victim-deploy-${RUN_ID}"
N_SHARED_SECRET="shared-deploy-${RUN_ID}"
N_ATTACKER="attacker-dp-${RUN_ID}"
N_CONTROL="control-dp-${RUN_ID}"
S_VICTIM_SECRET="victim-snippet-${RUN_ID}"
S_ATTACKER="attacker-sn-${RUN_ID}"
X_VICTIM_SECRET="victim-xns-${RUN_ID}"
X_ATTACKER="attacker-xns-${RUN_ID}"
R_SECRET="revoke-secret-${RUN_ID}"
R_ATTACKER="revoke-tp-${RUN_ID}"
W_SECRET="revoke-wf-secret-${RUN_ID}"
W_ATTACKER="revoke-wf-${RUN_ID}"

# ─── Colors + logging ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()    { echo -e "${CYAN}[#637]${NC} $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
header() { echo -e "\n${BOLD}═══ $* ═══${NC}"; }

# ─── Result tracking ────────────────────────────────────────────────────
TOTAL=0; PASSED=0
record_pass() { TOTAL=$((TOTAL+1)); PASSED=$((PASSED+1)); echo -e "  ${GREEN}✅ PASS${NC} — $1"; }
record_fail() { TOTAL=$((TOTAL+1)); echo -e "  ${RED}❌ FAIL${NC} — $1\n    ${RED}reason:${NC} $2"; }

# ─── kubectl wrapper (context-pinned, timeout-bounded) ──────────────────
kc() { kubectl --context="$KUBE_CONTEXT" --request-timeout="$KUBECTL_TIMEOUT" "$@"; }

# ─── Cleanup trap ───────────────────────────────────────────────────────
CLEANUP_DONE=0
# shellcheck disable=SC2329  # invoked via trap
cleanup() {
  [ "$CLEANUP_DONE" -eq 1 ] && return; CLEANUP_DONE=1
  log "Cleaning up #637 fixtures..."
  kc -n "$SANDBOX_NAMESPACE" delete workflowrecipe \
    "$T_ATTACKER" "$T_CONTROL" "$N_ATTACKER" "$N_CONTROL" "$S_ATTACKER" "$X_ATTACKER" "$R_ATTACKER" "$W_ATTACKER" \
    --ignore-not-found >/dev/null 2>&1 || true
  kc -n "$MCP_NAMESPACE" delete secret "$T_VICTIM_SECRET" "$T_SHARED_SECRET" "$R_SECRET" \
    --ignore-not-found >/dev/null 2>&1 || true
  kc -n "$SANDBOX_NAMESPACE" delete secret \
    "$N_VICTIM_SECRET" "$N_SHARED_SECRET" "$S_VICTIM_SECRET" "$X_VICTIM_SECRET" "$W_SECRET" \
    --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ─── Pre-flight ─────────────────────────────────────────────────────────
preflight() {
  header "Pre-flight"
  command -v kubectl >/dev/null 2>&1 || { warn "kubectl not found"; exit 2; }
  command -v jq >/dev/null 2>&1 || { warn "jq not found"; exit 2; }
  kubectl config get-contexts "$KUBE_CONTEXT" >/dev/null 2>&1 || { warn "context '$KUBE_CONTEXT' missing"; exit 2; }
  kc version --request-timeout=5s >/dev/null 2>&1 || { warn "cluster '$KUBE_CONTEXT' unreachable"; exit 2; }
  for ns in "$MCP_NAMESPACE" "$SANDBOX_NAMESPACE"; do
    kc get ns "$ns" >/dev/null 2>&1 || { warn "namespace '$ns' missing (run make minikube-deploy-all)"; exit 2; }
  done
  kc get crd workflowrecipes.clerum.io >/dev/null 2>&1 || { warn "WorkflowRecipe CRD missing"; exit 2; }
  log "context=$KUBE_CONTEXT mcp-ns=$MCP_NAMESPACE sandbox-ns=$SANDBOX_NAMESPACE run_id=$RUN_ID"
}

# ─── Fixture builders ───────────────────────────────────────────────────
apply_secret() { # name ns ownerLabelKey ownerLabelVal
  local name="$1" ns="$2" lkey="$3" lval="$4"
  kc apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    clerum.io/recipe-secret: "true"
    ${E2E_LABEL}: "true"
    ${lkey}: "${lval}"
type: Opaque
stringData:
  api-key: SECRET-${RUN_ID}
EOF
}

apply_transport_recipe() { # name secretName
  kc apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${1}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    ${E2E_LABEL}: "true"
spec:
  workloads:
    - id: mcp
      type: deployment
      image: clerum/mock-mcp-server:test
      port: 3000
      transport: { type: streamableHttp, path: /mcp }
      envSecret:
        name: ${2}
        keys: [{ secretKey: api-key, envVar: PROJECTED_KEY }]
EOF
}

apply_deploy_recipe() { # name secretName
  kc apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${1}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    ${E2E_LABEL}: "true"
spec:
  workloads:
    - id: app
      type: deployment
      image: nginx:1.30.1-alpine
      port: 8080
      envSecret:
        name: ${2}
        keys: [{ secretKey: api-key, envVar: PROJECTED_KEY }]
EOF
}

apply_snippet_recipe() { # name secretName
  kc apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${1}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    ${E2E_LABEL}: "true"
spec:
  triggers:
    onDemand:
      allowedActors: [user]
  steps:
    - id: run
      run:
        type: snippet
        language: typescript
        code: "return { ok: true }"
        capabilities:
          secrets:
            - alias: leaked
              secretRef: { name: ${2}, key: api-key }
EOF
}

# Two workloads sharing the SAME envSecret name: a transport workload FIRST
# (resolves to mcp-server, where the Secret is absent → missing) and a
# non-transport workload SECOND (resolves to sandbox-recipes, where the Secret is
# foreign). A first-wins name→namespace map would classify only mcp-server.
apply_collision_recipe() { # name secretName
  kc apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${1}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    ${E2E_LABEL}: "true"
spec:
  workloads:
    - id: mcp
      type: deployment
      image: clerum/mock-mcp-server:test
      port: 3000
      transport: { type: streamableHttp, path: /mcp }
      envSecret:
        name: ${2}
        keys: [{ secretKey: api-key, envVar: TOKEN }]
    - id: app
      type: deployment
      image: nginx:1.30.1-alpine
      port: 8080
      envSecret:
        name: ${2}
        keys: [{ secretKey: api-key, envVar: STOLEN }]
EOF
}

# A WORKFLOW recipe (steps>0) that ALSO declares a non-coordinator workload bearing
# an envSecret. Once deployed (owned Secret), the workflow reaches a steady phase
# (awaiting-trigger / active) whose reconcile short-circuits before the Step 8
# ownership gate — so a later foreign re-label must be enforced by the steady-state
# revocation path (or the watcher fan-out), not silently missed (Issue #637).
apply_workflow_envsecret_recipe() { # name secretName
  kc apply -f - >/dev/null <<EOF
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${1}
  namespace: ${SANDBOX_NAMESPACE}
  labels:
    ${E2E_LABEL}: "true"
spec:
  triggers:
    onDemand:
      allowedActors: [user]
  workloads:
    - id: app
      type: deployment
      image: nginx:1.30.1-alpine
      port: 8080
      envSecret:
        name: ${2}
        keys: [{ secretKey: api-key, envVar: PROJECTED_KEY }]
  steps:
    - id: noop
      run:
        type: snippet
        language: typescript
        code: "return { ok: true }"
EOF
}

# Wait until a recipe has reconciled past the empty/initial phase, OR a sentinel
# resource appears. Bounded; fails loud on timeout via the caller's assertion.
wait_secs() { sleep "$1"; }

ownership_condition() { # recipe ns → status of EnvSecretOwnershipDenied (or empty)
  kc -n "$2" get workflowrecipe "$1" -o json 2>/dev/null \
    | jq -r '.status.conditions[]? | select(.type=="EnvSecretOwnershipDenied") | .status' 2>/dev/null | head -1
}

# ─── Tests ──────────────────────────────────────────────────────────────
test_transport_denied() {
  header "Test 1 — TRANSPORT denied: foreign envSecret ⇒ no McpServer CRD (CRITICAL)"
  local name="Test 1: transport foreign envSecret is fail-closed"
  apply_secret "$T_VICTIM_SECRET" "$MCP_NAMESPACE" "clerum.io/owner-recipe" "$VICTIM_OWNER"
  apply_transport_recipe "$T_ATTACKER" "$T_VICTIM_SECRET"
  # Poll BOTH signals: fail fast if an McpServer CRD ever appears (bypass), and
  # wait (bounded) for the denial condition to be patched — a freshly-restarted or
  # loaded WRC patches status a few seconds after it skips the McpServer, so a
  # single post-wait check is flaky. The security signal (no McpServer) is checked
  # every iteration; the condition just needs to arrive within the window.
  local mcp="${T_ATTACKER}-mcp" deadline=$((SECONDS + RECONCILE_TIMEOUT)) cond=""
  while [ $SECONDS -lt $deadline ]; do
    if kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" >/dev/null 2>&1; then
      record_fail "$name" "McpServer '$mcp' WAS created — transport bypass NOT closed"
      return
    fi
    cond=$(ownership_condition "$T_ATTACKER" "$SANDBOX_NAMESPACE")
    [ "$cond" = "True" ] && break
    sleep 5
  done
  if kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" >/dev/null 2>&1; then
    record_fail "$name" "McpServer '$mcp' created at deadline"
  elif [ "$cond" != "True" ]; then
    record_fail "$name" "no McpServer (good) but EnvSecretOwnershipDenied!=True (got '${cond:-<none>}')"
  else
    record_pass "$name"
  fi
}

test_transport_control() {
  header "Test 2 — TRANSPORT control: shared Secret ⇒ McpServer CRD with envSecret"
  local name="Test 2: shared-Secret transport deploys (no false-positive)"
  apply_secret "$T_SHARED_SECRET" "$MCP_NAMESPACE" "clerum.io/shared" "true"
  apply_transport_recipe "$T_CONTROL" "$T_SHARED_SECRET"
  local mcp="${T_CONTROL}-mcp" deadline=$((SECONDS + RECONCILE_TIMEOUT)) found=0
  while [ $SECONDS -lt $deadline ]; do
    if kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" >/dev/null 2>&1; then found=1; break; fi
    sleep 5
  done
  if [ "$found" != 1 ]; then
    record_fail "$name" "McpServer '$mcp' NOT created within ${RECONCILE_TIMEOUT}s (false-positive lockout?)"
    return
  fi
  local env; env=$(kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" -o jsonpath='{.spec.envSecret.name}' 2>/dev/null || echo "")
  if [ "$env" = "$T_SHARED_SECRET" ]; then record_pass "$name"
  else record_fail "$name" "McpServer envSecret='${env}', expected '${T_SHARED_SECRET}'"; fi
}

test_nontransport_denied() {
  header "Test 3 — NON-TRANSPORT denied: foreign envSecret ⇒ no Deployment + condition"
  local name="Test 3: non-transport foreign envSecret is fail-closed"
  apply_secret "$N_VICTIM_SECRET" "$SANDBOX_NAMESPACE" "clerum.io/owner-recipe" "$VICTIM_OWNER"
  apply_deploy_recipe "$N_ATTACKER" "$N_VICTIM_SECRET"
  local deadline=$((SECONDS + 60)) cond=""
  while [ $SECONDS -lt $deadline ]; do
    cond=$(ownership_condition "$N_ATTACKER" "$SANDBOX_NAMESPACE")
    [ "$cond" = "True" ] && break
    sleep 5
  done
  # Deployment naming carries a hash suffix; match by recipe+workload label instead.
  local deploys; deploys=$(kc -n "$SANDBOX_NAMESPACE" get deploy \
    -l "clerum.io/recipe=${N_ATTACKER},clerum.io/workload=app" -o name 2>/dev/null || echo "")
  if [ -n "$deploys" ]; then
    record_fail "$name" "Deployment rendered for denied workload: ${deploys}"
  elif [ "$cond" != "True" ]; then
    record_fail "$name" "EnvSecretOwnershipDenied!=True (got '${cond:-<none>}')"
  else
    record_pass "$name"
  fi
}

test_nontransport_control() {
  header "Test 4 — NON-TRANSPORT control: shared Secret ⇒ Deployment rendered"
  local name="Test 4: shared-Secret non-transport deploys"
  apply_secret "$N_SHARED_SECRET" "$SANDBOX_NAMESPACE" "clerum.io/shared" "true"
  apply_deploy_recipe "$N_CONTROL" "$N_SHARED_SECRET"
  local deadline=$((SECONDS + RECONCILE_TIMEOUT)) deploys=""
  while [ $SECONDS -lt $deadline ]; do
    deploys=$(kc -n "$SANDBOX_NAMESPACE" get deploy \
      -l "clerum.io/recipe=${N_CONTROL},clerum.io/workload=app" -o name 2>/dev/null || echo "")
    [ -n "$deploys" ] && break
    sleep 5
  done
  if [ -z "$deploys" ]; then
    record_fail "$name" "no Deployment rendered for shared-Secret control within ${RECONCILE_TIMEOUT}s"
    return
  fi
  # The projected env var must be present (proves the shared Secret IS projected).
  local has_env; has_env=$(kc -n "$SANDBOX_NAMESPACE" get $deploys -o json 2>/dev/null \
    | jq -r '[.spec.template.spec.containers[].env[]?.name] | index("PROJECTED_KEY") // "no"')
  if [ "$has_env" != "no" ]; then record_pass "$name"
  else record_fail "$name" "Deployment rendered but PROJECTED_KEY env absent"; fi
}

test_snippet_denied() {
  header "Test 5 — SNIPPET denied: foreign capabilities.secret ⇒ no snippet-runner pod"
  local name="Test 5: snippet foreign capability Secret is fail-closed"
  apply_secret "$S_VICTIM_SECRET" "$SANDBOX_NAMESPACE" "clerum.io/owner-recipe" "$VICTIM_OWNER"
  apply_snippet_recipe "$S_ATTACKER" "$S_VICTIM_SECRET"
  # validateSnippetSecretRefs rejects in preflight, before any pod is created.
  local pod="${S_ATTACKER}-snippet-runner" deadline=$((SECONDS + 60)) phase=""
  while [ $SECONDS -lt $deadline ]; do
    phase=$(kc -n "$SANDBOX_NAMESPACE" get workflowrecipe "$S_ATTACKER" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [ "$phase" = "failed" ] || [ "$phase" = "degraded" ] && break
    sleep 5
  done
  if kc -n "$SANDBOX_NAMESPACE" get pod "$pod" >/dev/null 2>&1; then
    record_fail "$name" "snippet-runner pod '$pod' WAS created for a foreign capability Secret"
  elif [ "$phase" != "failed" ] && [ "$phase" != "degraded" ]; then
    record_fail "$name" "recipe did not reach failed/degraded (phase='${phase:-<none>}') — snippet gate may not have fired"
  else
    record_pass "$name"
  fi
}

test_cross_namespace_collision() {
  header "Test 6 — CROSS-NAMESPACE: transport-first must not mask a foreign non-transport Secret (Issue #637, @claude review)"
  local name="Test 6: cross-namespace first-wins is fail-closed"
  # Foreign Secret exists ONLY in sandbox-recipes (owned by another recipe); it is
  # absent in mcp-server. The transport workload (listed first) reads it in
  # mcp-server (missing); the non-transport workload reads it in sandbox-recipes
  # (foreign). The combined verdict must be denied so the non-transport pod is NOT
  # rendered with the foreign credential.
  apply_secret "$X_VICTIM_SECRET" "$SANDBOX_NAMESPACE" "clerum.io/owner-recipe" "$VICTIM_OWNER"
  apply_collision_recipe "$X_ATTACKER" "$X_VICTIM_SECRET"
  local deadline=$((SECONDS + 60)) cond=""
  while [ $SECONDS -lt $deadline ]; do
    cond=$(ownership_condition "$X_ATTACKER" "$SANDBOX_NAMESPACE")
    [ "$cond" = "True" ] && break
    sleep 5
  done
  # The leak path is the non-transport 'app' Deployment in sandbox-recipes.
  local appDeploys
  appDeploys=$(kc -n "$SANDBOX_NAMESPACE" get deploy \
    -l "clerum.io/recipe=${X_ATTACKER},clerum.io/workload=app" -o name 2>/dev/null || echo "")
  if [ -n "$appDeploys" ]; then
    record_fail "$name" "non-transport 'app' Deployment rendered (foreign credential leaked): ${appDeploys}"
  elif kc -n "$MCP_NAMESPACE" get mcpserver "${X_ATTACKER}-mcp" >/dev/null 2>&1; then
    record_fail "$name" "transport McpServer '${X_ATTACKER}-mcp' created for the masked collision"
  elif [ "$cond" != "True" ]; then
    record_fail "$name" "EnvSecretOwnershipDenied!=True (got '${cond:-<none>}')"
  else
    record_pass "$name"
  fi
}

test_revocation_via_watcher() {
  header "Test 7 — REVOCATION: re-labeling a transport Secret foreign in mcp-server tears down the McpServer CRD (codex HIGH)"
  local name="Test 7: mcp-server Secret-ownership revocation is observed"
  local mcp="${R_ATTACKER}-mcp"
  # Start with the Secret OWNED by this recipe in mcp-server → accessible → the
  # McpServer CRD is created WITH the envSecret.
  apply_secret "$R_SECRET" "$MCP_NAMESPACE" "clerum.io/owner-recipe" "$R_ATTACKER"
  apply_transport_recipe "$R_ATTACKER" "$R_SECRET"
  local deadline=$((SECONDS + RECONCILE_TIMEOUT)) created=0
  while [ $SECONDS -lt $deadline ]; do
    if kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" >/dev/null 2>&1; then created=1; break; fi
    sleep 5
  done
  if [ "$created" != 1 ]; then
    record_fail "$name" "precondition failed: owned-Secret McpServer '$mcp' was not created"
    return
  fi
  # REVOKE: re-label the Secret to a different owner. Only the multi-namespace
  # SecretWatcher (now watching mcp-server) can observe this and fan out a
  # re-reconcile; with a sandbox-recipes-only watcher the CRD would linger.
  kc -n "$MCP_NAMESPACE" label secret "$R_SECRET" \
    "clerum.io/owner-recipe=${VICTIM_OWNER}" --overwrite >/dev/null
  # The watcher debounces ~10s; allow generous time for fan-out + reconcile +
  # teardown, since the WRC reconcile queue may be busy with the earlier tests'
  # fixtures when this runs last in the suite.
  local rdeadline=$((SECONDS + 150)) torn=0
  while [ $SECONDS -lt $rdeadline ]; do
    if ! kc -n "$MCP_NAMESPACE" get mcpserver "$mcp" >/dev/null 2>&1; then torn=1; break; fi
    sleep 5
  done
  if [ "$torn" = 1 ]; then
    record_pass "$name"
  else
    record_fail "$name" "McpServer '$mcp' still present 90s after the Secret was re-labeled foreign — revocation watcher did not fire"
  fi
}

test_revocation_active_workflow() {
  header "Test 8 — WORKFLOW REVOCATION: re-labeling a workflow workload's envSecret foreign tears it down (Issue #637 steady-state)"
  local name="Test 8: workflow-recipe envSecret revocation is enforced in steady state"
  local sel="clerum.io/recipe=${W_ATTACKER},clerum.io/workload=app"
  # Owned Secret first → the workflow's 'app' workload Deployment is created WITH the
  # projected credential, and the recipe settles into a steady (awaiting-trigger)
  # phase whose reconcile short-circuits before the ownership gate.
  apply_secret "$W_SECRET" "$SANDBOX_NAMESPACE" "clerum.io/owner-recipe" "$W_ATTACKER"
  apply_workflow_envsecret_recipe "$W_ATTACKER" "$W_SECRET"
  local deadline=$((SECONDS + RECONCILE_TIMEOUT)) created=0
  while [ $SECONDS -lt $deadline ]; do
    if [ -n "$(kc -n "$SANDBOX_NAMESPACE" get deploy -l "$sel" -o name 2>/dev/null)" ]; then created=1; break; fi
    sleep 5
  done
  if [ "$created" != 1 ]; then
    record_fail "$name" "precondition: workflow 'app' Deployment not created within ${RECONCILE_TIMEOUT}s"
    return
  fi
  # REVOKE: re-label the envSecret to a foreign owner. Pre-fix, a running/steady
  # workflow's reconcile short-circuited before the ownership gate AND the watcher
  # fan-out routed through that same short-circuit, so this was silently missed.
  kc -n "$SANDBOX_NAMESPACE" label secret "$W_SECRET" \
    "clerum.io/owner-recipe=${VICTIM_OWNER}" --overwrite >/dev/null
  local rdeadline=$((SECONDS + 150)) torn=0
  while [ $SECONDS -lt $rdeadline ]; do
    if [ -z "$(kc -n "$SANDBOX_NAMESPACE" get deploy -l "$sel" -o name 2>/dev/null)" ]; then torn=1; break; fi
    sleep 5
  done
  # Require BOTH the teardown AND the positive EnvSecretOwnershipDenied=True signal —
  # teardown alone could happen for an unrelated reason (e.g. recipe GC), so the
  # positive condition proves the ownership gate is what fired. The condition and the
  # teardown come from the SAME reconcile; allow a short bounded window for the status
  # patch to land after the Deployment disappears.
  local cond=""
  if [ "$torn" = 1 ]; then
    local cdeadline=$((SECONDS + 30))
    while [ $SECONDS -lt $cdeadline ]; do
      cond=$(ownership_condition "$W_ATTACKER" "$SANDBOX_NAMESPACE")
      [ "$cond" = "True" ] && break
      sleep 3
    done
  else
    cond=$(ownership_condition "$W_ATTACKER" "$SANDBOX_NAMESPACE")
  fi
  if [ "$torn" = 1 ] && [ "$cond" = "True" ]; then
    record_pass "$name"
  elif [ "$torn" != 1 ]; then
    record_fail "$name" "workflow 'app' Deployment still present 150s after the foreign re-label — steady-state revocation did not fire (cond='${cond:-<none>}')"
  else
    record_fail "$name" "workflow 'app' Deployment torn down but EnvSecretOwnershipDenied!=True (got '${cond:-<none>}') — teardown not attributable to the ownership gate"
  fi
}

print_summary() {
  header "Summary"
  if [ "$PASSED" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo -e "${GREEN}${PASSED}/${TOTAL} passed — Issue #637 fail-closed ownership validated${NC}"
  else
    echo -e "${RED}${PASSED}/${TOTAL} passed — Issue #637 ownership gate FAILED${NC}"
  fi
}

# Label-based teardown of any leftover fixtures from a crashed prior run, across
# both namespaces. Used by `--cleanup-only` (the runtime-gate's --cleanup loop).
cleanup_by_label() {
  for ns in "$SANDBOX_NAMESPACE" "$MCP_NAMESPACE"; do
    kc -n "$ns" delete workflowrecipe,secret -l "${E2E_LABEL}=true" \
      --ignore-not-found >/dev/null 2>&1 || true
  done
}

main() {
  if [ "${1:-}" = "--cleanup-only" ]; then
    CLEANUP_DONE=1  # disable the per-run trap; this is a label-wide sweep
    cleanup_by_label
    exit 0
  fi
  header "Issue #637 — fail-closed cross-recipe Secret ownership (E2E)"
  preflight
  test_transport_denied
  test_transport_control
  test_nontransport_denied
  test_nontransport_control
  test_snippet_denied
  test_cross_namespace_collision
  test_revocation_via_watcher
  test_revocation_active_workflow
  print_summary
  { [ "$PASSED" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; } && exit 0
  exit 1
}

main "$@"
