# Customer overlay requirements (`deploy/overlays/aws-eks`)

What the overlay must contain, and why. Write the files yourself from
`deploy/base`, `deploy/components/ghcr-images`, and the minikube overlay used as
a template only. Snippets show shape, not complete files.

The overlay lives **only in the customer's release checkout** (`$REPO_DIR`).
Never open a PR with it. Its directory name must be exactly `aws-eks`:
`verify-networkpolicies.sh --overlay aws-eks` and `np-enforce-preflight.sh` with
`OVERLAY=aws-eks` resolve `deploy/overlays/<name>`. The guide's Phase 4 gate must
pass on the render.

## Layout

```text
deploy/overlays/aws-eks/
  kustomization.yaml
  configmaps/rpc-proxy-config.yaml        # required (not in base)
  configmaps/mcp-host-config.yaml         # required (not in base)
  configmaps/cloudflared-config.yaml      # Cloudflare Tunnel only
  patches/control-api-config.yaml
  patches/dynamic-images.yaml
  patches/external-rest-api-urls.yaml
  patches/storage.yaml
  patches/k8s-api-ip.yaml                 # from live cluster values
  patches/hcc-cluster.yaml                # from live cluster values
  patches/kube-dns-egress-rule.yaml       # from live cluster values
  patches/alb-ingress-*.yaml              # ALB/NLB only, from live subnet values
  patches/wrc-network-policy.yaml         # only after guide step 5.14 allows it
  instances/host.yaml
  instances/context.yaml
  instances/globalfilesystem.yaml
```

`kustomization.yaml` uses `resources: [../../base, …]`, the
`../../components/ghcr-images` component, and `patches:` only
(`patchesStrategicMerge` is deprecated in kustomize v5).

## Kubernetes API, DNS, and HCC cluster values

Regenerate these from the live cluster (guide Phase 0.5); never copy CIDRs from
another cluster.

- **API egress ipBlocks:** in `allow-k8s-api-egress-control-plane`, `-channels`,
  and `-mcp-host`, replace the base placeholder `10.109.0.1/32` with the
  `kubernetes` Service ClusterIP **and** every EndpointSlice address, each as
  `/32`, on 443 (`mcp-host` also 8443). Some CNIs (Calico, Cilium) evaluate the
  post-DNAT endpoint address, so both are required.
- **`host-context-controller` env:** `CONTEXT_MAPPER_K8S_API_CIDRS` = the same
  `/32` list (HCC fails closed on anything wider than IPv4 `/24` and reads it only
  at startup); `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR` = the NodeLocal DNSCache `/32`
  or empty; `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` = the RWO class (the
  code default `do-block-storage-retain` does not exist on EKS).
- **DNS:** append a TCP/UDP 53 rule to the kube-dns ClusterIP `/32` (plus the
  NodeLocal DNSCache IP, if present) on every `allow-dns-egress-*` policy and on
  `sandbox-ui-static-dns-egress`. Target the first with a name regex, for example
  `"allow-dns-egress-(channels|control-plane|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|webhook-ingress)"`
  (add `ingress` for the Tunnel). `np-enforce-preflight.sh` requires this ipBlock
  in every namespace.

## Ingress

The base public-ingress policies admit **only** `app: cloudflared` pods from the
`ingress` namespace.

**Variant A, ALB/NLB or an in-cluster ingress controller.** Add an ingress rule
to exactly these four policies, with these ports:

| Policy | Ports |
| --- | --- |
| `control-plane/control-ui-network` | 3000 |
| `profiles/allow-ingress-profiles` | 3001, 8091 |
| `rpc-proxy/rpc-proxy` | 8094 |
| `webhook-ingress/allow-public-ingress-webhook-proxy` | 8095 |

The `from` peer depends on where traffic arrives from:

- AWS Load Balancer Controller in **IP target mode** (preferred): `ipBlock`s for
  the subnets the ALB/NLB is placed in.
