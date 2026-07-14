# Webhook Proxy

Cluster-shared webhook ingress: a stateless, registry-validated router that
accepts public webhook traffic and forwards it to the right per-recipe
webhook-gateway. It holds no secrets beyond one control-api service token,
does no HMAC verification (that is the gateway's job), and buffers no bodies —
requests are streamed through.

## How it works

1. A request arrives at `ANY /api/v1/webhook/:recipeNs/:recipeName/:webhookId`
   (TLS is terminated upstream at the cluster edge; the proxy listens on plain
   HTTP).
2. The proxy validates the three path segments locally (see
   [Security](#security)) before doing anything else.
3. It looks the webhook up in control-api's internal registry
   (`GET /internal/webhook/registry/:ns/:name/:id`), authenticating with
   `Authorization: Bearer <service token>` plus `x-service-token:
webhook-proxy`, with a 5s lookup timeout. Results are cached in memory for
   `WEBHOOK_PROXY_REGISTRY_CACHE_TTL_MS` (default 5s) — hits **and** misses,
   so probe bursts against unknown ids don't hammer control-api. Transient
   `upstream_error` results are never cached.
4. On a registry hit it enforces the webhook's method allow-list (405
   otherwise) and a `Content-Length` pre-check against
   `min(registry maxBodyBytes, WEBHOOK_PROXY_MAX_BODY_BYTES_CEILING)` (413),
   then streams the request to the gateway service/namespace/port returned by
   the registry, dropping the `DROP_HEADERS` set from `src/forwarder.ts`
   (`cookie`, `host`, `connection`, `keep-alive`, `proxy-connection`,
   `transfer-encoding`) and rewriting `Host`.

Two extra routes bypass the registry entirely and are forwarded to
workflow-approval-request-reader for provider approval/chat callbacks:
`/webhooks/telegram` and `/webhooks/slack/:id`.

## Configuration

All configuration is via environment variables (`src/config.ts`):

| Variable                                          | Default                                                                   | Purpose                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `WEBHOOK_PROXY_HTTP_PORT`                         | `8095`                                                                    | Public-facing HTTP port                                                                                                  |
| `WEBHOOK_PROXY_METRICS_PORT`                      | `9090`                                                                    | Health port (`/healthz`, `/readyz`)                                                                                      |
| `WEBHOOK_PROXY_CONTROL_API_BASE_URL`              | `http://control-api.control-plane.svc.cluster.local:8090/api/v1`          | Registry lookup endpoint                                                                                                 |
| `WEBHOOK_PROXY_WORKFLOW_APPROVAL_READER_BASE_URL` | `http://workflow-approval-request-reader.channels.svc.cluster.local:8098` | Upstream for `/webhooks/telegram` and `/webhooks/slack/:id`                                                              |
| `WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN`         | `dev-webhook-proxy-token`                                                 | Service token registered in control-api (rotate in production)                                                           |
| `WEBHOOK_PROXY_SANDBOX_NAMESPACE`                 | `sandbox-recipes`                                                         | Namespace pin — `:recipeNs` must equal this                                                                              |
| `WEBHOOK_PROXY_REGISTRY_CACHE_TTL_MS`             | `5000`                                                                    | TTL for cached registry results (positive and negative)                                                                  |
| `WEBHOOK_PROXY_UPSTREAM_TIMEOUT_MS`               | `30000`                                                                   | Timeout for the gateway/reader forward                                                                                   |
| `WEBHOOK_PROXY_MAX_BODY_BYTES_CEILING`            | `10485760`                                                                | Declared `Content-Length` pre-check (chunked bodies without `Content-Length` pass through to the gateway's streamed cap) |

## Ports

- `8095` — public webhook traffic (HTTP; TLS terminated at the edge). Also
  answers `/healthz` and `/readyz`.
- `9090` — separate health server (`/healthz`, `/readyz`); used by the
  readiness/liveness probes in the deploy manifests.

## Security

Defense-in-depth, applied in order before any registry lookup:

- **Namespace pin** — `:recipeNs` must equal `WEBHOOK_PROXY_SANDBOX_NAMESPACE`
  or the request gets a generic 404 `webhook_not_found`.
- **Segment revalidation** — `:webhookId` is checked against `WEBHOOK_ID_RE`
  (`src/config.ts`), the same pattern the gateway and CRD use, and the gateway
  revalidates it independently; `:recipeName` is checked against
  `RECIPE_NAME_RE`, a proxy-side check only (the gateway never sees the recipe
  name).
- **No URL-decoding** — path segments are matched in raw form, so encoded
  traversal attempts like `%2e%2e` never decode into `..`.
- **No existence leak via CORS** — per-webhook CORS posture (allowed origins
  from the registry) is resolved only _after_ the webhook is confirmed to
  exist; pre-registry failures carry no `Access-Control-Allow-Origin` echo.
  `OPTIONS` preflights are answered locally (never forwarded), and the
  `Access-Control-Allow-Headers` echo is clamped to 256 chars.
- **Minimal trust surface** — zero runtime npm dependencies
  (`dependencies: {}` in `package.json`), no body buffering, and a fixed
  drop-list on forward (`cookie`, `host`, `connection`, `keep-alive`,
  `proxy-connection`, `transfer-encoding`). The proxy injects no identity
  headers; `X-Clerum-*` handling belongs to the gateway.
- **Container hardening** — runs as non-root uid 1001 (Dockerfile and deploy
  manifest), read-only root filesystem, all capabilities dropped,
  `RuntimeDefault` seccomp.
- **NetworkPolicies** — `deploy/base/webhook-ingress/networkpolicies.yaml`
  applies deny-all plus narrow allows: ingress from the cloudflared tunnel on
  8095 and monitoring on 9090; egress only to control-api, labelled
  webhook-gateway pods in the sandbox namespace,
  workflow-approval-request-reader, and DNS (port 53 to kube-system).

## Testing

22 test cases across two vitest suites (`test/registry.test.ts`,
`test/server.e2e.test.ts`) covering registry caching semantics, route
validation, method/body-size enforcement, and the CORS matrix:

```bash
cd webhook-proxy
npm install
npm test
```

## Deploy

Kubernetes manifests live in
[`deploy/base/webhook-ingress/`](../deploy/base/webhook-ingress/)
(Deployment, Service, ConfigMap, Secret, NetworkPolicies — namespace
`webhook-ingress`, 2 replicas). Replace the placeholder
`WEBHOOK_PROXY_CONTROL_API_SERVICE_TOKEN` secret value before production use;
it must match the `webhook-proxy` entry in control-api's internal
service-token config.
