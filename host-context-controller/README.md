# Host Context Controller

The Host Context Controller is a Kubernetes operator and REST API service that sits at the heart of the Clerum platform. It performs these key roles:

1. **McpServer Operator** — Watches `McpServer` CRDs and automatically manages Deployments and Services for each MCP server, including secret validation.
2. **Host Operator** — Watches `Host` CRDs and automatically manages one Deployment, one Service, and one PVC per host, including secret validation.
3. **NetworkPolicy Operator** — Watches `Context` and `McpServer` CRDs and generates a four-layer NetworkPolicy model (deny-all, infrastructure, context-allow, external-egress) plus recipe binding policies.
4. **REST API** — Exposes a curated API that `mcp-host` uses to discover available MCP servers, their status, and auth tokens.

It also reconciles `GlobalFileSystem` (`src/gfsReconciler.ts`) and `SharedFileSystem` (`src/sharedFileSystemReconciler.ts`) CRDs.

## Architecture

```
                                         ┌─────────────────────┐
                                         │   McpServer CRDs    │
                                         └──────────┬──────────┘
                                                    │ watch
                                                    ▼
┌─────────────────┐     REST API      ┌───────────────────────────┐     manages      ┌─────────────────────┐
│    mcp-host     │ ───────────────▶  │  host-context-controller  │ ──────────────▶  │  Deployments        │
│  (mcp-host ns)  │                   │    (control-plane ns)     │                  │  Services           │
└─────────────────┘                   └───────────────────────────┘                  │  NetworkPolicies    │
                                                    │                                └─────────────────────┘
                                           watch    │      reads
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                             ┌─────────────┐  ┌───────────┐  ┌─────────────┐
                             │ Context CRDs│  │  Secrets  │  │ MCP Server  │
                             └─────────────┘  └───────────┘  │    Pods     │
                                                             └─────────────┘
```

## McpServer Operator

When an `McpServer` CRD is created, modified, or deleted, the host-context-controller reconciler:

- **ADDED** — Validates that referenced secrets exist, then creates a Deployment and Service for the MCP server.
- **MODIFIED** — Updates the Deployment and Service to match the CRD spec (env vars, image, ports, resources, etc.).
- **DELETED** — Removes the Deployment and Service.

Remote egress-proxy McpServers keep the author's `spec.image` as desired-state input; HCC no longer rewrites it to the platform proxy image. The former `canonicalizeRemoteEgressProxyImage` step and its `ImageCanonicalized` status condition were removed (PR #205 readiness-safety cleanup): canonicalization mutated the observed CRD cache object and bumped the resource generation, retiring the in-flight reconcile before it could create the runtime resources. The platform-owned proxy image is instead selected at Deployment build time (`buildDeployment`), leaving the CRD spec untouched.

The reconciler builds Deployments with labels used for pod selection and network policy targeting:

| Label                  | Value                     | Purpose                           |
| ---------------------- | ------------------------- | --------------------------------- |
| `app`                  | `<server-name>`           | Standard app selector             |
| `clerum.io/managed-by` | `host-context-controller` | Identifies operator-managed pods  |
| `clerum.io/mcpserver`  | `<server-name>`           | Targets a specific MCP server pod |

### Secret Validation

Before deploying an MCP server, the reconciler checks that:

1. The secret referenced by `spec.envSecret.name` exists in the namespace.
2. All keys listed in `spec.envSecret.keys[].secretKey` are present in the secret data.

If the secret is missing or incomplete, the MCP server will **not** be deployed. Creating the secrets an `McpServer` references is not the host-context-controller's responsibility — for those it only validates their existence. (It does create its own Secrets elsewhere, e.g. the per-Host runtime-token Secret in `mcp-host`.)

## NetworkPolicy Operator

The host-context-controller enforces **deny-by-default** network isolation across all runtime namespaces and generates allow policies from `Context` and `McpServer` CRDs. The model has four layers, implemented in `src/networkPolicyReconciler.ts`, plus recipe-scoped binding policies in `src/bindingPolicyReconciler.ts`.

### L0 — Default deny

One `deny-all-<namespace>` policy per runtime namespace, configurable via `CONTEXT_MAPPER_RUNTIME_NAMESPACES` (the shipped deployment sets `mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui`; the code default is `mcp-server,mcp-host,sandbox-recipes,rpc-proxy`). Empty pod selector with `policyTypes: [Ingress, Egress]` — all traffic in both directions is blocked unless a higher layer allows it.

Note: as deployed, `mcp-host` is **not** in that list — its deny-all, DNS and K8s-API policies are static manifests (`deploy/base/mcp-host/networkpolicies.yaml`), not controller-managed.

### L1 — Infrastructure

Baseline plumbing, created once per runtime namespace:

