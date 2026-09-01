#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# E2E suite — issue #299 Phase 2: Provider-CIDR egress rendering
# ═══════════════════════════════════════════════════════════════════════
#
# Proves the provider-CIDR egress feature end-to-end against a REAL minikube
# cluster with Calico CNI (NetworkPolicy egress enforcement matches GKE+Calico).
# It proves the ROUTE the reconciler renders, NOT a live packet to a provider
# destination — see the enforcement-decoupling note in Phase 7.
#
# What this gate asserts (each is fail-loud; the run FAILS if any regresses):
#
#   Phase 0  Preconditions: cluster reachable, Calico Running, CRDs installed,
#            control-api / host-context-controller / workflow-recipes / control-ui
#            Ready, the seed ConfigMap clerum-provider-netblocks present.
#   Phase 1  Field-survives-apply (G3, McpServer): the structural
#            spec.egressBindings[].provider.{name,categories} field is NOT pruned
#            by the apiserver on a provider-mode McpServer.
#   Phase 2  Field-survives-apply (G3 + H2, WorkflowRecipe — the #1 must-have,
#            the surface where #299 reproduced live): the structural
#            spec.workloads[].egressBindings[].provider.{name,categories} field is
#            NOT pruned on a provider-mode recipe carrying a ui + a workload.
#   Phase 3  Admission CEL negatives: provider+cidr rejected; provider without a
#            provider object rejected; a bare unknown egressClass rejected — each
#            with the apiserver CEL message.
#   Phase 4  Provider RENDER proof (the novel #299 logic, against the real
#            reconciler): patch a PUBLIC, non-blocked test CIDR into the catalog,
#            declare a provider-mode binding, let the REAL reconciler render the
#            NetworkPolicy, then assert the rendered NP carries that CIDR as a
#            port-scoped ipBlock + the clerum.io/egress-provider-ranges provenance
#            annotation, and status ExternalEgressReady=True.
#   Phase 4b Provider RENDER proof — WRC twin (PR335-E2E-003; designed, live-
#            certified only under T1/T2): the REAL workflow-recipes reconciler
#            renders the workload NetworkPolicy wl-egress-<recipe>-<workload>
#            with the catalog CIDR port-scoped to the provider port + the
#            provenance annotation, AND — the WRC-002 isolation net — the
#            sibling exact-host binding (same dns, different port) must NOT
#            inherit the provider CIDR (only its /32 residual).
#   Phase 5  Drift canary: the binding's dns resolves OUTSIDE the narrow declared
#            range → clerum_hcc_external_egress_provider_drift_total increments
#            (scraped from the HCC /metrics endpoint) AND a Warning log is emitted
#            AND the binding still renders (availability preserved).
#   Phase 6  H3-live guard (the single most important safety proof): a provider
#            binding whose declared category is ABSENT from the catalog →
#            ExternalEgressReady=False AND the pre-existing NP is STILL present
#            (never deleted → a catalog problem becomes LKG, never egress loss).
#   Phase 7  Enforcement-layer proof (provider-AGNOSTIC): run the existing
#            scripts/minikube/verify-network-policy-enforcement.sh, which packet-
#            proves that Calico actually enforces allow/deny ipBlocks under this
#            cluster. See the decoupling note below for why this is separate.
#
# ── Why the enforcement proof is DECOUPLED from the provider CIDR (correction A) ──
# A live packet proof tying a client pod to a *provider* CIDR is impossible by
# design: an in-cluster destination pod always has an RFC1918-private IP, and the
# provider render path rejects/strips private ranges at TWO gates —
#   1. resolveProviderRanges → validateProviderRanges rejects any range
#      overlapping BLOCKED_EXTERNAL_EGRESS_CIDRS (10/8, 172.16/12, 192.168/16, …);
#   2. networkPolicyReconciler applies cidrs.filter(isAllowedExternalEgressCidr)
#      before rendering.
# So a destination can be inside a renderable provider CIDR (must be PUBLIC) or a
# reachable controlled pod (must be PRIVATE), never both. We therefore prove the
# provider-SPECIFIC guarantee at the render/spec layer (Phase 4), and prove that
# Calico enforces an ipBlock — the SAME code for any ipBlock — with the existing
# provider-agnostic packet gate (Phase 7).
#
# Usage:
#   CONTEXT=<kube-context> [MINIKUBE_PROFILE=<profile>] \
#     bash scripts/e2e/e2e-provider-cidr-egress.sh
#   (or:  make test-e2e-provider-cidr-egress MINIKUBE_PROFILE=<profile>)
#
# Env vars:
#   CONTEXT           kubectl context (REQUIRED — every kubectl passes it literally)
#   MINIKUBE_PROFILE  minikube profile (default: CONTEXT)
#   MCP_NS            McpServer namespace (default: mcp-server)
#   WFR_NS            WorkflowRecipe namespace (default: sandbox-recipes)
#   TEST_CIDR         public, non-blocked test range (default: 93.184.216.0/24)
#   PROVIDER_DNS      resolvable public host NOT in the provider registry, whose
#                     IPs fall OUTSIDE TEST_CIDR (default: one.one.one.one →
#                     1.1.1.1/1.0.0.1, deterministically outside the /24)
#   PROVIDER_PORT     destination port (default: 443)
#   E2E_SIBLING_PORT  sibling exact-host port for the WRC-002 isolation net —
#                     same dns as the provider binding, MUST NOT inherit the
#                     provider CIDR (default: 2222)
#   E2E_KEEP_RESOURCES=1  skip cleanup (debugging)
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
CONTEXT="${CONTEXT:-}"
if [ -z "$CONTEXT" ]; then
  echo "FATAL: CONTEXT env is required (the verified kube-context); refusing to run against an implicit context." >&2
  exit 1
fi
MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-$CONTEXT}"
CONTROL_NS="control-plane"
MCP_NS="${MCP_NS:-mcp-server}"
WFR_NS="${WFR_NS:-sandbox-recipes}"
CM_NAME="clerum-provider-netblocks"

