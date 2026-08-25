/**
 * Mock MCP Server for E2E testing.
 *
 * Exposes test tools via StreamableHTTP transport:
 *   - echo: returns the input text
 *   - add: adds two numbers
 *   - record: stores a key/value in this mock server process
 *   - recall: returns a previously stored key/value
 *   - fetch_http: fetches an allowlisted public HTTPS URL for egress tests
 *   - hang: sleeps long enough for timeout-bound workflow tests
 *
 * Health check on a separate port. Also serves two additive, opt-in routes
 * used by the issue #223 credential-rotation E2E suites (see
 * tests/e2e/integration/mcpRotation.helpers.ts):
 *   - GET /whoami-credential : echoes E2E_ROTATION_API_KEY as currently
 *     injected into THIS pod's env — proves a rotated credential actually
 *     reached a running container after rollout.
 *   - GET /echo-headers      : echoes received request headers as JSON — used
 *     as the upstream target for a remote connector's authHeaders, to prove
 *     the rotated value reaches the nginx egress proxy's outbound request.
 * Neither route is used by any existing consumer of this image, and the
 * startup gate below only fires for a reserved sentinel value no other
 * suite sets — both are inert unless a test opts in.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'crypto'
import { IncomingMessage, ServerResponse, createServer } from 'http'
import { z } from 'zod'

const MCP_PORT = parseInt(process.env.MCP_PORT || '3000', 10)
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3001', 10)
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '10000', 10)
const FETCH_ALLOWED_HOSTS = new Set(
  (process.env.EGRESS_PROBE_ALLOWED_HOSTS || 'example.com,httpbin.org')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
)
const records = new Map<string, string>()

// ─── Issue #223: opt-in credential-rotation test gate ───────────────────────
// Must match ROTATION_CREDENTIAL_ENV_VAR / ROTATION_INVALID_SENTINEL in
// tests/e2e/integration/mcpRotation.helpers.ts. When the E2E
// scenario for a FAILED rollout (E2) rotates this env var to the reserved
// sentinel, the process refuses to start — a real crash-loop, not a
// simulated one, so the Deployment's rolling update genuinely never
// converges and host-context-controller's generation-aware readiness check
// has something true to observe. Absent (the default for every other
// consumer of this image), this is a no-op.
const ROTATION_CREDENTIAL_ENV_VAR = 'E2E_ROTATION_API_KEY'
const ROTATION_INVALID_SENTINEL = '__E2E_INVALID_CREDENTIAL__'
if (process.env[ROTATION_CREDENTIAL_ENV_VAR] === ROTATION_INVALID_SENTINEL) {
  console.error(
    `[MockMCP] ${ROTATION_CREDENTIAL_ENV_VAR} is the reserved invalid-credential sentinel — ` +
      'refusing to start (issue #223 E2 fixture gate).'
  )
  process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function validateFetchUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('url must be an absolute URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('fetch_http only allows https URLs')
  }
  if (!FETCH_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`fetch_http host is not allowlisted: ${url.hostname}`)
  }
  return url
}

async function fetchWithTimeout(url: URL): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'clerum-e2e-mock-mcp-server/0.1',
        accept: 'text/plain, application/json;q=0.9, */*;q=0.1',
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

/** Create a fresh McpServer instance with the mock tools registered. */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mock-server',
    version: '0.1.0',
  })

  server.tool(
    'echo',
    'Echoes back the provided text',
    { text: z.string().describe('The text to echo back') },
    async ({ text }: { text: string }) => ({
      content: [{ type: 'text' as const, text: `Echo: ${text}` }],
    })
  )

  server.tool(
    'add',
    'Adds two numbers together',
    {
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    },
    async ({ a, b }: { a: number; b: number }) => ({
      content: [{ type: 'text' as const, text: String(a + b) }],
    })
  )

  server.tool(
    'record',
    'Stores a key/value pair in the mock MCP server process',
    {
      key: z.string().min(1).max(64).describe('Record key'),
      value: z.string().max(1024).describe('Record value'),
    },
    async ({ key, value }: { key: string; value: string }) => {
      records.set(key, value)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ key, value, stored: true }) }],
      }
    }
  )

  server.tool(
    'recall',
    'Returns a key/value pair stored by the record tool',
    { key: z.string().min(1).max(64).describe('Record key') },
    async ({ key }: { key: string }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ key, value: records.get(key) ?? null }),
        },
      ],
    })
  )

  server.tool(
    'fetch_http',
    'Fetches an allowlisted public HTTPS URL and returns status plus a text preview',
    {
      url: z.string().url().describe('Allowlisted public HTTPS URL to fetch'),
    },
    async ({ url: rawUrl }: { url: string }) => {
      const url = validateFetchUrl(rawUrl)
      const response = await fetchWithTimeout(url)
      const text = await response.text()
      const payload = {
        ok: response.ok,
        status: response.status,
        hostname: url.hostname,
        url: response.url,
        contentType: response.headers.get('content-type') ?? '',
        textPreview: text.slice(0, 500),
      }
      if (!response.ok) {
        throw new Error(`fetch_http returned HTTP ${response.status}`)
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      }
    }
  )

  server.tool(
    'hang',
    'Sleeps for timeout-bound MCP workflow tests',
    { durationMs: z.number().int().positive().max(600_000).default(120_000) },
    async ({ durationMs }: { durationMs: number }) => {
      await sleep(durationMs)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ completed: true, durationMs }) }],
      }
    }
  )

  return server
}

// --- StreamableHTTP Transport (raw http, no Express) ---

const transports = new Map<string, StreamableHTTPServerTransport>()

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined

  // Existing session
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!
    await transport.handleRequest(req, res)
    return
  }

  // New POST = new session (initialize)
  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    })

    // Connect a fresh McpServer to this transport BEFORE handling the request.
    // The server.connect() just sets up internal wiring — it doesn't consume the request.
    const server = createMcpServer()
    await server.connect(transport)

    // Now handle the incoming initialize request.
    // This will assign the session ID internally and send the response.
    await transport.handleRequest(req, res)

    // After handleRequest, the transport should have a session ID assigned.
    // Extract it from the response headers that were just sent.
    const assignedSessionId = (transport as any).sessionId as string | undefined
    if (assignedSessionId) {
      transports.set(assignedSessionId, transport)
      console.log(`[MockMCP] New session: ${assignedSessionId}`)
    }

    transport.onclose = () => {
      if (assignedSessionId) {
        transports.delete(assignedSessionId)
        console.log(`[MockMCP] Session closed: ${assignedSessionId}`)
      }
    }

    return
  }

  // Non-POST without session
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Bad request — send POST to initialize' }))
}

const mcpHttpServer = createServer(async (req, res) => {
  if (req.url === '/mcp') {
    try {
      await handleMcp(req, res)
    } catch (e) {
      console.error('[MockMCP] Error:', e)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  }
})

mcpHttpServer.listen(MCP_PORT, '0.0.0.0', () => {
  console.log(`[MockMCP] StreamableHTTP server listening on port ${MCP_PORT}`)
})

// --- Health Check (+ issue #223 credential-rotation probe routes) ---

const healthServer = createServer((req, res) => {
  const url = req.url ?? '/'

  if (url === '/whoami-credential') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ key: process.env[ROTATION_CREDENTIAL_ENV_VAR] ?? null }))
    return
  }

  if (url === '/echo-headers') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ headers: req.headers }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      status: 'ok',
      tools: ['echo', 'add', 'record', 'recall', 'fetch_http', 'hang'],
    })
  )
})

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[MockMCP] Health check listening on port ${HEALTH_PORT}`)
})
