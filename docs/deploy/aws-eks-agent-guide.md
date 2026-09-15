# Evenfire on existing Amazon EKS — agent how-to

**Audience:** a coding agent the customer points at this guide (or at the
`evenfire-aws-eks` skill). Humans: paste the prompt from the skill, approve
spend, secrets, and DNS when the agent stops, and do the two steps marked
**HUMAN** (admin password and LLM key) yourself.

**Starting state:** an existing EKS cluster (Kubernetes 1.30+, IPv4). This guide
does **not** create a VPC, account, or cluster.

**Validated release:** this procedure was checked line by line against the
public release **`v0.8.0`** (scripts, manifests, and a rendered, linted overlay).
It is the only place the version is written. If a newer release exists, stop and
ask the human (Phase 3.1).

**Honesty:** this OSS tree has no certified `deploy/overlays/aws`. The overlay is
customer-local and never pushed. Do not clone Evenfire's private infra repo
(wrong CIDRs, credentials, and private registry SHAs).

Skill entry point: [`.agents/skills/evenfire-aws-eks/SKILL.md`](../../.agents/skills/evenfire-aws-eks/SKILL.md).

---

## 1. How to use this document

**Two checkouts.** This guide and the skill live on the public repo's default
branch. Released tags older than this guide do not contain them.

| Directory | Git ref | Used for |
| --- | --- | --- |
| `$DOCS_DIR` | default branch | this guide, the skill, `scripts/` helpers (read and run, never edit) |
| `$REPO_DIR` | release tag `$RELEASE_TAG` | manifests, `deploy/scripts`, the customer overlay; run install commands here |

**Your shell does not keep state between commands.** Many agent harnesses start
a fresh shell per command, so exported variables and aliases vanish. Write one
env file and source it at the start of **every** command block. Never use an
alias such as `k`.

```bash
mkdir -p "$HOME/.evenfire-eks/work" && chmod 700 "$HOME/.evenfire-eks" "$HOME/.evenfire-eks/work"
cat > "$HOME/.evenfire-eks/env.sh" <<'EOF'
export CONTEXT='<eks-kubeconfig-context>'      # e.g. arn:aws:eks:<region>:<acct>:cluster/<name>
export AWS_PROFILE='<named-profile>'
export AWS_REGION='<region>'
export CLUSTER_NAME='<eks-cluster-name>'
export VALIDATED_RELEASE='v0.8.0'
export RELEASE_TAG='v0.8.0'                     # changed only with human approval (Phase 3.1)
export DOCS_DIR="$HOME/.evenfire-eks/docs"
export REPO_DIR="$HOME/.evenfire-eks/release"
export WORK="$HOME/.evenfire-eks/work"
export SKILL_SCRIPTS="$DOCS_DIR/.agents/skills/evenfire-aws-eks/scripts"
EOF
chmod 600 "$HOME/.evenfire-eks/env.sh"
. "$HOME/.evenfire-eks/env.sh"
git clone --depth 1 https://github.com/evenfire-ai/evenfire.git "$DOCS_DIR"
test -f "$SKILL_SCRIPTS/np-deny-probe.sh" || echo 'STOP: default branch has no evenfire-aws-eks skill yet'
```

Rules:

1. Every `kubectl` call passes `--context "$CONTEXT"`; every `aws` call uses the
   profile and region. Current-context is not load-bearing.
2. Run phases in order. On any failed check, stop and print the reason.
3. Ask the human before billed AWS resources, Secret writes, DNS/TLS changes, or
   anything this guide marks **ask first**.
4. Never print, echo, or pass on the command line: Secret values, passwords,
   bcrypt hashes, DSNs, private keys, tunnel credentials. Secret material goes
   through files created with `umask 077` in `$WORK` and deleted right after
   use.

---

## 2. Mission and hard limits

