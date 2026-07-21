# Workload Recipes Controller (WRC)

Kubernetes operator that reconciles WorkflowRecipe CRDs into native K8s workloads (Deployments, StatefulSets, CronJobs, Jobs, DaemonSets) with MCP server registration, security policy enforcement, and agentic workflow execution.

## Relationship to HCC

WRC runs as a **separate process** from the host-context-controller (HCC). While HCC manages McpServer/Context CRDs and infrastructure NetworkPolicies, WRC owns the full WorkflowRecipe lifecycle -- from CRD validation through workload creation to workflow orchestration. The two operators coordinate through the K8s API: WRC creates McpServer CRDs for transport-enabled workloads, which HCC then picks up for context mapping.

## Port

`8082` (configurable via `CLERUM_OPERATOR_PORT`)

## Key Features

- **13-state lifecycle** -- WorkflowRecipe CRDs progress through a state machine: `candidate` -> `pending-approval` -> `approved` -> `pending` -> `deploying` -> `testing` -> `active` (plus `degraded`, `rolling-back`, `failed`, `deprecated`, `rollback-failed` terminal states)
- **Namespace splitting** -- MCP workloads deploy to `mcp-server`; non-MCP workloads deploy to `sandbox-recipes`. In the current recipe schema, MCP workloads are the ones that opt into MCP delegation via `transport`.
- **envSecret** -- Maps individual keys from a K8s Secret to container environment variables without exposing the entire Secret
- **Per-workload security overrides** -- `runAsUser`, `runAsGroup`, `fsGroup`, and `addCapabilities` let images like PostgreSQL (UID 70) and MongoDB (UID 999) run under their expected user while maintaining `runAsNonRoot: true` and `DROP ALL`
- **StatefulSet + VCT support** -- `volumeClaimTemplates` for persistent storage; automatic volume filtering excludes `emptyDir` volumes for names matching VCTs
- **Template interpolation** -- `{{...}}` placeholders in `env[]`, `command[]`, and `args[]` resolved at reconcile time via `inputResolver` and `templateEngine`
- **Dependency graph** -- Topological sort of workload dependencies ensures correct creation order
- **MCP delegation** -- Transport-enabled workloads create McpServer CRDs: HTTP transports use `managed: false` because WRC owns the runtime, while stdio transports use `managed: true` because HCC owns the stdio-bridge runtime
- **Policy enforcement** -- Validates recipes against cluster-wide WorkflowRecipePolicy CRDs before deployment
- **Agentic workflows** -- Recipes with `spec.steps[]` spawn a Coordinator pod that executes multi-step LLM workflows via mcp-host, with step dependency resolution, model config overrides, and status reporting
- **MCP server interface** -- Exposes `list-recipes`, `get-recipe`, `deploy-recipe`, `delete-recipe`, and `get-recipe-status` tools via MCP (StreamableHTTP on port 8082)

## Architecture

```
WorkflowRecipe CRD (K8s watch)
        ↓
WRC Reconciler (14 numbered steps, labeled 2-9a; Step 1 implicit)
  ├── inputResolver     → resolve defaults + profiles
  ├── templateEngine    → {{...}} substitution
  ├── dependencyGraph   → topological sort
  ├── policyEnforcer    → validate against policies
  ├── resourceBuilder   → build K8s manifests
  ├── mcpDelegation     → create McpServer CRDs for transport workloads
  └── stateMachine      → phase transitions
        ↓
K8s Resources (Deployments, StatefulSets, Services, PVCs, Secrets, ConfigMaps)
        ↓
Coordinator Pod (for workflow recipes with steps[])
  └── sdkRuntime → snippet and agentic step execution
```

> **Step numbering note:** In `workflowRecipeReconciler.ts`, the `// Step N` comments start at **Step 2** and run through **Step 9a**, totalling 14 numbered steps (including sub-steps 2.5, 3a, 4a, 7b, 7c, 9a). **Step 1 is implicit** — it's the workflow-detection and non-deployable-phase guard that runs before the main `try` block (roughly lines 176-329 of the reconciler). The `WorkflowRecipe` with `steps[]` (coordinator-driven execution) follows a separate branch and delegates to `workflowReconciler.ts` rather than using the numbered steps above.

## Environment Variables

| Variable                   | Default            | Description                         |
| -------------------------- | ------------------ | ----------------------------------- |
| `CLERUM_DEV_MODE`          | `false`            | Dev mode: use mock K8s provider     |
| `CLERUM_OPERATOR_PORT`     | `8082`             | MCP server listen port              |
| `CLERUM_NAMESPACE`         | `mcp-server`       | Primary namespace for MCP workloads |
| `CLERUM_SANDBOX_NAMESPACE` | `sandbox-recipes`  | Namespace for non-MCP workloads     |
| `CLERUM_HOST_NAMESPACE`    | `mcp-host`         | mcp-host service namespace          |
| `CLERUM_OPERATOR_NAME`     | `workflow-recipes` | Operator identity (used in labels)  |

## Local Development

```bash
cd workflow-recipes
npm install

# Dev mode (no K8s required)
CLERUM_DEV_MODE=true npm run dev

# Against a live cluster (requires kubeconfig)
npm run dev
```

## Docker Build

```bash
docker build -t clerum/workflow-recipes:latest ./workflow-recipes
```

