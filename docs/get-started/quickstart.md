# Quickstart — the full platform on minikube

Stand up the complete evenfire platform on a local Kubernetes cluster: all
services, deny-all NetworkPolicies, the JWT auth chain, and a seeded agent
named `chatllm` you can message immediately.

> **What you get:** the real platform — operators, approvals, Control UI,
> desktop app, network isolation. Nothing is mocked or weakened.
> **Time:** ~5–10 minutes on first run (image builds dominate).

## Prerequisites

- **Docker Desktop** running, with **≥10 GB RAM and 6 CPUs** allocated
  (the cluster is started with `--memory=10240 --cpus=6` and Calico CNI)
- **minikube** v1.30+ (`brew install minikube`)
- **kubectl**
- **python3** (used by the JWT key sync)
- **Node.js 24+** (service builds; desktop app)
- One LLM API key: OpenAI, Anthropic Claude, Z.AI, or Alibaba Bailian

## 1. Configure

```bash
git clone https://github.com/evenfire-ai/evenfire.git && cd evenfire
cp .env.example .env
```

Edit `.env` and set **one** key (setup infers the matching provider):

```bash
OPENAI_API_KEY=sk-...
CLERUM_MODEL_PROVIDER=openai     # optional with one key: openai | claude | zai | bailian
# CLERUM_MODEL_NAME=gpt-5.4-mini # optional model override (default follows the provider)
```

> ⚠️ **Provider selection:** with exactly **one** API key set, setup auto-infers
> `CLERUM_MODEL_PROVIDER` and logs the choice. With multiple keys, set it
> explicitly — setup fails with a clear error naming the keys instead of
> guessing. With no key at all, the seeded agent gets placeholder credentials
> and will not reply.

## 2. Set up the cluster (one command)

```bash
make minikube-setup
```

This runs an idempotent 12-step setup: minikube cluster (Calico) → namespaces →
CRDs → JWT signing keys → secrets from `.env` → service images built in
minikube's Docker → deploy → readiness wait with auto-recovery → seed → verify.

It seeds for you:

> Seeded credentials below are for local minikube only — change them before any shared or production-like environment.

- an agent: Host `chatllm` + Context `context1` + a CommunicationChannel
- a desktop/API login: **`test@clerum.io` / `changeme123!`**
- a Control UI admin: **`admin` / `changeme123!`**

Verify:

```bash
make minikube-status    # every deployment should show READY
```

Useful re-runs: `make minikube-setup ARGS="--skip-build"` (redeploy in ~1 min) ·
`ARGS="--reset-db"` (fix postgres after a cold-start crash) ·
`ARGS="--force-keys"` (regenerate the JWT chain).

## 3. Say hello — desktop app

```bash
make install-all && npm --prefix control-ui install
npm run ui     # runs Control UI (:3000), Profile UI (:3001), and the Desktop App
```

Log into the **Desktop App** as `test@clerum.io` / `changeme123!` and message
the `chatllm` agent. Ask it to do something real — _"run `uname -a`"_ or
_"generate a one-page PDF about Kubernetes NetworkPolicies"_ — and approve the
tool call right in the chat when the approval gate fires. For what else is on
screen — live activity, artifacts, sandbox UIs — see
[Desktop App](../surfaces/desktop-app.md).

## 4. Say hello — the API

The headless path exercises the production JWT chain end to end. With
`make minikube-pf-all` holding port-forwards in another terminal
(control-api :8090, external-rest-api :8091, rpc-proxy :8094, mcp-host :8080):

```bash
EXT=http://localhost:8091  RPC=http://localhost:8094  HOST=chatllm

# 1. password login → session token
SESSION=$(curl -s -X POST "$EXT/api/v1/auth/password-login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@clerum.io","password":"changeme123!"}' | jq -r .token)

# 2. exchange for a short-lived RPC token scoped to this host
RPC_TOKEN=$(curl -s -X POST "$EXT/api/v1/rpc/token" \
  -H "Authorization: Bearer $SESSION" -H 'Content-Type: application/json' \
  -d '{"hostRefs":["chatllm"],"scopes":["host:message:invoke","host:task:read","host:approval:write"]}' \
  | jq -r .token)

# 3. send a message (async → taskId)
TASK=$(curl -s -X POST "$RPC/api/v1/rpc/hosts/$HOST/messages?async=true" \
  -H "Authorization: Bearer $RPC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"Hello! Reply with a one-sentence greeting."}' | jq -r .taskId)

# 4. poll the result
curl -s "$RPC/api/v1/rpc/hosts/$HOST/tasks/$TASK/result" \
  -H "Authorization: Bearer $RPC_TOKEN" | jq '{status, response}'
# → { "status": "completed", "response": "…" }
```

### Approve a tool call over the API

A plain hello completes directly. If the agent decides it needs an
approval-gated tool, the result poll returns `status: "awaiting_approval"`
with `approval.requestId` — approve it and re-poll:

```bash
# pull the pending approval id out of the result poll
REQUEST_ID=$(curl -s "$RPC/api/v1/rpc/hosts/$HOST/tasks/$TASK/result" \
  -H "Authorization: Bearer $RPC_TOKEN" | jq -r '.approval.requestId')

curl -s -X POST "$RPC/api/v1/rpc/hosts/$HOST/approvals/approve" \
  -H "Authorization: Bearer $RPC_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"toolCallId\":\"$REQUEST_ID\"}"
```

## 5. Optional: chat from Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather); get your numeric
   user id (e.g. via `@userinfobot`).
2. Set `CLERUM_TELEGRAM_BOT_TOKEN` and `CLERUM_TELEGRAM_USER_ID` in `.env`.
3. Re-run `make minikube-setup ARGS="--skip-build"` and message your bot.

Approval requests arrive on Telegram with inline **Approve / Deny** buttons.
Details: [Connect Telegram](../how-to/connect-telegram.md).

## Troubleshooting

| Symptom                                    | Fix                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Agent never replies                        | No real LLM key in `.env`; with several keys, set `CLERUM_MODEL_PROVIDER` explicitly (see step 1) |
| `minikube start` fails                     | Docker Desktop has less than 10 GB RAM / 6 CPUs allocated                                         |
| Pods `Pending` early on                    | Calico is still coming up — wait, then `make minikube-status`                                     |
| postgres CrashLoopBackOff after cold start | `make minikube-setup ARGS="--reset-db --skip-build"`                                              |
| Port-forwards die                          | re-run `make minikube-pf-all` (it holds them open; Ctrl-C stops)                                  |

## Next steps

| Goal                      | Doc                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Wire an MCP connector     | [Add an MCP server](../how-to/add-mcp-server.md)                                               |
| Tune the approval gates   | [Configure approvals](../how-to/configure-approvals.md)                                        |
| Understand the design     | [Why evenfire](../concepts/why-evenfire.md) · [Security model](../../README.md#security-model) |
| Deep deployment reference | [Minikube guide](../deploy/minikube.md) · [Production notes](../deploy/production.md)          |
| Tour the other UIs        | [Surfaces index](../surfaces/README.md)                                                        |
| Learning paths            | [Learning path](learning-path.md)                                                              |
