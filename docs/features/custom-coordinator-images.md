# Custom Coordinator Images

This guide explains how to build a custom coordinator image for a
`WorkflowRecipe`.

A custom coordinator image is useful when a workflow needs real business logic:
domain calculations, deterministic transformations, file generation, or a
controlled call to MCP tools. The platform still owns scheduling, security,
status, artifacts, and downloads. Your image owns the workflow logic.

If the workflow can fit inside the Clerum-managed TypeScript SDK runtime, start
with [Custom Coordinator Snippet Workflow](./custom-coordinator-snippet-workflow.md).
Use a custom coordinator image when you need a full developer-owned container,
custom dependencies, or image-level runtime behavior.

## The Mental Model

Custom coordinator images follow one product contract:

```text
WorkflowRecipe run
  -> custom coordinator image
  -> writes files to /output
  -> reports artifacts in step output
  -> Desktop App / Control UI download artifacts for that exact run
```

The artifact owner is the `WorkflowRecipe` run. It is not ChatLLM, Desktop RPC,
or a host/chat artifact flow.

## Snippet Runtime Or Custom Image

Both options produce the same product outcome: run-scoped workflow artifacts
downloadable from Desktop App and Control UI. The difference is the runtime
boundary.

| Need                                                         | Use                        |
| ------------------------------------------------------------ | -------------------------- |
| Small TypeScript business logic with curated SDK calls       | Custom coordinator snippet |
| Platform-owned runtime and stricter SDK surface              | Custom coordinator snippet |
| Custom npm/native dependencies or non-standard runtime setup | Custom coordinator image   |
| Full coordinator lifecycle implemented in your own image     | Custom coordinator image   |

Choose the snippet runtime first when it is enough. Choose a custom image when
the code needs to own more than a snippet step can safely expose.

## What You Build

A custom coordinator image is a container that:

1. Starts the Clerum workflow SDK.
2. Reads the mounted workflow config.
3. Executes the recipe steps in dependency order.
4. Runs your business logic for each step.
5. Writes downloadable files under `/output`.
6. Reports step and workflow status back to WRC.
7. Optionally calls the WRC-managed `mcp-host` when the recipe declares MCP
   tools for a step.

You do not build a Kubernetes operator, artifact server, token issuer, or
download API. Clerum provides those.

## SDK Base Image

The published `clerum-workflow-base` image is a convenience base for custom
coordinator images. It contains Node.js plus the compiled `@clerum/workflow-sdk`
package under `node_modules/@clerum/workflow-sdk`.

Use it when your coordinator is a Node/TypeScript runtime:

```dockerfile
FROM your-registry.example.com/evenfire/clerum-workflow-base:1.0.0
COPY dist/ ./dist/
CMD ["node", "dist/coordinator.js"]
```

The base-image build compiles the SDK with TypeScript only. It intentionally
does not run test dependency lifecycle scripts inside the Docker builder stage,
because those scripts are not needed for the production SDK files copied into
the final image and can make CI Docker builds flaky. SDK tests still run in the
normal package test jobs before the image build.

## Platform Status

Custom coordinator images are disabled by default:

```text
WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=false
```

An operator must explicitly enable the feature and configure the allowed image
prefixes before WRC accepts `spec.coordinatorImage`.

## Minimal Recipe

Create the parent `WorkflowRecipe` in `sandbox-recipes` and set
`spec.coordinatorImage`.

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: receivables-risk-review
  namespace: sandbox-recipes
spec:
  coordinatorImage: ghcr.io/acme/receivables-coordinator:v1.2.3

  inputContract:
    type: object
    properties:
      requestId:
        type: string
      approvalThreshold:
        type: number
        default: 1000

  output:
    destination: pvc
    format: json
    storageSize: 128Mi

  steps:
    - id: prepare
    - id: score-risk
      dependsOn: [prepare]
    - id: emit
      dependsOn: [score-risk]
