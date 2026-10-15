# Customer overlay requirements (`deploy/overlays/digitalocean-doks`)

What the overlay must contain, and why. Write the files yourself from
`deploy/base`, `deploy/components/ghcr-images`, and the minikube overlay used as
a template only. Snippets show shape, not complete files.

The overlay lives **only in the customer's release checkout** (`$REPO_DIR`).
Never open a PR with it. Its directory name must be exactly `digitalocean-doks`:
`verify-networkpolicies.sh --overlay digitalocean-doks` and
`np-enforce-preflight.sh` with `OVERLAY=digitalocean-doks` resolve
`deploy/overlays/<name>`. The guide's Phase 4 gate must pass on the render.

## Layout

```text
deploy/overlays/digitalocean-doks/
  kustomization.yaml
  configmaps/rpc-proxy-config.yaml        # required (not in base)
  configmaps/mcp-host-config.yaml         # required (not in base)
  configmaps/cloudflared-config.yaml      # Variant B only
  patches/control-api-config.yaml
  patches/dynamic-images.yaml
  patches/external-rest-api-urls.yaml
  patches/storage.yaml
  patches/k8s-api-ip.yaml                 # from live cluster values
  patches/hcc-cluster.yaml                # from live cluster values
  patches/kube-dns-egress-rule.yaml       # from live cluster values
  patches/cilium-api-egress.yaml          # a resource, not a patch
  patches/ingress-controller-*.yaml       # Variant A only
  patches/wrc-network-policy.yaml         # only after guide step 5.14 allows it
  instances/host.yaml
  instances/context.yaml
  instances/globalfilesystem.yaml
```

`kustomization.yaml` uses `resources: [../../base, …]`, the
`../../components/ghcr-images` component, and `patches:` only
(`patchesStrategicMerge` is deprecated in kustomize v5).

## Kubernetes API egress

