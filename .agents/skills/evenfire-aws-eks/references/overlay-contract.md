# Customer overlay contract (`deploy/overlays/aws-eks`)

The overlay lives **only in the customer's release checkout** (`$REPO_DIR`, the
public repo at `$RELEASE_TAG`). Never open a PR with it. The directory name must
be exactly `aws-eks`: `verify-networkpolicies.sh --overlay aws-eks` and
`np-enforce-preflight.sh` with `OVERLAY=aws-eks` resolve `deploy/overlays/<name>`.

This contract was rendered with `kubectl kustomize` and passed
`deploy/scripts/lint-networkpolicies.sh` against `v0.8.0` for both ingress
choices. If `RELEASE_TAG` differs from the guide's validated release, re-run
those checks and stop on any difference.

## Layout

```text
deploy/overlays/aws-eks/
  kustomization.yaml
  configmaps/rpc-proxy-config.yaml        # required (not in base)
  configmaps/mcp-host-config.yaml         # required (not in base)
  configmaps/cloudflared-config.yaml      # Cloudflare Tunnel only
  patches/control-api-config.yaml         # public URLs + image allowlist
  patches/dynamic-images.yaml             # HCC/WRC spawned images
  patches/external-rest-api-urls.yaml
  patches/storage.yaml
  patches/k8s-api-ip.yaml                 # generated
  patches/hcc-cluster.yaml                # generated
  patches/kube-dns-egress-rule.yaml       # generated
  patches/alb-ingress-*.yaml              # generated, ALB/NLB only
  patches/wrc-network-policy.yaml         # only after the deny probe passes
  instances/host.yaml
  instances/context.yaml
  instances/globalfilesystem.yaml
```

The `generated` files come from
[`scripts/write-network-patches.sh`](../scripts/write-network-patches.sh). Do not
hand-edit CIDRs.

## `kustomization.yaml`

Use `patches:` only. `patchesStrategicMerge` is deprecated in kustomize v5 and
unnecessary: multi-document strategic-merge files work under `patches:`.

### Variant A — existing ALB / NLB / ingress controller

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - configmaps/rpc-proxy-config.yaml
  - configmaps/mcp-host-config.yaml
components:
  - ../../components/ghcr-images
patches:
  - path: patches/control-api-config.yaml
  - path: patches/dynamic-images.yaml
  - path: patches/hcc-cluster.yaml
  - path: patches/external-rest-api-urls.yaml
  - path: patches/storage.yaml
  - path: patches/k8s-api-ip.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: "allow-dns-egress-(channels|control-plane|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|webhook-ingress)"}
    path: patches/kube-dns-egress-rule.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: sandbox-ui-static-dns-egress, namespace: sandbox-ui}
    path: patches/kube-dns-egress-rule.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: control-ui-network, namespace: control-plane}
    path: patches/alb-ingress-control-ui.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-ingress-profiles, namespace: profiles}
    path: patches/alb-ingress-profiles.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: rpc-proxy, namespace: rpc-proxy}
    path: patches/alb-ingress-rpc-proxy.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-public-ingress-webhook-proxy, namespace: webhook-ingress}
    path: patches/alb-ingress-webhook-proxy.yaml
```

The base public-ingress policies admit **only** `app: cloudflared` pods from the
`ingress` namespace. Without the four `alb-ingress-*` patches, an enforcing CNI
drops all load-balancer traffic and every hostname times out.

`INGRESS_CIDRS` for `write-network-patches.sh`:

- AWS Load Balancer Controller in **IP target mode**: the subnets the ALB/NLB
  is placed in. Prefer this mode.
- **Instance target mode** / NodePort: traffic arrives from node IPs, so use
  the node subnets.
- An **in-cluster** ingress controller (ingress-nginx, Traefik): do not use
  ipBlocks. Hand-write the four patches with a `namespaceSelector` and
  `podSelector` for the controller pods, then re-run the lint.

### Variant B — Cloudflare Tunnel

Start from Variant A, then:

- Add `../../base/ingress` and `configmaps/cloudflared-config.yaml` to `resources`.
- Remove the four `alb-ingress-*` patch entries (run the generator without
  `INGRESS_CIDRS`).
- Add `ingress` to the DNS target regex:
  `"allow-dns-egress-(channels|control-plane|ingress|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|webhook-ingress)"`.
- Add this `replacements` block. Without it `allow-cloudflared-egress` renders
  `0.0.0.0/0` with no exceptions (instance metadata and the VPC reachable) and
  `lint-networkpolicies.sh` fails.

```yaml
replacements:
  - source:
      group: clerum.io
      version: v1alpha1
      kind: PublicEgressExceptionSet
      name: public-egress-exceptions
      fieldPath: spec.ranges
    targets:
      - select:
          group: networking.k8s.io
          version: v1
          kind: NetworkPolicy
          name: allow-cloudflared-egress
        fieldPaths:
          - spec.egress.*.to.*.ipBlock.except