TEST_CIDR="${TEST_CIDR:-93.184.216.0/24}"
PROVIDER_NAME="testco"
PROVIDER_CATEGORY="edge"
CM_KEY="${PROVIDER_NAME}.${PROVIDER_CATEGORY}.ipv4"
PROVIDER_DNS="${PROVIDER_DNS:-one.one.one.one}"
PROVIDER_PORT="${PROVIDER_PORT:-443}"
# #510 — the ceiling's LOWER bound. Not overridable: the pair [80, 443] is the
# rule under test, so reading it from the environment would let a caller
# silently disarm CEIL-0 the way an unpinned PROVIDER_PORT could disarm the rest.
CEIL_LOW_PORT=80
SIBLING_PORT="${E2E_SIBLING_PORT:-2222}"
DRIFT_METRIC="clerum_hcc_external_egress_provider_drift_total"
ANNOTATION_KEY="clerum.io/egress-provider-ranges"
HCC_DEPLOY="host-context-controller"
WRC_DEPLOY="workflow-recipes"
HCC_METRICS_PORT="${HCC_METRICS_PORT:-8081}"

TIMEOUT="${TIMEOUT:-150}"
POLL="${POLL:-5}"

RID="$(date +%s%N | tail -c 9)"
MCP_SERVER="e2e-provcidr-${RID}"
MCP_SERVER_H3="e2e-provcidr-h3-${RID}"
WFR="e2e-provcidr-wfr-${RID}"
NP_NAME="ext-egress-${MCP_SERVER}-${PROVIDER_DNS}-${PROVIDER_PORT}"
NP_NAME_H3="ext-egress-${MCP_SERVER_H3}-${PROVIDER_DNS}-${PROVIDER_PORT}"
# WRC workload egress NP name — rb.workloadEgressPolicyName(recipe, workloadId)
# in workflow-recipes/src/reconciler/resourceBuilder.ts renders
# `wl-egress-<recipe>-<workload>` (recipe stem untrimmed at our name lengths).
WFR_NP="wl-egress-${WFR}-fetcher"
ABSENT_CATEGORY="nope-${RID}"

# ─── Logging + assertion accounting ──────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BOLD='\033[1m'; NC='\033[0m'
PASS_COUNT=0
# The EXACT number of assertions a complete run executes. Not a minimum: every
# assertion here is deterministic, so any deviation means the harness took a
# path it should not have — an early return, a skipped phase, a duplicated call.
#
# Why this lives in the script and not in a comment or a PR body: this suite
# spent three weeks reported as "32/32" and "33/33", neither of which the script
# can emit (it prints one number, never a fraction). Both figures were retyped
# by a human from a run whose real maximum was 33, where 32 meant "the throttled
# H7 canary log did not appear" — an INCOMPLETE run recorded as complete. A
# count that lives outside the program always drifts; one that lives inside it
# cannot. Update this literal in the same commit that adds or removes an `ok`.
EXPECTED_PASS_COUNT=37
CREATED=0

log()  { printf "\n${BOLD}[e2e-provider-cidr]${NC} %s\n" "$*"; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); printf "${GREEN}✓ PASS${NC} — %s\n" "$*"; }
warn() { printf "${YELLOW}! %s${NC}\n" "$*"; }
die()  { printf "${RED}✗ FAIL${NC} — %s\n" "$*" >&2; exit 1; }

kc() { kubectl --context "$CONTEXT" "$@"; }

# ─── Cleanup ─────────────────────────────────────────────────────────
cleanup() {
  kc delete mcpserver "$MCP_SERVER" "$MCP_SERVER_H3" -n "$MCP_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kc delete workflowrecipe "$WFR" -n "$WFR_NS" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  # Belt-and-suspenders: remove any NP the reconciler left for our servers.
  kc delete networkpolicy "$NP_NAME" "$NP_NAME_H3" -n "$MCP_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  kc delete networkpolicy "$WFR_NP" -n "$WFR_NS" \
    --ignore-not-found >/dev/null 2>&1 || true
  # Restore the catalog: drop the test key we injected (leave every real key).
  kc patch configmap "$CM_NAME" -n "$CONTROL_NS" --type=json \
    -p "[{\"op\":\"remove\",\"path\":\"/data/${CM_KEY}\"}]" >/dev/null 2>&1 || true
}

on_exit() {
  local status=$?
  if [ "$CREATED" = "1" ] && [ "${E2E_KEEP_RESOURCES:-0}" != "1" ]; then
    cleanup
  fi
  exit "$status"
}
trap on_exit EXIT

