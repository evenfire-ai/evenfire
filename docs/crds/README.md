# CRD Reference

evenfire defines **8** Custom Resource Definitions under the `clerum.io/v1alpha1`
API group (historical code name — see [code names](../concepts/code-names.md)).

Install via the Helm chart:

```bash
helm install clerum-crds ./charts/clerum-crds
# After upgrades, re-apply CRD YAML (Helm 3 does not upgrade crds/ on upgrade):
kubectl apply -f ./charts/clerum-crds/crds/
```

## CRDs

| CRD                  | Kind                   | Scope      | Purpose                                                             | Reference                                          |
| -------------------- | ---------------------- | ---------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| Host                 | `Host`                 | Namespaced | Agent instance: model provider, context, secret, channels, approval | [host.md](host.md)                                 |
| Context              | `Context`              | Namespaced | MCP server allowlist (and related scope) for Hosts                  | [context.md](context.md)                           |
| McpServer            | `McpServer`            | Namespaced | Connector deployment (image, transport, auth, env, egress)          | [mcpserver.md](mcpserver.md)                       |
| CommunicationChannel | `CommunicationChannel` | Namespaced | Telegram / Email / Slack config + authorized users                  | [communicationchannel.md](communicationchannel.md) |
| WorkflowRecipe       | `WorkflowRecipe`       | Namespaced | Multi-workload composition with MCP registration                    | [workflowrecipe.md](workflowrecipe.md)             |
| WorkflowRecipePolicy | `WorkflowRecipePolicy` | Namespaced | Governance policy for WorkflowRecipes                               | [workflowrecipepolicy.md](workflowrecipepolicy.md) |
| SharedFileSystem     | `SharedFileSystem`     | Namespaced | Per-team shared workspace (read-only to agents)                     | [sharedfilesystem.md](sharedfilesystem.md)         |
| GlobalFileSystem     | `GlobalFileSystem`     | Namespaced | Brokered global drive with audited access                           | [globalfilesystem.md](globalfilesystem.md)         |

## Relationships

```
Host
 |-- contextRef  -->  Context
 |       |-- mcpServers[]     -->  McpServer (0..N)
 |       |-- shared FS refs   -->  SharedFileSystem (0..N, when configured)
 |-- secretRef   -->  K8s Secret (API keys)
 |-- channels[]  -->  CommunicationChannel (by name)
 |-- approval    -->  policy for tool gates

WorkflowRecipe  --governed by-->  WorkflowRecipePolicy
GlobalFileSystem  (singleton-style governed drive; API via gfs-controller)
```

## Working examples

Ready-to-apply manifests:  
[`charts/clerum-crds/examples/`](../../charts/clerum-crds/examples/).

## Service ownership

| CRD                  | Primary consumers                                   |
| -------------------- | --------------------------------------------------- |
| Host                 | mcp-host                                            |
| Context              | host-context-controller                             |
| McpServer            | host-context-controller                             |
| CommunicationChannel | channel-reader                                      |
| WorkflowRecipe       | workflow-recipes (WRC)                              |
| WorkflowRecipePolicy | workflow-recipes (WRC)                              |
| SharedFileSystem     | host-context-controller, workspace-files-controller |
| GlobalFileSystem     | host-context-controller, gfs-controller             |