| Policy                      | Allows                                                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-dns-egress-<ns>`     | DNS (UDP+TCP 53) to `kube-system`; optional extra ipBlock rule for GKE NodeLocal DNSCache via `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`                                                                                                                                                                                                                 |
| `allow-hcc-api-egress-<ns>` | Egress to the `host-context-controller-api-gateway` pod in the control-plane namespace, scoped per namespace to the pod classes that need discovery (managed mcp-host pods, `mcp-proxy`, `rpc-proxy`, workflow MCP hosts)                                                                                                                         |
| `allow-k8s-api-egress-<ns>` | Egress to the Kubernetes API server (TCP 443; CIDRs from `CONTEXT_MAPPER_K8S_API_CIDRS`, falling back to `KUBERNETES_SERVICE_HOST`, then to a hardcoded `10.96.0.1/32` when that is unset). **Deny by default** outside `mcp-host`: pods in other runtime namespaces must opt in with the platform-owned label `clerum.io/k8s-api-egress: "true"` |

Namespaces listed in `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES` get only deny-all + DNS egress (no HCC-API or K8s-API egress).

`ensureDefaultPolicies` additionally creates one non-suffixed `allow-host-context-controller-api` policy — not per namespace, but a single policy in `CONTEXT_MAPPER_NAMESPACE` (`mcp-server`). It permits ingress from the `mcp-host` namespace on `CONTEXT_MAPPER_PORT` to pods matching `app: host-context-controller`. As shipped, the controller Deployment runs in `control-plane`, so this policy matches no pod in `mcp-server` and has no effect; the mcp-host → controller route is actually opened by the `allow-hcc-api-egress-<ns>` egress policies above.

### L2 — Context allow

For each MCP server in a `Context` CRD's `spec.mcpServers`, three paired policies open a single route on the server's transport port:

- `ctx-<contextId>-<serverName>` (ingress, MCP server namespace) — the server pod accepts traffic only from mcp-host pods **labeled with that context** (`clerum.io/context`), from `rpc-proxy` pods, and from `mcp-proxy`.
- `ctx-<contextId>-<serverName>-egress` (egress, `mcp-host` namespace) — the context-labeled mcp-host pods may reach that server (required because L0 also denies egress).
- `rpc-egress-<contextId>-<serverName>` (egress, `rpc-proxy` namespace) — rpc-proxy pods may reach that server.

Servers removed from a Context lose their policies on the next reconcile; deleting a Context removes all three families.

### L3 — External egress

`McpServer.spec.egressBindings` produce `ext-egress-*` policies in the server's namespace (`reconcileExternalEgress` in `src/networkPolicyReconciler.ts`):

- **`exact-host`** (default) — a CIDR binding, or a public DNS hostname resolved to `/32` ipBlocks, on one declared port/protocol. CIDRs and resolved IPs are rejected if they overlap `PUBLIC_EGRESS_EXCEPT_CIDRS` (RFC1918, CGNAT, loopback, link-local incl. cloud metadata, documentation, benchmarking, multicast, reserved ranges). Hostnames like `localhost`, `metadata.goog`, `*.internal`, `*.svc`, `*.cluster.local` are rejected outright.
- **`public-web`** — `0.0.0.0/0` on TCP 80/443 with `PUBLIC_EGRESS_EXCEPT_CIDRS` carved out via `except`.

Results are written to the McpServer's `status.conditions` (`ExternalEgressReady`) and `status.resolvedEgressIPs`. A failed binding blocks runtime reconciliation of that server, so a workload cannot start before its egress converges. DNS-derived allows are never retained across a failed refresh: HCC revokes the unprovable policy before certifying global readiness, while only the affected runtime remains blocked until DNS recovers. Each lookup has a bounded deadline.

HCC readiness certifies authoritative inventory and revocation safety, not
completion of positive policy creation. A renamed or newly requested allow may
therefore remain unavailable after HCC becomes Ready until its additive
reconciliation succeeds. HCC never keeps an obsolete allow merely to avoid
that availability gap: when old and new ownership cannot be proven equivalent,
revocation wins and only the affected runtime remains fail-closed.

During an in-place release, HCC is also the controller that stamps
`CONTEXT_MAPPER_HOST_IMAGE` onto managed mcp-host workloads. The new HCC
producer is consequently running before it replaces those consumers with the
new mcp-host image. For compatibility, an omitted `status.authoritative` field
retains the legacy fail-closed meaning; only an explicit `authoritative: false`
asks a new mcp-host to preserve an unchanged live connection.

### Recipe binding policies

McpServers carrying a `clerum.io/recipe-bindings` annotation (set for WorkflowRecipe bindings) get paired `bind-<recipe>-<from>-<to>-{egress,ingress}` policies connecting the MCP workload in the MCP server namespace with its counterpart in `sandbox-recipes` on the declared port/protocol (`src/bindingPolicyReconciler.ts`). Deleting the McpServer removes the recipe's binding policies.

### Reconciliation Lifecycle

- **Startup safety** — Ensures L0/L1 defaults, revokes stale or orphaned context-allow, rpc-proxy-egress, and external-egress policies from authoritative Context/McpServer inventories, then certifies readiness safety.
- **Startup additive convergence** — Reconciles Context allows after certification. The dedicated external-egress coordinator is the sole owner of McpServer egress creation, per-server startup gating, retry, and periodic DNS refresh; a failed binding blocks only that server's runtime.
- **Context ADDED/MODIFIED/DELETED** — Creates, updates, or removes the L2 policy set for that context.
- **McpServer ADDED/MODIFIED/DELETED** — Reconciles L3 external egress (before the workload Deployment is created) and recipe binding policies.

### Cross-Namespace Targeting

Policies select peers with the built-in `kubernetes.io/metadata.name` namespace label combined with pod label selectors, e.g. the L2 ingress rule:

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: mcp-host
        podSelector:
          matchLabels:
            clerum.io/managed-by: host-context-controller
            clerum.io/context: context1
    ports:
      - port: 3000
        protocol: TCP
```

## Host Operator

When a `Host` CRD is created, modified, or deleted in the host namespace, the host-context-controller host reconciler:

