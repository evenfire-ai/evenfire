import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { McpServerProvider } from './k8sClient'
import { McpApiAuthenticator, type VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import {
  type AuthorityContext,
  type AuthorityHost,
  type AuthorityMcpServer,
  type AuthoritySecret,
  McpAuthorizationError,
  McpAuthorizationService,
  type McpAuthorizationStore,
} from './mcpAuthorization'
import { resolveHostAuthoritativeFn, resolveProviderAuthoritativeFn } from './readinessGate'
import { ContextMapperServer, McpHostApiRateLimiter } from './server'
import type { McpServerInfo } from './types'

class FakeProvider implements McpServerProvider {
  constructor(private readonly infos: McpServerInfo[] = []) {}

  getAllServers() {
    return []
  }

  getAllServerInfos() {
    return this.infos
  }

  async getServerInfosByContext() {
    return []
  }

  onChange() {}

  async start() {}

  async stop() {}
}

class MockResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  headersSent = false

  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status
    this.headersSent = true
    if (headers) Object.assign(this.headers, headers)
  }

  end(chunk?: string): void {
    if (chunk) this.body += chunk
  }
}

async function invoke(
  server: ContextMapperServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
) {
  const headers = options.headers ?? {}
  const req = Readable.from(options.body === undefined ? [] : [options.body])
  Object.assign(req, {
    method: options.method ?? 'GET',
    url: path,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
  })
  const res = new MockResponse()
  await (
    server as unknown as {
      handleRequest: (req: Readable, res: MockResponse) => Promise<void>
    }
  ).handleRequest(req, res)
  return res
}

const principal: VerifiedMcpHostPrincipal = {
  subject: 'mcp-host/standalone',
  hostName: 'host-a',
  hostUid: 'host-uid-a',
  namespace: 'mcp-host',
  jti: 'jti-a',
  issuedAt: 1,
  expiresAt: 4_000_000_000,
  audiences: ['host-context-controller'],
}

class FakeAuthorityStore implements McpAuthorizationStore {
  secretValueReads = 0
  private readonly host: AuthorityHost = {
    name: 'host-a',
    namespace: 'mcp-host',
    metadata: { uid: 'host-uid-a', resourceVersion: '1' },
    contextRef: 'context-a',
  }
  private readonly context: AuthorityContext = {
    name: 'context-a',
    namespace: 'mcp-server',
    metadata: { uid: 'context-uid-a', resourceVersion: '2' },
    mcpServers: ['server-a'],
  }
  private readonly mcpServer: AuthorityMcpServer = {
    name: 'server-a',
    namespace: 'mcp-server',
    metadata: { uid: 'server-uid-a', resourceVersion: '3' },
    transport: { type: 'streamableHttp', url: 'http://server-a/mcp' },
    auth: { type: 'bearer', secretRef: 'server-a-auth', secretKey: 'token' },
    enabled: true,
    status: { deployed: true, ready: true },
  }
  private readonly secret: AuthoritySecret = {
    name: 'server-a-auth',
    namespace: 'mcp-server',
    metadata: { uid: 'secret-uid-a', resourceVersion: '4' },
    data: { token: Buffer.from('credential-value').toString('base64') },
  }

  async readHost() {
    return this.host
  }

  async readContext() {
    return this.context
  }

  async readMcpServer() {
    return this.mcpServer
  }

  async readSecretMetadata() {
    return {
      name: this.secret.name,
      namespace: this.secret.namespace,
      metadata: this.secret.metadata,
    }
  }

  async readSecret() {
    this.secretValueReads += 1
    return this.secret
  }
}

function protectedServer(store = new FakeAuthorityStore()): {
  server: ContextMapperServer
  store: FakeAuthorityStore
} {
  const authenticator = { authenticate: () => principal } as unknown as McpApiAuthenticator
  const server = new ContextMapperServer(
    new FakeProvider(),
    0,
    undefined,
    undefined,
    authenticator,
    new McpAuthorizationService(store)
  )
  server.setReady(true)
  return { server, store }
}

