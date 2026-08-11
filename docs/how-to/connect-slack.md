# How to: connect Slack

Reach an evenfire agent from Slack.

Slack works differently from Telegram. Telegram is polled: `channel-reader`
long-polls the bot and nothing has to reach your cluster. Slack is pushed:
`channel-reader` skips Slack polling entirely, and every Slack message arrives
as an Events API callback on `webhook-proxy`, which hands it to
`workflow-approval-request-reader` and on to `channel-reader`. Slack has to be
able to reach your cluster before anything works, including the setup code you
send to link your account.

## Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps), **Create New App**,
   **From scratch**, and pick the workspace.
2. Under **OAuth & Permissions**, add these **Bot Token Scopes**:

   | Scope                                                              | Used for                                                            |
   | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
   | `app_mentions:read`                                                | receiving `app_mention` events                                      |
   | `channels:history`, `groups:history`, `im:history`, `mpim:history` | receiving `message` events from channels, private channels, and DMs |
   | `chat:write`                                                       | posting and editing replies (`chat.postMessage`, `chat.update`)     |
   | `files:write`                                                      | delivering workflow result documents (`files.uploadV2`)             |
   | `channels:read`, `groups:read`, `im:read`, `mpim:read`             | reading conversation metadata at link time (`conversations.info`)   |
   | `users:read`                                                       | naming DM conversations at link time (`users.info`)                 |

   Drop the `im` / `mpim` entries if the agent will only live in channels, and
   the `groups` entries if only public channels are in play.

3. Under **Event Subscriptions**, enable events and subscribe to these bot
   events: `app_mention`, `message.channels`, `message.groups`, `message.im`,
   `message.mpim`. Leave the Request URL for now, you get it in the next
   section.
4. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`).
5. Under **Basic Information**, copy the **Signing Secret**.
6. In Slack, invite the app to the channel you want it in (`/invite @YourApp`),
   or open a DM with it.

Steps 1 and 2 are faster from a manifest. **Create New App** → **From an app
manifest**, then paste:

```yaml
display_information:
  name: Evenfire
features:
  bot_user:
    display_name: Evenfire
    always_online: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - chat:write
      - files:write
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The manifest deliberately omits `event_subscriptions` and `interactivity`.
Slack verifies a Request URL the moment you save one, and that URL does not
exist until the channel is created below.

Two things to know about credentials:

- The "app is ready" dialog offers a **Bot token** (`xoxb-…`) and an **App
  token** (`xapp-…`). Only the bot token is used. The `xapp-` token is for
  Socket Mode, which this platform does not use.
- The **Signing Secret** is not in that dialog. It lives under **Basic
  Information → App Credentials**, as a 32-character hex string. It is not the
  Client Secret.

## In the Control UI

External Channels → `/external-channels` → **Create** builds the
`CommunicationChannel` resource.

> **Create a dedicated channel. Do not add Slack to an existing Telegram or
> email channel.** Adding a Slack App Name to a channel whose Secret holds only
> another provider's credentials is currently accepted on update, and produces a
> channel that advertises Slack, shows a Slack Request URL, and appears in the
> Profile UI as a target, but answers every Slack request with
> `409 slack_signing_secret_missing`.

1. Pick the host, then the **Slack** provider.
2. Set **Slack App Name**. It is required, and it is what users are told to
   message, so use the app's real name.
3. Toggles:
   - **Only reply when mentioned** (on by default). In a channel the app then
     only acts on `app_mention` events and messages that start with a mention.
     DMs always work, and `/approve` and `/deny` are always accepted.
   - **Reply in threads**: replies go in a thread on the triggering message.
4. Paste the **Slack signing secret** and the **Slack Bot User OAuth token** as
   write-only credentials. This writes a Secret in the `channels` namespace and
   points `spec.credentialsSecretRef` at it.
5. Grant access to the users and teams allowed on this channel.

`spec.slack[]` starts empty. Conversations are added when users confirm them,
not by hand.

### Get the Request URL, from the right channel

Reopen the channel you just created and copy the **Slack Request URL** from its
edit page. Paste it into the Slack app as both the **Event Subscriptions**
request URL and the **Interactivity & Shortcuts** request URL. Slack's
`url_verification` handshake is answered for you, so the URL verifies on its own
once it is reachable.

