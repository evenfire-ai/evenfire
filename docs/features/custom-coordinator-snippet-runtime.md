# Custom Coordinator Snippet Runtime

Custom coordinator snippets run small TypeScript snippets inside a
Clerum-managed runtime image. They are meant for workflow business logic that
needs code but does not need a developer-owned Docker image.

For a developer-facing guide with copyable recipe patterns, see
[Custom Coordinator Snippet Workflow](./custom-coordinator-snippet-workflow.md).
This page is the compact runtime reference for validation, SDK scope, and
operational behavior.

Use snippets when the workflow can be expressed as:

```text
WorkflowRecipe -> platform coordinator -> workflow-snippet-runner -> sdk.* -> /output artifacts
```

Use a custom coordinator image instead when the developer needs custom
dependencies or a runtime that cannot fit the curated SDK.

## Runtime Contract

Snippet steps use `run.type: snippet`:

```yaml
steps:
  - id: summarize-receivables
    run:
      type: snippet
      language: typescript
      code: |
        const rows = await sdk.postgres.query(
          { workload: "postgres", database: "clerum" },
          { sql: "select customer, amount from receivables where status = $1 limit $2", values: ["open", 100] }
        )

        const artifact = await sdk.artifacts.writeMarkdown(
          "receivables-summary.md",
          `# Open Receivables\n\nRows: ${rows.length}\n`
        )

        return { rows, artifact }
      capabilities:
        postgres:
          access: read
          workloads: [postgres]
```

Every capability must be declared. The runner resolves capabilities from the
mounted WorkflowRecipe config, not from the coordinator request, so a caller
cannot widen code, endpoints, workloads, or tools at execution time.

Workflow step count is an operator setting: WRC reads
`WRC_MAX_WORKFLOW_STEPS` and defaults it to `100`. The CRD keeps the same
`100` ceiling for `spec.steps` and step dependencies because Kubernetes schemas
cannot read runtime environment variables.

## Validation Model

The snippet runtime intentionally fails as early as the check can be made without
duplicating runtime logic:

| Checkpoint      | Fails                                                      | Examples                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kubernetes CEL  | Invalid CRD shape or explicit intent mismatch              | duplicate step ids, `run + instruction`, `run + agent`, DB capability missing `access`, wildcard MCP tools, non-public `runtimeEgress.http.allowedHosts`, snippet HTTP hosts not declared in `spec.runtimeEgress.http.allowedHosts`, MCP servers without `allowedTools.include` |
| WRC before pods | Semantic recipe references that require controller context | unknown `dependsOn`, snippet `secretRef` Secret not owned by or shared with the recipe, snippet `secretRef` Secret/key missing from `sandbox-recipes`, Mongo/Postgres workload not declared in `spec.workloads`, MCP server/tool not declared or scoped                       |
| SDK runtime     | Values only known while code runs                          | actual URL host, HTTPS requirement, HTTP method, redirect target, response size, DB write attempted with `access: read`, unsafe artifact filename                                                                                                                               |

This keeps admission useful for developer feedback without making the CRD
expensive. WRC semantic failures happen before coordinator or runner pods are
created, so a bad recipe does not wait until the end of a workflow run to fail.

## Available SDK

The snippet receives one argument: `sdk`.

- `sdk.inputs`: resolved workflow inputs.
- `sdk.previousOutputs`: outputs from dependency steps.
- `sdk.http.fetchJson(url, init?)` and `sdk.http.fetchText(url, init?)`:
  public HTTP helpers for explicitly declared hosts. Supported methods are
  `GET`, `HEAD`, `POST`, and `PUT`.
- `sdk.secrets.get(alias)`: reads declared recipe Secret values by alias.
- `sdk.mongo.find/aggregate/insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany`:
  MongoDB helpers scoped to declared recipe workloads.
- `sdk.postgres.execute/query/queryOne`: PostgreSQL helpers scoped to declared recipe workloads.
- `sdk.mcp.callTool(serverId, toolName, args)`: manual MCP tool calls through the MCP TypeScript SDK, scoped to declared servers and tools.
- `sdk.artifacts.writeJson(name, data)` and `sdk.artifacts.writeMarkdown(name, body)`: writes product artifacts under `/output`.
- `sdk.log.info/warn/error(message, meta)`: structured snippet logs with secret redaction.

The runtime does not expose raw `fetch`, `axios`, `process.env`, `require`,
dynamic `import`, direct filesystem access, sockets, Kubernetes API access, or
arbitrary connection strings.

`sdk.previousOutputs` is runtime state, not CRD syntax. A step sees outputs from
completed dependency steps keyed by `step.id`; the CRD only declares the
dependency with `dependsOn`.

## Capability Rules

HTTP:

```yaml
runtimeEgress:
  http:
    allowedHosts: [api.example.com]

steps:
  - id: call-api
    run:
      type: snippet
      language: typescript
      code: |
        return await sdk.http.fetchJson("https://api.example.com/report")
      capabilities:
        http:
          allowedHosts: [api.example.com]
