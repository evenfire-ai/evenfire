# Context CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Watched by:** host-context-controller (Context Mapper)

## Purpose

Context defines which MCP servers a Host can access and which SharedFileSystems a
Host should mount read-only. A Host references a Context via `contextRef`, and the
Context declares the allowlist of McpServer names. The host-context-controller uses
this to filter which servers are returned to each host at discovery time, and to
inject SharedFileSystem volume mounts into the mcp-host pod.

## Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.contextId` | string | yes | Unique identifier for this context (e.g. `context1`). |
| `spec.description` | string | no | Human-readable description of the context scope. |
| `spec.mcpServers` | string[] | yes | List of McpServer CRD names accessible within this context. When a host requests servers for this context, only these servers are returned by the context-mapper. |
| `spec.sharedFileSystems` | object[] | no | Optional list of SharedFileSystem references. Each entry causes HCC to inject a read-only volume mount into every mcp-host pod whose Host references this Context. Keyed on `mountPath` (unique within a Context). Each entry requires `name` (SharedFileSystem.metadata.name in the mcp-host namespace) and `mountPath` (absolute path inside the container, matching `^/[a-zA-Z0-9_.][a-zA-Z0-9_./\-]*$`). |
| `spec.gfs.mounts` | object[] | no | Optional Global File System mount intents. Intent only: HCC wires a mount only if the Context identity already holds the requested scopes. Keyed on `target`. Each entry requires `drive` (gfs drive name), `target` (32-hex resource id or absolute path), and `scopes` (array from `gfs.read`, `gfs.write`, `gfs.delete`, `gfs.manage_acl`, `gfs.share`). |

## Additional Printer Columns

`kubectl get contexts` displays: Context ID, MCP Servers, SharedFS.

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
