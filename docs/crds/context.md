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
| `spec.displayName` | string | no | Free-text display name (spaces and capitals allowed), editable without changing the identifier. When absent, UIs fall back to `metadata.name`. control-api rejects control characters and trimmed lengths over 120. |
| `spec.description` | string | no | Human-readable description of the context scope. |
| `spec.mcpServers` | string[] | yes | List of McpServer CRD names accessible within this context. When a host requests servers for this context, only these servers are returned by the context-mapper. |
| `spec.sharedFileSystems` | object[] | no | Optional list of SharedFileSystem references. Each entry causes HCC to inject a read-only volume mount into every mcp-host pod whose Host references this Context. Keyed on `mountPath` (unique within a Context). Each entry requires `name` (SharedFileSystem.metadata.name in the mcp-host namespace) and `mountPath` (absolute path inside the container, matching `^/[a-zA-Z0-9_.][a-zA-Z0-9_./\-]*$`). |
| `spec.gfs.mounts` | object[] | no | Optional Global File System mount intents. Defined in the schema, but host-context-controller does not read it in this release: an entry wires no mount and grants no access. (The CRD description's scope check lives in `host-context-controller/src/contextGfsMount.ts`, which has no production caller yet.) Keyed on `target`. Each entry requires `drive` (gfs drive name), `target` (32-hex resource id or absolute path), and `scopes` (array from `gfs.read`, `gfs.write`, `gfs.delete`, `gfs.manage_acl`, `gfs.share`). |

## Status Fields

| Field | Type | Description |
|-------|------|-------------|
| `status.sharedFileSystems[]` | object[] | Per-entry resolution of `spec.sharedFileSystems`: `name`, `mountPath`, `phase` (`Resolving` \| `Mounted` \| `MissingTarget` \| `Failed`), optional `pvcName` and `message`. Defined in the schema, but host-context-controller does not write it in this release. Readers such as control-api fall back to each SharedFileSystem's own `status.phase` and `status.pvcName`. |

## How Contexts are created

Most Contexts are created for you. Control UI has no Contexts screen: old
`/contexts` links redirect to the Agents list, or to the owning agent's
Connectors tab when the Context belongs to an agent.

- **Agents.** The agent wizard creates a private Context for each new agent
  and sets the Host's `contextRef` to it. Its `mcpServers` are the connectors
  picked in the wizard.
- **Connector installs create no Context.** Installing a connector from the
  Marketplace, through an OAuth connector install, or as a custom or remote
  connector creates only the McpServer: it writes no Context and edits no
  `mcpServers` allowlist. Enabling the connector for an agent is a separate
  step that adds its name to that agent's Context.
- **Workflow recipes.** A WorkflowRecipe that runs MCP transport workloads and
  sets no `spec.contextRef` gets a private Context named `wf-<recipeName>`
  (hash-shortened past 63 characters), created by the workflow-recipes
  operator in the `mcp-server` namespace. An agentic recipe that does set
  `contextRef` must pass the default-deny check described in
  [WorkflowRecipePolicy](workflowrecipepolicy.md).

UI-created private Contexts are named `<subject>-<5 digits>`, where the
subject is the agent name in kebab case. Older Contexts named after a
connector came from installs that no longer create one.

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
- [SharedFileSystem CRD](sharedfilesystem.md) -- targets of `spec.sharedFileSystems`
- [WorkflowRecipePolicy CRD](workflowrecipepolicy.md) -- `allowContextRef` for agentic recipes
- [CRD Index](README.md)
- [Example](../../charts/clerum-crds/examples/context1.yaml)
