# McpServer CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Short name:** `mcp`
**Watched by:** host-context-controller (Context Mapper)

## Purpose

McpServer defines an MCP (Model Context Protocol) server that provides tools to
the LLM. The context-mapper watches these CRDs, manages runtime resources for
HCC-owned servers, and exposes discovery/status for WRC-owned servers.

## Spec Fields

### Core

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `spec.contextRef` | string | yes | -- | Reference to the Context this server belongs to. |
| `spec.description` | string | no | -- | Human-readable description of what this MCP server does. |
| `spec.image` | string | yes | -- | Docker image for the MCP server container (e.g. `mongodb/mongodb-mcp-server:latest`). |
| `spec.imagePullPolicy` | string | no | `Always` | Image pull policy. One of: `Always`, `IfNotPresent`, `Never`. |
| `spec.command` | string[] | no | -- | Override the container entrypoint (Docker ENTRYPOINT). |
| `spec.args` | string[] | no | -- | Arguments passed to the container entrypoint (Docker CMD). |
| `spec.enabled` | boolean | no | `true` | Whether this MCP server is enabled. Disabled servers have their deployments removed. |
| `spec.managed` | boolean | no | `true` | Runtime ownership. `true` or omitted means HCC owns the runtime resources. `false` means WRC owns the runtime; HCC only exposes discovery/status and must not create or delete the WRC-owned runtime. |

### Transport

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `spec.transport` | object | yes | -- | Transport configuration for connecting to the MCP server. |
| `spec.transport.type` | string | yes | -- | Transport type. One of: `sse` (Server-Sent Events), `streamableHttp` (HTTP streaming), `stdio` (stdin/stdout, requires stdio-bridge sidecar). |
| `spec.transport.url` | string | no | -- | Client-facing URL endpoint. Required for `sse` and `streamableHttp`. Auto-generated for `stdio` (stdio-bridge sidecar provides the HTTP endpoint). |
| `spec.transport.port` | integer | no | `3000` | Port the MCP server listens on (used for container port and Service). |

### Authentication

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.auth` | object | no | Authentication configuration for the mcp-host connecting to this server. |
| `spec.auth.type` | string | no | Authentication type. One of: `none`, `bearer`, `basic`, `apiKey`. |
| `spec.auth.secretRef` | string | no | Name of the Kubernetes Secret containing auth credentials. |
| `spec.auth.secretKey` | string | no | Key within the secret to use (default depends on auth type). |

### Server Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `spec.serverConfig` | object | no | -- | Operational configuration for the MCP server runtime. |
| `spec.serverConfig.readOnly` | boolean | no | `true` | Whether the MCP server operates in read-only mode. |
| `spec.serverConfig.loggers` | string | no | `"stderr"` | Comma-separated list of logger outputs (e.g. `stderr`, `disk`, `mcp`). |
| `spec.serverConfig.telemetry` | string | no | `"disabled"` | Whether telemetry collection is enabled. One of: `enabled`, `disabled`. |

### Environment Variables

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.env` | object[] | no | Additional environment variables for the container. |
| `spec.env[].name` | string | yes | Environment variable name. |
| `spec.env[].value` | string | yes | Environment variable value. |
| `spec.envSecret` | object | no | Secret-backed environment variables. The context-mapper validates that the secret and all referenced keys exist before creating the deployment. |
| `spec.envSecret.name` | string | yes* | Name of the Kubernetes Secret in the same namespace. (*Required when `envSecret` is set.) |
| `spec.envSecret.keys` | object[] | yes* | Mapping of secret keys to environment variable names. |
| `spec.envSecret.keys[].secretKey` | string | yes | Key within the Kubernetes Secret. |
| `spec.envSecret.keys[].envVar` | string | yes | Environment variable name to expose the secret value as. |

### Environment Variable Mapping

`spec.envMapping` maps CRD fields to image-specific environment variable names. The context-mapper
reads structured CRD fields and sets the named env vars automatically.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.envMapping.transport` | string | no | Env var for transport mode (value derived: `sse`/`streamableHttp` maps to `"http"`). |
| `spec.envMapping.httpHost` | string | no | Env var for HTTP bind host (value: always `"0.0.0.0"`). |
| `spec.envMapping.httpPort` | string | no | Env var for HTTP port (value from `spec.transport.port`). |
| `spec.envMapping.healthCheckHost` | string | no | Env var for health check bind host (value: always `"0.0.0.0"`). |
| `spec.envMapping.healthCheckPort` | string | no | Env var for health check port (value from `spec.healthCheck.port`). |
| `spec.envMapping.readOnly` | string | no | Env var for read-only mode (value from `spec.serverConfig.readOnly`). |
| `spec.envMapping.loggers` | string | no | Env var for loggers (value from `spec.serverConfig.loggers`). |
| `spec.envMapping.telemetry` | string | no | Env var for telemetry (value from `spec.serverConfig.telemetry`). |

### Health Check

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `spec.healthCheck` | object | no | -- | Health check endpoint configuration for Kubernetes probes. |
| `spec.healthCheck.port` | integer | no | `3001` | Port for the health check endpoint (separate from the main transport port). |

### Resources

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.resources` | object | no | Resource requests and limits for the container. |
| `spec.resources.requests.memory` | string | no | Memory request (e.g. `"64Mi"`). |
| `spec.resources.requests.cpu` | string | no | CPU request (e.g. `"50m"`). |
| `spec.resources.limits.memory` | string | no | Memory limit. |
| `spec.resources.limits.cpu` | string | no | CPU limit. |

