# Evenfire — Infrastructure Requirements & Pre-Deployment Questionnaire

**Audience:** platform / infrastructure / security teams evaluating a self-hosted
Evenfire deployment.

Evenfire is a Kubernetes-native platform. The platform services, agents,
connectors, and data run **inside your own cluster**, under your own network and
identity controls. Prompts and files go to the model provider whose key you
supply.

Two optional features call Evenfire-hosted services, and you decide whether to
use them:

- **Hosted member invitations and admin password-reset emails** use
  `registration.evenfire.ai`. The recipient's email address and the link
  metadata leave your cluster.
- **The connector and workflow-recipe registry** is `registry.evenfire.ai`.

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

The full stack has run on **6 vCPU / 10 GB RAM** in a single-node local evaluation.
Treat that as the floor for a smoke test, not as a sizing for real users.

Beyond that, capacity scales with usage: **each agent and each connector runs as its
own pod**. The platform services themselves are small; the variable cost is agents,
connectors, and workflows, which you control through configuration.

| Environment | Guidance |
| ----------- | -------- |
| Evaluation / PoC | 6 vCPU, 10 GB RAM available to the workload — a single node. |
| Pilot (5–20 agents) | 3 nodes, 8 vCPU / 16 GB RAM each — headroom plus node-level HA. |
| Production | Sized from your answers in Part 2 (agent count, users, workflow volume), spread across ≥2 availability zones. |

### 3. Storage

- A **block (ReadWriteOnce) StorageClass marked as the cluster default**. The
  platform database, agent workspaces, the global file drive, and per-workflow
  output volumes all use it. Workflow output volumes request no class, so a
  default StorageClass is required.
- A shared (ReadWriteMany) class such as EFS or NFS is **not** required for a new
  install.
- Your usual backup policy applied to those volumes.

### 4. Database

PostgreSQL 16. A single-instance in-cluster database ships with the install and
is suitable for evaluation and pilots, backed up through your volume snapshot
policy. Running on a managed PostgreSQL (RDS, Cloud SQL, Azure Database) is
possible but needs a reviewed migration and provisioning procedure: today's
install scripts provision database roles from inside the in-cluster instance.
Tell us early if a managed database is a requirement.

### 5. How users reach the platform

You provide **DNS names and TLS certificates** for the admin console, the user
profile page, and the endpoint the Desktop App connects to. Two supported patterns:

1. **Cloudflare Tunnel** — ships with the install; no inbound firewall holes and no
   public load balancer. Needs a Cloudflare account.
2. **Your own ingress controller and load balancer**, with your certificates. The
   shipped NetworkPolicies only admit the tunnel by default, so the install adds
   policies for your load balancer's source ranges or controller pods.

The platform can be public, VPN-only, or internal — your choice. One caveat: the
hosted invitation email path (`registration.evenfire.ai`) needs the console and
profile URLs to be real, publicly resolvable domains.

### 6. Outbound access

Runtime namespaces start deny-all, so every outbound destination is opened
explicitly. Please confirm you can allow:

| Destination | Purpose |
| ----------- | ------- |
| Your LLM provider endpoint(s) | Model calls — or nothing at all, if you point at a self-hosted model |
| `ghcr.io` | Pulling the platform images (all public on GitHub Container Registry) |
| Docker Hub | Pulling the pinned third-party images the install uses (PostgreSQL, nginx, busybox, cloudflared) — or mirror them |
| `registry.evenfire.ai` | Installing connectors and workflow recipes from the registry (optional) |
| `registration.evenfire.ai` | Hosted member invitations and admin password-reset emails (optional) |
| Channel APIs — Telegram, Slack, your IMAP/SMTP host | Only the channels you enable |
| Per-connector SaaS hosts | Allowed as port/CIDR egress rules derived from each connector's declared hosts, with documented FQDN limits (hostnames resolve to IP addresses; they are not a per-domain allowlist) |

Tell us early if the cluster's outbound traffic must go through a corporate HTTP
proxy or if the environment is air-gapped. Neither is a supported install path
today, and both need a specific assessment (image mirroring, registry access,
model endpoint reachability).

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
adequate rate limits, and a budget owner. Evenfire meters token spend and can block
on budget, but budgets are cost control, not a security boundary: if the budget
service is unreachable, requests are allowed (fail-open). Keep provider-side
spend limits as well.

### 9. Desktop app distribution

The Desktop App is installed on user machines, not in the cluster (macOS, Windows,
Linux; x64 and arm64). If you distribute internally you will want code-signing
certificates and an MDM or software-distribution channel.

### 10. Operations

The repository includes Helm values and dashboards for an optional Grafana + Loki
logging stack that you install and operate; if you already run Prometheus,
Datadog, or Splunk, plan to collect container logs with those instead. Plan for log retention —
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
| 3 | **Storage and database**: which StorageClasses exist, which one is the **default**, and is a managed PostgreSQL a hard requirement? | A default block StorageClass is required. A managed database needs a separate reviewed procedure, so we need to know up front. |
| 4 | **Scale**: how many agents and concurrent users in the first 3 months, and which connectors (databases, SaaS, internal APIs) do you need? | Each agent and connector is its own pod — this is what sizing is computed from. |
| 5 | **Exposure**: should users reach the platform over your internal network, VPN, or the public internet? Who owns DNS and TLS, and do you prefer Cloudflare Tunnel (shipped) or your own ingress controller? | Determines the entire edge design and what we need from your network team. |
| 6 | **Egress**: is outbound internet allowed from the cluster, only through a proxy, or not at all? What is the allowlisting process and lead time? | Model APIs, image pulls (GHCR and Docker Hub), and connector hosts all need explicit allowlisting; proxy-only and air-gapped environments need a specific assessment. |
| 7 | **Models**: which LLM provider(s) will you use, do you already hold keys, and is there a requirement to stay in-region or self-hosted (Bedrock, Vertex, Azure OpenAI, vLLM)? Who owns the budget? | You bring your own keys; residency constraints decide provider and region. |
| 8 | **Channels**: which do you want live at launch — Desktop App, Slack, Microsoft Teams, Telegram, email — and who approves the bot/app installation? | App approval is usually the longest lead-time item in a rollout. |
| 9 | **Security and compliance**: how do you manage secrets, what identity requirements apply to administrators (Control UI admins sign in with local username and password today), which compliance regimes apply, and which agent actions must always require human approval? | Shapes the secrets integration, the admin access model, the approval policy, and the audit/SIEM export. |
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