- **ADDED** — Validates that `spec.secretRef` exists, then creates/updates, in the host namespace (`mcp-host`):
  - `Deployment/<host-name>`
  - `Service/<host-name>`
  - `PersistentVolumeClaim/<host-name>-workspace`
  - `Secret/host-<host-name>-mcp-host-runtime-tokens` (runtime credentials, rotated by the reconciler)
  - `ServiceAccount/`, `Role/` and `RoleBinding/` scoping the pod to its own Host CRD and Secrets
  - `NetworkPolicy/allow-rpc-proxy-desktop-<host-name>` for desktop hosts

  It also reconciles, in the channels namespace (`CONTEXT_MAPPER_CHANNELS_NAMESPACE`, default `channels`), a per-Host `Service/channel-reader-<host-name>`, `Deployment/channel-reader-<host-name>` and `NetworkPolicy/channel-reader-<host-name>-egress`.

- **MODIFIED** — Reconciles the same resources to match current runtime defaults and host identity.
- **DELETED** — Deletes the resources listed above, in both namespaces.

Generated resources are labeled for orphan cleanup:

| Label                  | Value                     | Purpose                                            |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `clerum.io/managed-by` | `host-context-controller` | Identifies operator-managed host runtime resources |
| `clerum.io/host`       | `<host-name>`             | Tracks ownership to a specific Host CRD            |

On startup, a full host reconciliation pass runs and deletes orphaned host runtime resources whose Host CRD no longer exists — including orphaned channel-reader resources in `channels` and orphaned per-Host NetworkPolicies (`sweepOrphanChannelReaderResources`, `sweepOrphanHostNetworkPolicies`).

## REST API

The Host-facing MCP contract is authenticated and Host-scoped. HCC verifies the
runtime bearer, resolves the live Host and its live Context server-side, and
checks the Context grant before it reads credential material. Callers do not
supply a Context reference.

### Health Check

```
GET /health
```

```json
{ "status": "ok", "ready": true }
```

The server also exposes `GET /` (API information), `GET /ready` (readiness; 503 until the controller has started), `GET /metrics` (Prometheus), and `GET /api/v1/desktop/:hostRef` (desktop status; requires the `CONTEXT_MAPPER_DESKTOP_API_TOKEN` bearer token — the check is skipped when that variable is empty).

### Temporary system inventory (PR 2 compatibility)

```
GET /api/v1/mcpservers
```

```json
{
  "servers": [
    {
      "name": "mongodb-server",
      "contextRef": "context1",
      "transport": {
        "type": "sse",
        "url": "http://mongodb-server.mcp-server.svc.cluster.local:3000/sse"
      },
      "enabled": true,
      "status": { "deployed": true, "ready": true }
    }
  ],
  "contextRef": "*",
  "timestamp": "2026-02-14T15:11:12.000Z"
}
```

This anonymous, metadata-only route is retained temporarily for the existing
`mcp-proxy` poller. It is not the mcp-host discovery contract and exposes no
auth selector or Secret metadata. Its removal or authentication belongs to the
separate PR 2 migration.

### Authenticated Host inventory

```
GET /api/v2/hosts/self/mcpservers
Authorization: Bearer <mcp-host-runtime-token>
```

The response contains only enabled McpServers granted by the authenticated
Host's live Context. It omits `contextRef`, auth selectors, and Secret metadata.
An authenticated server includes an opaque `credentialRevision` so mcp-host can
retire a credential before admitting a changed revision.

The verifier accepts only RS256 tokens from the configured Control API issuer
with an exact HCC audience set (HCC-only, or the bounded HCC + workflow
migration pair), one `hostRefs` entry, the matching `host_uid`, and the single
`mcp:credential:read` capability. The historical workflow scope/standalone
recipe claims identify the reused runtime-token family; they do not grant a
Context. HCC derives that authorization from the live Host and Context objects.

```json
{
  "servers": [
    {
      "name": "mongodb-server",
      "transport": {
        "type": "sse",
        "url": "http://mongodb-server.mcp-server.svc.cluster.local:3000/sse"
      },
      "enabled": true,
      "status": { "deployed": true, "ready": true },
      "authRequired": true,
      "credentialRevision": "opaque-revision"
    }
  ],
  "timestamp": "2026-02-14T15:11:12.000Z"
}
```

### Authenticated Host credential

```
POST /api/v2/hosts/self/mcpservers/credential
Authorization: Bearer <mcp-host-runtime-token>
Content-Type: application/json

{ "serverName": "mongodb-server" }
```

Response (with auth):

```json
{ "token": "credential-value", "credentialRevision": "opaque-revision" }
```

Response (no auth configured):

```json
{ "token": null, "credentialRevision": "opaque-revision" }
```

HCC returns the same opaque `404 {"error":"not_found"}` for an ungranted,
missing, disabled, or cross-Context server name. It performs the grant check
before any Secret value read and revalidates the live authority snapshot after
the read. Protected responses are non-cacheable.

The legacy caller-selected routes
`GET /api/v1/mcpservers/context/:contextRef` and
`GET /api/v1/mcpservers/:name/auth` are tombstoned with a generic HTTP 410 at
both the gateway and HCC application layers; there is no v1 fallback.

## Environment Variables

HCC reads environment variables from `src/config.ts`, `src/gfsConfig.ts`,
`src/logger.ts`, and `src/k8sApiCidrs.ts`. Defaults below are the literal fallbacks
in code; where the deploy manifest overrides one, that is noted.

