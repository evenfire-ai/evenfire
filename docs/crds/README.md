# CRD Reference

Clerum defines 6 Custom Resource Definitions under the `clerum.io/v1alpha1` API group.
Install them via the Helm chart at `charts/clerum-crds/`:

```bash
helm install clerum-crds ./charts/clerum-crds
```

## CRDs

| CRD | Kind | Scope | Purpose | Reference |
|-----|------|-------|---------|-----------|
| Host | `Host` | Namespaced | Central LLM entity -- binds a model provider to a context, secret, and channels | [host.md](host.md) |
| Context | `Context` | Namespaced | Groups MCP servers into an allowlist accessible by a Host | [context.md](context.md) |
| McpServer | `McpServer` | Namespaced | MCP server deployment spec (image, transport, auth, env, egress) | [mcpserver.md](mcpserver.md) |
| CommunicationChannel | `CommunicationChannel` | Namespaced | Telegram / Email / Slack channel config with authorized users | [communicationchannel.md](communicationchannel.md) |
| WorkflowRecipe | `WorkflowRecipe` | Namespaced | Multi-workload composition (Deployments, StatefulSets, CronJobs, etc.) | [workflowrecipe.md](workflowrecipe.md) |
| WorkflowRecipePolicy | `WorkflowRecipePolicy` | Namespaced | Governance policy for WorkflowRecipes | *(not yet documented)* |

## Relationships

```
Host
 |-- contextRef  -->  Context
 |       |-- mcpServers[]  -->  McpServer (1..N)
 |-- secretRef   -->  K8s Secret (API keys)
 |-- channels[]  -->  CommunicationChannel (by name)
```

## Working Examples

See [`charts/clerum-crds/examples/`](../../charts/clerum-crds/examples/) for
ready-to-apply YAML manifests covering all CRD kinds.

## Service Ownership

| CRD | Watched by |
|-----|------------|
| Host | mcp-host |
| Context | host-context-controller |
| McpServer | host-context-controller |
| CommunicationChannel | channel-reader |
| WorkflowRecipe | host-context-controller (Workload Recipe Controller) |