# ─── Waits (bounded, fail-loud on expiry via the caller) ─────────────
# wait_cond "description" timeout cmd...  → returns 0 when cmd succeeds, 1 on timeout.
wait_cond() {
  local desc="$1" to="$2"; shift 2
  local elapsed=0
  while [ "$elapsed" -lt "$to" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$POLL"; elapsed=$((elapsed + POLL))
  done
  return 1
}

dump_hcc() {
  warn "recent host-context-controller logs:"
  kc -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=60 2>/dev/null || true
}

dump_wrc() {
  warn "recent workflow-recipes controller logs:"
  kc -n "$CONTROL_NS" logs "deploy/${WRC_DEPLOY}" --tail=60 2>/dev/null || true
  warn "WorkflowRecipe ${WFR} status:"
  kc get workflowrecipe "$WFR" -n "$WFR_NS" -o jsonpath='{.status}' 2>/dev/null || true
}

# ═════════════════════════════════════════════════════════════════════
log "issue #299 Phase 2 — provider-CIDR egress E2E (Calico CNI)"
log "context=${CONTEXT} profile=${MINIKUBE_PROFILE} run-id=${RID}"
log "test CIDR=${TEST_CIDR}  provider=${PROVIDER_NAME}/${PROVIDER_CATEGORY}  dns=${PROVIDER_DNS}:${PROVIDER_PORT}"

# ─── Phase 0 — Preconditions ─────────────────────────────────────────
log "Phase 0 — Preconditions"
kc cluster-info >/dev/null 2>&1 || die "cluster not reachable (context '${CONTEXT}')"
ok "cluster reachable"

if kc -n kube-system get pods -l k8s-app=calico-node --no-headers 2>/dev/null | grep -q 'Running'; then
  ok "Calico CNI (calico-node) Running — NetworkPolicy egress is enforced"
else
  kc -n kube-system get pods -l k8s-app=calico-node 2>/dev/null || true
  die "calico-node is not Running — a non-enforcing CNI would make every denial a false pass"
fi

for crd in mcpservers.clerum.io workflowrecipes.clerum.io; do
  kc get crd "$crd" >/dev/null 2>&1 || die "CRD '${crd}' not installed"
done
ok "McpServer + WorkflowRecipe CRDs installed"

# Only the backend reconcilers + admission surface are exercised by this gate;
# control-ui / profile-ui are intentionally NOT required (the setup may run with
# MINIKUBE_SKIP_UIS=true — the frontend is irrelevant to every assertion here).
for tuple in "control-api" "host-context-controller" "workflow-recipes"; do
  if kc -n "$CONTROL_NS" rollout status "deploy/${tuple}" --timeout=120s >/dev/null 2>&1; then
    ok "deployment ${tuple} is Ready"
  else
    kc -n "$CONTROL_NS" get deploy "$tuple" -o wide 2>/dev/null || true
    kc -n "$CONTROL_NS" get pods -l "app=${tuple}" 2>/dev/null || true
    die "deployment ${tuple} is not Ready"
  fi
done

if kc get configmap "$CM_NAME" -n "$CONTROL_NS" >/dev/null 2>&1; then
  ok "seed ConfigMap ${CM_NAME} present in ${CONTROL_NS}"
else
  kc get configmap -n "$CONTROL_NS" 2>/dev/null || true
  die "seed ConfigMap ${CM_NAME} missing in ${CONTROL_NS} (the provider-netblocks catalog)"
fi

CONTEXT_REF="$(kc -n "$MCP_NS" get contexts.clerum.io -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [ -z "$CONTEXT_REF" ]; then
  kc -n "$MCP_NS" get contexts.clerum.io 2>/dev/null || true
  die "no Context CRD found in namespace ${MCP_NS} — McpServer.spec.contextRef needs an existing Context"
fi
ok "discovered Context '${CONTEXT_REF}' for McpServer.spec.contextRef"

CREATED=1

# ─── Phase 1 — Field-survives-apply: McpServer (G3) ──────────────────
log "Phase 1 — Field-survives-apply (McpServer provider field, G3)"
kc apply -f - >/dev/null <<YAML || die "failed to apply provider-mode McpServer ${MCP_SERVER}"
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: provider-cidr-egress
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://${MCP_SERVER}.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: provider
      dns: ${PROVIDER_DNS}
      port: ${PROVIDER_PORT}
      provider:
        name: ${PROVIDER_NAME}
        categories: [${PROVIDER_CATEGORY}]
YAML

got_name="$(kc get mcpserver "$MCP_SERVER" -n "$MCP_NS" -o jsonpath='{.spec.egressBindings[0].provider.name}' 2>/dev/null || true)"
got_cats="$(kc get mcpserver "$MCP_SERVER" -n "$MCP_NS" -o jsonpath='{.spec.egressBindings[0].provider.categories[0]}' 2>/dev/null || true)"
[ "$got_name" = "$PROVIDER_NAME" ] || die "McpServer provider.name pruned/altered: expected '${PROVIDER_NAME}', got '${got_name}'"
[ "$got_cats" = "$PROVIDER_CATEGORY" ] || die "McpServer provider.categories pruned/altered: expected '${PROVIDER_CATEGORY}', got '${got_cats}'"
ok "McpServer spec.egressBindings[0].provider survived apply (name='${got_name}', categories[0]='${got_cats}')"

# ─── Phase 2 — Field-survives-apply: WorkflowRecipe (G3 + H2) ────────
log "Phase 2 — Field-survives-apply (WorkflowRecipe provider field, the #299 repro)"
kc apply -f - >/dev/null <<YAML || die "failed to apply provider-mode WorkflowRecipe ${WFR}"
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WFR}
  namespace: ${WFR_NS}
  labels:
    e2e.clerum.io/suite: provider-cidr-egress
