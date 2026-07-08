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
│  Port 8081 - Namespace: mcp-server                                   │
├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │   Context Mapper (McpServerReconciler)                         │  │
│  │   - McpServer CRDs                                             │  │
│  │   - Context CRDs                                               │  │
│  │   - NetworkPolicyReconciler (L0, L1, L2, L3)                   │  │
│  │   - Discovery REST API                                         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │   Workflow Recipe Controller (WRC)                             │  │
│  │   - WorkflowRecipe CRDs                                        │  │
│  │   - WorkflowRecipePolicy CRDs                                 │  │
│  │   - Generates Deployments/StatefulSets/Services/etc           │  │
│  │   - Does NOT expose MCP interface (pure CRD reconciler)       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Separation of Concerns**:
- **HCC/Context Mapper**: MCP services (McpServer CRDs)
- **HCC/WRC**: Workloads from recipes (WorkflowRecipe CRDs)
- **Both**: Run in the same process inside HCC

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
│     │    - Create McpServer CRD                                 │   │
│     │    - Context Mapper deploys it as MCP server              │   │
│     │    - Register in MCP registry                             │   │
│     └──────────────────────────────────────────────────────────┘   │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  ELSE (no transport) →                                   │   │
│     │    - WRC creates Deployment/StatefulSet/Service directly│   │
│     │    - Does NOT create McpServer CRD                        │   │
│     │    - Does NOT register in MCP registry                    │   │
│     └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  4. For ALL created resources (MCP and non-MCP):                   │
│                                                                    │
│     ┌──────────────────────────────────────────────────────────┐   │
│     │  HCC/NetworkPolicyReconciler applies policies:           │   │
│     │  - L0: egress deny-all (baseline)                        │   │
│     │  - L1: infrastructure allow (DNS, K8s API, HCC API)      │   │
│     │  - L2: context-scoped allow (bidirectional)              │   │
│     │  - L3: binding-scoped allow (ingress)                    │   │
│     │  - L3-egress: egressBindings (external API access)       │   │
│     └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 Implementation Validation by HCC

| Layer | Validation | Mechanism |
|-------|------------|-----------|
| **L0** | Security baseline | NetworkPolicy deny-all egress |
| **L1** | Functional infrastructure | Allow DNS (port 53), K8s API, HCC API |
| **L2** | Context isolation | Only pods from same context can communicate |
| **L3** | Controlled binding access | Only pods with binding can access the service |
| **L3-egress** | Egress control | External API access via egressBindings |

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

**Status**: ✅ IMPLEMENTED (commit a6814f2)

**Original Specification**:
```
Workloads with transport → mcp-server namespace
Workloads without transport → sandbox-recipes namespace
```

### 3.2 Current Implementation (Phase 8)

**Implementation commit**: `a6814f2` — "feat(phase-8): namespace splitting — non-MCP workloads to sandbox-recipes"

```typescript
// workloadRecipeReconciler.ts (line 72)
private resolveWorkloadNamespace(workload: WorkloadDef): string {
  return workload.transport ? this.config.namespace : this.config.sandboxNamespace;
}
```

**Namespace Resolution Logic**:
- Workloads **WITH** `transport` → `this.config.namespace` (mcp-server) → MCP servers
- Workloads **WITHOUT** `transport` → `this.config.sandboxNamespace` (sandbox-recipes) → non-MCP workloads