The URL is per channel, and the page renders the URL of whichever channel you
are looking at. Copying from the wrong channel's page is the single easiest
mistake to make here, and the resulting failure says nothing about which channel
it hit. The tail of the URL is a base64url blob that decodes to the channel
name, so you can always check what you have:

```bash
node -e 'console.log(Buffer.from(process.argv[1].replace(/-/g,"+").replace(/_/g,"/"),"base64").toString())' \
  "<the part after slack%3A>"
# → {"namespace":"channels","name":"slack-support"}
```

Two Slack-side traps when pasting it:

- **Retry does not re-read the field.** It re-sends to the URL Slack already
  stored, so a Retry after fixing nothing hits the old URL forever. Select the
  field, clear it, paste the new value, and let it lose focus.
- **The field truncates on screen**, often exactly where two channels' URLs
  diverge. Press `End` in the field to see the tail before saving.

Slack does not prompt for a reinstall after you subscribe to the bot events
above, because the manifest already granted the scopes those events need. That
is expected, not a failure. If you want one anyway: **Settings → Install App →
Reinstall to Workspace**, then re-check the bot token, since a reinstall can
issue a new one.

## On minikube (quickstart stack)

Complete the [Quickstart](../get-started/quickstart.md) first so the platform
runs.

There is no `.env` shortcut for Slack. `CLERUM_SLACK_BOT_TOKEN` is read only by
`channel-reader`'s dev-mode resolver when the process runs outside the cluster,
and is ignored in-cluster, where credentials come from
`spec.credentialsSecretRef` only. It changes where the token is read from and
nothing else: Slack is webhook-driven either way, and no code path polls it.

The bigger constraint is reachability. `webhook-proxy` runs in the
`webhook-ingress` namespace on port 8095, and the base manifests ship no
Ingress for it (production fronts it with cloudflared). A local minikube is not
reachable from Slack, so expose the proxy through a public tunnel and use
`<your-public-base>/webhooks/slack/<targetId>` as the Request URL. The Control
UI only prints the path when `NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL` is
unset, so prefix it with your own public base.

Without that, the Slack app installs fine and the channel saves fine, but no
message ever arrives.

## Any cluster (CRD path)

Deploy the stack ([Minikube guide](../deploy/minikube.md) for local). Slack is
declared as a `CommunicationChannel` bound to a `Host`, with the bot token and
signing secret in a Secret in the `channels` namespace.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cc-slack-support-credentials
  namespace: channels
type: Opaque
stringData:
  slack-bot-token: 'xoxb-…'
  slack-signing-secret: '…'
---
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: slack-support
  namespace: channels
spec:
  hostRef: 'chatllm'
  credentialsSecretRef:
    name: cc-slack-support-credentials
  slackSettings:
    botHandle: 'Evenfire'
    replyOnlyWhenMentioned: true
    replyInThreads: false
  slack:
    - channelId: 'C0123456789' # stable channel ID, not a display name
      workspaceId: 'T0123456789'
      userIds:
        - 'U0123456789'
