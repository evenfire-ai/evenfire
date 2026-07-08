# Host CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Watched by:** mcp-host

## Purpose

Host is the central entity that binds an LLM model provider to a context (MCP server allowlist),
a Kubernetes Secret containing API keys, and one or more communication channels. Each Host
represents a single LLM agent instance.

## Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.host` | string | yes | Host identifier (e.g. `chatLLM`). |
| `spec.contextRef` | string | yes | Reference to the Context CRD name (e.g. `context1`) that defines which MCP servers this host can access. |
| `spec.secretRef` | string | yes | Name of the Kubernetes Secret containing LLM API keys (`openai-api-key`, `claude-api-key`, `zai-api-key`, `bailian-api-key`). |
| `spec.channels` | string[] | no | List of CommunicationChannel CRD names this host interacts with. |
| `spec.model` | object | no | LLM model configuration. |
| `spec.model.provider` | string | no | LLM provider. One of: `openai`, `claude`, `zai`, `bailian`. |
| `spec.model.name` | string | no | Model name (e.g. `gpt-5.4-mini`, `claude-opus-4-7`, `glm-5.1`). |
| `spec.workflowControl.scopes` | string[] | no | Workflow broker scopes this Host may receive in its mcp-host-control JWT. Valid values: `workflow:list`, `workflow:read`, `workflow:trigger`, `workflow:approval:resolve`, `workflow:approval:decide`. `workflow_status` and `workflow_health` are covered by `workflow:read`; there is no native `workflow_read` tool. `workflow:approval:resolve` is required for provider identity resolution through this first-party Host; `workflow:approval:decide` is required when a bound channel-reader relays provider-originated workflow approval decisions. |
| `spec.approval` | object | no | Tool approval configuration -- controls who can approve tool executions. |
| `spec.approval.defaultPolicy` | string | no | Who can approve tool calls. One of: `cli_only` (HTTP endpoints only), `channel_users` (any authorized channel user), `designated_approvers` (only users in approvers list). |
| `spec.approval.channels` | object | no | Per-channel-type approval settings. |
| `spec.approval.channels.telegram` | object | no | Telegram approval config. |
| `spec.approval.channels.telegram.enabled` | boolean | no | Whether Telegram users can approve. |
| `spec.approval.channels.telegram.approvers` | string[] | no | List of Telegram user IDs allowed to approve. |
| `spec.approval.channels.email` | object | no | Email approval config. |
| `spec.approval.channels.email.enabled` | boolean | no | Whether email users can approve. |
| `spec.approval.channels.email.approvers` | string[] | no | List of email addresses allowed to approve. |
| `spec.approval.channels.slack` | object | no | Slack approval config. |
| `spec.approval.channels.slack.enabled` | boolean | no | Whether Slack users can approve. |
| `spec.approval.channels.slack.approvers` | string[] | no | List of Slack user IDs allowed to approve. |
| `spec.approval.tools` | object | no | Per-tool approval override map for native mcp-host tools. Map of tool name (e.g. `http_request`, `shell_exec`) to boolean: `true` forces approval, `false` skips approval. Absent entries fall through to each tool's built-in default. MCP tools (named `serverName__toolName`) are NOT covered. See `mcp-host/README.md#per-tool-approval-overrides` for the v1 tool list and warning behavior. |

## Additional Printer Columns

`kubectl get hosts` displays: Host, Context, Secret, Provider.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: claude
    name: claude-opus-4-7
  workflowControl:
    scopes:
      - workflow:list
      - workflow:read
      - workflow:trigger
      - workflow:approval:resolve
      - workflow:approval:decide
  channels:
    - all-channels
  approval:
    defaultPolicy: designated_approvers
    channels:
      telegram:
        enabled: true
        approvers:
          - "123456789"
    tools:
      http_request: false   # skip approval — relies on CLERUM_HTTP_ALLOWLIST as the gate
      shell_exec: true      # explicit (matches code default; documents intent)
```

The referenced Secret must exist in the same namespace:

```bash
kubectl create secret generic chatllm-api-keys \
  --from-literal=openai-api-key=sk-xxx \
  --from-literal=claude-api-key=sk-ant-xxx \
  --from-literal=zai-api-key=zai-xxx \
  --from-literal=bailian-api-key=sk-xxx
```

## Related

- [Context CRD](context.md) -- referenced via `spec.contextRef`
- [CommunicationChannel CRD](communicationchannel.md) -- referenced via `spec.channels[]`
- [CRD Index](README.md)
- [Example](../../charts/clerum-crds/examples/host-chatllm.yaml)
