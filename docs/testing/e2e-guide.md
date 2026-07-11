# Clerum E2E Testing Guide

> Consolidated 2026-04-13 from CLAUDE.md, scripts/e2e/, and scattered service test docs.

## Overview

Clerum has two categories of tests:

- **Unit tests** — per service, Vitest. Run with `npm test` inside each service directory.
- **E2E tests** — full-stack on minikube with Calico CNI. Run the runtime gate with `./scripts/e2e/e2e-workflow-runtime-gate.sh`; run backend compatibility suites with `./scripts/e2e/e2e-workflow-backend-compat.sh`.

E2E tests validate the full pipeline (CRD reconcile → NetworkPolicy → MCP discovery → LLM tool-calling + approval flow) against a real cluster. Unit tests validate per-service logic in isolation.

## Prerequisites

From root `README.md` §Testing prerequisites and CLAUDE.md §Before E2E Testing:

- **Docker Desktop** running
- **minikube** installed (`brew install minikube`)
- **kubectl** configured
- **Node.js 24+** for unit tests
- `.env` file at repo root with LLM API keys:

  | Variable                | Required For               | How to Get                              |
  | ----------------------- | -------------------------- | --------------------------------------- |
  | `ZAI_API_KEY`           | LLM tool-calling (Phase 8) | https://z.ai                            |
  | `OPENAI_API_KEY`        | Alternative LLM provider   | https://platform.openai.com/api-keys    |
  | `CLAUDE_API_KEY`        | Alternative LLM provider   | https://console.anthropic.com/          |
  | `CLERUM_MODEL_PROVIDER` | Provider selection         | `zai`, `openai`, `claude`, or `bailian` |

Copy `.env.example` to `.env` and fill in your keys. `.env` is gitignored.

## Cluster bootstrap

### 1. Create the minikube cluster

```bash
minikube start -p clerum-test \
  --driver=docker \
  --kubernetes-version=v1.26.1 \
  --cpus=6 \
  --memory=10240 \
  --cni=calico
```

> **Important:** ~10GB RAM allocated to minikube is recommended. The E2E suite runs 5 composite recipes concurrently deploying MongoDB, PostgreSQL, Redis, and multiple MCP servers. Calico CNI is required so NetworkPolicy Phase 6 actually enforces.

### 2. Bootstrap infrastructure

```bash
./scripts/bootstrap-cluster.sh
```

This performs 10 steps: cluster verify → namespaces (`control-plane`, `mcp-host`, `mcp-server`, `sandbox-recipes`, `rpc-proxy`) → CRDs install → image build+load → deploy HCC + WRC + mcp-host + mcp-proxy → apply Context/Host CRD instances → wait for readiness. API keys are read from `.env` automatically.

Alternatively, the Makefile path is the canonical local setup — it starts the
`clerum-test` profile, installs CRDs, creates secrets/config, builds images in
minikube's Docker daemon, deploys manifests, waits for rollouts, and seeds
local test data:

```bash
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-setup
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make minikube-status
```

### 3. Sync a running cluster before a gate

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

### 4. Port-forwards and Vitest

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

## Running E2E tests

```bash
# Runtime gate: agentic HTTP, snippet workflows, custom coordinator, rotation
./scripts/e2e/e2e-workflow-runtime-gate.sh

# Backend compatibility suites
./scripts/e2e/e2e-workflow-backend-compat.sh

# Cleanup runtime gate recipes
./scripts/e2e/e2e-workflow-runtime-gate.sh --cleanup

# Full bash + Vitest E2E
PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make test-e2e-all
```

The long-running software-creation suites are opt-in:

```bash
E2E_RUN_SOFTWARE_CREATION=1 PATH=/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH make test-e2e-vitest
```

## Individual suites

Runtime gate suites live in `scripts/e2e/`. Backend compatibility suites live in `scripts/e2e/workflow-backend-compat/`.

| #   | Script                             | Transport  | Tests      | Description                                                                          |
| --- | ---------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------ |
| 1   | `e2e-agentic-workflow-baseline.sh` | HTTP       | gate       | Agentic workflow baseline                                                            |
| 2   | `e2e-snippet-runtime-smoke.sh`     | snippet    | gate       | Fast snippet runtime smoke                                                           |
| 3   | `e2e-snippet-runtime.sh`           | mixed      | gate       | Snippet, DB, MCP, HTTP, and negative runtime paths                                   |
| 4   | `e2e-custom-coordinator-sdk.sh`    | mixed      | gate       | Custom coordinator image runtime                                                     |
| 5   | `e2e-workflow-token-rotation.sh`   | mixed      | gate       | Runtime token rotation                                                               |
| 6   | `e2e-agentic-stdio-baseline.sh`    | stdio      | standalone | Pure compute stdio baseline                                                          |
| 7   | `workflow-backend-compat/*.sh`     | HTTP/stdio | compat     | Backend and transport compatibility, including stdio PostgreSQL and multi-tool flows |

Extra scripts in `scripts/e2e/` not part of the main composite suite: `e2e-gke-*.sh` (production GKE smoke tests) and `e2e-prod-*.sh` (production recipe regressions).

### Backend compatibility suite results

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

## E2E phases (9 phases per suite)

Each suite validates 9 phases in order. Any failed phase aborts the suite.

