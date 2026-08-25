# MCP Proxy

Centralized HTTP proxy for MCP servers. It keeps a low-sensitivity topology view for health and observability, but every data-plane request is authorized live by the host-context-controller (HCC) before the proxy opens an upstream socket.

## Feature Flag

MCP Proxy is an optional component. `MCP_PROXY_ENABLED` selects proxy mode in mcp-host; `MCP_PROXY_FORWARDING_ENABLED` is the proxy's independent forwarding gate and remains `false` by default. A disabled gate makes no HCC authorization call and performs no upstream forwarding.

## Port

`8083` (configurable via `MCP_PROXY_PORT`)

## Architecture

```
mcp-host
   ↓ POST/GET /servers/{name}/mcp
MCP Proxy (:8083) — singleton TCB
   ├── HccClient (system-authenticated topology + live authorizeForward)
   └── HttpForwarder (buffer, sanitize, then forward)
         ↓
MCP Server (current HCC-approved target)
```

1. **Topology** -- `HccClient` polls the system-authenticated v2 directory at `GET {HCC_API_URL}/api/v2/system/mcpservers`. It may cache non-secret names, Context references, transport and readiness metadata for health/observability only. The cache is never a forwarding grant and the proxy has no v1 fallback.
2. **Live authorization** -- each request to `/servers/{name}/mcp` sends the projected system bearer and the caller's separate Host bearer to `POST {HCC_API_URL}/api/v2/system/mcpservers/authorize`. HCC resolves Host → Context → McpServer live and returns only the validated target and its destination binding.
3. **Pre-socket forwarding** -- `HttpForwarder` buffers and bounds the complete body, rejects invalid framing, strips identity/hop-by-hop headers, and opens no upstream socket until live authorization succeeds. Caller cancellation is checked again before the socket is created.
4. **Metrics** -- Prometheus-format counters at `GET /metrics`: `mcp_proxy_requests_total`, `mcp_proxy_active_connections`, `mcp_proxy_server_health`.
5. **Health** -- `GET /health` (liveness) and `GET /ready` (readiness, fails when the topology poll is expired or no servers are ready). Health state does not authorize data-plane traffic.

Data-plane errors use one non-enumerable status taxonomy: `400` for malformed
method/path/body/framing, `401` for a missing or invalid Host bearer, `403` for
a valid Host denied by live HCC membership/readiness, and `503` for HCC,
live-target, or forwarding availability failures. The proxy does not expose
distinct `404`, `405`, `413`, `429`, `502`, or `504` decisions from this
boundary, and all negative responses are bounded and non-cacheable.

The proxy is an explicit singleton trusted computing base. PR2 limits its Kubernetes authority and egress, but does not claim to contain malicious code running inside the proxy. The Host bearer, projected system bearer, and MCP credential remain separate; only the MCP credential is allowed to reach the upstream MCP server.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PROXY_PORT` | `8083` | HTTP listen port |
| `HCC_API_URL` | `http://host-context-controller.control-plane:8081` | HCC API base URL |
| `HCC_POLL_INTERVAL` | `30000` | Server discovery poll interval (ms) |
| `HCC_CACHE_TTL` | `180000` | Cache staleness threshold (ms) -- health warns; never authorizes forwarding |
| `HCC_CACHE_EXPIRY` | `600000` | Cache expiry threshold (ms) -- readiness fails; never authorizes forwarding |
| `MCP_PROXY_FORWARDING_ENABLED` | `false` | Independent data-plane forwarding gate |
| `MCP_PROXY_ENABLED` | `false` in base mcp-host config | Selects proxy mode in mcp-host; does not grant proxy forwarding by itself |
| `MCP_PROXY_REQUEST_TIMEOUT` | `30000` | Per-request forwarding timeout (ms) |
| `MCP_PROXY_MAX_RESPONSE_SIZE` | `10485760` | Max response body size (10 MB) |
| `CLERUM_DEV_MODE` | `false` | Dev mode: skip HCC polling, use static server list |
| `MCP_PROXY_SERVERS` | `[]` | JSON array of `ServerRoute` objects (dev mode only) |
| `LOG_LEVEL` | `info` | Log verbosity |

## Local Development

```bash
cd mcp-proxy
npm install
CLERUM_DEV_MODE=true \
MCP_PROXY_FORWARDING_ENABLED=true \
MCP_PROXY_SERVERS='[{"name":"echo","url":"http://localhost:3001/mcp","contextRef":"dev","managed":true,"ready":true,"port":3001}]' \
npm run dev
```

## Docker Build

```bash
docker build -t clerum/mcp-proxy:latest ./mcp-proxy
```

## Kubernetes Deployment

- **Namespace:** `mcp-server`
- **Manifest:** `deploy/base/mcp-server/mcp-proxy.yaml`
- Deploys a `Deployment`, `Service` (ClusterIP), and `ServiceAccount`
- Liveness: `/health`, Readiness: `/ready`, Startup: `/health`
- Runs as non-root (UID 1000), read-only root filesystem, all capabilities dropped

## Testing

```bash
cd mcp-proxy
npm test          # vitest — 5 test files (router, hccClient, httpForwarder, metrics, server)
npm run test:watch
```

Test files are in `mcp-proxy/test/`.

## Source Layout

```
src/
├── main.ts          # Entrypoint: config, wire dependencies, start poll + server
├── server.ts        # HTTP server: route dispatch, health/metrics/forward endpoints
├── router.ts        # In-memory routing table with diff-based updates
├── hccClient.ts     # HCC v2 system inventory + live forwarding authorization
├── httpForwarder.ts # Request proxy with buffered headers and size guard
├── health.ts        # Liveness + readiness probe handlers
├── metrics.ts       # Prometheus counter/gauge collector
└── types.ts         # Config loader + shared interfaces
```
