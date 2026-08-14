# How to: connect Microsoft Teams

Reach an evenfire agent from Microsoft Teams.

Teams is pushed, like Slack and unlike Telegram. `channel-reader` does not poll
Teams. Every message arrives as a Bot Framework activity on `webhook-proxy`,
which hands it to `workflow-approval-request-reader` and on to `channel-reader`.
Microsoft has to be able to reach your cluster before anything works, including
the code you send to link your account.

Teams also has a dependency the other providers do not. Registering the bot
requires the messaging endpoint, and that endpoint is derived from the channel
name, so you type the channel name first and the Control UI hands you the exact
command to run. Telegram gives you a token from BotFather immediately, and Slack
gives you a bot token as soon as the app exists. Teams gives you nothing until
the endpoint is settled.

## Before you start

| You need                          | Because                                            |
| --------------------------------- | -------------------------------------------------- |
| Admin of the Teams organization   | Enabling custom app upload                          |
| The Teams desktop or web client   | Installing the app                                  |
| Admin in the Control UI           | Creating the channel                                |
| An existing agent (`Host`)        | `spec.hostRef` is required                          |
| Node.js 20 or later               | Installing `@microsoft/teams.cli`                   |
| A publicly reachable cluster      | Microsoft must reach `webhook-proxy`                |

## Enable custom app upload

