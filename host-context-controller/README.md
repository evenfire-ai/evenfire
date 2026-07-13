# Host Context Controller

The Host Context Controller is a Kubernetes operator and REST API service that sits at the heart of the Clerum platform. It performs three key roles:

1. **McpServer Operator** — Watches `McpServer` CRDs and automatically manages Deployments and Services for each MCP server, including secret validation.
2. **Host Operator** — Watches `Host` CRDs and automatically manages one Deployment, one Service, and one PVC per host, including secret validation.
3. **NetworkPolicy Operator** — Watches `Context` and `McpServer` CRDs and generates a four-layer NetworkPolicy model (deny-all, infrastructure, context-allow, external-egress) plus recipe binding policies.
4. **REST API** — Exposes a curated API that `mcp-host` uses to discover available MCP servers, their status, and auth tokens.

## Architecture

```
                                         ┌─────────────────────┐
                                         │   McpServer CRDs    │
                                         └──────────┬──────────┘
                                                    │ watch
                                                    ▼
┌─────────────────┐     REST API      ┌──────────────────────────┐     manages      ┌─────────────────────┐
│    mcp-host     │ ───────────────▶  │  host-context-controller   │ ──────────────▶  │  Deployments        │
│ (mcp-host)│                   │      (control-plane ns)   │                  │  Services           │
└─────────────────┘                   └──────────────────────────┘                  │  NetworkPolicies    │
                                                    │                               └─────────────────────┘
                                         watch      │      reads
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                             ┌─────────────┐ ┌───────────┐  ┌─────────────┐
                             │ Context CRDs│ │  Secrets   │  │ MCP Server  │
                             └─────────────┘ └───────────┘  │    Pods     │
                                                            └─────────────┘
```

## McpServer Operator

When an `McpServer` CRD is created, modified, or deleted, the host-context-controller reconciler:

- **ADDED** — Validates that referenced secrets exist, then creates a Deployment and Service for the MCP server.
- **MODIFIED** — Updates the Deployment and Service to match the CRD spec (env vars, image, ports, resources, etc.).
- **DELETED** — Removes the Deployment and Service.

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

If the secret is missing or incomplete, the MCP server will **not** be deployed. Creating secrets is not the host-context-controller's responsibility — it only validates their existence.

## NetworkPolicy Operator

The host-context-controller enforces **deny-by-default** network isolation across all runtime namespaces and generates allow policies from `Context` and `McpServer` CRDs. The model has four layers, implemented in `src/networkPolicyReconciler.ts`, plus recipe-scoped binding policies in `src/bindingPolicyReconciler.ts`.

### L0 — Default deny

One `deny-all-<namespace>` policy per runtime namespace (default `mcp-server,mcp-host,sandbox-recipes,rpc-proxy`, configurable via `CONTEXT_MAPPER_RUNTIME_NAMESPACES`). Empty pod selector with `policyTypes: [Ingress, Egress]` — all traffic in both directions is blocked unless a higher layer allows it.

### L1 — Infrastructure

Baseline plumbing per runtime namespace:

