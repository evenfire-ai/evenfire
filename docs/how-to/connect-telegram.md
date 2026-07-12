# How to: connect Telegram

Reach an evenfire agent from Telegram.

## Option A — Docker Compose quickstart

Best for a single-host smoke test without Kubernetes.

1. Complete the [Quickstart](../get-started/quickstart.md) so `mcp-host` runs.
2. Create a bot via [@BotFather](https://t.me/BotFather); copy the bot token.
3. Find your numeric Telegram **user id** (not username).
4. Set in `.env.quickstart`:

```bash
CLERUM_TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_USER_ID=<your-numeric-user-id>
```

5. Start with the telegram profile:

```bash
docker compose --env-file .env.quickstart --profile telegram up
```

6. Message the bot from the allowed user account.

`channel-reader` polls Telegram and forwards allowed senders to `mcp-host`.
Users not in `userIds` are dropped.

Compose wiring lives in root `docker-compose.yml` (`channel-reader` service).

## Option B — Full platform (Kubernetes)

On the cluster stack, Telegram is declared as a `CommunicationChannel` CRD
bound to a `Host`, with secrets for the bot token managed by the platform.

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
  hostRef: "chatllm"
  telegram:
    - channelId: "telegram-general"
      userIds: ["123456789"]   # allowed senders
```

## Approvals over Telegram

When approval policy enables Telegram approvers, approve/deny callbacks are
signature-checked and authorized before a decision is applied. See
[Configure approvals](configure-approvals.md).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot never replies | Token set? Profile `telegram` up? `mcp-host` healthy? |
| Your messages ignored | `TELEGRAM_ALLOWED_USER_ID` / CRD `userIds` match your numeric id |
| Works in Compose, not in K8s | Channel CRD `hostRef`, secrets, channel-reader logs, NetworkPolicies |

More FAQ: [FAQ](../faq.md).
