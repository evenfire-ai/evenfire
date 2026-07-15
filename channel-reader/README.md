# Clerum Channel Reader

A Node.js/TypeScript application that fetches messages from Telegram, Email (IMAP), and Slack. `CommunicationChannel` config controls transport reachability and optional sender pre-filters. Workflow approval identity verification is a separate Profile UI flow and is enforced only by workflow approval/trigger handling.

## Modes

### Production Mode (default)

Watches CommunicationChannel CRDs in Kubernetes, filtered by `hostRef`. Auto-restarts when CRDs change.

### Dev Mode

Reads channel config from `CLERUM_CHANNEL` environment variable. No Kubernetes access required.

## How It Works

1. **Loads config**: From Kubernetes CRDs (production) or env var (dev mode)
2. **Extracts transport filters**: Telegram `userIds` are an optional legacy pre-filter; Email requires `emails` on every group; Slack requires either `userIds` + `workspaceId` (stable identity — the only form usable for workflow approval decisions) or legacy `userNames`. The CRD enforces this (`required`/`anyOf`) and `channelConfigValidation.ts` re-checks it at load
3. **Polls channels**: Connects to messaging platforms and fetches new messages
4. **Filters transport input**: Applies configured sender pre-filters before forwarding messages to the runtime
5. **Delegates workflow identity**: Workflow approval commands are authorized later through verified approval-medium accounts and workflow permissions

## Configuration

### Environment Variables

| Variable                             | Required  | Default                                | Description                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_DEV_MODE`                    | No        | `false`                                | Enable dev mode (read config from env var)                                                                                                                                                                                                                                 |
| `CLERUM_CHANNEL`                     | Dev mode  | -                                      | Channel config JSON (dev mode only)                                                                                                                                                                                                                                        |
| `CLERUM_HOST_REF`                    | Prod mode | -                                      | Filter CommunicationChannels by this `hostRef`                                                                                                                                                                                                                             |
| `CLERUM_NAMESPACE`                   | No        | "" (all)                               | Namespace to watch (production mode)                                                                                                                                                                                                                                       |
| `CLERUM_TELEGRAM_BOT_TOKEN`          | Dev mode  | -                                      | Telegram Bot API token. **Dev mode only** — production reads it from `spec.credentialsSecretRef` (key `telegram-bot-token`).                                                                                                                                               |
| `CLERUM_SLACK_BOT_TOKEN`             | Dev mode  | -                                      | Slack Bot OAuth token (xoxb-...). **Dev mode only** — production reads it from `spec.credentialsSecretRef` (key `slack-bot-token`).                                                                                                                                        |
| `CLERUM_EMAIL_IMAP_HOST`             | No        | -                                      | IMAP server host                                                                                                                                                                                                                                                           |
| `CLERUM_EMAIL_IMAP_PORT`             | No        | `993`                                  | IMAP server port                                                                                                                                                                                                                                                           |
| `CLERUM_EMAIL_SMTP_HOST`             | No        | falls back to `CLERUM_EMAIL_IMAP_HOST` | SMTP host for the **send** path. Set this when your outbound host differs from IMAP.                                                                                                                                                                                       |
| `CLERUM_EMAIL_SMTP_PORT`             | No        | `587`                                  | SMTP server port (send path)                                                                                                                                                                                                                                               |
| `CLERUM_EMAIL_USERNAME`              | Dev mode  | -                                      | IMAP username. **Dev mode only** — production reads it from `spec.credentialsSecretRef` (key `email-username`).                                                                                                                                                            |
| `CLERUM_EMAIL_PASSWORD`              | Dev mode  | -                                      | IMAP password. **Dev mode only** — production reads it from `spec.credentialsSecretRef` (key `email-password`).                                                                                                                                                            |
| `CLERUM_POLL_INTERVAL_SECONDS`       | No        | `2`                                    | Seconds between polling cycles. Telegram messages land in an in-memory queue via grammY long-polling and `pollCycle` only drains it. Slack and Email are fetched _during_ the cycle (Slack `conversations.history`, IMAP), so this interval bounds their delivery latency. |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS` | No        | `true`                                 | Enable response attachment delivery. Set to `false` to disable non-workflow response attachments.                                                                                                                                                                          |
| `CLERUM_ATTACHMENT_MAX_COUNT`        | No        | `3`                                    | Max attachments delivered per response                                                                                                                                                                                                                                     |
| `CLERUM_ATTACHMENT_MAX_BYTES`        | No        | `52428800`                             | Max decoded bytes per attachment                                                                                                                                                                                                                                           |

