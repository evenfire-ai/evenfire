# How to: configure human-in-the-loop approvals

The approval system is **on by default** (`CLERUM_ENABLE_APPROVAL` defaults to
`true`). **An MCP tool call suspends** until an explicit approve or deny unless
an earlier approval already covers it: approving once for the rest of the
turn, an "always" grant for the tool, or a grant for its whole MCP server lets
later matching calls run without a new prompt. The per-tool overrides below do
not apply to MCP tools.
Among **native** tools, five require approval by default — `shell_exec`,
`http_request`, `cron_manage`, `browser_open`, and `browser_navigate`.
`workflow_trigger` also requires approval, except when the task came from
Telegram, Slack or Teams. Every other native tool runs without prompting. Each
native tool can be flipped with a per-tool override on `Host.spec.approval`.

Pending approvals are kept in mcp-host's conversation store. The default store
(`CLERUM_SESSION_STORE=memory`) is in memory, so a pod restart loses them.
Stateless Hosts use the SQLite store on their workspace volume, and the
minikube overlay sets `CLERUM_SESSION_STORE=sqlite`.

## Mental model

1. Agent decides to call a tool.
2. If policy requires approval, the task waits.
3. A human approves or denies via desktop app, Slack, or Telegram (when
   configured).
4. Runtime continues or aborts.

## Dev mode (no cluster)

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

Tool approvals from chat do not arrive as signed callbacks. channel-reader
polls Telegram (long polling) and Slack with the bot's own token, and drops
messages from senders the channel does not allow. Workflow approvals are
different: the workflow approval reader takes inbound callbacks and checks
Telegram's webhook secret token, Slack's HMAC signature, or Teams'
authorization. Wiring a chat surface up:
[Connect Telegram](connect-telegram.md), [Connect Slack](connect-slack.md).

## Verify

1. Trigger a tool-using prompt (or E2E suite that exercises approvals).
2. Confirm a pending approval appears on the configured surface.
3. Deny once and confirm the tool does not run; approve and confirm it does.
4. On a Host that uses the SQLite store, restart `mcp-host` with a pending
   approval and confirm it still resolves.

Cluster E2E coverage: [E2E guide](../testing/e2e-guide.md).

## Related

- [Configure guardrails](configure-guardrails.md): rules whose `ask` decision uses this approval flow
- Root [Security model](../../README.md#security-model)
- [Host CRD](../crds/host.md)
- [Connect Telegram](connect-telegram.md)