**Done means:** Evenfire runs on the named cluster, every Deployment from the
rendered overlay plus the HCC-spawned Host and GFS Deployments are rolled out,
NetworkPolicy deny is proven at packet level, the human has claimed the admin
account, and the handover block from
[verify.md](../../.agents/skills/evenfire-aws-eks/references/verify.md) is printed.

**Out of scope:** new clusters, account setup, IPv6 clusters, RDS migration of an
existing database, Desktop code signing, Slack/Teams app review.

| Always | Ask first | Never |
| --- | --- | --- |
| Source the env file; pin `--context` / profile | EFS, RDS, ALB/NLB, other spend | Create or replace the cluster or VPC |
| Manifests from `$REPO_DIR` at `$RELEASE_TAG` | Any Secret write | Apply `deploy/overlays/minikube*` |
| Platform images `ghcr.io/evenfire-ai/*:$RELEASE_TAG` | Public DNS / TLS / ingress exposure | `latest`, `sha-*`, private registry SHAs |
| Prove NetworkPolicy deny with the probe | Enabling or changing the CNI | `CLERUM_DEV_MODE=true` or WRC `warn` mode |
| Generate CIDR patches with the script | A release other than `$VALIDATED_RELEASE` | See, handle, or print the admin password or LLM key |
| Fail closed | Marking a StorageClass default | Expose ingress before the admin is claimed |

---

## 3. Inputs the human must supply

Stop and ask for anything blank that blocks a phase.

| Input | Why |
| --- | --- |
| AWS profile, region, EKS cluster name, kube-context name | Identity; pin every command |
| cluster-admin (or equivalent) for the first install | CRDs, ClusterRoles |
| Domain for `app` / `profile` / `api` / `rpc` / `webhook`, **or** "internal only" | CORS, OAuth callbacks, invitations |
| Ingress: AWS Load Balancer Controller (ALB/NLB), in-cluster controller, **or** Cloudflare Tunnel | Overlay variant and ingress policies |
| Postgres: in-cluster 16 (eval/pilot) **or** RDS 16 | See Phase 2 |
| LLM provider and model name (the **human** enters the key in Control UI) | Host instance |
| Member invitations: hosted mode, remote registration service, or none | HMAC secret source (5.6) |
| GlobalFileSystem size | `instances/globalfilesystem.yaml` |

Sizing: the full stack has run on 6 vCPU / 10 GB RAM in a single-node local
evaluation; that is a floor for a smoke test, not a production sizing.

---

## 4. Phase 0 — Tools, identity, discovery (read-only)

Required local tools: `kubectl` ≥ 1.30, `helm` 3, `aws` v2, `git`, `bash`, `jq`,
`ruby`, `python3`, `openssl`, `curl`. If one is missing, print the install
command for the human; do not install it silently.

```bash
. "$HOME/.evenfire-eks/env.sh"
for t in kubectl helm aws git jq ruby python3 openssl curl; do command -v "$t" >/dev/null || echo "MISSING: $t"; done
aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION"
aws eks describe-cluster --name "$CLUSTER_NAME" --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'cluster.{status:status,version:version,platform:platformVersion,ipFamily:kubernetesNetworkConfig.ipFamily}' --output table
kubectl config get-contexts "$CONTEXT"
kubectl --context "$CONTEXT" version
kubectl --context "$CONTEXT" get nodes -o wide
kubectl --context "$CONTEXT" get storageclass
kubectl --context "$CONTEXT" get namespaces
kubectl --context "$CONTEXT" get validatingwebhookconfigurations,mutatingwebhookconfigurations
```

**Stop if:**

- Caller identity, account, or cluster name is not what the human named
- `kubectl config get-contexts "$CONTEXT"` errors (context not found)
- Kubernetes < 1.30, or `ipFamily` is `ipv6`
- Nodes cannot cover the evaluation floor
- Kyverno / Gatekeeper / restricted Pod Security / a service mesh would block
  the install. Report the rule; do not disable it.

### 4.1 NetworkPolicy enforcement (hard stop)

