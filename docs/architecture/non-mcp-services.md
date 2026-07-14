# Non-MCP Services

How the platform runs workloads that are **not** MCP servers — where they land,
who deploys them, and which NetworkPolicies apply.

A `WorkflowRecipe` can declare a mix of workloads: some speak MCP, some are
ordinary Kubernetes applications. This page covers the second kind.

## What counts as a non-MCP workload

A workload in `spec.workloads[]` that:

- has **no** `transport` field (no StreamableHTTP, SSE, or stdio),
- does not speak the MCP protocol, and
- is a standard Kubernetes application — a web frontend, a background worker, a
  cron job.

## Who deploys what

The [Workflow Recipe Controller](../../workflow-recipes/) (WRC) reconciles the
recipe; the [host-context-controller](../../host-context-controller/) (HCC) never
deploys a non-MCP workload directly.

| Workload has…            | WRC does                                                           | HCC does                                        |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `transport: stdio`       | Creates an `McpServer` CRD with `managed: true`                    | Owns the Deployment (injects the stdio-bridge)  |
| `transport: sse \| http` | Creates an `McpServer` CRD with `managed: false`, owns the runtime | Maps/registers it; handles discovery and status |
| **no `transport`**       | Creates the Deployment / StatefulSet / Job / Service directly      | Nothing — no `McpServer` CRD, no registry entry |

HCC **does** own the Context/MCP NetworkPolicies in every runtime namespace, so
it still governs what a non-MCP workload can reach (see below).

## Namespace splitting

Workloads from a single recipe are split three ways
(`workflow-recipes/src/reconciler/workflowRecipeReconciler.ts`):

```typescript
private resolveWorkloadNamespace(workload: WorkloadDef, uiWorkloadId?: string): string {
  if (workload.transport) return this.config.namespace          // mcp-server
  if (uiWorkloadId && workload.id === uiWorkloadId)
    return this.config.sandboxUiNamespace                       // sandbox-ui
  return this.config.sandboxNamespace                           // sandbox-recipes
}
```

- Workloads **with** `transport` → `mcp-server`
- The workload referenced by `spec.ui.workloadRef` → `sandbox-ui`
- Everything else → `sandbox-recipes`

The `WorkflowRecipe` CRDs themselves always live in `sandbox-recipes`.

### Cross-namespace ownership

Kubernetes does not support cross-namespace garbage collection, so when a
manifest is retargeted out of the recipe's own namespace, WRC strips its
`ownerReferences` and falls back to label-based deletion in `reconcileDelete`
(`adjustManifestNamespace`, same file). Same-namespace owner refs are kept. A
finalizer drives cleanup of the cross-namespace resources.

## NetworkPolicy layers (L0–L3)

Every runtime namespace is deny-all by default; each layer opens exactly what is
needed.

| Layer  | Purpose                   | Mechanism                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L0** | Security baseline         | `deny-all` NetworkPolicy — both Ingress and Egress — per runtime namespace                                                                                                                                                                                                                                                       |
| **L1** | Functional infrastructure | DNS egress (port 53) for **every** pod in the namespace. HCC-API and K8s-API egress are pod-selector-scoped, not namespace-wide: in `sandbox-recipes`, HCC-API egress selects `clerum.io/component=workflow-mcp-host` and K8s-API egress selects `clerum.io/k8s-api-egress=true` — so a plain non-MCP workload gets **DNS only** |
| **L2** | Context isolation         | Per `(Context, McpServer)` pair: an ingress policy on the McpServer pod in `mcp-server`, plus egress counterparts in `mcp-host` and `rpc-proxy` (without them, L0's egress deny-all would block agents from reaching the server)                                                                                                 |
| **L3** | Egress control            | External egress per McpServer `egressBindings` (CIDR or DNS)                                                                                                                                                                                                                                                                     |

> **Policy ownership.** L2 and L3 above are HCC's policies for **McpServer**
> pods. The policies for a _recipe workload's_ `egressBindings` are built by WRC
> itself, in that workload's own namespace
> (`buildWorkloadEgressNetworkPolicy` / `buildWorkloadIngressNetworkPolicy`).

The practical consequence: a non-MCP workload in `sandbox-recipes` starts with
DNS and nothing else. Anything further — reaching an MCP server, calling out to
the internet — must be declared, and becomes a policy someone owns.

## What HCC does and does not check

**HCC validates:** that NetworkPolicies are applied correctly, that Context
isolation holds, and that `egressBindings` are configured per `bindings[]`.

**HCC does not validate:** the correctness of a Deployment or StatefulSet built
by WRC, pod readiness (Kubernetes' job), or anything about the workload's own
behavior.

## See also

- [Platform topology](platform-topology.md) — namespaces, controller split, the full NetworkPolicy model
- [WorkflowRecipe CRD](../crds/workflowrecipe.md) — the schema these workloads are declared in
- [Architecture map](../../ARCHITECTURE.md) — every service and which controller creates it