```

`cloudflared-config` maps hostnames to in-cluster Services (`ingress` namespace):
`app` → `http://control-ui.control-plane.svc.cluster.local:3000`, `profile` →
`http://profile-ui.profiles.svc.cluster.local:3001`, `api` →
`http://external-rest-api.profiles.svc.cluster.local:8091`, `rpc` →
`http://rpc-proxy.rpc-proxy.svc.cluster.local:8094`, `webhook` →
`http://webhook-proxy.webhook-ingress.svc.cluster.local:8095`, then a final
`http_status:404` rule. Its `credentials-file` must point under
`/etc/cloudflared-creds/` (the Secret mount in `deploy/base/ingress/cloudflared.yaml`).

## ConfigMaps not in base

`rpc-proxy` loads `rpc-proxy-config` via `envFrom` (missing →
`CreateContainerConfigError`); HCC-spawned Host pods load `mcp-host-config`.
Copy `deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml` and
`mcp-host-config.yaml` as **templates only**, then:

- Delete `RPC_PROXY_DESKTOP_COOKIE_SECRET`, `RPC_PROXY_DESKTOP_API_TOKEN`, and
  `RPC_PROXY_SANDBOX_UI_COOKIE_SECRET`. The real values live in
  `rpc-proxy-secrets` (written by `gen-jwt-keys.sh`); a ConfigMap is not a
  secret store.
- Set `RPC_PROXY_CORS_ORIGIN` to `https://app.<domain>,https://api.<domain>`.
- Set `RPC_PROXY_OAUTH_CALLBACK_BASE_URL` to `https://api.<domain>`.
- Replace every `localhost`, `127.0.0.1`, `minikube`, or `test` value, and rewrite
  the header comments so they no longer describe minikube.

## `patches/control-api-config.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: control-api-config
  namespace: control-plane
data:
  CONTROL_API_CONTROL_UI_BASE_URL: https://app.<domain>
  CONTROL_API_OAUTH_CALLBACK_BASE_URL: https://api.<domain>
  CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: https://profile.<domain>
  CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: https://api.<domain>
  CONTROL_API_DESKTOP_RPC_PROXY_BASE_URL: https://rpc.<domain>
  # Base includes clerum/, an unqualified Docker Hub namespace Evenfire does not own.
  CONTROL_API_ALLOWED_IMAGE_PREFIXES: ghcr.io/evenfire-ai/,registry.evenfire.ai/,mongodb/,mcr.microsoft.com/
```

For an internal-only pilot use the agreed internal URLs. Base ships `127.0.0.1`
values that only work through a laptop port-forward.

## `patches/external-rest-api-urls.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-rest-api
  namespace: profiles
spec:
  template:
    spec:
      containers:
        - name: external-rest-api
          env:
            - name: EXTERNAL_REST_API_CORS_ORIGIN
              value: "https://app.<domain>,https://profile.<domain>"
            - name: EXTERNAL_REST_API_PUBLIC_BASE_URL
              value: "https://api.<domain>"
            - name: EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL
              value: "https://rpc.<domain>"
