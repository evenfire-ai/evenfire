# Context CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Watched by:** host-context-controller (Context Mapper)

## Purpose

Context defines which MCP servers a Host can access. A Host references a Context
via `contextRef`, and the Context declares the allowlist of McpServer names. The
context-mapper uses this to filter which servers are returned to each host at
discovery time.

## Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.contextId` | string | yes | Unique identifier for this context (e.g. `context1`). |
| `spec.description` | string | no | Human-readable description of the context scope. |
| `spec.mcpServers` | string[] | yes | List of McpServer CRD names accessible within this context. When a host requests servers for this context, only these servers are returned by the context-mapper. |

## Additional Printer Columns

`kubectl get contexts` displays: Context ID, MCP Servers.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: context1
  namespace: mcp-server
spec:
  contextId: context1
  description: Context for chatLLM host -- defines which MCP servers it can access.
  mcpServers:
    - mongodb-server
    - airtable-server
    - playwright-server
```

## Related

- [Host CRD](host.md) -- references this Context via `spec.contextRef`
- [McpServer CRD](mcpserver.md) -- entries in `spec.mcpServers` must match McpServer metadata names
- [CRD Index](README.md)
- [Example](../../charts/clerum-crds/examples/context1.yaml)