describe('ContextMapperServer', () => {
  let server: ContextMapperServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('serves health immediately but gates readiness and API responses until warm-up completes', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0)

    let response = await invoke(server, '/health')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', ready: false })

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(503)

    server.setReady(true)
    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ servers: [], contextRef: '*' })
  })

  it('keeps the temporary global v1 inventory metadata-only and non-cacheable', async () => {
    server = new ContextMapperServer(
      new FakeProvider([
        {
          name: 'server-a',
          description: 'must not be exposed by the legacy system inventory',
          contextRef: 'context-a',
          transport: {
            type: 'streamableHttp',
            url: 'http://server-a/mcp',
            secretRef: 'nested-secret-must-not-leak',
          } as McpServerInfo['transport'],
          auth: { type: 'bearer', secretRef: 'server-a-auth', secretKey: 'token' },
          enabled: true,
          status: { deployed: true, ready: true, message: 'internal status detail' },
        },
      ]),
      0,
      undefined,
      undefined,
      () => true
    )
    server.setReady(true)

    const response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(200)
    expect(response.headers['Cache-Control']).toBe('no-store, private')
    expect(JSON.parse(response.body).servers[0]).not.toHaveProperty('auth')
    expect(JSON.parse(response.body).servers[0]).not.toHaveProperty('description')
    expect(response.body).not.toContain('secretRef')
    expect(response.body).not.toContain('secretKey')
    expect(response.body).not.toContain('nested-secret-must-not-leak')
    expect(response.body).not.toContain('internal status detail')
  })

  it.each(['/api/v1/mcpservers/context/context-a', '/api/v1/mcpservers/server-a/auth'])(
    'returns an application-level 410 tombstone for legacy route %s',
    async path => {
      server = new ContextMapperServer(new FakeProvider(), 0)
      server.setReady(true)
      const response = await invoke(server, path)
      expect(response.statusCode).toBe(410)
      expect(JSON.parse(response.body)).toEqual({ error: 'gone' })
      expect(response.headers['Cache-Control']).toBe('no-store, private')
    }
  )

  it('tombstones legacy Host-selected routes for every method before readiness and CORS', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => true)

    for (const [path, method] of [
      ['/api/v1/mcpservers/context/context-a', 'OPTIONS'],
      ['/api/v1/mcpservers/server-a/auth', 'POST'],
    ] as const) {
      const response = await invoke(server, path, { method })
      expect(response.statusCode).toBe(410)
      expect(JSON.parse(response.body)).toEqual({ error: 'gone' })
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
      expect(response.headers['Cache-Control']).toBe('no-store, private')
    }
  })

  it('serves scoped v2 inventory without wildcard browser CORS or Secret values', async () => {
    const protectedRoute = protectedServer()
    server = protectedRoute.server
    const response = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(response.statusCode).toBe(200)
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(response.headers['Cache-Control']).toBe('no-store, private')
    const body = JSON.parse(response.body)
    expect(body.servers).toEqual([
      expect.objectContaining({ name: 'server-a', authRequired: true }),
    ])
    expect(response.body).not.toContain('context-a')
    expect(response.body).not.toContain('server-a-auth')
    expect(response.body).not.toContain('credential-value')
    expect(protectedRoute.store.secretValueReads).toBe(0)
  })

  it('keeps direct protected-route startup and not-found errors generic and non-cacheable', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => true)

    let response = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ error: 'authorization_unavailable' })
    expect(response.headers['Cache-Control']).toBe('no-store, private')

    server.setReady(true)
    response = await invoke(server, '/api/v2/hosts/self/mcpservers/unknown')
    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: 'not_found' })
    expect(response.headers['Cache-Control']).toBe('no-store, private')
  })

  it('accepts only the exact credential body and returns the fenced token DTO', async () => {
    const protectedRoute = protectedServer()
    server = protectedRoute.server
    const response = await invoke(server, '/api/v2/hosts/self/mcpservers/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'server-a' }),
    })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      token: 'credential-value',
      credentialRevision: expect.any(String),
    })
    expect(protectedRoute.store.secretValueReads).toBe(1)

    const invalid = await invoke(server, '/api/v2/hosts/self/mcpservers/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'server-a', contextRef: 'context-b' }),
    })
    expect(invalid.statusCode).toBe(400)
    expect(protectedRoute.store.secretValueReads).toBe(1)
  })

  it('normalizes protected route method, media-type, and body-limit failures without a Secret read', async () => {
    const protectedRoute = protectedServer()
    server = protectedRoute.server

    let response = await invoke(server, '/api/v2/hosts/self/mcpservers', { method: 'POST' })
    expect(response.statusCode).toBe(405)
    expect(JSON.parse(response.body)).toEqual({ error: 'method_not_allowed' })
    expect(response.headers.Allow).toBe('GET')

    response = await invoke(server, '/api/v2/hosts/self/mcpservers/credential', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(response.statusCode).toBe(415)
    expect(JSON.parse(response.body)).toEqual({ error: 'unsupported_media_type' })

    response = await invoke(server, '/api/v2/hosts/self/mcpservers/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'a'.repeat(1_025) }),
    })
    expect(response.statusCode).toBe(413)
    expect(JSON.parse(response.body)).toEqual({ error: 'payload_too_large' })
    expect(response.headers['Cache-Control']).toBe('no-store, private')
    expect(protectedRoute.store.secretValueReads).toBe(0)
  })

  it('fails closed when the protected Host verifier is not configured', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0)
    server.setReady(true)

    const response = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ error: 'authorization_unavailable' })
    expect(response.headers['Cache-Control']).toBe('no-store, private')
  })

  it('maps a rebound Host identity to a generic non-cacheable 401', async () => {
    const authenticator = { authenticate: () => principal } as unknown as McpApiAuthenticator
    const authorization = {
      listServers: async () => {
        throw new McpAuthorizationError('unauthorized')
      },
    } as unknown as McpAuthorizationService
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      authenticator,
      authorization
    )
    server.setReady(true)

    const response = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(response.statusCode).toBe(401)
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' })
    expect(response.headers['WWW-Authenticate']).toBe('Bearer realm="host-context-controller"')
    expect(response.headers['Cache-Control']).toBe('no-store, private')
    expect(response.headers.Pragma).toBe('no-cache')
  })
})

describe('McpHostApiRateLimiter', () => {
  let server: ContextMapperServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  it('limits each signed Host identity/action independently and resets after one minute', () => {
    let now = 1_000
    const limiter = new McpHostApiRateLimiter(1, () => now)
    expect(limiter.consume('host-uid-a', 'credential')).toEqual({ allowed: true })
    expect(limiter.consume('host-uid-a', 'inventory')).toEqual({ allowed: true })
    expect(limiter.consume('host-uid-b', 'credential')).toEqual({ allowed: true })
    expect(limiter.consume('host-uid-a', 'credential')).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    })
    now += 60_000
    expect(limiter.consume('host-uid-a', 'credential')).toEqual({ allowed: true })
  })
})