```

Point `Host.spec.channels` at the channel. Every `slack[]` entry needs either
`userIds` plus `workspaceId`, or the legacy `userNames`; a bare `channelId` is
rejected by the CRD's `anyOf`. See the
[CRD reference](../crds/communicationchannel.md) and
[examples](../../charts/clerum-crds/examples/channels.yaml).

## Confirm your Slack identity

**Do this before trying to chat.** Until a conversation is confirmed, the agent
answers nothing. `channel-reader` calls `authorizeProviderMessage` on every
inbound message and drops anything it cannot tie to a linked identity, logging
`Ignoring unauthorized slack message from <user> in <channel>`. The bot looks
dead, but the events are arriving and being refused. `verify` is the only thing
that works in an unconfirmed conversation.

Slack conversations are bound to a user rather than configured by hand. Each
person does this once per conversation:

1. In the Profile UI, open the Slack verification panel
   (`/settings/social/slack`) and start verification. It issues a six-digit
   code.
2. In Slack, send the code to the app:

   ```text
   verify 123456
   ```

   Send it as a DM, or mention the app in a channel
   (`@YourApp verify 123456`). Do not put a leading slash on `verify`: Slack
   treats it as a slash command and never delivers it.

3. The app replies `Slack identity confirmed.` control-api appends the
   conversation to `spec.slack[]` with your Slack user ID, the workspace ID,
   the conversation type and title, and who confirmed it, and fills in
   `slackSettings.workspaceId` if it was empty.

The `userIds` plus `workspaceId` pair recorded here is the only identity form
valid for workflow approval decisions. Legacy `userNames` groups are a chat-only
allowlist and are rejected as approval identity.

## Talk to the agent

Message the app in a confirmed conversation. In a DM any message reaches the
agent. In a channel, with the default **Only reply when mentioned**, mention the
app. `workflow-approval-request-reader` verifies the Slack signature, hands the
message to `channel-reader`, and `channel-reader` forwards it to `mcp-host` and
posts the reply back with the bot token.

**Threads are not exempt from the mention rule.** With **Reply in threads** on,
the agent answers inside a thread, but a reply you write in that thread still
needs a mention while **Only reply when mentioned** is set. The gate
(`workflow-approval-request-reader/src/server.ts:295-307`) accepts only
`app_mention` events, messages whose text starts with a mention, and
`/approve` / `/deny`. Thread identity is used to decide where to post a reply,
never whether to accept one. If threaded back-and-forth without tagging is what
you want, turn **Only reply when mentioned** off, and accept that the agent then
sees every message in that conversation. DMs never need a mention either way.

## Approvals over Slack

**Enable Interactivity & Shortcuts with the same Request URL as Event
Subscriptions, and press its own Save Changes button.** The reader serves both
on one route, `POST /webhooks/{medium}/{targetId}`
(`workflow-approval-request-reader/src/server.ts:709-721`), so the URL is
identical. If Interactivity is unset, Slack refuses to deliver `block_actions`
at all: the click dies in Slack, nothing reaches the cluster, and every service
log stays silent. Slack marks the buttons with a warning tooltip reading "This
app is not configured to handle interactive responses."

A tool approval posts **three** buttons, not two
(`channel-reader/src/main.ts:154-186`):

| Button             | Value      | Effect on the conversation                                                     |
| ------------------ | ---------- | ------------------------------------------------------------------------------ |
| **Approve**        | `tool:a:…` | Runs the call, and auto-approves `*` plus, for MCP tools, that server's prefix |
| **Always approve** | `tool:l:…` | Same, and additionally stores the bare tool name for future turns              |
| **Deny**           | `tool:d:…` | Cancels the call and releases the session                                      |

The value is `tool:<a|l|d>:<16-char token>`
(`main.ts:110-121`, matched by `decisionHandler.ts:93`). Typing `/approve`,
`/approve always`, or `/deny` works too.

Three properties of that token that produce confusing failures:

- It lives in `channel-reader`'s memory with a 10-minute TTL
  (`main.ts:95`). Clicking later returns "No pending approval found".
- Any `channel-reader` restart wipes it, and **saving an edit to the channel in
  the Control UI restarts that pod**. Approve after such a save and the click is
  already dead.
- Auto-approvals are per conversation
  (`mcp-host/src/core/conversation/conversation.ts:482-493`), so approving in
  the desktop app does not carry to Slack. There is no cross-surface rescue
  either: `mcp-host/src/server/routes.ts:433-435` forces `channelType='rpc'` for
  desktop callers, so a Slack-originated approval fails binding validation
  there.

Slack is enabled as an approval medium by default
(`WORKFLOW_APPROVAL_READER_ENABLED_MEDIA` is `telegram,slack,teams`). See
[Configure approvals](configure-approvals.md).

### An unanswered approval stalls that conversation

When a tool needs approval the session is suspended, and every later message in
that same conversation queues behind it
(`mcp-host/src/session/sessionProcessor.ts:196-204`). The reported symptom is
"the agent stopped responding", which sends people hunting for a connection
fault that is not there. `channel-reader` logs the giveaway:
`Queue: 3 pending, 1 processing`.

The scope is one session, not the host. `pickNextReadySession` skips only
suspended session keys, so other conversations keep running. Approving or
denying releases it (`releaseSuspendedSession`). Server-side expiry of the
approval itself is off by default (`CLERUM_APPROVAL_TIMEOUT` is `0`), so with a
misconfigured Slack app the stall persists until the durable pending row ages
out, 7 days by default (`CLERUM_PENDING_APPROVAL_TTL_HOURS`), or the pod
restarts and the boot reaper clears it.

To clear a stuck request without waiting, deny it from inside the
`channel-reader` pod, the only legitimate edge caller. The image has no curl,
so use node:

```
POST http://<host>.mcp-host.svc.cluster.local:8080/v1/runtime/approvals/deny
  x-clerum-edge-caller: channel-reader
  x-clerum-edge-host-ref: <host>
  x-clerum-edge-channel-type: slack
  x-clerum-edge-channel-id: <C…>
  x-clerum-edge-sender: <U…>

