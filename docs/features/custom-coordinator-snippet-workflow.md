# Custom Coordinator Snippet Workflow

This guide explains how to write workflow business logic with TypeScript
snippets in the Clerum-managed custom coordinator runtime.

Custom coordinator snippets are for developers who need code inside a
`WorkflowRecipe` but do not need to own a Docker image. Clerum owns the runtime
image, pod hardening, network policies, token delivery, status reporting, and
artifact download path. The developer owns the snippet logic and declares the
context it is allowed to use.

## Mental Model

Custom coordinator snippets follow one product artifact contract:

```text
WorkflowRecipe run
  -> platform coordinator
  -> workflow-snippet-runner
  -> sdk.*
  -> /output
  -> status.artifacts[]
  -> Desktop App / Control UI download artifacts for that exact run
```

The artifact owner is the `WorkflowRecipe` run. It is not ChatLLM, Desktop RPC,
or a host/chat artifact flow.

## When To Use Snippets

Use snippets when the workflow logic fits inside the curated SDK:

- fetch or submit data to declared public HTTP hosts;
- read or write declared MongoDB/PostgreSQL workloads from the same recipe;
- call declared MCP servers/tools directly without an LLM;
- combine snippet steps with separate agentic steps that use `mcp-host`;
- generate JSON or Markdown artifacts from workflow inputs and step outputs.

Use [Custom Coordinator Images](custom-coordinator-images.md) instead when you
need custom dependencies, a long-lived runtime, language/runtime choices beyond
the curated TypeScript SDK, or image-level business code.

| Need                                                | Choose                     |
| --------------------------------------------------- | -------------------------- |
| Small TypeScript business logic                     | Custom coordinator snippet |
| Platform-owned runtime and SDK controls             | Custom coordinator snippet |
| Custom npm/native dependencies or runtime bootstrap | Custom coordinator image   |
| Full coordinator lifecycle owned by developer image | Custom coordinator image   |

## Minimal Snippet Step

Snippet steps use `run.type: snippet` and `language: typescript`.

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: receivables-summary
  namespace: sandbox-recipes
spec:
  inputContract:
    type: object
    properties:
      minAmount:
        type: number
        default: 1000

  output:
    destination: pvc
    format: json
    storageSize: 128Mi

  workloads:
    - id: postgres
      type: deployment
      image: postgres:16
      port: 5432
      env:
        - name: POSTGRES_DB
          value: clerum
        - name: POSTGRES_USER
          value: clerum
        - name: POSTGRES_PASSWORD
          value: dev-only-password

  steps:
    - id: build-summary
      run:
        type: snippet
        language: typescript
        code: |
          const minAmount = sdk.inputs.minAmount ?? 1000
          const rows = await sdk.postgres.query(
            { workload: "postgres", database: "clerum" },
            {
              sql: "select account, amount from receivables where amount >= $1 order by amount desc limit $2",
              values: [minAmount, 100],
            }
          )

          const artifact = await sdk.artifacts.writeMarkdown(
            "receivables-summary.md",
            `# Receivables Summary\n\nRows: ${rows.length}\n`
          )

          return { rows, artifact }
        capabilities:
          postgres:
            access: read
            workloads: [postgres]
