# MCP Proxy

Centralized HTTP proxy for MCP servers. It discovers available servers by polling the host-context-controller (HCC) API, maintains an in-memory routing table, and forwards incoming JSON-RPC requests to the correct backend.

## Feature Flag

MCP Proxy is an optional component gated by the `MCP_PROXY_ENABLED` feature flag. When enabled, mcp-host routes all MCP tool calls through the proxy instead of connecting to servers directly.

## Port

`8083` (configurable via `MCP_PROXY_PORT`)

## Architecture

```
mcp-host
   ↓ POST /servers/{name}/mcp
MCP Proxy (:8083)
   ├── Router (in-memory routing table)
   ├── HccClient (polls HCC every 30s for server list)
   └── HttpForwarder (proxies request to backend server)
         ↓
MCP Server (e.g. mongodb-mcp:3000, stdio-bridge:3000)
```

1. **Server discovery** -- `HccClient` polls `GET {HCC_API_URL}/api/v1/mcpservers` on a configurable interval. Each server entry includes a name, transport URL, readiness status, and context ref. Results are cached; stale/expired cache affects health probes.
2. **Routing** -- `Router` maintains a `Map<name, ServerRoute>`. On each poll, it diffs the new list against the current map and logs additions/removals.
3. **Forwarding** -- `HttpForwarder` pipes the incoming request body to the backend URL, buffers initial response chunks before committing headers (to avoid silent truncation on oversized responses), and enforces `maxResponseSize` and `requestTimeout`.
4. **Metrics** -- Prometheus-format counters at `GET /metrics`: `mcp_proxy_requests_total`, `mcp_proxy_active_connections`, `mcp_proxy_server_health`.
5. **Health** -- `GET /health` (liveness) and `GET /ready` (readiness, fails when HCC cache is expired or no servers are ready).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PROXY_PORT` | `8083` | HTTP listen port |
| `HCC_API_URL` | `http://host-context-controller.control-plane:8081` | HCC API base URL |
| `HCC_POLL_INTERVAL` | `30000` | Server discovery poll interval (ms) |
| `HCC_CACHE_TTL` | `120000` | Cache staleness threshold (ms) -- health warns |
| `HCC_CACHE_EXPIRY` | `300000` | Cache expiry threshold (ms) -- readiness fails |
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
├── hccClient.ts     # HCC API client with cache + staleness tracking
├── httpForwarder.ts # Request proxy with buffered headers and size guard
├── health.ts        # Liveness + readiness probe handlers
├── metrics.ts       # Prometheus counter/gauge collector
└── types.ts         # Config loader + shared interfaces
```
