# Workload Recipes Controller (WRC)

Kubernetes operator that reconciles WorkflowRecipe CRDs into native K8s workloads (Deployments, StatefulSets, CronJobs, Jobs, DaemonSets) with MCP server registration, security policy enforcement, and agentic workflow execution.

## Relationship to HCC

WRC runs as a **separate process** from the host-context-controller (HCC). While HCC manages McpServer/Context CRDs and infrastructure NetworkPolicies, WRC owns the full WorkflowRecipe lifecycle -- from CRD validation through workload creation to workflow orchestration. The two operators coordinate through the K8s API: WRC creates McpServer CRDs for transport-enabled workloads, which HCC then picks up for context mapping.

## Port

`8082` (configurable via `CLERUM_OPERATOR_PORT`)

## Key Features

- **13-state lifecycle** -- WorkflowRecipe CRDs progress through a state machine: `candidate` -> `pending-approval` -> `approved` -> `pending` -> `deploying` -> `testing` -> `active` (plus `pending-operator-input`, `degraded`, `rolling-back`, `failed`, `deprecated`, `rollback-failed` states)
- **Namespace splitting** -- MCP workloads deploy to `mcp-server`; non-MCP workloads deploy to `sandbox-recipes`. In the current recipe schema, MCP workloads are the ones that opt into MCP delegation via `transport`.
- **envSecret** -- Maps individual keys from a K8s Secret to container environment variables without exposing the entire Secret
- **Per-workload security overrides** -- `runAsUser`, `runAsGroup`, `fsGroup`, and `addCapabilities` let images like PostgreSQL (UID 70) and MongoDB (UID 999) run under their expected user while maintaining `runAsNonRoot: true` and `DROP ALL`
- **StatefulSet + VCT support** -- `volumeClaimTemplates` for persistent storage; automatic volume filtering excludes `emptyDir` volumes for names matching VCTs
- **Template interpolation** -- `{{...}}` placeholders in `env[]`, `command[]`, and `args[]` resolved at reconcile time via `inputResolver` and `templateEngine`
- **Dependency graph** -- Topological sort of workload dependencies ensures correct creation order
- **MCP delegation** -- Transport-enabled workloads create McpServer CRDs: HTTP transports use `managed: false` because WRC owns the runtime, while stdio transports use `managed: true` because HCC owns the stdio-bridge runtime
- **Policy enforcement** -- Validates recipes against cluster-wide WorkflowRecipePolicy CRDs before deployment
- **Agentic workflows** -- Recipes with `spec.steps[]` spawn a Coordinator pod that executes multi-step LLM workflows via mcp-host, with step dependency resolution, model config overrides, and status reporting
- **MCP server interface** -- Exposes `deploy_recipe`, `list_recipes`, `get_recipe_status`, `rollback_recipe`, `delete_recipe`, `validate_recipe`, `search_registry`, and `list_policies` tools via MCP (StreamableHTTP on port 8082)

## Architecture

```
WorkflowRecipe CRD (K8s watch)
        ↓
WRC Reconciler (19 numbered steps, labeled 2-10; Step 1 implicit)
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

> **Step numbering note:** In `workflowRecipeReconciler.ts`, the `// Step N` comments start at **Step 2** and run through **Step 10**, totalling 19 numbered steps (2, 2.5, 3, 3a, 4, 4a, 5, 6, 7, 7a, 7b, 7c, 8, 9, 9b, 9c, 9d, 9a, 10 — note 9a appears after 9b-9d in the source). **Step 1 is implicit** — it's the namespace allowlist, workflow-detection and non-deployable-phase guard that runs at the top of `reconcile()`, before the main `try` block. The `WorkflowRecipe` with `steps[]` (coordinator-driven execution) follows a separate branch and delegates to `workflowReconciler.ts` rather than using the numbered steps above.

## Environment Variables