spec:
  description: "issue #299 Phase 2 provider-CIDR field-survival fixture (ui + workload)."
  workloads:
    - id: ui
      type: deployment
      image: busybox:1.36.1
      replicas: 1
      port: 8080
      command: ["sh", "-c"]
      args: ["trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
    - id: fetcher
      type: deployment
      image: busybox:1.36.1
      command: ["sh", "-c"]
      args: ["trap 'exit 0' TERM INT; while true; do sleep 3600; done"]
      egressBindings:
        - egressClass: provider
          dns: ${PROVIDER_DNS}
          port: ${PROVIDER_PORT}
          provider:
            name: ${PROVIDER_NAME}
            categories: [${PROVIDER_CATEGORY}]
        # WRC-002 regression net: exact-host sibling on the SAME dns but a
        # DIFFERENT port — Phase 4b asserts the provider CIDR never leaks
        # onto this rule (it must carry only its /32 residual).
        - egressClass: exact-host
          dns: ${PROVIDER_DNS}
          port: ${SIBLING_PORT}
        # CEIL-0 (#510): the LOWER bound of the port ceiling. The whole suite
        # ran on a single PROVIDER_PORT (443), so a regression narrowing the
        # allowed pair to [443] alone would have gone green everywhere. Riding
        # on this workload costs no extra object and no extra wait — Phase 4b
        # already waits for this NetworkPolicy.
        - egressClass: provider
          dns: ${PROVIDER_DNS}
          port: 80
          provider:
            name: ${PROVIDER_NAME}
            categories: [${PROVIDER_CATEGORY}]
  ui:
    workloadRef: ui
    port: 8080
YAML

wfr_name="$(kc get workflowrecipe "$WFR" -n "$WFR_NS" -o jsonpath='{.spec.workloads[?(@.id=="fetcher")].egressBindings[0].provider.name}' 2>/dev/null || true)"
wfr_cats="$(kc get workflowrecipe "$WFR" -n "$WFR_NS" -o jsonpath='{.spec.workloads[?(@.id=="fetcher")].egressBindings[0].provider.categories[0]}' 2>/dev/null || true)"
[ "$wfr_name" = "$PROVIDER_NAME" ] || die "WorkflowRecipe workload provider.name pruned/altered: expected '${PROVIDER_NAME}', got '${wfr_name}' (this is the exact #299 regression)"
[ "$wfr_cats" = "$PROVIDER_CATEGORY" ] || die "WorkflowRecipe workload provider.categories pruned/altered: expected '${PROVIDER_CATEGORY}', got '${wfr_cats}'"
ok "WorkflowRecipe spec.workloads[fetcher].egressBindings[0].provider survived apply (name='${wfr_name}', categories[0]='${wfr_cats}')"

# ─── Phase 3 — Admission CEL negatives ───────────────────────────────
log "Phase 3 — Admission CEL negatives (apiserver must reject invalid provider specs)"

expect_reject() {
  local desc="$1" needle="$2" manifest="$3" out rc
  out="$(printf '%s' "$manifest" | kc apply -f - 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    # It was (wrongly) accepted — delete it and fail loud.
    printf '%s' "$manifest" | kc delete -f - --ignore-not-found >/dev/null 2>&1 || true
    die "admission ACCEPTED an invalid spec that must be rejected: ${desc}"
  fi
  if printf '%s' "$out" | grep -qiF "$needle"; then
    ok "admission rejected ${desc} (message contains '${needle}')"
  else
    die "admission rejected ${desc} but WITHOUT the expected CEL message '${needle}'; got: ${out}"
  fi
}

# NEEDLE DISCIPLINE: the needle must be unique to the rule under test.
# These two negatives both used the bare needle "provider", which appears in
# THREE different CEL messages on this CRD — so each assertion could pass for
# the other's reason, and a rule could be deleted without either going red.
# Each needle below is now copied verbatim from the `message:` of the exact
# rule it exercises (charts/clerum-crds/crds/mcpserver.yaml).
expect_reject "provider binding that also declares cidr" \
  "provider requires dns and port (no cidr)" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER}-neg-cidr
  namespace: ${MCP_NS}
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://x.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: provider
      dns: ${PROVIDER_DNS}
      port: ${PROVIDER_PORT}
      cidr: 8.8.8.0/24
      provider:
        name: ${PROVIDER_NAME}
        categories: [${PROVIDER_CATEGORY}]
YAML
)"

expect_reject "provider egressClass without a provider object" \
  "egressClass 'provider' requires the provider object" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER}-neg-noprov
  namespace: ${MCP_NS}
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://x.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: provider
      dns: ${PROVIDER_DNS}
      port: ${PROVIDER_PORT}
YAML
)"

# ── #510 port ceiling — the rule THIS PR introduced, previously ungated ──
#
# The ceiling ([80, 443] for `provider` on the WorkflowRecipe surfaces) shipped
# in three layers and had NO live coverage: the suite exercised a single
# PROVIDER_PORT, defaulting to 443, so neither bound of the pair was tested and
# no out-of-range value was ever rejected on a cluster.
#
# The needles are copied verbatim from workflowrecipe.yaml (:1016 and :125).
# CEIL-1 and CEIL-2 share a needle on purpose — they exercise the SAME rule with
# DIFFERENT inputs; what separates them is the `transport:` block in CEIL-2.

expect_reject "CEIL-1: recipe workload provider binding outside [80,443]" \
  "egressClass 'provider' is limited to port 80 or 443" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WFR}-neg-ceiling
  namespace: ${WFR_NS}
spec:
  description: "#510 ceiling negative — non-transport workload."
  workloads:
    - id: fetcher
      type: deployment
      image: busybox:1.36.1
      egressBindings:
        - egressClass: provider
          dns: ${PROVIDER_DNS}
          port: 22
          provider:
            name: ${PROVIDER_NAME}
            categories: [${PROVIDER_CATEGORY}]
YAML
)"

# CEIL-2 is the regression net for the change 1f179c7f made: `transport` USED TO
# lift the ceiling. Comments in the repo still described it as the intended
# escape hatch. If someone restores that exemption, only this assertion notices.
expect_reject "CEIL-2: TRANSPORT workload is capped too (transport is not an escape hatch)" \
  "egressClass 'provider' is limited to port 80 or 443" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WFR}-neg-ceiling-transport
  namespace: ${WFR_NS}
spec:
  description: "#510 ceiling negative — transport workload must NOT be exempt."
  workloads:
    - id: agent
      type: deployment
      image: busybox:1.36.1
      port: 3000
      transport:
        type: streamableHttp
      egressBindings:
        - egressClass: provider
          dns: ${PROVIDER_DNS}
          port: 22
          provider:
            name: ${PROVIDER_NAME}
            categories: [${PROVIDER_CATEGORY}]
YAML
)"

# CEIL-3 covers the OTHER recipe surface. A ui.egress.external entry has no
# `egressClass` field at all, so this rule keys on the `provider` object — the
# same predicate the WRC reconciler now uses.
expect_reject "CEIL-3: recipe ui.egress.external provider entry outside [80,443]" \
  "spec.ui.egress.external[] provider entries are limited to port 80 or 443" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${WFR}-neg-ceiling-ui
  namespace: ${WFR_NS}