In the [Teams admin center](https://admin.teams.microsoft.com), open Teams apps
> **Setup policies**, click the name **Global (Org-wide default)**, turn on
**Upload custom apps**, and save.

That enables sideloading for everyone in the tenant, which is what you want on a
test tenant. Check it first, since it is often already on. In a production org,
create a separate policy instead and assign it under Users > Manage users > the
user > Policies > App setup policy. Direct assignment overrides the global
default, so an assigned user is governed by their own policy regardless of what
Global says.

**Verify from the CLI, not the admin center.** After the next section,
`teams status` prints a `Sideloading:` line:

```text
✔ Logged in as you@yourtenant.onmicrosoft.com
✔ Sideloading: enabled
```

`enabled` means the policy is live. That one line replaces clicking through
assignment screens, and it is also how you know propagation has finished. Policy
changes take Microsoft's own time, sometimes hours. If the install step fails
later, check this first.

## Install the Teams CLI

```shell
npm install -g @microsoft/teams.cli
teams --version
teams login          # add --device-code to avoid opening a browser
teams status
```

The install prints an `allow-scripts` warning about skipped build scripts for
`keytar` and `@azure/msal-node-extensions`. Ignore it. `keytar` ships a prebuilt
binary and login works without them. An `Azure CLI: not installed` line in
`teams status` is also fine; only the `--azure` path needs it.

## In the Control UI

1. Open **External Channels** and create a new channel.
2. Enter the channel name and pick the agent. **Settle the name now.** It is
   encoded into the endpoint, and channels cannot be renamed.
3. Choose the **Microsoft Teams** provider. The tab opens on Telegram, so this
   is an explicit click.
4. Enter the bot **Name**. This becomes the bot's display name in Teams, so a
   human-readable name like `Evenfire Support` is fine. Any non-empty name up to
   80 characters is accepted, matching what the CRD and the API allow. Avoid
   quotes and shell metacharacters, since the name is interpolated into the
   command you are about to copy.
5. Decide whether the bot answers only when mentioned.

The panel now shows the `teams app create` command with your endpoint filled in.
Copy it and run it. The same command is available later on the channel's edit
page, which is also the repair path if you ever need to re-register.

### If your deployment has no public webhook origin

The Control UI works out the origin from
`NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL`, or by deriving
`webhook.<domain>` when the page hostname starts with `app.`. On a deployment
where neither applies, including minikube and `localhost`, it cannot know your
public address.

You will see a warning and a command containing the literal placeholder
`https://<public-webhook-origin>`. Replace it with your public origin before
running the command, or set the environment variable so it is filled in
automatically. Do not run the command unedited: it registers a bot pointing at a
hostname that does not exist, and no message ever arrives.

The endpoint itself is deterministic. It is `/webhooks/teams/` plus a
percent-encoded target id, which is `teams:` followed by the base64url encoding
of `{"namespace":"channels","name":"<kebab-channel-name>"}`:

```text
/webhooks/teams/teams%3AeyJuYW1lc3BhY2UiOiJjaGFubmVscyIsIm5hbWUiOiJ0ZWFtcy1zdXBwb3J0In0
```

## Register the bot

```shell
teams app create \
  --name teams-support \
  --endpoint "https://webhook.example.com/webhooks/teams/teams%3A…" \
  --sign-in-audience myOrg \
  --env .env
```

**Run it from anywhere.** There is no project requirement and no scaffolding
step. Evenfire is the message server, so the quickstart's "create a project"
instructions do not apply. The working directory only decides where `.env`
lands. If you pass `--json` instead of `--env`, credentials come back on stdout
and no `.env` is written at all.

**`--sign-in-audience myOrg` matters.** `channel-reader` fetches its bot token
from `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`, which
only works for a single-tenant app. A multi-tenant registration needs the
`botframework.com` authority instead and fails with an `AADSTS` error. The
default is single-tenant, but the flag exists, so pin it.

The command prints a **Teams App ID**, a **Bot ID**, an **Install in Teams**
link, and writes `CLIENT_ID`, `TENANT_ID` and `CLIENT_SECRET`. On a
teams-managed bot the Teams App ID, Bot ID and `CLIENT_ID` are the same UUID;
do not go hunting for three different values.

**Short and long description need to differ.** `teams app create` sets both to
the app name. The Developer Portal requires them to be different, so before
installing, open the [Developer Portal](https://dev.teams.microsoft.com/apps),
select the app, and under **Basic information** give the long description its
own value. Do this regardless: it may be part of why the install link below
fails (see Troubleshooting), though that has not been confirmed.

Open the install link, add the app, and optionally add it to a channel.

Then paste `CLIENT_ID`, `TENANT_ID` and `CLIENT_SECRET` into the Control UI and
create the channel. The secret is stored as `teams-app-password` in a Secret
named `cc-<channel-name>-credentials` in the `channels` namespace, and is
write-only: it renders masked and is never returned.

Treat the generated `.env` as a secret. Do not paste it into a document, a chat,
or a screenshot.

## Enable file upload and download

Workflow results are delivered as files, which the bot cannot send unless the
manifest allows it:

```shell
teams app manifest update <appId> --set-json 'bots[0].supportsFiles=true' --yes
```

**`--yes` is load-bearing.** Without it the command prints "Manifest update
requires --yes in non-interactive mode", changes nothing, and still looks like
it worked. The global `-y` you passed to `teams app create` does not carry over.
Confirm against the server rather than trusting the exit code:

```shell
teams app manifest download <appId> ./verify.json
```

Expect `bots[0].supportsFiles` to be `true` and the manifest version to have
bumped. The equivalent portal path is App Features > Bot > **Upload and download
files**.

`teams app doctor <appId>` is a useful checkpoint. It reports whether the
endpoint is reachable and shows `Sign-in audience: AzureADMyOrg` for a correctly
registered single-tenant bot.

## Any cluster (CRD path)

Teams is declared as a `CommunicationChannel` bound to a `Host`, with the client
secret in a Secret in the `channels` namespace.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cc-teams-support-credentials
  namespace: channels
type: Opaque
stringData:
  teams-app-password: '…' # CLIENT_SECRET from the generated .env
---
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: teams-support
  namespace: channels
spec:
  hostRef: 'chatllm'
  credentialsSecretRef:
    name: cc-teams-support-credentials
  teamsSettings:
    appName: 'teams-support'
    appId: '00000000-0000-0000-0000-000000000000' # CLIENT_ID
    tenantId: '00000000-0000-0000-0000-000000000000' # TENANT_ID
    replyOnlyWhenMentioned: true
  teams:
    - channelId: '19:…@thread.tacv2' # Bot Framework conversation id
      tenantId: '00000000-0000-0000-0000-000000000000'
```

`metadata.name` decides the endpoint, so it cannot change later. Point
`Host.spec.channels` at the channel. See the
[CRD reference](../crds/communicationchannel.md).

## Confirm your Teams identity

**Do this before trying to chat.** Until a conversation is confirmed, the agent
will not act on it.

1. Open **Profile UI > Settings > Approval Channels > Teams**.
2. Start a connection and pick the Teams channel.
3. Copy the code it shows.
4. Open the conversation you want to connect. For a channel, add the bot to it
   first.
5. Send the verification command:
   - Direct message: `verify 123456`
   - Channel with mention-only on: `@YourBot verify 123456`

The bot replies `Teams identity confirmed.` and the account shows as connected.
The code expires, so if it lapses, start the connection again rather than
resending the old one.

If you message the bot before connecting, it replies once explaining that it
cannot accept messages from that account and pointing you here. That reply is
threaded under your message, and you get it at most once per conversation per
day.

## Talk to the agent

Message the bot, mentioning it if mention-only is on. In a channel the reply
arrives in a thread. Tool progress appears as the agent works, and a failed tool
renders as a short sentence rather than a raw error, for example
`GitHub search unavailable (authentication problem). Ask your administrator.`
The full error goes to the logs, not to chat.

## Approvals over Teams

When a workflow needs a decision, an approval card arrives in the conversation.
Choosing an option records the decision and the agent continues.

Approving with an "always" option is sticky for that tool. A later run will not
prompt again until the decision is cleared, which looks like a broken approval
flow when it is not.

## Troubleshooting

**Nothing arrives, but the channel saved.** Almost always the endpoint. Confirm
the registered endpoint matches the channel's current name, and that the origin
is publicly reachable. `teams app doctor <appId>` reports reachability.

A wrong endpoint is not fatal. The messaging endpoint stays editable in the
[Teams Developer Portal](https://dev.teams.microsoft.com/apps). Only
`CLIENT_ID`, `TENANT_ID` and the secret are fixed once created, so repair by
pasting the correct URL rather than registering a second bot.

**A channel was deleted and recreated under a different name.** The derived
endpoint changed with it. Update the bot's messaging endpoint in the portal.

**The app will not install.** The sideloading policy has not propagated, or the
signed-in user is not the one it was assigned to. Check `teams status` rather
than guessing.

**The install link says "This app cannot be found."** Clicking the
**Install in Teams** link `teams app create` prints, right after creation, can
return this even though the app exists and is visible in the Developer Portal.
It reads like the create failed. It did not: re-running `teams app create` in
response leaves you with two bots.

Two workarounds. Use **Preview in Teams** from the
[Developer Portal](https://dev.teams.microsoft.com/apps) instead of the
printed link; it bypasses the catalog lookup that is failing. Or wait a short
while and regenerate the link:

```shell
teams app get <appId> --install-link
```

**The bot cannot get a token.** An `AADSTS` error means the app is multi-tenant.
`channel-reader` needs single-tenant; `teams app doctor` should report
`Sign-in audience: AzureADMyOrg`.

**File delivery does nothing.** `supportsFiles` was never actually saved. Re-run
the manifest update with `--yes` and verify by downloading the manifest.

**You lost the install link.**

```shell
teams app get <teamsAppId> --install-link
teams app list                              # every app with its id
```

**Messages arrive and are rejected.** `workflow-approval-request-reader` refuses
any medium absent from `WORKFLOW_APPROVAL_READER_ENABLED_MEDIA`. The shipped
manifests include `teams`, so this only bites a reader run by hand with the code
default of `telegram,slack`.

## See also

- [Connect Slack](./connect-slack.md), which has the same push architecture
- [Connect Telegram](./connect-telegram.md), which is polled instead
- [Configure approvals](./configure-approvals.md)