```

How to read this:

- `WorkflowRecipe` CRDs live in `sandbox-recipes`.
- `output.destination: pvc` makes `/output` available for product artifacts on
  the parent recipe output PVC, sized by `output.storageSize` unless an existing
  `output.claimName` is provided.
- The snippet can query only the declared `postgres` workload.
- `capabilities.postgres.access: read` declares read-only intent for this step.
- The returned artifact metadata is surfaced through run-scoped downloads.

## Deployable Recipe Shape

A recipe that a user can trigger from Desktop App or Control UI needs more than
steps. The usual shape is:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: api-db-report
  namespace: sandbox-recipes
spec:
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
      allowedHosts: [api.vendor.example]

  workloads:
    - id: mongo
      type: deployment
      image: mongo:7
      port: 27017
    - id: postgres
      type: deployment
      image: postgres:16
      port: 5432
      env:
        - name: POSTGRES_DB
          value: clerum
        - name: POSTGRES_USER
          value: clerum
        - name: POSTGRES_PASSWORD
          value: dev-only-password

  steps:
    - id: fetch-api-to-mongo
      run:
        type: snippet
        language: typescript
        code: |
          const apiKey = sdk.secrets.get("vendor_api_key")
          const payload = await sdk.http.fetchJson("https://api.vendor.example/report", {
            method: "GET",
            headers: { authorization: `Bearer ${apiKey}` },
          })
          await sdk.mongo.insertOne(
            { workload: "mongo", database: "clerum", collection: "reports" },
            { document: { requestId: sdk.inputs.requestId, payload } }
          )
          return await sdk.artifacts.writeJson("api-to-mongo.json", { requestId: sdk.inputs.requestId })
        capabilities:
          http:
            allowedHosts: [api.vendor.example]
          secrets:
            - alias: vendor_api_key
              secretRef:
                name: vendor-api
                key: apiKey
          mongo:
            access: readWrite
            workloads: [mongo]
```

Add later steps with `dependsOn` to read from MongoDB, write to PostgreSQL, and
emit the final report. Keep the recipe context explicit: public hosts in
`runtimeEgress`, secret references in `run.capabilities.secrets`, DBs in
`workloads`, and per-step capabilities under `run.capabilities`.

For manual testing:

- use YAML with `kubectl apply`;
- use JSON if the Control UI editor expects JSON;
- include `triggers.onDemand` when the workflow must be user-triggerable;
- grant the target user access to the recipe before testing from Desktop App;
- use a unique `requestId` per run when comparing downloaded artifacts;
- Control UI detects `run.capabilities.secrets[].secretRef`, asks for the
  values in password fields, and creates or updates the Kubernetes Secret in
  `sandbox-recipes` before deploying;
- if you apply YAML directly, create the Kubernetes Secret in `sandbox-recipes`
  first;
- never commit real API keys or database passwords to Git.

## SDK Surface

The snippet receives one argument: `sdk`.

| API                                     | Purpose                                            |
| --------------------------------------- | -------------------------------------------------- |
| `sdk.inputs`                            | Workflow inputs resolved from the `inputContract`. |
| `sdk.previousOutputs`                   | Outputs from dependency steps.                     |
| `sdk.http.fetchJson/fetchText`          | Public HTTP to declared hosts.                     |
| `sdk.secrets.get(alias)`                | Declared recipe Secret values by alias.            |
| `sdk.mongo.*`                           | MongoDB helpers scoped to declared workloads.      |
| `sdk.postgres.*`                        | PostgreSQL helpers scoped to declared workloads.   |
| `sdk.mcp.callTool`                      | Manual MCP tool calls to declared servers/tools.   |
| `sdk.artifacts.writeJson/writeMarkdown` | Writes files under `/output` and returns metadata. |
| `sdk.log.info/warn/error`               | Structured logs with secret redaction.             |

The runtime does not expose raw `fetch`, `axios`, `process.env`,
`require/import`, direct filesystem access, sockets, Kubernetes API access, or
arbitrary connection strings.

`sdk.previousOutputs` is not a CRD field. It is runtime state built from
completed dependency steps and keyed by `step.id`. Declare dependencies with
`dependsOn` when a step needs another step's output.

## Output Previews And Artifacts

`status.steps[].output` is a bounded status preview. It is useful for compact
summaries, artifact metadata, and operator diagnostics, but it is not the source
of truth for complete reports. Large reports must be written through
`sdk.artifacts.*` so they land under `/output` and are exposed through
run-scoped artifact downloads.

Prompt interpolation with `{{step-id:output}}` is also bounded. When previous
step output is too large, the SDK sends only a marked preview to the model. Do
not depend on prompt interpolation to move a full Markdown/PDF/DOCX/Excel report
between steps; pass compact structured data in step output and write the full
file as an artifact.

## Declared Context Controls Access

The snippet runtime is not meant to guess whether a business operation is good
or bad. It controls whether the snippet can reach the services the recipe author
declared.

That means:

