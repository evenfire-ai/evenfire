# Evenfire on existing DigitalOcean Kubernetes (DOKS) — agent how-to

**Audience:** a coding agent the customer points at this guide (or at the
`evenfire-digitalocean-doks` skill). Humans: paste the prompt from the skill,
approve spend, secrets, and DNS when the agent stops, and do the two steps marked
**HUMAN** (admin password and LLM key) yourself.

**Starting state:** an existing DOKS cluster (IPv4; DOKS has no IPv6 clusters).
This guide does **not** create a DigitalOcean team, VPC, or cluster.

**Validated release:** the env file below names the one public release this
procedure was checked against (scripts, manifests, and all three overlay variants
rendered and linted), plus a live install on a DOKS 1.36 cluster through the
internal-only variant. Variants A and B were rendered and linted, not run live. If a newer release exists, stop and ask the human (Phase 3.1).

**Honesty:** this OSS tree has no certified `deploy/overlays/digitalocean-doks`.
The overlay is customer-local and never pushed. Do not clone Evenfire's private
infra repo.

**How this guide works:** it gives the order, the checks, the pass and stop
criteria, and the DOKS-specific reasons, with short commands where they make a
check unambiguous. It does not ship install tooling beyond the scripts the
release itself contains (`deploy/scripts/*.sh`). Write any helper you need
yourself, and keep it to the criteria stated here.

Skill entry point: [`.agents/skills/evenfire-digitalocean-doks/SKILL.md`](../../.agents/skills/evenfire-digitalocean-doks/SKILL.md).

---

## How to use this document

**Two checkouts.** This guide and the skill live on the public repo's default
branch. Released tags older than this guide do not contain them.

| Directory | Git ref | Used for |
| --- | --- | --- |
| `$DOCS_DIR` | default branch | this guide and the skill (read only) |
| `$REPO_DIR` | release tag `$RELEASE_TAG` | manifests, `deploy/scripts`, the customer overlay; run install commands here |

**Your shell does not keep state between commands.** Write one env file and
source it at the start of **every** command block. Never use an alias such as
`k`.

```bash
mkdir -p "$HOME/.evenfire-doks/work" && chmod 700 "$HOME/.evenfire-doks" "$HOME/.evenfire-doks/work"
cat > "$HOME/.evenfire-doks/env.sh" <<'EOF'
export DOCTL_CONTEXT='<doctl-auth-context>'     # from `doctl auth list`
export CLUSTER_NAME='<doks-cluster-name>'
export REGION='<region-slug>'                   # e.g. fra1
export CONTEXT="do-${REGION}-${CLUSTER_NAME}"   # kubeconfig context written by doctl
export VALIDATED_RELEASE='v0.10.0'
export RELEASE_TAG="$VALIDATED_RELEASE"         # changed only with human approval (Phase 3.1)
export DOCS_DIR="$HOME/.evenfire-doks/docs"
export REPO_DIR="$HOME/.evenfire-doks/release"
export WORK="$HOME/.evenfire-doks/work"
EOF
chmod 600 "$HOME/.evenfire-doks/env.sh"
. "$HOME/.evenfire-doks/env.sh"
git clone --depth 1 https://github.com/evenfire-ai/evenfire.git "$DOCS_DIR"
test -f "$DOCS_DIR/.agents/skills/evenfire-digitalocean-doks/SKILL.md" || echo 'STOP: default branch has no evenfire-digitalocean-doks skill yet'
```

Rules:

1. Every `doctl` call passes `--context "$DOCTL_CONTEXT"`; never run
   `doctl auth switch`. Every `kubectl` call passes `--context "$CONTEXT"`.
   Current-context is not load-bearing.
2. Run phases in order. On any failed check, stop and print the reason.
3. Ask the human before billed DigitalOcean resources, Secret writes, DNS/TLS
   changes, or anything this guide marks **ask first**.
4. Never print, echo, or pass on the command line: Secret values, passwords,
   bcrypt hashes, DSNs, private keys, API tokens, tunnel credentials. Secret
   material goes through files created with `umask 077` in `$WORK` and deleted
   right after use.

---

## Mission and hard limits

**Done means:** Evenfire runs on the named cluster, every Deployment from the
rendered overlay plus the HCC-spawned Host and GFS Deployments are rolled out,
NetworkPolicy deny and Kubernetes API egress are proven (Phase 0.1), the human
has claimed the admin account, and the handover block from
[verify.md](../../.agents/skills/evenfire-digitalocean-doks/references/verify.md)
is printed.

**Out of scope:** new clusters, team or VPC setup, DigitalOcean Managed
PostgreSQL, Desktop code signing, Slack/Teams app review.

| Always | Ask first | Never |
| --- | --- | --- |
| Source the env file; pin `--context` for `doctl` and `kubectl` | Load balancers, volumes, snapshots, other spend | Create or replace the cluster, VPC, or team |
| Manifests from `$REPO_DIR` at `$RELEASE_TAG` | Any Secret write | Apply `deploy/overlays/minikube*` |
| Platform images `ghcr.io/evenfire-ai/*:$RELEASE_TAG` | Public DNS / TLS / ingress exposure | `latest`, `sha-*`, private registry SHAs |
| Prove NetworkPolicy deny and API egress (Phase 0.1) | Installing an ingress controller | `CLERUM_DEV_MODE=true` or WRC `warn` mode |
| Take addresses from the live cluster (Phase 0.5) | A release other than `$VALIDATED_RELEASE` | See, handle, or print the admin password or LLM key |
| Fail closed | The Phase 0.1 checks (they create a namespace) | Expose ingress before the admin is claimed |
| | | Edit Cilium, CoreDNS, Gateway API CRDs, or anything labelled `doks.digitalocean.com/managed` |