The WRC reads ~60 environment variables. Defaults below are the literal
fallbacks in `src/config.ts` (and, where noted, the reconciler). Rows marked 🔒
are **security-load-bearing** — loosening them weakens an enforced control.

Most numeric limits are **ceilings, not suggestions**: `getEnvBoundedInt` is
called with `max === default` for nearly all of them, so the environment can only
_lower_ a limit, never raise it, and an out-of-range value **throws at startup**
rather than silently clamping.

### Core / server

| Variable                  | Default                                                   | Description                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_DEV_MODE`         | `false`                                                   | 🔒 Use the mock K8s provider. **Bigger than its name suggests**: it also skips `validateInfrastructure()`, which is what enforces the HMAC-secret check below. Never enable in a cluster. |
| `CLERUM_OPERATOR_PORT`    | `8082`                                                    | MCP StreamableHTTP + REST listen port.                                                                                                                                                    |
| `CLERUM_OPERATOR_NAME`    | `workflow-recipes`                                        | Operator identity, used in labels and as the `WRC_INSTANCE_ID` fallback.                                                                                                                  |
| `CLERUM_WRC_SERVICE_NAME` | `workflow-recipes`                                        | Service name WRC advertises to spawned pods.                                                                                                                                              |
| `CONTROL_API_BASE_URL`    | `http://control-api.control-plane.svc.cluster.local:8090` | control-api endpoint for GFS binding, OAuth-broker and runtime-token issuance.                                                                                                            |

### Namespaces

| Variable                        | Default           | Description                                                                                                                                |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLERUM_NAMESPACE`              | `mcp-server`      | Namespace for the **McpServer transport children** WRC renders for workloads that declare `transport`.                                     |
| `CLERUM_SANDBOX_NAMESPACE`      | `sandbox-recipes` | Where WorkflowRecipe CRDs, coordinator pods, and recipe mcp-host pods live.                                                                |
| `CLERUM_SANDBOX_UI_NAMESPACE`   | `sandbox-ui`      | 🔒 Namespace for sandbox UI workloads (`spec.ui.workloadRef`), kept separate so NetworkPolicy can scope rpc-proxy ingress to UI pods only. |
| `CLERUM_HOST_NAMESPACE`         | `mcp-host`        | mcp-host service namespace.                                                                                                                |
| `WRC_CONTROL_PLANE_NAMESPACE`   | `control-plane`   | control-api's namespace, used in the per-recipe egress policy for background-OAuth workloads.                                              |
| `WRC_WEBHOOK_INGRESS_NAMESPACE` | `webhook-ingress` | webhook-proxy namespace label used in per-recipe NetworkPolicies.                                                                          |
| `WRC_MONITORING_NAMESPACE`      | `monitoring`      | Prometheus scraper namespace label used in per-recipe NetworkPolicies.                                                                     |

### Security & tokens

| Variable                                   | Default                         | Description                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTERNAL_CONTROL_JWT_WRC_HMAC_SECRET`     | `''` — **effectively required** | 🔒 HS256 secret for signing InternalControl JWTs to control-api. `validateInfrastructure()` **fails startup fatally** if it is empty or still a `replace-with-*` placeholder. Bypassed only by `CLERUM_DEV_MODE=true`. |
| `CONTROL_API_PUBLIC_KEY_PEM`               | unset → **fail-closed**         | 🔒 Public key verifying control-api delegation JWTs. Unset means admin delegation paths return **401** — the correct posture, not a silent allow. Must stay in sync with control-api's admin private key.              |
| `WRC_RUNTIME_TOKEN_TTL_SECONDS`            | `900` (max `86400`)             | 🔒 TTL of runtime tokens minted for workflow pods. Shorter = smaller blast radius on leak.                                                                                                                             |
| `WRC_RUNTIME_TOKEN_REFRESH_BEFORE_SECONDS` | `300` (max = TTL)               | 🔒 How long before expiry a runtime token refreshes. **Must be strictly less than the TTL** — startup throws otherwise.                                                                                                |
| `WRC_ENABLE_LEGACY_DIRECT_TRIGGER`         | unset (disabled)                | 🔒 Re-enables the deprecated direct-trigger REST endpoint, which otherwise returns **410 Gone**. Leave unset; callers should use the control-api workflow broker.                                                      |