**Parsing semantics.** `getEnv(key, default)` uses `process.env[key] ?? default`,
so an **empty string wins over the default** — that is how the minikube overlay
disables the image-pull secret with `value: ""`. `getEnvInt` / `getEnvBool` treat
an empty string as unset and fall back to the default; `getEnvBool` accepts
`true` (any case) or `1`.

**Three variables fail the process closed on bad input** rather than programming
a permissive policy — see the NetworkPolicy and GFS tables:
`CONTEXT_MAPPER_K8S_API_CIDRS`, `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`, and
`CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY`.

### Core / server

| Variable              | Default | Description                                                                                                                                          |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_PORT` | `8081`  | HTTP server port.                                                                                                                                    |
| `CLERUM_DEV_MODE`     | `false` | Read McpServers/Contexts/auth tokens from env instead of the K8s API. Also skips the `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` startup assertion below. |
| `LOG_LEVEL`           | `info`  | `debug` \| `info` \| `warn` \| `error`. Unrecognized values fall back to `info`.                                                                     |

### Namespaces

| Variable                                 | Default           | Description                                                                                                                                                                |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_NAMESPACE`               | `mcp-server`      | Where `McpServer` / `Context` CRDs live and managed server workloads are created.                                                                                          |
| `CONTEXT_MAPPER_CONTROL_PLANE_NAMESPACE` | `control-plane`   | Where control-plane gateway services live.                                                                                                                                 |
| `CONTEXT_MAPPER_HOST_NAMESPACE`          | `mcp-host`        | Where mcp-host pods run (drives NetworkPolicy generation).                                                                                                                 |
| `CONTEXT_MAPPER_GFS_NAMESPACE`           | `gfs`             | Where the GlobalFileSystem controller (gfsc) runs.                                                                                                                         |
| `CONTEXT_MAPPER_RPC_PROXY_NAMESPACE`     | `rpc-proxy`       | Where rpc-proxy runs (L2 egress policy generation).                                                                                                                        |
| `CONTEXT_MAPPER_CHANNELS_NAMESPACE`      | `channels`        | Per-Host channel-reader Deployments/Services.                                                                                                                              |
| `CONTEXT_MAPPER_SANDBOX_NAMESPACE`       | `sandbox-recipes` | Workflow-recipe namespace. Read only by the GFS factory.                                                                                                                   |
| `HCC_TARGET_NAMESPACE`                   | `mcp-host`        | Namespace HCC names when asking control-api for caller-bound 1st-party mcp-host credentials. It must exactly equal `CONTEXT_MAPPER_HOST_NAMESPACE`; HCC exits 1 otherwise. |

### MCP server provisioning

| Variable                                     | Default                             | Description                                                                                                          |
| -------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_MCPSERVER_IMAGE_PULL_POLICY` | `IfNotPresent`                      | Pull policy for reconciled McpServer workloads.                                                                      |
| `CONTEXT_MAPPER_EGRESS_PROXY_IMAGE`          | `clerum/nginx-egress-proxy:0.1.0`   | Per-server nginx egress proxy for **remote** MCP servers (`spec.remote`).                                            |
| `CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE`          | (registry-qualified `stdio-bridge`) | stdio-bridge sidecar image for managed stdio MCP servers. Manifest pins `clerum/stdio-bridge:0.9.5`.                 |
| `CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_MEMORY` | `32Mi`                              | stdio-bridge sidecar memory request.                                                                                 |
| `CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_CPU`    | `50m`                               | stdio-bridge sidecar CPU request.                                                                                    |
| `CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_MEMORY`   | `128Mi`                             | stdio-bridge sidecar memory limit.                                                                                   |
| `CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_CPU`      | `200m`                              | stdio-bridge sidecar CPU limit.                                                                                      |
| `HCC_EXTERNAL_EGRESS_RESYNC_SEC`             | `300`                               | Periodic external-egress DNS resync interval (seconds). `0` disables periodic refresh; watch events still reconcile. |
| `HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS`         | `5000`                              | Per-hostname DNS lookup deadline in milliseconds.                                                                    |

### mcp-host provisioning

| Variable                                            | Default                         | Description                                                                                                                    |
| --------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CONTEXT_MAPPER_HOST_IMAGE`                         | (registry-qualified `mcp-host`) | Image for reconciled Host Deployments. Manifest pins `clerum/mcp-host:0.9.5`.                                                  |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY`             | `Always`                        | Pull policy. Minikube overlay sets `IfNotPresent`.                                                                             |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET`             | `clerum`                        | `imagePullSecrets` name. Minikube overlay sets `""` to disable (empty string overrides the default).                           |
| `CONTEXT_MAPPER_HOST_PORT`                          | `8080`                          | Container/service port for the host runtime.                                                                                   |
| `CONTEXT_MAPPER_HOST_CONFIGMAP_NAME`                | `mcp-host-config`               | ConfigMap loaded into host containers via `envFrom`.                                                                           |
| `CONTEXT_MAPPER_HOST_SERVICE_ACCOUNT`               | `mcp-host`                      | ServiceAccount used by Host Deployments.                                                                                       |
| `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS`       | `do-block-storage-retain`       | StorageClass for per-host workspace PVCs. Minikube overlay sets `standard`.                                                    |
| `CONTEXT_MAPPER_HOST_WORKSPACE_SIZE`                | `10Gi`                          | Requested per-host workspace PVC size.                                                                                         |
| `CONTEXT_MAPPER_HOST_WORKSPACE_PATH`                | `/workspace`                    | Workspace mount path inside host containers.                                                                                   |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_MEMORY`      | `128Mi`                         | Host container memory request.                                                                                                 |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_CPU`         | `100m`                          | Host container CPU request.                                                                                                    |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY`        | `512Mi`                         | Host container memory limit.                                                                                                   |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_CPU`           | `500m`                          | Host container CPU limit.                                                                                                      |
| `CONTEXT_MAPPER_HOST_RESYNC_SEC`                    | `300`                           | Periodic Host `fullReconcile` (seconds); guards against dropped watch events and drives auth-degraded self-heal. `0` disables. |
| `HCC_MCP_HOST_RUNTIME_BOOTSTRAP_REFRESH_BEFORE_SEC` | `900`                           | How long before expiry HCC refreshes the mcp-host bootstrap credential Secret.                                                 |

