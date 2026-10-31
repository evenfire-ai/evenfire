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

An McpServer does not belong to a Context. A Context exposes a server by listing
its name in [`Context.spec.mcpServers`](context.md), and several Contexts can list
the same server. Installing a server writes no Context allowlist; enabling it for
an agent is a separate edit of that agent's Context.

## Spec Fields

### Core

| Field                  | Type     | Required | Default  | Description                                                                                                                                                                                           |
| ---------------------- | -------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.description`     | string   | no       | --       | Human-readable description of what this MCP server does.                                                                                                                                              |
| `spec.image`           | string   | yes      | --       | Docker image for the MCP server container (e.g. `mongodb/mongodb-mcp-server:latest`).                                                                                                                 |
| `spec.imagePullPolicy` | string   | no       | _(none)_ | Image pull policy. One of: `Always`, `IfNotPresent`, `Never`. The schema sets no default; if omitted, HCC applies `CONTEXT_MAPPER_MCPSERVER_IMAGE_PULL_POLICY` (default `IfNotPresent`).              |
| `spec.command`         | string[] | no       | --       | Override the container entrypoint (Docker ENTRYPOINT).                                                                                                                                                |
| `spec.args`            | string[] | no       | --       | Arguments passed to the container entrypoint (Docker CMD).                                                                                                                                            |
| `spec.enabled`         | boolean  | no       | `true`   | Whether this MCP server is enabled. Disabled servers have their deployments removed.                                                                                                                  |
| `spec.managed`         | boolean  | no       | `true`   | Runtime ownership. `true` or omitted means HCC owns the runtime resources. `false` means WRC owns the runtime; HCC only exposes discovery/status and must not create or delete the WRC-owned runtime. |

### Transport

| Field                 | Type    | Required | Default | Description                                                                                                                                        |
| --------------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.transport`      | object  | yes      | --      | Transport configuration for connecting to the MCP server.                                                                                          |
| `spec.transport.type` | string  | yes      | --      | Transport type. One of: `sse` (Server-Sent Events), `streamableHttp` (HTTP streaming), `stdio` (stdin/stdout, requires stdio-bridge sidecar).      |
| `spec.transport.url`  | string  | no       | --      | Client-facing URL endpoint. Required for `sse` and `streamableHttp`. Auto-generated for `stdio` (stdio-bridge sidecar provides the HTTP endpoint). |
| `spec.transport.port` | integer | no       | `3000`  | Port the MCP server listens on (used for container port and Service).                                                                              |

### Authentication