```

## Images

- **Platform images:** `ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`. The
  `ghcr-images` component rewrites every `clerum/*` image **and every env value
  starting with `clerum/`** that base sets, which covers base Deployment images
  and base HCC/WRC `*_IMAGE` env values.
- **Third-party images pinned by base, pulled from Docker Hub:**
  `postgres:16-alpine`, `nginx:1.30.1-alpine` (gateways), `busybox:1.36` (HCC
  init containers), and `cloudflare/cloudflared@sha256:…` (tunnel only). Keep
  them as pinned. Allow Docker Hub for image pulls or mirror them.
- **Env vars base does not set** fall back to code defaults that are unqualified
  `clerum/*` names, which resolve to Docker Hub where Evenfire does not own the
  namespace. Set them explicitly. `mcp-host-desktop` is published on GHCR even
  though the component does not list it (it is not deployed to minikube).

`patches/dynamic-images.yaml` (write the tag literally; kustomize does not expand
variables):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: host-context-controller
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: host-context-controller
          env:
            - name: CONTEXT_MAPPER_HOST_IMAGE
              value: ghcr.io/evenfire-ai/mcp-host-slim:<RELEASE_TAG>
            - name: CONTEXT_MAPPER_DESKTOP_IMAGE
              value: ghcr.io/evenfire-ai/mcp-host-desktop:<RELEASE_TAG>
            - name: CONTEXT_MAPPER_CHANNEL_READER_IMAGE
              value: ghcr.io/evenfire-ai/channel-reader:<RELEASE_TAG>
            - name: CONTEXT_MAPPER_GFSC_IMAGE
              value: ghcr.io/evenfire-ai/gfs-controller:<RELEASE_TAG>
            - name: CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET
              value: ""
            - name: CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET
              value: ""
            - name: CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES
              value: ghcr.io/evenfire-ai/,registry.evenfire.ai/,mongodb/,mcr.microsoft.com/
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-recipes
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: workflow-recipes
          env:
            - name: CLERUM_MCP_HOST_IMAGE
              value: ghcr.io/evenfire-ai/mcp-host-slim:<RELEASE_TAG>
```

The image allowlists stay audit-only unless `*_ENFORCE_IMAGE_ALLOWLIST` is
`"true"`. Turning enforcement on is the human's decision, because it blocks
connector images from unlisted prefixes.

**Gate:** [`scripts/image-gate.rb`](../scripts/image-gate.rb) must print
`image gate: OK` for the render. It fails on any other registry, any tag other
than `$RELEASE_TAG`, and any missing HCC spawned-image env var. If a pull returns
`MANIFEST_UNKNOWN`, stop. Never fall back to `latest`, `main`, or `sha-*`.

## Kubernetes API, DNS, and HCC cluster values

`write-network-patches.sh` generates these from Phase 0.5 detection:

- **`patches/k8s-api-ip.yaml`** replaces the base placeholder `10.109.0.1/32` in
  `allow-k8s-api-egress-control-plane`, `-channels`, and `-mcp-host`. It uses
  the `kubernetes` Service ClusterIP **and** every endpoint IP, each as `/32`.
  Some CNIs (Calico, Cilium) match the post-DNAT endpoint address, so both are
  required.
- **`patches/hcc-cluster.yaml`** sets three HCC env vars:
  - `CONTEXT_MAPPER_K8S_API_CIDRS`: the same list. HCC crashes on startup for
    anything broader than IPv4 `/24` or IPv6 `/120`.
  - `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`: exactly one IPv4 `/32`, or empty.
  - `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS`: the code default
    `do-block-storage-retain` does not exist on EKS.
- **`patches/kube-dns-egress-rule.yaml`** adds TCP/UDP 53 to the kube-dns
  ClusterIP (plus the NodeLocal DNSCache IP, if present) on every
  `allow-dns-egress-*` policy and on `sandbox-ui-static-dns-egress`.
  `np-enforce-preflight.sh` requires this ipBlock in every namespace.

EKS replaces the API server's network interfaces on every Kubernetes version
upgrade. After each upgrade:

1. Re-detect the addresses.
2. Re-run the generator.
3. Re-render and apply.
4. Run `rollout restart deployment/host-context-controller` (HCC reads
   `CONTEXT_MAPPER_K8S_API_CIDRS` only at startup).

IPv6 EKS clusters are not covered; the generator stops on non-IPv4 input.

## Storage

Run `kubectl get sc` first. EKS clusters often have `gp2` (or `gp3` with the EBS
CSI driver) and may have **no default** StorageClass.

| Consumer | Needs | How to set |
| --- | --- | --- |
| `control-postgres-data` (control-plane) | RWO | `patches/storage.yaml` |
| `clerum-workflow-output` (sandbox-recipes) | Legacy PVC that greenfield recipes do not mount. Base requests **RWX**, which EBS cannot provision | `patches/storage.yaml`: `ReadWriteOnce` + RWO class |
| Per-recipe workflow output PVCs (WRC) | RWO, no `storageClassName` | a **default** StorageClass; if none exists, ask the human to mark the RWO class as default |
| HCC Host workspace PVCs | RWO | `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` (generated) |
| GlobalFileSystem PVC | RWO | `instances/globalfilesystem.yaml` `spec.storage.storageClassName`. The CRD default `standard-rwo` does not exist on EKS |
| SharedFileSystem PVCs | RWO | empty means cluster default |

A greenfield install does **not** need EFS/RWX. Do not create an EFS file system
unless the human asks for it for another reason.

`patches/storage.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: control-postgres-data
  namespace: control-plane
spec:
  storageClassName: gp3
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: clerum-workflow-output
  namespace: sandbox-recipes
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3
```

## Instances

`provision-gfs-runtime.sh` applies **everything** in `instances/` and then waits
for `GlobalFileSystem/gfs` to reach `Ready`. The directory must exist and be
valid before that step.

`instances/globalfilesystem.yaml`:

```yaml
apiVersion: clerum.io/v1alpha1
kind: GlobalFileSystem
metadata:
  name: gfs
  namespace: gfs
spec:
  storage:
    size: 100Gi          # ask the human
    storageClassName: gp3
    accessModes:
      - ReadWriteOnce
  layout:
    rootDirectories:
      - /org
      - /system/published-workflow-artifacts
  security:
    runAsUser: 1000
    fsGroup: 1000
  readerReplicas: 1
  retainOnDelete: true
```

For `instances/context.yaml` and `instances/host.yaml`, start from
`deploy/overlays/minikube/instances/`:

- Set the model `provider` and `name` to the human's choice.
- Remove the `telegram` approval channel and the `channels:` list unless the
  human configured that channel.
- Do not copy `communicationchannel.yaml`, `workflowrecipepolicy.yaml`,
  `instances-e2e/`, or `fake-telegram/`.
- The Host's `secretRef` Secret (`chatllm-api-keys`) is filled by the human in
  Control UI → Secrets → LLM, never by the agent.

## NetworkPolicy enforcement flag (WRC)

Keep the base values `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=required` and
`CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED=false`. In that state WRC refuses
recipes that need external egress. Never set `warn`: it logs a warning and
deploys anyway.

Add `patches/wrc-network-policy.yaml` to `patches:` and re-apply only when all
of these hold:

- [`scripts/np-deny-probe.sh`](../scripts/np-deny-probe.sh) passed.
- `OVERLAY=aws-eks np-enforce-preflight.sh` reports no FAIL.
- The human agrees.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-recipes
  namespace: control-plane
spec:
  template:
    spec:
      containers:
        - name: workflow-recipes
          env:
            - name: CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE
              value: required
            - name: CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED
              value: "true"
```

## What must not be in the overlay

- `fake-telegram/`, `instances-e2e/`, minikube `127.0.0.1` / `localhost` URLs
- Any Secret, token, cookie secret, password, or `replace-with-*` placeholder
  (`patches/service-tokens.yaml`-style files wipe live tokens on apply)
- `WEBHOOK_PUBLIC_BASE_URL` (no code reads it)
- `CLERUM_DEV_MODE`, or `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=warn`
- Registry Postgres/MinIO secrets, Evenfire Artifact Registry hostnames, tunnel
  UUIDs, or CIDRs from another cluster