### mcp-host API authorization

| Variable                                 | Default       | Description                                                                                                                                |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HCC_MCP_HOST_JWT_PUBLIC_KEY`            | `` (empty)    | RS256 public key used to verify protected v2 Host MCP requests. HCC fails startup when it is absent, malformed, private, or a placeholder. |
| `HCC_MCP_HOST_JWT_ISSUER`                | `control-api` | Exact issuer accepted for protected v2 Host MCP requests.                                                                                  |
| `HCC_MCP_HOST_JWT_MAX_TTL_SECONDS`       | `600`         | Maximum accepted `exp - iat`; the deploy manifest sources this from Control API's access-token TTL contract.                               |
| `HCC_MCP_HOST_API_RATE_LIMIT_PER_MINUTE` | `120`         | Per verified Host UID and action fixed-window limit for inventory and credential requests.                                                 |

### Desktop (Host CRD `spec.desktop`)

| Variable                                          | Default                          | Description                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_DESKTOP_IMAGE`                    | `clerum/mcp-host-desktop:latest` | Desktop sidecar image.                                                                                                                                                                   |
| `CONTEXT_MAPPER_DESKTOP_PORT`                     | `3000`                           | Desktop container port.                                                                                                                                                                  |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_MEMORY` | `256Mi`                          | Desktop memory request.                                                                                                                                                                  |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_CPU`    | `250m`                           | Desktop CPU request.                                                                                                                                                                     |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_MEMORY`   | `4Gi`                            | Desktop memory limit.                                                                                                                                                                    |
| `CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_CPU`      | `1000m`                          | Desktop CPU limit.                                                                                                                                                                       |
| `CONTEXT_MAPPER_DESKTOP_API_TOKEN`                | `` (empty)                       | Bearer token required by `GET /api/v1/desktop/:hostRef`. **When empty the check is skipped and the endpoint is unauthenticated** — a dev-mode convenience. Set it in any shared cluster. |

### channel-reader provisioning

| Variable                                          | Default                       | Description                                                                     |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_CHANNEL_READER_IMAGE`             | `clerum/channel-reader:0.9.5` | Image for per-Host channel-reader Deployments.                                  |
| `CONTEXT_MAPPER_CHANNEL_READER_IMAGE_PULL_POLICY` | `Always`                      | Pull policy. Minikube overlay sets `IfNotPresent` to use locally-loaded images. |
| `CONTEXT_MAPPER_CHANNEL_READER_HANDOFF_PORT`      | `8099`                        | Internal handoff port on per-Host channel-reader Services.                      |

### workspace-files-controller (WFC) provisioning

