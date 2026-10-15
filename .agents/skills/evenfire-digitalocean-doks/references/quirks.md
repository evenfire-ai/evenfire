# Fail-closed quirks (agents get these wrong)

Each item is a real failure mode, checked against the scripts and manifests at
the guide's validated release, against DigitalOcean's documentation (linked),
or against a live DOKS 1.36 cluster where the documentation is silent. Read this
before writing the overlay or running Phase 5.

## Kubernetes API egress: measure it, do not assume it

DigitalOcean's DOKS known issues say: "The new control plane architecture does
not support using a Kubernetes `NetworkPolicy` to selectively allow access to the
API server when a `NetworkPolicy` restricts it. You can instead use
`CiliumNetworkPolicies`"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
Evenfire's base grants API egress only with NetworkPolicy ipBlocks (port 443).

On a DOKS 1.36 HA cluster created with custom subnets (VPC-native per doctl's
`cluster create` help) running Cilium 1.19 with
`policy-cidr-match-mode` unset, the guide's Phase 0.1 check found that deny-all blocks
the API server, and that **both** an ipBlock policy (ClusterIP and endpoint `/32`)
and a CiliumNetworkPolicy `toEntities: kube-apiserver` restore it on their own.
That is one cluster shape. Other versions, non-VPC-native clusters, or a future
control-plane change may behave as DigitalOcean documents. So:

- The overlay always ships `cilium-api-egress.yaml` (the documented path).
- The Phase 0.1 check decides per cluster. If neither path works, stop. Record
  `API_EGRESS_PATH`; the day-2 rules depend on it.
- The ipBlock patches stay, because `verify-networkpolicies.sh` and
  `np-enforce-preflight.sh` check them. They are not proof of reachability.

The kubernetes endpoint on DOKS is a VPC address that is not a node IP. Discovery
reports it with its EndpointSlice port; the CiliumNetworkPolicies allow 443 and
that port.

## `np-enforce-preflight.sh` on DOKS

- Pass `OVERLAY=digitalocean-doks`. Without it the script guesses overlays only
  from GKE context names. Its check 0 (enforcement state) is GKE-only and prints
  "skipped".
- Check 2 compares ipBlock strings with the live endpoints. It passes even when
  ipBlocks would not grant access, so on DOKS it is not load-bearing; the Phase 0.1
  check is.
- Check 3 requires a DNS ipBlock to the kube-dns ClusterIP in every Evenfire
  namespace. At `v0.10.0` it always FAILs for `gfs` (HCC writes a selector-only
  DNS rule) and `llm-hooks` (sealed on purpose; check 5 forbids the policy that
  would satisfy check 3). Those two FAILs are expected. On Cilium the DNS ipBlock
  is not load-bearing either. Any other FAIL is a stop.

## NetworkPolicy enforcement on DOKS

