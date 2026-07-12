# Quickstart

Run the evenfire **agent runtime** (`mcp-host`) locally with Docker Compose.
No Kubernetes required.

> **What you get:** a model-backed agent over HTTP (and optionally Telegram).  
> **What you do not get yet:** full platform features (NetworkPolicies, Control
> UI, multi-host fleet). For that, see [Minikube](../deploy/minikube.md).

## Prerequisites

- Docker and Docker Compose
- One LLM API key (OpenAI, Anthropic Claude, Z.AI, or Alibaba Bailian)

## 1. Configure

```bash
cp .env.quickstart.example .env.quickstart
# Edit .env.quickstart — set exactly ONE provider + key
```

Example (OpenAI):

```bash
CLERUM_MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

## 2. Start the runtime

```bash
docker compose --env-file .env.quickstart up mcp-host
```

Wait until the healthcheck is happy (container healthy), or:

```bash
curl -sS http://localhost:8080/v1/runtime/health
```

## 3. Send a message (felt success)

Use the helper script (it sets the edge trust headers for you):

```bash
./scripts/dev/quickstart-chat.sh "Hello! What can you help with?"
```

You should get a JSON response that includes the model’s reply (exact shape
depends on runtime version).

### Manual curl (advanced)

Dev mode authenticates callers with `x-clerum-edge-*` trust headers. In
production those headers are only sent by platform edge services and locked
down by NetworkPolicy.

```bash
curl -sS -X POST http://localhost:8080/v1/runtime/messages \
  -H "Content-Type: application/json" \
  -H "x-clerum-edge-caller: channel-reader" \
  -H "x-clerum-edge-host-ref: dev-host" \
  -H "x-clerum-edge-channel-type: telegram" \
  -H "x-clerum-edge-channel-id: dev-channel" \
  -H "x-clerum-edge-sender: 123456789" \
  -d '{"content":"Hello!","channelType":"telegram","channelId":"dev-channel","sender":"123456789","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","messageId":"msg-1","hostRef":"dev-host"}'
```

## 4. Optional: chat from Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Get your numeric Telegram user id (e.g. via `@userinfobot`).
3. Add to `.env.quickstart`:

```bash
CLERUM_TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
```

4. Run:

```bash
docker compose --env-file .env.quickstart --profile telegram up
```

5. Message your bot from the allowed account.

More detail: [Connect Telegram](../how-to/connect-telegram.md).

## Quickstart limitations

| Topic | Behavior |
| --- | --- |
| Auth | Dev trust headers only — not production JWT edge auth |
| MCP tools | None by default (LLM knowledge only). Set `CLERUM_MCP_SERVERS` — see `.env.quickstart.example` |
| Approvals | Full approval UX needs desktop/channel integration on the K8s stack |
| Networking | No default-deny NetworkPolicies in Compose |

## Next steps

| Goal | Doc |
| --- | --- |
| Wire a first MCP tool | [Add an MCP server](../how-to/add-mcp-server.md) |
| Run the full platform | [Minikube deploy](../deploy/minikube.md) |
| Understand governance | [Why evenfire](../concepts/why-evenfire.md) · [Security model](../../README.md#security-model) |
| Learning paths | [Learning path](learning-path.md) |