Evenfire's isolation is default-deny NetworkPolicy. A cluster that accepts
NetworkPolicy objects but does not enforce them silently removes that control.
Listing `aws-node` pods or `NetworkPolicy` objects proves nothing: the VPC CNI
ships its policy agent container with `--enable-network-policy=false` by default,
and the API server stores policies whatever the CNI does.

**Amazon VPC CNI:**

```bash
. "$HOME/.evenfire-eks/env.sh"
aws eks describe-addon --cluster-name "$CLUSTER_NAME" --addon-name vpc-cni \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --query 'addon.{version:addonVersion,config:configurationValues}' --output json
kubectl --context "$CONTEXT" -n kube-system get daemonset aws-node \
  -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.args}{"\n"}{end}'
kubectl --context "$CONTEXT" -n kube-system get daemonset aws-node \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="aws-node")].env[?(@.name=="NETWORK_POLICY_ENFORCING_MODE")].value}{"\n"}'
```

Enforcement requires `--enable-network-policy=true` on the agent container (the
add-on sets it from `"enableNetworkPolicy": "true"`). Evenfire additionally
requires **strict mode** on the VPC CNI (`NETWORK_POLICY_ENFORCING_MODE=strict`).
In the default standard mode, a new pod starts allow-all until its policies are
programmed. AWS also documents that enforcement "might not work reliably" for
pods without `ownerReferences`, and WorkflowRecipe coordinator and
snippet-runner pods are bare pods. If either setting is missing, stop and ask.
Enabling them is a CNI change that can restart `aws-node` on every node. Say so.

**Calico or Cilium:** confirm the `calico-node` / `cilium` DaemonSet is Ready on
every node and that it is the component enforcing policy (not only chained for
IPAM).

**Then, for every CNI, run the packet-level probe.** It creates and deletes a
temporary namespace `evenfire-np-probe`. Tell the human first.

```bash
. "$HOME/.evenfire-eks/env.sh"
CONTEXT="$CONTEXT" bash "$SKILL_SCRIPTS/np-deny-probe.sh"
```

Exit 0 is the only pass. Exit 1 (not enforced) or 2 (inconclusive) is a hard
stop. Do not install Evenfire on this cluster until it passes.

### 4.2 Storage

```bash
. "$HOME/.evenfire-eks/env.sh"
kubectl --context "$CONTEXT" get storageclass \
  -o custom-columns='NAME:.metadata.name,PROVISIONER:.provisioner,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class'
```