| Field                 | Type   | Required | Description                                                                                                                                   |
| --------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.auth`           | object | no       | Authentication configuration for the mcp-host connecting to this server.                                                                      |
| `spec.auth.type`      | string | no       | Authentication type. One of: `none`, `bearer`, `basic`, `apiKey`, `oauth`. `oauth` requires `spec.oauth` and forbids `secretRef`/`secretKey`. |
| `spec.auth.secretRef` | string | no       | Name of the Kubernetes Secret containing auth credentials.                                                                                    |
| `spec.auth.secretKey` | string | no       | Key within the secret to use (default depends on auth type).                                                                                  |

### OAuth (`spec.oauth`)

Present only when `spec.auth.type: oauth`. control-api runs the OAuth 2.1
authorize, token and refresh flow. Tokens are resolved per connection at call
time and are **never mounted into the connector pod**.

> **Enable the broker first.** `MCP_OAUTH_BROKER_ENABLED` is **off by default**
> in `deploy/base` (the minikube overlay turns it on). While it is off,
> OAuth connectors keep asking for consent and never get a token. Also set
> `CONTROL_API_OAUTH_CALLBACK_BASE_URL` to the browser-reachable control-api
> origin; otherwise registry OAuth installs are refused, and other callbacks
> fall back to the request host (an internal hostname behind the proxy chain).

There are three configuration styles, chosen by `source`, which can't change
after creation:

- **Built-in provider** (`source` absent): one of the known adapters in
  `provider`.
- **`remote`**: endpoints pinned from discovery when the remote-connector
  wizard installs the server.
- **`generic`**: an operator-configured client with explicit endpoints and
  wire options.

| Field                                                                                                                                                     | Applies to                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.id`                                                                                                                                                | all                                     | Stable client identifier; also the callback path segment. Immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `oauth.provider`                                                                                                                                          | built-in                                | `salesforce`, `slack`, `notion`, `microsoft-graph`, `google`, `monday`, `clickup`, `vercel`. Immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `oauth.clientIdRef` / `oauth.clientSecretRef`                                                                                                             | all                                     | `{name, key}` of Secrets in the `mcp-server` namespace (control-api's `CONTROL_API_MCP_SERVERS_NAMESPACE`) holding the client id / secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `oauth.scopes[]`                                                                                                                                          | all                                     | Scopes to request. Include the provider's offline/refresh scope when `backgroundAccess` is true.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `oauth.backgroundAccess`                                                                                                                                  | all                                     | Allow use by a workload with no live human session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `oauth.grantScope`                                                                                                                                        | all                                     | `user` (default): every user authorizes their own grant. `context`: one shared identity per Context that enables the server in its `spec.mcpServers`, which one member bootstraps and others inherit. Immutable.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `oauth.source`                                                                                                                                            | —                                       | absent (built-in), `remote`, or `generic`. Immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `oauth.clientMode`                                                                                                                                        | remote                                  | `public` (PKCE, no secret) or `confidential`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `oauth.authorizationEndpoint`, `tokenEndpoint`, `resource`                                                                                                | remote, generic                         | Pinned endpoints; `resource` is the RFC 8707 resource indicator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `oauth.registrationEndpoint`, `issuer`, `issForCallback`                                                                                                  | remote                                  | Dynamic client registration URL, issuer, and the RFC 9207 `iss` validated on callback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `oauth.bearerInBody`, `supportsRefresh`                                                                                                                   | remote (`supportsRefresh` also generic) | Pinned at install. `bearerInBody` must be `false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `oauth.asProfile`                                                                                                                                         | remote                                  | Optional. Closed authorization-server profile, set at install when the pinned issuer is recognised. Only value: `entra-v2` (Microsoft Entra ID v2, tenant authority): the RFC 8707 `resource` is not sent, `offline_access` is always requested, and the scopes are sent on the code exchange and on refresh. Requires a Microsoft Entra tenant issuer (see the AS-PROFILE-ISSUER rule below). With `entra-v2`, control-api also checks `oauth.scopes` against the host of `spec.remote.baseUrl` at install and at runtime; see [Scopes and audience](../how-to/connect-oauth-connector.md#scopes-and-audience). Immutable. |
| `oauth.tokenRequestFormat`, `tokenAuthMethod`, `scopeSeparator`, `sendScope`, `usePkce`, `includeResponseType`, `refreshEndpoint`, `extraAuthorizeParams` | generic                                 | Wire options for non-standard authorization servers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Redirect URI to register** with the provider:

- Built-in and `generic`:
  `<CONTROL_API_OAUTH_CALLBACK_BASE_URL>/api/v1/oauth-callback/<oauth.id>`.
- `remote`: `/api/v1/oauth-callback/remote` when the authorization server
  advertises RFC 9207, otherwise `/api/v1/oauth-callback/remote/<serverName>`.
  With dynamic registration, the install id is appended and registered
  automatically.

The remote-connector wizard in Control UI shows the exact URI. See
[Connect an OAuth connector](../how-to/connect-oauth-connector.md) for the
full walkthrough.

### Server Configuration

| Field                         | Type    | Required | Default      | Description                                                             |
| ----------------------------- | ------- | -------- | ------------ | ----------------------------------------------------------------------- |
| `spec.serverConfig`           | object  | no       | --           | Operational configuration for the MCP server runtime.                   |
| `spec.serverConfig.readOnly`  | boolean | no       | `true`       | Whether the MCP server operates in read-only mode.                      |
| `spec.serverConfig.loggers`   | string  | no       | `"stderr"`   | Comma-separated list of logger outputs (e.g. `stderr`, `disk`, `mcp`).  |
| `spec.serverConfig.telemetry` | string  | no       | `"disabled"` | Whether telemetry collection is enabled. One of: `enabled`, `disabled`. |

### Environment Variables

| Field                             | Type     | Required | Description                                                                                                                                     |
| --------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.env`                        | object[] | no       | Additional environment variables for the container.                                                                                             |
| `spec.env[].name`                 | string   | yes      | Environment variable name.                                                                                                                      |
| `spec.env[].value`                | string   | yes      | Environment variable value.                                                                                                                     |
| `spec.envSecret`                  | object   | no       | Secret-backed environment variables. The context-mapper validates that the secret and all referenced keys exist before creating the deployment. |
| `spec.envSecret.name`             | string   | yes\*    | Name of the Kubernetes Secret in the same namespace. (\*Required when `envSecret` is set.)                                                      |
| `spec.envSecret.keys`             | object[] | yes\*    | Mapping of secret keys to environment variable names.                                                                                           |
| `spec.envSecret.keys[].secretKey` | string   | yes      | Key within the Kubernetes Secret.                                                                                                               |
| `spec.envSecret.keys[].envVar`    | string   | yes      | Environment variable name to expose the secret value as.                                                                                        |

### Environment Variable Mapping

`spec.envMapping` maps CRD fields to image-specific environment variable names. The context-mapper
reads structured CRD fields and sets the named env vars automatically.

| Field                             | Type   | Required | Description                                                                          |
| --------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `spec.envMapping.transport`       | string | no       | Env var for transport mode (value derived: `sse`/`streamableHttp` maps to `"http"`). |
| `spec.envMapping.httpHost`        | string | no       | Env var for HTTP bind host (value: always `"0.0.0.0"`).                              |
| `spec.envMapping.httpPort`        | string | no       | Env var for HTTP port (value from `spec.transport.port`).                            |
| `spec.envMapping.healthCheckHost` | string | no       | Env var for health check bind host (value: always `"0.0.0.0"`).                      |
| `spec.envMapping.healthCheckPort` | string | no       | Env var for health check port (value from `spec.healthCheck.port`).                  |
| `spec.envMapping.readOnly`        | string | no       | Env var for read-only mode (value from `spec.serverConfig.readOnly`).                |
| `spec.envMapping.loggers`         | string | no       | Env var for loggers (value from `spec.serverConfig.loggers`).                        |
| `spec.envMapping.telemetry`       | string | no       | Env var for telemetry (value from `spec.serverConfig.telemetry`).                    |

### Health Check

| Field                   | Type    | Required | Default | Description                                                                 |
| ----------------------- | ------- | -------- | ------- | --------------------------------------------------------------------------- |
| `spec.healthCheck`      | object  | no       | --      | Health check endpoint configuration for Kubernetes probes.                  |
| `spec.healthCheck.port` | integer | no       | `3001`  | Port for the health check endpoint (separate from the main transport port). |

### Resources

| Field                            | Type   | Required | Description                                     |
| -------------------------------- | ------ | -------- | ----------------------------------------------- |
| `spec.resources`                 | object | no       | Resource requests and limits for the container. |
| `spec.resources.requests.memory` | string | no       | Memory request (e.g. `"64Mi"`).                 |
| `spec.resources.requests.cpu`    | string | no       | CPU request (e.g. `"50m"`).                     |
| `spec.resources.limits.memory`   | string | no       | Memory limit.                                   |
| `spec.resources.limits.cpu`      | string | no       | CPU limit.                                      |

### Remote Proxy

| Field                                     | Type     | Required | Description                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec.remote`                             | object   | no       | Remote MCP server configuration. When present, the Context Mapper creates an nginx-based egress proxy Pod instead of deploying the vendor image directly. The proxy forwards requests to the external `baseUrl`, injecting auth headers from `envSecret`.                                                                                                          |
| `spec.remote.baseUrl`                     | string   | yes\*    | External MCP server endpoint URL (e.g. `https://mcp.sentry.io/sse`). Must be HTTPS and must not reference an internal cluster service (`svc.cluster.local`). The query may contain complete `${NAME}` placeholders where `NAME` matches `[A-Z_][A-Z0-9_]*`; each name must be present in the rendered egress-proxy environment. (\*Required when `remote` is set.) |
| `spec.remote.authHeaders`                 | object[] | no       | HTTP headers to inject when proxying to the remote server (max 20). Rendered into nginx `proxy_set_header` directives.                                                                                                                                                                                                                                             |
| `spec.remote.authHeaders[].header`        | string   | yes      | HTTP header name. Alphanumeric and hyphens only (1--128 chars).                                                                                                                                                                                                                                                                                                    |
| `spec.remote.authHeaders[].valueTemplate` | string   | yes      | Header value template. May contain `${VAR}` placeholders that nginx envsubst resolves at startup from mounted env vars.                                                                                                                                                                                                                                            |

An McpServer with `spec.remote` must declare at least one `egressBinding`.

Query credentials must use an `envSecret`-backed placeholder, not a literal URL
value or `spec.env`. A placeholder remains in the generated ConfigMap and is
resolved inside the egress-proxy container. A literal query value is not migrated
automatically: it remains in the existing CRD and ConfigMap until an operator
replaces it, and an affected provider key must be rotated because it may already
have been logged. `spec.envSecret` keeps the value out of the Deployment manifest
environment; a literal `spec.env` value is visible there.

The resolved query value may contain only `[A-Za-z0-9._~-]` and complete `%XX`
escapes. The proxy does not encode values. Out-of-class values are rejected
before NGINX starts; store a value that the upstream expects percent-encoded in
that form. The remote egress-proxy image and HCC must roll together because the
rendered exec liveness probe calls the image-provided `egress-proxy-liveness`
script. Rolling the image back without rolling HCC back makes remote egress
proxies fail their liveness probes visibly rather than silently losing the stderr
filter.

### Image Pull Secrets

| Field                          | Type     | Required | Description                           |
| ------------------------------ | -------- | -------- | ------------------------------------- |
| `spec.imagePullSecrets`        | object[] | no       | Image pull secrets for the container. |
| `spec.imagePullSecrets[].name` | string   | no       | Name of the image pull Secret.        |

HCC copies `spec.imagePullSecrets` verbatim onto the generated Deployment and re-validates
nothing, so whatever writes this field owns the decision.

**Object references here, `string[]` on WorkflowRecipe — intentional.** A `WorkflowRecipe`
workload declares `imagePullSecrets` as plain Secret **names**
(`docs/crds/workflowrecipe.md` §3.4.2). When WRC delegates a transport workload to an
McpServer it applies the Issue-#637 ownership filter to those names and then **normalizes
them into the `{ name }` object form** this CRD (and Kubernetes `PodSpec`) requires. That is
a documented format conversion at the contract boundary, **not** a desynchronization
between the two CRDs — neither schema should be changed to match the other.

**The platform registry credential is injected, not declared.** For an image hosted on the
configured platform registry, the writer (Control API for direct installs, WRC for
recipe-delegated servers) appends `evenfire-registry-pull` itself, after the ownership
filter. It is provisioned by Control API and is deliberately unlabeled to the #637 model, so
a recipe that names it is denied rather than honored. See
`docs/architecture/registry-pull-secret-self-provisioning.md`.

**`spec.envSecret` is a separate mechanism and must never carry registry credentials.**
`envSecret` projects Secret values into the container's **environment**; `imagePullSecrets`
is consumed by the **kubelet** and never reaches the container. A registry credential routed
through `envSecret` is readable by the workload process itself.

### Security Context

| Field                           | Type     | Required | Description                                                                                    |
| ------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `spec.security`                 | object   | no       | Security context overrides for the MCP server pod.                                             |
| `spec.security.runAsUser`       | integer  | no       | UID to run the container as. Minimum `1`.                                                      |
| `spec.security.runAsGroup`      | integer  | no       | GID to run the container as.                                                                   |
| `spec.security.fsGroup`         | integer  | no       | Supplemental group applied to mounted volumes.                                                 |
| `spec.security.addCapabilities` | string[] | no       | Linux capabilities to add. Each one of: `CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`. |

### Egress Bindings

| Field                               | Type     | Required    | Description                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec.egressBindings`               | object[] | no          | External egress bindings allowing this MCP server to reach external APIs. Each binding generates a NetworkPolicy allowing egress to the specified destination.                                                                                                                                   |
| `spec.egressBindings[].egressClass` | string   | no          | Egress class. `exact-host` is the default for `dns`/`cidr` bindings. `public-web` is explicit public TCP 80/443 egress with private, metadata, cluster-internal, link-local, multicast, and reserved ranges blocked.                                                                             |
| `spec.egressBindings[].dns`         | string   | no          | DNS hostname to resolve (e.g. `api.openai.com`). Mutually exclusive with `cidr`.                                                                                                                                                                                                                 |
| `spec.egressBindings[].cidr`        | string   | no          | Public IPv4 CIDR range (e.g. `203.0.114.10/32`). Mutually exclusive with `dns`. Must use canonical network notation and must not overlap private, metadata, link-local, documentation, multicast, or reserved IPv4 ranges (this rejects `0.0.0.0/0` and any RFC1918 range such as `10.0.0.0/8`). |
| `spec.egressBindings[].port`        | integer  | conditional | Destination port number. Required for `exact-host` bindings; `public-web` bindings must omit it.                                                                                                                                                                                                 |
| `spec.egressBindings[].protocol`    | string   | no          | Network protocol for exact-host bindings. One of: `TCP`, `UDP`. If omitted, the controller treats exact-host as `TCP`; public-web must omit this field.                                                                                                                                          |

Validation rules enforce that exactly one of `dns` or `cidr` must be set per binding, and
that a `cidr` is a canonical public IPv4 range that does not overlap private, metadata,
link-local, documentation, multicast, or reserved ranges (so `0.0.0.0/0` and RFC1918 ranges
are rejected).

`public-web` bindings must not declare `dns`, `cidr`, `port`, or `protocol`.
They are intended for operator-approved MCP servers that need dynamic public web
access and cannot be represented by a stable exact-host list. Registry
`egressSummary.wideCidr: true` is a temporary compatibility signal that Control
API translates to this explicit `egressClass: public-web` CRD shape.

## Status

| Field                                   | Type      | Description                                                                                                                                                                                                                          |
| --------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status.resolvedEgressIPs`              | object[]  | Resolved IPs for DNS-based egress bindings (for auditability).                                                                                                                                                                       |
| `status.resolvedEgressIPs[].dns`        | string    | The DNS hostname that was resolved.                                                                                                                                                                                                  |
| `status.resolvedEgressIPs[].ips`        | string[]  | Resolved IP addresses.                                                                                                                                                                                                               |
| `status.resolvedEgressIPs[].resolvedAt` | date-time | When the resolution occurred.                                                                                                                                                                                                        |
| `status.conditions[]`                   | object[]  | Standard conditions written by host-context-controller (e.g. `SecretResolved`, `Ready`) with `reason` (e.g. `SecretNotFound`) and `observedGeneration`. Control UI uses them to show connectors whose credentials are still missing. |

## Additional Printer Columns

`kubectl get mcpservers` displays: Image, Transport, URL, Enabled, Managed, Ready. To see which Contexts expose a server, read `spec.mcpServers` with `kubectl get contexts`.

## CRD Validation Rules

- WRC-owned servers (`managed: false`) still require `transport`.
- For `managed: false`, WRC owns runtime isolation, including runtime NetworkPolicies; HCC exposes discovery/status and does not create or delete WRC-owned runtime policies.
- `spec.managed` is immutable after creation; omit is treated as the default `true`.
- Each egress binding must have exactly one of `dns` or `cidr` (not both, not neither).
- A `cidr` must be a canonical public IPv4 range; ranges overlapping private, metadata, link-local, documentation, multicast, or reserved IPv4 ranges (including `0.0.0.0/0` and RFC1918 ranges such as `10.0.0.0/8`) are rejected.
- An McpServer with `spec.remote` must declare at least one `egressBinding`.
- `spec.oauth.asProfile` is remote-only: built-in (no `source`) and `generic` servers must not set it.
- On a `remote` server, `spec.oauth.asProfile` is immutable like the other pinned fields: it cannot be added, removed, or changed after creation. Delete and recreate the server to change it.
- **AS-PROFILE-ISSUER:** when `spec.oauth.asProfile` is set, `spec.oauth.issuer` must be a Microsoft Entra ID tenant authority, matching `^https://login[.]microsoftonline[.]com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/v2[.]0$` (lower-case tenant GUID, no trailing slash). Otherwise the write is rejected with `spec.oauth.asProfile entra-v2 requires spec.oauth.issuer to be a Microsoft Entra ID tenant authority`. A profile stops sending the RFC 8707 `resource`, so it must stay on the issuer it was recognised from. control-api applies the same check at runtime and refuses an object written before the rule was in the cluster (`409 remote_oauth_spec_incoherent`, reason `as_profile_issuer_mismatch`).

> **Apply the CRD before control-api.** An apiserver whose McpServer CRD does not
> declare `asProfile` drops the field on write and still answers 200. The install
> route detects this, removes what it created and answers `409 mcpserver_crd_outdated`.
> An object written another way (`kubectl`, GitOps) keeps the Entra issuer without
> the profile; control-api refuses it at runtime (`409 remote_oauth_spec_incoherent`,
> reason `as_profile_issuer_mismatch`), and because the profile cannot be added after
> creation it must be deleted and recreated once the CRD is applied. See
> [Deploy order for additive schema fields](../../charts/clerum-crds/README.md#deploy-order-for-additive-schema-fields).

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: github-server
spec:
  description: Provides GitHub repository management tools
  image: mcp/github:latest
  transport:
    type: sse
    url: http://github-server.mcp-server.svc.cluster.local:3000/sse
    port: 3000
  env:
    - name: MCP_TRANSPORT
      value: 'sse'
    - name: MCP_HOST
      value: '0.0.0.0'
    - name: MCP_PORT
      value: '3000'
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
      memory: '64Mi'
      cpu: '50m'
    limits:
      memory: '128Mi'
      cpu: '200m'
  enabled: true
```

## Related

- [Context CRD](context.md) -- lists this server's name in `spec.mcpServers` to expose it
- [Host CRD](host.md) -- indirectly connected through Context
- [CRD Index](README.md)
- Examples: [github](../../charts/clerum-crds/examples/mcpserver-github.yaml), [postgres](../../charts/clerum-crds/examples/mcpserver-postgres.yaml), [filesystem](../../charts/clerum-crds/examples/mcpserver-filesystem.yaml)
