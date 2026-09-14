# Evenfire on existing Amazon EKS — agent how-to

**Audience:** a coding agent the customer has given this file (or the
`evenfire-aws-eks` skill). Humans: paste the prompt in the skill and approve
spend, secrets, and DNS when the agent stops.

**Starting state:** an existing EKS cluster (Kubernetes 1.30+). This guide does
**not** create a VPC, account, or cluster.

**Honesty:** this OSS tree has no certified `deploy/overlays/aws`. Do not add
one here. Do not clone the private infra repo (wrong CIDRs, credentials, and
**private registry SHAs**). Compose a **customer-local** overlay from
`deploy/base` + the GHCR component **on the last official release tag**.

**Images:** only `ghcr.io/evenfire-ai/<image>:<official-release>`. Last official
release is **`v0.8.0`** (the `newTag` in
`deploy/components/ghcr-images/kustomization.yaml` on that git tag). Never
`latest`, never `sha-<git>`, never Artifact Registry / ECR unless the human
named a private mirror of **that same release**.

Skill entry point: [`.agents/skills/evenfire-aws-eks/SKILL.md`](../../.agents/skills/evenfire-aws-eks/SKILL.md).

---

## 1. How to use this document

1. Pin `CONTEXT`, `AWS_PROFILE`, and `AWS_REGION` in the shell. Every `kubectl`
   and `aws` call uses them. Current kube-context is not load-bearing.
2. Run phases in order. Stop on any hard fail; print the reason.
3. Ask the human before billed AWS resources, Secret writes, DNS/TLS changes,
   or JWT regeneration.
4. Do not print Secret values, DSNs, or private keys.

```bash
export CONTEXT='<eks-kubeconfig-context>'          # e.g. arn:aws:eks:…:cluster/my-eks
export AWS_PROFILE='<named-profile>'
export AWS_REGION='<region>'
export CLUSTER_NAME='<eks-cluster-name>'
alias k='kubectl --context "$CONTEXT"'
```

Customer prompt:

```text
Using the evenfire-aws-eks skill, deploy Evenfire into my existing EKS cluster.
Pin kubectl --context and AWS_PROFILE/AWS_REGION on every command. Do not create
a cluster. Ask before any paid AWS resource or Secret write. Stop if
NetworkPolicies are not enforced.
```

---

## 2. Mission and hard limits

**Done means:** Evenfire is running on the named EKS cluster, required
Deployments are Ready, Control UI is reachable (HTTPS or agreed port-forward),
and a bootstrap Host exists. Hand over the block in
[verify.md](../../.agents/skills/evenfire-aws-eks/references/verify.md).

**Out of scope:** new clusters, org/account setup, Desktop code signing, Slack
or Teams app review, cloning `evenfire-infra`.

| Always | Ask first | Never |
| --- | --- | --- |
| Pin `--context` / AWS profile | EFS, RDS, ALB/NLB, other spend | Create/replace the cluster or VPC |
| Checkout public repo **at `v0.8.0`** | LLM keys, JWT regen, admin password | Apply `deploy/overlays/minikube*` |
| Images `ghcr.io/evenfire-ai/*:v0.8.0` | Public DNS / TLS | `latest`, `sha-*`, private registry SHAs |
| Detect API ClusterIP **and** endpoints | | Clone evenfire-infra or copy gcp overlays |
| `kubectl patch` for live tokens | | `CLERUM_DEV_MODE=true` |
| Fail closed | | Commit secrets; invent CIDRs |

---

## 3. Inputs the human must supply

Partial answers are fine — stop and ask for anything blank that blocks a phase.

| Input | Why |
| --- | --- |
| AWS profile, region, EKS cluster name | Identity and `update-kubeconfig` |
| kubeconfig context name | Pin every `kubectl` |
| cluster-admin (or equivalent) for the first install | CRDs, ClusterRoles |
| DNS names for app / profile / api / rpc / webhook, **or** “internal only” | CORS, OAuth, invitations |
| Ingress: existing ALB/controller **or** Cloudflare Tunnel | Opt-in `deploy/base/ingress` |
| Postgres: in-cluster 16 (eval) **or** RDS 16 | Storage vs DSN |
| LLM provider + key (paste into a Secret, not git) | Model calls |
| Whether `registry.evenfire.ai` is required | Optional; skip credentials if unused |
| Confirmation that NetworkPolicies are actually enforced | Isolation is the security control |