```

How to read this:

- `metadata.namespace` is always `sandbox-recipes` for `WorkflowRecipe` CRDs.
- `coordinatorImage` is your image. WRC uses it instead of the built-in
  coordinator.
- `inputContract` is the product input shape shown to users and passed into the
  mounted runtime config.
- `output.destination: pvc` tells Clerum to mount `/output` from a dedicated
  workflow output PVC and make workflow artifacts downloadable.
- With a custom coordinator, steps can be id-only. The CRD declares the workflow
  shape; your image decides what each step does.
- WRC limits workflow step count with `WRC_MAX_WORKFLOW_STEPS`, default `100`.
  The CRD also has a static `100` ceiling for `spec.steps` and step dependencies
  because Kubernetes admission schemas cannot read WRC runtime environment
  variables.

## Deployable Recipe Shape

A recipe that should be launched by a user needs an on-demand trigger and user
grant, even when the custom image is fully deterministic:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: custom-risk-review
  namespace: sandbox-recipes
spec:
  coordinatorImage: ghcr.io/acme/risk-coordinator:v1.2.3

  triggers:
    onDemand:
      requiresApproval: false
      allowedActors: ['user']

  inputContract:
    type: object
    properties:
      requestId:
        type: string
      customer:
        type: string

  output:
    destination: pvc
    format: multi
    storageSize: 128Mi

  runtimeEgress:
    http:
      allowedHosts:
        - api.vendor.example

  steps:
    - id: fetch-inputs
    - id: score-risk
      dependsOn: [fetch-inputs]
    - id: emit-artifacts
      dependsOn: [score-risk]
```

Use this as the deterministic baseline: no child `mcp-host` is required, and
your image performs the step logic from the mounted config plus declared
context. If the workflow needs MCP broker behavior, add declared transport
workloads, `mcpServers`, `allowedTools`, and `agent` metadata to the step that
needs the broker. WRC then creates the child `mcp-host` and provides the scoped
`MCP_HOST_TOKEN_FILE` only for that broker-backed path.

For manual testing:

- use YAML with `kubectl apply`;
- use JSON if the Control UI editor expects JSON;
- include `triggers.onDemand` when the workflow must be user-triggerable;
- grant the target user access to the recipe before testing from Desktop App;
- use a unique `requestId` per run when comparing downloaded artifacts;
- do not bake API keys, provider keys, or Clerum runtime credentials into the
  image or CRD; use the platform's approved secret provisioning path;
- verify deterministic recipes do not create a child `mcp-host`;
- verify broker-backed recipes create a child `mcp-host` and only use declared
  `mcpServers` and `allowedTools`.

## Validation Model

Custom coordinator recipes use the same early-validation split as the rest of
WorkflowRecipe:

| Checkpoint        | Fails                                                   | Examples                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes CEL    | Invalid CRD shape or invalid public egress intent       | duplicate step ids, non-public `runtimeEgress.http.allowedHosts`, malformed cron, invalid run/instruction combinations                                                                        |
| WRC before pods   | Policy and semantic checks that need controller context | feature flag disabled, image prefix or digest policy failure, unsupported Linux capability, unknown step dependency, broker-backed step without agent config, undeclared workload/MCP binding |
| Runtime SDK/image | Behavior only the running image can perform             | business logic, actual artifact content, custom HTTP client behavior inside the image                                                                                                         |

WRC should reject policy or semantic violations before creating the custom
coordinator pod. Runtime failures are reserved for work that only the image can
perform after the declared context has already been accepted.

## Public HTTP Egress

Custom coordinator pods do not get public ingress. They can call WRC and other
declared workflow runtime services through explicit NetworkPolicies.

The model is capability control through declared workflow context. If the
`WorkflowRecipe` declares a non-transport workload, the custom coordinator may
perform the business operation it needs against that declared dependency. WRC
generates egress from the coordinator and ingress to that workload by recipe
label and port. Transport workloads and MCP tools still go through the
WRC-managed `mcp-host` path so `allowedTools` and scoped broker tokens remain
in force. The platform limits which destinations and tokens exist; it does not
try to infer each operation's business intent.

If the image needs direct public HTTP calls, declare the intent on the recipe:

```yaml
spec:
  coordinatorImage: ghcr.io/acme/receivables-coordinator:v1.2.3
  runtimeEgress:
    http:
      allowedHosts:
        - api.vendor.example
```

The current implementation follows the existing WRC runtime egress pattern. WRC
resolves the declared hostnames to public IPv4 `/32` CIDRs and opens TCP `80/443`
egress for the custom `workflow-coordinator` only to that resolved CIDR set.
Resolution fails closed when a host does not resolve or resolves to private,
metadata, link-local, cluster-local, documentation, benchmarking, multicast, or
reserved ranges. While a workflow run is active, WRC periodically re-resolves
those hosts and patches the NetworkPolicy. If the CIDR set changes, WRC keeps
the previous CIDRs for `WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS` seconds
(default `300`) so DNS rotation does not cut over in-flight runs abruptly. Treat
this as a bounded trust window as well as an availability setting: the previous
public CIDRs remain allowed until the overlap expires.
Kubernetes NetworkPolicy still cannot enforce HTTP hostnames at L7; a shared
egress proxy remains the hardening path for redirect/TLS/method/rate-limit
policy on custom images.