### Egress Bindings

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.egressBindings` | object[] | no | External egress bindings allowing this MCP server to reach external APIs. Each binding generates a NetworkPolicy allowing egress to the specified destination. |
| `spec.egressBindings[].egressClass` | string | no | Egress class. `exact-host` is the default for `dns`/`cidr` bindings. `public-web` is explicit public TCP 80/443 egress with private, metadata, cluster-internal, link-local, multicast, and reserved ranges blocked. |
| `spec.egressBindings[].dns` | string | no | DNS hostname to resolve (e.g. `api.openai.com`). Mutually exclusive with `cidr`. |
| `spec.egressBindings[].cidr` | string | no | IP CIDR range (e.g. `10.0.0.1/32`). Mutually exclusive with `dns`. Must not be `0.0.0.0/0`. |
| `spec.egressBindings[].port` | integer | yes | Destination port number. |
| `spec.egressBindings[].protocol` | string | no | Network protocol for exact-host bindings. One of: `TCP`, `UDP`. If omitted, the controller treats exact-host as `TCP`; public-web must omit this field. |

Validation rules enforce that exactly one of `dns` or `cidr` must be set per binding, and
open CIDR `0.0.0.0/0` is rejected.

`public-web` bindings must not declare `dns`, `cidr`, `port`, or `protocol`.
They are intended for operator-approved MCP servers that need dynamic public web
access and cannot be represented by a stable exact-host list. Registry
`egressSummary.wideCidr: true` is a temporary compatibility signal that Control
API translates to this explicit `egressClass: public-web` CRD shape.

## Status

| Field | Type | Description |
|-------|------|-------------|
| `status.resolvedEgressIPs` | object[] | Resolved IPs for DNS-based egress bindings (for auditability). |
| `status.resolvedEgressIPs[].dns` | string | The DNS hostname that was resolved. |
| `status.resolvedEgressIPs[].ips` | string[] | Resolved IP addresses. |
| `status.resolvedEgressIPs[].resolvedAt` | date-time | When the resolution occurred. |

## Additional Printer Columns

`kubectl get mcpservers` displays: Context, Image, Transport, URL, Enabled, Managed.

## CRD Validation Rules

- WRC-owned servers (`managed: false`) still require `transport` and `contextRef`.
- For `managed: false`, WRC owns runtime isolation, including runtime NetworkPolicies; HCC exposes discovery/status and does not create or delete WRC-owned runtime policies.
- `spec.managed` is immutable after creation; omit is treated as the default `true`.
- Each egress binding must have exactly one of `dns` or `cidr` (not both, not neither).
- Open CIDR range `0.0.0.0/0` is not allowed in egress bindings.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: github-server
spec:
  contextRef: context1
  description: Provides GitHub repository management tools
  image: mcp/github:latest
  transport:
    type: sse
    url: http://github-server.mcp-server.svc.cluster.local:3000/sse
    port: 3000
  env:
    - name: MCP_TRANSPORT
      value: "sse"
    - name: MCP_HOST
      value: "0.0.0.0"
    - name: MCP_PORT
      value: "3000"
  envSecret:
    name: github-mcp-credentials
    keys:
      - secretKey: github-token
        envVar: GITHUB_TOKEN
  healthCheck:
    port: 3001
  auth:
    type: bearer
    secretRef: github-mcp-credentials
    secretKey: github-token
  resources:
    requests:
      memory: "64Mi"
      cpu: "50m"
    limits:
      memory: "128Mi"
      cpu: "200m"
  enabled: true
```

## Related

- [Context CRD](context.md) -- referenced via `spec.contextRef`
- [Host CRD](host.md) -- indirectly connected through Context
- [CRD Index](README.md)
- Examples: [github](../../charts/clerum-crds/examples/mcpserver-github.yaml), [postgres](../../charts/clerum-crds/examples/mcpserver-postgres.yaml), [filesystem](../../charts/clerum-crds/examples/mcpserver-filesystem.yaml)