### Coordinator image policy

| Variable                                 | Default      | Description                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE`    | `false`      | 🔒 Master switch letting a recipe supply its own coordinator image. Off by default: recipes run only the operator-pinned `CLERUM_COORDINATOR_IMAGE`. Enabling it means recipe authors choose the code that drives execution — gate it with the two vars below. |
| `WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES` | `[]` (empty) | 🔒 Allowlist of registry/repo prefixes permitted for custom coordinator images. Empty = nothing allowlisted.                                                                                                                                                   |
| `WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST`   | `true`       | 🔒 Require `@sha256:` digest pinning rather than a mutable tag. **Do not set `false`** — a tag-only reference lets image content change under an already-approved recipe.                                                                                      |

### Feature flags

| Variable                      | Default | Description                                                                                                                                               |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRC_ENABLE_SNIPPET_RUNTIME`  | `false` | 🔒 Enables execution of user-authored snippet steps. Off by default because snippets run arbitrary user code.                                             |
| `PLUGIN_WORKLOAD_SDK_ENABLED` | `false` | Master switch for the Plugin Workload SDK (`promptBridge` + `clientNotifications`). When false, `spec.pluginWorkloadSdk` validates but activates nothing. |
| `WRC_ENABLE_DETERMINISTIC`    | `true`  | Deterministic reconcile/rendering (stable ordering, reproducible manifests).                                                                              |

### NetworkPolicy enforcement

| Variable                                      | Default    | Description                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE`      | `required` | 🔒 `required` = recipes are blocked unless their NetworkPolicies can be enforced. `warn` = violations logged, recipe proceeds. Any other value **throws at startup**. `warn` is a migration-only escape hatch.                                                     |
| `CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED` | `false`    | 🔒 Operator attestation that the cluster runs a NetworkPolicy-enforcing CNI (Calico, Cilium — plain kubenet silently ignores NetworkPolicy objects). Set `true` only after verifying enforcement: `required` mode is meaningless on a CNI that drops the policies. |

### Image pins

Read in `workflowRecipeReconciler.ts`. 🔒 **Every default is `:latest`** — a mutable
tag. The deploy manifest overrides all of them with version pins; keep it that
way, and prefer digests in hardened environments.

| Variable                       | Default                                 | Description                                                                                                                                      |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLERUM_COORDINATOR_IMAGE`     | `clerum/workflow-coordinator:latest`    | Coordinator pod image (manifest pins `0.9.5`).                                                                                                   |
| `CLERUM_MCP_HOST_IMAGE`        | `clerum/mcp-host:latest`                | Per-recipe mcp-host image (manifest pins `0.9.5`).                                                                                               |
| `CLERUM_ARTIFACT_READER_IMAGE` | `clerum/workflow-recipes:latest`        | Artifact-reader sidecar — the WRC image, different entrypoint (manifest pins `0.9.5`).                                                           |
| `CLERUM_SNIPPET_RUNNER_IMAGE`  | `clerum/workflow-snippet-runner:latest` | Snippet-runner pod image (manifest pins `0.9.5`).                                                                                                |
| `WRC_WEBHOOK_GATEWAY_IMAGE`    | `clerum/webhook-gateway:latest`         | Injected into per-recipe webhook-gateway Deployments when `spec.webhooks[]` is set (manifest pins `0.1.0`).                                      |
| `CLERUM_IMAGE_PULL_POLICY`     | `IfNotPresent`                          | Pull policy for spawned pods. Manifest sets `Always`. Cast unchecked — a typo yields an invalid pod spec at reconcile time, not a startup error. |

### Workflow limits