```

`spec.runtimeEgress.http.allowedHosts` is the workflow-level public egress
contract shared with custom coordinator images. A snippet step may then declare
the subset it uses through `run.capabilities.http.allowedHosts`; Kubernetes
admission rejects the recipe if the step asks for a host outside the
workflow-level list. WRC resolves the workflow-level hosts to public IPv4 `/32`
CIDRs and opens TCP `80/443` egress for snippet runner pods only to that
resolved CIDR set. Resolution fails closed for unresolved, private, metadata,
link-local, cluster-local, documentation, benchmarking, multicast, or reserved
addresses. While a workflow run is active, WRC periodically re-resolves those
hosts and patches the NetworkPolicy. If the CIDR set changes, WRC keeps the
previous CIDRs for `WRC_RUNTIME_EGRESS_DNS_OVERLAP_SECONDS` seconds (default
`300`) so DNS rotation does not cut over in-flight runs abruptly. That overlap is
also a bounded trust window: the old public CIDRs remain allowed until the window
expires, even if the hostname has already moved. The SDK also enforces the
per-step host allowlist in-process,
requires HTTPS for public hosts, blocks redirects to undeclared hosts, restricts
methods to `GET`, `HEAD`, `POST`, and `PUT`, and limits response size.

Secrets:

```yaml
steps:
  - id: call-api
    run:
      type: snippet
      language: typescript
      code: |
        const key = sdk.secrets.get("api_key")
        return { hasKey: Boolean(key) }
      capabilities:
        secrets:
          - alias: api_key
            secretRef:
              name: public-api-key
              key: key
```

Snippet secrets reference Kubernetes Secrets by `secretRef.name/key`. Control UI
can capture these values in password fields and creates or updates the Secret in
`sandbox-recipes` before deploying the WorkflowRecipe; the CRD stores only the
reference, never the value. If you apply YAML directly, create the Kubernetes
Secret yourself first, and label it so the recipe is allowed to read it: either
`clerum.io/shared: "true"` (any recipe may reference it) or
`clerum.io/owner-recipe: <recipeName>` (only that recipe may). An unlabeled
Secret — or one carrying both labels — is denied, and the recipe fails with
`snippet secret "<name>" is not accessible to recipe "<recipe>"`.
Platform-managed runtime Secrets such as coordinator tokens are rejected.

MongoDB/PostgreSQL:

```yaml
workloads:
  - id: postgres
    type: deployment
    image: postgres:16
    port: 5432
steps:
  - id: query-db
    run:
      type: snippet
      language: typescript
      code: |
        const ref = { workload: "postgres", database: "clerum" }
        await sdk.postgres.execute(ref, {
          sql: "insert into receivables(account, amount) values ($1, $2)",
          values: ["dao-alpha", 1880]
        })
        return await sdk.postgres.query(ref, {
          sql: "select * from receivables where amount >= $1",
          values: [1000],
          limit: 10
        })
      capabilities:
        postgres:
          access: readWrite
          workloads: [postgres]
```

Database helpers can only reach declared workloads in the same WorkflowRecipe.
Within that declared context, the snippet can perform the business operations
it needs. Declare `access: read` for read-only steps and `access: readWrite`
for steps that insert, update, delete, run PostgreSQL DDL, or use MongoDB
`$out`/`$merge`. The runner does not accept arbitrary connection strings,
host/port overrides, or undeclared workload ids. PostgreSQL calls are one
statement per SDK call to avoid bundled follow-on statements; use multiple SDK
calls when a step needs a sequence of operations.

MCP:

```yaml
workloads:
  - id: mongo-mcp
    type: deployment
    image: clerum/mock-mcp-server:test
    port: 3000
    transport:
      type: streamableHttp
      path: /mcp
steps:
  - id: read-mcp
    run:
      type: snippet
      language: typescript
      code: |
        return await sdk.mcp.callTool("mongo-mcp", "upsert_receivable", {
          account: "dao-alpha",
          amount: 1880
        })
      capabilities:
        mcp:
          servers: [mongo-mcp]
          allowedTools:
            include: [mongo-mcp__upsert_receivable]
```

Tool allowlists must be explicit. Wildcards are rejected. If a declared MCP tool
mutates data, that mutation is considered part of the workflow context chosen
by the recipe author; WRC controls access to the declared server/tool rather
than trying to infer each tool's internal side effects.

Manual MCP calls use the MCP TypeScript SDK directly inside the snippet worker.
Operators can tune SDK request bounds with `CLERUM_MCP_TOOL_TIMEOUT_MS` and
`CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS`; the effective call timeout is still
clamped to the remaining snippet step budget. For snippets that do not declare
`timeoutSeconds`, the runner keeps its existing operational fallback timeout,
but declared step budgets are not replaced by that fallback.

## Artifacts

Artifacts become product artifacts when the snippet returns metadata produced by
`sdk.artifacts.*`:

```ts
const artifact = await sdk.artifacts.writeJson("custom-report.json", { ok: true })
return { artifact }
```

Safe artifact names contain only letters, numbers, dot, underscore, and hyphen.
Artifacts are mounted at `/output` and later surfaced through the run-scoped
WorkflowRecipe artifact download flow in Control UI and Desktop App.
Artifacts written through `sdk.artifacts.*` are tracked by the runtime even when
the returned object is nested or named differently; returning
`{ artifacts: [...] }` is still recommended because it makes the step output
easy to inspect.

## Operational Notes

- The feature flag is `WRC_ENABLE_SNIPPET_RUNTIME`; operators enable it per
  environment.
- The runner image is `clerum/workflow-snippet-runner`.
- The runner pod has no service account token, runs non-root, uses a read-only
  root filesystem, drops Linux capabilities, and receives only declared snippet
  secret aliases plus the explicit MCP timeout env allowlist.
- NetworkPolicies are generated from declared snippet capabilities.