Attachment delivery behavior:

- Telegram: JPEG attachments are sent as photos. Workflow result documents and supported internal generated artifacts are sent as documents.
- Slack: workflow result documents and supported internal generated artifacts are uploaded as real files (`files.uploadV2`). Any attachment outside those two categories is not delivered; the text reply then carries a note counting the undeliverable attachments.
- Email: the text reply is sent with an attachment-availability note; no attachment is delivered.

## Dev Mode

For local development without Kubernetes, use dev mode:

```bash
export CLERUM_DEV_MODE=true
export CLERUM_CHANNEL='{
  "hostRef": "chatllm",
  "telegram": [
    {
      "channelId": "telegram1",
      "chatType": "private",
      "userIds": ["123456789"]
    }
  ]
}'
export CLERUM_TELEGRAM_BOT_TOKEN="your-token"

npm start
```

The `CLERUM_CHANNEL` JSON matches the CommunicationChannel CRD spec:

```json
{
  "hostRef": "chatllm",
  "telegram": [
    {
      "channelId": "telegram1",
      "chatType": "private",
      "userIds": ["123456789", "987654321"]
    }
  ],
  "email": [
    {
      "channelId": "INBOX",
      "emails": ["user@example.com"]
    }
  ],
  "slack": [
    {
      "channelId": "C01234567",
      "workspaceId": "T01234567",
      "userIds": ["U01234567", "U07654321"]
    }
  ]
}
```

Slack groups must supply either `userIds` + `workspaceId` or the legacy `userNames`. Only the `userIds` + `workspaceId` form is a valid workflow-approval identity; `userNames` is a legacy chat-only allowlist. When `userIds` are set, `channelId` must be a stable Slack channel ID (`C…`, `D…`, or `G…`) and `workspaceId` a team ID (`T…`).

## Production Mode (Kubernetes)

### Kubernetes API Access

The channel-reader needs cluster-wide `list` and `watch` on `communicationchannels.clerum.io` (via a ClusterRole — the CRD itself is namespaced, and `CLERUM_NAMESPACE=""` means watch all namespaces), plus `get` on Secrets in the `channels` namespace — at adapter init it reads `spec.credentialsSecretRef` through the Kubernetes API to resolve the bot tokens:

```yaml
# ClusterRole
rules:
  - apiGroups: ['clerum.io']
    resources: ['communicationchannels']
    verbs: ['list', 'watch']
---
# Role in the `channels` namespace
rules:
  - apiGroups: ['']
    resources: ['secrets']
    verbs: ['get']
```

Both are shipped in `deploy/base/cluster-wide/clusterroles.yaml` and `deploy/base/channels/rbac.yaml`.

### Example CommunicationChannel CRD

```yaml
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: my-channels
spec:
  hostRef: chatllm # Must match CLERUM_HOST_REF
  # In production mode, credentials are read ONLY from this Secret (in the
  # `channels` namespace). The CLERUM_*_TOKEN env vars are dev-mode only.
  credentialsSecretRef:
    name: my-channels-credentials
  telegram:
    - channelId: telegram1
      chatType: private
      userIds:
        - '123456789'
  email:
    - channelId: INBOX
      emails:
        - user@example.com
  slack:
    - channelId: C01234567 # stable channel ID required when userIds are set
      workspaceId: T01234567
      userIds:
        - U01234567
```

When you create, update, or delete this CRD, the channel-reader automatically detects the change and restarts.

## Local Development

### Dev Mode (recommended for local)

```bash
npm install
npm run build

export CLERUM_DEV_MODE=true
export CLERUM_CHANNEL='{"hostRef":"dev","telegram":[{"channelId":"test","chatType":"private","userIds":["123"]}]}'
export CLERUM_TELEGRAM_BOT_TOKEN="your-token"
npm start
```

### Production Mode

The CRD watcher tries `loadFromCluster()` first and falls back to `loadFromDefault()` (`src/k8sClient.ts`), so production mode can also run off-cluster against whatever `~/.kube` context is current — the ServiceAccount token is used only when the process runs as a pod. Credentials are resolved exclusively from the Secret named by `CommunicationChannel.spec.credentialsSecretRef.name` in the `channels` namespace; the `CLERUM_TELEGRAM_BOT_TOKEN` / `CLERUM_SLACK_BOT_TOKEN` / `CLERUM_EMAIL_USERNAME` / `CLERUM_EMAIL_PASSWORD` env vars are read by the dev-mode resolver only and are ignored in production. Running it locally therefore requires a kubeconfig whose user can read the CommunicationChannels and the credentials Secret.

