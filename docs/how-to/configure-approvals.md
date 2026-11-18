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
  "modeCeiling": "auto",
  "channels": {
    "telegram": {
      "enabled": true,
      "approvers": ["123456789"],
      "allowModeChange": true
    }
  }
}
```

In dev mode (`CLERUM_DEV_MODE`), which has no Host watch, `modeCeiling` and `allowModeChange` are read from this JSON. Outside dev mode those keys in `CLERUM_APPROVAL_CONFIG` are ignored. A Host whose policy comes only from the ConfigMap stays at ceiling `manual` and channel cap `manual` until the same policy is copied onto the Host CR. See [Host CRD](../crds/host.md#approval-mode-ceiling).

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
    modeCeiling: auto
    channels:
      telegram:
        enabled: true
        approvers: ["123456789"]
        allowModeChange: true
      slack:
        enabled: true
        approvers: ["U01234567"]
        allowModeChange: false
    # Optional per-tool overrides for native tools:
    # tools:
    #   http_request: false   # skip approval for this native tool
    #   shell_exec: true      # in auto, a card on every shell call
```

Per-tool overrides for **native** tools are documented in
[mcp-host README](../../mcp-host/README.md). MCP tools use server/tool naming
and platform defaults — treat “require approval” as the safe baseline.

## Approval modes

Each interactive session stores `manual`, `auto`, or `allow_all`. A new session
is `manual`. Rank is `manual` < `auto` < `allow_all`. Desktop labels the higher
two "Auto-approve" and "Allow all". A messaging command uses `allow-all`. The
effective mode is the minimum of the stored choice, the ceiling, and the
channel cap. A lower ceiling or cap keeps the stored choice, so raising it
again restores that choice.

| Mode | What a gated call does |
| --- | --- |
| `manual` | Today's card. The classifier is not called. |
| `auto` | Judges `shell_exec` on the models below. `http_request` runs with no card. Every other tool still shows a card. |
| `allow_all` | Runs every call that would have shown a card, except `cron_manage`. |

`cron_manage` asks exactly when manual would, in every mode. A task grant
already stored for it still covers a later create, including while the chat is
allow-all. The mode does not change its forced create/enable gate.

### Ceiling

`Host.spec.approval.modeCeiling` is `manual`, `auto`, or `allow_all`. Absent,
or any other value, means `manual`. mcp-host reads it from the Host CR only.
The same field in `CLERUM_APPROVAL_CONFIG` is not a live control, except in
dev mode.

A control-api admin, or a Kubernetes principal who can write
`hosts.clerum.io`, sets it. The mcp-host service account cannot write the Host.
Setting `auto` or `allow_all` accepts unattended shell on this Host. Treat
either as suitable only for a single-user Host. v1 does not enforce that.

An `allow_all` ceiling accepts, among other things: shell that can read the
process environment, the runtime-token Secret, and the Host GFS token; HTTP to
any public host on ports 80 and 443 when the allowlist is empty; MCP servers
running under the user's own OAuth identity; and edits to shared identity files.
`cron_manage` still asks. In `auto`, `http_request` runs with no card unless
`tools.http_request` is `true`, which keeps the card.

### Channel cap

The cap comes from the session's channel type, not from the session key.

| Session | Cap |
| --- | --- |
| Desktop (`rpc`) | `allow_all` |
| Telegram, Slack, email, or Microsoft Teams | `allow_all` while `approval.channels.<type>.allowModeChange` is `true`; otherwise `manual` |
| Teams, or any other channel | `manual` |

| Ceiling | Desktop can use | A channel with `allowModeChange: true` can use | A channel without it can use |
| --- | --- | --- | --- |
| `manual` | manual | manual | manual |
| `auto` | manual, auto | manual, auto | manual |
| `allow_all` | all three | all three | manual |

A messaging command may always store `manual`. It may store `auto` or
`allow_all` only while that channel's `allowModeChange` is true. Otherwise it
stores `manual` and says the channel is limited to manual. Turning the flag
off again lowers every session on that channel at the next tool call.

### Kill switch

Lower `modeCeiling`, or set a channel's `allowModeChange` to false, with an
edit to the Host CR. That stops new unattended tool calls at the next tool
call of every affected session, with no restart. Mode-scoped grants are
cleared as soon as the new config arrives, even for a session that makes no
tool call before the ceiling is raised again.

A slower older Host event does not restore the ceiling or channel cap. The
config that stays is the latest observed Host event.

`cron_manage` asks exactly when manual would. Its task grant stays across the
change. The switch does not stop a `shell_exec` the tool still tracks until
that command's own timeout. A child started with `setsid` or a detached spawn
is not signalled and runs until the pod restarts. It does not stop a cron job
already created, a workflow step already waiting, or an HTTP or MCP side
effect already in flight, and it does not undo a write. Editing
`CLERUM_APPROVAL_CONFIG` is not this switch: that variable is parsed once at
startup.

### Classifier coverage

Auto judges shell only on Claude, Bedrock Anthropic models, and non-reasoning
OpenAI models. Everywhere else, auto shows the shell card for every shell
command, while `http_request` still runs with no card. That includes OpenAI's
default `gpt-5.4-mini` (it is in the reasoning family), Azure, the subscription
providers, and Vertex and Gemini.

The judge is the model serving the turn. When failover is serving a fallback,
that pair is the one checked and called. A fallback the table would refuse
shows the card. With no failover, the session's model on the Host provider is
the pair.

An explicit `tools.shell_exec: true` keeps a card on every shell call in auto,
with no classifier and no shell memory. Remove the line if auto should judge
shell. See [Host CRD](../crds/host.md#approval-mode-ceiling).

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
