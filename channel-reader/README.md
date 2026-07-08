# Clerum Channel Reader

A Node.js/TypeScript application that fetches messages from Telegram, Email (IMAP), and Slack. `CommunicationChannel` config controls transport reachability and optional sender pre-filters. Workflow approval identity verification is a separate Profile UI flow and is enforced only by workflow approval/trigger handling.

## Modes

### Production Mode (default)

Watches CommunicationChannel CRDs in Kubernetes, filtered by `hostRef`. Auto-restarts when CRDs change.

### Dev Mode

Reads channel config from `CLERUM_CHANNEL` environment variable. No Kubernetes access required.

## How It Works

1. **Loads config**: From Kubernetes CRDs (production) or env var (dev mode)
2. **Extracts transport filters**: Gets optional `userIds` (Telegram), `emails` (Email), or `userNames` (Slack)
3. **Polls channels**: Connects to messaging platforms and fetches new messages
4. **Filters transport input**: Applies configured sender pre-filters before forwarding messages to the runtime
5. **Delegates workflow identity**: Workflow approval commands are authorized later through verified approval-medium accounts and workflow permissions

## Configuration

### Environment Variables

| Variable                             | Required  | Default    | Description                                                                                                                                                                                                                   |
| ------------------------------------ | --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_DEV_MODE`                    | No        | `false`    | Enable dev mode (read config from env var)                                                                                                                                                                                    |
| `CLERUM_CHANNEL`                     | Dev mode  | -          | Channel config JSON (dev mode only)                                                                                                                                                                                           |
| `CLERUM_HOST_REF`                    | Prod mode | -          | Filter CommunicationChannels by this `hostRef`                                                                                                                                                                                |
| `CLERUM_NAMESPACE`                   | No        | "" (all)   | Namespace to watch (production mode)                                                                                                                                                                                          |
| `CLERUM_TELEGRAM_BOT_TOKEN`          | No        | -          | Telegram Bot API token                                                                                                                                                                                                        |
| `CLERUM_SLACK_BOT_TOKEN`             | No        | -          | Slack Bot OAuth token (xoxb-...)                                                                                                                                                                                              |
| `CLERUM_EMAIL_IMAP_HOST`             | No        | -          | IMAP server host                                                                                                                                                                                                              |
| `CLERUM_EMAIL_IMAP_PORT`             | No        | `993`      | IMAP server port                                                                                                                                                                                                              |
| `CLERUM_EMAIL_USERNAME`              | No        | -          | IMAP username                                                                                                                                                                                                                 |
| `CLERUM_EMAIL_PASSWORD`              | No        | -          | IMAP password                                                                                                                                                                                                                 |
| `CLERUM_POLL_INTERVAL_SECONDS`       | No        | `2`        | Seconds between polling cycles. Telegram/Slack land in an in-memory queue near-instantly via their long-polling/websocket transports; pollCycle drains it. Raise this only if IMAP polling rate on the email channel matters. |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS` | No        | `true`     | Enable response attachment delivery. Set to `false` to disable non-workflow response attachments.                                                                                                                             |
| `CLERUM_ATTACHMENT_MAX_COUNT`        | No        | `3`        | Max attachments delivered per response                                                                                                                                                                                        |
| `CLERUM_ATTACHMENT_MAX_BYTES`        | No        | `52428800` | Max decoded bytes per attachment                                                                                                                                                                                              |

Attachment delivery behavior:

- Telegram: JPEG attachments are sent as photos. Workflow result documents and supported internal generated artifacts are sent as documents.
- Slack/Email: text reply is sent with an attachment-availability note.

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
  "email": {
    "channelId": "INBOX",
    "emails": ["user@example.com"]
  },
  "slack": {
    "channelId": "C01234567",
    "userNames": ["@john", "@jane"]
  }
}
```

## Production Mode (Kubernetes)

### Kubernetes API Access

The channel-reader needs `list` and `watch` permissions on `communicationchannels.clerum.io`:

```yaml
rules:
  - apiGroups: ['clerum.io']
    resources: ['communicationchannels']
    verbs: ['list', 'watch']
```

### Example CommunicationChannel CRD

```yaml
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: my-channels
spec:
  hostRef: chatllm # Must match CLERUM_HOST_REF
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
    - channelId: slack1
      userNames:
        - '@john'
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

### Production Mode (requires kubeconfig)

```bash
export CLERUM_HOST_REF="chatllm"
export CLERUM_TELEGRAM_BOT_TOKEN="your-token"
npm start
```

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

# Run in production mode (with kubeconfig mounted)
docker run --rm \
  -v ~/.kube:/home/node/.kube:ro \
  -e CLERUM_HOST_REF="chatllm" \
  -e CLERUM_TELEGRAM_BOT_TOKEN="your-token" \
  clerum/channel-reader:latest
```

## Deploy to Kubernetes

1. **Install CRDs first** (if not already):

```bash
helm install clerum-crds ../charts/clerum-crds
```

2. **Create namespace and RBAC**:

```bash
kubectl apply -f deploy/namespace.yaml
kubectl apply -f deploy/serviceaccount.yaml
kubectl apply -f deploy/rbac.yaml
```

3. **Configure settings** (edit `deploy/configmap.yaml` - set `CLERUM_HOST_REF`):

```bash
kubectl apply -f deploy/configmap.yaml
```

4. **Configure credentials** -- copy the example and fill in your tokens:

```bash
cp deploy/example.secret.yaml deploy/secret.yaml
```

Values under `data:` must be **base64-encoded**. Encode them like this:

```bash
# Encode a value
echo -n "your-telegram-bot-token" | base64

# Example
echo -n "<TELEGRAM_BOT_TOKEN>" | base64
# Output: <BASE64_TELEGRAM_BOT_TOKEN>
```

Then paste the encoded value into `deploy/secret.yaml`:

```yaml
data:
  telegram-bot-token: <BASE64_TELEGRAM_BOT_TOKEN>
```

Alternatively, use `stringData:` instead of `data:` to provide plain-text values -- Kubernetes will encode them automatically:

```yaml
stringData:
  telegram-bot-token: '<TELEGRAM_BOT_TOKEN>'
```

Apply the secret:

```bash
kubectl apply -f deploy/secret.yaml
```

5. **Deploy**:

```bash
kubectl apply -f deploy/deployment.yaml
```

6. **Create a CommunicationChannel CRD** (with matching `hostRef`):

```bash
kubectl apply -f ../examples/channels.yaml
```

7. **Check logs**:

```bash
kubectl logs -n clerum-system -l app.kubernetes.io/name=channel-reader -f
```

## Project Structure

```
channel-reader/
├── src/
│   ├── main.ts           # Entry point, polling loop, dev/prod mode
│   ├── config.ts         # Environment configuration
│   ├── types.ts          # Shared TypeScript types
│   ├── k8sClient.ts      # Kubernetes CRD watcher (production mode)
│   └── channels/
│       ├── index.ts      # Channel adapter exports
│       ├── base.ts       # Shared utilities
│       ├── telegram.ts   # Telegram adapter (grammY)
│       ├── email.ts      # Email adapter (ImapFlow)
│       └── slack.ts      # Slack adapter (@slack/web-api)
├── deploy/
│   ├── namespace.yaml
│   ├── serviceaccount.yaml
│   ├── rbac.yaml         # ClusterRole with list/watch permissions
│   ├── configmap.yaml    # Settings including CLERUM_HOST_REF
│   ├── example.secret.yaml  # API tokens template (copy to secret.yaml)
│   └── deployment.yaml
├── Dockerfile
├── package.json
└── tsconfig.json
```