spec:
  description: "#510 ceiling negative — ui.egress.external surface."
  workloads:
    - id: ui
      type: deployment
      image: busybox:1.36.1
      port: 8080
  ui:
    workloadRef: ui
    port: 8080
    egress:
      external:
        - fqdn: ${PROVIDER_DNS}
          port: 22
          provider:
            name: ${PROVIDER_NAME}
            categories: [${PROVIDER_CATEGORY}]
YAML
)"

# CEIL-4 pins the INTENTIONAL asymmetry in the opposite direction: McpServer is
# NOT capped, by design (a platform-authored server pays for its width with the
# MCP runtime's supervision, and reaching this surface needs `create` on
# mcpservers.clerum.io). Server-side dry-run: full admission, no persistence,
# nothing to clean up. Without this, a "unification" that capped McpServer too
# would pass every other assertion in this suite.
ceil4_manifest="$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER}-ceiling-accept
  namespace: ${MCP_NS}
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://x.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: provider
      dns: ${PROVIDER_DNS}
      port: 5432
      provider:
        name: ${PROVIDER_NAME}
        categories: [${PROVIDER_CATEGORY}]
YAML
)"
ceil4_out="$(printf '%s' "$ceil4_manifest" | kc apply --dry-run=server -f - 2>&1)" || {
  die "admission REJECTED an McpServer provider binding on port 5432; McpServer is uncapped BY DESIGN — if a port ceiling was deliberately added to this surface, update this assertion and the contract in packages/network-policy-core/index.cjs. Output: ${ceil4_out}"
}
ok "CEIL-4: McpServer provider binding on port 5432 accepted (asymmetry with recipes is by design)"

expect_reject "a bare unknown egressClass" "Unsupported value" "$(cat <<YAML
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER}-neg-enum
  namespace: ${MCP_NS}
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://x.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: totally-bogus
      dns: ${PROVIDER_DNS}
      port: ${PROVIDER_PORT}
YAML
)"

# ─── Phase 4 — Provider RENDER proof ─────────────────────────────────
log "Phase 4 — Provider RENDER proof (real reconciler renders the catalog CIDR)"
kc patch configmap "$CM_NAME" -n "$CONTROL_NS" --type merge \
  -p "{\"data\":{\"${CM_KEY}\":\"${TEST_CIDR}\"}}" >/dev/null \
  || die "failed to patch test CIDR into ${CM_NAME}"
ok "patched catalog key ${CM_KEY}=${TEST_CIDR} into ${CM_NAME}"

# Nudge a fresh reconcile so HCC re-reads the catalog for our McpServer.
kc annotate mcpserver "$MCP_SERVER" -n "$MCP_NS" \
  "e2e.clerum.io/rev=${RID}-p4" --overwrite >/dev/null 2>&1 || true

np_has_cidr() {
  kc get networkpolicy "$NP_NAME" -n "$MCP_NS" \
    -o jsonpath='{.spec.egress[*].to[*].ipBlock.cidr}' 2>/dev/null | grep -qF "$TEST_CIDR"
}
if wait_cond "provider NP renders test CIDR" "$TIMEOUT" np_has_cidr; then
  ok "reconciler rendered NetworkPolicy ${NP_NAME} with ipBlock ${TEST_CIDR}"
else
  warn "NetworkPolicy ${NP_NAME} did not render ${TEST_CIDR} within ${TIMEOUT}s"
  kc get networkpolicy "$NP_NAME" -n "$MCP_NS" -o yaml 2>/dev/null || warn "NP not found"
  kc get mcpserver "$MCP_SERVER" -n "$MCP_NS" -o jsonpath='{.status}' 2>/dev/null || true
  dump_hcc
  die "provider NP did not render the catalog CIDR (render path regressed)"
fi

# Every egress rule must be port-scoped to PROVIDER_PORT.
np_ports="$(kc get networkpolicy "$NP_NAME" -n "$MCP_NS" -o jsonpath='{.spec.egress[*].ports[*].port}' 2>/dev/null || true)"
printf '%s' "$np_ports" | grep -qw "$PROVIDER_PORT" \
  || die "rendered NP egress is not port-scoped to ${PROVIDER_PORT}; ports='${np_ports}'"
ok "rendered NP egress rules are port-scoped to ${PROVIDER_PORT}"

# Provenance annotation carries dns=<ranges> including the test CIDR.
np_annot="$(kc get networkpolicy "$NP_NAME" -n "$MCP_NS" \
  -o "jsonpath={.metadata.annotations.clerum\.io/egress-provider-ranges}" 2>/dev/null || true)"
printf '%s' "$np_annot" | grep -qF "$TEST_CIDR" \
  || die "provenance annotation '${ANNOTATION_KEY}' missing test CIDR; got '${np_annot}'"
printf '%s' "$np_annot" | grep -qF "$PROVIDER_DNS" \
  || die "provenance annotation '${ANNOTATION_KEY}' missing dns '${PROVIDER_DNS}'; got '${np_annot}'"
ok "rendered NP carries provenance annotation ${ANNOTATION_KEY}='${np_annot}'"

# Status condition ExternalEgressReady=True.
ready_true() {
  local v
  v="$(kc get mcpserver "$MCP_SERVER" -n "$MCP_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="ExternalEgressReady")]}{.status}{end}' 2>/dev/null || true)"
  [ "$v" = "True" ]
}
if wait_cond "ExternalEgressReady=True" "$TIMEOUT" ready_true; then
  ok "McpServer status ExternalEgressReady=True"
else
  kc get mcpserver "$MCP_SERVER" -n "$MCP_NS" -o jsonpath='{.status.conditions}' 2>/dev/null || true
  dump_hcc
  die "McpServer never reported ExternalEgressReady=True"
fi

# ─── Phase 4b — WRC workload provider RENDER proof ───────────────────
# WRC twin of the McpServer render proof above — closes PR335-E2E-003 (WRC
# render + WRC-002 sibling isolation). DESIGNED phase: live-certified only
# under a T1/T2 minikube run (minikube intentionally paused at design time).
log "Phase 4b — WRC workload provider RENDER proof (real workflow-recipes reconciler)"

