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

In dev mode (`CLERUM_DEV_MODE`), which has no Host watch, `modeCeiling` and `allowModeChange` are read from this JSON. Outside dev mode those keys in `CLERUM_APPROVAL_CONFIG` are ignored. A Host whose policy comes only from the ConfigMap has ceiling `manual`, so every session runs as manual, until a ceiling is set on the Host CR. mcp-host uses `spec.approval` or `CLERUM_APPROVAL_CONFIG` as one whole object and never merges the two, so adding `spec.approval` replaces the ConfigMap policy: a `defaultPolicy`, channel block or `tools` override left only in the ConfigMap stops applying. Copy `defaultPolicy`, `channels` (with each channel's `approvers` and `allowModeChange`) and `tools` into the CR in the same edit that sets the ceiling. A channel switch not on the CR keeps its default, so Telegram, Slack and Teams sessions can then rise unless `allowModeChange: false` is on the CR. See [Host CRD](../crds/host.md#approval-mode-ceiling).

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
    # Absent means gpt-5.5. The chat model above is not the shell judge.
    # shellClassifierModel: gpt-5.5
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
is `manual`, except a Desktop chat whose first message carries a mode picked
before the chat existed: that chat stores the carried mode. Rank is
`manual` < `auto` < `allow_all`. Desktop labels the higher two "Auto-approve"
and "Allow all". A messaging command uses `allow-all`. The effective mode is
the minimum of the stored choice, the ceiling, and the channel cap. On a
messaging channel the cap also carries the approver policy (see
[Approver policy](#approver-policy)). A lower ceiling or cap keeps the stored
choice, so raising it again restores that choice.

| Mode | What a gated call does |
| --- | --- |
| `manual` | Today's card. The classifier is not called. |
| `auto` | Judges `shell_exec` on the models below. Read-only commands inside the workspace run; anything else shows the shell card. `http_request` runs with no card. Every other tool still shows a card. |
| `allow_all` | Runs every call that would have shown a card, except two. `cron_manage` asks exactly when manual would (see below). A guardrail `ask` (an explicit `ask` rule, or the `unmatched_ask` default of a Host with guardrail rules) still shows its card. |

`cron_manage` asks exactly when manual would, in every mode. A task grant
already stored for it still covers a later create, including while the chat is
allow-all, except on a stateless Host: there every create and enable asks,
whatever grant is stored. The mode does not change that forced gate.

Any change of a session's effective mode, up or down, clears its mode-scoped
grants: every task grant (a plain approval that covers the rest of the task)
except `cron_manage`'s, so the `http_request` one goes too, not only the
`shell_exec` one; the Always grant for `shell_exec`; and the auto shell grants
(Allow this command and Always allow shell). Always grants for other tools
stay.

A guardrail `ask` shows its card in every interactive mode, scoped to that one
call, with no Always option. Allow-all still runs these with no card: a tool an
admin forces to ask with `spec.approval.tools.<tool>: true`, a tool the user
denied earlier in the chat, and a GFS download (`clerum__gfs_download`), which
otherwise asks on every call. A guardrail `deny` still blocks in every mode.

### Ceiling

`Host.spec.approval.modeCeiling` is `manual`, `auto`, or `allow_all`. Absent,
or any other value, means `manual`. mcp-host reads it from the Host CR only.
The same field in `CLERUM_APPROVAL_CONFIG` is not a live control, except in
dev mode.

A control-api admin, or a Kubernetes principal who can write
`hosts.clerum.io`, sets it. The mcp-host service account cannot write the Host.
Setting `auto` or `allow_all` accepts unattended shell on this Host. Treat
either as suitable only for a single-user Host. v1 does not enforce that.

On Hosts that run the `mcp-host-slim`, `mcp-host-full` or `mcp-host-desktop`
image, which ship developer tools, treat `auto` with the same caution as
`allow_all`. The classifier judges the command text only, so an approval is not
a guarantee that the command is read-only. Keep the ceiling at `manual` on those
Hosts unless the Host is single-user and you accept that risk.

An `allow_all` ceiling accepts, among other things: shell that can read the
process environment, the runtime-token Secret, and the Host GFS token; HTTP to
any public host on ports 80 and 443 when the allowlist is empty; MCP servers
running under the user's own OAuth identity; and edits to shared identity files.
`cron_manage` still asks exactly when manual would, and a guardrail `ask` still shows its card. In `auto`, `http_request` runs with no card unless
`tools.http_request` is `true`, which keeps the card.

### Channel cap

The cap comes from the session's channel type, not from the session key, and,
on a messaging channel, from the [approver policy](#approver-policy) for the
session's owner.

| Session | Cap |
| --- | --- |
| Desktop (`rpc`) | `allow_all`. The approver policy never applies |
| Telegram, Slack, or Microsoft Teams | `allow_all` unless `approval.channels.<type>.allowModeChange` is `false`. The switch defaults to on. `manual` for an owner the approver policy does not allow |
| Email | `allow_all` only when `approval.channels.email.allowModeChange` is `true`. The switch defaults to off, because the From address can be forged. `manual` for an owner the approver policy does not allow |
| Any other channel | `manual` |

A malformed value caps sessions at `manual`. A `channels` value that is not an object
caps every messaging channel: Telegram, email, Slack and Microsoft Teams. A
channel block that is not an object, or an `allowModeChange` that is not a
boolean, caps that channel only. Desktop is not affected. mcp-host logs
`approval_config_invalid` with the field name when the config arrives.

The table assumes the approver policy allows the channel session's owner. For
an owner it does not allow, the column is the same as a switch that is off.

| Ceiling | Desktop can use | A channel whose switch is on can use | A channel whose switch is off can use |
| --- | --- | --- | --- |
| `manual` | manual | manual | manual |
| `auto` | manual, auto | manual, auto | manual |
| `allow_all` | all three | all three | manual |

A messaging command may always store `manual`. It may store `auto` or
`allow_all` only while that channel's switch is on. When the switch is off,
the command stores `manual` and says the channel is limited to manual.
Turning the switch off again lowers every session on that channel at the
next tool call.

### Approver policy

An explicit `defaultPolicy` also limits who can raise the mode from a
messaging channel, and who keeps a raised mode. The owner of a messaging
session is the sender it belongs to. Under `cli_only`, no owner can raise the
mode or keep a raised one. Under `designated_approvers`, only an owner listed
in that channel's `approvers` can, unless that channel block sets
`enabled: false`. Every other messaging session runs as `manual`, whatever it
stored and whenever it stored it. Desktop sessions are never affected. An
entry must equal the ID the channel reports:

- Telegram: the Telegram user ID.
- Slack: the Slack user ID.
- Microsoft Teams: the `from.id` of the Bot Framework activity. Under
  `designated_approvers`, a Host with no `teams.approvers` list refuses every
  Teams raise and runs every Teams session as `manual`.
- Email: the From address, compared case-sensitively, so
  `Ana@example.com` and `ana@example.com` are different entries.

A refused raise leaves the stored mode unchanged, and the reply says why;
lowering the mode is always allowed. The reply's effective mode includes the
policy, so an owner it does not allow sees `manual`. An unset policy or
`channel_users` adds no check. Any other value runs every messaging session as
`manual`, refuses every raise, and logs `approval_config_invalid` for
`defaultPolicy`.

The policy on the Host CR is read live, like the ceiling. Changing
`defaultPolicy`, or removing an owner from `approvers`, lowers that owner's
sessions at their next tool call, with no restart. The stored choice is kept, so allowing the owner
again restores it.

### Kill switch

Lower `modeCeiling`, set a channel's `allowModeChange` to false, or narrow
the approver policy (set `defaultPolicy` to `cli_only` or
`designated_approvers`, or remove an owner from a channel's `approvers`), with
an edit to the Host CR. That stops new unattended tool calls at the next tool call of every
affected session, with no restart. Mode-scoped grants (see
[Approval modes](#approval-modes)) are cleared as soon as the new config
arrives, even for a session that makes no tool call before the change is
undone. A card answered after the change resolves under the lower
mode.

Check the spelling of `allowModeChange` and the channel names. The CRD drops
an unknown key under `spec.approval.channels` instead of storing it. `kubectl
apply` refuses such a key by default (strict field validation), but a client
that does not validate strictly gets only a warning, and the channel then keeps
its default: on for Telegram, Slack and Teams. After the edit, read the Host
back (`kubectl get host <name> -o yaml`) and confirm the field is there.

A slower older Host event does not restore the ceiling, the channel cap or the
approver policy. The config that stays is the latest observed Host event.

`cron_manage` asks exactly when manual would. Its task grant stays across the
change. The switch does not stop a `shell_exec` the tool still tracks until
that command's own timeout. A child started with `setsid` or a detached spawn
is not signalled and runs until the pod restarts. It does not stop a cron job
already created, a workflow step already waiting, or an HTTP or MCP side
effect already in flight, and it does not undo a write. Editing
`CLERUM_APPROVAL_CONFIG` is not this switch: that variable is parsed once at
startup.

### Classifier coverage

The classifier approves only commands that read, list or search inside the workspace, read-only git commands, and commands that compute a result without writing files, reading secrets or using the network. Deletes, installs, network calls, secrets, identity and memory files, scheduling, privilege changes and hidden commands show the card. So does a command that argues for its own approval. An approval is a model's judgment, not a security boundary: in auto, `http_request` still runs with no card.

When the Host's model provider (`spec.model.provider`) is `openai`, auto
judges shell with `spec.approval.shellClassifierModel`, using the Host's
OpenAI key. Absent or blank means `gpt-5.5`. That
call does not follow the chat model: a `gpt-5.4-mini` chat, and a failover
pair, are still judged by the shell classifier model. The call asks for
reasoning effort `none`, so the short reply is not spent on hidden reasoning.
The session read's `shellClassifierAvailable` reports that same model, and
the usage event names it.

The OpenAI models the classifier may call are an allowlist. It contains
`gpt-5.5`. `gpt-4o`,
`gpt-4.1`, `gpt-4.1-mini`, and `gpt-5.4-mini` show the shell card. Pinning
`shellClassifierModel` to one of those shows the card too.

On any other provider, the classifier model is not used: mcp-host builds it
only from the credentials of the Host's own provider, so neither an
`openai-api-key` in the Host's Secret nor an OpenAI fallback's key enables it.
Auto then judges shell on Claude and on Bedrock
Anthropic models, using the model serving the turn. When failover is serving
a fallback, that pair is the one checked and called. A pair the table refuses
shows the card. Azure, the subscription providers, and Vertex and Gemini show
the card. `http_request` still runs with no card. In dev mode, which reads keys
from the environment, any `OPENAI_API_KEY` enables the classifier model.

An explicit `tools.shell_exec: true` keeps a card on every shell call in auto,
with no classifier and no shell memory. Remove the line if auto should judge
shell. It does not keep a card in allow-all; a guardrail `ask` rule does. See
[Host CRD](../crds/host.md#approval-mode-ceiling).

## Option C — the Control UI

Open the agent in Control UI and choose the **Approvals** tab, between
**Access** and **Advanced** (`/agents/<name>/approval-settings`; the older
`/agents/<name>/approvals` link redirects there). It does three things.

- **Reads every approval setting.** The highest mode and what it lets run,
  the shell judge (shown in Auto and Allow all), which channels may change the
  mode, who may raise it from a channel (the policy and each channel's
  approvers), and the per-tool overrides. Approver IDs and email addresses
  show on this page, which any admin who can open the agent can read. The
  mode, channel and approver sections are read-only. Change
  them on the Host as described in [Approval modes](#approval-modes); the
  tab's **How to change these** link points there.
- **Lowers the ceiling with one button.** **Set to Manual now** is the off
  switch, described next.
- **Edits per-tool overrides.** Each native tool is **Default / Required /
  Skip**. A change that loosens approval (a tool set to Skip, or Required put
  back to Default on a tool whose default is Skip, among others) lists each
  loosening item in a confirmation dialog, and the save is sent only after
  you confirm. Saving writes `spec.approval.tools` and nothing else on the
  Host, except on a first save (below). MCP tools stay approval-required
  regardless of what is set here.

The per-tool editor used to live under **Advanced**; **Advanced** now holds a
pointer to the **Approvals** tab. The Overview, Model and guardrails saves on
the agent page read the Host's version first and refuse to save without one
(the page says "Reload the page to save").

### Set to Manual now

The button writes `modeCeiling: manual` and nothing else in `spec`. It needs
no confirmation, and it is available even when the tab could not load the
agent's settings. It reads the Host, and if the ceiling is already Manual (or
the Host has no `spec.approval`) it reports "Manual is saved. It was already
Manual." and writes nothing; it never creates an approval block. Otherwise it
sends the Host with the version it just read, and retries on a version
conflict, a 429, a server error or no answer, starting no new attempt more
than 20 seconds after the click. Running chats apply the lower ceiling at
their next tool call, as in [Kill switch](#kill-switch).

**What it does not stop.** The message after a save lists what still runs
without a card:

- tools set to Skip, and tools that never ask (the page lists them);
- approvals chats already gave: "Always allow" for every tool except shell, in
  every chat; "Always allow" for shell and approvals for the rest of a task on
  `shell_exec` and `http_request`, in chats that were already in Manual;
  `cron_manage` approvals, in every chat;
- scheduled tasks (on stateless agents they still ask before creating or
  enabling another schedule).

[Kill switch](#kill-switch) also covers a shell command, cron job, workflow
step or HTTP or MCP side effect already running. None of this has an effect
if approvals are off for the cluster (below).

**It can be refused.** The general Host save validates the whole spec, so an
unrelated field can refuse it. One case: a Host whose spec names the
`codex-subscription` or `grok-subscription` provider while control-api's
`CONTROL_API_CODEX_SUBSCRIPTION_ENABLED` or
`CONTROL_API_GROK_SUBSCRIPTION_ENABLED` is `false` (the `deploy/base` default;
the minikube overlay sets both to `true`) is answered with 422
`provider "..." is disabled`. The page then shows the error and this command,
which changes only the ceiling:

```bash
kubectl -n <namespace> patch host <name> --type=json \
  -p '[{"op":"replace","path":"/spec/approval/modeCeiling","value":"manual"}]'
```

The patch needs `spec.approval` to exist. On a Host without it the ceiling is
already Manual.

**Known limit: a Host CRD rolled back.** After a rollback to a Host CRD without
`modeCeiling`, the switch reports "It was already Manual." while the stored
ceiling is only hidden by the older schema. After upgrading the CRD again,
check the ceiling.

### Other things to know

- **Agents with no approval settings of their own.** The tab says the agent
  uses the cluster default, which the page cannot show. mcp-host reads the
  ceiling and the channel switches from the Host's own block only, so such an
  agent already runs Manual. Its first per-tool save asks you to pick who may
  approve from a channel ("Any channel user" or "Nobody (Desktop only)") and
  writes that `defaultPolicy` with the tools. The dialog warns that the cluster
  rules stop applying for this agent and may have been stricter than the
  values the page shows. The reason is that mcp-host uses `spec.approval` or
  `CLERUM_APPROVAL_CONFIG` as one whole object, never a merge.
- **Copy a stricter `CLERUM_APPROVAL_CONFIG` first.** If you made it stricter
  than the default, copy `defaultPolicy`, `channels` and `tools` into the Host
  with `kubectl` before that first save, as [Dev mode](#dev-mode-no-cluster)
  describes.
- **`CLERUM_ENABLE_APPROVAL`.** It defaults to `true` in `deploy/base` and the
  minikube overlay (neither sets it). If it is `false` for the cluster there is
  no approval gate, and nothing on this tab has an effect.
- **Agents set by a deployment manifest.** A banner appears when a manifest
  also sets `spec.approval`: a `kubectl apply` that recorded
  `spec.approval` in its `last-applied-configuration` annotation (the banner
  then shows the values it set), or a server-side apply that owns
  `spec.approval` (the banner shows no values). Edits made in the tab,
  `kubectl patch` and `kubectl edit` do not raise it. The next deploy puts the
  manifest's values back, including a higher ceiling, so change the manifest
  too. If a server-side apply owned only `modeCeiling`, the off switch's write
  takes that field over: the switch's message still warns, but after a reload
  the banner is gone, and a re-apply that forces conflicts
  (`kubectl apply --server-side --force-conflicts`) puts the manifest's
  ceiling back.
- **HTTP allowlist.** In Auto, `http_request` runs with no card. Unless
  `CLERUM_HTTP_ALLOWLIST` is set on mcp-host, it can reach any public address
  (it refuses private ones). Neither `deploy/base` nor the minikube overlay
  sets it. Setting `http_request` to Skip without an allowlist logs an
  `[approval-config]` warning at startup and again on every Host change.
- **In-flight action checks.** With `CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2` on
  (off by default), any `spec.approval` change, the off switch included, makes an
  action check bound to the earlier policy come back `access_path_stale`, so it is
  checked again.
- **Concurrent edits.** A Host PUT that changes `spec.approval` must carry
  the `metadata.resourceVersion` it read. Without it control-api answers
  `409 {"error":"conflict","reason":"approval_requires_version"}`. A PUT
  that leaves `spec.approval` as stored needs no version. A PUT or create
  with no `spec` is refused with 422. Scripts and clients that change
  approval through the Host API must read the Host first and send its version.
  `kubectl` is not affected.

### The audit line and its retention

Each Host create or update through control-api that changes `spec.approval`
writes one structured log line, event `host_approval_changed` at `info`, from
the control-api logger. It records the Host, namespace, the admin's `operatorSub`, the
`operationId` of the administrative operation record, and `via` (`host_put` or
`host_create`). Then:

- `fields`: old and new for `modeCeiling`, `defaultPolicy`, `shellClassifierModel`
  and each channel's `enabled` and `allowModeChange`. A `defaultPolicy` that
  is not one of the three CRD values is recorded as `(not a policy value)`.
- `tools`: a list of `{ name, old, new }`. Changed native tools of mcp-host come
  first, then at most 50 other changed keys, with `toolsTruncated` for the
  rest. Names are cut to 64 characters and string values to 128.
- `approvers`: counts added and removed per channel. Approver IDs and
  addresses are never logged.
- `blockRemoved` and `inheritedBefore`.

String values are written with control, C1, bidirectional and line-separator
characters as `\uXXXX` escapes.

A Host create, or an update that carries a version, also stores the intended
change as JSON in the `summary` of the administrative intent event for the
request, readable
through the administrative event detail in control-api's tracing API. It is
built from the request and, for an update, the read just before the write, not
from what the cluster stored: under an older Host CRD it can record a field
that the apiserver then prunes. It is capped at 4096 characters. If the change
is larger, other tools are dropped first, then long string values become
`(value too long)`, then the field values
become counts (the changed `modeCeiling` and `defaultPolicy` keep their old and
new values, and every native tool entry stays). If even that cannot fit,
control-api logs a `host_approval_summary_oversize` warning and cuts native
entries, counting them in `nativeToolsTruncated`. A PUT without a version
cannot change `spec.approval`, so it stores no summary.

Retention is not set by this feature. Log lines last as long as your log
collection keeps them; control-api does not store them. The stored `summary`
is an administrative event, which the trace maintenance worker prunes after 90
days ([Governed tracing](../architecture/governed-tracing.md)). Where you need
longer evidence, keep the log line.

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
