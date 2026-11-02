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
- **Node.js 24.22.1 or later** (use the Node 24 version pinned in `.nvmrc` for Desktop and the validation harness)
- **git**, **make**, and **ruby** (ruby renders the control-api DB migration
  overlay; ships with macOS, `apt-get install ruby` on Debian/Ubuntu)
- One LLM API key. Setup picks the agent's provider automatically from
  `OPENAI_API_KEY`, `CLAUDE_API_KEY`, `ZAI_API_KEY` or `BAILIAN_API_KEY`
  (first one set wins). For any other supported provider (Gemini, Groq,
  Mistral, … see [the full list](../llm-providers/README.md)) put its key in
  `.env` **and** set `CLERUM_MODEL_PROVIDER` and `CLERUM_MODEL_NAME`. The pair
  must be enabled in the model allowlist, or setup stops with
  `HOST_MODEL_UNKNOWN` (pair not in the allowlist) or `HOST_MODEL_DISABLED`
  (pair listed but disabled). Setup only writes the four keys above to the cluster,
  so after `make minikube-setup` run `make minikube-apply-secrets` and then
  `kubectl rollout restart deployment/chatllm -n mcp-host --context clerum-test`.
  Without any key, setup still boots, but the agent can't reply until you add
  one.

Run `make prereqs` (alias `make doctor`) to check all of these at once. It
prints the install command for anything missing and flags a `.env` without
`ADMIN_PASSWORD` or an LLM key. `make minikube-setup` runs it first (skip with
`SKIP_PREREQS=true`).

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
# CLERUM_MODEL_NAME=gpt-5.4-mini # optional override; only with CLERUM_MODEL_PROVIDER
```

> ⚠️ **Provider selection:** without `CLERUM_MODEL_PROVIDER`, setup takes the
> first key present in the order `OPENAI_API_KEY`, `CLAUDE_API_KEY`,
> `ZAI_API_KEY`, `BAILIAN_API_KEY`, uses that provider's default model, and logs
> the choice. With several keys the first one in that order wins, so set
> `CLERUM_MODEL_PROVIDER` when you want another. `CLERUM_MODEL_NAME` without
> `CLERUM_MODEL_PROVIDER` stops setup with an error naming both, and so does a
> pair that is not enabled in the model allowlist. With no key at all, the
> seeded agent gets `openai/gpt-5.4-mini` with placeholder credentials and will
> not reply.

## 2. Set up the cluster (one command)

```bash
make minikube-setup
```

This runs an idempotent 12-step setup: minikube cluster (Calico) → namespaces →
CRDs → JWT signing keys → secrets from `.env` → service images pulled from
`ghcr.io/evenfire-ai` → deploy → readiness wait with auto-recovery → seed →
verify.

**You do not build images.** The 25 service images are published for
`linux/amd64` and `linux/arm64`, so an Apple Silicon Mac pulls a native image
instead of compiling anything. MCP servers are not loaded into the cluster at
all — they are installed on demand from the evenfire registry.

The manifests pin a release tag. Right after a release bump, that tag's images
may not be promoted yet, and the pull fails with a message naming the image, the
tag, and `MINIKUBE_IMAGE_TAG`. In that case run
`MINIKUBE_IMAGE_TAG=latest make minikube-setup` to use the newest `dev` images
instead. See [Releases and upgrades](../deploy/releases-and-upgrades.md).

To build every image from source instead, use `make minikube-setup-local`
(equivalently `IMAGE_SOURCE=local`). That path needs no tag override.

It seeds for you:

- an agent: Host `chatllm` + an empty Context `context1` (no MCP servers —
  install connectors from the registry) + a CommunicationChannel
- one account, using the `ADMIN_PASSWORD` you set in `.env`: username
  **`admin`** for the Control UI and email **`admin@evenfire.local`** for the
  Desktop App — the same account, and the sole Desktop App member. It is also
  the initial EvenDrive (GFS) operator. A default re-run of setup rebuilds
  the control database, so it seeds a fresh link. With `REUSE_DB=true` it
  keeps the database and never recreates a revoked operator link or adds a
  second member; if the link is missing, setup stops with an actionable error.

Verify:

```bash
make minikube-status    # every deployment should show READY
```

Useful re-runs (setup rebuilds the database by default, so keep it with
`REUSE_DB=true` on an existing cluster):
`make minikube-setup REUSE_DB=true ARGS="--skip-build"` (redeploy in ~1 min) ·
`ARGS="--reset-db"` with `CONTROL_DB_RESET_PVC_UID` (fix postgres after a
cold-start crash; see the troubleshooting table) ·
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

The headless path exercises the production JWT chain end to end. Keep
`make minikube-pf-all` running in another terminal; it holds the
port-forwards open (control-api :8090, external-rest-api :8091,
rpc-proxy :8094, mcp-host :8080). Then:

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

1. Create a bot with [@BotFather](https://t.me/BotFather); copy the bot token
   and its `@handle`.
2. In the Control UI, open **External Channels** and create a channel: pick the
   `chatllm` agent, choose Telegram, and paste the bot token and handle. The
   token is stored as a write-only channel credential.
3. Grant your Telegram account chat access, then message your bot.

Setup does not read Telegram values from `.env`; channel credentials are set
only through the Control UI (or the admin API).

Approval requests arrive on Telegram with inline **Approve / Deny** buttons.
Details: [Connect Telegram](../how-to/connect-telegram.md).

## Troubleshooting

| Symptom                                    | Fix                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent never replies                        | No real LLM key in `.env`; with several keys, set `CLERUM_MODEL_PROVIDER` explicitly (see step 1)                                                                                                                                                                                                                           |
| `minikube start` fails on memory           | Raise Docker Desktop to ≥10 GB RAM / 6 CPUs — or, if you can't spare it, `MINIKUBE_MEMORY=9216 make minikube-setup` (stock Docker Desktop's ~9.9 GB is just under the 10 GB default)                                                                                                              |
| Pods `Pending` early on                    | Calico is still coming up — wait, then `make minikube-status`                                                                                                                                                                                                                                                               |
| postgres CrashLoopBackOff after cold start | Rebuild the DB — this deletes all its data. Set `KCTX=clerum-test` (your `MINIKUBE_PROFILE`) and confirm the cluster with `kubectl --context "$KCTX" cluster-info`. Then print and check the volume's UID: `kubectl --context "$KCTX" -n control-plane get pvc control-postgres-data -o jsonpath='{.metadata.uid}'`. Then paste it: `CONTROL_DB_RESET_PVC_UID=<uid-from-previous-step> make minikube-setup MINIKUBE_PROFILE="$KCTX" ARGS="--reset-db --skip-build"` ([details](../deploy/minikube.md#postgres-crashloopbackoff-wal-corruption)) |
| Port-forwards die                          | Re-run `make minikube-pf-all` (it holds them open; Ctrl-C stops) |

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