DOKS networking "is preconfigured with Cilium and supports network policies"
([DOKS features](https://docs.digitalocean.com/products/kubernetes/details/features/)).
DigitalOcean manages Cilium: "do not modify any managed components pre-installed
in your DigitalOcean Kubernetes cluster, such as workloads, policies, Cilium, and
CoreDNS"
([managed components](https://docs.digitalocean.com/products/kubernetes/details/managed/)).
Do not change `cilium-config`. Prove enforcement with the guide's Phase 0.1
check (owned and bare pod) instead of reading configuration.

DOKS adds a cluster-wide CiliumClusterwideNetworkPolicy `deny-imds-egress` that
denies pod egress to `169.254.169.254`. On the live cluster it sets
`enableDefaultDeny.egress: false`, so it does not put pods into default-deny.

## Load balancers carry no usable source CIDR

- Since `1.33.1-do.0` a `type: LoadBalancer` Service gets a network load balancer
  by default, and "Network load balancers (`REGIONAL_NETWORK`) preserve client
  source IP addresses automatically"
  ([configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)).
  The same page still calls the type "currently in public preview"; the
  [release notes](https://docs.digitalocean.com/release-notes/kubernetes/) say it
  is generally available. Set the type annotation explicitly either way.
- "Backend IP addresses may change at any time and should not be used to
  configure firewalls"
  ([load balancer features](https://docs.digitalocean.com/products/networking/load-balancers/details/features/)).
- So the overlay admits the in-cluster ingress controller pods by selector (Variant A)
  and filters clients with `loadBalancerSourceRanges` on the load balancer.
- The network load balancer's idle timeout is not documented. The HTTP load
  balancer's is `do-loadbalancer-http-idle-timeout-seconds` ("The default is
  60."). `rpc` server-sent events send a keepalive every 15 s
  (`RPC_PROXY_STREAM_KEEPALIVE_MS`), inside the documented HTTP load balancer
  default. Write annotation values as quoted strings.
- Pods cannot reach a load balancer's external IP from inside the cluster
  (hairpin); DigitalOcean documents the `do-loadbalancer-hostname` workaround.
- Every load balancer is billed. Ask before creating one.

## Gateway API and managed objects

"DOKS installs and manages the Gateway API CRDs … Do not install or modify the
Gateway API CRDs"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
Gateway traffic also carries Cilium's reserved `ingress` identity, which a
Kubernetes NetworkPolicy cannot select, so Gateway API is not an Evenfire ingress
variant here.

"DOKS labels the Kubernetes objects it installs and manages with
`doks.digitalocean.com/managed: "true"`"
([managed components](https://docs.digitalocean.com/products/kubernetes/details/managed/)).
Never edit those objects; the reconciler reverts them.

## IPv6

"DOKS does not support IPv6 on nodes or clusters, only on DigitalOcean Load
Balancers provisioned for DOKS clusters"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
The helpers stop on any IPv6 address.

## Upgrades replace the control plane and the nodes

"During an upgrade, the control plane (Kubernetes main) is replaced with a new
control plane", and "The new worker nodes have new IP addresses"
([upgrade a cluster](https://docs.digitalocean.com/products/kubernetes/how-to/upgrade-cluster/)).
Clusters are upgraded automatically 30 days after their minor release goes out of
support
([supported releases](https://docs.digitalocean.com/products/kubernetes/details/supported-releases/)).
After every upgrade, re-read the cluster addresses, regenerate the patches, re-render,
apply, and restart HCC (it reads `CONTEXT_MAPPER_K8S_API_CIDRS` only at
startup). If `API_EGRESS_PATH=ipblock`, repeat the API egress check first: until
the patches are regenerated, API egress may be cut.

Clusters created on 1.36 or later get the HA control plane by default
([managed components](https://docs.digitalocean.com/products/kubernetes/details/managed/)).

## `clusterlint` findings: report them, do not rewrite workloads

"DigitalOcean runs a cluster linter check before each required upgrade … If
cluster linter errors are present, you must fix the issues"
([upgrade a cluster](https://docs.digitalocean.com/products/kubernetes/how-to/upgrade-cluster/)).
Two checks are likely to flag Evenfire
([clusterlint fixes](https://docs.digitalocean.com/support/clusterlint-error-fixes/)):

- `dobs-pod-owner` "ensures that any pod that references a DigitalOcean Block
  Storage Volume is owned by a StatefulSet", because the Eviction API ignores
  Deployment strategies. `control-postgres`, `gfsc-writer`, and HCC Host
  workspaces are Deployments with block-storage volumes. `strategy: Recreate`
  does not protect against evictions during a node drain.
- `validating-admission-policy` flags a ValidatingAdmissionPolicy with a `Deny`
  binding that matches resources DOKS needs to manage. Evenfire `v0.10.0`
  renders five ValidatingAdmissionPolicies and five bindings, and no admission
  webhooks.

DigitalOcean does not document which findings block an upgrade. Run the check
from the cluster's Operational Readiness Check before going live and report every
Evenfire finding to the human. Converting Evenfire workloads to StatefulSets or
changing its admission policies is a product change, not an install step.

## `doctl` and identity

- Pass `--context "$DOCTL_CONTEXT"` on every call. Never run `doctl auth switch`;
  it changes the default for every other session.
- `doctl kubernetes cluster kubeconfig save` sets the current kubectl context
  unless you pass `--set-current-context=false`
  ([kubeconfig save](https://docs.digitalocean.com/reference/doctl/reference/kubernetes/cluster/kubeconfig/save/)).
  The saved context is `do-<region>-<cluster>` and runs `doctl` to fetch
  credentials, so `doctl` must stay installed and authenticated.
- `doctl … -o json` omits `ha`, `auto_upgrade`, and `surge_upgrade` when they are
  false. Treat a missing key as `false`.
- No API field says whether an existing cluster is VPC-native. `doctl kubernetes
  cluster create --help` says default subnets (10.244.0.0/16, 10.245.0.0/16)
  create a "virtual network" cluster and custom ones a "vpc-native cluster";
  read the type from that, or treat it as unknown.
- Team Owners and Members are `cluster-admin` in every cluster
  ([custom role bindings](https://docs.digitalocean.com/products/kubernetes/how-to/set-up-custom-rolebindings/)).
  Read-only behaviour is the agent's job, not the token's.

## Storage

- DOKS ships `do-block-storage` (default, Delete), `do-block-storage-retain`,
  `do-block-storage-xfs`, `do-block-storage-xfs-retain`, and the
  `do-block-storage` VolumeSnapshotClass (observed on a 1.36 cluster;
  DigitalOcean documents only `do-block-storage`). Use what discovery reports.
- Volumes are ReadWriteOnce only. Base `clerum-workflow-output` asks for RWX and
  must be patched to RWO. The GlobalFileSystem CRD defaults to `standard-rwo`,
  which does not exist on DOKS; `provision-gfs-runtime.sh` then waits forever.
- At most 15 volumes attach to one DOKS node
  ([volume limits](https://docs.digitalocean.com/products/volumes/details/limits/)).
  Each Host workspace, the GFS writer, and Postgres take one.
- Volumes from `-retain` classes survive PVC deletion and keep billing until
  deleted by hand.

## Managed NetworkPolicies need `system:masters` to create

Evenfire's ValidatingAdmissionPolicy `managed-networkpolicy-label-immutability`
(`deploy/base/cluster-wide/workflowrecipe-admission.yaml`) refuses to CREATE a
NetworkPolicy labelled `clerum.io/managed-by: host-context-controller|wrc|workflow-recipes`
unless the requester is the HCC or WRC service account or in `system:masters`.
The base render ships 13 such policies. On a live DOKS cluster the installer's
groups were `do-role-name:Member`, `k8saas:authenticated`, `k8saas:default`, and
`system:authenticated`: `cluster-admin` by role binding, not `system:masters`.
A plain apply created some of those policies before the binding took effect and
was refused for the rest, so the outcome depends on apply order.

Guide 5.10 applies exactly that subset (a label selector, checked to match
NetworkPolicies only) with
`kubectl --as=evenfire-bootstrap --as-group=system:masters`, then the full render
normally. Never impersonate for anything else, and never delete or relax the
admission policy.

## Admin setup is first-come

`POST /api/v1/admin/auth/setup` needs no login. It sets the admin credentials
while the single bootstrap admin has never logged in. The human claims the
account through a port-forward **before** any ingress exists (guide Phase 6). A
409 on a fresh install means someone else got there first.

## Script context guards reject DOKS names unless told

| Script | Needs on DOKS |
| --- | --- |
| `apply-inter-service-tokens.sh` | `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` on first run (fails closed outside minikube) |
| `run-control-api-db-migration.sh`, `provision-control-api-runtime-roles.sh` | `CONTEXT` and `ALLOWED_CONTEXTS` (exact match) |
| `provision-gfs-runtime.sh` | `ALLOWED_CONTEXTS="$CONTEXT"`; refuses every name that is not `minikube` / `clerum-*` otherwise |
| `scripts/minikube/sync-auth-key.sh` | do not call directly; `provision-gfs-runtime.sh` calls it correctly |
| `np-enforce-preflight.sh` | `OVERLAY=digitalocean-doks` |
| `bootstrap-rbac.sh` | the `ingress` namespace must exist (it applies every `rbac.yaml` under `deploy/base`, including `ingress/rbac.yaml`) |

## Missing install steps break silently

- `reconcile-gfs-deploy-credentials.sh` before the overlay apply (guide 5.8), as
  the release's `docs/deploy/gfs-permission-store.md` orders it. Base declares
  `gfs/gfs-controller-db` without its `connection-string`; without this step
  `gfsc-writer` stays in `CreateContainerConfigError` and
  `provision-gfs-runtime.sh` stops (observed live).
- `provision-control-api-runtime-roles.sh` after the migration: base ships
  `control-api-postgres-runtime` and the workflow-recipes and trace-maintenance
  runtime Secrets empty. Without it those Deployments sit in
  `CreateContainerConfigError`.
- `apply-inter-service-tokens.sh` again after **every** overlay apply: base
  declares `webhook-proxy-secrets` with a `replace-with-*` token, so the apply
  overwrites the real one. At `v0.10.0` the script also writes
  `grok-llm-proxy-secrets`.

## Secrets vs `kubectl apply`

Base ships empty canary Secrets. Real tokens are written with
`kubectl patch --type=merge`, outside the last-applied envelope. A token placed in
a kustomize patch is wiped by the next apply. Never put Secret values in the
overlay or on a command line: build a patch file in `$WORK` under `umask 077`, use
`--patch-file`, delete the file.

## `gen-jwt-keys.sh` rotates everything, every time

It has no skip flag. Each run rotates every key (invalidating all sessions),
writes a placeholder admin hash, and resets `control-postgres` to
`postgres/postgres`. Run it only when `control-api-secrets` is absent, then
replace the Postgres superuser password before Postgres first starts (guide 5.5).

## `mcp-host-config` public key is overwritten by apply

`provision-gfs-runtime.sh` syncs `CLERUM_AUTH_JWT_PUBLIC_KEY` from
`rpc-proxy-secrets` into `mcp-host-config` and `gfs-config`. The overlay's
`mcp-host-config` carries a placeholder, so re-run that script after any apply.

## Images: unset env vars resolve to Docker Hub

| Env var | Code default |
| --- | --- |
| `CONTEXT_MAPPER_DESKTOP_IMAGE` | `clerum/mcp-host-desktop:latest` |
| `CONTEXT_MAPPER_CHANNEL_READER_IMAGE` | `clerum/channel-reader:0.9.5` |
| `CONTEXT_MAPPER_GFSC_IMAGE` | `clerum/gfs-controller:test` |

Those are unqualified Docker Hub names in a namespace Evenfire does not own. Set
all three explicitly and remove `clerum/` from the image allowlists.
The guide's Phase 4 gate enforces this. Base also pulls `postgres:16-alpine`,
`nginx:1.30.1-alpine`, `busybox:1.36`, and (Variant B)
`cloudflare/cloudflared@sha256:…` from Docker Hub.

## Release pin check

`deploy/components/ghcr-images/kustomization.yaml` has a comment line containing
`newTag`. Use `grep -E '^[[:space:]]+newTag:'`.

## CRDs

Helm 3 does not upgrade CRDs on `helm upgrade`. Always also run
`kubectl apply -f ./charts/clerum-crds/crds/`.

## Rollout order

WorkflowRecipe external egress waits for HCC `ExternalEgressReady` at the
current generation. Roll HCC to Ready, then WRC. Roll control-api and control-ui
from the same render.

## Member registration

In hosted mode, do not set `CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` or
`…_TENANT_ID`: control-api refuses to start. The HMAC secret is ignored in hosted
mode, but the token script still requires one on first run.

## `CLERUM_DEV_MODE` and WRC `warn`

Never set `CLERUM_DEV_MODE=true` or `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=warn`
on a real cluster.

## WorkflowRecipe `spec.dryRun`

The CRD has no such field; the API server prunes it and the recipe deploys for
real. `kubectl apply --dry-run=server` is the only dry run.

## Do not copy from other clusters

No Artifact Registry images, `standard-rwo`, NodeLocal DNS CIDRs, tunnel UUIDs,
HMAC key ids, tenant ids, or IP addresses from GKE, EKS, minikube, or a previous
DOKS cluster. Regenerate everything from discovery.
