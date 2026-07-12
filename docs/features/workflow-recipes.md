# WorkflowRecipes — Feature Hub

WorkflowRecipes are evenfire’s multi-workload CRD: compose Deployments,
StatefulSets, CronJobs, Jobs, and DaemonSets with MCP registration, network
bindings, security overrides, and scoped runtime tokens.

Because the feature spans schema, operator internals, deployment ops, and
security policy, docs live in several places. **This page is the single
starting point.**

> **Naming:** CRD kinds are `WorkflowRecipe` and `WorkflowRecipePolicy`. The
> operator directory is `workflow-recipes/`; the module is often called Workload
> Recipe Controller (WRC). Public product name is **evenfire**; APIs remain
> `clerum.io` — [code names](../concepts/code-names.md).

---

## CRD reference

- **[WorkflowRecipe CRD](../crds/workflowrecipe.md)** — schema, validation,
  approval semantics, lifecycle, security overrides
- **[WorkflowRecipePolicy CRD](../crds/workflowrecipepolicy.md)** — governance
  policy for recipes
- **[Custom coordinator snippet workflow](./custom-coordinator-snippet-workflow.md)** —
  snippet business logic with the curated SDK
- **[Custom coordinator images](custom-coordinator-images.md)** — custom
  `coordinatorImage`, `/output` artifacts, optional MCP tools
- **[CRD YAML examples](../../charts/clerum-crds/examples/)** — including the
  [MongoDB StatefulSet recipe](../../charts/clerum-crds/examples/MONGODB-STATEFULSET-README.md)

## Architecture

- **[Platform topology](../architecture/platform-topology.md)** — namespaces,
  HCC/WRC split, deny-all baseline
- **[Non-MCP services](../architecture/non-mcp-services.md)** — namespace
  splitting (`transport` → `mcp-server`, else `sandbox-recipes`), L0–L3 policies

## Deployment & operations

- **[WorkflowRecipes operations guide](../deploy/workflow-recipes-guide.md)** —
  Control UI/API, RBAC, REST routes, debugging
- **[Minikube deploy guide](../deploy/minikube.md)** — local full stack
- **[Production notes](../deploy/production.md)** — production checklist and
  in-repo deploy assets

## Security

- Recipe CRDs and sandbox workloads follow platform namespace rules
  (`sandbox-recipes` vs `mcp-server` for transport children)
- NetworkPolicy behavior: static manifests under
  `deploy/base/**/networkpolicies*.yaml` plus HCC-managed policies described in
  [architecture overview](../architecture/overview.md)
- Root [security model](../../README.md#security-model)

## Operator internals

- **[`workflow-recipes/README.md`](../../workflow-recipes/README.md)** — reconciler
  entry, tests, module layout
- **[host-context-controller README](../../host-context-controller/README.md)** —
  parent operator hosting Context Mapper and related modules

## Quick reference

| I want to…                       | Go to                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Define a WorkflowRecipe          | [CRD reference](../crds/workflowrecipe.md)                                             |
| Write TypeScript snippet logic   | [Snippet workflow](./custom-coordinator-snippet-workflow.md)                           |
| Build a custom coordinator image | [Custom images](custom-coordinator-images.md)                                          |
| See a working YAML example       | [MongoDB StatefulSet](../../charts/clerum-crds/examples/MONGODB-STATEFULSET-README.md) |
| Deploy locally                   | [Minikube](../deploy/minikube.md)                                                      |
| Plan production                  | [Production notes](../deploy/production.md)                                            |
| Understand namespace splitting   | [Non-MCP services](../architecture/non-mcp-services.md)                                |
| Debug a stuck recipe             | [Operations guide](../deploy/workflow-recipes-guide.md)                                |
| Understand HCC/WRC architecture  | [Platform topology](../architecture/platform-topology.md)                              |
