import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChildProcess, spawn } from 'node:child_process'
import http, { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_JWT_PUBLIC_KEY, signRpcJwt, signWithWrongKey } from './helpers/jwt.js'
import { getFreePort } from './helpers/ports.js'

type ServerEntry = { name: string; url: string }
type HostEntry = { hostRef: string; url: string }
type ControlApiMode = 'ok' | 'error500'
type UpstreamMode =
  | 'ok'
  | 'status400'
  | 'status500'
  | 'timeout'
  | 'mongodbSessionRequired'
  | 'hostStatus500'
  | 'hostTimeout'

function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

async function requestJson(
  baseUrl: string,
  pathName: string,
  init: RequestInit = {},
  token?: string
): Promise<{ status: number; body: any; raw: string }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${baseUrl}${pathName}`, { ...init, headers })
  const raw = await res.text()
  let body: unknown = raw
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    // keep raw text for assertions
  }
  return { status: res.status, body, raw }
}

describe('rpc-proxy e2e security suite', () => {
  let rpcProxyProcess: ChildProcess | null = null
  let controlApiServer: http.Server | null = null
  let upstreamServer: http.Server | null = null
  let rpcProxyBaseUrl = ''
  let rpcProxyStdout = ''
  let rpcProxyStderr = ''
  let rpcProxyExitError: Error | null = null
  let controlApiMode: ControlApiMode = 'ok'
  let upstreamMode: UpstreamMode = 'ok'
  let initialized = false
  let mcpSessionId = 'sess-e2e-1'

  const allowedServersByUser = new Map<string, ServerEntry[]>()
  const allowedHostsByUser = new Map<string, HostEntry[]>()

  beforeAll(async () => {
    const controlApiPort = await getFreePort()
    const upstreamPort = await getFreePort()
    const rpcProxyPort = await getFreePort()

    const upstreamBase = `http://127.0.0.1:${upstreamPort}`
    rpcProxyBaseUrl = `http://127.0.0.1:${rpcProxyPort}`

    allowedServersByUser.set('e2e-user', [{ name: 'mongodb-server', url: `${upstreamBase}/mcp` }])
    allowedServersByUser.set('no-servers-user', [])
    allowedHostsByUser.set('e2e-user', [{ hostRef: 'agent2', url: `${upstreamBase}/host` }])
    allowedHostsByUser.set('no-hosts-user', [])

    controlApiServer = http.createServer((req, res) => {
      void (async () => {
        if (!req.url || !req.method) {
          json(res, 400, { error: 'bad request' })
          return
        }
        if (controlApiMode === 'error500') {
          json(res, 500, { error: 'control api failure' })
          return
        }
        if (req.method !== 'GET') {
          json(res, 404, { error: 'Not Found' })
          return
        }
        const serverMatch = req.url.match(/^\/api\/v1\/rpc\/access\/users\/([^/]+)\/mcp-servers/)
        if (serverMatch) {
          const userId = decodeURIComponent(serverMatch[1] || '')
          const servers = allowedServersByUser.get(userId) ?? []
          json(res, 200, {
            userId,
            contextIds: ['ctx-e2e'],
            servers,
          })
          return
        }
        const hostMatch = req.url.match(
          /^\/api\/v1\/rpc\/access\/users\/([^/]+)\/mcp-hosts\/([^/]+)/
        )
        if (hostMatch) {
          const userId = decodeURIComponent(hostMatch[1] || '')
          const hostRef = decodeURIComponent(hostMatch[2] || '')
          const hosts = allowedHostsByUser.get(userId) ?? []
          const host = hosts.find(entry => entry.hostRef === hostRef)
          if (!host) {
            json(res, 403, { error: 'Forbidden' })
            return
          }
          json(res, 200, {
            userId,
            hostRef: host.hostRef,
            url: host.url,
          })
          return
        }
        json(res, 404, { error: 'Not Found' })
      })().catch(error => {
        json(res, 500, { error: String(error) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      controlApiServer!.listen(controlApiPort, '127.0.0.1', () => resolve())
      controlApiServer!.on('error', reject)
    })

    upstreamServer = http.createServer((req, res) => {
      void (async () => {
        if (!req.url || !req.method || req.method !== 'POST') {
          json(res, 404, { error: 'Not Found' })
          return
        }
        if (req.url === '/host/v1/runtime/messages') {
          if (upstreamMode === 'hostTimeout' || upstreamMode === 'timeout') {
            return
          }
          if (upstreamMode === 'hostStatus500' || upstreamMode === 'status500') {
            json(res, 500, { error: 'forced host upstream 500' })
            return
          }
          const payload = (await readJsonBody(req)) as Record<string, unknown>
          json(res, 200, {
            accepted: true,
            hostRef: String(payload.hostRef || ''),
            taskId: 'task-e2e-1',
          })
          return
        }
        if (req.url !== '/mcp') {
          json(res, 404, { error: 'Not Found' })
          return
        }
        const payload = (await readJsonBody(req)) as {
          method?: string
          id?: string | number | null
        }
        const method = String(payload?.method || '')

        if (upstreamMode === 'timeout') {
          return
        }
        if (upstreamMode === 'status400') {
          json(res, 400, { error: 'forced upstream 400' })
          return
        }
        if (upstreamMode === 'status500') {
          json(res, 500, { error: 'forced upstream 500' })
          return
        }

        if (method === 'initialize') {
          json(
            res,
            200,
            {
              jsonrpc: '2.0',
              id: payload?.id ?? 'init',
              result: { protocolVersion: '2024-11-05' },
            },
            { 'mcp-session-id': mcpSessionId }
          )
          return
        }
        if (method === 'notifications/initialized') {
          const session = String(req.headers['mcp-session-id'] || '')
          if (session === mcpSessionId) initialized = true
          res.writeHead(202)
          res.end()
          return
        }

        const session = String(req.headers['mcp-session-id'] || '')
        if (upstreamMode === 'mongodbSessionRequired' && (!session || !initialized)) {
          json(res, 400, { jsonrpc: '2.0', error: { code: -32004, message: 'invalid request' } })
          return
        }

        const ssePayload = `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: payload?.id ?? null,
          result: { tools: [{ name: 'listCollections' }] },
        })}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(ssePayload)
      })().catch(error => {
        json(res, 500, { error: String(error) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      upstreamServer!.listen(upstreamPort, '127.0.0.1', () => resolve())
      upstreamServer!.on('error', reject)
    })

    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    const rpcProxyDir = path.resolve(__dirname, '../../../rpc-proxy')
    rpcProxyProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: rpcProxyDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        RPC_PROXY_PORT: String(rpcProxyPort),
        RPC_PROXY_CORS_ORIGIN: 'http://localhost:3000',
        RPC_PROXY_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
        RPC_PROXY_JWT_ISSUER: 'control-api',
        RPC_PROXY_JWT_AUDIENCE: 'rpc-proxy',
        RPC_PROXY_UPSTREAM_TIMEOUT_MS: '120',
        RPC_PROXY_MAX_TOKEN_LENGTH: '4096',
        RPC_PROXY_CONTROL_API_BASE_URL: `http://127.0.0.1:${controlApiPort}/api/v1`,
        RPC_PROXY_CONTROL_API_SERVICE_TOKEN: 'e2e-service-token',
        RPC_PROXY_CONTROL_API_SERVICE_NAME: 'rpc-proxy',
        RPC_PROXY_CONTROL_API_CACHE_TTL_MS: '5',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    rpcProxyStdout = ''
    rpcProxyStderr = ''
    rpcProxyExitError = null

    rpcProxyProcess.stdout?.on('data', chunk => {
      rpcProxyStdout += chunk.toString('utf8')
    })
    rpcProxyProcess.stderr?.on('data', chunk => {
      rpcProxyStderr += chunk.toString('utf8')
    })
    rpcProxyProcess.once('error', error => {
      rpcProxyExitError = new Error(`rpc-proxy process error: ${error.message}`)
    })
    rpcProxyProcess.once('exit', (code, signal) => {
      if (code === 0 && signal === null) return
      rpcProxyExitError = new Error(
        `rpc-proxy exited before startup completed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      )
    })

    const started = Date.now()
    while (Date.now() - started < 20_000) {
      if (rpcProxyExitError) {
        throw new Error(
          `${rpcProxyExitError.message}\nstdout:\n${rpcProxyStdout || '<empty>'}\nstderr:\n${rpcProxyStderr || '<empty>'}`
        )
      }
      try {
        const res = await fetch(`${rpcProxyBaseUrl}/health`)
        if (res.ok) return
      } catch {
        // wait for startup
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(
      `rpc-proxy did not start in time\nstdout:\n${rpcProxyStdout || '<empty>'}\nstderr:\n${rpcProxyStderr || '<empty>'}`
    )
  })

  afterAll(async () => {
    if (rpcProxyProcess) {
      rpcProxyProcess.kill('SIGTERM')
      rpcProxyProcess = null
    }
    await Promise.all([
      new Promise<void>(resolve =>
        controlApiServer ? controlApiServer.close(() => resolve()) : resolve()
      ),
      new Promise<void>(resolve =>
        upstreamServer ? upstreamServer.close(() => resolve()) : resolve()
      ),
    ])
  })

  it('GET /health returns 200', async () => {
    const res = await requestJson(rpcProxyBaseUrl, '/health', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('rejects missing Authorization header', async () => {
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' })
    expect(res.status).toBe(401)
  })

  it('rejects non-Bearer authorization', async () => {
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', {
      method: 'GET',
      headers: { authorization: 'Basic abc123' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects oversized bearer token', async () => {
    const tooLong = 'a'.repeat(5000)
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/servers',
      { method: 'GET' },
      tooLong
    )
    expect(res.status).toBe(401)
  })

  it('rejects malformed JWT', async () => {
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/servers',
      { method: 'GET' },
      'not-a-jwt'
    )
    expect(res.status).toBe(401)
  })

  it('rejects JWT signed by wrong private key', async () => {
    const token = signWithWrongKey()
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, token)
    expect(res.status).toBe(401)
  })

  it('rejects wrong issuer and wrong audience', async () => {
    const wrongIss = signRpcJwt({ iss: 'wrong-issuer' })
    const wrongAud = signRpcJwt({ aud: 'wrong-audience' })
    const [a, b] = await Promise.all([
      requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, wrongIss),
      requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, wrongAud),
    ])
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
  })

  it('rejects expired JWT', async () => {
    const token = signRpcJwt({ now: Math.floor(Date.now() / 1000) - 3600, expiresInSeconds: 60 })
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, token)
    expect(res.status).toBe(401)
  })

  it('rejects service token type on user endpoint', async () => {
    const token = signRpcJwt({ typ: 'service' })
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, token)
    expect(res.status).toBe(403)
  })

  it('rejects empty scopes, empty hostRefs, and wildcard hostRefs', async () => {
    const emptyScopes = signRpcJwt({ scopes: [] })
    const emptyHostRefs = signRpcJwt({ hostRefs: [] })
    const wildcardHostRefs = signRpcJwt({ hostRefs: ['*'] })

    const [a, b, c] = await Promise.all([
      requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, emptyScopes),
      requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, emptyHostRefs),
      requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, wildcardHostRefs),
    ])

    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(c.status).toBe(401)
  })

  it('enforces mcp:servers:list for GET /rpc/servers', async () => {
    const token = signRpcJwt({ scopes: ['mcp:server:invoke'] })
    const res = await requestJson(rpcProxyBaseUrl, '/api/v1/rpc/servers', { method: 'GET' }, token)
    expect(res.status).toBe(403)
  })

  it('enforces mcp:server:invoke for POST /rpc/:serverName', async () => {
    const token = signRpcJwt({ scopes: ['mcp:servers:list'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 for valid token but unauthorized server', async () => {
    const token = signRpcJwt()
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/not-allowed',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(res.status).toBe(403)
  })

  it('rejects invalid JSON-RPC payload and disallowed method patterns', async () => {
    const token = signRpcJwt()
    const invalidBody = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      { method: 'POST', body: JSON.stringify({ bad: true }) },
      token
    )
    expect(invalidBody.status).toBe(400)

    const badMethod = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools list', params: {} }),
      },
      token
    )
    expect(badMethod.status).toBe(400)
  })

  it('accepts method with slash and returns server list with valid scope', async () => {
    upstreamMode = 'ok'
    const token = signRpcJwt()

    const servers = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/servers',
      { method: 'GET' },
      token
    )
    expect(servers.status).toBe(200)
    expect(servers.body.servers).toContain('mongodb-server')

    const invoke = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(invoke.status).toBe(200)
    expect(invoke.body?.result?.tools?.[0]?.name).toBe('listCollections')
  })

  it('maps upstream 400/500 to json-rpc -32002', async () => {
    const token = signRpcJwt()
    upstreamMode = 'status400'
    const s400 = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(s400.status).toBe(200)
    expect(s400.body?.error?.code).toBe(-32002)

    upstreamMode = 'status500'
    const s500 = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(s500.status).toBe(200)
    expect(s500.body?.error?.code).toBe(-32002)
    expect(JSON.stringify(s500.body)).not.toContain(token)
  })

  it('maps upstream timeout to 504 gateway timeout', async () => {
    upstreamMode = 'timeout'
    const token = signRpcJwt()
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'Gateway Timeout' })
  })

  it('handles mongodb session bootstrap flow on generic -32004 invalid request', async () => {
    upstreamMode = 'mongodbSessionRequired'
    initialized = false
    mcpSessionId = `sess-${Date.now()}`
    const token = signRpcJwt({ jti: `sess-test-${Date.now()}` })

    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/mongodb-server',
      {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      token
    )
    expect(res.status).toBe(200)
    expect(res.body?.result?.tools?.[0]?.name).toBe('listCollections')
    expect(initialized).toBe(true)
  })

  it('surfaces control-api lookup failure as 500', async () => {
    controlApiMode = 'error500'
    try {
      const token = signRpcJwt({
        sub: `control-error-user-${Date.now()}`,
        jti: `control-error-${Date.now()}`,
      })
      const res = await requestJson(
        rpcProxyBaseUrl,
        '/api/v1/rpc/servers',
        { method: 'GET' },
        token
      )
      expect(res.status).toBe(500)
    } finally {
      controlApiMode = 'ok'
    }
  })

  it('enforces host:message:invoke for host message invoke', async () => {
    const token = signRpcJwt({ scopes: ['mcp:server:invoke'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/agent2/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(403)
  })

  it('returns 403 for valid token but unauthorized host', async () => {
    const token = signRpcJwt({ scopes: ['host:message:invoke'], hostRefs: ['agent2'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/not-allowed/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(403)
  })

  it('rejects invalid host REST payload', async () => {
    const token = signRpcJwt({ scopes: ['host:message:invoke'], hostRefs: ['agent2'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/agent2/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(400)
  })

  it('forwards host message to mcp-host with valid token', async () => {
    upstreamMode = 'ok'
    const token = signRpcJwt({ scopes: ['host:message:invoke'], hostRefs: ['agent2'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/agent2/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(200)
    expect(res.body?.accepted).toBe(true)
    expect(res.body?.hostRef).toBe('agent2')
  })

  it('maps mcp-host upstream errors safely and does not leak token', async () => {
    upstreamMode = 'hostStatus500'
    const token = signRpcJwt({ scopes: ['host:message:invoke'], hostRefs: ['agent2'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/agent2/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain(token)
    upstreamMode = 'ok'
  })

  it('maps mcp-host timeout to 504 gateway timeout', async () => {
    upstreamMode = 'hostTimeout'
    const token = signRpcJwt({ scopes: ['host:message:invoke'], hostRefs: ['agent2'] })
    const res = await requestJson(
      rpcProxyBaseUrl,
      '/api/v1/rpc/hosts/agent2/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: 'hello',
          channelType: 'rpc',
          sender: 'desktop',
        }),
      },
      token
    )
    expect(res.status).toBe(504)
    upstreamMode = 'ok'
  })
})
