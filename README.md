# evenfire

> **Build multi-channel LLM agents you own** — agents that take **real actions**,
> with human-in-the-loop approvals, least-privilege connectors, and default-deny
> networking built in. Self-hosted, Kubernetes-native, declared as CRDs.

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/evenfire-ai/evenfire/ci-public.yml?branch=main&label=CI)](https://github.com/evenfire-ai/evenfire/actions)
[![GitHub release](https://img.shields.io/github/v/release/evenfire-ai/evenfire?sort=semver)](https://github.com/evenfire-ai/evenfire/releases)

[What agents can do](#what-agents-can-do) · [Get started](#get-started-minikube) · [Architecture](#architecture) · [Security model](#security-model) · [Components](#components) · [Docs](docs/README.md) · [License](#license)

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

Edit `.env` — set **one** LLM key (setup infers the matching provider):

```bash
OPENAI_API_KEY=sk-...
CLERUM_MODEL_PROVIDER=openai     # optional with one key: openai | claude | zai | bailian
```

> ⚠️ With exactly **one** API key set, setup auto-infers `CLERUM_MODEL_PROVIDER`
> (and logs the choice). With multiple keys, set it explicitly — setup fails
> with a clear error naming the keys instead of guessing.

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
   appends to a tamper-evident audit log. Inbound webhooks use timing-safe
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

## Components

Every deployable component in this monorepo has its own README. The map below
distills the load-bearing facts from each — the folder READMEs are the deep
dives.

### Agent runtime

- **[mcp-host/](mcp-host/README.md)** — the agent runtime. Runs the task
  state machine and LLM loop under hard guardrails (per-task tool-call cap,
  max task duration, bounded queue), executes native and MCP tools behind the
  approval gate, and serves the versioned `/v1/runtime/*` REST API — messages,
  approve/deny, task results, cron deliveries. Identity comes from a `Host`
  CRD plus its referenced Secret, hot-reloaded on change; connector discovery
  goes through host-context-controller's API, so mcp-host needs no McpServer
  RBAC. LLM providers are data-first descriptors — an OpenAI-compatible
  provider is a registry entry, not new code. `Host.spec.approval.tools`
  overrides per-tool approval defaults (e.g. skip `http_request` approval
  when `CLERUM_HTTP_ALLOWLIST` is the gate).
- **[channel-reader/](channel-reader/README.md)** — Telegram (grammY), Email
  (ImapFlow), and Slack (`@slack/web-api`) ingress. Watches
  `CommunicationChannel` CRDs filtered by `hostRef` and restarts itself when
  they change; applies per-sender pre-filters (Telegram user IDs, email
  addresses, Slack usernames) before a message ever reaches the agent;
  delivers generated attachments back to the channel under count/size caps.
- **[mcp-proxy/](mcp-proxy/README.md)** — optional centralized MCP router
  (`MCP_PROXY_ENABLED`). Polls host-context-controller for the live server
  list into a diff-logged routing table, forwards with response-size and
  timeout guards, and fails readiness when its discovery cache expires.
- **[stdio-bridge/](stdio-bridge/README.md)** — sidecar that turns any
  stdio-only MCP server (PostgreSQL, Redis, GitHub, …) into a StreamableHTTP
  endpoint. Injected automatically when a CRD declares
  `transport.type: stdio`; supervises the child process with
  exponential-backoff restarts and graceful shutdown.
- **[mcp-servers/](mcp-servers/README.md)** — the connector catalog. MongoDB
  and Airtable ship with a 343-case test suite covering CRD config, API
  behavior, MCP protocol, and generated Kubernetes resources; web-search
  (Brave), Playwright, and doc-generator are available; Alpha Vantage is a
  stub. Credentials live in Kubernetes Secrets, never in CRDs.

### Operators

- **[host-context-controller/](host-context-controller/README.md)** — the
  central operator. Reconciles `McpServer` CRDs into Deployments and Services
  — refusing to deploy any server whose referenced Secret (or any declared
  key) is missing — and `Host` CRDs into a per-agent Deployment, Service, and
  workspace PVC. Owns the four-layer NetworkPolicy model: for external
  egress, public hostnames are DNS-resolved to `/32` ipBlocks, rejected if
  they overlap private/link-local/cloud-metadata ranges, and re-resolved
  periodically (default 5 min) — a failed egress binding blocks the workload
  from starting at all. Also serves the discovery REST API mcp-host uses to
  find connectors and their auth tokens, and sweeps orphaned resources on
  startup.
- **[workflow-recipes/](workflow-recipes/README.md)** — the operator that
  owns the `WorkflowRecipe` lifecycle: policy validation against
  cluster-wide `WorkflowRecipePolicy` CRDs, input and `{{…}}` template
  resolution, topological dependency ordering, then Deployments,
  StatefulSets, CronJobs, and Jobs. Recipes advance through a 13-state
  machine (candidate → … → active, with degraded / rolling-back / failed
  paths). Transport-enabled workloads become `McpServer` CRDs that
  host-context-controller picks up. Per-workload security overrides let
  images like PostgreSQL (uid 70) run under their expected uid while keeping
  `runAsNonRoot` and all capabilities dropped. Recipes with `steps[]` get a
  coordinator pod that executes multi-step LLM workflows with crash
  recovery, per-step model overrides, and LLM-call rate limiting.
- **[gfs-controller/](gfs-controller/README.md)** — brokered file API over
  the `GlobalFileSystem` drive, and the only workload that mounts its PVC
  (one writer replica, read-only readers). Every request runs a fail-closed
  chain: RS256 JWT → subject expansion → token ceiling (the token is an
  upper bound on authority, never a grant) → Postgres permission store
  re-checked on every operation. Unauthorized and non-existent resources are
  indistinguishable (both 403); every decision — allow, deny, or error — is
  an INSERT-only audit row, and an audit-write failure means the operation
  is not served. Agent replace/delete calls carry an integer `ifMatch`
  version for optimistic concurrency.
- **[workspace-files-controller/](workspace-files-controller/README.md)** —
  the write path for `SharedFileSystem` team workspaces, one instance per
  filesystem. Agents mount the same PVC read-only, and the instance's
  NetworkPolicy admits only control-api — so a compromised agent pod cannot
  reach the writable side of its own workspace. Short-lived JWTs are pinned
  to one filesystem with a closed scope set; paths are validated lexically
  and physically (symlinks rejected, re-validation after writes against
  TOCTOU swaps, atomic temp-then-rename uploads).

### Edge & security

- **[rpc-proxy/](rpc-proxy/README.md)** — the external gateway for desktop
  and tenant traffic. Verifies RS256 RPC tokens — issuer, audience, expiry,
  scopes, per-host bindings, wildcard `*` rejected — holding a public key
  only, so it can never mint what it verifies; each user's reachable servers
  and hosts are resolved through control-api. Status/activity SSE streams
  are read-only and never include chain-of-thought. Ships hardened
  manifests: non-root, seccomp `RuntimeDefault`, read-only root filesystem,
  NetworkPolicy, PodDisruptionBudget.
- **[external-rest-api/](external-rest-api/README.md)** — public auth and
  profile facade: password/Google login (session tokens are minted by
  control-api), team membership and roles (admin / inviter / member),
  invitations, directory lookup, and RPC-token brokerage. `userId` and
  `teamId` always derive from verified JWT claims — never from request input
  — and control-api re-validates the claim binding on every forwarded call.
- **[webhook-gateway/](webhook-gateway/README.md)** — per-recipe webhook
  verifier, one per recipe that declares `spec.webhooks[]`. Verifies the
  exact raw bytes the provider signed: HMAC-SHA256 (plain or timestamped
  with a replay window), constant-time static bearer, or JWKS-verified JWTs
  — asymmetric algorithms only, `HS*`/`none` rejected. Slowloris budgets,
  in-flight caps, per-webhook body caps; strips every inbound `x-clerum-*`
  header and injects its own verified identity. Zero runtime npm
  dependencies.
- **[webhook-proxy/](webhook-proxy/README.md)** — stateless public webhook
  router in front of the gateways. Path segments are matched raw (encoded
  `%2e%2e` never decodes into `..`), the recipe namespace is pinned,
  webhooks are looked up in control-api's registry (hits and misses both
  cached), and bodies stream through unbuffered with method and size
  enforcement. Holds no secrets beyond one service token and does no HMAC
  itself — that is the gateway's job. Zero runtime npm dependencies.
- **[workflow-approval-request-reader/](workflow-approval-request-reader/README.md)**
  — the inbound half of channel approvals: normalizes Telegram/Slack
  callbacks (approve/deny buttons, enrollment, chat handoff) and submits
  decisions to the right workflow runtime. Telegram auth is a timing-safe
  secret comparison; Slack signatures are verified via control-api and
  cross-checked against the workspace ID; a fail-safe `can-approve`
  pre-check refuses to forward a decision when control-api errors. Zero
  runtime npm dependencies.
- **[nginx-egress-proxy/](nginx-egress-proxy/README.md)** — hardened nginx
  image serving as the pinned egress path for remote (SaaS) connectors.
  host-context-controller generates its config per server: `proxy_pass`
  locked to exactly one sanitized HTTPS URL (DNS hostnames only — IP
  literals, internal and metadata hosts rejected, the URL reconstructed to
  strip injected characters), upstream TLS verified, auth headers sanitized
  against CRLF injection, credentials resolved from Secrets at pod start via
  `${VAR}` placeholders so they never land in the ConfigMap. A remote CRD's
  `spec.image` is never what runs — the operator always stamps the platform
  image.

### Control plane & UIs

- **[control-api/](control-api/README.md)** — control-plane backend and the
  platform's token mint. CRUD for the CRDs, namespace-constrained secret
  management (listing returns metadata, never payloads), usage/cost
  accounting, and three separately-keyed RS256 token families: user session
  JWTs, short-lived scope-narrowed RPC tokens, and admin JWTs
  (bcrypt-seeded bootstrap admin, lockout after repeated failures).
  Separate keypairs keep blast radius contained and rotation independent;
  internal service calls use timing-safe token comparison; token consumers
  hold public keys only.
- **[control-ui/](control-ui/README.md)** — the admin dashboard (Next.js).
  Admin-JWT login in front of 14 sections: agents with a per-tool approval
  editor that shows risk hints whenever a setting loosens a
  required-by-default gate, connector egress editing that rejects
  private/metadata/reserved ranges, a registry marketplace with trust levels
  and publisher keys, a Global File System browser with grant delegation,
  token usage with 8 group-by dimensions, budgets, and write-only secrets.
  The browser talks same-origin only; a server-side handler proxies to
  control-api.
- **[profile-ui/](profile-ui/README.md)** — end-user profile and invitation
  confirmation (Next.js). Invited users accept and set a password through a
  token route; only the invitation token, email, and password ever leave the
  browser — the temporary invitation session stays server-side.
- **[desktop-app/](desktop-app/README.md)** — Electron + React client with a
  hardened renderer: `contextIsolation` and `sandbox` on, `nodeIntegration`
  off, all access through validated IPC (`window.clerum.*`). Authenticates
  via external-rest-api, holds only short-lived scoped RPC tokens (internal
  service tokens never touch the app), restores sessions from the OS
  keychain, and consumes the read-only SSE streams. E2E-tested in two
  phases: real IPC handlers against a live cluster, then Playwright driving
  the built Electron app.

### Platform directories

| Directory                                           | What's in it                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [charts/clerum-crds/](charts/clerum-crds/README.md) | Helm chart with all 8 CRDs plus example resources                                                                        |
| [deploy/](deploy/)                                  | Kubernetes manifests (`deploy/base/…`) for every namespace                                                               |
| [packages/](packages/)                              | Shared TypeScript libraries                                                                                              |
| [monitoring/](monitoring/README.md)                 | Optional Grafana + Loki log stack — Helm values and dashboards only, no code; authoritative usage/cost is in control-api |
| [tests/e2e/](docs/testing/e2e-guide.md)             | 268 end-to-end tests across 8 suites on minikube                                                                         |
| [docs/](docs/README.md)                             | The documentation tree                                                                                                   |

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
