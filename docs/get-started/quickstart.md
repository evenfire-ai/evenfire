# Quickstart — the full platform on minikube

Stand up the complete evenfire platform on a local Kubernetes cluster: all
services, deny-all NetworkPolicies, the JWT auth chain, and a seeded agent
named `chatllm` you can message immediately.

> **What you get:** the real platform — operators, approvals, Control UI,
> desktop app, network isolation. Nothing is mocked or weakened.
> **Time:** roughly 15 minutes on a cold cache (pulling images dominates).

## Prerequisites

- **Docker Desktop** running, with **≥10 GB RAM and 6 CPUs** allocated
  (the cluster is started with `--memory=10240 --cpus=6` and Calico CNI)
- **minikube** v1.30+ (`brew install minikube`)
- **kubectl**
- **python3** (used by the JWT key sync)
- **Node.js 24+** (service builds; desktop app)
- **git**, **make**, and **ruby** (ruby renders the control-api DB migration
  overlay; ships with macOS, `apt-get install ruby` on Debian/Ubuntu)
- One LLM API key from any of the 22 supported providers (e.g. OpenAI,
  Anthropic Claude, Google Gemini, Groq, Mistral, Z.AI, Alibaba Bailian) —
  optional for setup (it boots with placeholders), but the agent can't call a
  model without one. Full list: [../deploy/llm-providers.md](../deploy/llm-providers.md)

## 1. Configure

```bash
git clone https://github.com/evenfire-ai/evenfire.git && cd evenfire
cp .env.example .env
```

Edit `.env` and set the platform password — one value for both the Control UI
`admin` login and the seeded Desktop App user. No default ships; setup aborts
in Step 1 without it:

```bash
ADMIN_PASSWORD=<choose-a-password>
```

Then set **one** LLM key (setup infers the matching provider):

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
MINIKUBE_IMAGE_TAG=latest make minikube-setup   # see the override note below
```

This runs an idempotent 12-step setup: minikube cluster (Calico) → namespaces →
CRDs → JWT signing keys → secrets from `.env` → service images pulled from
`ghcr.io/evenfire-ai` → deploy → readiness wait with auto-recovery → seed →
verify.

**You do not build images.** The 23 service images are published for
`linux/amd64` and `linux/arm64`, so an Apple Silicon Mac pulls a native image
instead of compiling anything. MCP servers are not loaded into the cluster at
all — they are installed on demand from the evenfire registry.

`MINIKUBE_IMAGE_TAG=latest` is required today. The cluster manifests pin the
next release tag, whose images are created by promotion _on_ that tag, so the
pin currently names something that does not exist yet. Without the override the
pull fails with a message naming the image, the tag, and this variable. Drop the
override once that release is tagged and promoted.

To build every image from source instead, use `make minikube-setup-local`
(equivalently `IMAGE_SOURCE=local`). That path needs no tag override.

It seeds for you:

- an agent: Host `chatllm` + an empty Context `context1` (no MCP servers —
  install connectors from the registry) + a CommunicationChannel
- one account, using the `ADMIN_PASSWORD` you set in `.env`: username
  **`admin`** for the Control UI and email **`admin@evenfire.local`** for the
  Desktop App — the same account, and the sole Desktop App member

Verify:

```bash
make minikube-status    # every deployment should show READY
```

Useful re-runs: `make minikube-setup ARGS="--skip-build"` (redeploy in ~1 min) ·
`ARGS="--reset-db"` (fix postgres after a cold-start crash) ·
`ARGS="--force-keys"` (regenerate the JWT chain) ·
`ARGS="--seed-profile=e2e"` or `make minikube-setup-e2e` (adds the E2E fixture
set: test user, `e2e-*` recipes, demo MCP servers).

## 3. Say hello — desktop app

```bash
make install-all && npm --prefix control-ui install
npm run ui     # runs Control UI (:3000), Profile UI (:3001), and the Desktop App
```

Log into the **Desktop App** as `admin@evenfire.local` using the
`ADMIN_PASSWORD` you set in `.env`, and message the `chatllm` agent. Ask it to
do something real — _"run `uname -a`"_ or
_"generate a one-page PDF about Kubernetes NetworkPolicies"_ — and approve the
tool call right in the chat when the approval gate fires. For what else is on
screen — live activity, artifacts, sandbox UIs — see
[Desktop App](../surfaces/desktop-app.md).

## 4. Say hello — the API

The headless path exercises the production JWT chain end to end. With
`make minikube-pf-all` holding port-forwards in another terminal
(control-api :8090, external-rest-api :8091, rpc-proxy :8094, mcp-host :8080)
on the shared `clerum-test` profile. For a branch-owned profile, first-hand
entry point (gitignored helper at repo root — do not search for it):

```bash
MINIKUBE_PROFILE=<owned-profile> \
  make -f .local-notes/minikube-profiles/branch.mk branch-profile-pf