# The TEST_CIDR is already in the catalog (patched in Phase 4). Nudge a fresh
# WRC reconcile so the recipe re-reads it for the fetcher workload.
kc annotate workflowrecipe "$WFR" -n "$WFR_NS" \
  "e2e.clerum.io/rev=${RID}-p4b" --overwrite >/dev/null 2>&1 || true

# One line per egress rule: "<ports space-joined>|<ipBlock cidrs space-joined>".
wfr_np_rules() {
  kc get networkpolicy "$WFR_NP" -n "$WFR_NS" \
    -o jsonpath='{range .spec.egress[*]}{.ports[*].port}{"|"}{.to[*].ipBlock.cidr}{"\n"}{end}' 2>/dev/null || true
}

wfr_np_has_cidr() {
  kc get networkpolicy "$WFR_NP" -n "$WFR_NS" \
    -o jsonpath='{.spec.egress[*].to[*].ipBlock.cidr}' 2>/dev/null | grep -qF "$TEST_CIDR"
}
if wait_cond "WRC workload NP renders test CIDR" "$TIMEOUT" wfr_np_has_cidr; then
  ok "WRC rendered NetworkPolicy ${WFR_NP} with ipBlock ${TEST_CIDR}"
else
  warn "NetworkPolicy ${WFR_NP} did not render ${TEST_CIDR} within ${TIMEOUT}s"
  kc get networkpolicy "$WFR_NP" -n "$WFR_NS" -o yaml 2>/dev/null || warn "NP not found"
  dump_wrc
  die "WRC workload NP did not render the catalog CIDR (WRC render path regressed)"
fi

# The provider-CIDR rule(s) must be port-scoped to a DECLARED provider port — a
# rule carrying TEST_CIDR on any other port is a scoping regression.
#
# The fetcher declares provider on TWO ports now (PROVIDER_PORT and the ceiling's
# lower bound), so the invariant is "only on declared provider ports", not "only
# on PROVIDER_PORT". It still fails loud on the sibling exact-host port, which is
# the leak WRC-002 guards.
misscoped="$(wfr_np_rules | grep -F "$TEST_CIDR" \
  | grep -vw "$PROVIDER_PORT" | grep -vw "$CEIL_LOW_PORT" || true)"
if [ -n "$misscoped" ]; then
  warn "rules carrying ${TEST_CIDR} on a port other than ${PROVIDER_PORT}/${CEIL_LOW_PORT}:"
  printf '%s\n' "$misscoped"
  dump_wrc
  die "WRC provider-CIDR rule is not port-scoped to a declared provider port"
fi
ok "WRC provider-CIDR rule(s) are port-scoped to declared provider ports (${PROVIDER_PORT}, ${CEIL_LOW_PORT})"

# CEIL-0 (#510): the ceiling's LOWER bound actually renders. Asserted separately
# from the scoping check above, which would stay green if port 80 rendered
# NOTHING at all — an absent rule carries no CIDR on a wrong port either.
ceil_low_rule="$(wfr_np_rules | awk -F'|' -v p="$CEIL_LOW_PORT" \
  '{ n = split($1, a, " "); for (i = 1; i <= n; i++) if (a[i] == p) { print; next } }')"
printf '%s' "$ceil_low_rule" | grep -qF "$TEST_CIDR" \
  || { warn "rules: $(wfr_np_rules)"; dump_wrc; die "CEIL-0: provider binding on port ${CEIL_LOW_PORT} rendered no ${TEST_CIDR} rule — the ceiling's lower bound is not honoured; got '${ceil_low_rule}'"; }
ok "CEIL-0: provider CIDR renders on the ceiling's lower bound port ${CEIL_LOW_PORT}"

# WRC-002 isolation (the key new coverage): the sibling exact-host binding on
# SIBLING_PORT must render its OWN rule (else the check would be vacuous) and
# that rule must NEVER carry the provider CIDR — only its /32 residual.
sibling_rules() {
  wfr_np_rules | awk -F'|' -v p="$SIBLING_PORT" \
    '{ n = split($1, a, " "); for (i = 1; i <= n; i++) if (a[i] == p) { print; next } }'
}
sibling_rule_present() { sibling_rules | grep -q .; }
if wait_cond "sibling exact-host rule renders" "$TIMEOUT" sibling_rule_present; then
  ok "sibling exact-host rule for port ${SIBLING_PORT} rendered"
else
  warn "rendered egress rules (port|cidrs):"
  wfr_np_rules
  dump_wrc
  die "sibling exact-host rule for port ${SIBLING_PORT} never rendered — WRC-002 isolation cannot be proven"
fi

sib_rules="$(sibling_rules)"
if printf '%s' "$sib_rules" | grep -qF "$TEST_CIDR"; then
  warn "sibling rules (port|cidrs):"
  printf '%s\n' "$sib_rules"
  dump_wrc
  die "WRC-002 sibling widening regressed: the sibling port ${SIBLING_PORT} rule carries the provider CIDR ${TEST_CIDR}"
fi
printf '%s' "$sib_rules" | grep -q '/32' \
  || die "sibling port ${SIBLING_PORT} rule carries no /32 residual; rules='${sib_rules}'"
ok "WRC-002 isolation holds — port ${SIBLING_PORT} carries only /32 residual(s), never ${TEST_CIDR}"

# Provenance annotation on the WFR NP carries dns + the test CIDR.
wfr_annot="$(kc get networkpolicy "$WFR_NP" -n "$WFR_NS" \
  -o "jsonpath={.metadata.annotations.clerum\.io/egress-provider-ranges}" 2>/dev/null || true)"
printf '%s' "$wfr_annot" | grep -qF "$TEST_CIDR" \
  || { dump_wrc; die "WFR NP provenance annotation '${ANNOTATION_KEY}' missing test CIDR; got '${wfr_annot}'"; }
