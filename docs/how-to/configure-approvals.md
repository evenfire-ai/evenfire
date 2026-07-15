# How to: configure human-in-the-loop approvals

evenfire treats tool execution as untrusted by default. MCP tool calls can
**suspend** until an explicit approve or deny. Pending approvals are persisted
so they survive pod restarts.

## Mental model

1. Agent decides to call a tool.
2. If policy requires approval, the task waits.
3. A human approves or denies via desktop app, Slack, or Telegram (when
   configured).
4. Runtime continues or aborts.

## Dev / Compose

Environment knobs on `mcp-host` (see [mcp-host README](../../mcp-host/README.md)):

| Variable | Role |
| --- | --- |
| `CLERUM_ENABLE_APPROVAL` | Master switch for the approval gate |
| `CLERUM_APPROVAL_CONFIG` | JSON policy when not loading a Host CRD |

Example policy JSON:

```json
{
  "defaultPolicy": "designated_approvers",
  "channels": {
    "telegram": {
      "enabled": true,
      "approvers": ["123456789"]
    }
  }
}
```

`defaultPolicy` values (Host CRD / runtime):

| Value | Meaning |
| --- | --- |
| `cli_only` | Approvals only via HTTP / control surfaces |
| `channel_users` | Any authorized channel user may approve |
| `designated_approvers` | Only listed approvers |

## Production (Host CRD)

Configure approvals on the **Host**:

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
  approval:
    defaultPolicy: designated_approvers
    channels:
      telegram:
        enabled: true
        approvers: ["123456789"]
      slack:
        enabled: true
        approvers: ["U01234567"]
    # Optional per-tool overrides for native tools:
    # tools:
    #   http_request: false   # skip approval for this native tool
    #   shell_exec: true      # force approval
```

Per-tool overrides for **native** tools are documented in
[mcp-host README](../../mcp-host/README.md). MCP tools use server/tool naming
and platform defaults — treat “require approval” as the safe baseline.

## Option C — the Control UI

The host detail page in Control UI has a per-tool approval editor
(`HostApprovalSection`) with three settings per native tool — **Default /
Required / Skip** — plus a risk hint when an override loosens a tool whose
built-in default is Required (for example `shell_exec` or `http_request` set
to Skip). Saving writes the same `spec.approval.tools` field on the `Host`
CRD shown above; it is a front end for it, not a second mechanism. MCP tools
stay approval-required by default regardless of what is set here. See
[Control UI](../surfaces/control-ui.md).

## Where humans approve

| Surface | Typical use |
| --- | --- |
| Desktop app | Operators watching live tasks |
| Telegram / Slack | Mobile / chat-native approve-deny |
| Control plane APIs | Automation and integration tests |

Channel callbacks are signature-verified; unauthorized actors cannot mint
approvals by replaying chat.

## Verify

1. Trigger a tool-using prompt (or E2E suite that exercises approvals).
2. Confirm a pending approval appears on the configured surface.
3. Deny once and confirm the tool does not run; approve and confirm it does.
4. Restart `mcp-host` with a pending approval and confirm it still resolves.

Cluster E2E coverage: [E2E guide](../testing/e2e-guide.md).

## Related

- Root [Security model](../../README.md#security-model)
- [Host CRD](../crds/host.md)
- [Connect Telegram](connect-telegram.md)
