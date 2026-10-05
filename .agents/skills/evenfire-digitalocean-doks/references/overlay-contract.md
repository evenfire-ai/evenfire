# Customer overlay contract (`deploy/overlays/digitalocean-doks`)

The overlay lives **only in the customer's release checkout** (`$REPO_DIR`, the
public repo at `$RELEASE_TAG`). Never open a PR with it. The directory name must
be exactly `digitalocean-doks`: `verify-networkpolicies.sh --overlay
digitalocean-doks` and `np-enforce-preflight.sh` with `OVERLAY=digitalocean-doks`
resolve `deploy/overlays/<name>`.

Every file block below is rendered for both ingress variants, linted with
`deploy/scripts/lint-networkpolicies.sh`, and passed through `image-gate.rb`
against the guide's validated release by
`scripts/tests/test-doks-overlay-contract.sh`. If `RELEASE_TAG` differs from the
validated release, re-run the guide's Phase 4 gate and stop on any difference.

Placeholders you must replace before rendering:

| Placeholder | Value |
| --- | --- |
| `<domain>` | the human's domain, or the agreed internal names for an internal-only pilot |
| `<RELEASE_TAG>` | `$RELEASE_TAG`, written literally (kustomize does not expand variables) |
| `<STORAGE_CLASS>` | `DEFAULT_SC` from `doks-discover.sh` (the default StorageClass) |
| `<GFS_SIZE>` | asked from the human |
| `<LLM_PROVIDER>` / `<LLM_MODEL>` | the human's model choice |
| `<TUNNEL_ID>` | Variant B only: the Cloudflare Tunnel UUID (not a secret) |

## Layout

```text
deploy/overlays/digitalocean-doks/
  kustomization.yaml
  configmaps/rpc-proxy-config.yaml        # required (not in base)
  configmaps/mcp-host-config.yaml         # required (not in base)
  configmaps/cloudflared-config.yaml      # Variant B only
  patches/control-api-config.yaml         # public URLs + image allowlist
  patches/dynamic-images.yaml             # HCC/WRC spawned images
  patches/external-rest-api-urls.yaml
  patches/storage.yaml
  patches/k8s-api-ip.yaml                 # generated
  patches/hcc-cluster.yaml                # generated
  patches/kube-dns-egress-rule.yaml       # generated
  patches/cilium-api-egress.yaml          # generated; a resource, not a patch
  patches/ingress-controller-*.yaml       # generated, Variant A only
  patches/wrc-network-policy.yaml         # only after guide step 5.14 allows it
  instances/host.yaml
  instances/context.yaml
  instances/globalfilesystem.yaml
```

The `generated` files come from
[`scripts/write-network-patches.sh`](../scripts/write-network-patches.sh). Never
hand-edit them; re-run the script.

## Kubernetes API egress on DOKS