DigitalOcean lists as a known issue that "The new control plane architecture does
not support using a Kubernetes `NetworkPolicy` to selectively allow access to the
API server when a `NetworkPolicy` restricts it. You can instead use
`CiliumNetworkPolicies`"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
Cilium's CIDR selectors do not match in-cluster entities unless
`policy-cidr-match-mode=nodes`, and egress `toEntities: kube-apiserver` is the
supported selector
([Cilium layer 3 policy](https://docs.cilium.io/en/stable/security/policy/language/)).
Evenfire's base grants API egress with NetworkPolicy ipBlocks only, so the
overlay carries both:

**CiliumNetworkPolicies** (in `resources`), named
`allow-k8s-api-egress-cilium-<namespace>`, with the same pod selectors as the
base and HCC API-egress NetworkPolicies, `toEntities: [kube-apiserver]`, and
`toPorts` limited to these ports:

| Namespace | Pod selector (v0.10.0) | Ports |
| --- | --- | --- |
| `control-plane` | `app In [host-context-controller, workflow-recipes, control-api, trace-maintenance-worker]` | 443, API endpoint port |
| `channels` | `app: channel-reader` | 443, API endpoint port |
| `mcp-host` | `clerum.io/managed-by: host-context-controller` | 443, API endpoint port, 8443 |
| `mcp-server`, `sandbox-recipes`, `rpc-proxy` | `clerum.io/k8s-api-egress: "true"` (HCC opt-in label) | 443, API endpoint port |

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-k8s-api-egress-cilium-channels
  namespace: channels
spec:
  endpointSelector:
    matchLabels: {app: channel-reader}
  egress:
    - toEntities: [kube-apiserver]
      toPorts:
        - ports:
            - {port: "443", protocol: TCP}
```

Do not label them `clerum.io/managed-by`. Cilium unions allow rules, so they add
API reachability without widening anything else. At `v0.10.0` no pod carries the
opt-in label, so the last three grant nothing today; they keep the opt-in working.

**ipBlock patches**, still required because `verify-networkpolicies.sh` fails
while the base placeholder `10.109.0.1/32` is rendered and
`np-enforce-preflight.sh` compares them with the live endpoints:

- `allow-k8s-api-egress-control-plane`, `-channels`, `-mcp-host`: replace the
  placeholder with the `kubernetes` Service ClusterIP **and** every EndpointSlice
  address, each as `/32`, on 443 (`mcp-host` also 8443).
- `host-context-controller` env: `CONTEXT_MAPPER_K8S_API_CIDRS` = the same `/32`
  list (HCC fails closed on anything wider than IPv4 `/24` and reads it only at
  startup), `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR` empty (no NodeLocal DNS on DOKS),
  `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` = the default StorageClass.
- DNS: append a TCP/UDP 53 rule to the kube-dns ClusterIP `/32` on every
  `allow-dns-egress-*` policy and on `sandbox-ui-static-dns-egress`. Target the
  first with a name regex, for example
  `"allow-dns-egress-(channels|control-plane|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|webhook-ingress)"`
  (add `ingress` for Variant B).

## Ingress

The base public-ingress policies admit **only** `app: cloudflared` pods from the
`ingress` namespace.

**Variant A, in-cluster ingress controller behind a DigitalOcean load balancer.**
DigitalOcean network load balancers preserve the client IP, and "Backend IP
addresses may change at any time and should not be used to configure firewalls"
([load balancer features](https://docs.digitalocean.com/products/networking/load-balancers/details/features/)),
so there is no source CIDR to allow. Add an ingress rule admitting the controller
pods by `namespaceSelector` (`kubernetes.io/metadata.name: <controller namespace>`)
and `podSelector` (labels read from the running controller pods, selecting only
them) to exactly these four policies, with these ports:

| Policy | Ports |
| --- | --- |
| `control-plane/control-ui-network` | 3000 |
| `profiles/allow-ingress-profiles` | 3001, 8091 |
| `rpc-proxy/rpc-proxy` | 8094 |
| `webhook-ingress/allow-public-ingress-webhook-proxy` | 8095 |

`rpc-proxy/allow-ingress-rpc-proxy` is a different policy; do not target it.
Filter clients with `loadBalancerSourceRanges` on the load balancer. Use the
customer's existing controller, or one from DigitalOcean's 1-Click catalog
(`doctl kubernetes 1-click list`; it listed `traefik` when this was validated).
Do not install ingress-nginx: upstream ended releases and security fixes in March
2026 ([Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).
Cilium Gateway API is not a variant: its traffic carries Cilium's reserved
`ingress` identity, which a NetworkPolicy cannot select.

**Variant B, Cloudflare Tunnel.** Add `../../base/ingress` and a
`cloudflared-config` ConfigMap to `resources`. The config maps `app`, `profile`,
`api`, `rpc`, `webhook` to the five Services (Phase 7 of the guide), ends with
`http_status:404`, and points `credentials-file` under `/etc/cloudflared-creds/`
(the Secret mount in `deploy/base/ingress/cloudflared.yaml`). This `replacements`
block is required: without it `allow-cloudflared-egress` renders `0.0.0.0/0` with
no exceptions and `lint-networkpolicies.sh` fails.

```yaml
replacements:
  - source: {group: clerum.io, version: v1alpha1, kind: PublicEgressExceptionSet,
             name: public-egress-exceptions, fieldPath: spec.ranges}
    targets:
      - select: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-cloudflared-egress}
        fieldPaths: [spec.egress.*.to.*.ipBlock.except]
```

**Variant C, internal only.** No ingress patches. The base public-ingress policies
stay closed; operators use `kubectl port-forward`. Moving to A or B later is an
overlay change followed by the guide's day-2 rule.

## ConfigMaps not in base

Both start from the `v0.10.0` minikube templates in
`deploy/overlays/minikube/configmaps/`.

**`rpc-proxy-config`** (`rpc-proxy` loads it via `envFrom`; missing →
`CreateContainerConfigError`):

- Remove `RPC_PROXY_DESKTOP_COOKIE_SECRET`, `RPC_PROXY_DESKTOP_API_TOKEN`, and
  `RPC_PROXY_SANDBOX_UI_COOKIE_SECRET`. The real values live in
  `rpc-proxy-secrets` (written by `gen-jwt-keys.sh`).
- `RPC_PROXY_CORS_ORIGIN: "https://app.<domain>,https://api.<domain>"` and
  `RPC_PROXY_OAUTH_CALLBACK_BASE_URL: "https://api.<domain>"`.
- Keep `RPC_PROXY_STREAM_KEEPALIVE_MS` (15 s); it keeps `rpc` server-sent events
  inside a 60 s load-balancer idle timeout.

**`mcp-host-config`** (HCC-spawned Host pods load it):

- `CLERUM_AUTH_JWT_PUBLIC_KEY`: a placeholder. `provision-gfs-runtime.sh` syncs
  the real key from `rpc-proxy-secrets` and must be re-run after every apply,
  which resets it.

## `control-api-config`

| Key | Value | Why |
| --- | --- | --- |
| `CONTROL_API_CONTROL_UI_BASE_URL`, `…_OAUTH_CALLBACK_BASE_URL`, `…_DESKTOP_PROFILE_UI_BASE_URL`, `…_DESKTOP_EXTERNAL_REST_API_BASE_URL`, `…_DESKTOP_RPC_PROXY_BASE_URL` | the human's `https://<host>.<domain>` URLs | base ships `127.0.0.1` values |
| `CONTROL_API_ALLOWED_IMAGE_PREFIXES` | `ghcr.io/evenfire-ai/,registry.evenfire.ai/,mongodb/,mcr.microsoft.com/` | base includes `clerum/`, an unqualified Docker Hub namespace Evenfire does not own |
| `TRACING_ENVIRONMENT`, `TRACING_CLUSTER_NAME`, `TRACING_CLUSTER_LOCATION` | a deployment label, the cluster name, the region | required in production; without them control-api exits ("Missing required governed tracing environment variable") and trace-maintenance-worker stays in `CreateContainerConfigError` (observed live). Base does not set them |
| `CLERUM_REGISTRY_URL`, `REGISTRY_CONNECTION_MODE` | `https://registry.evenfire.ai`, `self-hosted` | without them Marketplace shows "The registry is currently unavailable" (observed live). The default mode `managed` never runs the self-hosted connect flow (release doc `docs/how-to/connect-to-registry.md`) |

Leave `CONTROL_API_GROK_SUBSCRIPTION_ENABLED` at its base value `'false'` unless
the human enables Grok. `external-rest-api` needs
`EXTERNAL_REST_API_CORS_ORIGIN`, `…_PUBLIC_BASE_URL`, and
`…_DESKTOP_RPC_PROXY_BASE_URL` set to the same public URLs.

## Images

- **Platform images:** only `ghcr.io/evenfire-ai/<name>:$RELEASE_TAG`. The
  `ghcr-images` component rewrites every `clerum/*` image and every env value
  starting with `clerum/` that base sets.
- **Third-party images base pins, from Docker Hub:** `postgres:16-alpine`,
  `nginx:1.30.1-alpine`, `busybox:1.36`, and `cloudflare/cloudflared@sha256:…`
  (Variant B). Keep them as pinned.
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

DigitalOcean volumes are ReadWriteOnce only ("accessModes must be set to
ReadWriteOnce",
[add volumes](https://docs.digitalocean.com/products/kubernetes/how-to/add-volumes/)).
Use the single default StorageClass from the guide's Phase 0.

| Consumer | Requirement |
| --- | --- |
| `control-postgres-data` (control-plane) | `storageClassName` = default class |
| `clerum-workflow-output` (sandbox-recipes) | base requests **RWX**; patch to `ReadWriteOnce` + default class |
| per-recipe workflow output PVCs | none (they use the default class) |
| HCC Host workspaces | `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS`; the code default `do-block-storage-retain` exists on DOKS but keeps volumes (and billing) after deletion |
| GlobalFileSystem | `instances/globalfilesystem.yaml` `spec.storage.storageClassName`; the CRD default `standard-rwo` does not exist on DOKS, and `provision-gfs-runtime.sh` then waits forever |

At most 15 volumes attach to one DOKS node
([volume limits](https://docs.digitalocean.com/products/volumes/details/limits/)).

## Instances

`provision-gfs-runtime.sh` applies everything in `instances/` and waits for
`GlobalFileSystem/gfs` to be `Ready`.

- `globalfilesystem.yaml`: `gfs` in namespace `gfs`, size from the human, the
  default StorageClass, `ReadWriteOnce`, `retainOnDelete: true`.
- `context.yaml` and `host.yaml`: start from `deploy/overlays/minikube/instances/`.
  Set the model `provider` and `name` to the human's choice and drop the minikube
  Telegram channel and approval channel. The Host's `secretRef` Secret is filled
  by the human in Control UI, never by the agent.
- Do not copy `communicationchannel.yaml`, `workflowrecipepolicy.yaml`,
  `instances-e2e/`, or `fake-telegram/`.

## WorkflowRecipe enforcement flag

Keep `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=required` and
`…_CONFIRMED=false` (base values) until the guide's step 5.14 conditions hold;
then patch `workflow-recipes` with `…_CONFIRMED: "true"`. Never set `warn`.

## What must not be in the overlay

- `fake-telegram/`, `instances-e2e/`, minikube `127.0.0.1` / `localhost` URLs
- Any Secret, token, cookie secret, password, or `replace-with-*` placeholder (a
  Secret value in a kustomize patch is wiped by the next apply)
- `WEBHOOK_PUBLIC_BASE_URL` (no code reads it), `CLERUM_DEV_MODE`, WRC `warn`
- Gateway API CRDs, or any object labelled `doks.digitalocean.com/managed: "true"`
- IP addresses, cluster IDs, or tunnel UUIDs from another cluster