## Image Policy

WRC accepts a custom image only when all policy checks pass:

| Check         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| Feature flag  | `WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE=true` must be set by the operator. |
| Allowlist     | The image must match `WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES`.          |
| No `:latest`  | Mutable `latest` tags are rejected.                                     |
| Digest policy | If enabled, the image must include a valid `sha256` digest.             |

This is a platform control. Your image does not enforce it, but release images
should be built as if the policy will be strict.

## Runtime Environment

WRC starts your container with a small set of environment variables and mounted
files:

| Name                         | What it is for                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `CLERUM_WORKFLOW_NAME`       | Child run recipe name. Use it for WRC calls.                       |
| `CLERUM_NAMESPACE`           | Runtime namespace, normally `sandbox-recipes`.                     |
| `CLERUM_WRC_URL`             | In-cluster WRC REST base URL.                                      |
| `WRC_TOKEN_FILE`             | File containing the current Clerum runtime JWT for WRC routes.     |
| `WORKFLOW_CONFIG_PATH`       | Mounted workflow config, normally `/etc/workflow/config.json`.     |
| `SOUL_MD_PATH`               | Mounted `SOUL.md` path, when present.                              |
| `CLERUM_WORKFLOW_OUTPUT_DIR` | Output directory, normally `/output`.                              |
| `CLERUM_MCPHOST_URL`         | Present only when a step requires broker-backed MCP work.          |
| `MCP_HOST_TOKEN_FILE`        | File containing the current child `mcp-host` token, when required. |

`WRC_TOKEN_FILE` and `MCP_HOST_TOKEN_FILE` point to Kubernetes Secret volume
files. WRC rotates those files while the pod runs, so coordinators should use
the SDK token provider instead of reading a startup token once and caching it
forever. These are Clerum runtime tokens, not OpenAI, Anthropic, Z.ai, Bailian,
or other provider API keys. Provider secrets are held by platform services and
are not exposed to custom coordinator code.

## Token Handling

Your code can access its own runtime tokens through the SDK because they are
delivered as Kubernetes Secret-backed files. That is expected. The security rule
is narrower:

- Use the token from `WRC_TOKEN_FILE` only to call the allowed WRC SDK/API
  routes.
- Use the token from `MCP_HOST_TOKEN_FILE` only through the SDK `mcp-host`
  client.
- Do not log either token.
- Do not write either token into `/output`.
- Do not pass either token to MCP tools, model prompts, external services, or
  generated artifacts.

If a token appears in an artifact, that artifact is a leak created by the custom
image.

## Pod Constraints

The platform runs custom coordinators with a hardened pod profile:

| Constraint                                       | Impact on your image                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| Non-root user/group `1000`                       | Files your image writes must be writable by user `1000`.                    |
| Read-only root filesystem                        | Do not write into `/app`, `/usr`, or other image paths.                     |
| Writable `/tmp`                                  | Put temporary files in `/tmp`.                                              |
| Writable `/output`                               | Put product artifacts in `/output`.                                         |
| No privilege escalation and dropped capabilities | Do not rely on privileged Linux operations.                                 |
| No service account token dependency              | Do not design the image around Kubernetes API access.                       |
| `restartPolicy: Never`                           | The image should fail clearly and report failure before exit when possible. |

These are platform controls. You do not need to implement them in your code, but
your image must be compatible with them.

## SDK Lifecycle

Use `@clerum/workflow-sdk`. A coordinator usually follows this lifecycle:

```js
const { WorkflowSDK, emitLog } = require('@clerum/workflow-sdk')

async function main() {
  const sdk = await WorkflowSDK.fromEnvironment()
  const spec = await sdk.config.getSpec()
  const steps = sdk.coordinator.resolveOrder(spec.steps)
  const outputs = {}

  try {
    sdk.updatePhase('running')
    await sdk.status.reportWorkflowStatus('running')

    for (const step of steps) {
      await sdk.status.reportStepStatus(step.id, 'running', {
        executor: 'custom',
        startedAt: new Date().toISOString(),
      })

      const output = await runBusinessStep(step, spec, outputs, sdk)
      outputs[step.id] = output

      await sdk.status.reportStepStatus(step.id, 'completed', {
        executor: 'custom',
        output,
        completedAt: new Date().toISOString(),
      })
    }

    await sdk.status.reportWorkflowStatus('completed', {
      completedAt: new Date().toISOString(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await sdk.status.reportWorkflowStatus('failed', { failureReason: message })
    emitLog('error', `Custom coordinator failed: ${message}`)
    process.exitCode = 1
  } finally {
    await sdk.shutdown()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

`runBusinessStep` is your code. It can calculate, transform, call internal
business libraries, create files, or call `mcp-host` when the recipe declares a
broker-backed step.

## Writing Artifacts

To create a downloadable workflow artifact:

1. Write the file under `/output`.
2. Return artifact metadata from the step output.

Single artifact:

```js
return {
  artifact: {
    name: 'receivables-risk-result.json',
    format: 'json',
    path: '/output/receivables-risk-result.json',
    sizeBytes: 989,
    createdAt: new Date().toISOString(),
  },
}
```

Multiple artifacts:

```js
return {
  artifacts: [
    {
      name: 'receivables-risk-result.json',
      format: 'json',
      path: '/output/receivables-risk-result.json',
      sizeBytes: 989,
      createdAt: new Date().toISOString(),
    },
    {
      name: 'risk-summary.md',
      format: 'md',
      path: '/output/risk-summary.md',
      sizeBytes: 431,
      createdAt: new Date().toISOString(),
    },
  ],
}
```

Artifact rules enforced by WRC:

| Rule                                            | Why it matters                                   |
| ----------------------------------------------- | ------------------------------------------------ |
| `name` must be a filename only                  | Prevents path traversal and ambiguous downloads. |
| `path` must be under `/output/`                 | Keeps downloads bound to workflow output only.   |
| `sizeBytes` must be a safe non-negative integer | Prevents invalid metadata.                       |
| Metadata has length limits                      | Prevents oversized status payloads.              |
| At most 20 artifacts per step update            | Keeps status updates bounded.                    |

Desktop App and Control UI download workflow artifacts by parent recipe plus
`runId`. Do not use `window.clerum.rpc.downloadArtifact` for workflow outputs;
that API is for host/chat artifacts.

Downloaded filenames may be prefixed by the run id in the UI. The artifact name
in `status.artifacts[]` remains the logical workflow artifact name, while the
local filename prefix prevents accidental overwrites when two runs emit
`risk-summary.md` or `custom-sdk-result.json`.

## Status Output Is A Preview

`status.steps[].output` is intentionally bounded. WRC stores it as an operator
preview with truncation metadata, not as a complete report body. If your custom
coordinator creates a full Markdown, PDF, DOCX, XLSX, HTML, JSON, or image
artifact, write it under `/output` and report artifact metadata as shown above.

`{{step-id:output}}` prompt interpolation in the SDK follows the same principle:
it sends a bounded, marked preview of a dependency step's output. Use it for
compact summaries or structured handoff data. Do not use it as the transport for
complete reports; those belong in `/output` artifacts.

## Deterministic Workflows

A deterministic custom coordinator does not need an LLM or `mcp-host`.

Use this style when the workflow can run from inputs plus code:

- scoring;
- classification with fixed rules;
- report generation from provided inputs;
- normalization or validation;
- deterministic file generation.

For deterministic workflows:

- the CRD can have id-only steps;
- no child `mcp-host` should be created;
- artifacts still come from `/output` and `status.artifacts[]`;
- Desktop App and Control UI should still download by the exact `runId`.

## Broker-Backed MCP Workflows

A broker-backed custom coordinator uses a WRC-managed child `mcp-host` for steps
that declare agent/tool requirements.

Example:

```yaml
spec:
  coordinatorImage: ghcr.io/acme/receivables-coordinator:v1.2.3

  workloads:
    - id: receivables-tools
      type: deployment
      image: ghcr.io/acme/receivables-mcp:v1.2.3
      port: 3000
      transport:
        type: streamableHttp
        path: /mcp
      healthCheck:
        type: tcp
        port: 3001

  steps:
    - id: prepare
    - id: broker-review
      dependsOn: [prepare]
      instruction: |
        Use receivables-tools to fetch the customer risk snapshot.
        Return normalized JSON.
      agent:
        provider: zai
        model: glm-4.7
      mcpServers:
        - receivables-tools
      allowedTools:
        include:
          - receivables-tools__risk_snapshot
      maxIterations: 6
    - id: emit
      dependsOn: [broker-review]
