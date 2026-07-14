# nginx-egress-proxy

Hardened nginx image that serves as the pinned egress path for **remote** MCP
servers (McpServer CRDs with `spec.remote.baseUrl`).

**This directory contains only a Dockerfile — there is no application code
here.** All proxy logic (config generation, URL/header sanitization, deployment)
lives in [host-context-controller](../host-context-controller/) (`src/reconciler.ts`).

## The image

- Base: `nginx:1.30.1-alpine` — kept because its entrypoint runs `envsubst` on
  `/etc/nginx/templates/*.template` at startup, which HCC relies on for
  credential injection.
- Hardened to run as non-root (`USER 101:101`): the `user` directive is removed
  from `nginx.conf`, the PID file moves to `/tmp/nginx.pid`, the shipped
  `default.conf` is removed, and nginx dirs plus `/tmp` temp dirs are chowned
  to `101:101`.

## How it works

For each remote McpServer, host-context-controller:

1. **Validates and sanitizes `spec.remote.baseUrl`** (`sanitizeRemoteUrl`):
   HTTPS only; DNS hostnames only (IPv4/IPv6 literals rejected); internal
   cluster hosts (`*.svc`, `*.svc.cluster.local`, `kubernetes.default`) and
   private/link-local/loopback patterns rejected; the URL is reconstructed from
   parsed components so injected characters (e.g. newlines) are stripped.
2. **Renders a per-server `default.conf.template` ConfigMap** pinning
   `proxy_pass` to that single external base URL, with TLS to the upstream
   (`proxy_ssl_verify on`, SNI, system CA bundle), SSE-friendly settings
   (buffering/cache off, long read timeouts), and a local `/health` endpoint.
3. **Sanitizes each `spec.remote.authHeaders` entry** (`sanitizeAuthHeader`):
   header names restricted to `[A-Za-z0-9-]`, values capped at 2048 chars,
   CR/LF/NUL rejected (HTTP request smuggling / nginx directive-injection
   defense), backslashes and quotes escaped for nginx's quoted-string context.
4. **Deploys this image as the only container** (`egress-proxy`) of the
   per-server Deployment. The ConfigMap mounts at `/etc/nginx/templates`, so
   `envsubst` resolves `${VAR}` placeholders in auth headers at pod start from
   env vars sourced from `spec.envSecret` — with `${VAR}` placeholders,
   credentials never appear in the ConfigMap itself. A literal value inlined in
   the CRD would be emitted (escaped) into the ConfigMap — always use
   placeholders.

## Configuration

The image takes no configuration of its own; env vars are injected per-server
by HCC from the McpServer CRD (`spec.env`, `spec.envSecret`). The image
reference is platform-controlled:

| Setting                                     | Component                                                             | Default                           |
| ------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| `CONTEXT_MAPPER_EGRESS_PROXY_IMAGE`         | host-context-controller                                               | `clerum/nginx-egress-proxy:0.1.0` |
| `CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE` | control-api (registry install stamps `spec.image` for remote entries) | `clerum/nginx-egress-proxy:0.1.0` |

HCC additionally canonicalizes `spec.image` of remote McpServers back to the
platform image (`canonicalizeRemoteEgressProxyImage`) as best-effort cleanup;
the enforcement is that Deployment rendering always stamps the configured
platform image, so a CRD's `spec.image` is never what runs.

## Ports

The image `EXPOSE`s **3000**. The actual `listen` port in the generated config
comes from `spec.transport.port` (default 3000); `/health` answers on it.

## Security

- Deployed as the workload's only container on the remote path: `runAsNonRoot` as `101:101`,
  all capabilities dropped, `allowPrivilegeEscalation: false`, seccomp
  `RuntimeDefault`, `automountServiceAccountToken: false` at the pod level.
- Proxy is pinned to exactly one sanitized external base URL over verified TLS.
- The broader egress-binding CIDR model (private, metadata, link-local,
  documentation, multicast, and reserved IPv4 ranges blocked) is validated in
  [control-ui/lib/egressModel.ts](../control-ui/lib/egressModel.ts).

## Testing

The generated config, sanitization rules, and deployment shape are asserted in
[host-context-controller/src/\_\_tests\_\_/reconciler.remote.test.ts](../host-context-controller/src/__tests__/reconciler.remote.test.ts).

## Build & deploy

CI builds and publishes the image via
[.github/workflows/build-publish.yml](../.github/workflows/build-publish.yml)
(ghcr.io). There are no static manifests for this service: Deployments,
ConfigMaps, and Services are created dynamically by host-context-controller —
see its [README](../host-context-controller/README.md).