---

## Inputs the human must supply

Stop and ask for anything blank that blocks a phase.

| Input | Why |
| --- | --- |
| `doctl` auth context, cluster name, region | Identity; pin every command |
| An account role that is `cluster-admin` (team Owner or Member) | CRDs, ClusterRoles |
| Domain for `app` / `profile` / `api` / `rpc` / `webhook`, **or** "internal only" | CORS, OAuth callbacks, invitations |
| Ingress: an in-cluster ingress controller behind a DigitalOcean load balancer, Cloudflare Tunnel, **or** internal only (port-forward) | Overlay variant and ingress policies |
| LLM provider and model name (the **human** enters the key in Control UI) | Host instance |
| Member invitations: hosted mode, remote registration service, or none | HMAC secret source (5.6) |
| GlobalFileSystem size | `instances/globalfilesystem.yaml` |
| A label for this deployment (for example `production` or `pilot`) | `TRACING_ENVIRONMENT` in `control-api-config` |

Sizing: the full stack has run on 6 vCPU / 10 GB RAM in a single-node local
evaluation; that is a floor for a smoke test, not a production sizing.

---

## Phase 0 — Tools, identity, discovery (read-only)

Required local tools: `doctl`, `kubectl`, `helm` 3, `git`, `bash`, `jq`, `ruby`,
`python3`, `openssl`, `curl`. If one is missing, print the install command for
the human (for `doctl`: `brew install doctl`, `sudo snap install doctl`, or a
[GitHub release](https://docs.digitalocean.com/reference/doctl/how-to/install/));
do not install it silently.

```bash
. "$HOME/.evenfire-doks/env.sh"
for t in doctl kubectl helm git jq ruby python3 openssl curl; do command -v "$t" >/dev/null || echo "MISSING: $t"; done
doctl auth list
doctl --context "$DOCTL_CONTEXT" account get --format Email,Team,Status
doctl --context "$DOCTL_CONTEXT" kubernetes cluster list --format Name,Region,Version,Status
kubectl config get-contexts "$CONTEXT" || echo "no kubeconfig context $CONTEXT yet"
```

If the context does not exist, save it **without** changing the current context
(this writes your local kubeconfig; tell the human):

```bash
. "$HOME/.evenfire-doks/env.sh"
doctl --context "$DOCTL_CONTEXT" kubernetes cluster kubeconfig save "$CLUSTER_NAME" --set-current-context=false
kubectl config get-contexts "$CONTEXT"
```

`--set-current-context` defaults to `true`
([kubeconfig save](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/kubeconfig/save/)).
The saved context runs `doctl kubernetes cluster kubeconfig exec-credential` to
fetch short-lived credentials (doctl source, `commands/kubernetes.go`), so `doctl`
must stay installed and authenticated with the same context.

Then read the cluster facts. All read-only:

```bash
. "$HOME/.evenfire-doks/env.sh"
doctl --context "$DOCTL_CONTEXT" kubernetes cluster get "$CLUSTER_NAME" -o json \
  | jq '.[0] | {id, version, status: .status.state, ha: (.ha // false), auto_upgrade: (.auto_upgrade // false),
               surge_upgrade: (.surge_upgrade // false), cluster_subnet, service_subnet}'
kubectl --context "$CONTEXT" get nodes -o wide
kubectl --context "$CONTEXT" get storageclass
kubectl --context "$CONTEXT" -n kube-system get configmap cilium-config \
  -o jsonpath='{.data.policy-cidr-match-mode}{" "}{.data.kube-proxy-replacement}{"\n"}'
kubectl --context "$CONTEXT" get crd ciliumnetworkpolicies.cilium.io
kubectl --context "$CONTEXT" -n kube-system get daemonset node-local-dns 2>/dev/null || echo 'no node-local-dns'
kubectl --context "$CONTEXT" auth whoami
kubectl --context "$CONTEXT" get validatingwebhookconfigurations,mutatingwebhookconfigurations,validatingadmissionpolicies
```

What to read from it:

- `doctl … -o json` omits `ha`, `auto_upgrade`, and `surge_upgrade` when they are
  false; treat a missing key as `false` (the `// false` above does).
- `cluster_subnet` and `service_subnet`: the `doctl kubernetes cluster create`
  help says the defaults (10.244.0.0/16, 10.245.0.0/16) create a cluster "with a
  virtual network" and custom ones a "vpc-native cluster". Record which.
- `version`: from `1.33.1-do.0` a LoadBalancer Service defaults to a network load
  balancer
  ([configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)).
- `auth whoami`: on DOKS a team Owner or Member is `cluster-admin` through a role
  binding, not a member of `system:masters`. That matters in 5.10.

**Stop if:**

- The team (`doctl … account get`), the cluster, or the region is not what the
  human named, or the cluster status is not `running`
- Any address in the cluster is IPv6 (DOKS has no IPv6 clusters; this guide
  covers IPv4 only)
- There is not exactly one default StorageClass
- `node-local-dns` is installed (not a DOKS default); its listen address must then
  be taken from its configuration by hand
- The CiliumNetworkPolicy CRD is missing
- Nodes cannot cover the evaluation floor
- An admission policy, webhook, or Pod Security label would block the install.
  Report the rule; do not disable it.

### 0.1 NetworkPolicy enforcement and API egress (hard stop)

Evenfire's isolation is default-deny NetworkPolicy. DOKS runs Cilium, which
DigitalOcean manages; do not change its configuration
([managed components](https://docs.digitalocean.com/products/kubernetes/details/managed/)).
Prove enforcement instead of reading configuration. Run the checks in a
throwaway namespace (create it, delete it afterwards); ask the human first.

**NetworkPolicy deny.** Run one Deployment-owned pod and one bare pod
(WorkflowRecipe coordinator and snippet-runner pods are bare pods), both from a
pinned image such as `busybox:1.36`, non-root.

1. Both pods resolve `kubernetes.default.svc.cluster.local` before any policy
   exists. If not, the check is inconclusive: stop.
2. Apply a deny-all egress policy to the namespace:
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata: {name: deny-all-egress}
   spec: {podSelector: {}, policyTypes: ["Egress"]}
   ```
3. Within about a minute both lookups must fail. If either still resolves,
   NetworkPolicy is not enforced: stop.

**Kubernetes API egress.** DigitalOcean documents that "The new control plane
architecture does not support using a Kubernetes `NetworkPolicy` to selectively
allow access to the API server when a `NetworkPolicy` restricts it. You can
instead use `CiliumNetworkPolicies`"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
Measure it on this cluster. Targets: the `kubernetes` Service ClusterIP on 443 and
every EndpointSlice address on its port:

```bash
. "$HOME/.evenfire-doks/env.sh"
kubectl --context "$CONTEXT" -n default get service kubernetes -o jsonpath='{.spec.clusterIP}{"\n"}'
kubectl --context "$CONTEXT" -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{range .items[*]}{.endpoints[*].addresses}{" "}{.ports[*].port}{"\n"}{end}'
```

From two pods on different nodes when possible, test a TCP connect to every
target (for example `timeout 5 nc -z -w 3 <ip> <port>`), retrying a few times
before calling it blocked. Every pod must reach every target for a phase to pass.

1. **No policy:** must connect. Otherwise inconclusive: stop.
2. **Deny-all egress only:** must be blocked. Otherwise NetworkPolicy does not
   police API egress here, and the next phases prove nothing: stop.
3. **Deny-all + an ipBlock policy only:** `/32` for the ClusterIP and each
   endpoint, on 443 and the endpoint port. Record whether it connects.
4. **Deny-all + a CiliumNetworkPolicy only:** remove the ipBlock policy first;
   Cilium unions allow rules, so leaving it would mask a failing CNP.
   ```yaml
   apiVersion: cilium.io/v2
   kind: CiliumNetworkPolicy
   metadata: {name: allow-api-entity}
   spec:
     endpointSelector: {matchLabels: {app: <probe-pod-label>}}
     egress:
       - toEntities: [kube-apiserver]
         toPorts: [{ports: [{port: "443", protocol: TCP}, {port: "<endpoint-port>", protocol: TCP}]}]
   ```
   Record whether it connects.

Record `API_EGRESS_PATH`: `cnp` if phase 4 connects, otherwise `ipblock` if
phase 3 connects. If neither connects: stop. The day-2 rules depend on it.

On a DOKS 1.36 HA cluster created with custom subnets (Cilium 1.19,
`policy-cidr-match-mode` unset), deny-all blocked the API server and phases 3 and
4 each restored it on their own. That is one cluster shape. Details:
[quirks.md § API egress](../../.agents/skills/evenfire-digitalocean-doks/references/quirks.md#kubernetes-api-egress-measure-it-do-not-assume-it).

### 0.2 Storage

The single default StorageClass from Phase 0 is the RWO block class Evenfire
uses. WorkflowRecipe output PVCs carry no `storageClassName`, so exactly one
default class is required. DigitalOcean volumes are ReadWriteOnce only,
and at most 15 attach to one node
([volume limits](https://docs.digitalocean.com/products/volumes/details/limits/)).
DigitalOcean Network File Storage is not required. Details:
[overlay-requirements.md § Storage](../../.agents/skills/evenfire-digitalocean-doks/references/overlay-requirements.md#storage).

---

## Phase 0.5 — Cluster coordinates (read-only)

Record these from the live cluster. Never paste addresses from GKE, EKS,
minikube, or another DOKS cluster.

| Value | How | Used for |
| --- | --- | --- |
| API addresses | `kubernetes` Service ClusterIP plus every EndpointSlice address (Phase 0.1) | ipBlock patches and `CONTEXT_MAPPER_K8S_API_CIDRS` |
| API endpoint port | the EndpointSlice port; exactly one expected | CiliumNetworkPolicy `toPorts` besides 443 |
| DNS address | `kubectl -n kube-system get service kube-dns -o jsonpath='{.spec.clusterIP}'` | DNS egress rules |
| StorageClass | the single default class | overlay storage |
| Default load balancer type | from the DOKS version (Phase 0) | Phase 1 |

On a live DOKS 1.36 cluster the API endpoint was a VPC address that is not a node
IP, on port 443.

---

## Phase 1 — Add-ons only if missing (ask first)

- **NetworkPolicy enforcement:** built in (Cilium). Nothing to install.
- **Ingress controller (Variant A only):** use the customer's existing controller.
  If none exists, list DigitalOcean's 1-Click catalog
  (`doctl --context "$DOCTL_CONTEXT" kubernetes 1-click list`) and pick an
  in-cluster ingress controller it offers (it listed `traefik` when this guide
  was validated); install it only with approval, because it creates a billed
  load balancer. Do
  not install ingress-nginx: it no longer receives security fixes
  ([Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).
  Do not use Gateway API (see
  [overlay-requirements.md § Ingress](../../.agents/skills/evenfire-digitalocean-doks/references/overlay-requirements.md#ingress)).
- **The controller's LoadBalancer Service** (through its Helm values if Helm
  manages it): set `service.beta.kubernetes.io/do-loadbalancer-type` explicitly
  (`REGIONAL_NETWORK` or `REGIONAL`; see the default in Phase 0),
  `externalTrafficPolicy: Local`, and `loadBalancerSourceRanges`
  if the human restricts clients
  ([configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)).
  Quote every annotation value.
- **Never** install or upgrade the Gateway API CRDs; DOKS manages them.

---

## Phase 2 — Data plane

**Evaluation / pilot:** in-cluster `postgres:16-alpine` on the default StorageClass
(`control-postgres-data`), as `deploy/base` ships. Step 5.5 replaces the superuser
password that `gen-jwt-keys.sh` hard-codes. Back it up with VolumeSnapshots
(billed; ask first).

**DigitalOcean Managed PostgreSQL:** not covered step by step. The migration and
runtime-role scripts execute `psql` inside the in-cluster `control-postgres`
Deployment, so a managed database needs a separately reviewed procedure. Tell the
human; do not improvise it.

LLM keys and channel tokens stay in Kubernetes Secrets and are entered by the
human in Control UI.

---

## Phase 3 — Release checkout

### 3.1 Confirm the release

```bash
. "$HOME/.evenfire-doks/env.sh"
latest="$(git ls-remote --tags --refs https://github.com/evenfire-ai/evenfire.git \
  | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
echo "latest=$latest validated=$VALIDATED_RELEASE"
```

If `latest` differs from `VALIDATED_RELEASE`, stop and ask the human to choose:

- install `VALIDATED_RELEASE`, or
- install `latest` knowing this guide was not validated against it. In that case
  set `RELEASE_TAG` in the env file, re-read every script's usage block before
  calling it, and stop on any mismatch with this guide.

### 3.2 Clone and pin

```bash
. "$HOME/.evenfire-doks/env.sh"
git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/evenfire-ai/evenfire.git "$REPO_DIR"
cd "$REPO_DIR"
test "$(git describe --tags --exact-match)" = "$RELEASE_TAG" || { echo "STOP: not at $RELEASE_TAG"; exit 1; }
tags="$(grep -E '^[[:space:]]+newTag:' deploy/components/ghcr-images/kustomization.yaml | awk '{print $2}' | sort -u)"
test "$tags" = "$RELEASE_TAG" || { echo "STOP: ghcr-images newTag=[$tags], expected $RELEASE_TAG"; exit 1; }
echo "release pin OK: $RELEASE_TAG"
```

---

## Phase 4 — Customer overlay

Build `$REPO_DIR/deploy/overlays/digitalocean-doks` so that it meets
[overlay-requirements.md](../../.agents/skills/evenfire-digitalocean-doks/references/overlay-requirements.md),
choosing Variant A (in-cluster ingress controller), Variant B (Cloudflare
Tunnel), or Variant C (internal only, port-forward). Use the Phase 0.5 values;
regenerate the cluster-specific patches from the live cluster whenever they
change, never by hand-copying old values.

Render and gate. The block must end with `render gate: OK` before anything is
applied:

```bash
. "$HOME/.evenfire-doks/env.sh"
cd "$REPO_DIR"
kubectl kustomize deploy/overlays/digitalocean-doks > "$WORK/render.yaml" || { echo 'STOP: render failed'; exit 1; }
bad_images="$(grep -E '^[[:space:]]*(image|value):[[:space:]]*"?[a-z0-9.-]+(\.[a-z]+)?/[^[:space:]"]+[:@]' "$WORK/render.yaml" \
  | grep -vE "ghcr\.io/evenfire-ai/[^:]+:$RELEASE_TAG|postgres:16-alpine|nginx:1\.30\.1-alpine|busybox:1\.36|cloudflare/cloudflared@sha256:[0-9a-f]{64}|registry\.evenfire\.ai/|mcr\.microsoft\.com/|mongodb/" || true)"
[ -z "$bad_images" ] || { printf 'STOP: images outside the release pin:\n%s\n' "$bad_images"; exit 1; }
for v in CONTEXT_MAPPER_HOST_IMAGE CONTEXT_MAPPER_DESKTOP_IMAGE CONTEXT_MAPPER_CHANNEL_READER_IMAGE CONTEXT_MAPPER_GFSC_IMAGE; do
  grep -A1 "name: $v\$" "$WORK/render.yaml" | grep -q "ghcr.io/evenfire-ai/.*:$RELEASE_TAG" || { echo "STOP: $v not pinned to the release"; exit 1; }
done
bash deploy/scripts/lint-networkpolicies.sh --rendered "$WORK/render.yaml" || exit 1
if grep -q '10\.109\.0\.1/32' "$WORK/render.yaml"; then echo 'STOP: base API placeholder still rendered'; exit 1; fi
cnps="$(grep -c '^kind: CiliumNetworkPolicy' "$WORK/render.yaml")"
[ "$cnps" -eq 6 ] || { echo "STOP: expected 6 CiliumNetworkPolicies, rendered $cnps"; exit 1; }
leftovers="$(grep -En 'localhost|127\.0\.0\.1|minikube|replace-with-|CLERUM_DEV_MODE|value: warn|<(domain|RELEASE_TAG|STORAGE_CLASS|GFS_SIZE|TUNNEL_ID|LLM_PROVIDER|LLM_MODEL|TRACING_ENVIRONMENT|CLUSTER_NAME|REGION)>' "$WORK/render.yaml" \
  | grep -Ev 'CONTROL_API_GOOGLE_CLIENT_ID: replace-with-|WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN: replace-with-')"
if [ -n "$leftovers" ]; then printf 'STOP: dev leftovers in render:\n%s\n' "$leftovers"; exit 1; fi
echo 'render gate: OK'
```

The image check enforces the rule from
[overlay-requirements.md § Images](../../.agents/skills/evenfire-digitalocean-doks/references/overlay-requirements.md#images):
platform images only as `ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`, the
third-party images `deploy/base` pins, and every HCC spawned-image variable set,
because unset ones fall back to unqualified `clerum/*` Docker Hub names. The two
allowed placeholders come from base. `CONTROL_API_GOOGLE_CLIENT_ID`
stays unset unless the human configures Google sign-in. The
`webhook-proxy-secrets` token is replaced by step 5.11 after every apply.

---

## Phase 5 — Install

Run every step from `$REPO_DIR` after sourcing the env file.

### 5.1 Namespaces

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
kubectl --context "$CONTEXT" apply -f deploy/base/namespaces.yaml
kubectl --context "$CONTEXT" apply -f deploy/base/ingress/namespace.yaml
```

Create `ingress` for every variant. `bootstrap-rbac.sh` applies every `rbac.yaml`
under `deploy/base`, including `deploy/base/ingress/rbac.yaml`, and stops partway
if that namespace is missing.

### 5.2 CRDs

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds
kubectl --context "$CONTEXT" apply -f ./charts/clerum-crds/crds/
```

Helm 3 does not upgrade CRDs on `helm upgrade`; always re-apply the YAML. On a
fresh cluster the YAML apply warns that each CRD is "missing the
kubectl.kubernetes.io/last-applied-configuration annotation"; that is expected
after a Helm install and is patched automatically.

### 5.3 RBAC

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh
```

If the context name contains `clerum`, the script asks for `CONFIRM=yes`; pass it
only after re-checking the context.

### 5.4 JWT keys and generated Secrets — once only (ask first)

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
if kubectl --context "$CONTEXT" -n control-plane get secret control-api-secrets >/dev/null 2>&1; then
  echo "control-api-secrets exists: SKIP gen-jwt-keys.sh"
else
  CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh >/dev/null
fi
```

`gen-jwt-keys.sh` has no skip flag. **Every** run rotates all keys (invalidating
sessions) and resets `control-postgres` to `postgres/postgres`. Never re-run it on
a cluster with users. Its admin password hash is a placeholder that cannot log
in; the human claims the admin account in Phase 6.

### 5.5 Postgres superuser password (first install only)

The password only takes effect when Postgres initializes an empty volume, so do
this before 5.7 starts Postgres. If the PVC already exists, skip and report it.

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
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

control-api uses the least-privilege runtime DSN from 5.8, not the
`CONTROL_API_PG_CONNECTION_STRING` default in `control-api-config`.

### 5.6 Inter-service tokens (ask first)

Outside minikube the script refuses to run unless
`CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` is set or already stored.

- **Hosted invitations or no invitations:** control-api ignores the value in
  hosted mode, so a random value satisfies the script.
- **Remote registration service:** the human supplies the per-tenant secret
  through a file you do not print.

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
hmac_key=CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET
if [ -n "$(kubectl --context "$CONTEXT" -n control-plane get secret control-api-internal-tokens \
      -o jsonpath="{.data.$hmac_key}" 2>/dev/null)" ]; then
  CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh          # keep the stored HMAC
else
  CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET="$(openssl rand -hex 32)" \
    CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh        # first run only
fi
```

A value passed in the environment wins over the stored one, so the block passes
a new HMAC only when `control-api-internal-tokens` has none; otherwise a re-run
would rotate it (harmless in hosted mode, breaks invitations with a remote
registration service). The script preserves the other tokens on re-run and also
writes
`grok-llm-proxy-secrets`. In hosted mode, never set
`CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` / `…_TENANT_ID`: control-api refuses to
start.

### 5.7 DB migration

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/digitalocean-doks
```

The script applies `control-postgres` (PVC, Deployment, Service), waits for it,
and runs the schema Job. The PVC creates a billed DigitalOcean volume.

### 5.8 Runtime database roles and GFS credentials

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/provision-control-api-runtime-roles.sh || { echo 'STOP: runtime roles'; exit 1; }
GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS="$CONTEXT" CONTEXT="$CONTEXT" \
  bash deploy/scripts/reconcile-gfs-deploy-credentials.sh || { echo 'STOP: GFS credentials'; exit 1; }
```

Both are required. Without the runtime roles, control-api, workflow-recipes, and
trace-maintenance-worker stay in `CreateContainerConfigError`. The release's
GFS permission-store document (`docs/deploy/gfs-permission-store.md`) orders
"migrations, runtime-role reconciliation, apply the central
`reconcile-gfs-deploy-credentials.sh` entrypoint, then apply the environment
overlay". Without it, `gfs/gfs-controller-db` has no `connection-string`,
`gfsc-writer` cannot start, and 5.12 stops with "gfs-controller-db.connection-string
is empty". The script never rotates a valid credential, so re-running it is safe.

### 5.9 Re-render and gate

Re-run the Phase 4 render-and-gate block so `"$WORK/render.yaml"` is fresh and
ends with `render gate: OK`.

### 5.10 Apply

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
managed='clerum.io/managed-by in (host-context-controller,wrc,workflow-recipes)'
kinds="$(kubectl --context "$CONTEXT" apply --dry-run=client -f "$WORK/render.yaml" -l "$managed" -o name | cut -d/ -f1 | sort -u)"
[ "$kinds" = "networkpolicy.networking.k8s.io" ] || { echo "STOP: managed selector matches [$kinds]"; exit 1; }
kubectl --context "$CONTEXT" --as=evenfire-bootstrap --as-group=system:masters \
  apply -f "$WORK/render.yaml" -l "$managed" || { echo 'STOP: managed NetworkPolicy apply failed'; exit 1; }
kubectl --context "$CONTEXT" apply -f "$WORK/render.yaml" || { echo 'STOP: apply failed'; exit 1; }
```

Evenfire's ValidatingAdmissionPolicy `managed-networkpolicy-label-immutability`
lets only the HCC and WRC service accounts, or the `system:masters` group,
**create** NetworkPolicies labelled `clerum.io/managed-by`. DOKS team Owners and
Members are `cluster-admin` through a role binding, not `system:masters`, so a
plain apply is refused for those policies. The block first checks that the label
selector matches NetworkPolicies only (13 of them at the validated release), then
applies exactly those from the gated render while impersonating
`system:masters` (cluster-admin may impersonate; the API server audit log records
it). Use impersonation for nothing else. The full apply then only updates them,
which the policy allows while the label is unchanged. Run both commands on every
apply; the impersonated step is idempotent.

### 5.11 Re-apply inter-service tokens

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh
```

Required after **every** overlay apply: base declares `webhook-proxy-secrets` with
a `replace-with-*` token, so the apply overwrites the real one.

### 5.12 GFS runtime, auth-key sync, instances

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
ALLOWED_CONTEXTS="$CONTEXT" \
  bash deploy/scripts/provision-gfs-runtime.sh --context "$CONTEXT" --overlay deploy/overlays/digitalocean-doks
```

This step syncs the RPC public key into `mcp-host-config` and `gfs-config`,
applies everything in `deploy/overlays/digitalocean-doks/instances/`, waits for
HCC, finalizes GFS credentials, and waits for `GlobalFileSystem/gfs` to be
`Ready`. Do not call `scripts/minikube/sync-auth-key.sh` directly.

### 5.13 NetworkPolicies live and enforcement preflight

```bash
. "$HOME/.evenfire-doks/env.sh"; cd "$REPO_DIR"
bash deploy/scripts/verify-networkpolicies.sh --overlay digitalocean-doks --context "$CONTEXT"
CONTEXT="$CONTEXT" OVERLAY=digitalocean-doks bash deploy/scripts/np-enforce-preflight.sh
```

Expected on DOKS at the validated release:

- `verify-networkpolicies.sh` ends with `OK`.
- The preflight's check 0 prints "skipped" (GKE-only). Check 2 compares the ipBlock
  patches with the live endpoints; it is not proof of API reachability (Phase 0.1
  is).
- Check 3 FAILs for `gfs` and `llm-hooks` only. Those two are expected
  ([quirks.md](../../.agents/skills/evenfire-digitalocean-doks/references/quirks.md#np-enforce-preflightsh-on-doks)).
  Any other FAIL is a stop.

### 5.14 Confirm WorkflowRecipe egress enforcement (ask first)

Only when all of these hold, and the human agrees:

- Phase 0.1: NetworkPolicy deny proven and an API egress path recorded.
- 5.13: `verify-networkpolicies.sh` OK; preflight FAIL lines limited to check 3
  for `gfs` and `llm-hooks`.

Then add `patches/wrc-network-policy.yaml` (see overlay-requirements.md), re-render,
re-gate, re-apply (5.9–5.12). Until then WRC stays `required` and refuses recipes
with external egress. That is the intended fail-closed state.

### 5.15 Wait for the platform

Run the rollout check from Phase 8. Fix any failure before continuing, with two
expected exceptions at this point:

- `mcp-host/<host>` not rolled out: HCC does not deploy a Host whose
  `secretRef` Secret is missing, and that Secret is created only when the human
  enters the LLM key in Phase 6. The Host stays not rolled out until the human
  does so; Phase 8 is the clean gate.
- Cloudflare Tunnel (Variant B) only: `ingress/cloudflared` cannot start until
  Phase 7 patches its credentials.

HCC must be Ready before WRC external egress converges; control-api and
control-ui are always rolled out from the same render.

---

## Phase 6 — Claim the admin account (HUMAN, before any ingress)

`POST /api/v1/admin/auth/setup` is unauthenticated by design. Whoever reaches it
first becomes admin. So the human claims it **through a port-forward**, before
Phase 7 exposes anything. The agent must not run the second block, see the
password, or ask for it.

Agent (terminal 1, leave running):

```bash
. "$HOME/.evenfire-doks/env.sh"
kubectl --context "$CONTEXT" -n control-plane port-forward service/control-api 18090:8090
```

Human (their own terminal on the same machine as the agent's port-forward, bash
or zsh; 8–256 character password stored straight into their password manager). Set the two values on the first lines, paste the
whole block, then type the password at the prompt. The block is one `( … )`
subshell on purpose: a pasted multi-line block otherwise feeds its own next line
to `read` as the password.

```bash
(
EF_USER='your-admin-username'
EF_EMAIL='you@example.com'
LOCAL=127.0.0.1:18090          # the address the agent's port-forward listens on
printf 'New Evenfire admin password: '; stty -echo; IFS= read -r EF_PW; stty echo; echo
[ ${#EF_PW} -ge 8 ] || { echo 'password too short (min 8); nothing sent'; exit 1; }
export EF_USER EF_EMAIL EF_PW                 # read by jq via env, never argv
jq -n '{username:env.EF_USER,email:env.EF_EMAIL,password:env.EF_PW}' \
| curl -sS -o /dev/null -w 'setup HTTP %{http_code}\n' \
    -X POST "http://$LOCAL/api/v1/admin/auth/setup" \
    -H 'content-type: application/json' --data-binary @-
jq -n '{username:env.EF_USER,password:env.EF_PW}' \
| curl -sS -o /dev/null -w 'login check HTTP %{http_code}\n' \
    -X POST "http://$LOCAL/api/v1/admin/auth/login" \
    -H 'content-type: application/json' --data-binary @-
)
```

Expect a 2xx. A **400** means the request was rejected (empty or short
password, invalid email); nothing was claimed, so fix the input and re-run.
**409** ("Initial admin setup is no longer available") on a fresh
install means the account is already claimed. First ask the human whether they
already ran the block (a repeat run returns 409). Otherwise treat it as a security
incident: stop, keep ingress closed, and tell the human.

Expect `setup HTTP 2xx` and `login check HTTP 200`. A setup 2xx with a failed
login check means the stored password is not the one typed: recover before going
further.

### Recover a mis-claimed admin account

Only on a fresh install, with no ingress exposed, and with the human's approval.
Setup accepts a claim only while the bootstrap admin row has never logged in. This
puts the single admin row back into that state without handling any password
(`!` matches no password; the `session_version` bump ends existing sessions), then
the human runs the claim block again. Never run `gen-jwt-keys.sh` to recover.

```bash
. "$HOME/.evenfire-doks/env.sh"
kubectl --context "$CONTEXT" -n control-plane exec deploy/control-postgres -- \
  psql -U postgres -d profiles -v ON_ERROR_STOP=1 -At -c "UPDATE control_admin_users
     SET username = 'admin', email = NULL, password_hash = '!', last_login_at = NULL,
         failed_attempts = 0, locked_until = NULL, session_version = session_version + 1,
         updated_at = NOW()
   WHERE (SELECT count(*) FROM control_admin_users) = 1
  RETURNING username, (last_login_at IS NULL) AS claimable"
```

Then the human sets the LLM key: port-forward `service/control-ui` 3000, log in,
Control UI → **Secrets → LLM** for the Host's `secretRef`.

Optional, for the connector and recipe catalog: Control UI → **Marketplace →
Connect**, enter an organization name and contact email. This registers the
deployment with `registry.evenfire.ai` (outbound HTTPS from control-api). Until
then Marketplace shows "The registry is currently unavailable", or "The registry
could not be reached" (control-api has no registry credentials yet; the network is
fine). Reload Marketplace after connecting; errors from before the connect stay on
screen. Expect the public catalog's connectors; the API Keys, Entries, and Images
tabs belong to your new organization and stay empty until you publish.

`kubectl port-forward` drops after idle time or laptop sleep ("lost connection to
pod"; the page then loads blank or times out). Restart it, or keep it in a loop:
`while true; do kubectl --context "$CONTEXT" -n control-plane port-forward service/control-ui 13000:3000; sleep 2; done`.

---

## Phase 7 — Ingress (ask first)

**Variant C (internal only):** skip this phase. Nothing is exposed; operators use
`kubectl port-forward`.

**Variant A (in-cluster ingress controller; not exercised on a live cluster):** the
`ingress-controller-*` patches
must already be in the applied render. Create Ingress (or the controller's own
route) objects for the five hostnames:

| Host | Service |
| --- | --- |
| `app` | `control-ui.control-plane:3000` |
| `profile` | `profile-ui.profiles:3001` |
| `api` | `external-rest-api.profiles:8091` |
| `rpc` | `rpc-proxy.rpc-proxy:8094` |
| `webhook` | `webhook-proxy.webhook-ingress:8095` |

Use TLS certificates the human owns: a certificate at the controller (for example
cert-manager, also in DigitalOcean's 1-Click catalog), or a DigitalOcean
certificate on an HTTP load balancer. `rpc` carries server-sent events: do not
buffer responses, and keep any idle timeout ≥ 60 s. Point DNS at the load
balancer's address only after the human approves.

**Variant B (Cloudflare Tunnel):** the human authorizes the tunnel interactively
and saves the credentials JSON to a file. Patch it from that file; the value never
appears on a command line:

```bash
. "$HOME/.evenfire-doks/env.sh"
( umask 077
  f="$WORK/cf-credentials-patch.json"
  ruby -rjson -rbase64 -e 'puts JSON.generate({"data"=>{"credentials.json"=>Base64.strict_encode64(File.read(ARGV[0]))}})' \
    '<path-to-tunnel-credentials.json>' > "$f"
  kubectl --context "$CONTEXT" -n ingress patch secret cloudflared-credentials --type=merge --patch-file "$f" >/dev/null
  rm -f "$f" )
kubectl --context "$CONTEXT" -n ingress rollout restart deployment/cloudflared
```

Outbound 7844 only; no public load balancer.

After exposure, hit the five HTTPS hostnames and re-run the Phase 8 rollout check.

---

## Phase 8 — Prove it

Follow [verify.md](../../.agents/skills/evenfire-digitalocean-doks/references/verify.md)
and print its handover block. Public HTTPS is mandatory when the human asked for
public DNS; a port-forward is acceptable only for an agreed internal pilot.

---

## Day-2 rules

- **After any overlay change:** re-render, re-gate (Phase 4), apply with both 5.10
  commands (a new release can add a managed NetworkPolicy), re-run 5.11 (tokens),
  then 5.12 (restores the RPC public key in `mcp-host-config`).
- **After every DOKS upgrade or node replacement:** DigitalOcean replaces the
  control plane during upgrades and new nodes get new IP addresses
  ([upgrade a cluster](https://docs.digitalocean.com/products/kubernetes/how-to/upgrade-cluster/)).
  Re-read the Phase 0.5 values, regenerate the cluster-specific patches, render,
  gate, apply, and
  `kubectl --context "$CONTEXT" -n control-plane rollout restart deployment/host-context-controller`
  (HCC reads its API CIDRs only at startup). Then repeat the Phase 0.1 API egress check.
  If the recorded `API_EGRESS_PATH` was `ipblock`, do this before anything else:
  until the patches are regenerated, operators may lose API access.
- **Before a required upgrade:** DigitalOcean runs clusterlint and expects errors
  fixed. Report Evenfire findings to the human; do not rewrite workloads
  ([quirks.md](../../.agents/skills/evenfire-digitalocean-doks/references/quirks.md#clusterlint-findings-report-them-do-not-rewrite-workloads)).
- **Never** re-run `gen-jwt-keys.sh` on a live cluster.

---

## Stop-and-ask-human gates

- Wrong `doctl` team, cluster, region, or kube-context
- A Phase 0 stop condition
- NetworkPolicy deny not proven, or no API egress path (Phase 0.1)
- A release newer than `VALIDATED_RELEASE`, or `MANIFEST_UNKNOWN` on any image
- Any Phase 4 gate fails, or `np-enforce-preflight.sh` prints a FAIL other than
  check 3 for `gfs` / `llm-hooks`
- An admission policy would require weakening a rule, or 5.10 is refused for
  anything other than the managed NetworkPolicies
- `control-api-secrets` exists and someone asks to regenerate keys
- `/admin/auth/setup` returns 409 on a fresh install
- HCC crash-loop mentioning `CONTEXT_MAPPER_K8S_API_CIDRS`
- DigitalOcean Managed PostgreSQL requested (not covered step by step)

---

## Appendix A — Namespace map

| Namespace | Role |
| --- | --- |
| `control-plane` | control-api, control-ui, HCC, WRC, trace-maintenance-worker, codex and grok LLM proxies, gateways, in-cluster Postgres |
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
`$RELEASE_TAG`, plus `mcp-host-desktop` (published, not in the component), all at
`ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`.

Third-party images pinned by `deploy/base` and pulled from Docker Hub:
`postgres:16-alpine`, `nginx:1.30.1-alpine`, `busybox:1.36`, and
`cloudflare/cloudflared@sha256:…` (tunnel only). The Phase 0.1 checks also need
a small pinned image such as `busybox:1.36`.

## Appendix C — Egress allowlist

Runtime namespaces start deny-all. DigitalOcean does not document outbound rules
for the cluster firewalls it manages. If the customer restricts outbound traffic
(for example through a NAT gateway or an egress proxy), allow:

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
- [Platform topology](../architecture/platform-topology.md)
- [Member invitations](../how-to/member-invitations-self-hosted.md)
- [LLM providers](llm-providers.md)
- [Claims guardrails](../meta/claims-guardrails.md)