Sizing floor: **6 vCPU / 10 GB RAM** available to the workload
([client-infrastructure-requirements.md](client-infrastructure-requirements.md)).

---

## 4. Phase 0 — Discover, do not mutate

```bash
aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION"
aws eks describe-cluster --name "$CLUSTER_NAME" --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'cluster.{status:status,version:version,platform:platformVersion}' --output table
k config get-contexts
k version --short
k get nodes -o wide
k get sc
k get ns
```

**Stop if:**

- Caller identity or cluster name is not what the human named
- Kubernetes **< 1.30**
- Nodes cannot cover 6 vCPU / 10 GB even for an eval
- You cannot list namespaces (wrong context / RBAC)

### NetworkPolicy enforcement (hard stop)

Evenfire default-deny is meaningless if the CNI ignores NetworkPolicy.

```bash
k get pods -n kube-system
# Look for: aws-node (VPC CNI), calico-node, cilium, or amazon-vpc-cni NetworkPolicy agent
aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name vpc-cni \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" 2>/dev/null || true
k get networkpolicy -A | head
```

If there is no policy-capable CNI, **stop**. Ask the human before installing
Amazon VPC CNI network policy, Calico, or Cilium. Do not apply Evenfire
manifests onto a cluster that will silently skip isolation.

Also note Kyverno / Gatekeeper / restricted Pod Security / a service mesh —
admission rules can block the install. Review; do not disable them yourself.

### Storage

```bash
k get sc
k get nodes --no-headers | wc -l
```

Need:

- An RWO block class (`gp2` / `gp3` / `ebs.csi.aws.com`)
- **RWX** if node count ≥ 2 (EFS CSI). Single-node eval may use RWO for
  workflow output (same compromise as a single-node GKE node).

---

## 5. Phase 0.5 — Cluster coordinates

Detect and **write into the overlay**. Never paste GKE or minikube CIDRs.

```bash
k get svc kubernetes -n default -o jsonpath='ClusterIP={.spec.clusterIP}{"\n"}'
k get endpoints kubernetes -n default -o jsonpath='Endpoints={.subsets[*].addresses[*].ip}{"\n"}'
# If Endpoints is empty (k8s 1.33+), list EndpointSlices for service kubernetes
k get endpointslices -n default -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses}{"\n"}{end}'

k -n kube-system get svc kube-dns -o jsonpath='kube-dns={.spec.clusterIP}{"\n"}'
k -n kube-system get ds node-local-dns 2>/dev/null || echo 'no node-local-dns'
```

Keep both API ClusterIP and every endpoint as `/32`. HCC rejects CIDRs broader
than IPv4 `/24`. Details:
[overlay-contract.md](../../.agents/skills/evenfire-aws-eks/references/overlay-contract.md),
[quirks.md](../../.agents/skills/evenfire-aws-eks/references/quirks.md).

---

## 6. Phase 1 — Add-ons only if missing

Ask before anything that costs money.

### NetworkPolicy CNI

If Phase 0 found no enforcement, install the customer's chosen CNI (VPC CNI
network-policy addon, Calico, or Cilium) and **re-check** before continuing.
Enabling enforcement can bounce nodes on some distributions — say so up front.

### EFS CSI (multi-node RWX)

If node count ≥ 2 and no RWX StorageClass:

1. Confirm the EFS CSI addon or controller is installed
2. Ask before creating a file system + mount targets + StorageClass
3. Record the StorageClass name for `clerum-workflow-output`

### AWS Load Balancer Controller

Only if they chose ALB/NLB and it is not already present. Cloudflare Tunnel
needs **no** public load balancer.

---

## 7. Phase 2 — Data plane

**Evaluation / first install:** keep in-cluster `postgres:16-alpine` on an RWO
gp2/gp3 PVC (`control-postgres-data`). That is what `deploy/base` ships.

**RDS PostgreSQL 16:** human gate. Evenfire consumes a connection string; wiring
it means a Secret + overlay (do not leave the OSS default DSN in the ConfigMap).
Ask; do not create RDS unprompted.

LLM keys and channel tokens stay in Kubernetes Secrets (or the customer's
existing External Secrets / Secrets Manager setup). Do not invent IRSA for
Bedrock — the documented Bedrock path is static access keys in a Secret
([llm-providers.md](llm-providers.md)).

---

