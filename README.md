# evenfire

> Self-hostable, Kubernetes-native platform for LLM agents — multi-channel
> (Telegram/Email/Slack), first-class MCP, and a declarative workflow engine.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/evenfire-ai/evenfire/ci-public.yml?branch=main&label=CI)](https://github.com/evenfire-ai/evenfire/actions)
[![GitHub release](https://img.shields.io/github/v/release/evenfire-ai/evenfire?sort=semver)](https://github.com/evenfire-ai/evenfire/releases)

[Quickstart](#quickstart) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) · [License](#license)

<!-- ![demo](docs/assets/demo.gif) — add the demo GIF before launch (see docs/assets/) -->

## Why evenfire
- **CRD-driven, bidirectional MCP** — provision MCP servers declaratively; expose
  your agents over MCP. Not a per-vendor wrapper.
- **WorkflowRecipe engine** — declarative multi-step agentic workflows as K8s CRDs.
- **Multi-provider** — OpenAI, Claude, ZAI, Bailian behind one interface.

## Quickstart

No Kubernetes required. The quickstart runs `mcp-host` in dev mode — a local
LLM agent you can chat with over HTTP.

```bash
cp .env.quickstart.example .env.quickstart   # add ONE LLM API key
docker compose --env-file .env.quickstart up mcp-host
```

Once running, send a message:

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

**Optional: Telegram surface** — to connect a real Telegram bot, add
`CLERUM_TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` to `.env.quickstart`,
then run:

```bash
docker compose --env-file .env.quickstart --profile telegram up
```

> **Quickstart status and limitations**
> - `mcp-host` build and boot verified; health endpoint and message routing confirmed.
> - The message endpoint requires the internal `x-clerum-edge-*` headers shown above
>   (no JWT — these are trust headers sent by the channel-reader sidecar in production).
> - `channel-reader` is in the `telegram` profile; requires a real Telegram bot token.
> - No MCP servers are wired by default (agent replies using its LLM knowledge only).
>   To add MCP tools, set `CLERUM_MCP_SERVERS` as a JSON array (see `.env.quickstart.example`).

(The full Kubernetes deployment with NetworkPolicies, CRDs, and all services is under [docs/deploy](docs/deploy).)

## Self-host on Kubernetes
For the full platform (all services, NetworkPolicies, Helm CRDs) see
[docs/deploy](docs/deploy).

---

## Custom Resource Definitions (CRDs)

| Resource                 | API group | Description                                                                                                                       |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **CommunicationChannel** | clerum.io | Defines one or more channels (Telegram, Email, Slack) with their allowed user identifiers.                                        |
| **Context**              | clerum.io | Logical scope that groups a host and its MCP servers (Secrets, Network access).                                                   |
| **Host**                 | clerum.io | Central entity (e.g. chatLLM) that uses a context and references channels.                                                        |
| **McpServer**            | clerum.io | MCP server deployment spec (image, transport, auth, env, security overrides). Supports HTTP and stdio transports.                 |
| **WorkflowRecipe**       | clerum.io | Multi-workload composition (Deployments, StatefulSets, CronJobs) with MCP server registration, security overrides, and envSecret. |
| **WorkflowRecipePolicy** | clerum.io | Governance and detection policy for WorkflowRecipe deployments.                                                                   |

## Install

### Install CRDs (Helm)

```bash
helm install clerum-crds ./charts/clerum-crds
```

See [charts/clerum-crds/README.md](charts/clerum-crds/README.md) for details.

### Apply example resources (optional)

After CRDs are installed, apply the sample resources:

```bash
kubectl apply -f charts/clerum-crds/examples/
```

## Layout

### Core Services

- **[host-context-controller/](host-context-controller/README.md)** – K8s operator: manages MCP server Deployments/Services/NetworkPolicies, REST API for discovery (port 8081).
- **[mcp-host/](mcp-host/README.md)** – LLM orchestration (OpenAI/Claude/ZAI/Bailian), MCP tool calling, approval system, agent state machine (port 8080).
- **[mcp-proxy/](mcp-proxy/README.md)** – Centralized HTTP proxy for MCP servers. Polls HCC API for server discovery, routes requests (port 8083).
- **[channel-reader/](channel-reader/README.md)** – Watches CommunicationChannel CRDs and fetches messages from Telegram, Email, and Slack.
- **[workflow-recipes/](workflow-recipes/README.md)** – K8s operator: reconciles WorkflowRecipe CRDs into Deployments/StatefulSets/CronJobs with security overrides.

### Infrastructure

- **[stdio-bridge/](stdio-bridge/README.md)** – Sidecar container: translates stdio MCP transport to StreamableHTTP (port 3000). Used for stdio-only MCP images (postgres, redis, etc.).
- **[charts/clerum-crds/](charts/clerum-crds/README.md)** – Helm chart to install all CRDs.
- **[charts/clerum-crds/examples/](charts/clerum-crds/examples/)** – Sample CRD instances (Context, Host, McpServer, WorkflowRecipe).
- **[mcp-servers/](mcp-servers/README.md)** – MCP server implementations (MongoDB, Airtable).
- **[monitoring/](monitoring/README.md)** – Grafana dashboards + Loki log aggregation configs.
- **scripts/** – E2E test scripts, cluster bootstrap, test library.

### Frontend / API

- **[profile-ui/](profile-ui/README.md)** – Next.js frontend for profile and team workflows.
- **[rpc-proxy/](rpc-proxy/README.md)** – External-facing JWT-protected tenant RPC gateway to MCP servers.
- **[control-api/](control-api/README.md)** / **[control-ui/](control-ui/README.md)** – control plane backend/frontend.
- **[external-rest-api/](external-rest-api/README.md)** – User profile/team REST API with Google auth, invitations, password setup, and RPC token brokerage.
- **[desktop-app/](desktop-app/README.md)** – Desktop Electron app for direct evenfire interaction.

### Documentation — start here

- **[docs/README.md](docs/README.md)** — docs index (architecture, deploy, security, CRD reference, testing, features, archive).
- **[docs/architecture/overview.md](docs/architecture/overview.md)** — full architecture reference (services, CRDs, message lifecycle, NetworkPolicy model).
- **[docs/crds/](docs/crds/README.md)** — per-CRD reference pages for Host, Context, McpServer, WorkflowRecipe, CommunicationChannel.
- **[docs/deploy/gcp.md](docs/deploy/gcp.md)** and **[docs/deploy/minikube.md](docs/deploy/minikube.md)** — production and local deployment guides.
- **[docs/features/workflow-recipes.md](docs/features/workflow-recipes.md)** — WorkflowRecipes feature hub (single landing page for all WR content).
- **[docs/testing/e2e-guide.md](docs/testing/e2e-guide.md)** — E2E testing guide (8 suites, 9 phases, approval flow).

## External REST API Architecture

The `external-rest-api` follows a layered structure:

- `routes/`: HTTP handlers, validation, middleware, response shaping.
- `services/`: business workflow orchestration.
- `repositories/`: database access and SQL statements only.

This keeps database concerns isolated and makes migrations or DB provider changes easier.

See [external-rest-api/README.md](external-rest-api/README.md) for endpoint and environment details.

## Local Development

### Git Hooks

The repo uses tracked hooks from [`.githooks/`](.githooks). Root `npm install` configures them automatically. To activate them manually:

```bash
npm run install-git-hooks
```

This enables:

- `pre-commit`: runs `npm run version:staged` and `npm run format:staged`
- `commit-msg`: runs `commitlint`

### External REST API

```bash
cd external-rest-api
npm install
npm run dev
```

### Profile UI

```bash
cd profile-ui
npm install
npm run dev
```

## Testing

### Prerequisites

- **Docker Desktop** running
- **minikube** installed (`brew install minikube`)
- **kubectl** configured
- Node.js 24+ for unit tests

### 1. Environment Setup

Copy `.env.example` and fill in your API keys:

```bash
cp .env.example .env
```

Required keys for full E2E testing:

| Variable                | Required For               | How to Get                                     |
| ----------------------- | -------------------------- | ---------------------------------------------- |
| `ZAI_API_KEY`           | LLM tool-calling (Phase 8) | [z.ai](https://z.ai)                           |
| `OPENAI_API_KEY`        | Alternative LLM provider   | [OpenAI](https://platform.openai.com/api-keys) |
| `CLAUDE_API_KEY`        | Alternative LLM provider   | [Anthropic](https://console.anthropic.com/)    |
| `CLERUM_MODEL_PROVIDER` | Provider selection         | `zai`, `openai`, `claude`, or `bailian`        |

The `.env` file is gitignored and never committed.

### 2. Unit Tests

~3,000 unit tests across services (run `make test-unit-all`).

Each service also has its own suite:

```bash
cd mcp-host && npm test
cd workflow-recipes && npm test
cd mcp-servers && npm test
cd control-api && npm test
cd workflow-sdk && npm test
cd host-context-controller && npm test
cd mcp-proxy && npm test
```

### 3. E2E Tests (Kubernetes)

E2E tests validate the full pipeline on a real minikube cluster with Calico CNI for NetworkPolicy enforcement.

#### 3.1 Setup and Sync the Cluster

Use the Makefile path as the canonical local setup. It starts the `clerum-test`
profile, installs CRDs, creates secrets/config, builds images in minikube's
Docker daemon, deploys manifests, waits for rollouts, and seeds local test data.

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-setup
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-status
```

> **Important:** ~10GB RAM allocated to minikube is recommended for the full stack. The E2E suite runs 5 composite recipes concurrently deploying MongoDB, PostgreSQL, Redis, and multiple MCP servers.

Before any cluster-backed E2E gate, sync the running cluster to the current
worktree:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-pre-gate-sync GATE=<gate-name>
```

Use `--force-cluster-sync --skip-port-forwards` when deployable code changed
and your test runner will hold its own port-forwards:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH \
  make minikube-pre-gate-sync GATE=<gate-name> ARGS="--force-cluster-sync --skip-port-forwards"
```

After the deploy sync, verify a clean state before reading E2E results:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-status
kubectl --context=clerum-test get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl --context=clerum-test -n sandbox-recipes get workflowrecipes
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-verify-network-policy
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH CONTEXT=clerum-test scripts/minikube/seed-test-data.sh
```

#### 3.2 Port-Forwards and Vitest

`make test-e2e-vitest` and `make test-e2e-all` install `tests/e2e`
dependencies when missing and keep minikube port-forwards alive for the Vitest
phase. Direct `npx vitest` runs still require a held port-forward terminal:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-pf-all
```

With port-forwards held, verify the localhost ports used by the tests:

```bash
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8091/health
curl -sS http://127.0.0.1:8094/health
curl -sS http://127.0.0.1:8098/health
curl -sS http://127.0.0.1:8080/v1/runtime/health
```

The long-running software-creation suites are opt-in:

```bash
E2E_RUN_SOFTWARE_CREATION=1 PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make test-e2e-vitest
```

#### 3.3 Run Workflow E2E Gates

```bash
# Runtime gate: agentic baselines + snippet workflows
KUBECONTEXT=clerum-test ./scripts/e2e/e2e-workflow-runtime-gate.sh

# Backend compatibility suites
KUBECONTEXT=clerum-test ./scripts/e2e/e2e-workflow-backend-compat.sh

# Full bash + Vitest E2E
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make test-e2e-all

# Cleanup runtime gate recipes
KUBECONTEXT=clerum-test ./scripts/e2e/e2e-workflow-runtime-gate.sh --cleanup
```

#### 3.4 Run Individual Backend Compatibility Suites

```bash
# HTTP transport suites
./scripts/e2e/workflow-backend-compat/http-mongodb-stack.sh
./scripts/e2e/workflow-backend-compat/http-mock-db.sh
./scripts/e2e/workflow-backend-compat/http-postgres.sh
./scripts/e2e/workflow-backend-compat/http-redis-cache.sh
./scripts/e2e/workflow-backend-compat/http-webhook-relay.sh

# stdio transport suites
./scripts/e2e/e2e-agentic-stdio-baseline.sh
./scripts/e2e/workflow-backend-compat/stdio-postgres.sh
./scripts/e2e/workflow-backend-compat/stdio-multi-tool.sh
```

#### 3.5 E2E Test Phases

Each suite validates 9 phases:

| Phase              | What It Tests                                                                         |
| ------------------ | ------------------------------------------------------------------------------------- |
| 0 — Prerequisites  | Cluster, namespaces, CRDs, core deployments                                           |
| 1 — Clean Slate    | Delete previous recipe resources                                                      |
| 2 — Apply Recipe   | `kubectl apply` the WorkflowRecipe YAML                                               |
| 3 — Backend        | StatefulSet/Deployment readiness, data connectivity (pg_isready, mongosh, redis PING) |
| 4 — MCP Delegation | McpServer CRD auto-creation, managed=false, transport Service, Context allowlist      |
| 5 — MCP Server     | Pod readiness, transport protocol started                                             |
| 6 — NetworkPolicy  | Deny-all enforcement, binding NP (cross-namespace), internet egress blocked           |
| 7 — Discovery      | MCP Host discovers server via HCC API, tool registration                              |
| 8 — Tool-Calling   | Send message → LLM selects tool → **approval flow** → tool execution                  |

#### 3.6 Approval Flow in E2E

Phase 8 tests the full approval pipeline without disabling any security:

```
POST /message → response: { status: "awaiting_approval", approval: { requestId, taskId } }
     ↓
POST /approve → { userId: "e2e-runner", requestId }
     ↓
GET /task/:taskId/result → poll until { status: "completed" }
```

#### E2E Test Results

| Suite                   | Transport | Tests   | Description                                                |
| ----------------------- | --------- | ------- | ---------------------------------------------------------- |
| mongodb-mcp-stack       | HTTP      | 36      | MongoDB StatefulSet + PVC + 24 MongoDB tools               |
| mock-mcp-with-db        | HTTP      | 32      | PostgreSQL (runAsUser:70) + Mock MCP + approval flow       |
| mcp-postgres            | HTTP      | 37      | PostgreSQL + template interpolation (`{{workload:field}}`) |
| mcp-redis-cache         | HTTP      | 33      | Redis Deployment + binding NP cross-namespace              |
| mcp-webhook-relay       | HTTP      | 32      | MCP + CronJob + template resolution in args[]              |
| stdio-mcp-calculator    | stdio     | 28      | Pure compute, no backend                                   |
| stdio-mcp-with-postgres | stdio     | 31      | stdio + PostgreSQL StatefulSet + VCT + bindings            |
| stdio-mcp-multi-tool    | stdio     | 39      | 2 stdio servers + Redis                                    |
| **Total**               |           | **268** | **All phases including LLM tool-calling**                  |

## CommunicationChannel CRD

The CommunicationChannel CRD allows defining multiple channel groups in a single resource, associated with a Host. Each channel type is an array, so you can monitor multiple groups per type:

```yaml
apiVersion: clerum.io/v1alpha1
kind: CommunicationChannel
metadata:
  name: my-channels
spec:
  hostRef: chatllm           # Required: reference to the Host
  telegram:
    - channelId: "-11111"
      userIds:
        - "123456789"
    - channelId:"-22222"
      userIds:
        - "987654321"
  email:
    - channelId: INBOX
      emails:
        - user@example.com
  slack:
    - channelId: slack1
      userNames:
        - "@john"
```

- `hostRef` is required and references the Host this channel belongs to
- Each channel type (telegram, email, slack) is optional -- define only the ones you need
- Each channel type is an array of groups, where each group has its own `channelId` and allowed users

## Channel Reader

The `channel-reader/` directory contains a Docker image that:

1. Watches CommunicationChannel CRDs filtered by `hostRef` (via `CLERUM_HOST_REF` env var)
2. Connects to Telegram, Email (IMAP), and Slack
3. Reads all messages from allowed senders (defined in the CRDs)
4. Auto-restarts when CommunicationChannel CRDs are added, modified, or deleted

The channel-reader requires only `list` and `watch` permissions on `communicationchannels.clerum.io`.

See [channel-reader/README.md](channel-reader/README.md) for build and deployment instructions.

## Supported LLM Providers

The **mcp-host** service supports the following LLM providers, configured via the Host CRD `spec.model.provider` field:

| Provider                             | `provider` value | Default Model       | API                     |
| ------------------------------------ | ---------------- | ------------------- | ----------------------- |
| OpenAI                               | `openai`         | `gpt-5.4-mini`      | OpenAI Chat Completions |
| Anthropic Claude                     | `claude`         | `claude-sonnet-4-6` | Anthropic Messages      |
| ZAI (z.ai)                           | `zai`            | `glm-5.1`           | OpenAI-compatible       |
| Alibaba Cloud Model Studio (Bailian) | `bailian`        | `qwen3-coder-plus`  | OpenAI-compatible       |

### Bailian (Alibaba Cloud Model Studio)

Bailian provides access to multiple models through Alibaba Cloud's Coding Plan, including Qwen, MiniMax, GLM, and Kimi models.

Available models: `qwen3-coder-plus`, `qwen3.5-plus`, `qwen3-coder-next`, `qwen3-max-2026-01-23`, `MiniMax-M2.5`, `glm-5.1`, `glm-5`, `glm-4.7`, `kimi-k2.5`

**Host CRD example:**

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: bailian
    name: qwen3-coder-plus
```

**Dev mode:**

```bash
CLERUM_DEV_MODE=true BAILIAN_API_KEY=sk-... CLERUM_MODEL_PROVIDER=bailian npm run dev
```

Get your Coding Plan API key at: https://modelstudio.console.alibabacloud.com/

## Data Flow

```
User (Telegram/Email/Slack)
        ↓
channel-reader (polls, filters by allowed senders)
        ↓ HTTP POST /v1/runtime/messages
mcp-host (queues, agent state machine, LLM + MCP tool calling)
        ↓ GET /api/v1/mcpservers/context/{ref}
host-context-controller (discovers MCP servers, provides auth tokens)
        ↓
mcp-proxy (centralized HTTP routing)
        ↓ POST /servers/{name}/mcp
MCP Servers (MongoDB, Airtable, Playwright, stdio-bridge sidecars)
```

## Relationships

- **CommunicationChannel** defines allowed users for Telegram, Email, and Slack.
- **Host** (chatLLM) uses a **Context** (context1) and references channel configurations.
- **Host** and **McpServers** share the same **Context** (context1).
- **WorkflowRecipe** composes multiple workloads (Deployments, StatefulSets, CronJobs) and auto-registers MCP servers.
- **MCP Proxy** centralizes HTTP routing to all MCP servers, enabling metrics and health monitoring.
- **McpServers**: MongoDB, Airtable, Playwright (browser rendering/screenshot), and any stdio-based servers via stdio-bridge sidecar.

## License

evenfire is licensed under **Apache-2.0 with an additional use grant** (no
operating a competing managed multi-tenant service). It is **source-available**,
not OSI open source. Self-hosting for your own organization and internal
commercial use are permitted. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).