| Policy                              | Allows                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-dns-egress-<ns>`             | DNS (UDP+TCP 53) to `kube-system`; optional extra ipBlock rule for GKE NodeLocal DNSCache via `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`                                                                                                                                                                                                                 |
| `allow-hcc-api-egress-<ns>`         | Egress to the `host-context-controller-api-gateway` pod in the control-plane namespace, scoped per namespace to the pod classes that need discovery (managed mcp-host pods, `mcp-proxy`, `rpc-proxy`, workflow MCP hosts)                                                                                                                         |
| `allow-k8s-api-egress-<ns>`         | Egress to the Kubernetes API server (TCP 443; CIDRs from `CONTEXT_MAPPER_K8S_API_CIDRS`, falling back to `KUBERNETES_SERVICE_HOST`, then to a hardcoded `10.96.0.1/32` when that is unset). **Deny by default** outside `mcp-host`: pods in other runtime namespaces must opt in with the platform-owned label `clerum.io/k8s-api-egress: "true"` |
| `allow-host-context-controller-api` | Ingress to the controller's own REST API (`app: host-context-controller`) from the `mcp-host` namespace on the configured port                                                                                                                                                                                                                    |

Namespaces listed in `CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES` get only deny-all + DNS egress (no HCC-API or K8s-API egress).

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

Results are written to the McpServer's `status.conditions` (`ExternalEgressReady`) and `status.resolvedEgressIPs`. A failed binding blocks runtime reconciliation of that server, so a workload cannot start before its egress converges. DNS answers are re-resolved periodically (`HCC_EXTERNAL_EGRESS_RESYNC_SEC`, default 300s).

### Recipe binding policies

McpServers carrying a `clerum.io/recipe-bindings` annotation (set for WorkflowRecipe bindings) get paired `bind-<recipe>-<from>-<to>-{egress,ingress}` policies connecting the MCP workload in the MCP server namespace with its counterpart in `sandbox-recipes` on the declared port/protocol (`src/bindingPolicyReconciler.ts`). Deleting the McpServer removes the recipe's binding policies.

### Reconciliation Lifecycle

- **Startup** — Ensures L0/L1 defaults, reconciles all Contexts and all McpServer egress bindings, then deletes orphaned context-allow policies in the MCP server namespace, plus orphaned rpc-proxy-egress and external-egress policies, whose owning CRD no longer exists (`fullReconcile`).
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

- **ADDED** — Validates that `spec.secretRef` exists, then creates/updates:
  - `Deployment/<host-name>`
  - `Service/<host-name>`
  - `PersistentVolumeClaim/<host-name>-workspace`
- **MODIFIED** — Reconciles the same resources to match current runtime defaults and host identity.
- **DELETED** — Deletes the host Deployment, Service, and per-host PVC.

Generated resources are labeled for orphan cleanup:

| Label                  | Value                     | Purpose                                            |
| ---------------------- | ------------------------- | -------------------------------------------------- |
| `clerum.io/managed-by` | `host-context-controller` | Identifies operator-managed host runtime resources |
| `clerum.io/host`       | `<host-name>`             | Tracks ownership to a specific Host CRD            |

On startup, a full host reconciliation pass runs and deletes orphaned host runtime resources whose Host CRD no longer exists.

## REST API

The host-context-controller returns curated `McpServerInfo` objects that strip deployment-specific fields and include operator-managed status.

### Health Check

```
GET /health
```

```json
{ "status": "ok" }
```

### List All McpServers

```
GET /api/v1/mcpservers
```

```json
{
  "servers": [
    {
      "name": "mongodb-server",
      "description": "MongoDB MCP Server",
      "contextRef": "context1",
      "transport": {
        "type": "sse",
        "url": "http://mongodb-server.mcp-server.svc.cluster.local:3000/sse"
      },
      "auth": {
        "type": "bearer",
        "secretRef": "mcp-mongodb-credentials",
        "secretKey": "auth-token"
      },
      "enabled": true,
      "status": { "deployed": true, "ready": true, "message": "Running" }
    }
  ],
  "contextRef": "*",
  "timestamp": "2026-02-14T15:11:12.000Z"
}
```

### List McpServers by Context

```
GET /api/v1/mcpservers/context/:contextRef
```

Returns only McpServers that are listed in the specified Context CRD's `spec.mcpServers` array and are enabled. If the Context CRD does not exist, returns an empty list.

### Get Auth Token

```
GET /api/v1/mcpservers/:name/auth
```

Response (with auth):

```json
{ "token": "secret-token-value" }
```

Response (no auth configured):

```json
{ "token": null, "message": "No auth configured for this server" }
```

## Environment Variables

| Variable                                       | Default                                             | Description                                                      |
| ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `CLERUM_DEV_MODE`                              | `false`                                             | Enable dev mode (reads from env vars instead of K8s)             |
| `CONTEXT_MAPPER_PORT`                          | `8081`                                              | HTTP server port                                                 |
| `CONTEXT_MAPPER_NAMESPACE`                     | `mcp-server`                                        | Kubernetes namespace where MCP servers and Context CRDs live     |
| `CONTEXT_MAPPER_HOST_NAMESPACE`                | `mcp-host`                                          | Namespace where mcp-host pods run (for NetworkPolicy generation) |
| `CONTEXT_MAPPER_HOST_IMAGE`                    | `your-registry.example.com/evenfire/mcp-host:0.3.0` | Container image for reconciled host Deployments                  |
| `CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY`        | `Always`                                            | Pull policy for reconciled host Deployments                      |
| `CONTEXT_MAPPER_HOST_PORT`                     | `8080`                                              | Container/service port for host runtime                          |
| `CONTEXT_MAPPER_HOST_CONFIGMAP_NAME`           | `mcp-host-config`                                   | ConfigMap loaded into host containers via `envFrom`              |
| `CONTEXT_MAPPER_HOST_SERVICE_ACCOUNT`          | `mcp-host`                                          | Service account used by host Deployments                         |
| `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS`  | `do-block-storage-retain`                           | Storage class for per-host workspace PVCs                        |
| `CONTEXT_MAPPER_HOST_WORKSPACE_SIZE`           | `10Gi`                                              | Requested per-host workspace PVC size                            |
| `CONTEXT_MAPPER_HOST_WORKSPACE_PATH`           | `/workspace`                                        | Workspace mount path inside host containers                      |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_MEMORY` | `128Mi`                                             | Host container memory request                                    |
| `CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_CPU`    | `100m`                                              | Host container CPU request                                       |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY`   | `512Mi`                                             | Host container memory limit                                      |
| `CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_CPU`      | `500m`                                              | Host container CPU limit                                         |
| `CLERUM_MCP_SERVERS`                           | -                                                   | (Dev mode) JSON array of McpServer objects                       |
| `CLERUM_MCP_AUTH`                              | -                                                   | (Dev mode) JSON object mapping server name to auth token         |

## Kubernetes RBAC

The host-context-controller requires permissions in both `mcp-server` and `mcp-host` namespaces:

| API Group           | Resource                 | Verbs                             | Purpose                                                                |
| ------------------- | ------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| `clerum.io`         | `mcpservers`             | get, list, watch                  | Watch McpServer CRDs                                                   |
| `clerum.io`         | `contexts`               | get, list, watch                  | Watch Context CRDs for NetworkPolicy reconciliation                    |
| `clerum.io`         | `hosts`                  | get, list, watch                  | Watch Host CRDs in host namespace                                      |
| `networking.k8s.io` | `networkpolicies`        | get, list, create, update, delete | Manage generated NetworkPolicies                                       |
| `apps`              | `deployments`            | get, list, create, update, delete | Manage MCP server Deployments                                          |
| `apps`              | `deployments`            | get, list, create, update, delete | Manage per-host runtime Deployments                                    |
| _(core)_            | `services`               | get, list, create, update, delete | Manage MCP server and host runtime Services                            |
| _(core)_            | `persistentvolumeclaims` | get, list, create, update, delete | Manage per-host workspace PVCs                                         |
| _(core)_            | `secrets`                | get                               | Read auth tokens and validate secret references (`McpServer` + `Host`) |

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

```bash
# Install dependencies
npm install

# Option 1: Use .env file (recommended)
cp .env.example .env
# Edit .env with your servers
make dev

# Option 2: Run with inline example servers (quick test)
make dev-example

# Or provide your own servers:
CLERUM_DEV_MODE=true \
CLERUM_MCP_SERVERS='[
  {
    "name": "filesystem",
    "spec": {
      "contextRef": "dev-context",
      "description": "Filesystem operations",
      "image": "mcp/filesystem:latest",
      "transport": {"type": "sse", "url": "http://localhost:3001/sse", "port": 3001},
      "enabled": true
    }
  }
]' \
CLERUM_MCP_AUTH='{"github":"ghp_your_token_here"}' \
make dev
```

### Production Mode (with Kubernetes)

```bash
# Run with kubectl access (watches K8s for McpServer and Context CRDs)
make dev
```

## Deployment

```bash
# Build Docker image
make docker-build

# Build and push to registry
make docker-push

# Deploy to Kubernetes (namespace, RBAC, deployment, service)
make deploy

# Undeploy
make undeploy
```