The Dockerfile exposes port 8082 and runs as non-root (`USER node`).

## Testing

```bash
cd workflow-recipes
npm test          # vitest — 790 tests across 15 test files
npm run test:watch
npm run test:e2e  # E2E tests (requires minikube)
```

Test files are co-located with source in `src/` (e.g., `reconciler/resourceBuilder.test.ts`) plus MCP tool tests in `src/mcp/`. Vitest config excludes `tests/e2e/` and `dist/` from unit runs.

### Test Coverage by Module

| Module            | Test file                         | Focus                                                                         |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| reconciler        | `reconciler.test.ts`              | Full reconcile pipeline                                                       |
| resourceBuilder   | `resourceBuilder.test.ts`         | K8s manifest generation (Deployments, StatefulSets, envSecret, PVC, security) |
| securityContext   | `securityContext.test.ts`         | Per-workload security overrides                                               |
| stateMachine      | `stateMachine.test.ts`            | Phase transitions                                                             |
| templateEngine    | `templateEngine.test.ts`          | `{{...}}` interpolation                                                       |
| inputResolver     | `inputResolver.test.ts`           | Default/profile input resolution                                              |
| dependencyGraph   | `dependencyGraph.test.ts`         | Topological sort                                                              |
| includeWhenFilter | `includeWhenFilter.test.ts`       | Conditional workload inclusion                                                |
| computedValues    | `computedValuesEvaluator.test.ts` | Dynamic value computation                                                     |
| mcpDelegation     | `mcpDelegation.test.ts`           | McpServer CRD creation                                                        |
| policyEnforcer    | `policyEnforcer.test.ts`          | Policy validation                                                             |
| types             | `types.test.ts`                   | Type guards                                                                   |
| config            | `config.test.ts`                  | Config loading                                                                |
| mcp/tools         | `tools.test.ts`                   | MCP tool definitions                                                          |
| mcp/handlers      | `handlers.test.ts`                | MCP tool handlers                                                             |

## Further Reading

- [WorkflowRecipe CRD reference](../docs/crds/workflowrecipe.md)
- [Workflow Recipes feature hub](../docs/features/workflow-recipes.md)

## Source Layout

```
src/
├── main.ts                # Entrypoint: validate infra, start provider + MCP server
├── config.ts              # Env-based config loader
├── types.ts               # CRD types, phase enum, type guards
├── k8sClient.ts           # K8s watcher / dev-mode provider
├── coordinator.ts         # Workflow Coordinator pod entrypoint
├── metrics.ts             # Prometheus metrics
├── observability/         # Logger, tool tracer
├── registry/              # Container registry client
├── mcp/
│   ├── server.ts          # MCP StreamableHTTP server
│   ├── tools.ts           # Tool definitions (list/get/deploy/delete/status)
│   └── handlers.ts        # Tool handler implementations
├── reconciler/
│   ├── workflowRecipeReconciler.ts  # 14 numbered steps (2-9a); Step 1 implicit at reconcile() entry
│   ├── resourceBuilder.ts           # K8s manifest builders
│   ├── securityContext.ts           # Security context with overrides
│   ├── stateMachine.ts              # 13-phase state machine
│   ├── templateEngine.ts            # {{...}} interpolation
│   ├── inputResolver.ts             # Input defaults + profiles
│   ├── dependencyGraph.ts           # Topological sort
│   ├── mcpDelegation.ts             # McpServer CRD delegation to HCC
│   ├── policyEnforcer.ts            # Policy validation
│   ├── policyClient.ts              # Policy CRD reader
│   ├── includeWhenFilter.ts         # Conditional workload filter
│   ├── computedValuesEvaluator.ts   # Dynamic value computation
│   ├── crdConstants.ts              # CRD group/version/plural
│   └── k8sErrors.ts                 # K8s error code helpers
└── workflow/
    ├── sdkRuntime.ts        # Runtime dispatcher for snippet and agentic steps
    ├── workflowReconciler.ts # Workflow-specific reconcile extensions
    ├── podFactory.ts        # Coordinator Pod spec builder
    ├── statusReporter.ts    # CRD status update client
    ├── crashRecovery.ts     # Resume after coordinator restart
    ├── stepDependencyGraph.ts # Step-level dependency resolution
    ├── finalizationHandler.ts # Post-workflow cleanup
    ├── childRecipeFactory.ts  # Sub-recipe creation
    ├── secretFactory.ts     # JWT + secret generation
    ├── jwtTokenFactory.ts   # WRC signing token
    ├── networkPolicyFactory.ts # Sandbox NetworkPolicies
    ├── modelConfigHandler.ts # Per-step model overrides
    ├── httpMcpHostClient.ts  # mcp-host HTTP client
    ├── schedulingHandler.ts  # Cron/trigger scheduling
    ├── signalStore.ts        # Inter-step signal passing
    ├── rateLimiter.ts        # LLM call rate limiting
    ├── historyManager.ts     # Execution history
    ├── restEndpoints.ts      # REST API for coordinator
    ├── objectStorageAdapter.ts # S3-compatible artifact storage
    ├── objectStorageClient.ts  # Storage client
    ├── k8sSecretReaderImpl.ts  # K8s Secret reader
    └── types.ts             # Workflow-specific types
```
