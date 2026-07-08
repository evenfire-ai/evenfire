# stdio-bridge

Sidecar that translates the stdio MCP transport to StreamableHTTP, exposing a JSON-RPC HTTP endpoint on port 3000. This lets Clerum route requests to MCP servers that only support stdin/stdout (e.g., PostgreSQL, Redis, GitHub, Brave Search) through the same HTTP-based infrastructure used for native HTTP MCP servers.

## When to Use

Use stdio-bridge for any MCP server image that communicates over stdin/stdout instead of HTTP. In a WorkflowRecipe, set `transport.type: stdio` on the workload -- the host-context-controller (HCC) automatically injects stdio-bridge as a sidecar container alongside the MCP server pod.

## Port

`3000` (configurable via `BRIDGE_PORT`)

## How It Works

```
mcp-host / mcp-proxy
   ↓ POST /mcp (JSON-RPC)
stdio-bridge (:3000)
   ↓ stdin (JSON-RPC message)
MCP server process (e.g. @modelcontextprotocol/server-postgres)
   ↓ stdout (JSON-RPC response)
stdio-bridge
   ↓ HTTP 200 (JSON-RPC response)
caller
```

1. **Process spawn** -- On startup, `StdioBridge` spawns the target MCP server as a child process using `StdioClientTransport` from `@modelcontextprotocol/sdk`. The command and args are configured via environment variables.
2. **Request routing** -- Incoming HTTP POST requests are parsed as JSON-RPC messages, sent to the child process over stdin, and the corresponding response (matched by `id`) is returned as the HTTP response.
3. **Health** -- `GET /health` returns process status, command name, and restart count.
4. **Auto-restart** -- If the child process exits unexpectedly, stdio-bridge restarts it with exponential backoff (base delay x 3^n), up to a configurable maximum number of retries.
5. **Graceful shutdown** -- On SIGTERM/SIGINT, pending requests are rejected, the HTTP server is closed, and the child process stdin is closed with a configurable timeout.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STDIO_COMMAND` | *(required)* | Command to spawn (e.g., `node`, `npx`) |
| `STDIO_ARGS` | `[]` | JSON array of arguments (e.g., `["dist/index.js"]`) |
| `BRIDGE_PORT` | `3000` | HTTP listen port |
| `BRIDGE_HEALTH_PATH` | `/health` | Health endpoint path |
| `STDIO_RESTART_MAX` | `3` | Max auto-restart attempts |
| `STDIO_RESTART_DELAY` | `5000` | Base restart delay (ms) |
| `STDIO_INIT_TIMEOUT` | `30000` | Process init timeout (ms) |
| `STDIO_SHUTDOWN_TIMEOUT` | `10000` | Graceful shutdown timeout (ms) |
| `LOG_LEVEL` | `info` | Log verbosity |

## Local Development

```bash
cd stdio-bridge
npm install
STDIO_COMMAND=node STDIO_ARGS='["../tests/e2e/fixtures/mock-stdio-mcp-server/dist/index.js"]' npm run dev
```

## Docker Build

```bash
docker build -t clerum/stdio-bridge:latest ./stdio-bridge
```

## Kubernetes Deployment

stdio-bridge is not deployed as a standalone service. It runs as a **sidecar container** alongside MCP server pods in the `mcp-server` namespace. HCC injects it automatically when a WorkflowRecipe or McpServer CRD specifies `transport.type: stdio`:

- HCC adds stdio-bridge as a container in the pod spec
- An `emptyDir` volume is shared between the MCP server init container and stdio-bridge
- MCP Proxy routes HTTP requests to `stdio-bridge:3000` transparently

## Testing

```bash
cd stdio-bridge
npm test          # vitest — 1 test file (bridge.test.ts)
npm run test:watch
```

Test files are in `stdio-bridge/test/`.

## Source Layout

```
src/
├── main.ts    # Entrypoint: load config, start bridge, graceful shutdown
├── bridge.ts  # StdioBridge: process lifecycle, HTTP server, request/response routing
└── types.ts   # BridgeConfig interface + env-based config loader
```