DigitalOcean lists as a known issue that "The new control plane architecture does
not support using a Kubernetes `NetworkPolicy` to selectively allow access to the
API server when a `NetworkPolicy` restricts it. You can instead use
`CiliumNetworkPolicies`"
([DOKS limits](https://docs.digitalocean.com/products/kubernetes/details/limits/)).
Cilium documents why: CIDR selectors do not match in-cluster entities unless
`policy-cidr-match-mode=nodes`, and egress `toEntities: kube-apiserver` is the
supported selector
([Cilium layer 3 policy](https://docs.cilium.io/en/stable/security/policy/language/)).

Evenfire's base grants API egress with NetworkPolicy ipBlocks only. On DOKS the
overlay therefore adds `patches/cilium-api-egress.yaml`: one
CiliumNetworkPolicy per namespace, named `allow-k8s-api-egress-cilium-<ns>`, with
the same pod selector as the matching NetworkPolicy and `toPorts` limited to 443,
the kubernetes EndpointSlice port, and (mcp-host) 8443. Cilium unions allow
rules, so these add API reachability without widening anything else.

The ipBlock patches (`k8s-api-ip.yaml`, `hcc-cluster.yaml`) are still generated:
`verify-networkpolicies.sh` fails while the base placeholder `10.109.0.1/32` is
rendered, and `np-enforce-preflight.sh` check 2 compares them with the live
endpoints. On DOKS they do not prove API reachability;
[`api-egress-probe.sh`](../scripts/api-egress-probe.sh) does.

## `kustomization.yaml`

Use `patches:` only. `patchesStrategicMerge` is deprecated in kustomize v5.

### Variant A — in-cluster ingress controller behind a DigitalOcean load balancer

The base public-ingress policies admit **only** `app: cloudflared` pods from the
`ingress` namespace. DigitalOcean gives no source CIDR for load-balancer traffic:
network load balancers preserve the client IP, and "Backend IP addresses may
change at any time and should not be used to configure firewalls"
([load balancer features](https://docs.digitalocean.com/products/networking/load-balancers/details/features/)).
So the four `ingress-controller-*` patches admit the ingress controller pods by
namespace and pod labels instead of by address. Client filtering belongs on the
load balancer (`loadBalancerSourceRanges`).

Use the ingress controller the customer already operates. If there is none,
pick an in-cluster controller from DigitalOcean's 1-Click catalog
(`doctl kubernetes 1-click list`; it listed `traefik` when this contract was
validated). Installing it creates a billed load balancer, so ask first. Do not
install ingress-nginx: the Kubernetes project ended its maintenance in March
2026, with "no further releases, no bugfixes, and no updates to resolve any
security vulnerabilities"
([Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)).

Cilium Gateway API is not a supported variant: its traffic carries Cilium's
reserved `ingress` identity, which a NetworkPolicy cannot select.

<!-- file: kustomization.yaml variants: A -->
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - configmaps/rpc-proxy-config.yaml
  - configmaps/mcp-host-config.yaml
  - patches/cilium-api-egress.yaml
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
    path: patches/ingress-controller-control-ui.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-ingress-profiles, namespace: profiles}
    path: patches/ingress-controller-profiles.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: rpc-proxy, namespace: rpc-proxy}
    path: patches/ingress-controller-rpc-proxy.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: allow-public-ingress-webhook-proxy, namespace: webhook-ingress}
    path: patches/ingress-controller-webhook-proxy.yaml
```

The patch targets are exact. `rpc-proxy/allow-ingress-rpc-proxy` is a different
policy; do not target it.

Run the generator with `INGRESS_MODE=controller`, `INGRESS_NAMESPACE`, and
`INGRESS_POD_LABELS` read from the running controller pods (choose labels that
select only the controller pods, never a whole namespace):

```bash
kubectl --context "$CONTEXT" -n "$INGRESS_NAMESPACE" get pods -o jsonpath='{range .items[*]}{.metadata.labels}{"\n"}{end}'
```

### Variant B — Cloudflare Tunnel

No public load balancer. Run the generator with `INGRESS_MODE=tunnel`. The
`replacements` block is required: without it `allow-cloudflared-egress` renders
`0.0.0.0/0` with no exceptions and `lint-networkpolicies.sh` fails.

<!-- file: kustomization.yaml variants: B -->
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - ../../base/ingress
  - configmaps/rpc-proxy-config.yaml
  - configmaps/mcp-host-config.yaml
  - configmaps/cloudflared-config.yaml
  - patches/cilium-api-egress.yaml
components:
  - ../../components/ghcr-images
patches:
  - path: patches/control-api-config.yaml
  - path: patches/dynamic-images.yaml
  - path: patches/hcc-cluster.yaml
  - path: patches/external-rest-api-urls.yaml
  - path: patches/storage.yaml
  - path: patches/k8s-api-ip.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: "allow-dns-egress-(channels|control-plane|ingress|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|webhook-ingress)"}
    path: patches/kube-dns-egress-rule.yaml
  - target: {group: networking.k8s.io, version: v1, kind: NetworkPolicy, name: sandbox-ui-static-dns-egress, namespace: sandbox-ui}
    path: patches/kube-dns-egress-rule.yaml
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

`credentials-file` must point under `/etc/cloudflared-creds/`, the Secret mount
in `deploy/base/ingress/cloudflared.yaml`.

<!-- file: configmaps/cloudflared-config.yaml variants: B -->
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloudflared-config
  namespace: ingress
data:
  config.yaml: |
    tunnel: <TUNNEL_ID>
    credentials-file: /etc/cloudflared-creds/credentials.json
    no-autoupdate: true
    ingress:
      - hostname: app.<domain>
        service: http://control-ui.control-plane.svc.cluster.local:3000
      - hostname: profile.<domain>
        service: http://profile-ui.profiles.svc.cluster.local:3001
      - hostname: api.<domain>
        service: http://external-rest-api.profiles.svc.cluster.local:8091
      - hostname: rpc.<domain>
        service: http://rpc-proxy.rpc-proxy.svc.cluster.local:8094
      - hostname: webhook.<domain>
        service: http://webhook-proxy.webhook-ingress.svc.cluster.local:8095
      - service: http_status:404
```

### Variant C — internal only (port-forward)

For an agreed internal pilot with no public exposure. Run the generator with
`INGRESS_MODE=internal`. The base public-ingress policies stay as shipped: they
admit only `cloudflared`, which is not deployed, so nothing outside the cluster
reaches the five services. Operators use `kubectl port-forward`. Use the agreed
internal names for `<domain>`.

<!-- file: kustomization.yaml variants: C -->
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  - configmaps/rpc-proxy-config.yaml
  - configmaps/mcp-host-config.yaml
  - patches/cilium-api-egress.yaml
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
```

Moving from Variant C to A or B later is an overlay change: switch the
kustomization, re-run the generator with the new `INGRESS_MODE`, and follow the
day-2 rule (re-render, gate, apply, tokens, `provision-gfs-runtime.sh`).

## ConfigMaps not in base

`rpc-proxy` loads `rpc-proxy-config` via `envFrom` (missing →
`CreateContainerConfigError`); HCC-spawned Host pods load `mcp-host-config`.
These are the `v0.10.0` minikube templates with the minikube values replaced.
The three `RPC_PROXY_*` cookie and token values are removed: the real values live
in `rpc-proxy-secrets`, written by `gen-jwt-keys.sh`.

<!-- file: configmaps/rpc-proxy-config.yaml variants: A B C -->
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: rpc-proxy-config
  namespace: rpc-proxy
  labels:
    app: rpc-proxy
data:
  RPC_PROXY_PORT: "8094"
  RPC_PROXY_CORS_ORIGIN: "https://app.<domain>,https://api.<domain>"
  RPC_PROXY_JWT_ISSUER: "control-api"
  RPC_PROXY_JWT_AUDIENCE: "rpc-proxy"
  RPC_PROXY_CONTROL_API_BASE_URL: "http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/api/v1"
  RPC_PROXY_CONTROL_API_CACHE_TTL_MS: "30000"
  RPC_PROXY_UPSTREAM_TIMEOUT_MS: "60000"
  RPC_PROXY_MAX_TOKEN_LENGTH: "4096"
  RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB: "250"
  RPC_PROXY_ALLOWED_METHOD_PATTERN: "^[a-zA-Z0-9_./:-]{1,120}$"
  RPC_PROXY_STREAM_MAX_LIFETIME_MS: "600000"
  RPC_PROXY_STREAM_INTERVAL_MS: "3000"
  RPC_PROXY_STREAM_KEEPALIVE_MS: "15000"
  RPC_PROXY_STREAM_MAX_CONCURRENT: "1000"
  RPC_PROXY_STREAM_MAX_PER_USER: "3"
  RPC_PROXY_STREAM_MAX_PER_USER_HOST: "1"
  RPC_PROXY_STREAM_IDLE_TIMEOUT_MS: "60000"
  RPC_PROXY_ACTIVITY_STREAM_MAX_LIFETIME_MS: "600000"
  RPC_PROXY_ACTIVITY_STREAM_KEEPALIVE_MS: "15000"
  RPC_PROXY_ACTIVITY_STREAM_IDLE_TIMEOUT_MS: "60000"
  RPC_PROXY_ACTIVITY_STREAM_MAX_CONCURRENT: "1000"
  RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER: "3"
  RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST: "3"
  RPC_PROXY_HCC_BASE_URL: "http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081"
  RPC_PROXY_HOST_NAMESPACE: "mcp-host"
  RPC_PROXY_OAUTH_CALLBACK_BASE_URL: "https://api.<domain>"
```

`RPC_PROXY_STREAM_KEEPALIVE_MS` (15 s) keeps `rpc` server-sent event streams
active well inside a 60 s load-balancer idle timeout.

`CLERUM_AUTH_JWT_PUBLIC_KEY` is a placeholder on purpose:
`provision-gfs-runtime.sh` syncs the real key from `rpc-proxy-secrets` (guide
5.12) and must be re-run after every apply, which resets it.

<!-- file: configmaps/mcp-host-config.yaml variants: A B C -->
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-host-config
  namespace: mcp-host
  labels:
    app: mcp-host
data:
  CLERUM_HOST_NAME: 'chatllm'
  CLERUM_SERVER_PORT: '8080'
  CLERUM_CONTEXT_MAPPER_URL: 'http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081'
  CLERUM_CONTEXT_MAPPER_POLL_INTERVAL: '30000'
  MCP_PROXY_ENABLED: 'false'
  MCP_HOST_CODEX_SUBSCRIPTION_ENABLED: 'true'
  HCC_AUTHORITY_MAX_STALENESS_MS: '60000'
  MCP_PROXY_URL: 'http://mcp-proxy.mcp-server.svc.cluster.local:8083'
  CLERUM_AGENT_TASK_DELAY: '3'
  CLERUM_AGENT_MAX_TASK_DURATION: '86400000'
  CLERUM_SHELL_TIMEOUT: '1500000'
  CLERUM_TOOL_TIMEOUT: '1500000'
  CLERUM_MCP_TOOL_TIMEOUT_MS: '1500000'
  CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS: '1500000'
  CLERUM_TOOL_PROGRESS_INTERVAL_MS: '5000'
  CLERUM_AGENT_MAX_TOOL_CALLS: '1000'
  CLERUM_AGENT_MAX_QUEUE_SIZE: '100'
  CLERUM_BUDGETS_ENABLED: 'true'
  TRACING_APPROVAL_PROMPT_HISTORY_ENABLED: 'false'
  TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES: '16384'
  TRACING_APPROVAL_PROMPT_HISTORY_RETENTION_DAYS: '30'
  TRACING_APPROVAL_PROMPT_HISTORY_KEY_VERSION: 'v1'
  CLERUM_APPROVAL_CONFIG: '{"defaultPolicy":"channel_users","channels":{"telegram":{"enabled":true}}}'
  CLERUM_APPROVAL_TIMEOUT: '0'
  CLERUM_MEMORY_ENABLED: 'true'
  CLERUM_SESSION_STORE: 'sqlite'
  CLERUM_SESSION_SEARCH_ENABLED: 'true'
  CLERUM_SESSION_TTL_DAYS: '90'
  CLERUM_SEARCH_RETENTION_DAYS: '90'
  CLERUM_CONTEXT_MAX_TOKENS: '100000'
  CLERUM_ENABLE_RESPONSE_ATTACHMENTS: 'true'
  CLERUM_ATTACHMENT_MAX_COUNT: '3'
  CLERUM_ATTACHMENT_MAX_BYTES: '52428800'
  CLERUM_PERSONALIZATION_ENABLED: 'false'
  CLERUM_ENABLE_AUTH: 'true'
  CLERUM_AUTH_JWT_ISSUER: 'control-api'
  CLERUM_AUTH_JWT_AUDIENCE: 'rpc-proxy'
  CLERUM_AUTH_JWT_PUBLIC_KEY: 'synced-by-provision-gfs-runtime'
```

## `patches/control-api-config.yaml`

<!-- file: patches/control-api-config.yaml variants: A B C -->
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

Base ships `127.0.0.1` values that only work through a laptop port-forward. For an
internal-only pilot use the agreed internal URLs. Leave
`CONTROL_API_GROK_SUBSCRIPTION_ENABLED` at its base value `'false'` unless the
human enables Grok; `GROK_LLM_PROXY_ADMIN_URL` is already an in-cluster URL.

## `patches/external-rest-api-urls.yaml`

<!-- file: patches/external-rest-api-urls.yaml variants: A B C -->
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
  `ghcr-images` component rewrites every `clerum/*` image and every env value
  starting with `clerum/` that base sets, including `grok-llm-proxy` at `v0.10.0`.
- **Third-party images pinned by base, pulled from Docker Hub:**
  `postgres:16-alpine`, `nginx:1.30.1-alpine` (gateways), `busybox:1.36` (HCC
  init containers), and `cloudflare/cloudflared@sha256:…` (Variant B). Keep them
  as pinned. DigitalOcean warns that per-IP registry rate limits such as Docker
  Hub's can slow node readiness
  ([routing agent](https://docs.digitalocean.com/products/kubernetes/how-to/use-routing-agent/)).
- **Env vars base does not set** fall back to code defaults that are unqualified
  `clerum/*` names, which resolve to Docker Hub where Evenfire does not own the
  namespace. Set them explicitly. `mcp-host-desktop` is published on GHCR even
  though the component does not list it.

<!-- file: patches/dynamic-images.yaml variants: A B C -->
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
`"true"`. Turning enforcement on is the human's decision.

**Gate:** [`scripts/image-gate.rb`](../scripts/image-gate.rb) must print
`image gate: OK` for the render. If a pull returns `MANIFEST_UNKNOWN`, stop.
Never fall back to `latest`, `main`, or `sha-*`.

## Storage

DigitalOcean documents `do-block-storage` as the built-in StorageClass and
volumes as ReadWriteOnce only: "accessModes must be set to ReadWriteOnce"
([add volumes](https://docs.digitalocean.com/products/kubernetes/how-to/add-volumes/)).
Use the default class `doks-discover.sh` reports (`DEFAULT_SC`); do not assume
other classes exist.

| Consumer | Needs | How to set |
| --- | --- | --- |
| `control-postgres-data` (control-plane) | RWO | `patches/storage.yaml` |
| `clerum-workflow-output` (sandbox-recipes) | legacy PVC; base requests **RWX**, which DigitalOcean block storage cannot provide | `patches/storage.yaml`: `ReadWriteOnce` |
| Per-recipe workflow output PVCs (WRC) | RWO, no `storageClassName` | the cluster's default StorageClass |
| HCC Host workspace PVCs | RWO | `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` (generated). The code default `do-block-storage-retain` exists only if discovery reports `RETAIN_SC_PRESENT=yes` |
| GlobalFileSystem PVC | RWO | `instances/globalfilesystem.yaml`; the CRD default `standard-rwo` does not exist on DOKS |

DigitalOcean attaches at most 15 volumes to one DOKS node
([volume limits](https://docs.digitalocean.com/products/volumes/details/limits/)).
A new install does not need DigitalOcean Network File Storage.

<!-- file: patches/storage.yaml variants: A B C -->
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: control-postgres-data
  namespace: control-plane
spec:
  storageClassName: <STORAGE_CLASS>
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: clerum-workflow-output
  namespace: sandbox-recipes
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: <STORAGE_CLASS>
```

## Instances

`provision-gfs-runtime.sh` applies **everything** in `instances/` and then waits
for `GlobalFileSystem/gfs` to reach `Ready`. Do not copy
`communicationchannel.yaml`, `workflowrecipepolicy.yaml`, `instances-e2e/`, or
`fake-telegram/` from minikube.

<!-- file: instances/globalfilesystem.yaml variants: A B C -->
```yaml
apiVersion: clerum.io/v1alpha1
kind: GlobalFileSystem
metadata:
  name: gfs
  namespace: gfs
spec:
  storage:
    size: <GFS_SIZE>
    storageClassName: <STORAGE_CLASS>
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

<!-- file: instances/context.yaml variants: A B C -->
```yaml
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: context1
  namespace: mcp-server
spec:
  contextId: context1
  description: Default context; lists the MCP servers the Host can use.
  mcpServers: []
```

The Host below drops the minikube Telegram channel and approval channel. Add a
channel only after the human configures it. The Host's `secretRef` Secret
(`chatllm-api-keys`) is filled by the human in Control UI → Secrets → LLM, never
by the agent.

<!-- file: instances/host.yaml variants: A B C -->
```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: <LLM_PROVIDER>
    name: <LLM_MODEL>
  workflowControl:
    scopes:
      - workflow:list
      - workflow:read
      - workflow:trigger
      - workflow:approval:resolve
      - workflow:approval:decide
```

## NetworkPolicy enforcement flag (WRC)

Keep the base values `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=required` and
`CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED=false`. In that state WRC refuses
recipes that need external egress. Never set `warn`: it logs a warning and
deploys anyway. Add `patches/wrc-network-policy.yaml` to `patches:` only when the
guide's step 5.14 conditions hold.

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
  (a Secret value in a kustomize patch is wiped by the next apply)
- `WEBHOOK_PUBLIC_BASE_URL` (no code reads it)
- `CLERUM_DEV_MODE`, or `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=warn`
- Gateway API CRDs, or any object labelled `doks.digitalocean.com/managed: "true"`
  (DigitalOcean manages and reconciles them)
- IP addresses, cluster IDs, or tunnel UUIDs from another cluster
