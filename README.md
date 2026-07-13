# evenfire

> **Build multi-channel LLM agents you own** — agents that take **real actions**,
> with human-in-the-loop approvals, least-privilege connectors, and default-deny
> networking built in. Self-hosted, Kubernetes-native, declared as CRDs.

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/evenfire-ai/evenfire/ci-public.yml?branch=main&label=CI)](https://github.com/evenfire-ai/evenfire/actions)
[![GitHub release](https://img.shields.io/github/v/release/evenfire-ai/evenfire?sort=semver)](https://github.com/evenfire-ai/evenfire/releases)

[What agents can do](#what-agents-can-do) · [Get started](#get-started-minikube) · [Architecture](#architecture) · [Security model](#security-model) · [Docs](docs/README.md) · [License](#license)

---

## What is evenfire

evenfire runs LLM agents on **your** infrastructure. Agents converse over
Telegram, Email, Slack, and a desktop app, call tools through the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP), and execute
multi-step workflows — while risky actions wait for a human "yes." Agents,
connectors, channels, and workflows are declared as Kubernetes custom
resources, so your fleet is version-controlled, reviewable configuration. You
bring your own model keys; prompts and data stay in your environment.

One command (`make minikube-setup`) stands up the full platform — operators,
NetworkPolicies, JWT chain, control plane, seeded agent — on a local cluster.

> **Naming:** the code uses the project's internal name **clerum** —
> `clerum.io` CRDs, `CLERUM_*` env vars, `clerum-*` packages. **evenfire** is
> the public name of the same project. Details:
> [docs/concepts/code-names.md](docs/concepts/code-names.md).

---

## What agents can do

Everything below is shipped in this repo and registered in
`mcp-host/src/core/tools/nativeToolRegistry.ts`. Tools marked 🔒 suspend the
task for human approval before running.

### Act on systems

| Capability                 | Tools                                                                                                                  | Notes                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Run shell commands         | `shell_exec` 🔒                                                                                                        | full shell syntax in the agent workspace; the approval gate is the security boundary                                                           |
| Call HTTP APIs             | `http_request` 🔒                                                                                                      | GET/POST/PUT/DELETE against an allowlisted set of domains (`CLERUM_HTTP_ALLOWLIST`)                                                            |
| Read/write workspace files | `file_read`, `file_write`                                                                                              | path-validated, per-user isolated workspace                                                                                                    |
| Drive a real browser       | `browser_open` 🔒, `browser_navigate` 🔒, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_content` | Playwright Chromium; enable with `CLERUM_DESKTOP_BROWSER=true`                                                                                 |
| Drive a desktop            | `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_mouse_move`, `desktop_drag`             | X11 (`scrot`/`xdotool`); enable with `CLERUM_DESKTOP_X11=true`                                                                                 |
| Schedule recurring work    | `cron_manage` 🔒                                                                                                       | agent creates/edits cron jobs (5-part expressions); each fire enqueues a real agent task and the result routes back to the originating channel |

### Produce artifacts

Pure-JS document generation — no headless browser involved; artifacts persist
on the workspace PVC so download links survive pod restarts:

| Tool                                                                        | Output                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `clerum__generate_pdf`                                                      | print-quality PDF (markdown subset, tables, cover band, embedded images)                          |
| `clerum__generate_docx` / `clerum__generate_xlsx` / `clerum__generate_pptx` | styled Word / Excel (frozen headers, auto-filter, number formats) / PowerPoint (4 deck templates) |
| `clerum__generate_chart`                                                    | PNG charts — line, bar, horizontalBar, pie, doughnut, area, scatter, radar, polarArea, bubble     |
| `clerum__generate_dashboard`                                                | self-contained single-file HTML dashboard                                                         |
| `clerum__generate_markdown`                                                 | plain `.md`                                                                                       |

### Use governed connectors (MCP)

- **Shipped connector specs:** MongoDB (9 tools: find, aggregate, count,
  distinct, insert/update/delete-one, list collections/databases; writes
  blockable via read-only mode) and Airtable (8 tools). Both run upstream
  images packaged as `McpServer` CRDs.
- **Any stdio MCP server** plugs in through the [stdio-bridge](stdio-bridge/README.md)
  sidecar (PostgreSQL, Redis, GitHub, Brave Search, …) — set
  `transport.type: stdio` and the operator injects the bridge. Example CRDs
  ship for postgres, github, and filesystem servers
  ([charts/clerum-crds/examples/](charts/clerum-crds/examples/)).
- An agent only reaches connectors its `Context` allowlists — enforced by
  NetworkPolicy, not convention.

### Remember and stay within budget

- **Persistent memory** — `memory_search` / `memory_write` / `memory_read` /
  `memory_tree` over a per-user workspace (`CLERUM_MEMORY_ENABLED`).
- **Cross-session recall** — full-text search (SQLite FTS5) over the user's
  past conversations (`clerum__session_search`, flag-gated).
- **Context management** — deterministic pre-pruning plus tiered compaction
  under token pressure; oversized tool results spill to disk and the agent
  reads them back on demand (`clerum__spillover_read`, on by default).
- **Durable sessions** — conversation state survives pod restarts
  (SQLite-backed); a boot-time reaper recovers sessions stuck mid-approval.
  Sessions persist and resume per channel; identities are deliberately
  channel-namespaced.

### Trigger multi-step workflows

`workflow_list` / `workflow_status` / `workflow_trigger` 🔒 /
`workflow_result` — agents inspect and (with approval) launch
`WorkflowRecipe` deployments. One recipe YAML can stand up e.g. a persistent
MongoDB StatefulSet with PVC, health probes, stable DNS, and auto-registered
MCP tools; recipes advance through a 13-state lifecycle with risk-based
approval, shadow testing, and automatic rollback.

### The approval flow, on the wire

A tool call that needs approval suspends the task and tells the caller:

```jsonc
// POST /v1/runtime/messages            → agent decides it needs a tool
{ "success": true, "status": "waiting_approval",
  "approval": { "taskId": "…", "requestId": "…", "userId": "…",
                "notification": "The agent wants to run shell_exec: …" } }

// POST /v1/runtime/approvals/approve   { "userId", "requestId" }
{ "success": true }

// GET /v1/runtime/tasks/{taskId}/result   → poll until done
{ "success": true, "status": "completed",
  "response": "…final answer…", "attachments": [ /* generated files */ ] }
```

Approvals surface wherever you are: **inline Approve/Deny buttons on
Telegram** (or `/approve <target>`), a Slack Approve button, or the desktop
app's in-chat gate. Channel callbacks are signature-verified and re-authorized
against the control plane before any decision is forwarded — and pending
approvals survive pod restarts.

---

## Get started (minikube)

The full platform on a local Kubernetes cluster: all services, deny-all
NetworkPolicies, the JWT chain, and a seeded agent named `chatllm`.

**Prerequisites:** Docker Desktop running with **≥10 GB RAM / 6 CPUs**
allocated · `minikube` v1.30+ · `kubectl` · `python3` · Node.js 20+.

```bash
git clone https://github.com/evenfire-ai/evenfire.git && cd evenfire
cp .env.example .env
```

Edit `.env` — set **one** LLM key **and its matching provider**:

```bash
OPENAI_API_KEY=sk-...
CLERUM_MODEL_PROVIDER=openai     # REQUIRED: openai | claude | zai | bailian
```

> ⚠️ If `CLERUM_MODEL_PROVIDER` is unset, the seeded agent defaults to
> `zai`/`glm-5.1` regardless of which key you provided — the most common
> "my agent won't reply" cause.

Then:

```bash
make minikube-setup    # 12 idempotent steps: cluster → CRDs → keys → images → deploy → seed
make minikube-status   # every deployment READY
```

First run takes ~5–10 minutes (image builds dominate). Re-run safely any time;
`ARGS="--skip-build"` redeploys in ~1 minute.

### Say hello — desktop app

```bash
npm run ui             # Control UI + Profile UI + Desktop App against the cluster
```

Log into the desktop app as `test@clerum.io` / `changeme123!` and message the
`chatllm` agent. Ask it to run a command or generate a PDF — and approve the
tool call from the chat.

### Say hello — the API (exercises the real JWT chain)

With `make minikube-pf-all` holding port-forwards in another terminal:

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

# 3. message the agent
TASK=$(curl -s -X POST "$RPC/api/v1/rpc/hosts/$HOST/messages?async=true" \
  -H "Authorization: Bearer $RPC_TOKEN" -H 'Content-Type: application/json' \
  -d '{"content":"Hello! Reply with a one-sentence greeting."}' | jq -r .taskId)

# 4. poll the result
curl -s "$RPC/api/v1/rpc/hosts/$HOST/tasks/$TASK/result" \
  -H "Authorization: Bearer $RPC_TOKEN" | jq '{status, response}'
```

That hello just traversed the production auth path: session JWT → scoped RPC
token (audience/scope-checked, wildcard host bindings rejected) → rpc-proxy →
agent runtime.

**If something fails:** postgres CrashLoopBackOff after a cold start →
`make minikube-setup ARGS="--reset-db --skip-build"`; Calico pods take a while
on first boot — `make minikube-status` until green. Full guide:
[docs/get-started/quickstart.md](docs/get-started/quickstart.md) ·
[docs/deploy/minikube.md](docs/deploy/minikube.md) ·
production: [docs/deploy/production.md](docs/deploy/production.md).

---

## Architecture

```mermaid
flowchart LR
    TG([Telegram / Email / Slack]) --> CR[channel-reader]
    DA([Desktop app]) --> RP["rpc-proxy<br/>(scoped JWTs)"]
    CR --> MH["mcp-host<br/>agent runtime · approval gate"]
    RP --> MH
    MH <--> LLM[("OpenAI · Claude<br/>Z.AI · Bailian")]
    MH --> HCC["host-context-controller<br/>connector discovery"]
    MH --> MP[mcp-proxy] --> MCP["MCP servers<br/>(HTTP · stdio via bridge)"]
    HCC -. "reconciles CRDs,<br/>generates NetworkPolicies" .-> MCP
```

Messages arrive through `channel-reader` or the desktop app (via `rpc-proxy`).
`mcp-host` runs the agent state machine, calls your LLM, and executes MCP and
native tools — pausing for human approval when policy requires it.
`host-context-controller` turns CRDs into Deployments, Services, and
NetworkPolicies; the `workflow-recipes` operator does the same for multi-step
workflow workloads.

### Services and ports

| Service                            | Port           | Role                                                                                 |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `mcp-host`                         | 8080           | agent runtime: LLM loop, state machine, approval gate, native tools                  |
| `host-context-controller`          | 8081           | operator: Host/Context/McpServer → Deployments + NetworkPolicies; discovery REST API |
| `workflow-recipes` (WRC)           | 8082           | operator: WorkflowRecipe → workloads with policy enforcement                         |
| `mcp-proxy`                        | 8083           | optional centralized HTTP router for MCP servers                                     |
| `gfs-controller`                   | 8087           | brokered GlobalFileSystem API (permission store, audit chain)                        |
| `control-api`                      | 8090           | control plane: CRDs, secrets, token issuance, usage/cost, registry                   |
| `external-rest-api`                | 8091           | profiles, teams, invitations, RPC-token brokerage                                    |
| approval gateway                   | 8092           | workflow approval ingress lane                                                       |
| `rpc-proxy`                        | 8094           | external JWT-gated gateway (desktop/tenant → hosts and MCP servers)                  |
| `workflow-approval-request-reader` | 8098           | Slack/Telegram approval callbacks, signature-verified                                |
| `stdio-bridge`                     | 3000 (sidecar) | stdio MCP transport → StreamableHTTP                                                 |
| `control-ui` / `profile-ui`        | 3000 / 3001    | admin dashboard / end-user profile                                                   |

### Token flows

- **External:** desktop → `external-rest-api` (password/Google login →
  session JWT) → `POST /api/v1/rpc/token` brokers a **short-lived, scope-narrowed
  RPC token** (dropped scopes are surfaced) signed by `control-api` →
  `rpc-proxy` verifies RS256 + issuer + audience + scopes + host bindings
  (wildcards rejected).
- **Internal:** services authenticate with audience-separated RS256 token
  families — down to **60-second single-purpose artifact tokens** minted per
  request and never stored. Shared-file access treats the JWT as a ceiling and
  re-checks a permission store on every operation, fail-closed.
- **Agent ingress:** `mcp-host` runtime routes authenticate the platform's own
  edge services via edge trust headers, restricted by NetworkPolicy (the route
  rejects bearer tokens by design; JWTs authenticate the hops _into_ the edge).

### Network isolation (4 layers)

Every runtime namespace starts from **deny-all in both directions**; the
operators add back only what CRDs declare: **L0** deny-all → **L1**
infrastructure (DNS; Kubernetes-API egress denied by default, opt-in by
label) → **L2** per-(context, server) allow pairs → **L3** external egress
with private/link-local/cloud-metadata CIDRs excluded and remote connectors
pinned behind an SSRF-hardened egress proxy.

Deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[docs/architecture/overview.md](docs/architecture/overview.md) ·
[docs/architecture/platform-topology.md](docs/architecture/platform-topology.md).

---

## Security model

A model can be steered, misled, or simply wrong — so the platform never trusts
it by default. Four enforcement layers in this repo:

1. **Human-in-the-loop approvals.** MCP tool calls suspend until explicit
   approve/deny (default-on for MCP tools; per-tool overrides on the `Host`
   CRD). Channel callbacks are signature-verified and authorized. Pending
   approvals survive restarts.

2. **Least privilege.** A `Context` defines reachable connectors; RPC tokens are
   short-lived and scope-narrowed (wildcard host bindings rejected); custom
   workflow-coordinator images require sha256 digests, and connector images are
   checked against an image allowlist (audit-mode by default); workloads drop
   capabilities; secrets validated key-by-key.

3. **Default-deny networking.** Runtime namespaces start deny-all; connectivity
   is added per (context, server). External egress excludes private and
   cloud-metadata ranges; remote connectors use a pinned egress proxy. (Egress
   is not a full per-domain SaaS allowlist — see architecture docs.)

4. **Authenticated internals.** Service-to-service RS256 tokens with strict
   audience/scope (including short-lived artifact tokens). Shared-file access
   treats the JWT as a ceiling, re-checks a permission store fail-closed, and
   appends to a tamper-evident audit chain. Inbound webhooks use timing-safe
   signature checks. Direct `mcp-host` ingress is **layered**: edge trust
   headers from named platform services (in production restricted by
   NetworkPolicy); the host's own JWT middleware guards only specific control
   routes.

Report vulnerabilities privately: **[SECURITY.md](SECURITY.md)**.
Public claim rules: [docs/meta/claims-guardrails.md](docs/meta/claims-guardrails.md).

---

## Beyond the agent

- **Shared file systems** — `SharedFileSystem` (read-only to agents) and
  `GlobalFileSystem` (brokered API, permission store, tamper-evident audit).
- **Usage & cost** — authoritative token usage in control-api; dashboards and
  budgets in control-ui (not the Grafana/Loki stack under `monitoring/`).
  Budgets are cost control (fail-open), not a security boundary.
- **Governed registry** — publish and install connectors and workflow recipes
  with trust labels and publisher keys.
- **Observability** — Prometheus metrics across services; optional Grafana +
  Loki log aggregation in [monitoring/](monitoring/README.md).

---

## Custom Resource Definitions (8)

| Resource                 | Description                                      |
| ------------------------ | ------------------------------------------------ |
| **Host**                 | Agent: model, context, channels, approval policy |
| **Context**              | MCP server allowlist (+ related scope)           |
| **McpServer**            | Connector deployment (HTTP/stdio, auth, egress)  |
| **CommunicationChannel** | Telegram / Email / Slack + allowed identities    |
| **WorkflowRecipe**       | Multi-workload composition with MCP registration |
| **WorkflowRecipePolicy** | Governance policy for recipes                    |
| **SharedFileSystem**     | Per-team workspace (read-only to agents)         |
| **GlobalFileSystem**     | Brokered global drive with audited access        |

```bash
helm install clerum-crds ./charts/clerum-crds
kubectl apply -f charts/clerum-crds/examples/   # optional samples
```

Reference: [docs/crds/README.md](docs/crds/README.md) ·
Production checklist: [docs/deploy/production.md](docs/deploy/production.md).

---

## Supported LLM providers

| Provider         | `provider` value | Default model       |
| ---------------- | ---------------- | ------------------- |
| OpenAI           | `openai`         | `gpt-5.4-mini`      |
| Anthropic Claude | `claude`         | `claude-sonnet-4-6` |
| Z.AI             | `zai`            | `glm-5.1`           |
| Alibaba Bailian  | `bailian`        | `qwen3-coder-plus`  |

Four providers behind one interface; OpenAI-compatible endpoints can plug in as
registry descriptors where the code supports it. Bailian surfaces Qwen / GLM /
Kimi / MiniMax models. Keys live in a Kubernetes Secret you create (dev mode:
environment variables). Details: [mcp-host/README.md](mcp-host/README.md).

---

## Repository layout

| Area                    | Component                                                                                                                                              | Role                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Agent runtime**       | [mcp-host/](mcp-host/README.md)                                                                                                                        | LLM loop, approvals, MCP + native tools |
|                         | [channel-reader/](channel-reader/README.md)                                                                                                            | Telegram / Email / Slack ingress        |
|                         | [mcp-proxy/](mcp-proxy/README.md), [stdio-bridge/](stdio-bridge/README.md)                                                                             | MCP routing / stdio bridge              |
|                         | [mcp-servers/](mcp-servers/README.md)                                                                                                                  | Connector specs (upstream images)       |
| **Operators**           | [host-context-controller/](host-context-controller/README.md)                                                                                          | CRDs → Deployments + NetworkPolicies    |
|                         | [workflow-recipes/](workflow-recipes/README.md)                                                                                                        | WorkflowRecipe operator                 |
|                         | [gfs-controller/](gfs-controller/), [workspace-files-controller/](workspace-files-controller/)                                                         | File planes                             |
| **Edge & security**     | [rpc-proxy/](rpc-proxy/README.md), [external-rest-api/](external-rest-api/README.md)                                                                   | JWT edge, profiles/tokens               |
|                         | [webhook-gateway/](webhook-gateway/), [webhook-proxy/](webhook-proxy/), [nginx-egress-proxy/](nginx-egress-proxy/)                                     | Ingress / egress hardening              |
|                         | [workflow-approval-request-reader/](workflow-approval-request-reader/)                                                                                 | Channel approval callbacks              |
| **Control plane & UIs** | [control-api/](control-api/README.md), [control-ui/](control-ui/README.md), [profile-ui/](profile-ui/README.md), [desktop-app/](desktop-app/README.md) | Admin, profile, desktop                 |
| **Platform**            | [charts/clerum-crds/](charts/clerum-crds/README.md), [deploy/](deploy/), [packages/](packages/), [monitoring/](monitoring/README.md)                   | CRDs, manifests, shared libs, log stack |

---

## Development & testing

Each service is an independent npm package:

```bash
cd mcp-host && npm install && npm test
```

- **Unit tests** — 10,000+ Vitest cases across ~880 test files; run `npm test`
  in each package, or `make test-unit-all` after installing deps.
- **E2E** — 268 tests across 8 suites on minikube with Calico NetworkPolicies
  and the approval flow:
  [docs/testing/e2e-guide.md](docs/testing/e2e-guide.md)
- **Hooks** — [`.githooks/`](.githooks); `npm run install-git-hooks`

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Documentation

| Path                                                                               | For                   |
| ---------------------------------------------------------------------------------- | --------------------- |
| **[docs/README.md](docs/README.md)**                                               | Docs index            |
| **[docs/get-started/learning-path.md](docs/get-started/learning-path.md)**         | Role-based path       |
| **[docs/concepts/why-evenfire.md](docs/concepts/why-evenfire.md)**                 | Product intent        |
| **[docs/concepts/when-to-use-evenfire.md](docs/concepts/when-to-use-evenfire.md)** | Fit by category       |
| **[docs/faq.md](docs/faq.md)**                                                     | FAQ & troubleshooting |
| **[docs/llms.txt](docs/llms.txt)**                                                 | Map for coding agents |
| **[docs/meta/claims-guardrails.md](docs/meta/claims-guardrails.md)**               | Public claim rules    |

---

## Community

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev loop, what we accept
- **[SECURITY.md](SECURITY.md)** — private vulnerability disclosure
- **[GOVERNANCE.md](GOVERNANCE.md)** · **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** · **[CLA.md](CLA.md)**

---

## License

evenfire is **open source** under the [Mozilla Public License 2.0](LICENSE)
(MPL-2.0) — an OSI-approved, file-level copyleft license. Use it, modify it,
self-host it, and build commercial products on it; changes to MPL-licensed
files must remain under MPL when distributed. Trademarks are separate — see
[TRADEMARK.md](TRADEMARK.md).
