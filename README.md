# evenfire

> **Build multi-channel LLM agents you own** — agents that take **real actions**,
> with human-in-the-loop approvals, least-privilege connectors, and default-deny
> networking built in. Self-hostable; Kubernetes-native when you need the full
> platform. Declared as CRDs.

[![License: Apache 2.0 (+ use grant)](https://img.shields.io/badge/License-Apache_2.0%20%2B%20grant-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/evenfire-ai/evenfire/ci-public.yml?branch=main&label=CI)](https://github.com/evenfire-ai/evenfire/actions)
[![GitHub release](https://img.shields.io/github/v/release/evenfire-ai/evenfire?sort=semver)](https://github.com/evenfire-ai/evenfire/releases)

[Quickstart](#quickstart) · [What is evenfire](#what-is-evenfire) · [Security model](#security-model) · [Docs](docs/README.md) · [Contributing](CONTRIBUTING.md) · [License](#license)

---

## What is evenfire

evenfire runs LLM agents on **your** infrastructure. Agents converse over
Telegram, Email, and Slack, call tools through the
[Model Context Protocol](https://modelcontextprotocol.io) (MCP), and execute
multi-step workflows — while risky actions wait for a human “yes.” Agents,
connectors, channels, and workflows are declared as Kubernetes custom
resources, so your fleet is version-controlled, reviewable configuration. You
bring your own model keys; prompts and data stay in your environment.

Try the agent runtime in two commands with Docker Compose (no Kubernetes
required), then deploy the full platform to any cluster when you need
NetworkPolicies, the control plane, and multi-host ops.

> **Naming:** the code uses the project’s internal name **clerum** —
> `clerum.io` CRDs, `CLERUM_*` env vars, `clerum-*` packages. **evenfire** is
> the public name of the same project. Details:
> [docs/concepts/code-names.md](docs/concepts/code-names.md).

---

## Features

- **Multi-channel agents** — one agent over Telegram, Email (IMAP), and Slack,
  with per-channel allowed-sender filters (`CommunicationChannel` CRD).
- **Human-in-the-loop approvals** — MCP tool calls require explicit approve/deny
  by default; desktop app or Slack/Telegram; pending approvals survive pod
  restarts. Per-tool policy is configurable on the `Host` CRD.
- **Governed connectors** — a `Context` lists which MCP servers an agent may
  reach; everything unlisted is unreachable at the network layer.
- **First-class MCP** — provision servers declaratively (`McpServer` CRD, HTTP
  and stdio); expose agents over MCP. Not a per-vendor wrapper.
- **Declarative workflow engine** — `WorkflowRecipe` CRDs compose Deployments,
  StatefulSets, and CronJobs with auto-registered MCP servers and scoped tokens.
- **Model-neutral, bring-your-own-keys** — four providers (OpenAI, Claude, Z.AI,
  Bailian) behind one interface; switching is a config change. Bailian can
  surface Qwen / GLM / Kimi / MiniMax models via that provider.
- **Built-in context management** — deterministic pre-pruning and tiered
  compaction (configurable per deployment; not always-on by default).
- **Shared file systems** — per-team workspaces mounted **read-only** into
  agent pods; brokered global drive with permission-store authorization and a
  tamper-evident audit log.
- **Usage & cost visibility** — per-request token accounting in the control
  plane (control-api / control-ui), price tables, and token budgets. Budgets are
  cost control (fail-open), not a security boundary.
- **Governed registry** — publish and install connectors and workflow recipes
  with trust labels and publisher keys.
- **Desktop app** — Electron client for chat, live approvals, files, and
  workflow monitoring.

---

## Quickstart

No Kubernetes required. Run the agent runtime (`mcp-host`) and send a message.

```bash
cp .env.quickstart.example .env.quickstart   # add ONE LLM API key
docker compose --env-file .env.quickstart up mcp-host
```

When healthy:

```bash
./scripts/dev/quickstart-chat.sh "Hello! What can you help with?"
```

**Optional — Telegram:** set `CLERUM_TELEGRAM_BOT_TOKEN` and
`TELEGRAM_ALLOWED_USER_ID` in `.env.quickstart`, then:

```bash
docker compose --env-file .env.quickstart --profile telegram up
```

> **Quickstart limitations**
>
> - The runtime authenticates callers with platform edge trust headers (the
>   helper script sets them) — the same mechanism production uses, where
>   NetworkPolicy restricts who can reach `mcp-host` and short-lived JWTs
>   authenticate the hops into the edge services themselves.
> - No MCP servers by default. Wire tools with `CLERUM_MCP_SERVERS` — see
>   `.env.quickstart.example`.
> - Full approvals UX, Control UI, and default-deny networking need the
>   Kubernetes stack.

Walkthrough: [docs/get-started/quickstart.md](docs/get-started/quickstart.md).  
Full platform: [docs/deploy/minikube.md](docs/deploy/minikube.md) ·
[docs/deploy/production.md](docs/deploy/production.md).

---

## How it works

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
`mcp-host` runs the agent state machine, calls your LLM, and executes MCP tools
— pausing for human approval when policy requires it.
`host-context-controller` turns CRDs into Deployments, Services, and
NetworkPolicies.

Deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[docs/architecture/overview.md](docs/architecture/overview.md).

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

- **Context management** — deterministic pre-prune (dedup, oversized-output
  trimming) plus tiered compaction under pressure; configurable, not assumed
  always-on.
- **Shared file systems** — `SharedFileSystem` (read-only to agents) and
  `GlobalFileSystem` (brokered API, permission store, tamper-evident audit).
- **Usage & cost** — authoritative token usage in control-api; dashboards and
  budgets in control-ui (not the Grafana/Loki stack under `monitoring/`).
- **Governed registry** — connectors and recipes with trust labels.
- **Observability** — Prometheus metrics across services; optional Grafana +
  Loki log aggregation in [monitoring/](monitoring/README.md).

---

## Running on Kubernetes

### Custom Resource Definitions (8)

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

Reference: [docs/crds/README.md](docs/crds/README.md).  
Local full stack: [docs/deploy/minikube.md](docs/deploy/minikube.md).

---

## Supported LLM providers

| Provider         | `provider` value | Default model       |
| ---------------- | ---------------- | ------------------- |
| OpenAI           | `openai`         | `gpt-5.4-mini`      |
| Anthropic Claude | `claude`         | `claude-sonnet-4-6` |
| Z.AI             | `zai`            | `glm-5.1`           |
| Alibaba Bailian  | `bailian`        | `qwen3-coder-plus`  |

Four providers behind one interface; OpenAI-compatible endpoints can plug in as
registry descriptors where the code supports it. Keys live in a Kubernetes
Secret you create (dev mode: environment variables). Details:
[mcp-host/README.md](mcp-host/README.md).

---

## Repository layout

| Area                    | Component                                                                                                                                              | Role                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **Agent runtime**       | [mcp-host/](mcp-host/README.md)                                                                                                                        | LLM loop, approvals, MCP tools           |
|                         | [channel-reader/](channel-reader/README.md)                                                                                                            | Telegram / Email / Slack ingress         |
|                         | [mcp-proxy/](mcp-proxy/README.md), [stdio-bridge/](stdio-bridge/README.md)                                                                             | MCP routing / stdio bridge               |
|                         | [mcp-servers/](mcp-servers/README.md)                                                                                                                  | Sample connector specs (upstream images) |
| **Operators**           | [host-context-controller/](host-context-controller/README.md)                                                                                          | CRDs → Deployments + NetworkPolicies     |
|                         | [workflow-recipes/](workflow-recipes/README.md)                                                                                                        | WorkflowRecipe operator                  |
|                         | [gfs-controller/](gfs-controller/), [workspace-files-controller/](workspace-files-controller/)                                                         | File planes                              |
| **Edge & security**     | [rpc-proxy/](rpc-proxy/README.md), [external-rest-api/](external-rest-api/README.md)                                                                   | JWT edge, profiles/tokens                |
|                         | [webhook-gateway/](webhook-gateway/), [webhook-proxy/](webhook-proxy/), [nginx-egress-proxy/](nginx-egress-proxy/)                                     | Ingress / egress hardening               |
|                         | [workflow-approval-request-reader/](workflow-approval-request-reader/)                                                                                 | Channel approval callbacks               |
| **Control plane & UIs** | [control-api/](control-api/README.md), [control-ui/](control-ui/README.md), [profile-ui/](profile-ui/README.md), [desktop-app/](desktop-app/README.md) | Admin, profile, desktop                  |
| **Platform**            | [charts/clerum-crds/](charts/clerum-crds/README.md), [deploy/](deploy/), [packages/](packages/), [monitoring/](monitoring/README.md)                   | CRDs, manifests, shared libs, log stack  |

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

evenfire is licensed under **Apache-2.0 with an additional use grant** (no
operating a competing managed multi-tenant service). It is **source-available**,
not OSI open source. Self-hosting for your own organization and internal
commercial use are permitted. See [LICENSE](LICENSE) and [TRADEMARK.md](TRADEMARK.md).