- if a DB workload is declared and the step asks for `access: readWrite`, the
  snippet may write to that DB through the SDK;
- if an MCP server/tool is declared, the snippet may call that tool;
- if a public HTTP host is declared, the snippet may call that host with the
  allowed HTTP methods;
- if a workload, host, secret, or tool is not declared, the recipe fails early
  or the SDK call fails closed.

This keeps the platform secure without making the SDK too restrictive for real
business workflows.

## Public HTTP

Declare public HTTP intent twice:

1. At workflow level, in `spec.runtimeEgress.http.allowedHosts`.
2. At step level, in `run.capabilities.http.allowedHosts`.

```yaml
spec:
  runtimeEgress:
    http:
      allowedHosts:
        - api.vendor.example

  steps:
    - id: fetch-vendor-data
      run:
        type: snippet
        language: typescript
        code: |
          return await sdk.http.fetchJson("https://api.vendor.example/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "open" }),
          })
        capabilities:
          http:
            allowedHosts:
              - api.vendor.example
```

Rules:

- supported methods are `GET`, `HEAD`, `POST`, and `PUT`;
- public hosts must use HTTPS;
- IP literals, cluster-local names, `.svc`, `.internal`, and metadata hosts are
  rejected;
- redirects to undeclared hosts are rejected;
- response size and timeouts are bounded.

WRC resolves the workflow-level hosts to public IPv4 `/32` CIDRs and opens TCP
`80/443` egress for snippet runner pods only to that resolved CIDR set.
Resolution fails closed for unresolved, private, metadata, link-local,
cluster-local, documentation, benchmarking, multicast, or reserved addresses.
While a workflow run is active, WRC periodically re-resolves those hosts and
patches the NetworkPolicy. If the CIDR set changes, WRC keeps the previous CIDRs
for `WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS` seconds (default `300`) so DNS
rotation does not cut over in-flight runs abruptly. Kubernetes NetworkPolicy
still cannot enforce HTTP hostnames at L7, so a shared egress proxy remains the
hardening path for redirect/TLS/method/rate-limit policy on custom images.

## Secrets

Secrets are declared as Kubernetes `secretRef` values and mapped into a snippet
alias. The WorkflowRecipe carries the reference only.

```yaml
steps:
  - id: call-vendor
    run:
      type: snippet
      language: typescript
      code: |
        const token = sdk.secrets.get("vendor_token")
        return await sdk.http.fetchJson("https://api.vendor.example/report", {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        })
      capabilities:
        http:
          allowedHosts: [api.vendor.example]
        secrets:
          - alias: vendor_token
            secretRef:
              name: vendor-api
              key: token
```

Control UI captures the missing `vendor-api/token` value outside the JSON
editor and writes the Kubernetes Secret to `sandbox-recipes` before the final
server-side validation. Direct `kubectl apply` users must create the Secret
first, for example:

```bash
kubectl --context=clerum-test -n sandbox-recipes create secret generic vendor-api \
  --from-literal=token="$VENDOR_TOKEN"
```

Platform runtime tokens and provider API keys are not exposed as snippet
secrets.

## MongoDB And PostgreSQL

Database helpers can only connect to workloads declared by the same
`WorkflowRecipe`. They do not accept arbitrary connection strings or host/port
overrides.

Read-only MongoDB:

```yaml
run:
  type: snippet
  language: typescript
  code: |
    return await sdk.mongo.find(
      { workload: "mongo", database: "clerum", collection: "receivables" },
      { filter: { status: "open" }, limit: 100 }
    )
  capabilities:
    mongo:
      access: read
      workloads: [mongo]
```

Read-write PostgreSQL:

```yaml
run:
  type: snippet
  language: typescript
  code: |
    const ref = { workload: "postgres", database: "clerum" }
    await sdk.postgres.execute(ref, {
      sql: "insert into receivables(account, amount) values ($1, $2)",
      values: ["dao-alpha", 1880],
    })
    return await sdk.postgres.query(ref, {
      sql: "select account, amount from receivables where account = $1",
      values: ["dao-alpha"],
    })
  capabilities:
    postgres:
      access: readWrite
      workloads: [postgres]
```