| Variable                                      | Default                      | Description                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_WFC_IMAGE`                    | (registry-qualified `wfc`)   | Per-SharedFileSystem WFC image. Manifest pins `clerum/workspace-files-controller:0.9.5`.                                                                                                                       |
| `CONTEXT_MAPPER_WFC_IMAGE_PULL_POLICY`        | `IfNotPresent`               | Pull policy for WFC Deployments.                                                                                                                                                                               |
| `CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET`        | `clerum`                     | `imagePullSecrets` name. Minikube overlay sets `""` to disable.                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_PORT`                     | `8086`                       | WFC container/service port.                                                                                                                                                                                    |
| `CONTEXT_MAPPER_WFC_INIT_IMAGE`               | `busybox:1.36`               | Init container that seeds directories and chowns the fresh PVC.                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_MEMORY` | `64Mi`                       | WFC memory request.                                                                                                                                                                                            |
| `CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_CPU`    | `50m`                        | WFC CPU request.                                                                                                                                                                                               |
| `CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_MEMORY`   | `128Mi`                      | WFC memory limit.                                                                                                                                                                                              |
| `CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_CPU`      | `200m`                       | WFC CPU limit.                                                                                                                                                                                                 |
| `CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM`        | `mcp-host-config`            | ConfigMap holding the JWT public key the WFC verifies against.                                                                                                                                                 |
| `CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM_KEY`    | `CLERUM_AUTH_JWT_PUBLIC_KEY` | Key within that ConfigMap.                                                                                                                                                                                     |
| `CONTEXT_MAPPER_WFC_MAX_UPLOAD_BYTES`         | `104857600` (100 MiB)        | Upload size cap forwarded to the WFC container.                                                                                                                                                                |
| `CONTEXT_MAPPER_WFC_MAX_LIST_ENTRIES`         | `5000`                       | Max directory entries the WFC will list.                                                                                                                                                                       |
| `CONTEXT_MAPPER_WFC_MAX_PATH_DEPTH`           | `32`                         | Max path depth the WFC will traverse.                                                                                                                                                                          |
| `CONTEXT_MAPPER_SFS_RESYNC_SEC`               | `60`                         | Periodic SharedFileSystem `fullReconcile` (seconds). The SFS watch fires only on CRD changes — not on PVC binding or WFC readiness — so this is what drives `Initializing`/`Degraded` → `Ready`. `0` disables. |

### GlobalFileSystem (GFS) provisioning

Read by `src/gfsConfig.ts`. Invalid values **throw at startup** rather than silently defaulting.

| Variable                                | Default                      | Description                                                                                                                   |
| --------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_GFSC_PORT`              | `8087`                       | gfsc service port.                                                                                                            |
| `CONTEXT_MAPPER_GFSC_IMAGE`             | `clerum/gfs-controller:test` | gfsc writer Deployment image. **The default is a `:test` tag** — override it.                                                 |
| `CONTEXT_MAPPER_GFSC_IMAGE_PULL_POLICY` | `IfNotPresent`               | Must be exactly `Always` \| `IfNotPresent` \| `Never`; any other non-empty value **throws** at startup.                       |
| `CONTEXT_MAPPER_GFSC_IMAGE_PULL_SECRET` | _(unset)_                    | Optional `imagePullSecrets` name for gfsc.                                                                                    |
| `CONTEXT_MAPPER_GFSC_PRIORITY_CLASS`    | _(unset)_                    | Optional `priorityClassName` for the gfsc Deployment.                                                                         |
| `CONTEXT_MAPPER_GFSC_INIT_IMAGE`        | `busybox:1.36`               | gfsc init-container image.                                                                                                    |
| `CONTEXT_MAPPER_GFSC_REQUEST_MEMORY`    | `128Mi`                      | gfsc memory request.                                                                                                          |
| `CONTEXT_MAPPER_GFSC_REQUEST_CPU`       | `100m`                       | gfsc CPU request.                                                                                                             |
| `CONTEXT_MAPPER_GFSC_LIMIT_MEMORY`      | `256Mi`                      | gfsc memory limit.                                                                                                            |
| `CONTEXT_MAPPER_GFSC_LIMIT_CPU`         | `500m`                       | gfsc CPU limit.                                                                                                               |
| `CONTEXT_MAPPER_GFS_POSTGRES_APP_LABEL` | `control-postgres`           | `app` pod label selecting the Postgres pods gfsc may reach (NetworkPolicy).                                                   |
| `CONTEXT_MAPPER_GFS_POSTGRES_PORT`      | `5432`                       | Postgres port for the gfsc egress policy.                                                                                     |
| `CONTEXT_MAPPER_GFS_JWT_CONFIGMAP`      | `gfs-config`                 | ConfigMap holding the JWT public key gfsc verifies against.                                                                   |
| `CONTEXT_MAPPER_GFS_JWT_CONFIGMAP_KEY`  | `jwt-public-key`             | Key within that ConfigMap.                                                                                                    |
| `CONTEXT_MAPPER_GFS_PG_SECRET`          | `gfs-controller-db`          | Secret holding the gfsc Postgres connection string.                                                                           |
| `CONTEXT_MAPPER_GFS_PG_SECRET_KEY`      | `connection-string`          | Key within that Secret.                                                                                                       |
| `CONTEXT_MAPPER_GFS_DRIVE_NAME`         | `main`                       | Default GFS drive name.                                                                                                       |
| `CONTEXT_MAPPER_GFS_TOKEN_AUDIENCE`     | `gfs-controller`             | Expected `aud` claim on GFS access tokens.                                                                                    |
| `CONTEXT_MAPPER_GFS_RESYNC_SEC`         | `60`                         | Periodic GlobalFileSystem `fullReconcile` (seconds); drives convergence to `Ready` and the root-directory seed. `0` disables. |

### NetworkPolicy