printf '%s' "$wfr_annot" | grep -qF "$PROVIDER_DNS" \
  || { dump_wrc; die "WFR NP provenance annotation '${ANNOTATION_KEY}' missing dns '${PROVIDER_DNS}'; got '${wfr_annot}'"; }
ok "WFR NP carries provenance annotation ${ANNOTATION_KEY}='${wfr_annot}'"

# The recipe must not have failed while rendering the provider binding.
#
# This assertion used to read .status.phase ONCE and pass whenever it was not
# literally "failed" — including when it was EMPTY, which is what an unreconciled
# recipe reports. It therefore counted toward PASS_COUNT while proving nothing.
# Wait for a non-empty phase first, so "not failed" is a statement about an
# observed phase rather than about the absence of one.
wfr_phase_present() {
  [ -n "$(kc get workflowrecipe "$WFR" -n "$WFR_NS" -o jsonpath='{.status.phase}' 2>/dev/null)" ]
}
wait_cond "WorkflowRecipe ${WFR} publishes a status.phase" "$TIMEOUT" wfr_phase_present \
  || { dump_wrc; die "WorkflowRecipe ${WFR} published no status.phase within ${TIMEOUT}s — the reconciler never reached a verdict, so 'not failed' would assert nothing"; }
wfr_phase="$(kc get workflowrecipe "$WFR" -n "$WFR_NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
if [ "$wfr_phase" = "failed" ]; then
  dump_wrc
  die "WorkflowRecipe ${WFR} reached status.phase=failed while rendering the provider binding"
fi
ok "WorkflowRecipe ${WFR} status.phase='${wfr_phase}' (non-empty, not failed)"

# ─── Phase 5 — Drift canary ──────────────────────────────────────────
log "Phase 5 — Drift canary (dns resolves OUTSIDE the declared range)"

# The HCC exposes Prometheus /metrics on its http port; scrape it from inside the
# pod with node (guaranteed present; the image has no curl/wget).
scrape_hcc_metrics() {
  kc -n "$CONTROL_NS" exec "deploy/${HCC_DEPLOY}" -- node -e '
    const http = require("node:http");
    http.get("http://127.0.0.1:'"$HCC_METRICS_PORT"'/metrics", r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => process.stdout.write(d));
    }).on("error", e => { console.error(String(e)); process.exit(3); });
  ' 2>/dev/null || true
}

drift_present() {
  scrape_hcc_metrics | grep -E "^${DRIFT_METRIC}\{[^}]*dns=\"${PROVIDER_DNS}\"[^}]*\}[[:space:]]+[1-9]" >/dev/null 2>&1
}
if wait_cond "drift metric increments" "$TIMEOUT" drift_present; then
  drift_line="$(scrape_hcc_metrics | grep -E "^${DRIFT_METRIC}\{[^}]*dns=\"${PROVIDER_DNS}\"" | head -1)"
  ok "drift metric fired: ${drift_line}"
else
  warn "did not observe ${DRIFT_METRIC} for dns='${PROVIDER_DNS}' within ${TIMEOUT}s"
  scrape_hcc_metrics | grep -E "external_egress_provider_drift" || warn "(no drift metric samples at all)"
  dump_hcc
  die "drift canary metric did not increment for out-of-range resolved IPs"
fi

# Availability preserved: the out-of-range resolved IPs also ride the /32 window,
# so the NP still renders (it must contain more than just the declared range).
np_cidrs="$(kc get networkpolicy "$NP_NAME" -n "$MCP_NS" -o jsonpath='{.spec.egress[*].to[*].ipBlock.cidr}' 2>/dev/null || true)"
extra_count="$(printf '%s\n' $np_cidrs | grep -vF "$TEST_CIDR" | grep -c '/32' || true)"
if [ "${extra_count:-0}" -ge 1 ]; then
  ok "availability preserved — ${extra_count} residual /32(s) rendered alongside ${TEST_CIDR}"
else
  warn "rendered CIDRs: ${np_cidrs}"
  die "expected out-of-range resolved IPs to ride the /32 window alongside ${TEST_CIDR} (availability guarantee)"
fi

# Warning log emitted for the drift (Phase-2 H7 canary log). DIAGNOSTIC ONLY — NOT a
# counted assertion: the drift invariant is already proven fail-loud by the metric
# assertion above (`die` on absence). The H7 log is throttled (1h) and read from the
# last 400 lines, so its presence is timing-dependent; gating `ok`/PASS_COUNT on it
# made the total non-deterministic (32↔33) for the SAME correct state. Keep it as
# information only so PASS_COUNT counts deterministic assertions exclusively.
if kc -n "$CONTROL_NS" logs "deploy/${HCC_DEPLOY}" --tail=400 2>/dev/null \
     | grep -qF "provider-range drift for \"${PROVIDER_DNS}\""; then
  log "diagnostic: HCC drift Warning log present for '${PROVIDER_DNS}' (H7 canary)"
else
  log "diagnostic: HCC drift Warning log not in the last 400 lines for '${PROVIDER_DNS}' (throttled/rotated; the metric assertion above already proved drift fail-loud)"
fi

# ─── Phase 6 — H3-live guard (catalog problem → LKG, never egress loss) ──
log "Phase 6 — H3-live guard (invalid provider category retains the live NP)"

# 6a — stand up a healthy provider McpServer first (positive before negative).
kc apply -f - >/dev/null <<YAML || die "failed to apply H3 McpServer ${MCP_SERVER_H3}"
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${MCP_SERVER_H3}
  namespace: ${MCP_NS}
  labels:
    e2e.clerum.io/suite: provider-cidr-egress
spec:
  contextRef: ${CONTEXT_REF}
  image: clerum/nginx-egress-proxy:0.1.0
  transport:
    type: streamableHttp
    url: http://${MCP_SERVER_H3}.${MCP_NS}.svc.cluster.local:3000/mcp
    port: 3000
  egressBindings:
    - egressClass: provider
      dns: ${PROVIDER_DNS}
      port: ${PROVIDER_PORT}
      provider:
        name: ${PROVIDER_NAME}
        categories: [${PROVIDER_CATEGORY}]