Use `access: read` when the step should only read. Use `access: readWrite` when
the step needs inserts, updates, deletes, DDL, or MongoDB write pipelines such
as `$out` or `$merge`.

## Manual MCP Calls

A snippet can call a declared MCP server/tool directly through the SDK. This is
not an LLM flow and does not require a child `mcp-host`.

```yaml
workloads:
  - id: mongo-tools
    type: deployment
    image: ghcr.io/acme/mongo-tools-mcp:v1.0.0
    port: 3000
    transport:
      type: streamableHttp
      path: /mcp

steps:
  - id: load-risk-data
    run:
      type: snippet
      language: typescript
      code: |
        return await sdk.mcp.callTool("mongo-tools", "upsert_receivable", {
          account: "dao-alpha",
          amount: 1880,
        })
      capabilities:
        mcp:
          servers: [mongo-tools]
          allowedTools:
            include:
              - mongo-tools__upsert_receivable
```

Tool allowlists must be explicit. Wildcards are rejected.

For hybrid workflows, use snippet steps for deterministic logic and separate
`instruction`/`agent` steps for agentic work. Those agentic steps create the
WRC-managed child `mcp-host`; snippet steps themselves do not call
`/configure-model` or `/trigger`.

## Artifacts

Use artifact helpers instead of writing arbitrary files and guessing metadata.

```ts
const json = await sdk.artifacts.writeJson("risk-result.json", {
  requestId: sdk.inputs.requestId,
  status: "ready",
})

const summary = await sdk.artifacts.writeMarkdown(
  "risk-summary.md",
  "# Risk Summary\n\nStatus: ready\n"
)

return { artifacts: [json, summary] }
```

Rules:

- artifact names are filenames only;
- files must stay under `/output`;
- generated metadata becomes `status.artifacts[]`;
- returning `{ artifacts: [...] }` keeps the step output readable, but artifacts
  written through `sdk.artifacts.*` are still tracked by the runtime;
- Desktop App and Control UI download by parent recipe plus exact `runId`;
- the UI may prefix local downloaded filenames with the run id to avoid
  overwriting artifacts from two runs that use the same artifact names;
- do not use host/chat artifact APIs for workflow outputs.

## Early Failure Model

Snippet workflows fail early where possible:

| Checkpoint     | Example failures                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Kubernetes CEL | invalid snippet shape, duplicate steps, wildcard MCP tools, HTTP host not declared in `runtimeEgress`      |
| WRC preflight  | undeclared DB workload, missing `secretRef` Secret/key, undeclared MCP server/tool                         |
| SDK runtime    | unsupported HTTP method, unsafe redirect, DB write attempted with `access: read`, unsafe artifact filename |

Bad recipes should fail before useful runtime resources are created. Runtime
errors are reserved for values only known when code executes.

## Operational Notes

- Feature flag: `WRC_ENABLE_SNIPPET_RUNTIME`.
- Runtime image: `clerum/workflow-snippet-runner`.
- Step count: `WRC_MAX_WORKFLOW_STEPS`, default `100`; CRD schema also uses a
  static `100` ceiling.
- The runner runs non-root, has no service account token, uses a read-only root
  filesystem, drops Linux capabilities, and receives only declared snippet
  secret aliases.
- NetworkPolicies are generated from declared snippet capabilities.

## Validation Checklist

Before publishing a snippet workflow:

- Apply the `WorkflowRecipe` in `sandbox-recipes`.
- Confirm CEL accepts the declared capabilities.
- Confirm WRC reaches an active parent recipe state.
- Trigger from Desktop App or Control UI as an authorized user.
- Confirm the run creates the expected child workflow.
- Confirm pure snippet workflows do not create a child `mcp-host`.
- Confirm hybrid workflows create `mcp-host` only for agentic steps.
- Confirm declared DB/MCP/HTTP access works.
- Confirm undeclared hosts/workloads/tools fail closed.
- Confirm `status.artifacts[]` includes expected artifacts.
- Confirm Desktop App and Control UI download artifacts for the exact `runId`.