| Variable                                                 | Default / max        | Description                                                                                                                                                        |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WRC_MAX_WORKFLOW_STEPS`                                 | `100` / `100`        | Max steps per workflow (falls back to `CLERUM_WORKFLOW_MAX_STEPS`).                                                                                                |
| `CLERUM_WORKFLOW_MAX_WORKLOADS_PER_RECIPE`               | `25` / `25`          | Max workloads a recipe may render.                                                                                                                                 |
| `CLERUM_WORKFLOW_UI_EGRESS_INTERNAL_MAX_ITEMS`           | `25` / `25`          | 🔒 Max internal-egress entries a UI workload may declare — caps how many in-cluster destinations a sandbox UI can reach.                                           |
| `CLERUM_WORKFLOW_STEP_DEPENDS_ON_MAX_ITEMS`              | `100` / `100`        | Max `dependsOn` entries per step.                                                                                                                                  |
| `CLERUM_WORKFLOW_STEP_ALLOWED_TOOLS_MAX_ITEMS`           | `50` / **`100`**     | Max `allowedTools` per step — the one limit whose ceiling exceeds its default.                                                                                     |
| `CLERUM_WORKFLOW_STEP_MCP_SERVERS_MAX_ITEMS`             | `20` / `20`          | Max MCP servers per step.                                                                                                                                          |
| `CLERUM_WORKFLOW_STATEFULSET_MAX_REPLICAS`               | `20` / `20`          | Max StatefulSet replicas per workload.                                                                                                                             |
| `CLERUM_WORKFLOW_STATEFULSET_MAX_VOLUME_CLAIM_TEMPLATES` | `4` / `4`            | Max `volumeClaimTemplates` per StatefulSet.                                                                                                                        |
| `WRC_WORKFLOW_MAX_RUN_DURATION_SECONDS`                  | `86400` / `86400`    | Hard ceiling on a single workflow run.                                                                                                                             |
| `WRC_WORKFLOW_DEFAULT_RUN_DURATION_SECONDS`              | `3600` / = above     | Default run duration when a recipe does not specify one.                                                                                                           |
| `WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS`             | `32768` (1024–65536) | Step output stored in CRD status. Keep `steps × preview_chars` under the etcd object budget (~1.5 MiB); full outputs belong in `/output` artifacts.                |
| `WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS`                 | `300` (30–3600)      | 🔒 Grace window where an old egress DNS entry stays allowed after rotation, so in-flight connections survive. Longer = a stale destination stays reachable longer. |

### Database (Postgres)

Supplied via `envFrom: secretRef: control-postgres`. WRC holds a sticky session
for leader election, run notifications, schedule workers, and archive maintenance.

| Variable             | Default                                            | Description                                                                                                                      |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_HOST`      | `control-postgres.control-plane.svc.cluster.local` | Postgres host.                                                                                                                   |
| `POSTGRES_PORT`      | `5432`                                             | Postgres port.                                                                                                                   |
| `POSTGRES_USER`      | `clerum`                                           | Postgres user.                                                                                                                   |
| `POSTGRES_PASSWORD`  | `''`                                               | 🔒 From the `control-postgres` Secret — never hard-code it in a manifest.                                                        |
| `POSTGRES_DB`        | `clerum`                                           | Database name.                                                                                                                   |
| `POSTGRES_SSL`       | `false`                                            | 🔒 TLS to Postgres. The `false` default assumes in-cluster traffic; enable it for any off-cluster or untrusted-network database. |
| `POSTGRES_POOL_MAX`  | `4`                                                | Max pooled connections per replica.                                                                                              |
| `WRC_INSTANCE_ID`    | `$HOSTNAME`, else `wrc-local`                      | Per-replica ID stamped into `workflow_runs.owner_instance_id`.                                                                   |
| `WRC_LEADER_POLL_MS` | `10000`                                            | Leader-lock re-probe cadence when not the leader.                                                                                |
| `WRC_RUN_POLL_MS`    | `30000`                                            | Fallback run poll, in case a `NOTIFY` is missed across reconnects.                                                               |