## 8. Phase 3 — Customer overlay then Evenfire install

Working tree: the public repo **at git tag `v0.8.0`**. Overlay directory
**must** be `deploy/overlays/aws-eks` so
`verify-networkpolicies.sh --overlay aws-eks` resolves.

```bash
git clone --branch v0.8.0 https://github.com/evenfire-ai/evenfire.git
cd evenfire
test "$(git describe --tags --exact-match)" = v0.8.0
test "$(grep newTag deploy/components/ghcr-images/kustomization.yaml | sort -u | wc -l)" = 1
grep -m1 newTag deploy/components/ghcr-images/kustomization.yaml   # must print v0.8.0
```

Do not commit that overlay to `evenfire-ai/evenfire`. Follow
[overlay-contract.md](../../.agents/skills/evenfire-aws-eks/references/overlay-contract.md).

If any image pull returns `MANIFEST_UNKNOWN` for `v0.8.0`, **stop** — do not
switch to `latest`.

### 3.1 Namespaces

```bash
k apply -f deploy/base/namespaces.yaml
# If using Cloudflare Tunnel:
# k apply -f deploy/base/ingress/namespace.yaml
```

Base namespaces: `channels`, `control-plane`, `mcp-host`, `mcp-server`,
`llm-hooks`, `profiles`, `rpc-proxy`, `sandbox-recipes`, `sandbox-ui`,
`webhook-ingress`, `gfs`. Ingress is opt-in.

### 3.2 CRDs

```bash
helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds
k apply -f ./charts/clerum-crds/crds/
```

Helm 3 does not upgrade CRDs on `helm upgrade`. Always re-apply the YAML.
CRDs before control-api before UIs.

### 3.3 RBAC

```bash
CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh
```

### 3.4 JWT keys (once)

```bash
# Skip if k get secret control-api-secrets -n control-plane already exists
# Human chooses the admin password; bcrypt it, then:
ADMIN_BOOTSTRAP_PASSWORD_HASH='<bcrypt>' \
  CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh
```

Without `ADMIN_BOOTSTRAP_PASSWORD_HASH` the script writes a placeholder that
**cannot log in**. See quirks.md.

### 3.5 Remaining secrets (patch, not apply)

LLM keys: `kubectl --context "$CONTEXT" -n mcp-host create secret generic …`
or `patch --type=merge` if the canary exists. Do not put keys in kustomize.

### 3.6 Inter-service tokens

```bash
CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh
```

Preserves existing values. Hosted member-registration mode must not also set
legacy HMAC kid/tenant env vars.

### 3.7 DB migration gate

```bash
CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/run-control-api-db-migration.sh \
    --overlay deploy/overlays/aws-eks
```

### 3.8 Apply the overlay

```bash
kubectl kustomize deploy/overlays/aws-eks | k apply -f -
```

Prefer server-side apply if the customer already uses it; otherwise client apply
is what the public scripts use. Wait for HCC Ready **before** expecting WRC
external egress to converge. Roll `control-api` and `control-ui` together.

### 3.9 JWT public key sync

```bash
bash scripts/minikube/sync-auth-key.sh --context "$CONTEXT"
```

(The path is under `scripts/minikube/` but `--context` is generic.)

### 3.10 GFS runtime

```bash
# Ask the human before --allow-prod on a production-like cluster name
bash deploy/scripts/provision-gfs-runtime.sh \
  --context "$CONTEXT" \
  --overlay deploy/overlays/aws-eks
```

### 3.11 NetworkPolicies

```bash
bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"
```

Must not still render `10.109.0.1/32`.

Before flipping enforcement to `required` / confirmed:

```bash
CONTEXT="$CONTEXT" bash deploy/scripts/np-enforce-preflight.sh
```

### 3.12 CRD instances

Apply Host / Context / CommunicationChannel / GlobalFileSystem from
`deploy/overlays/aws-eks/instances/` **after** services are Ready. Do not copy
minikube fake-Telegram instances.

### 3.13 Restart ConfigMap consumers

If you patched ConfigMaps after pods started, rolling-restart those Deployments
so they pick up keys and URLs.

### 3.14 Ingress

**Cloudflare Tunnel:** include `../../base/ingress`, supply `cloudflared-config`
(hostname → in-cluster Service map), patch tunnel credentials with
`kubectl patch` (not git). Tunnel login is interactive — the **human** must
authorize. Outbound 7844 only; no public LB.

