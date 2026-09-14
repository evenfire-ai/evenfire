# Evenfire — Infrastructure Requirements & Pre-Deployment Questionnaire

**Audience:** platform / infrastructure / security teams evaluating a self-hosted
Evenfire deployment.

Evenfire is a Kubernetes-native platform. It runs **entirely inside your own
cluster**, under your own network and identity controls. There is no Evenfire
SaaS in the request path: your prompts, files, and data go only to the model
provider whose key you supply.

This document has two parts:

- **Part 1 — Requirements:** what must exist on your side before an install can start.
- **Part 2 — Questionnaire:** what we need to know about your environment to size,
  plan, and (optionally) run the deployment for you.

> Reference material: [production deployment guide](production.md) ·
> [EKS agent how-to](aws-eks-agent-guide.md) (existing Amazon EKS) ·
> [platform topology](../architecture/platform-topology.md) ·
> [minikube walkthrough](minikube.md) (order-of-operations reference).

---

## Part 1 — What you need on your side

### 1. A Kubernetes cluster

- **Kubernetes 1.30 or later.** Any conformant cluster works: EKS, GKE, AKS,
  OpenShift, Rancher/RKE2, k3s, or bare metal.
- **A CNI that enforces NetworkPolicies** (Calico, Cilium, or equivalent). This is
  non-negotiable: Evenfire isolates every agent with default-deny networking, and a
  CNI that ignores NetworkPolicies silently removes that control.
- **`cluster-admin` for the initial install** (CRDs, operators, RBAC). Day-to-day
  operation runs on scoped service accounts.
- The cluster can be dedicated or shared. If you run a policy engine (Kyverno,
  Gatekeeper, restricted Pod Security) or a service mesh, we should review the rules
  before installing.

### 2. Compute

The whole platform runs on **6 vCPU / 10 GB RAM** — that is the documented minimum
for the full stack, and it is enough for evaluation and small pilots.

Beyond that, capacity scales with usage: **each agent and each connector runs as its
own pod**. The platform services themselves are small; the variable cost is agents,
connectors, and workflows, which you control through configuration.

| Environment | Guidance |
| ----------- | -------- |
| Evaluation / PoC | 6 vCPU, 10 GB RAM available to the workload — a single node. |
| Pilot (5–20 agents) | 3 nodes, 8 vCPU / 16 GB RAM each — headroom plus node-level HA. |
| Production | Sized from your answers in Part 2 (agent count, users, workflow volume), spread across ≥2 availability zones. |

### 3. Storage

- A **standard block StorageClass** for the platform database.
- A **shared (ReadWriteMany) StorageClass** for workflow output volumes — NFS, EFS,
  Azure Files, Filestore, CephFS, or Longhorn all work. This is the most common gap:
  many clusters ship only block storage.
- Your usual backup policy applied to those volumes.

### 4. Database

PostgreSQL 16. A ready-to-run instance ships with the install, which is fine for
evaluation and small deployments. For production we recommend your **managed
PostgreSQL** (RDS, Cloud SQL, Azure Database, or your own HA cluster) — Evenfire
takes a connection string, so that is a configuration change, not a code change.

### 5. How users reach the platform

You provide **DNS names and TLS certificates** for the admin console, the user
profile page, and the endpoint the Desktop App connects to. Two supported patterns:

1. **Cloudflare Tunnel** — ships with the install; no inbound firewall holes and no
   public load balancer. Needs a Cloudflare account.
2. **Your own ingress controller and load balancer**, with your certificates.

The platform can be public, VPN-only, or internal — your choice. One caveat: the
zero-config invitation email path needs the console and profile URLs to be real,
publicly resolvable domains.

### 6. Outbound access

Runtime namespaces start deny-all, so every outbound destination is opened
explicitly. Please confirm you can allow:

| Destination | Purpose |
| ----------- | ------- |
| Your LLM provider endpoint(s) | Model calls — or nothing at all, if you point at a self-hosted model |
| `ghcr.io` | Pulling the platform images (all public on GitHub Container Registry) |
| `registry.evenfire.ai` | Installing connectors and workflow recipes from the registry (optional) |
| Channel APIs — Telegram, Slack, your IMAP/SMTP host | Only the channels you enable |
| Per-connector SaaS hosts | Each connector declares its own hosts; egress is pinned to those, never the open internet |

A corporate egress proxy is fine — connector traffic already routes through a pinned
proxy and can be chained. Fully air-gapped installs are possible; tell us early.

### 7. Secrets and keys