**Cross-namespace Resources**:
```typescript
// workloadRecipeReconciler.ts (lines 84-92)
private adjustManifestNamespace(manifest, targetNs) {
  manifest.metadata.namespace = targetNs;
  if (targetNs !== this.config.namespace && manifest.metadata.ownerReferences) {
    delete manifest.metadata.ownerReferences; // ← Avoids cross-namespace GC issues
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
- ✅ MCP services (via Context Mapper + McpServer CRDs)
- ✅ NetworkPolicies (via NetworkPolicyReconciler)
- ✅ Services for MCP servers
- ✅ StatefulSets/Deployments for MCP servers

**WRC deploys directly**:
- ✅ MCP services (via McpServer CRDs it creates)
- ✅ Non-MCP services (via direct Deployment/StatefulSet/Service)
- ✅ ConfigMaps, Secrets associated with workloads

**HCC validates** (post-deployment):
- ✅ NetworkPolicies applied to all pods
- ✅ Context isolation (L2)
- ✅ Binding-controlled access (L3)
- ✅ Egress controls (L3-egress)

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
│       namespace: mcp-server                                        │
│     spec:                                                          │
│       workloads:                                                   │
│         - name: web-frontend                                       │
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
│         clerum.io/workload: web-frontend                           │
│         clerum.io/recipe: my-recipe                                │
│         clerum.io/context: context1                                │
│       # NOTE: no ownerReferences (cross-namespace GC)              │
│     spec:                                                          │
│       # ... deployment spec                                         │
│     ```                                                            │
│                                                                     │
│  3. HCC/NetworkPolicyReconciler creates NetworkPolicies:           │
│     ```yaml                                                         │
│     # L0: Egress deny-all (applied to all pods)                    │
│     apiVersion: networking.k8s.io/v1                               │
│     kind: NetworkPolicy                                            │
│     metadata:                                                      │
│       name: l0-egress-deny                                         │
│       namespace: sandbox-recipes                                   │
│     spec:                                                          │
│       podSelector: {}                                              │
│       policyTypes:                                                  │
│         - Egress                                                   │
│                                                                     │
│     # L2: Context-allow (bidirectional)                            │
│     apiVersion: networking.k8s.io/v1                               │
│     kind: NetworkPolicy                                            │
│     metadata:                                                      │
│       name: l2-context-context1-allow                              │
│       namespace: sandbox-recipes                                   │
│     spec:                                                          │
│       podSelector:                                                  │
│         matchLabels:                                                │
│           clerum.io/context: context1                              │
│       policyTypes: [Ingress, Egress]                               │
│                                                                     │
│     # L3: Binding-allow (if bindings[] specified)                  │
│     # L3-egress: EgressBindings (if egressBindings[] specified)    │
│     ```                                                            │
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
- WRC is a module INSIDE HCC (not separate operator)
- WRC handles WorkflowRecipe CRDs
- WRC generates Deployments/StatefulSets for non-MCP workloads
- HCC validates via NetworkPolicyReconciler (L0-L3)
- ✅ **Namespace splitting is IMPLEMENTED** (commit a6814f2)

### 5.2 Gaps Identified

| Gap | Severity | Status |
|-----|-----------|--------|
| **Namespace splitting** | 🟢 ZERO | ✅ IMPLEMENTED (commit a6814f2) |
| **Ready state validation** | 🟢 ZERO | K8s handles this correctly |
| **Documentation** | 🟢 ZERO | ✅ Updated (Step 2 completed) |

### 5.3 Recommendations

1. ✅ **Documentation**: COMPLETED
   - Phase 8 §4.8 updated to "IMPLEMENTED"
   - CLERUM-PLATFORM-ARCHITECTURE.md §8.2 updated
   - Implementation Status updated
   - NetworkPolicy Layer Model updated

2. ✅ **Code**: IMPLEMENTED
   - Namespace splitting functional in workloadRecipeReconciler.ts
   - Finalizer pattern implemented
   - Cross-namespace L3 NetworkPolicies functional

3. ✅ **Testing**: VALIDATED
   - E2E tests in operational-complex.test.ts
   - E2E tests in operational-simple.test.ts
   - Unit tests in reconciler.test.ts validate namespace resolution

---

## 6. Next Steps

1. ✅ Validate understanding (this document)
2. ✅ Adjust documentation per identified gaps
3. ⏭️ Code changes if needed (currently no gaps identified)
4. ⏭️ Continue with Phase 9 items (ValidatingAdmissionWebhook, per-context auth)

---

**Approval required before proceeding with any code changes.**