| Variable                                          | Default                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_RUNTIME_NAMESPACES`               | `mcp-server,mcp-host,sandbox-recipes,rpc-proxy` | Namespaces that get L0 deny-all + L1 infrastructure policies. Manifest overrides to `mcp-server,sandbox-recipes,rpc-proxy,sandbox-ui` — note it **drops `mcp-host`**, whose policies are static (`deploy/base/mcp-host/networkpolicies.yaml`), because an HCC deny-all would block mcp-host from reaching LLM APIs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES`         | `` (empty)                                      | Subset of runtime namespaces that get **only** deny-all + DNS egress — no HCC-API or K8s-API egress. Manifest sets `sandbox-ui`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CONTEXT_MAPPER_K8S_API_CIDRS`                    | _(unset → `[]`)_                                | K8s API-server CIDRs for `allow-k8s-api-egress-*`. Empty falls back to `KUBERNETES_SERVICE_HOST`. **Validated fail-closed at module load**: a malformed entry, or one broader than `/24` (IPv4) or `/120` (IPv6), **crashes startup** rather than programming a permissive policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`               | `` (empty)                                      | DNS infrastructure CIDR for NodeLocal DNSCache / kube-dns. Must be exactly one IPv4 `/32`; anything else throws at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `CONTEXT_MAPPER_NETPOL_RESYNC_SEC`                | `0`                                             | Periodic NetworkPolicy coordinated convergence (seconds). Re-enters the single-flight pass with `ensureDefaults: true` so a tick covers orphan sweep (class A) and L0/L1 defaults (class D). A tick while a pass is in flight is **skipped** (`clerum_hcc_netpol_resync_ticks_skipped_total{reason="pass-in-flight"}`) and does not coalesce; event-driven trailing is unchanged. `0` disables the interval (merge default). Startup still converges once; `start()` already applied defaults as a bootstrap barrier. Default `0` logs a `console.warn` on every boot (same pattern as Host/SFS/GFS/LlmHook) — expected; it names the self-heal gap. **Enable is a separate ops decision** (issue #478, not this merge): with the skip guard the chosen value is **`1500`**; without the guard the floor is **`3600`**. `300` is not a valid enable while passes last minutes. Treadmill ⇔ pass duration ≥ period. Enable preconditions live on #478: image deployed, census read, histogram p99/max ≪ T, then infra **dev first**.                                                                      |
| `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP`         | `10`                                            | Absolute orphan-delete cap for a namespace-wide NetworkPolicy sweep. Candidates **strictly above** this count refuse **deletes** and increment `clerum_hcc_netpol_orphan_sweep_capped_total`; the pass **still certifies** (#478: alert and do not delete). Governs every `fullReconcile` (startup, event-driven, timer). Absolute is checked first, so at a fleet ≥ 50 with these defaults the percent rule never binds. One cap over the **sum of all lanes** (not per-lane): a trip leaves those orphans in place until an operator raises the env; the signal is that counter. `0` refuses every orphan delete; a negative or non-canonical value (`2e1`, `10.9`) fails loud at load. Census: `scripts/ops/hcc-netpol-orphan-census.sh` — `live_cap_would_trip` is Deployment env only; `controller_cap_would_trip` applies compiled defaults when unset. Census listed/orphan sets include the controller `repairable` class (managed-by + reserved name, policy-type absent). When the Deployment omits `CONTEXT_MAPPER_RPC_PROXY_NAMESPACE`, the census assumes the compiled `rpc-proxy` default. |
| `CONTEXT_MAPPER_NETPOL_ORPHAN_DELETE_CAP_PERCENT` | `20`                                            | Percent orphan-delete cap against the listed managed fleet. Strict `>`. Inert on a tiny inventory where `percent * listed < 1`. Values above 100 never fire. Same every-`fullReconcile` scope as the absolute cap; only binds when the fleet is small enough that 20% is below the absolute cap of 10. Non-canonical values fail loud at load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `KUBERNETES_SERVICE_HOST`                         | _(injected by Kubernetes)_                      | Not set by the operator — the `/32` fallback source when `CONTEXT_MAPPER_K8S_API_CIDRS` is empty.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Plugin image allowlist

| Variable                                 | Default                     | Description                                                                                                                                         |
| ---------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES`  | see `packages/image-policy` | Comma-separated trusted image prefixes for local-mode `McpServer` images. Manifest sets `ghcr.io/evenfire-ai/,mongodb/,mcr.microsoft.com/,clerum/`. |
| `CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST` | `false`                     | `false` = audit mode (log would-be denials without blocking). `true` = enforce. Manifest sets `"false"`.                                            |

### Control-API integration

| Variable                               | Default                                                         | Description                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTROL_API_BASE_URL`                 | `http://control-api.control-plane.svc.cluster.local:8090`       | Cluster-internal control-api URL. HCC calls it directly to issue mcp-host runtime tokens for the pods it provisions.                                                                                |
| `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` | `` (empty)                                                      | HS256 secret for signing InternalControl JWTs. **Required whenever `CLERUM_DEV_MODE` is not `true`** — the process logs `[HCC] FATAL` and exits 1 if empty or still a `replace-with-…` placeholder. |
| `MCP_HOST_GATEWAY_URL`                 | `http://nginx-workflow-approval-gateway.control-plane.svc:8092` | The nginx allowlist proxy mediating mcp-host → control-api. HCC **injects this into the mcp-host pods it provisions**; it does not call it itself.                                                  |

### Dev mode

Parsed only when `CLERUM_DEV_MODE` is truthy. A JSON parse failure logs an error and yields an empty result rather than crashing.

| Variable             | Default | Description                                                                                                       |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `CLERUM_MCP_SERVERS` | `[]`    | JSON array of McpServer objects.                                                                                  |
| `CLERUM_CONTEXTS`    | `[]`    | JSON array of Context objects used by the development provider. Caller-selected Context discovery is not exposed. |
| `CLERUM_MCP_AUTH`    | `{}`    | JSON object mapping MCP server name → auth token for development-provider fixtures.                               |

## Kubernetes RBAC

The shipped Roles and RoleBindings are the source of truth — see `deploy/base/<namespace>/rbac.yaml`. The controller's ServiceAccount lives in `control-plane` and is bound into `mcp-server`, `mcp-host`, `channels`, `rpc-proxy`, `sandbox-recipes`, `sandbox-ui` and `gfs`. The table below is an overview of the two main namespaces, not a complete Role definition — do not build a Role from it.

In `mcp-server` (`deploy/base/mcp-server/rbac.yaml`):

| API Group           | Resource            | Verbs                             | Purpose                                                      |
| ------------------- | ------------------- | --------------------------------- | ------------------------------------------------------------ |
| `clerum.io`         | `mcpservers`        | get, list, watch, patch           | Watch McpServer CRDs                                         |
| `clerum.io`         | `mcpservers/status` | get, patch                        | Publish readiness / secret-resolution conditions             |
| `clerum.io`         | `contexts`          | get, list, watch                  | Watch Context CRDs for NetworkPolicy reconciliation          |
| `networking.k8s.io` | `networkpolicies`   | get, list, create, update, delete | Manage generated NetworkPolicies                             |
| `apps`              | `deployments`       | get, list, create, update, delete | Manage MCP server Deployments                                |
| _(core)_            | `services`          | get, list, create, update, delete | Manage MCP server Services                                   |
| _(core)_            | `configmaps`        | get, list, create, update, delete | Manage the remote egress proxy nginx config                  |
| _(core)_            | `secrets`           | get, list, watch                  | Read auth tokens, validate `envSecret`, re-enqueue on change |

In `mcp-host` (`deploy/base/mcp-host/rbac.yaml`), the controller additionally manages per-Host identity and SharedFileSystem resources: `hosts` (get, list, watch), `sharedfilesystems` + `sharedfilesystems/status`, `batch/jobs`, `deployments`, `services`, `persistentvolumeclaims`, `networkpolicies`, `serviceaccounts`, `roles`/`rolebindings`, `configmaps` (get, watch, list), `pods` (get, list), and `secrets` with **get, watch, list, create, update, patch, delete** — it creates the per-Host `host-<hostRef>-mcp-host-runtime-tokens` Secret and the per-Host ServiceAccount + Role + RoleBinding on every reconcile.

## Namespaces

| Component               | Namespace       | Purpose                                                              |
| ----------------------- | --------------- | -------------------------------------------------------------------- |
| host-context-controller | `control-plane` | Operator and API service                                             |
| MCP server pods + CRDs  | `mcp-server`    | `McpServer` and `Context` source of truth + managed server workloads |
| mcp-host                | `mcp-host`      | Consumer of the REST API, target of NetworkPolicy `from` rules       |
| channel-reader          | `channels`      | Communication layer                                                  |

## Local Development

### Dev Mode (without Kubernetes)

Run host-context-controller locally without Kubernetes by providing MCP servers via environment variables. In dev mode, no reconciliation occurs (no Deployments, Services, or NetworkPolicies are created).

Startup still requires a real trusted Control API RS256 public key in
`HCC_MCP_HOST_JWT_PUBLIC_KEY`, including in dev mode. Export it from the
approved local public-key source before either command below. `.env.example`
deliberately does not include a placeholder key, and HCC has no insecure
verifier fallback.

```bash
# Install dependencies
npm install

# Load HCC_MCP_HOST_JWT_PUBLIC_KEY from the trusted Control API public-key source.

# Option 1: Use .env file (recommended)
cp .env.example .env
# Edit .env with your servers
make dev

# Option 2: Run with inline example servers (quick test)
make dev-example
```

`make dev` requires a `.env` file — it sources `./.env` and exits with an error if the file is absent. Because the recipe re-sources `.env` after make has exported the environment, any key defined in `.env` overrides a value passed inline on the command line; a variable _not_ present in `.env` is passed through untouched. To provide your own servers, put them in `.env`:

```bash
CLERUM_DEV_MODE=true
CLERUM_MCP_SERVERS='[{"name":"filesystem","spec":{"contextRef":"dev-context","description":"Filesystem operations","image":"mcp/filesystem:latest","transport":{"type":"sse","url":"http://localhost:3001/sse","port":3001},"enabled":true}}]'
CLERUM_CONTEXTS='[{"name":"dev-context","namespace":"dev","spec":{"contextId":"dev-context","description":"Dev context","mcpServers":["filesystem"]}}]'
CLERUM_MCP_AUTH='{"github":"ghp_your_token_here"}'
```

Dev mode retains the metadata-only global v1 inventory for local `mcp-proxy`
compatibility. It does not restore either caller-selected v1 Host route. The
protected v2 contract requires live Kubernetes Host/Context authority and
therefore fails closed when that authority is unavailable.

### Production Mode (with Kubernetes)

Run against the cluster in your current kubeconfig (watches K8s for McpServer and Context CRDs) with `CLERUM_DEV_MODE` unset. Production startup requires both the existing `INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET` signing material and the real Control API public key in `HCC_MCP_HOST_JWT_PUBLIC_KEY`. Load both from their approved sources before starting; missing or invalid verifier material fails startup closed.

```bash
make build
npm start
```

`make dev` also works, but only if a `.env` file exists (see above) — it is the same target, so it aborts when `.env` is absent. Leave `CLERUM_DEV_MODE` out of that `.env` and load both required values through the approved local configuration path to run against a real cluster.

## Deployment

`host-context-controller/Dockerfile` copies `packages/workflow-recipe-capability-policy`, `packages/image-policy` and `host-context-controller/`, so **the build context must be the repo root**, not this directory. Build from the repo root and point `-f` at the Dockerfile:

```bash
# From the repo root
export IMAGE=ghcr.io/<org>/host-context-controller:$(git describe --tags --always)

# Build
docker build -f host-context-controller/Dockerfile -t "$IMAGE" .

# Push
docker push "$IMAGE"

# Multi-platform build + push (ARM host targeting an amd64 cluster)
docker buildx build --platform linux/amd64 -f host-context-controller/Dockerfile -t "$IMAGE" --push .
```

For a local minikube cluster, `scripts/minikube/build-images.sh` builds this image (and the other services) with the correct root context.

> The component Makefile's `docker-build` / `docker-push` / `docker-push-cross` targets pass this directory as the build context, so the `COPY packages/...` layer cannot resolve and the build fails. Use the root-context commands above.

The component Makefile does not deploy. The controller's ServiceAccount, Deployment and Service live in `deploy/base/control-plane/host-context-controller.yaml`; namespaces are in `deploy/base/namespaces.yaml` and RBAC in `deploy/base/<namespace>/rbac.yaml`. All are applied with kustomize from the repo root, e.g. `kubectl apply -k deploy/overlays/minikube`.
