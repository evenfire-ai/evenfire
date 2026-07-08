# WorkflowRecipes — Feature Hub

WorkflowRecipes is Clerum's most complex CRD, enabling declarative multi-workload applications (Deployments, StatefulSets, CronJobs, Jobs, DaemonSets) with MCP server registration, network bindings, security overrides, and envSecret support. Because the feature spans CRD schema, operator internals, deployment operations, and security policy, its documentation is distributed across several locations in this repo.

This page is your single starting point for everything WorkflowRecipe-related.

> **Naming note:** The CRD kind is `WorkflowRecipe` (and `WorkflowRecipePolicy`). The operator directory is `workflow-recipes/` and the module is "Workload Recipe Controller (WRC)" — these names are historical and intentionally unchanged.

---

## CRD Reference

- **[WorkflowRecipe CRD Reference](../crds/workflowrecipe.md)** — full CRD schema (fields, CEL validation, approval semantics, resource lifecycle, security overrides, envSecret, namespace splitting). This is the authoritative spec for CRD users.
- **[Custom Coordinator Snippet Workflow](./custom-coordinator-snippet-workflow.md)** — developer guide for writing snippet business logic with the curated SDK, declared HTTP/DB/MCP capabilities, and run-scoped artifacts.
- **[Custom Coordinator Images](custom-coordinator-images.md)** — developer guide for building a custom `coordinatorImage`, writing business logic, producing `/output` artifacts, and optionally using WRC-managed `mcp-host`/MCP tools.
- **[CRD YAML Examples](../../charts/clerum-crds/examples/)** — working example manifests, including the [MongoDB StatefulSet recipe](../../charts/clerum-crds/examples/MONGODB-STATEFULSET-README.md).

## Architecture

- **[Platform Topology](../architecture/platform-topology.md)** — 7-namespace architecture, HCC/WRC controller split, deny-all security baseline. Explains how WRC fits into the Host Context Controller process.
- **[Non-MCP Services Architecture](../architecture/non-mcp-services.md)** — namespace splitting rules (workloads with `transport` → `mcp-server`, without → `sandbox-recipes`), L0–L3 NetworkPolicy layers.

## Deployment & Operations

- **[WorkflowRecipes Operations Guide](../deploy/workflow-recipes-guide.md)** — configuration, Control UI/API integration, RBAC requirements, REST API routes, debugging guide.
- **[WorkflowRecipes Bug Index](../deploy/workflow-bugs-2026-03-24.md)** — 10 bugs from the validation phase with root causes, severity, and fix commits.
- **[GCP Deployment Guide](../deploy/gcp.md)** — production deployment including WorkflowRecipe CRD installation and instance application.
- **[Minikube Deployment Guide](../deploy/minikube.md)** — local development stack including WorkflowRecipe testing.

## Security

- WorkflowRecipe CRDs are always owned by the platform in `sandbox-recipes`.
- `mcp-server` is reserved for transport children generated from recipes that declare transport workloads.
- NetworkPolicy behavior is split between static manifests under `deploy/base/**/networkpolicies*.yaml` and HCC runtime-managed policies described in `docs/architecture/overview.md`.

## Operator Internals

- **[`workflow-recipes/README.md`](../../workflow-recipes/README.md)** — WRC reconciler entry point, test instructions, module architecture.
- **[Host Context Controller README](../../host-context-controller/README.md)** — parent operator that hosts both Context Mapper and WRC modules.

## Historical Archive

- **[`docs/archive/clerum-workflow-recipes/`](../archive/clerum-workflow-recipes/)** — phase plans (PHASE-1 through PHASE-9), workflow stages (STAGE-1 through STAGE-6), E2E test runbooks (FASE-1 through FASE-7), early specs (WRO-SPECIFICATION, USER-APPROVAL-WORKFLOW-SPEC, WORKFLOW-ADJUSTMENT-PLAN), and review artifacts. These are point-in-time planning docs from the 2026-02 through 2026-03 build-out and are not maintained.

## Quick reference

| I want to… | Go to |
|---|---|
| Define a new WorkflowRecipe CRD | [CRD Reference](../crds/workflowrecipe.md) |
| Write TypeScript snippet workflow logic | [Custom Coordinator Snippet Workflow](./custom-coordinator-snippet-workflow.md) |
| Build a custom coordinator image | [Custom Coordinator Images](custom-coordinator-images.md) |
| See a working YAML example | [MongoDB StatefulSet](../../charts/clerum-crds/examples/MONGODB-STATEFULSET-README.md) |
| Deploy to my cluster | [GCP Guide](../deploy/gcp.md) or [Minikube Guide](../deploy/minikube.md) |
| Understand namespace splitting | [Non-MCP Services](../architecture/non-mcp-services.md) |
| Debug a stuck recipe | [Operations Guide](../deploy/workflow-recipes-guide.md) |
| Understand HCC/WRC architecture | [Platform Topology](../architecture/platform-topology.md) |
| Read historical design decisions | [Archive](../archive/clerum-workflow-recipes/) |
