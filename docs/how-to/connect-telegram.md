# How to: connect Telegram

Reach an evenfire agent from Telegram.

## On minikube (quickstart stack)

1. Complete the [Quickstart](../get-started/quickstart.md) so the platform runs.
2. Create a bot via [@BotFather](https://t.me/BotFather); copy the bot token.
3. Find your numeric Telegram **user id** (not username), e.g. via `@userinfobot`.
4. Set in `.env`:

```bash
CLERUM_TELEGRAM_BOT_TOKEN=<bot-token>
CLERUM_TELEGRAM_USER_ID=<your-numeric-user-id>
```

5. Re-apply secrets and redeploy:

```bash
make minikube-setup ARGS="--skip-build"
```

6. Message the bot from the allowed user account.

`channel-reader` polls Telegram and forwards allowed senders to `mcp-host`.
Users not in the allowlist are dropped.

## Any cluster (CRD path)

Telegram is declared as a `CommunicationChannel` CRD bound to a `Host`, with
the bot token in a platform-managed Secret.

1. Deploy the stack ([Minikube guide](../deploy/minikube.md) for local).
2. Create or edit a `CommunicationChannel` (see
   [CRD reference](../crds/communicationchannel.md) and
   [examples](../../charts/clerum-crds/examples/channels.yaml)).
3. Point `Host.spec.channels` at that channel.
4. Store the bot token in the Secret / channel credentials path your overlay
   expects (see service README for `channel-reader`).

Example shape:

```yaml
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: all-channels
spec:
  hostRef: 'chatllm'
  telegram:
    - channelId: 'telegram-general'
      userIds: ['123456789'] # allowed senders
```

## Approvals over Telegram

When approval policy enables Telegram approvers, approval requests arrive with
inline **Approve / Deny** buttons (or reply `/approve <target>`); callbacks are
signature-checked and authorized before a decision is applied. See
[Configure approvals](configure-approvals.md).

## Troubleshooting

| Symptom                        | Check                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- |
| Bot never replies              | Token set in `.env`? channel-reader deployed and READY? `mcp-host` healthy? |
| Your messages ignored          | `CLERUM_TELEGRAM_USER_ID` / CRD `userIds` match your numeric id             |
| Channel looks wired but silent | Channel CRD `hostRef`, secrets, channel-reader logs, NetworkPolicies        |

More FAQ: [FAQ](../faq.md).