{"userId":"<U…>","requestId":"<uuid>","channelType":"slack","channelId":"<C…>"}
```

The header and body channel triple must match (`mcp-host/src/server/routes.ts:66-81`).
A `{"success":true}` moves the task to `completed` and drains the queue.

## Troubleshooting

Diagnose from the two services in the path. Everything below is visible there
before it is visible anywhere else:

```bash
# Did Slack reach us, and did the signature check pass?
kubectl -n channels logs deploy/clerum-workflow-approval-request-reader --since=15m | grep -i slack

# Did the message get accepted, or dropped at the identity gate?
kubectl -n channels logs deploy/channel-reader-<host> --since=15m | grep -iE "New message from slack|unauthorized"
```

A silent reader log means Slack never called. The `targetId` in a reader warning
decodes to the channel that was hit, which is how you catch a wrong Request URL.

| Symptom                                          | Cause and check                                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack: "didn't respond with the challenge value" | Read the reader log. The `targetId` tells you which channel Slack actually hit, and the status tells you why it failed                                                                 |
| `409 slack_signing_secret_missing`               | The URL points at a channel whose Secret has no `slack-signing-secret`, almost always the wrong channel's Request URL                                                                  |
| `401 invalid_provider_signature`                 | Right channel, wrong secret. Re-copy the Signing Secret from **Basic Information**, not the Client Secret                                                                              |
| `404` / `400 invalid_target_id`                  | Malformed or truncated URL, usually a partial paste                                                                                                                                    |
| Retrying in Slack changes nothing                | Retry re-sends to the stored URL. Clear the field and paste the new one                                                                                                                |
| Nothing arrives at all                           | Is the Request URL public and verified? Slack pushes, nothing is polled                                                                                                                |
| Slack cannot verify the Request URL              | The URL must reach `webhook-proxy` (`webhook-ingress`, port 8095) from the internet                                                                                                    |
| `Ignoring unauthorized slack message`            | The conversation is not confirmed. Run the `verify` flow first, chat is gated on a linked identity                                                                                     |
| App answers only when tagged                     | `replyOnlyWhenMentioned` is on by default, and thread replies are not exempt                                                                                                           |
| Missing message events                           | Subscribe to `message.channels` / `message.groups` / `message.im` / `message.mpim` and `app_mention`                                                                                   |
| `verify` never lands                             | Sent with a leading slash (`/verify`), so Slack intercepted it. Send `verify 123456`                                                                                                   |
| Verification fails                               | Code expired or already used; issue a new one from the Profile UI                                                                                                                      |
| Events arrive but replies fail                   | Bot token wrong or stale. A reinstall can issue a new `xoxb-`; update it on the channel                                                                                                |
| Two identical app names when verifying           | Two channels on the host both have Slack enabled. Only one has credentials. Clear the Slack App Name on the wrong one                                                                  |
| Approval buttons do nothing                      | Interactivity & Shortcuts has no Request URL. Slack blocks the click itself, so the reader log is completely silent. Its tooltip says "not configured to handle interactive responses" |
| "No pending approval found" on click             | The 10-minute token expired, or `channel-reader` restarted. Saving a channel edit in the Control UI restarts it                                                                        |
| Agent stopped responding to Slack entirely       | An unanswered approval suspended that conversation. Look for `Queue: N pending, 1 processing`, then approve, deny, or clear it as above                                                |

More FAQ: [FAQ](../faq.md).