MINIKUBE_PROFILE=<owned-profile> \
  make -f .local-notes/minikube-profiles/branch.mk branch-profile-health
```

Implementation: `.local-notes/minikube-profiles/branch-profile.sh`.
HARD DENY: do not `ls`/`cat` `~/.cache/clerum/minikube-profiles/`.
This is the host-side hold for Control UI / Desktop. Profile-owned random
ports only (never shared `:3000`/`:8090`). `make minikube-pf-all-bg` is a
gate refresh only; it must not replace `branch-profile-pf`. Do not start UI
PFs from a sandboxed agent shell. Run the make target on the host. Do not
kill this lane's `branch-profile-pf`. `branch-profile-pf-health` starts PFs
then STOPS them on EXIT — do not use it as the lasting hold.

Shared-profile curl example (fixed ports):

```bash
EXT=http://localhost:8091  RPC=http://localhost:8094  HOST=chatllm

# 1. password login → session token
SESSION=$(curl -s -X POST "$EXT/api/v1/auth/password-login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"<seeded-email>","password":"<your ADMIN_PASSWORD>"}' | jq -r .token)

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

| Symptom                                    | Fix                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent never replies                        | No real LLM key in `.env`; with several keys, set `CLERUM_MODEL_PROVIDER` explicitly (see step 1)                                                                                                              |
| `minikube start` fails on memory           | Raise Docker Desktop to ≥10 GB RAM / 6 CPUs — or, if you can't spare it, `MINIKUBE_MEMORY=9216 MINIKUBE_IMAGE_TAG=latest make minikube-setup` (stock Docker Desktop's ~9.9 GB is just under the 10 GB default) |
| Pods `Pending` early on                    | Calico is still coming up — wait, then `make minikube-status`                                                                                                                                                  |
| postgres CrashLoopBackOff after cold start | `make minikube-setup ARGS="--reset-db --skip-build"`                                                                                                                                                           |
| Port-forwards die                          | Shared profile: re-run `make minikube-pf-all` (it holds them open; Ctrl-C stops). Branch-owned profile: `MINIKUBE_PROFILE=<owned-profile> make -f .local-notes/minikube-profiles/branch.mk branch-profile-pf` (do not use `branch-profile-pf-health` as the lasting hold; do not replace it with `make minikube-pf-all-bg`) |

## Next steps

| Goal                           | Doc                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Wire an MCP connector          | [Add an MCP server](../how-to/add-mcp-server.md)                                               |
| Connect to the shared registry | [Connect to the registry](../how-to/connect-to-registry.md)                                    |
| Tune the approval gates        | [Configure approvals](../how-to/configure-approvals.md)                                        |
| Understand the design          | [Why evenfire](../concepts/why-evenfire.md) · [Security model](../../README.md#security-model) |
| Deep deployment reference      | [Minikube guide](../deploy/minikube.md) · [Production notes](../deploy/production.md)          |
| Tour the other UIs             | [Surfaces index](../surfaces/README.md)                                                        |
| Learning paths                 | [Learning path](learning-path.md)                                                              |
