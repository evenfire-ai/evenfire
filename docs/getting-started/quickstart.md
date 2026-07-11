---
title: Quickstart
description: Run a local evenfire LLM agent with Docker Compose in under five minutes — no Kubernetes required.
---

# Quickstart

No Kubernetes required. The quickstart runs `mcp-host` in dev mode — a local
LLM agent you can chat with over HTTP.

## 1. Configure an LLM API key

```bash
cp .env.quickstart.example .env.quickstart   # add ONE LLM API key
```

Any one of the supported providers works — see [LLM Providers](../reference/llm-providers.md)
for the full list (OpenAI, Claude, ZAI, Bailian).

## 2. Start the agent

```bash
docker compose --env-file .env.quickstart up mcp-host
```

## 3. Send a message

```bash
curl -X POST http://localhost:8080/v1/runtime/messages \
  -H "Content-Type: application/json" \
  -H "x-clerum-edge-caller: channel-reader" \
  -H "x-clerum-edge-host-ref: dev-host" \
  -H "x-clerum-edge-channel-type: telegram" \
  -H "x-clerum-edge-channel-id: dev-channel" \
  -H "x-clerum-edge-sender: 123456789" \
  -d '{"content":"Hello!","channelType":"telegram","channelId":"dev-channel","sender":"123456789","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","messageId":"msg-1","hostRef":"dev-host"}'
```

## Optional: Telegram surface

To connect a real Telegram bot, add `CLERUM_TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_USER_ID` to `.env.quickstart`, then run:

```bash
docker compose --env-file .env.quickstart --profile telegram up
```

## Quickstart status and limitations

- `mcp-host` build and boot verified; health endpoint and message routing confirmed.
- The message endpoint requires the internal `x-clerum-edge-*` headers shown above
  (no JWT — these are trust headers sent by the channel-reader sidecar in production).
- `channel-reader` is in the `telegram` profile; requires a real Telegram bot token.
- No MCP servers are wired by default (agent replies using its LLM knowledge only).
  To add MCP tools, set `CLERUM_MCP_SERVERS` as a JSON array (see `.env.quickstart.example`).

## Next steps

- [Installation](installation.md) — install the CRDs and run the full platform on Kubernetes.
- [Architecture overview](../architecture/overview.md) — how the services fit together.
- [CRD reference](../crds/README.md) — configure Hosts, Contexts, MCP servers, and channels.
