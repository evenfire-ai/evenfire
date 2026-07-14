# @clerum/workflow-sdk

A TypeScript library for building **custom workflow coordinator Pods** that plug into the
evenfire/Clerum `WorkflowRecipe` runtime. A coordinator is the process that runs inside a
workflow's Pod: it loads the workflow spec from a mounted volume, resolves step order,
executes steps (either as deterministic in-coordinator logic or by delegating agentic work to
the `mcp-host` service), reports status back to the Workflow Runtime Controller (WRC), and
responds to control signals (pause / resume / cancel / approval). The SDK wires all of these
pieces together behind a single façade, `WorkflowSDK`, so your coordinator focuses only on step
business logic.

## Install & prerequisites

- **Node.js `>=20`.**
- `@clerum/workflow-sdk` depends on `@clerum/workflow-runtime-core`, where the concrete
  implementations actually live. The SDK barrel re-exports the public runtime-core symbols
  (`ConfigLoader`, `StepCoordinator`, `StatusReporter`, `SignalPoller`, `McpHostClient`, the
  prompt/soul/model injection helpers, error types, and all the value/spec types); only the
  `WorkflowSDK` class and the registry interfaces are defined in this package. **Both packages
  must be present at runtime.**
- The dependency is declared as a local filesystem link
  (`"@clerum/workflow-runtime-core": "file:../workflow-runtime-core"`) — runtime-core is an
  internal package that is not published on its own. As a result there is **no standalone
  `npm install @clerum/workflow-sdk`** that resolves for an outside consumer: installing from a
  registry would try to resolve `file:../workflow-runtime-core`, which does not exist outside
  this repository, and fail. Consume the SDK from a checkout of this repository, where the
  sibling package resolves, and build your coordinator image from the repository root (see
  [Building a coordinator image](#building-a-coordinator-image)).

```bash
# From a clone of this repository, with both sibling packages present:
git clone <this-repo> && cd <this-repo>/packages/workflow-sdk
npm install   # resolves the file: link to ../workflow-runtime-core
```

The runtime environment (env vars, token files, and the mounted spec volume) is injected by WRC
when it schedules your Pod — you do not set these yourself.

## Core concepts — the coordinator lifecycle

1. **Load config** — `WorkflowSDK.fromEnvironment()` reads required env vars, builds a token
   provider, initializes the logger, and wires every component. `sdk.config.getSpec()` reads and
   validates the workflow spec from the mounted volume (default `/etc/workflow/config.json`).
2. **Poll signals** — `sdk.signals` (a `SignalPoller`) polls WRC for control signals; a local
   REST server started by `fromEnvironment()` can also receive pushed signals.
3. **Coordinate steps** — `sdk.coordinator.resolveOrder(spec.steps)` computes a deterministic
   execution order (Kahn topological sort over `step.dependsOn`, throwing `CycleDetectedError`
   on cycles); your coordinator iterates the ordered steps.
4. **Report status** — `sdk.status` (a `StatusReporter`) reports per-step and workflow-level
   phase transitions back to WRC. Mirror the same state locally with `sdk.updatePhase()` and
   `sdk.updateStepState()` so the REST `/status` endpoint stays current.

Agentic (broker-backed) work is delegated through `sdk.requireMcpHost()` — the `McpHostClient` is
only constructed when both `CLERUM_MCPHOST_URL` and `MCP_HOST_TOKEN_FILE` are configured.

### Environment variables (read by `ConfigLoader`)

**Required** (missing any throws `WorkflowSDKInitError`):

- `CLERUM_WORKFLOW_NAME`
- `CLERUM_NAMESPACE`
- `CLERUM_WRC_URL`
- `WRC_TOKEN_FILE`

**Optional:**

- `CLERUM_MCPHOST_URL` + `MCP_HOST_TOKEN_FILE` — enable agentic steps (if the URL is set, the
  token file is required).
- `CLERUM_SNIPPET_RUNNER_URL` + `SNIPPET_RUNNER_TOKEN_FILE` — same pairing rule.
- `CLERUM_CORRELATION_ID` (defaults to a random UUID)
- `CLERUM_SIGNAL_POLL_INTERVAL_MS` (default `5000`, floor `500`)
- `CLERUM_SDK_REST_PORT` (default `8090`)
- `CLERUM_REGISTRY_URL`, `CLERUM_STORAGE_ENDPOINT`
- `CLERUM_WORKFLOW_CONFIG_PATH` / `WORKFLOW_CONFIG_PATH` (spec path; default
  `/etc/workflow/config.json`)

## Quickstart

A minimal coordinator that loads the spec, runs each step in dependency order, and reports
status. This mirrors the shape of the canonical end-to-end fixture (with a trivial step executor
stubbed in — replace `runStep` with your own logic).

```ts
// coordinator.ts
import { WorkflowSDK, emitLog, type StepSpec } from '@clerum/workflow-sdk'

async function runStep(step: StepSpec): Promise<unknown> {
  // Your deterministic business logic, or delegate agentic work to
  // sdk.requireMcpHost().executeAgentStep({ ... }).
  return { stepId: step.id, ok: true }
}

async function main(): Promise<void> {
  const sdk = await WorkflowSDK.fromEnvironment()
  const spec = await sdk.config.getSpec()
  const orderedSteps = sdk.coordinator.resolveOrder(spec.steps)

  try {
    sdk.updatePhase('running')
    await sdk.status.reportWorkflowStatus('running')

    for (const step of orderedSteps) {
      const startedMs = Date.now()
      sdk.updateStepState(step.id, { phase: 'running' })
      await sdk.status.reportStepStatus(step.id, 'running', { executor: 'custom' })

      const output = await runStep(step)

      sdk.updateStepState(step.id, { phase: 'completed', output })
      await sdk.status.reportStepStatus(step.id, 'completed', {
        output,
        executor: 'custom',
        durationMs: Date.now() - startedMs,
      })
    }

    sdk.updatePhase('completed')
    await sdk.status.reportWorkflowStatus('completed', {
      completedAt: new Date().toISOString(),
    })
    emitLog('info', 'Coordinator completed', { workflowName: spec.name })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    sdk.updatePhase('failed')
    await sdk.status.reportWorkflowStatus('failed', { failureReason: message })
    emitLog('error', `Coordinator failed: ${message}`)
    process.exitCode = 1
  } finally {
    await sdk.shutdown()
  }
}

void main()
```

### Delegating an agentic step to mcp-host

```ts
// import { renderPrompt } from '@clerum/workflow-sdk'
// (inside the step loop, with `sdk`, `step`, `spec`, `previousOutputs` in scope)
const mcpHost = sdk.requireMcpHost() // throws McpHostNotConfiguredError if not configured

const result = await mcpHost.executeAgentStep({
  stepId: step.id,
  instruction: renderPrompt(step.prompt?.template ?? step.instruction ?? '', {
    step,
    previousOutputs,
    workflowName: spec.name,
  }),
  maxIterations: 8,
  timeoutSeconds: 300,
})

if (result.status === 'failed') {
  throw new Error(result.error ?? 'agent step failed')
}
```

## Public API reference

| Export | Kind | Purpose |
| --- | --- | --- |
| `WorkflowSDK` | class | Top-level façade; `static fromEnvironment()` builds and wires everything. |
| `WorkflowSDK.fromEnvironment()` | static method | `Promise<WorkflowSDK>` — the single init call. |
| `sdk.config` (`ConfigLoader`) | class | Loads config from env; `getConfig()`, `getSpec()`. |
| `sdk.coordinator` (`StepCoordinator`) | class | `resolveOrder()`, `injectSignal()`, `runWorkflow()`. |
| `sdk.status` (`StatusReporter`) | class | `reportStepStatus()`, `reportWorkflowStatus()`, `getWorkflowStatus()`. |
| `sdk.signals` (`SignalPoller`) | class | `pollSignals()`, `pushSignal()`, `hasSignal()`, `consumeSignal()`, `stop()`. |
| `sdk.mcpHost` / `requireMcpHost()` (`McpHostClient`) | class | `executeAgentStep()`, `healthCheck()`. |
| `updatePhase()` / `updateStepState()` / `shutdown()` | methods | Mirror local REST state; graceful teardown. |
| `renderPrompt()` | function | Interpolates `{{...}}` placeholders in a prompt template. |
| `loadSoul()` | function | Reads a `SOUL.md` artifact from `/etc/workflow/souls` (path-traversal guarded). |
| `requestModelInjection()` | function | POSTs a `{stepId, provider, model}` model binding to WRC. |
| `createFileRuntimeTokenProvider()` / `createStaticRuntimeTokenProvider()` / `requireRuntimeToken()` | functions | Build / resolve runtime token providers. |
| `withRetry()` / `computeBackoff()` | functions | Retry helper and exponential backoff (capped at 300s). |
| `emitLog()` / `initLogger()` | functions | Structured JSON logging to stdout. |
| `createServer()` / `start()` / `stop()` / `safeEqual()` | functions | REST server helpers (health/status/signal routes; constant-time compare). |
| `WorkflowSDKInitError` / `CycleDetectedError` / `McpHostNotConfiguredError` | error classes | Init, DAG-cycle, and unconfigured-mcp-host failures. |
| `RegistryClient` and registry types | interfaces/types | Registry connection contract (defined in this package). |
| Config/spec types | types | `WorkflowConfig`, `WorkflowRecipeSpec`, `StepSpec`, `AgentSpec`, `ToolScope`, `PromptSpec`, `WorkflowPhase`, `StepPhase`, `Signal`. |
| mcp-host types | types | `AgentStepRequest`, `AgentStepResult`, `StepMcpServerRef`, `AllowedToolsConfig`. |
| Misc types | types | `StepContext`, `StepExecutor`, `WorkflowStateRef`, `RetryOptions`, `PromptContext`, `SignalCallback`, `RuntimeTokenProvider`. |

## Building a coordinator image

Because `@clerum/workflow-sdk` re-exports from `@clerum/workflow-runtime-core` (linked as
`file:../workflow-runtime-core`), an image that installs or copies **only** the SDK fails at load
time — both compiled packages must be present under `node_modules`, and the dependency link
points to a sibling package one directory up. **The build context must be the repository root**
so both sibling packages resolve.

The multi-stage build below mirrors this package's shipped
[`Dockerfile.base`](./Dockerfile.base). `--ignore-scripts` skips the flaky esbuild/vitest
postinstall lifecycle that the production `dist` does not need; the base-image stage compiles
with TypeScript only via `build:docker`.

```dockerfile
# Build from the REPOSITORY ROOT: docker build -f coordinator.Dockerfile .
FROM node:24-alpine AS sdk-builder
WORKDIR /app

# 1) Build runtime-core (the real implementations)
COPY packages/workflow-runtime-core/package.json packages/workflow-runtime-core/package-lock.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/tsconfig.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/src ./packages/workflow-runtime-core/src
WORKDIR /app/packages/workflow-runtime-core
RUN npm ci --ignore-scripts && npm run build

# 2) Build the SDK
WORKDIR /app
COPY packages/workflow-sdk/package.json packages/workflow-sdk/package-lock.json ./packages/workflow-sdk/
COPY packages/workflow-sdk/tsconfig.json ./packages/workflow-sdk/
COPY packages/workflow-sdk/src ./packages/workflow-sdk/src
WORKDIR /app/packages/workflow-sdk
RUN npm ci --ignore-scripts && npm run build:docker

# 3) Assemble the runtime image with BOTH packages under node_modules
FROM node:24-alpine AS base
WORKDIR /app
COPY --from=sdk-builder /app/packages/workflow-runtime-core/dist/ ./node_modules/@clerum/workflow-runtime-core/dist/
COPY packages/workflow-runtime-core/package.json ./node_modules/@clerum/workflow-runtime-core/package.json
COPY --from=sdk-builder /app/packages/workflow-sdk/dist/ ./node_modules/@clerum/workflow-sdk/dist/
COPY packages/workflow-sdk/package.json ./node_modules/@clerum/workflow-sdk/package.json

# 4) Add your compiled coordinator and run as non-root
COPY dist/ ./dist/
RUN mkdir -p /output /tmp && chown -R 1000:1000 /app /output /tmp
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 8090
CMD ["node", "dist/coordinator.js"]
```

Alternatively, `FROM` the published `clerum-workflow-base` image (both packages already present)
and only `COPY` your own build output.

### Image-digest enforcement (on by default)

WRC requires a **sha256-digest-pinned** `spec.coordinatorImage` by default
(`WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST` defaults to `true`); a tag-only reference is rejected.
Build and ship as if policy is strict:

- Reference images by digest, e.g. `ghcr.io/acme/coordinator@sha256:<64-hex>` — no `:latest`.
- Run as user `1000`; write only to `/tmp` and `/output`.
- Do not bundle provider or Clerum credentials; pin third-party dependencies.

(The `minikube` overlay is the only path that disables enforcement, for local E2E.)

## Full guide

For the complete walkthrough — build/ship details, the snippet-vs-agentic split, capability
gating, and the end-to-end example — see `docs/features/custom-coordinator-*.md` in this
repository.

## License

MPL-2.0
```