- **Instance target mode** / NodePort: the node subnets.
- An **in-cluster** controller: a `namespaceSelector` and `podSelector` for the
  controller pods, no ipBlocks. Do not use ingress-nginx: upstream ended releases
  and security fixes in March 2026
  ([Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).

Without these rules an enforcing CNI drops all load-balancer traffic and every
hostname times out. `rpc-proxy/allow-ingress-rpc-proxy` is a different policy; do
not target it.

**Variant B, Cloudflare Tunnel.** Add `../../base/ingress` and a
`cloudflared-config` ConfigMap to `resources`. The config maps `app`, `profile`,
`api`, `rpc`, `webhook` to the five Services (guide Phase 7), ends with
`http_status:404`, and points `credentials-file` under `/etc/cloudflared-creds/`
(the Secret mount in `deploy/base/ingress/cloudflared.yaml`). This `replacements`
block is required: without it `allow-cloudflared-egress` renders `0.0.0.0/0` with
no exceptions (instance metadata and the VPC reachable) and
`lint-networkpolicies.sh` fails.

```yaml
replacements:
  - source: {group: clerum.io, version: v1alpha1, kind: PublicEgressExceptionSet,
             name: public-egress-exceptions, fieldPath: spec.ranges}
    targets:
      - select: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-cloudflared-egress}
        fieldPaths: [spec.egress.*.to.*.ipBlock.except]
```

## ConfigMaps not in base

Both start from the minikube templates in `deploy/overlays/minikube/configmaps/`
at the release.

**`rpc-proxy-config`** (`rpc-proxy` loads it via `envFrom`; missing →
`CreateContainerConfigError`): remove `RPC_PROXY_DESKTOP_COOKIE_SECRET`,
`RPC_PROXY_DESKTOP_API_TOKEN`, and `RPC_PROXY_SANDBOX_UI_COOKIE_SECRET` (the real
values live in `rpc-proxy-secrets`, written by `gen-jwt-keys.sh`); set
`RPC_PROXY_CORS_ORIGIN` to `https://app.<domain>,https://api.<domain>` and
`RPC_PROXY_OAUTH_CALLBACK_BASE_URL` to `https://api.<domain>`; replace every
`localhost`, `127.0.0.1`, `minikube`, or `test` value.

**`mcp-host-config`** (HCC-spawned Host pods load it): `CLERUM_AUTH_JWT_PUBLIC_KEY`
is a placeholder. `provision-gfs-runtime.sh` syncs the real key and must be re-run
after every apply, which resets it.

## `control-api-config`

| Key | Value | Why |
| --- | --- | --- |
| `CONTROL_API_CONTROL_UI_BASE_URL`, `…_OAUTH_CALLBACK_BASE_URL`, `…_DESKTOP_PROFILE_UI_BASE_URL`, `…_DESKTOP_EXTERNAL_REST_API_BASE_URL`, `…_DESKTOP_RPC_PROXY_BASE_URL` | the human's `https://<host>.<domain>` URLs | base ships `127.0.0.1` values |
| `CONTROL_API_ALLOWED_IMAGE_PREFIXES` | `ghcr.io/evenfire-ai/,registry.evenfire.ai/,mongodb/,mcr.microsoft.com/` | base includes `clerum/`, an unqualified Docker Hub namespace Evenfire does not own |
| `TRACING_ENVIRONMENT`, `TRACING_CLUSTER_NAME`, `TRACING_CLUSTER_LOCATION` | a deployment label, the cluster name, the region | required in production at the validated release; without them control-api exits ("Missing required governed tracing environment variable") and trace-maintenance-worker stays in `CreateContainerConfigError`. Base does not set them |
| `CLERUM_REGISTRY_URL`, `REGISTRY_CONNECTION_MODE` | `https://registry.evenfire.ai`, `self-hosted` | without them Marketplace shows "The registry is currently unavailable". The default mode `managed` never runs the self-hosted connect flow (release doc `docs/how-to/connect-to-registry.md`) |

The `TRACING_*` and registry findings come from a live install of the same
release on another managed Kubernetes service (the DOKS guide); they are base
behaviour, not cloud-specific. Leave `CONTROL_API_GROK_SUBSCRIPTION_ENABLED` at its
base value unless the human enables Grok. `external-rest-api` needs
`EXTERNAL_REST_API_CORS_ORIGIN`, `…_PUBLIC_BASE_URL`, and
`…_DESKTOP_RPC_PROXY_BASE_URL` set to the same public URLs.

## Images

- **Platform images:** only `ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`. The
  `ghcr-images` component rewrites every `clerum/*` image and every env value
  starting with `clerum/` that base sets.
- **Third-party images base pins, from Docker Hub:** `postgres:16-alpine`,
  `nginx:1.30.1-alpine`, `busybox:1.36`, and `cloudflare/cloudflared@sha256:…`
  (Tunnel). Keep them as pinned; allow Docker Hub or mirror them.
- **HCC env vars base does not set** fall back to unqualified Docker Hub names
  (`clerum/mcp-host-desktop:latest`, `clerum/channel-reader:0.9.5`,
  `clerum/gfs-controller:test`). Set `CONTEXT_MAPPER_HOST_IMAGE`,
  `…_DESKTOP_IMAGE`, `…_CHANNEL_READER_IMAGE`, and `…_GFSC_IMAGE` to the release
  images (`mcp-host-desktop` is published on GHCR though the component does not
  list it), `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES` without `clerum/`, and
  `workflow-recipes`' `CLERUM_MCP_HOST_IMAGE` to `mcp-host-slim:$RELEASE_TAG`.
  Write the tag literally; kustomize does not expand variables.

If a pull returns `MANIFEST_UNKNOWN`, stop. Never fall back to `latest`, `main`,
or `sha-*`.

## Storage

Run `kubectl get sc` first. EKS clusters often have `gp2` (or `gp3` with the EBS
CSI driver) and may have **no default** StorageClass.

| Consumer | Requirement |
| --- | --- |
| `control-postgres-data` (control-plane) | `storageClassName` = the RWO class |
| `clerum-workflow-output` (sandbox-recipes) | base requests **RWX**, which EBS cannot provision; patch to `ReadWriteOnce` + RWO class |
| per-recipe workflow output PVCs | none; they need a **default** StorageClass (ask the human before marking one) |
| HCC Host workspaces | `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` |
| GlobalFileSystem | `instances/globalfilesystem.yaml` `spec.storage.storageClassName`; the CRD default `standard-rwo` does not exist on EKS, and `provision-gfs-runtime.sh` then waits forever |

A new install does not need EFS/RWX.

## Instances

`provision-gfs-runtime.sh` applies everything in `instances/` and waits for
`GlobalFileSystem/gfs` to be `Ready`.

- `globalfilesystem.yaml`: `gfs` in namespace `gfs`, size from the human, the RWO
  class, `ReadWriteOnce`, `retainOnDelete: true`.
- `context.yaml` and `host.yaml`: start from `deploy/overlays/minikube/instances/`.
  Set the model `provider` and `name` to the human's choice and drop the minikube
  Telegram channel and approval channel. The Host's `secretRef` Secret is filled
  by the human in Control UI, never by the agent.
- Do not copy `communicationchannel.yaml`, `workflowrecipepolicy.yaml`,
  `instances-e2e/`, or `fake-telegram/`.

## WorkflowRecipe enforcement flag

Keep `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=required` and `…_CONFIRMED=false`
(base values) until the guide's step 5.14 conditions hold; then patch
`workflow-recipes` with `…_CONFIRMED: "true"`. Never set `warn`.

## What must not be in the overlay

- `fake-telegram/`, `instances-e2e/`, minikube `127.0.0.1` / `localhost` URLs
- Any Secret, token, cookie secret, password, or `replace-with-*` placeholder (a
  Secret value in a kustomize patch is wiped by the next apply)
- `WEBHOOK_PUBLIC_BASE_URL` (no code reads it), `CLERUM_DEV_MODE`, WRC `warn`
- Registry Postgres/MinIO secrets, Evenfire Artifact Registry hostnames, tunnel
  UUIDs, or CIDRs from another cluster