YAML

h3_np_present() { kc get networkpolicy "$NP_NAME_H3" -n "$MCP_NS" >/dev/null 2>&1; }
h3_ready_true() {
  local v
  v="$(kc get mcpserver "$MCP_SERVER_H3" -n "$MCP_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="ExternalEgressReady")]}{.status}{end}' 2>/dev/null || true)"
  [ "$v" = "True" ]
}
wait_cond "H3 NP renders" "$TIMEOUT" h3_np_present || { dump_hcc; die "H3 baseline NP ${NP_NAME_H3} never rendered"; }
wait_cond "H3 ExternalEgressReady=True" "$TIMEOUT" h3_ready_true || { dump_hcc; die "H3 baseline never reached ExternalEgressReady=True"; }
ok "H3 baseline healthy — NP ${NP_NAME_H3} present and ExternalEgressReady=True"

# 6b — mutate the binding to a category ABSENT from the catalog. The reconciler
# must fail loud (ExternalEgressReady=False) and RETAIN the live NP.
kc patch mcpserver "$MCP_SERVER_H3" -n "$MCP_NS" --type merge \
  -p "{\"spec\":{\"egressBindings\":[{\"egressClass\":\"provider\",\"dns\":\"${PROVIDER_DNS}\",\"port\":${PROVIDER_PORT},\"provider\":{\"name\":\"${PROVIDER_NAME}\",\"categories\":[\"${ABSENT_CATEGORY}\"]}}]}}" \
  >/dev/null || die "failed to patch H3 McpServer to an absent category"
ok "patched H3 binding to absent category '${PROVIDER_NAME}.${ABSENT_CATEGORY}'"

h3_ready_false() {
  local v
  v="$(kc get mcpserver "$MCP_SERVER_H3" -n "$MCP_NS" \
    -o jsonpath='{range .status.conditions[?(@.type=="ExternalEgressReady")]}{.status}{end}' 2>/dev/null || true)"
  [ "$v" = "False" ]
}
if wait_cond "H3 ExternalEgressReady=False" "$TIMEOUT" h3_ready_false; then
  ok "invalid provider category → ExternalEgressReady=False (fail-loud)"
else
  kc get mcpserver "$MCP_SERVER_H3" -n "$MCP_NS" -o jsonpath='{.status.conditions}' 2>/dev/null || true
  dump_hcc
  die "H3: invalid category did not flip ExternalEgressReady to False"
fi

# The pre-existing NP MUST still be present (never deleted on a catalog problem).
if kc get networkpolicy "$NP_NAME_H3" -n "$MCP_NS" >/dev/null 2>&1; then
  ok "H3-live: pre-existing NP ${NP_NAME_H3} is STILL present (LKG retained, no egress loss)"
else
  dump_hcc
  die "H3 VIOLATION: the live NP ${NP_NAME_H3} was DELETED on an invalid category — a catalog problem became egress loss"
fi

# ─── Phase 7 — Enforcement-layer proof (provider-agnostic ipBlock) ───
log "Phase 7 — Enforcement-layer proof (Calico enforces ipBlock allow/deny)"
# Decoupled from the provider CIDR on purpose (see header note): the enforcement
# of a rendered ipBlock is the SAME code for any ipBlock, and in-cluster
# destinations are RFC1918 → unrenderable as provider CIDRs by design. We prove
# the render at the spec layer (Phases 4-6) and the enforcement with the existing
# provider-agnostic packet gate here.
PROBE_IMAGE_REF="clerum/workflow-custom-sdk-e2e:test"
if minikube -p "$MINIKUBE_PROFILE" image ls 2>/dev/null | grep -Eq "(^|/)${PROBE_IMAGE_REF}$|(^|/)docker.io/${PROBE_IMAGE_REF}$"; then
  ok "enforcement probe image ${PROBE_IMAGE_REF} already loaded"
else
  warn "probe image ${PROBE_IMAGE_REF} absent (setup-local seeds minimal) — building it (bounded)…"
  MINIKUBE_PROFILE="$MINIKUBE_PROFILE" scripts/minikube/build-images.sh --only=workflow-custom-sdk-e2e \
    || die "failed to build the enforcement probe fixture workflow-custom-sdk-e2e"
  ok "built enforcement probe image ${PROBE_IMAGE_REF}"
fi

if CONTEXT="$CONTEXT" MINIKUBE_PROFILE="$MINIKUBE_PROFILE" NS="$MCP_NS" \
     bash scripts/minikube/verify-network-policy-enforcement.sh; then
  ok "Calico enforces ipBlock allow/deny (verify-network-policy-enforcement.sh passed for ${MCP_NS})"
else
  die "provider-agnostic NetworkPolicy enforcement gate FAILED — Calico is not enforcing ipBlocks"
fi

# ─── Results (zero-tests-is-never-success) ───────────────────────────
log "═════════════════════════════════════════════════════════════════"
if [ "$PASS_COUNT" -le 0 ]; then
  die "zero assertions executed — the harness never reached a real assertion"
fi
# Scope guard: "nothing failed" is not "everything ran". Every assertion in this
# suite is deterministic, so a count below EXPECTED means assertions were
# silently skipped, and a count above it means one ran more times than intended.
# Either way the run is not a verdict.
if [ "$PASS_COUNT" -ne "$EXPECTED_PASS_COUNT" ]; then
  die "assertion count mismatch: executed ${PASS_COUNT}, expected ${EXPECTED_PASS_COUNT}. Fewer means assertions were skipped and the green is partial; more means one ran twice. If you added or removed an assertion, update EXPECTED_PASS_COUNT in the same commit."
fi
printf "${GREEN}All ${PASS_COUNT} provider-CIDR assertions passed.${NC}\n"
log "═════════════════════════════════════════════════════════════════"