```bash
# Uses the in-cluster ServiceAccount when run as a pod, otherwise the current kubeconfig context.
export CLERUM_HOST_REF="chatllm"
npm start
```

For local iteration, use dev mode above.

## Docker

```bash
# Build image
docker build -t clerum/channel-reader:latest .

# Run in dev mode
docker run --rm \
  -e CLERUM_DEV_MODE=true \
  -e CLERUM_CHANNEL='{"hostRef":"dev","telegram":[{"channelId":"test","chatType":"private","userIds":["123"]}]}' \
  -e CLERUM_TELEGRAM_BOT_TOKEN="your-token" \
  clerum/channel-reader:latest
```

Production mode inside a container needs Kubernetes credentials: as a pod it picks up the mounted ServiceAccount token, and any other runtime must have a kubeconfig mounted for the `loadFromDefault()` fallback to find. In the cluster, host-context-controller creates the per-Host `channel-reader-<host>` Deployment for you — see below.

## Deploy to Kubernetes

There is no standalone channel-reader Deployment to apply. The legacy static Deployment was retired in favor of **per-Host `channel-reader-<host>` Deployments created by host-context-controller** (HCC) from the `Host` CR. The only static pieces are the `clerum-channel-reader` ServiceAccount and the `clerum-channel-reader-config` ConfigMap, which the per-Host pods reference — both live in `deploy/base/channels/` in the `channels` namespace and ship with the platform deploy.

1. **Install CRDs** (if not already), from the repo root:

```bash
helm install clerum-crds charts/clerum-crds
```

2. **Deploy the platform** (namespaces, RBAC, ServiceAccount, ConfigMap, HCC), from the repo root:

```bash
kubectl apply -k deploy/overlays/minikube   # or your own overlay
```

3. **Create the credentials Secret** in the `channels` namespace, holding the keys channel-reader reads (`telegram-bot-token`, `slack-bot-token`, `email-username`, `email-password`), then reference it from the CommunicationChannel via `spec.credentialsSecretRef.name`.

4. **Create a CommunicationChannel** with a `hostRef` matching an existing `Host` (see the example above). HCC reconciles the per-Host channel-reader Deployment; the reader picks up the CRD and restarts on change.

5. **Check logs**:

```bash
# `app=channel-reader` matches every per-Host reader; app.kubernetes.io/name
# is the per-Host value `channel-reader-<host>`.
kubectl logs -n channels -l app=channel-reader -f
```

## Project Structure

```
channel-reader/
├── src/
│   ├── main.ts                    # Entry point, polling loop, dev/prod mode
│   ├── config.ts                  # Environment configuration
│   ├── types.ts                   # Shared TypeScript types
│   ├── k8sClient.ts               # Kubernetes CRD watcher (production mode)
│   ├── credentials.ts             # Secret-backed + dev-mode credential resolvers
│   ├── channelConfigValidation.ts # CommunicationChannel spec validation
│   ├── handoffServer.ts           # Inbound handoff HTTP listener
│   ├── rpcClient.ts               # mcp-host runtime client
│   ├── progressClient.ts          # Task progress streaming
│   ├── progressFormatter.ts       # Progress rendering
│   ├── notificationDeliveryClient.ts
│   ├── telegramCallbackData.ts    # Telegram callback payload codec
│   ├── workflowApproval*.ts       # Workflow approval coordination/decisions
│   └── channels/
│       ├── index.ts               # Channel adapter exports
│       ├── base.ts                # Shared utilities
│       ├── telegram.ts            # Telegram adapter (grammY)
│       ├── email.ts               # Email adapter (ImapFlow)
│       ├── slack.ts               # Slack adapter (@slack/web-api)
│       ├── slackVerification.ts
│       ├── telegramDelivery.ts
│       ├── telegramOperationalMessage.ts
│       ├── telegramProviderTarget.ts
│       └── telegramVerification.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```

Kubernetes manifests are not vendored here — the static ServiceAccount/ConfigMap and RBAC live in `deploy/base/channels/`, and the per-Host Deployment is generated by host-context-controller.