### Child-pod passthrough

WRC does not read these itself — `buildPropagatedEnv()` copies them from the
controller's environment into spawned pods via three explicit **allowlists**,
rather than a blanket copy, precisely so controller secrets cannot leak into
recipe pods. 🔒 Adding a name to an allowlist widens what a recipe pod can see;
treat those lists as a security boundary. An empty-string value is skipped
(meaning "omit it, use the downstream default").

| Variable                                           | Manifest  | Forwarded to             | Description                                                                     |
| -------------------------------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------- |
| `MCP_HOST_STEP_TIMEOUT_SECONDS`                    | `300`     | coordinator              | Per-step timeout enforced by the coordinator.                                   |
| `CLERUM_WORKFLOW_PREVIOUS_OUTPUT_PROMPT_MAX_CHARS` | `8192`    | coordinator              | Cap on how much of the previous step's output is injected into the next prompt. |
| `CLERUM_MCP_TOOL_TIMEOUT_MS`                       | `3600000` | mcp-host, snippet-runner | Single MCP tool-call timeout.                                                   |
| `CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS`             | `3600000` | mcp-host, snippet-runner | Cumulative MCP tool-call budget.                                                |
| `MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS`              | `""`      | mcp-host                 | Optional cap on provider output tokens. Empty → provider default.               |

### Registry

None are set in the manifest — the registry client is inert by default.

| Variable                        | Default | Description                                                       |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `CLERUM_REGISTRY_URL`           | `''`    | Recipe registry base URL, used by the `search_registry` MCP tool. |
| `CLERUM_REGISTRY_AUTH_ENABLED`  | `false` | Enable OAuth2 client-credentials auth against the registry.       |
| `CLERUM_REGISTRY_CLIENT_ID`     | unset   | OAuth2 client ID.                                                 |
| `CLERUM_REGISTRY_CLIENT_SECRET` | unset   | 🔒 OAuth2 client secret — source from a Secret, not a literal.    |

### Observability / dev-only

| Variable                | Default   | Description                                                                         |
| ----------------------- | --------- | ----------------------------------------------------------------------------------- |
| `LOG_LEVEL`             | `info`    | Minimum log level; unrecognized values fall back to `info`.                         |
| `CLERUM_CORRELATION_ID` | `unknown` | Correlation ID stamped into structured logs.                                        |
| `CLERUM_RECIPES`        | unset     | **Dev mode only.** JSON array of WorkflowRecipe CRDs seeded into the mock provider. |

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
# Build context must be the repo root -- the Dockerfile COPYs shared packages
# (packages/workflow-runtime-core, packages/workflow-recipe-capability-policy,
# packages/image-policy) that live outside workflow-recipes/.
docker build -t clerum/workflow-recipes:latest -f workflow-recipes/Dockerfile .
```

The Dockerfile exposes port 8082 and runs as non-root (`USER node`).

## Testing

```bash
cd workflow-recipes
npm test          # vitest — 130+ test files under src/ and tests/
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
│   ├── tools.ts           # Tool definitions (deploy/list/status/rollback/delete/validate/search/policies)
│   └── handlers.ts        # Tool handler implementations
├── reconciler/
│   ├── workflowRecipeReconciler.ts  # 19 numbered steps (2-10); Step 1 implicit at reconcile() entry
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
    ├── triggerHandler.ts     # External trigger support
    ├── signalStore.ts        # Inter-step signal passing
    ├── rateLimiter.ts        # LLM call rate limiting
    ├── historyManager.ts     # Execution history
    ├── restEndpoints.ts      # REST API for coordinator
    ├── objectStorageAdapter.ts # S3-compatible artifact storage
    ├── objectStorageClient.ts  # Storage client
    ├── k8sSecretReaderImpl.ts  # K8s Secret reader
    └── types.ts             # Workflow-specific types
```