**Existing ALB / ingress:** do not include `deploy/base/ingress`. Create Ingress
or HTTPRoute objects that match the five hostnames. Wire CORS/URLs to those
origins. For `rpc`, keep chunked encoding (SSE).

---

## 9. Phase 4 — Prove it

Follow [verify.md](../../.agents/skills/evenfire-aws-eks/references/verify.md).
Print the handover block. User-facing HTTPS is mandatory when they asked for
public DNS; port-forward is acceptable for an internal-only pilot if they said so.

---

## 10. Stop-and-ask-human gates

Stop (do not work around) when:

- Wrong AWS account, region, or kube context
- CNI does not enforce NetworkPolicy
- No RWO class, or multi-node cluster with no RWX and no permission to add EFS
- GHCR `v0.8.0` missing (`MANIFEST_UNKNOWN`) — stop; do not use `latest`
- Admission webhook / Pod Security would require weakening policy
- `FORCE_REGEN` on JWT keys of a cluster that already has users
- Overlay still contains `10.109.0.1/32` or `clerum/*:test` image tags
- HCC crash-loop mentioning `CONTEXT_MAPPER_K8S_API_CIDRS`

---

## Appendix A — Namespace map

| Namespace | Role |
| --- | --- |
| `control-plane` | control-api, control-ui, HCC, WRC, in-cluster Postgres |
| `profiles` | profile-ui, external-rest-api |
| `mcp-host` | agent runtime (deny-all; static NPs) |
| `mcp-server` | connector pods (HCC) |
| `rpc-proxy` | Desktop JWT edge |
| `channels` | channel-reader, approval reader |
| `sandbox-recipes` | WorkflowRecipe objects and most recipe workloads |
| `sandbox-ui` | recipe UIs |
| `webhook-ingress` | webhook-proxy |
| `gfs` | global file broker |
| `llm-hooks` | optional guardrail hooks |
| `ingress` | cloudflared (opt-in) |

Code/API group is still `clerum.io` / `CLERUM_*`. Public name is evenfire.

## Appendix B — GHCR images (official release)

Source of truth: `deploy/components/ghcr-images/kustomization.yaml` **on git
tag `v0.8.0`**. Every `newTag` is `v0.8.0`. Typical set: `channel-reader`,
`workflow-approval-request-reader`, `control-api`, `control-ui`,
`external-rest-api`, `host-context-controller`, `mcp-host` / `mcp-host-slim`,
`mcp-proxy`, `gfs-controller`, `nginx-egress-proxy`, `profile-ui`, `rpc-proxy`,
`workflow-recipes`, `workflow-coordinator`, `workflow-snippet-runner`,
`stdio-bridge`, `workspace-files-controller`, `webhook-gateway`,
`webhook-proxy`, `codex-llm-proxy`.

Coordinate: `ghcr.io/evenfire-ai/<name>:v0.8.0`. Allowlist `ghcr.io` on cluster
egress. Do not mix tags. Do not use minikube's `MINIKUBE_IMAGE_TAG=latest`.

## Appendix C — Egress allowlist

Runtime namespaces start deny-all. Confirm the customer can allow:

| Destination | Purpose |
| --- | --- |
| LLM provider endpoint(s) | Model calls (or none, if self-hosted) |
| `ghcr.io` | Platform images |
| `registry.evenfire.ai` | Optional connectors / recipes |
| `registration.evenfire.ai` | Optional hosted invitations |
| Cloudflare `7844` | Only if using the Tunnel |
| Channel APIs | Only the channels they enable |

## Appendix D — What not to copy from minikube

- `fake-telegram/`
- `storageClassName: standard` (hostPath)
- `127.0.0.1` Control/Profile URLs
- `MINIKUBE_*` Make targets as the production installer
- Regenerating keys on every setup
- `CLERUM_DEV_MODE`

Order-of-operations in [minikube.md](minikube.md) is still the dependency
graph: namespaces → CRDs → keys → secrets → images (here: GHCR pin) → apply →
verify.

## Related

- [Production checklist](production.md)
- [Infrastructure questionnaire](client-infrastructure-requirements.md)
- [Platform topology](../architecture/platform-topology.md)
- [Member invitations](../how-to/member-invitations-self-hosted.md)
- [LLM providers](llm-providers.md)
- [Claims guardrails](../meta/claims-guardrails.md)