LLM keys, channel tokens, and connector credentials live in Kubernetes Secrets. We
can integrate with Vault, External Secrets, or your cloud secret manager if that is
your standard. The install also generates a JWT signing keypair for the auth chain —
decide where that private key lives and who can rotate it.

### 8. An LLM provider

**You bring your own key.** OpenAI, Anthropic, Vertex, Bedrock, Azure OpenAI,
Mistral, Groq, DeepSeek, xAI, OpenRouter, Gemini and more are supported
([full list](llm-providers.md)) — or point at a self-hosted, OpenAI-compatible
endpoint so nothing leaves your environment at all. You need an account, a key with
adequate rate limits, and a budget owner; Evenfire meters spend and can hard-block on
budget.

### 9. Desktop app distribution

The Desktop App is installed on user machines, not in the cluster (macOS, Windows,
Linux; x64 and arm64). If you distribute internally you will want code-signing
certificates and an MDM or software-distribution channel.

### 10. Operations

Optional Grafana + Loki logging ships with the platform; if you already run
Prometheus, Datadog, or Splunk, we wire into those instead. Plan for log retention —
approvals and file access are audited, and that audit trail is usually what your
compliance team asks for.

You need at least one person or team who can administer the cluster, manage DNS and
TLS, and approve network changes. If **we** run the deployment, see question 10 in
Part 2.

---

## Part 2 — Questionnaire

Ten questions. Partial answers are fine — "don't know yet" tells us where to help.

| # | Question | Why we ask |
| - | -------- | ---------- |
| 1 | **Kubernetes**: do you run it in production today? Which distribution and version, and will Evenfire get a dedicated cluster or a namespace set on a shared one? | Confirms the 1.30+ floor and whether we share capacity and policies with your other workloads. |
| 2 | **Networking policy**: which CNI, and are NetworkPolicies actually enforced? Do you run a policy engine (Kyverno, Gatekeeper, restricted Pod Security) or a service mesh? | Default-deny isolation is the primary security control; a non-enforcing CNI removes it, and existing admission rules can block the install. |
| 3 | **Storage and database**: which StorageClasses exist, is there a **ReadWriteMany** option, and do you want the in-cluster PostgreSQL or a managed instance? | RWX is the most common gap. Managed Postgres is a config change, but we need to know up front. |
| 4 | **Scale**: how many agents and concurrent users in the first 3 months, and which connectors (databases, SaaS, internal APIs) do you need? | Each agent and connector is its own pod — this is what sizing is computed from. |
| 5 | **Exposure**: should users reach the platform over your internal network, VPN, or the public internet? Who owns DNS and TLS, and do you prefer Cloudflare Tunnel (shipped) or your own ingress controller? | Determines the entire edge design and what we need from your network team. |
| 6 | **Egress**: is outbound internet allowed from the cluster, through a proxy, or are you air-gapped? What is the allowlisting process and lead time? | Model APIs, image pulls, and connector hosts all need explicit allowlisting; air-gapped changes registry and update strategy. |
| 7 | **Models**: which LLM provider(s) will you use, do you already hold keys, and is there a requirement to stay in-region or self-hosted (Bedrock, Vertex, Azure OpenAI, vLLM)? Who owns the budget? | You bring your own keys; residency constraints decide provider and region. |
| 8 | **Channels**: which do you want live at launch — Desktop App, Slack, Microsoft Teams, Telegram, email — and who approves the bot/app installation? | App approval is usually the longest lead-time item in a rollout. |
| 9 | **Security and compliance**: how do you manage secrets, do you need SSO for admins, which compliance regimes apply, and which agent actions must always require human approval? | Shapes the secrets integration, the approval policy, and the audit/SIEM export. |
| 10 | **Deployment ownership**: if we run the deployment, what access can you provide (kubeconfig, jump host, screen-share only)? Which environments do you need, what is the target go-live, and who operates it day to day afterwards? | Defines the engagement model, change process, and handover. |

---

## Suggested next steps

1. You return this questionnaire (partially filled is fine).
2. We hold a 60-minute architecture call and produce a sizing and topology proposal.
3. We run a pilot install in a non-production namespace or cluster.
4. Security review and hardening pass against the
   [production checklist](production.md#security-non-negotiables).
5. Production rollout and handover.

---

## Related

- [Production deployment guide](production.md)
- [Evenfire on existing Amazon EKS (agent how-to)](aws-eks-agent-guide.md)
- [Platform topology](../architecture/platform-topology.md)
- [LLM providers](llm-providers.md)
- [Member invitations on self-hosted](../how-to/member-invitations-self-hosted.md)
- [Security policy](../../SECURITY.md)