Need an RWO block class (`gp3` or `gp2`) **marked default**. WorkflowRecipe
output PVCs carry no `storageClassName`. If no class is default, ask the human
before annotating one. EFS/RWX is not required. Details:
[overlay-contract.md § Storage](../../.agents/skills/evenfire-aws-eks/references/overlay-contract.md#storage).

---

## 5. Phase 0.5 — Cluster coordinates (read-only)

```bash
. "$HOME/.evenfire-eks/env.sh"
kubectl --context "$CONTEXT" -n default get service kubernetes -o jsonpath='{.spec.clusterIP}{"\n"}'
kubectl --context "$CONTEXT" -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[*]}{"\n"}{end}'
kubectl --context "$CONTEXT" -n kube-system get service kube-dns -o jsonpath='{.spec.clusterIP}{"\n"}'
kubectl --context "$CONTEXT" -n kube-system get daemonset node-local-dns 2>/dev/null || echo 'no node-local-dns'
```

Record: `API_IPS` = the ClusterIP plus every endpoint address; `DNS_IP`; the
NodeLocal DNSCache IP if that DaemonSet exists (from its config, usually
`169.254.20.10`). Write them into the overlay only with
`write-network-patches.sh` (Phase 4). Never paste CIDRs from GKE, minikube, or
another cluster.

For the ALB/NLB variant also record `INGRESS_CIDRS`: the subnets the load
balancer uses (IP target mode) or the node subnets (instance mode). See
[overlay-contract.md § Variant A](../../.agents/skills/evenfire-aws-eks/references/overlay-contract.md#variant-a--existing-alb--nlb--ingress-controller).

---

## 6. Phase 1 — Add-ons only if missing (ask first)

- **NetworkPolicy enforcement:** see 4.1. Re-run the probe after any change.
- **AWS Load Balancer Controller:** only for the ALB/NLB variant and only if it
  is absent. Cloudflare Tunnel needs no public load balancer.
- **EBS CSI driver / gp3 class:** only if no usable RWO class exists.

---

## 7. Phase 2 — Data plane

**Evaluation / pilot:** in-cluster `postgres:16-alpine` on the RWO class
(`control-postgres-data`), as `deploy/base` ships. Step 5.5 replaces the
superuser password that `gen-jwt-keys.sh` hard-codes. Back up the PVC with the
customer's normal EBS snapshot policy.

**RDS PostgreSQL 16:** not covered step by step. The migration and runtime-role
scripts execute `psql` inside the in-cluster `control-postgres` Deployment, so
RDS needs a separately reviewed procedure. Tell the human; do not improvise it.

LLM keys and channel tokens stay in Kubernetes Secrets and are entered by the
human in Control UI. The documented Bedrock path is static access keys in the
Host's LLM Secret ([llm-providers.md](llm-providers.md)); do not invent IRSA.

---

## 8. Phase 3 — Release checkout

### 3.1 Confirm the release

```bash
. "$HOME/.evenfire-eks/env.sh"
latest="$(git ls-remote --tags --refs https://github.com/evenfire-ai/evenfire.git \
  | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
echo "latest=$latest validated=$VALIDATED_RELEASE"
```

If `latest` differs from `VALIDATED_RELEASE`, stop and ask the human to choose:

- install `VALIDATED_RELEASE`, or
- install `latest` knowing this guide was not validated against it. In that
  case set `RELEASE_TAG` in the env file, re-read every script's usage block
  before calling it, and stop on any mismatch with this guide.

### 3.2 Clone and pin

```bash
. "$HOME/.evenfire-eks/env.sh"
git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/evenfire-ai/evenfire.git "$REPO_DIR"
cd "$REPO_DIR"
test "$(git describe --tags --exact-match)" = "$RELEASE_TAG" || { echo "STOP: not at $RELEASE_TAG"; exit 1; }
tags="$(grep -E '^[[:space:]]+newTag:' deploy/components/ghcr-images/kustomization.yaml | awk '{print $2}' | sort -u)"
test "$tags" = "$RELEASE_TAG" || { echo "STOP: ghcr-images newTag=[$tags], expected $RELEASE_TAG"; exit 1; }
echo "release pin OK: $RELEASE_TAG"
```

The `grep -E '^[[:space:]]+newTag:'` anchor matters: the component file also has
a comment line containing `newTag`.

---

## 9. Phase 4 — Customer overlay

Build `$REPO_DIR/deploy/overlays/aws-eks` exactly as
[overlay-contract.md](../../.agents/skills/evenfire-aws-eks/references/overlay-contract.md)
specifies, choosing Variant A (ALB/NLB/in-cluster controller) or Variant B
(Cloudflare Tunnel). Then generate the cluster-specific patches:

```bash
. "$HOME/.evenfire-eks/env.sh"
cd "$REPO_DIR"
OVERLAY_DIR=deploy/overlays/aws-eks \
API_IPS='<clusterIP> <endpoint> …' DNS_IP='<kube-dns ip>' STORAGE_CLASS='gp3' \
NODELOCAL_DNS_IP='' INGRESS_CIDRS='<lb subnet cidrs, empty for Tunnel>' \
  bash "$SKILL_SCRIPTS/write-network-patches.sh"
```

Render and gate. The block must end with `render gate: OK` before anything is
applied:

```bash
. "$HOME/.evenfire-eks/env.sh"
cd "$REPO_DIR"
kubectl kustomize deploy/overlays/aws-eks > "$WORK/render.yaml" || { echo 'STOP: render failed'; exit 1; }
RELEASE_TAG="$RELEASE_TAG" ruby "$SKILL_SCRIPTS/image-gate.rb" < "$WORK/render.yaml" || exit 1
bash deploy/scripts/lint-networkpolicies.sh --rendered "$WORK/render.yaml" || exit 1
if grep -q '10\.109\.0\.1/32' "$WORK/render.yaml"; then echo 'STOP: base API placeholder still rendered'; exit 1; fi
leftovers="$(grep -En 'localhost|127\.0\.0\.1|minikube|replace-with-|CLERUM_DEV_MODE|value: warn' "$WORK/render.yaml" \
  | grep -Ev 'CONTROL_API_GOOGLE_CLIENT_ID: replace-with-|WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN: replace-with-')"
if [ -n "$leftovers" ]; then printf 'STOP: dev leftovers in render:\n%s\n' "$leftovers"; exit 1; fi
echo 'render gate: OK'
```

The two allowed placeholders come from base. `CONTROL_API_GOOGLE_CLIENT_ID`
stays unset unless the human configures Google sign-in. The
`webhook-proxy-secrets` token is replaced by step 5.11 after every apply.

---

## 10. Phase 5 — Install

Run every step from `$REPO_DIR` after sourcing the env file.

### 5.1 Namespaces

```bash
kubectl --context "$CONTEXT" apply -f deploy/base/namespaces.yaml
kubectl --context "$CONTEXT" apply -f deploy/base/ingress/namespace.yaml
```

Create `ingress` even without the Tunnel. `bootstrap-rbac.sh` applies
`deploy/base/ingress/rbac.yaml` and stops partway through the RBAC set if that
namespace is missing.

### 5.2 CRDs

```bash
helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds
kubectl --context "$CONTEXT" apply -f ./charts/clerum-crds/crds/
```

Helm 3 does not upgrade CRDs on `helm upgrade`; always re-apply the YAML.

### 5.3 RBAC

```bash
CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh
```

If the context name contains `clerum`, the script asks for `CONFIRM=yes`; pass
it only after re-checking the context.

### 5.4 JWT keys and generated Secrets — once only (ask first)

```bash
if kubectl --context "$CONTEXT" -n control-plane get secret control-api-secrets >/dev/null 2>&1; then
  echo "control-api-secrets exists: SKIP gen-jwt-keys.sh"
else
  CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh >/dev/null
fi
```

`gen-jwt-keys.sh` has no skip flag. **Every** run rotates all keys (invalidating
sessions) and resets `control-postgres` to `postgres/postgres`. Never re-run it
on a cluster with users. Its admin password hash is a placeholder that cannot
log in; the human claims the admin account in Phase 6.

### 5.5 Postgres superuser password (in-cluster Postgres, first install only)

The password only takes effect when Postgres initializes an empty volume, so do
this before 5.7 starts Postgres. If the PVC already exists, skip this step and
report it.

```bash
if kubectl --context "$CONTEXT" -n control-plane get pvc control-postgres-data >/dev/null 2>&1; then
  echo "control-postgres-data exists: SKIP (password already initialized)"
else
  ( umask 077
    f="$WORK/pg-password-patch.json"
    printf '{"stringData":{"POSTGRES_PASSWORD":"%s"}}' "$(openssl rand -hex 32)" > "$f"
    kubectl --context "$CONTEXT" -n control-plane patch secret control-postgres \
      --type=merge --patch-file "$f" >/dev/null
    rm -f "$f" )
fi
```

The migration Job reads this Secret. The runtime-role and GFS scripts use
`psql` inside the Postgres pod. control-api uses the least-privilege runtime DSN
from 5.8, not the `CONTROL_API_PG_CONNECTION_STRING` default in
`control-api-config`.

### 5.6 Inter-service tokens (ask first)

Outside minikube the script refuses to run unless
`CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` is set or already stored.

- **Hosted invitations or no invitations:** control-api ignores the value in
  hosted mode, so a random value satisfies the script.
- **Remote registration service:** the human supplies the per-tenant secret
  through a file you do not print.

```bash
CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$(openssl rand -hex 32)" \
  CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh
```

The script preserves existing values on re-run. In hosted mode, never set
`CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` / `…_TENANT_ID`: control-api refuses
to start.

### 5.7 DB migration

```bash
CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/aws-eks
```

The script applies `control-postgres` (PVC, Deployment, Service) itself, waits
for it, and runs the schema Job.

### 5.8 Runtime database roles

```bash
CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/provision-control-api-runtime-roles.sh
```

Required. Base ships `control-api-postgres-runtime` and the workflow-recipes /
trace-maintenance runtime Secrets empty. Without this step control-api,
workflow-recipes, and trace-maintenance-worker stay in
`CreateContainerConfigError`.

### 5.9 Re-render and gate

Re-run the Phase 4 render-and-gate block so `"$WORK/render.yaml"` is fresh and
ends with `render gate: OK`. Do not apply a stale render.

### 5.10 Apply

```bash
kubectl --context "$CONTEXT" apply -f "$WORK/render.yaml"
```

### 5.11 Re-apply inter-service tokens

```bash
CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh
```

Required after **every** overlay apply. Base declares `webhook-proxy-secrets`
with a `replace-with-*` token, so the apply overwrites the real one. On re-run
the script treats placeholders as empty and re-syncs both sides.

### 5.12 GFS runtime, auth-key sync, instances

```bash
ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/provision-gfs-runtime.sh --context "$CONTEXT" --overlay deploy/overlays/aws-eks
```

This one step:

- Syncs the RPC public key into `mcp-host-config` and `gfs-config`, with the
  remote authorization `sync-auth-key.sh` needs. Do not call
  `scripts/minikube/sync-auth-key.sh` directly: without
  `GFS_REMOTE_RECONCILE_AUTHORIZED=true` and `ALLOWED_CONTEXTS` it takes the
  local minikube lease path and fails.
- Applies everything in `deploy/overlays/aws-eks/instances/`.
- Waits for HCC.
- Finalizes GFS credentials.
- Waits for `GlobalFileSystem/gfs` to be `Ready`.

Without `ALLOWED_CONTEXTS` or `--allow-prod` it refuses every EKS context name.
Prefer `ALLOWED_CONTEXTS`.

### 5.13 NetworkPolicies live and enforcement preflight

```bash
bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"
CONTEXT="$CONTEXT" OVERLAY=aws-eks bash deploy/scripts/np-enforce-preflight.sh
```

`OVERLAY=aws-eks` is required: without it the preflight guesses the overlay and
namespaces from GKE context names. Every FAIL line is a stop.

### 5.14 Confirm WorkflowRecipe egress enforcement (ask first)

Only after the Phase 4.1 probe passed and 5.13 has no FAIL, and the human
agrees: add `patches/wrc-network-policy.yaml` (see overlay-contract.md),
re-render, re-gate, re-apply (5.9–5.11). Until then WRC stays `required` and
refuses recipes with external egress. That is the intended fail-closed state.

### 5.15 Wait for the platform

Run `verify-rollout.sh` (Phase 8). Fix any FAIL before continuing. HCC must be
Ready before WRC external egress converges; control-api and control-ui are
always rolled out from the same render.

Cloudflare Tunnel (Variant B) only: `ingress/cloudflared` cannot start until
Phase 7 patches its credentials, so at this point its FAIL lines are the only
acceptable ones. After Phase 7, `verify-rollout.sh` must pass with no FAIL.

---

## 11. Phase 6 — Claim the admin account (HUMAN, before any ingress)

`POST /api/v1/admin/auth/setup` is unauthenticated by design. It sets the admin
credentials while the bootstrap admin has never logged in. Whoever reaches it
first becomes admin. So the human claims it **through a port-forward**, before
Phase 7 exposes anything. The agent must not run the second block, see the
password, or ask for it.

Agent (terminal 1, leave running):

```bash
. "$HOME/.evenfire-eks/env.sh"
kubectl --context "$CONTEXT" -n control-plane port-forward service/control-api 18090:8090
```

Human (their own terminal, 8–256 character password stored straight into
their password manager):

```bash
read -r -s -p 'New Evenfire admin password: ' EF_PW; echo
jq -n --arg u '<admin-username>' --arg e '<admin-email>' --arg p "$EF_PW" \
  '{username:$u,email:$e,password:$p}' \
| curl -sS -o /dev/null -w 'setup HTTP %{http_code}\n' \
    -X POST http://127.0.0.1:18090/api/v1/admin/auth/setup \
    -H 'content-type: application/json' --data-binary @-
unset EF_PW
```

Expect a 2xx. **409** ("Initial admin setup is no longer available") on a fresh
install means someone else already claimed the account. Treat it as a security
incident: stop, keep ingress closed, and tell the human.

Then the human sets the LLM key: port-forward `service/control-ui` 3000, log in,
Control UI → **Secrets → LLM** for the Host's `secretRef`, and for Bedrock /
Vertex / Azure the non-secret values under **Host → Environment**.

---

## 12. Phase 7 — Ingress (ask first)

**ALB/NLB (Variant A):** the `alb-ingress-*` patches must already be in the
applied render. Create Ingress / Service objects for the five hostnames:

| Host | Service |
| --- | --- |
| `app` | `control-ui.control-plane:3000` |
| `profile` | `profile-ui.profiles:3001` |
| `api` | `external-rest-api.profiles:8091` |
| `rpc` | `rpc-proxy.rpc-proxy:8094` |
| `webhook` | `webhook-proxy.webhook-ingress:8095` |

Use TLS certificates the human owns (for example ACM). `rpc` carries SSE: keep
idle timeouts ≥ 60 s and do not buffer responses.

**Cloudflare Tunnel (Variant B):** the human authorizes the tunnel interactively
and saves the credentials JSON to a file. Patch it from that file; the value
never appears on a command line:

```bash
. "$HOME/.evenfire-eks/env.sh"
( umask 077
  f="$WORK/cf-credentials-patch.json"
  ruby -rjson -rbase64 -e 'puts JSON.generate({"data"=>{"credentials.json"=>Base64.strict_encode64(File.read(ARGV[0]))}})' \
    '<path-to-tunnel-credentials.json>' > "$f"
  kubectl --context "$CONTEXT" -n ingress patch secret cloudflared-credentials --type=merge --patch-file "$f" >/dev/null
  rm -f "$f" )
kubectl --context "$CONTEXT" -n ingress rollout restart deployment/cloudflared
```

Outbound 7844 only; no public load balancer.

After exposure, hit the five HTTPS hostnames and re-run `verify-rollout.sh`.

---

## 13. Phase 8 — Prove it

Follow [verify.md](../../.agents/skills/evenfire-aws-eks/references/verify.md)
and print its handover block. Public HTTPS is mandatory when the human asked for
public DNS; a port-forward is acceptable only for an agreed internal pilot.

---

## 14. Day-2 rules

- **After any overlay change:** re-render, re-gate (Phase 4), apply, re-run 5.11
  (tokens), then re-run 5.12 (restores the RPC public key in `mcp-host-config`,
  which the apply overwrites from the overlay template).
- **After every EKS Kubernetes version upgrade:** EKS replaces the API server
  network interfaces. Re-run Phase 0.5, `write-network-patches.sh`, render,
  gate, apply, and
  `kubectl --context "$CONTEXT" -n control-plane rollout restart deployment/host-context-controller`.
  Until then Calico/Cilium clusters drop operator traffic to the new addresses.
- **After any CNI change:** re-run `np-deny-probe.sh`.
- **Never** re-run `gen-jwt-keys.sh` on a live cluster.

---

## 15. Stop-and-ask-human gates

- Wrong AWS account, region, cluster, or kube-context
- `np-deny-probe.sh` exit ≠ 0, or VPC CNI without strict mode
- No default RWO StorageClass and no permission to mark one
- IPv6 cluster
- A release newer than `VALIDATED_RELEASE`, or `MANIFEST_UNKNOWN` on any image
- Any Phase 4 gate fails, or `np-enforce-preflight.sh` prints FAIL
- Admission policy would require weakening a rule
- `control-api-secrets` exists and someone asks to regenerate keys
- `/admin/auth/setup` returns 409 on a fresh install
- HCC crash-loop mentioning `CONTEXT_MAPPER_K8S_API_CIDRS`
- RDS requested (not covered step by step)

---

## Appendix A — Namespace map

| Namespace | Role |
| --- | --- |
| `control-plane` | control-api, control-ui, HCC, WRC, trace-maintenance-worker, gateways, in-cluster Postgres |
| `profiles` | profile-ui, external-rest-api, profile-control-funnel |
| `mcp-host` | agent runtime (one Deployment per Host, spawned by HCC) |
| `mcp-server` | connector pods (HCC), mcp-proxy |
| `rpc-proxy` | Desktop JWT edge |
| `channels` | approval reader; per-Host channel readers |
| `sandbox-recipes` | WorkflowRecipe objects and most recipe workloads |
| `sandbox-ui` | recipe UIs |
| `webhook-ingress` | webhook-proxy |
| `gfs` | global file broker (`gfsc-writer`, `gfsc-reader`) |
| `llm-hooks` | optional guardrail hooks |
| `ingress` | always created; cloudflared only with the Tunnel |

Code/API group is still `clerum.io` / `CLERUM_*`. The public name is Evenfire.

## Appendix B — Images

Source of truth: `deploy/components/ghcr-images/kustomization.yaml` at
`$RELEASE_TAG`, plus `mcp-host-desktop` (published, not in the component). All
are multi-arch (`linux/amd64`, `linux/arm64`) at `ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`.

Third-party images pinned by `deploy/base` and pulled from Docker Hub:
`postgres:16-alpine`, `nginx:1.30.1-alpine`, `busybox:1.36`, and
`cloudflare/cloudflared@sha256:…` (tunnel only).

## Appendix C — Egress allowlist

Runtime namespaces start deny-all. Confirm the customer's VPC egress (NAT,
firewall, proxy) allows:

| Destination | Purpose |
| --- | --- |
| LLM provider endpoint(s) | Model calls (none if self-hosted) |
| `ghcr.io` and its blob storage (`pkg-containers.githubusercontent.com`) | Platform images |
| Docker Hub (`registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`) | Postgres, nginx, busybox, cloudflared images |
| `registry.evenfire.ai` | Optional connectors and recipes |
| `registration.evenfire.ai` | Hosted invitations and admin password-reset email links |
| Cloudflare `7844` | Tunnel only |
| Channel APIs | Only the channels they enable |

## Appendix D — What not to copy from minikube

- `fake-telegram/`, `instances-e2e/`, `communicationchannel.yaml`
- `storageClassName: standard` (hostPath)
- `127.0.0.1` / `localhost` URLs and the `RPC_PROXY_*_SECRET` / `*_TOKEN` values in its ConfigMaps
- `MINIKUBE_*` Make targets and `MINIKUBE_IMAGE_TAG=latest`
- `scripts/minikube/generate-keys.sh`, or regenerating keys on every setup
- `CLERUM_DEV_MODE`

## Related

- [Production checklist](production.md)
- [Infrastructure questionnaire](client-infrastructure-requirements.md)
- [Platform topology](../architecture/platform-topology.md)
- [Member invitations](../how-to/member-invitations-self-hosted.md)
- [LLM providers](llm-providers.md)
- [Claims guardrails](../meta/claims-guardrails.md)