| Phase              | What it tests                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------- |
| 0 — Prerequisites  | Cluster reachable, namespaces, CRDs installed, core deployments healthy                     |
| 1 — Clean Slate    | Delete previous recipe resources to guarantee a clean test                                  |
| 2 — Apply Recipe   | `kubectl apply` the WorkflowRecipe YAML                                                     |
| 3 — Backend        | StatefulSet/Deployment readiness; data connectivity (`pg_isready`, `mongosh`, redis `PING`) |
| 4 — MCP Delegation | McpServer CRD auto-created, `managed=false`, transport Service, Context allowlist           |
| 5 — MCP Server     | Pod ready, transport protocol started                                                       |
| 6 — NetworkPolicy  | Deny-all enforcement, binding NP cross-namespace, internet egress blocked                   |
| 7 — Discovery      | mcp-host discovers server via HCC API, tool registration                                    |
| 8 — Tool-Calling   | Send message → LLM selects tool → **approval flow** → tool execution → result               |

## Approval flow in E2E

Phase 8 exercises the full production approval pipeline without disabling any security. No short-circuiting — the E2E runner plays the role of the approving user.

The `mcp-host` runtime routes are:

```
POST /v1/runtime/messages
  → response: { status: "waiting_approval", approval: { requestId, taskId } }
     ↓
POST /v1/runtime/approvals/approve
  body: { userId, requestId, channelType, channelId }   (+ x-clerum-edge-* headers)
     ↓
GET /v1/runtime/tasks/:taskId/result → poll until { status: "completed" }
```

The E2E suite drives these through the tenant gateway instead of hitting
`mcp-host` directly: it approves at
`POST /api/v1/rpc/hosts/{hostRef}/approvals/approve` with `{ toolCallId }` and
polls `GET /api/v1/rpc/hosts/{hostRef}/tasks/{taskId}/result` (see
`tests/e2e/e2e-approval-flow.sh`).

This ensures E2E tests validate the real production flow, not a weakened test-mode path.

## Unit test suites

CLAUDE.md §Testing (test coverage table). Per-service numbers here track the authoritative CLAUDE.md values; actuals can drift — run `npm test` in each directory to confirm.

| Service                 | Tests (CLAUDE.md) | Description                                                                     |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------- |
| mcp-host                | 570               | Agent state machine, LLM providers, approval system, MCP client, internal tools |
| workflow-recipes        | 790               | StatefulSet, Deployment, envSecret, PVC, workflows                              |
| mcp-servers             | 343 ⚠️            | MongoDB + Airtable config + E2E                                                 |
| workflow-sdk            | 147               | Workflow SDK primitives                                                         |
| control-api             | 56                | Admin CRUD, auth, recipes, artifacts                                            |
| host-context-controller | 38                | McpServer reconciler, NetworkPolicy reconciler, API gateway                     |
| **Total (CLAUDE.md)**   | **1,944**         |                                                                                 |

> ⚠️ **Known discrepancy (mcp-servers)**: CLAUDE.md reports 343 tests; Phase 2 Agent 1 audit (2026-04-11) verified 294 actual tests passing. Likely a counting-methodology difference (e.g. E2E subdirectory vs. unit only). Running `cd mcp-servers && npm test` is the source of truth.

Root `README.md` §2 quotes slightly different (older) per-service counts — 370 workflow-recipes, 404 mcp-host, 37 mcp-proxy, 32 HCC = 843 total. CLAUDE.md is considered more current.

Run all unit tests:

```bash
make test-unit-all        # from repo root — runs every service test suite
make test-e2e-all         # bash + vitest E2E suites
make test-integration     # cross-service integration tests
make validate-all         # install → unit → setup → integration → e2e
```

Per-service:

```bash
cd mcp-host && npm test
cd workflow-recipes && npm test
cd mcp-servers && npm test
cd control-api && npm test
cd host-context-controller && npm test
```

## Desktop app E2E

From CLAUDE.md §Testing desktop-app. Two-phase test strategy — requires port-forwards to a running cluster.

```bash
cd desktop-app
cp .env.e2e.example .env.e2e    # set E2E_DEV_LOGIN_EMAIL and E2E_HOST_REF

npm run test:e2e                # Phase 1: IPC harness   (19 tests, ~45s)
npm run test:e2e:playwright     # Phase 2: Playwright/Electron (9 tests, ~2-3 min)
npm run test:e2e:all            # Both phases
```

Existing mcp-host E2E (requires minikube):

```bash
cd tests/e2e && npx vitest run
```

## Troubleshooting

Relevant test-related issues from CLAUDE.md §Common issues:

- **409 on first-time setup** → `make minikube-setup ARGS="--reset-db --skip-build"`
- **Postgres WAL corruption after cold start** → `make minikube-setup ARGS="--reset-db --skip-build"` (auto-detected)
- **Pod `ImagePullBackOff`** → `make minikube-setup` (rebuilds images with `:test` tag and `imagePullPolicy: IfNotPresent`)
- **`401: "Invalid token"` from chatllm** → `make minikube-gen-keys` followed by `make minikube-sync-auth-key` (auto-syncs + restarts). See CLAUDE.md §JWT Auth Chain.
- **Port-forward drops after pod restart** → re-run `make minikube-pf-desktop`
- **Desktop app shows no agents after login** → `scripts/minikube/seed-test-data.sh`
- **NetworkPolicy Phase 6 passes when it shouldn't** → ensure minikube was started with `--cni=calico`; the default `kindnet` CNI silently ignores NetworkPolicy. Cross-check the NetworkPolicy section in root `CLAUDE.md` and the rendered policies from the active overlay.
- **Phase 8 times out on approval** → check mcp-host logs for `awaiting_approval` entry; E2E runner uses `userId: "e2e-runner"` and must match the approver identity configured on the Host CRD.

## Related

- Root [`README.md`](../../README.md) §Development & testing — per-service test commands and suite summary
- Per-service `package.json` test scripts (vitest config)
- [`../deploy/minikube.md`](../deploy/minikube.md) — prerequisite deployment guide
- [`../architecture/overview.md`](../architecture/overview.md) NetworkPolicy model — required reading before debugging Phase 6
