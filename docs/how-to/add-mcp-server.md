# How to: add an MCP server (connector)

MCP servers give agents tools. evenfire never “auto-discovers the whole
cluster”: a **Context** allowlists which servers a **Host** may reach, and the
platform enforces that with NetworkPolicies on Kubernetes.

## Option A — mcp-host dev mode (contributors, no cluster)

When running `mcp-host` standalone (`CLERUM_DEV_MODE=true npm run dev`), wire
servers with `CLERUM_MCP_SERVERS` (JSON array). Each entry needs `name`,
`contextRef`, `transport`, `enabled`, and
`status: { deployed: true, ready: true }` or it is skipped as not ready:

```bash
CLERUM_MCP_SERVERS=[{"name":"my-mcp","contextRef":"dev-context","transport":{"type":"streamableHttp","url":"http://my-mcp:3000/mcp"},"enabled":true,"status":{"deployed":true,"ready":true}}]
```

Restart the dev process after changing env. There is **no** NetworkPolicy
isolation in dev mode — this is for local tool smoke tests only.

## Option B — Kubernetes (platform path)

### 1. Declare the server

```yaml
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: mongodb-server
  namespace: mcp-server
spec:
  # image, transport (HTTP or stdio), env, auth, egress — see CRD reference
```

Full schema: [McpServer CRD](../crds/mcpserver.md).  
Examples: [charts/clerum-crds/examples/](../../charts/clerum-crds/examples/).

### 2. Allow it on a Context

```yaml
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: context1
  namespace: mcp-server
spec:
  contextId: context1
  mcpServers:
    - mongodb-server
```

Anything **not** listed is unreachable to hosts that use this context.

### 3. Point a Host at the Context

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: openai
    name: gpt-5.4-mini
```

### 4. Apply and verify

```bash
kubectl apply -f your-mcpserver.yaml -f your-context.yaml
# host-context-controller reconciles Deployments, Services, NetworkPolicies
```

Check:

- McpServer / Deployment ready in the MCP namespace
- `mcp-host` discovery / tool list includes the new tools
- First tool call respects [approval policy](configure-approvals.md)

## Stdio vs HTTP

- **HTTP / Streamable HTTP** — direct service URL
- **stdio** — typically via `stdio-bridge` sidecar translating to HTTP

See [stdio-bridge README](../../stdio-bridge/README.md) and
[mcp-servers](../../mcp-servers/README.md).

## Security checklist

- [ ] Image pinned by digest in production
- [ ] Secrets referenced key-by-key, not ambient cluster access
- [ ] Egress bindings only as wide as the connector needs
- [ ] Context allowlist reviewed like IAM
- [ ] Approval policy still requires human yes for risky tools

## Related

- [CRD index](../crds/README.md)
- [Architecture overview](../architecture/overview.md)
- [WorkflowRecipes](../features/workflow-recipes.md) — multi-workload recipes that may register MCP servers