```

How this works:

- WRC sees that `broker-review` requires broker-backed execution.
- WRC creates the child `mcp-host`.
- Your container receives `CLERUM_MCPHOST_URL` and `MCP_HOST_TOKEN_FILE`.
- Your code requests model injection through WRC for the declared provider/model.
- Your code calls `mcp-host` through the SDK.
- `mcp-host` enforces declared servers and allowed tools.
- MCP SDK tool requests are bounded by the recipe-local `mcp-host` timeout
  configuration and by the workflow/custom-coordinator step budget. A streamed
  `mcp-host` response must produce a result before the SDK step timeout expires.
- Your code writes final artifacts under `/output`.

SDK sketch:

```js
const { requestModelInjection, renderPrompt } = require('@clerum/workflow-sdk')

async function runBrokerStep(step, spec, outputs, sdk) {
  const mcpHost = sdk.requireMcpHost()
  const cfg = sdk.config.getConfig()

  await requestModelInjection(cfg.wrcUrl, spec.name, cfg.tokenProvider, {
    stepId: step.id,
    provider: step.agent.provider,
    model: step.agent.model,
  })

  const result = await mcpHost.executeAgentStep({
    stepId: step.id,
    instruction: renderPrompt(step.instruction, {
      step,
      previousOutputs: outputs,
      workflowName: spec.name,
    }),
    mcpServers: step.mcpServers ?? [],
    allowedTools: step.allowedTools ?? {},
    maxIterations: step.maxIterations,
    timeoutSeconds: step.timeoutSeconds,
  })

  if (result.status === 'failed') {
    throw new Error(result.error || `mcp-host failed step ${step.id}`)
  }

  return result
}
```

## Platform-Enforced Boundaries

The platform already blocks several unsafe or out-of-contract behaviors. They
are documented here so image authors know what not to depend on.

| Boundary                  | What happens                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `/configure-model`        | Custom coordinator tokens cannot use this privileged route. Use WRC model injection instead.       |
| `/trigger`                | Custom coordinator tokens cannot trigger workflows. They can only operate on the current run.      |
| Undeclared model/provider | WRC rejects model injection that is not declared by the step/recipe.                               |
| Undeclared MCP tools      | `mcp-host` enforces the declared `mcpServers` and `allowedTools`.                                  |
| Artifact path traversal   | WRC rejects unsafe artifact names and paths.                                                       |
| Kubernetes API dependency | Custom pods are not meant to use service account tokens, `pods/exec`, or broad cluster API access. |

These controls protect the platform. They do not replace developer hygiene:
your code must still avoid logging tokens, writing secrets into artifacts, or
sending runtime tokens to tools or external systems.

## Image Build Checklist

Recommended Dockerfile shape:

```Dockerfile
FROM node:24-alpine AS sdk-builder
WORKDIR /app/packages/workflow-sdk
COPY packages/workflow-sdk/package.json packages/workflow-sdk/package-lock.json ./
COPY packages/workflow-sdk/tsconfig.json ./
COPY packages/workflow-sdk/src ./src
RUN npm ci && npm run build

FROM node:24-alpine
WORKDIR /app
COPY packages/workflow-sdk/package.json ./node_modules/@clerum/workflow-sdk/package.json
COPY --from=sdk-builder /app/packages/workflow-sdk/dist ./node_modules/@clerum/workflow-sdk/dist
COPY coordinator.js ./coordinator.js
RUN mkdir -p /output /tmp && chown -R 1000:1000 /app /output /tmp
USER 1000:1000
EXPOSE 8090
CMD ["node", "coordinator.js"]
```

Before release:

- Run as user `1000`, not root.
- Write only to `/tmp` and `/output`.
- Do not bundle provider API keys or static Clerum credentials.
- Pin third-party dependencies.
- Prefer digest-pinned image references in production-like environments.
- Keep business logic testable outside Kubernetes.

## Validation Checklist

Before asking an operator to allow your image:

- Unit-test the business logic without Kubernetes.
- Build the image and run it as non-root.
- Apply a `WorkflowRecipe` in `sandbox-recipes`.
- Verify WRC accepts `spec.coordinatorImage`.
- Verify the child run reaches `Succeeded`.
- Verify the coordinator pod uses your image.
- For deterministic workflows, verify no child `mcp-host` pod is created.
- For broker-backed workflows, verify the child `mcp-host` is created and the
  custom coordinator uses the declared MCP server/tool.
- Verify `status.artifacts[]` contains the expected artifact metadata.
- Verify Desktop App downloads the artifact for the exact run.
- Verify Control UI downloads the same artifact for the exact run.
- Verify two consecutive runs do not cross-download each other's artifacts.
