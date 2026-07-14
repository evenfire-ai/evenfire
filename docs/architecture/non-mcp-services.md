# Non-MCP Services Architecture Validation - Clerum

**Date**: 2026-03-05
**Purpose**: Validate understanding of the transition from Clerum Operator to HCC+WRC and the current state of non-MCP services
**Branch**: feat/phase-8-hardening

---

## 1. Historical vs Current Architecture

### 1.1 Previous Architecture (Clerum Operator)

```
┌─────────────────────────────────────────────────────────────┐
│                    Clerum Operator                          │
│  (Single operator for all services)                         │
├─────────────────────────────────────────────────────────────┤
│  - Manages CommunicationChannel CRDs                        │
│  - Manages Host CRDs                                        │
│  - Manages McpServer CRDs                                   │
│  - Manages ALL workloads (MCP and non-MCP)                 │
│  - Deploys all services in mcp-server namespace            │
└─────────────────────────────────────────────────────────────┘
```

**Problem**: Single operator doing everything, violating separation of concerns principle.

### 1.2 Current Architecture (HCC + WRC)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Host Context Controller (HCC)                      │
│  Deployment: host-context-controller                                  │
│  Port 8081 - Namespace: control-plane                                 │
├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │   Context Mapper (McpServerReconciler)                         │  │
│  │   - McpServer CRDs                                             │  │
│  │   - Context CRDs                                               │  │
│  │   - NetworkPolicyReconciler (L0, L1, L2, L3)                   │  │
│  │   - Discovery REST API                                         │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│              Workflow Recipe Controller (WRC)                         │
│  Deployment: workflow-recipes                                         │
│  Port 8082 - Namespace: control-plane                                 │
├──────────────────────────────────────────────────────────────────────┤
│  - WorkflowRecipe CRDs                                                │
│  - WorkflowRecipePolicy CRDs                                          │
│  - Generates Deployments/StatefulSets/Services/etc                    │
│  - Also exposes MCP: StreamableHTTP on :8082/mcp/v1 (8 tools)         │
└──────────────────────────────────────────────────────────────────────┘
```

WRC is not a pure CRD reconciler: alongside the reconcile loop it starts a
StreamableHTTP MCP server on the same port (`POST :8082/mcp/v1`) exposing
`deploy_recipe`, `list_recipes`, `get_recipe_status`, `rollback_recipe`,
`delete_recipe`, `validate_recipe`, `search_registry` and `list_policies`
(`workflow-recipes/src/mcp/server.ts`, `workflow-recipes/src/mcp/tools.ts`).
That MCP interface is *about* recipes; it does not make WRC the deployer of
McpServer CRDs.

**Separation of Concerns**:
- **HCC/Context Mapper**: MCP services (McpServer CRDs)
- **WRC**: Workloads from recipes (WorkflowRecipe CRDs), plus an MCP interface
  for managing those recipes
- **Both**: Separate Deployments in the `control-plane` namespace, each with its
  own image, ServiceAccount and Service (HCC on 8081, WRC on 8082)

---

## 2. Non-MCP Services: From Clerum Operator to WRC

### 2.1 What are Non-MCP Services

Non-MCP services are workloads that:
- **DO NOT** have a `transport` field (StreamableHTTP, Stdio, etc.)
- **DO NOT** expose MCP protocol
- Are standard Kubernetes applications (web apps, workers, jobs)
- Examples: Web frontends, background workers, cron jobs

### 2.2 Current Management Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. User creates WorkflowRecipe CRD                                │
│     (with workloads[], some with transport, others without)        │
├─────────────────────────────────────────────────────────────────────┤
│  2. WRC detects WorkflowRecipe (reconciler loop)                   │
├─────────────────────────────────────────────────────────────────────┤
│  3. WRC processes each workload in workloads[]:                    │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  IF workload.transport EXISTS →                          │   │
│     │    - Create McpServer CRD                                │   │
│     │    - stdio → managed: true; HCC owns the Deployment      │   │
│     │    - sse/streamableHttp → managed: false; WRC owns the   │   │
│     │      runtime, HCC only maps/registers it                 │   │
│     │    - Register in MCP registry                            │   │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  ELSE (no transport) →                                   │   │
│     │    - WRC creates Deployment/StatefulSet/Service directly│   │
│     │    - Does NOT create McpServer CRD                        │   │
│     │    - Does NOT register in MCP registry                    │   │
│     └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  4. NetworkPolicies:                                               │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  HCC/NetworkPolicyReconciler applies the L0-L3 model:    │   │
│     │  - L0: deny-all ingress + egress (per runtime namespace) │   │
│     │  - L1: infrastructure egress — DNS for every pod in the  │   │
│     │        namespace; HCC API and K8s API egress only for    │   │
│     │        pods matching platform-owned selectors            │   │
│     │  - L2: context-allow ingress per (context, McpServer)    │   │
│     │        + egress counterparts in mcp-host / rpc-proxy     │   │
│     │  - L3: external-egress per McpServer egressBindings      │   │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  WRC builds its own per-workload policies for recipe     │   │
│     │  workloads (buildWorkloadEgressNetworkPolicy /           │   │
│     │  buildWorkloadIngressNetworkPolicy) from                 │   │
│     │  workloads[].egressBindings.                             │   │
│     └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 Implementation Validation by HCC

| Layer | Validation | Mechanism |
|-------|------------|-----------|
| **L0** | Security baseline | NetworkPolicy deny-all, both Ingress and Egress |
| **L1** | Functional infrastructure | DNS egress (port 53) for every pod in the namespace. HCC-API and K8s-API egress are pod-selector-scoped, not namespace-wide: in `sandbox-recipes` HCC-API egress selects `clerum.io/component=workflow-mcp-host` and K8s-API egress selects `clerum.io/k8s-api-egress=true`, so a plain non-MCP workload gets DNS only (`networkPolicyReconciler.ts:132-156`) |
| **L2** | Context isolation | Per (Context, McpServer) pair: ingress policy on the McpServer pod in `mcp-server`, **plus** egress counterparts in the `mcp-host` and `rpc-proxy` namespaces (without them L0 egress deny-all would block agents/rpc-proxy from reaching the server) |
| **L3** | Egress control | External egress per McpServer `egressBindings` (CIDR or DNS) |

Note: L2/L3 above are HCC's policies for **McpServer** pods. The NetworkPolicies
for a recipe workload's `egressBindings` are built by **WRC** itself, in the
workload's own namespace.

**HCC does NOT validate**:
- Correctness of Deployment/StatefulSet created by WRC
- Pod Ready status (that's K8s responsibility)
- Business logic of workloads

**HCC DOES validate**:
- NetworkPolicies are applied correctly
- Context isolation is respected
- EgressBindings are configured per bindings[]

---

## 3. Gap Analysis: Namespace Splitting

### 3.1 Specification (Phase 8 §4.8)

**Status**: ✅ IMPLEMENTED

**Original Specification**:
```
Workloads with transport → mcp-server namespace
Workloads without transport → sandbox-recipes namespace
```

### 3.2 Current Implementation (Phase 8)

Namespace splitting (non-MCP workloads to `sandbox-recipes`) is implemented in
`workflow-recipes/src/reconciler/workflowRecipeReconciler.ts`:

```typescript
// workflow-recipes/src/reconciler/workflowRecipeReconciler.ts
private resolveWorkloadNamespace(workload: WorkloadDef, uiWorkloadId?: string): string {
  if (workload.transport) return this.config.namespace
  if (uiWorkloadId && workload.id === uiWorkloadId) return this.config.sandboxUiNamespace
  return this.config.sandboxNamespace
}
```

**Namespace Resolution Logic** (three-way split):
- Workloads **WITH** `transport` → `this.config.namespace` (mcp-server) → MCP servers
- The workload referenced by `spec.ui.workloadRef` → `this.config.sandboxUiNamespace` (sandbox-ui) → UI workload
- All other workloads → `this.config.sandboxNamespace` (sandbox-recipes) → non-MCP workloads

The WorkflowRecipe CRDs themselves always live in `sandbox-recipes`.

**Cross-namespace Resources**:
```typescript
// workflow-recipes/src/reconciler/workflowRecipeReconciler.ts
private adjustManifestNamespace(manifest, targetNs: string, recipeNamespace: string): void {
  if (manifest.metadata) {
    manifest.metadata.namespace = targetNs
    // Reference namespace is the CRD's own namespace (sandbox-recipes).
    // Same-namespace ownerRefs are safe to keep; cross-namespace ones are
    // stripped (K8s does not support cross-namespace GC) and cleanup falls
    // back to label-based deletion in reconcileDelete.
    if (targetNs !== recipeNamespace && manifest.metadata.ownerReferences) {
      delete manifest.metadata.ownerReferences
    }
  }
}
```

**Finalizer Pattern**: Implemented for cross-namespace resource cleanup.

### 3.3 Implementation Impact

| Aspect | Specification | Implementation | Impact |
|---------|----------------|----------------|---------|
| **Namespace splitting** | sandbox-recipes for non-MCP | ✅ IMPLEMENTED | 🟢 ZERO |
| **Security isolation** | Separation by namespace | Separation by namespace + NetworkPolicy | 🟢 OPTIMAL |
| **Resource cleanup** | Finalizer pattern | ✅ Finalizer implemented | 🟢 ZERO |
| **Governance** | Policies by namespace | Policies by namespace + labels | 🟢 OPTIMAL |

**Assessment**: ✅ **NO GAPS** - Implementation meets specification.

---

## 4. HCC Validation: Does it Deploy Non-MCP Services?

### 4.1 Short Answer

**NOT directly.** HCC does not deploy non-MCP services directly.

### 4.2 Long Answer

**HCC deploys directly**:
- ✅ NetworkPolicies (via NetworkPolicyReconciler)
- ✅ Runtime (Deployment + Service) **only** for `managed: true` McpServers — i.e.
  `stdio` transports, where HCC injects the stdio-bridge sidecar
- ❌ NOT the runtime of `managed: false` McpServers (`sse`/`streamableHttp`): HCC
  skips runtime creation/deletion for those and only maps/registers them
  (`host-context-controller/src/reconciler.ts` → `reconcileWrcOwnedServer`)

**WRC deploys directly**:
- ✅ McpServer CRDs for workloads with `transport` (`managed: isStdio` —
  `workflow-recipes/src/reconciler/mcpDelegation.ts`)
- ✅ The runtime for `sse`/`streamableHttp` MCP workloads (`managed: false`)
- ✅ Non-MCP services (via direct Deployment/StatefulSet/Service)
- ✅ ConfigMaps, Secrets associated with workloads

**HCC validates** (post-deployment):
- ✅ Baseline NetworkPolicies (L0 deny-all + L1 infrastructure) in every runtime namespace
- ✅ Context isolation for McpServer pods (L2)
- ✅ External egress for McpServer `egressBindings` (L3)

Egress controls for recipe workloads' `egressBindings` are WRC's own policies,
not HCC's.

### 4.3 Complete Validation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  NON-MCP WORKLOAD: Web App without transport                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. User creates WorkflowRecipe:                                   │
│     ```yaml                                                         │
│     apiVersion: clerum.io/v1alpha1                                 │
│     kind: WorkflowRecipe                                           │
│     metadata:                                                      │
│       name: my-recipe                                              │
│       namespace: sandbox-recipes  # ← recipes always live here     │
│     spec:                                                          │
│       workloads:                                                   │
│         - id: web-frontend        # ← id + type + image required   │
│           type: deployment                                         │
│           image: nginx:1.30.1-alpine                               │
│           # NO transport field → non-MCP workload                  │
│     ```                                                            │
│                                                                     │
│  2. WRC creates Deployment (in sandbox-recipes, no transport):    │
│     ```yaml                                                         │
│     apiVersion: apps/v1                                            │
│     kind: Deployment                                               │
│     metadata:                                                      │
│       name: web-frontend                                           │
│       namespace: sandbox-recipes  # ← non-MCP workloads go here    │
│       labels:                                                      │
│         app: web-frontend                                          │
│         clerum.io/managed-by: workflow-recipes                     │
│         clerum.io/recipe: my-recipe                                │
│         clerum.io/workload: web-frontend                           │
│         # clerum.io/context is only stamped when the recipe        │
│         # sets spec.contextRef                                     │
│      # NOTE: the ownerReference to the WorkflowRecipe IS kept here │
│      # (target ns == recipe ns). It is only stripped for children  │
│      # placed in a different namespace, e.g. mcp-server.           │
│     spec:                                                          │
│       # ... deployment spec                                         │
│     ```                                                            │
│                                                                     │
│  3. HCC/NetworkPolicyReconciler creates the baseline policies:     │
│     ```yaml                                                         │
│     # L0: deny-all, ingress AND egress (one per runtime namespace) │
│     apiVersion: networking.k8s.io/v1                               │
│     kind: NetworkPolicy                                            │
│     metadata:                                                      │
│       name: deny-all-sandbox-recipes                               │
│       namespace: sandbox-recipes                                   │
│     spec:                                                          │
│       podSelector: {}                                              │
│       policyTypes:                                                  │
│         - Ingress                                                  │
│         - Egress                                                   │
│                                                                     │
│     # L1: DNS egress for every pod in sandbox-recipes.             │
│     # HCC-API egress is scoped to pods labelled                    │
│     #   clerum.io/component=workflow-mcp-host, and K8s-API egress  │
│     #   to pods labelled clerum.io/k8s-api-egress=true — so this   │
│     #   plain web-frontend pod gets DNS egress only.               │
│     ```                                                            │
│                                                                     │
│     HCC's L2 (context-allow) and L3 (external-egress) policies are │
│     built for McpServer pods (L2 ingress in mcp-server, plus its   │
│     egress counterparts in mcp-host and rpc-proxy), not for recipe │
│     workloads in sandbox-recipes.                                  │
│                                                                     │
│  3b. WRC creates the per-workload policies for this workload from  │
│     its `egressBindings[]` (buildWorkloadEgressNetworkPolicy /     │
│     buildWorkloadIngressNetworkPolicy), in sandbox-recipes.        │
│                                                                     │
│  4. Final validation:                                              │
│     ✅ Pod web-frontend Running                                     │
│     ✅ NetworkPolicies applied                                      │
│     ✅ Context isolation respected                                  │
│     ✅ Egress controls applied                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Conclusions and Recommendations

### 5.1 Validated Understanding

✅ **Correct**:
- WRC is a standalone Deployment (`workflow-recipes`, port 8082) in `control-plane`,
  separate from HCC (`host-context-controller`, port 8081, same namespace)
- WRC handles WorkflowRecipe CRDs
- WRC generates Deployments/StatefulSets for non-MCP workloads
- HCC applies the L0-L3 NetworkPolicy model via NetworkPolicyReconciler
- ✅ **Namespace splitting is IMPLEMENTED**

### 5.2 Gaps Identified

| Gap | Severity | Status |
|-----|-----------|--------|
| **Namespace splitting** | 🟢 ZERO | ✅ IMPLEMENTED |
| **Ready state validation** | 🟢 ZERO | K8s handles this correctly |
| **Documentation** | 🟢 ZERO | ✅ Updated (Step 2 completed) |

### 5.3 Recommendations

1. ✅ **Documentation**: COMPLETED
   - Phase 8 §4.8 updated to "IMPLEMENTED"
   - Implementation Status updated
   - NetworkPolicy Layer Model updated (see `docs/architecture/platform-topology.md`)

2. ✅ **Code**: IMPLEMENTED
   - Namespace splitting functional in workflow-recipes/src/reconciler/workflowRecipeReconciler.ts
   - Finalizer pattern implemented
   - Per-workload egress/ingress NetworkPolicies (built by WRC) functional

3. ✅ **Testing**: VALIDATED
   - E2E tests in operational-complex.test.ts
   - E2E tests in operational-simple.test.ts
   - Unit tests in reconciler.test.ts validate namespace resolution

---

## 6. Next Steps

1. ✅ Validate understanding (this document)
2. ✅ Adjust documentation per identified gaps
3. ⏭️ Code changes if needed (currently no gaps identified)
4. ⏭️ Continue with Phase 9 items (per-context auth)
   - Note: admission validation for WorkflowRecipe / WorkflowRecipePolicy is
     already shipped as CEL `ValidatingAdmissionPolicy` objects
     (`deploy/base/cluster-wide/workflowrecipe-admission.yaml`), not as a
     webhook — no ValidatingAdmissionWebhook is pending for these CRDs.

---

**Approval required before proceeding with any code changes.**
