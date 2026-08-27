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
import {
  type ReadinessInventoryDetail,
  resolveHostAuthoritativeFn,
  resolveProbeAuthoritativeFn,
  resolveProviderAuthoritativeFn,
  resolveReadinessDetailFn,
} from './readinessGate'
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
    () => true,
    () => true,
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
    vi.restoreAllMocks()
  })

  it('withholds readiness when no inventory-authority gate is wired', async () => {
    // The gate decides whether the provider's inventory is authoritative. A
    // caller that forgets to wire it must not get a permanently Ready server:
    // this endpoint is the contract that no stale allow is live, so the default
    // has to fail closed. There is no type error to catch the omission.
    server = new ContextMapperServer(new FakeProvider(), 0)
    server.setReady(true)

    const response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
  })

  it('serves health immediately but gates readiness and API responses until warm-up completes', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => true)

    let response = await invoke(server, '/health')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      ready: false,
    })

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

  it.each([
    ['authorization_unavailable' as const, 503],
    ['credential_unavailable' as const, 503],
    ['not_found' as const, 404],
    ['unauthorized' as const, 401],
  ])('maps credential %s failures to a token-free fail-closed response', async (code, status) => {
    const authenticator = { authenticate: () => principal } as unknown as McpApiAuthenticator
    const authorization = {
      getCredential: async () => {
        throw new McpAuthorizationError(code)
      },
    } as unknown as McpAuthorizationService
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => true,
      () => true,
      authenticator,
      authorization
    )
    server.setReady(true)

    const response = await invoke(server, '/api/v2/hosts/self/mcpservers/credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'server-a' }),
    })

    expect(response.statusCode).toBe(status)
    expect(JSON.parse(response.body)).toEqual({ error: code })
    expect(response.body).not.toContain('token')
    expect(response.headers['Cache-Control']).toBe('no-store, private')
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
      () => true,
      () => true,
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

  it('tracks provider authority dynamically after warm-up and fails API requests closed', async () => {
    let providerAuthoritative = true
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => providerAuthoritative
    )

    let response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'starting', ready: false })

    server.setReady(true)

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })

    providerAuthoritative = false

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'degraded', ready: false })

    response = await invoke(server, '/health')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      status: 'ok',
      ready: false,
    })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Context mapper provider inventory is not authoritative',
    })

    providerAuthoritative = true

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(200)
  })

  it('fails readiness closed when the provider authority check throws', async () => {
    const authorityError = new Error('authority unavailable')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => {
      throw authorityError
    })
    server.setReady(true)

    const response = await invoke(server, '/ready')

    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'degraded', ready: false })
    const readinessErrors = errorLog.mock.calls
      .map(args => {
        try {
          return JSON.parse(String(args[0])) as {
            msg?: string
            err?: { name?: string; message?: string }
          }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { msg: string; err?: { name?: string; message?: string } } =>
        Boolean(entry && entry.msg === 'provider authority readiness check failed')
      )
    expect(readinessErrors).toHaveLength(1)
    expect(readinessErrors[0].err).toEqual({
      name: authorityError.name,
      message: authorityError.message,
    })
  })

  it('withdraws readiness as soon as shutdown begins', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => true)
    server.setReady(true)

    expect((await invoke(server, '/ready')).statusCode).toBe(200)

    await server.stop()

    const response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'starting', ready: false })
  })
})

describe('ContextMapperServer desktop status authority', () => {
  let server: ContextMapperServer | null = null

  // A Host reconciler that reports a running desktop, so the only thing that can
  // withhold a 200 is the Host-authority gate under test.
  const runningReconciler = {
    getStatus: () => ({ deployed: true, ready: true, message: '' }),
    hasDesktop: () => true,
  } as unknown as ConstructorParameters<typeof ContextMapperServer>[2]
  const hasDesktopFn = () => true

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  it('serves desktop status on Host authority alone even when the provider inventory is not authoritative', async () => {
    // The heart of H1: desktop needs only Host authority. A degraded
    // McpServer/Context lane (providerAuthoritative=false) must NOT 503 desktop,
    // while /api/v1/mcpservers still 503s on the same server.
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      runningReconciler,
      hasDesktopFn,
      () => false, // provider inventory NOT authoritative
      () => true // Host inventory authoritative
    )
    server.setReady(true)

    const desktop = await invoke(server, '/api/v1/desktop/host-a')
    expect(desktop.statusCode).toBe(200)
    expect(JSON.parse(desktop.body)).toEqual({ status: 'running', hostRef: 'host-a' })

    const mcpservers = await invoke(server, '/api/v1/mcpservers')
    expect(mcpservers.statusCode).toBe(503)
  })

  it('fails desktop closed (503, never 200 inactive) when Host inventory is not authoritative', async () => {
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      runningReconciler,
      hasDesktopFn,
      () => true, // provider authoritative — must not rescue desktop
      () => false // Host inventory NOT authoritative
    )
    server.setReady(true)

    const desktop = await invoke(server, '/api/v1/desktop/host-a')
    expect(desktop.statusCode).toBe(503)
    expect(JSON.parse(desktop.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Host inventory is not authoritative',
    })
  })

  it('serves desktop status 200 in the dev wiring (no watcher), never 503 (R2-M1)', async () => {
    // Wiring regression for R2-M1: main.ts resolves both authority gates from the
    // same watcher. In dev (DevMcpServerProvider, watcher=null) the OLD wiring left
    // the Host gate undefined, so the server's fail-closed default pinned every
    // /api/v1/desktop/* at 503 after setReady(true) — where the base answered 200
    // {status:'inactive'}. Exercise the REAL resolvers with a null watcher, exactly
    // as main.ts does, so a revert to the undefined wiring turns this 200 into 503.
    const providerAuthoritativeFn = resolveProviderAuthoritativeFn(null)
    const hostAuthoritativeFn = resolveHostAuthoritativeFn(null)
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      runningReconciler,
      hasDesktopFn,
      providerAuthoritativeFn,
      hostAuthoritativeFn
    )
    server.setReady(true)

    const desktop = await invoke(server, '/api/v1/desktop/host-a')
    expect(desktop.statusCode).toBe(200)
    expect(JSON.parse(desktop.body)).toEqual({ status: 'running', hostRef: 'host-a' })
  })

  it('fails desktop closed when no Host-authority gate is wired (default)', async () => {
    // Omitting the 6th arg must default to fail-closed, exactly like the
    // provider gate — no type error catches the omission.
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      runningReconciler,
      hasDesktopFn,
      () => true
    )
    server.setReady(true)

    const desktop = await invoke(server, '/api/v1/desktop/host-a')
    expect(desktop.statusCode).toBe(503)
    expect(JSON.parse(desktop.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Host inventory is not authoritative',
    })
  })

  it('fails desktop closed when the Host authority check throws', async () => {
    const authorityError = new Error('host authority unavailable')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      runningReconciler,
      hasDesktopFn,
      () => true,
      () => {
        throw authorityError
      }
    )
    server.setReady(true)

    const desktop = await invoke(server, '/api/v1/desktop/host-a')
    expect(desktop.statusCode).toBe(503)
    expect(JSON.parse(desktop.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Host inventory is not authoritative',
    })
    const hostErrors = errorLog.mock.calls
      .map(args => {
        try {
          return JSON.parse(String(args[0])) as {
            msg?: string
            err?: { name?: string; message?: string }
          }
        } catch {
          return null
        }
      })
      .filter((entry): entry is { msg: string; err?: { name?: string; message?: string } } =>
        Boolean(entry && entry.msg === 'host authority check failed')
      )
    expect(hostErrors).toHaveLength(1)
    expect(hostErrors[0].err).toEqual({
      name: authorityError.name,
      message: authorityError.message,
    })
  })
})

describe('ContextMapperServer /ready reasons', () => {
  let server: ContextMapperServer | null = null

  const authoritativeDetail = (): ReadinessInventoryDetail => ({
    stopped: false,
    mcpServerCacheSynced: true,
    contextCacheSynced: true,
    hostCacheSynced: true,
    safetyInventoryCertified: true,
    contextRevisionAligned: true,
    serverRevisionAligned: true,
  })

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  it('adds closed-gate reasons on 503 and keeps the 200 body unchanged', async () => {
    let detail = authoritativeDetail()
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () =>
        !detail.stopped &&
        detail.mcpServerCacheSynced &&
        detail.contextCacheSynced &&
        detail.hostCacheSynced &&
        detail.safetyInventoryCertified &&
        detail.contextRevisionAligned &&
        detail.serverRevisionAligned,
      () => false,
      undefined,
      undefined,
      () => detail
    )
    server.setReady(true)

    let response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })
    expect(JSON.parse(response.body)).not.toHaveProperty('reasons')

    detail = { ...detail, mcpServerCacheSynced: false, safetyInventoryCertified: false }
    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['mcp_watch_unsynced', 'safety_pass_uncertified'],
    })
  })

  it('omits reasons when the detail fn is missing or throws', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0, undefined, undefined, () => false)
    server.setReady(true)
    let response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'degraded', ready: false })

    await server.stop()
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => false,
      () => false,
      undefined,
      undefined,
      () => {
        throw new Error('detail unavailable')
      }
    )
    server.setReady(true)
    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'degraded', ready: false })
    expect(JSON.parse(response.body)).not.toHaveProperty('reasons')
  })

  it('names controller_stopped when stopped is the only closed clause', async () => {
    const detail = { ...authoritativeDetail(), stopped: true }
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () =>
        !detail.stopped &&
        detail.mcpServerCacheSynced &&
        detail.contextCacheSynced &&
        detail.hostCacheSynced &&
        detail.safetyInventoryCertified &&
        detail.contextRevisionAligned &&
        detail.serverRevisionAligned,
      () => false,
      undefined,
      undefined,
      () => detail
    )
    server.setReady(true)

    const response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['controller_stopped'],
    })
  })

  it('emits closed reasons through the omitted-probe fallback resolve*Fn wiring', async () => {
    // A1 fallback / T10: the 10th constructor arg is omitted on purpose so
    // /ready still uses the 6-clause provider gate. Production main.ts now
    // wires resolveProbeAuthoritativeFn; that split is covered below.
    let detail = authoritativeDetail()
    const watcher = {
      isReadinessInventoryAuthoritative: () =>
        !detail.stopped &&
        detail.mcpServerCacheSynced &&
        detail.contextCacheSynced &&
        detail.hostCacheSynced &&
        detail.safetyInventoryCertified &&
        detail.contextRevisionAligned &&
        detail.serverRevisionAligned,
      getReadinessInventoryDetail: () => detail,
    }
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      resolveProviderAuthoritativeFn(watcher),
      resolveHostAuthoritativeFn(null),
      undefined,
      undefined,
      resolveReadinessDetailFn(watcher)
    )
    server.setReady(true)

    let response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })

    detail = { ...detail, safetyInventoryCertified: false }
    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['safety_pass_uncertified'],
    })
  })
})

describe('ContextMapperServer /ready probe cut (A1)', () => {
  let server: ContextMapperServer | null = null

  const authoritativeDetail = (
    overrides: Partial<ReadinessInventoryDetail> = {}
  ): ReadinessInventoryDetail => ({
    stopped: false,
    mcpServerCacheSynced: true,
    contextCacheSynced: true,
    hostCacheSynced: true,
    safetyInventoryCertified: true,
    contextRevisionAligned: true,
    serverRevisionAligned: true,
    ...overrides,
  })

  function sixClauseAuthoritative(detail: ReadinessInventoryDetail): boolean {
    return (
      !detail.stopped &&
      detail.mcpServerCacheSynced &&
      detail.contextCacheSynced &&
      detail.hostCacheSynced &&
      detail.safetyInventoryCertified &&
      detail.contextRevisionAligned &&
      detail.serverRevisionAligned
    )
  }

  function mainLikeServer(
    detailRef: { current: ReadinessInventoryDetail },
    extras: {
      authenticator?: McpApiAuthenticator
      authorization?: McpAuthorizationService
    } = {}
  ): ContextMapperServer {
    const watcher = {
      isReadinessInventoryAuthoritative: () => sixClauseAuthoritative(detailRef.current),
      isHostInventoryAuthoritative: () =>
        !detailRef.current.stopped && detailRef.current.hostCacheSynced,
      getReadinessInventoryDetail: () => detailRef.current,
    }
    return new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      resolveProviderAuthoritativeFn(watcher),
      resolveHostAuthoritativeFn(watcher),
      extras.authenticator,
      extras.authorization,
      resolveReadinessDetailFn(watcher),
      resolveProbeAuthoritativeFn(watcher)
    )
  }

  afterEach(async () => {
    await server?.stop()
    server = null
    vi.restoreAllMocks()
  })

  it('A1-T05 keeps /ready 200 when only the safety pass is uncertified', async () => {
    const detailRef = { current: authoritativeDetail({ safetyInventoryCertified: false }) }
    const authenticator = { authenticate: () => principal } as unknown as McpApiAuthenticator
    server = mainLikeServer(detailRef, {
      authenticator,
      authorization: new McpAuthorizationService(new FakeAuthorityStore()),
    })
    server.setReady(true)

    const ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(200)
    expect(JSON.parse(ready.body)).toEqual({ status: 'ready', ready: true })
    expect(JSON.parse(ready.body)).not.toHaveProperty('reasons')

    const inventory = await invoke(server, '/api/v1/mcpservers')
    expect(inventory.statusCode).toBe(503)

    const hostInventory = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(hostInventory.statusCode).toBe(503)
    expect(JSON.parse(hostInventory.body)).toEqual({ error: 'authorization_unavailable' })
  })

  it.each([
    ['serverRevisionAligned', { serverRevisionAligned: false }],
    ['contextRevisionAligned', { contextRevisionAligned: false }],
  ] as const)('A1-T06 keeps /ready 200 when only %s is false', async (_name, override) => {
    const detailRef = { current: authoritativeDetail(override) }
    const authenticator = { authenticate: () => principal } as unknown as McpApiAuthenticator
    server = mainLikeServer(detailRef, {
      authenticator,
      authorization: new McpAuthorizationService(new FakeAuthorityStore()),
    })
    server.setReady(true)

    const ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(200)
    expect(JSON.parse(ready.body)).toEqual({ status: 'ready', ready: true })
    expect(JSON.parse(ready.body)).not.toHaveProperty('reasons')

    const inventory = await invoke(server, '/api/v1/mcpservers')
    expect(inventory.statusCode).toBe(503)

    const hostInventory = await invoke(server, '/api/v2/hosts/self/mcpservers')
    expect(hostInventory.statusCode).toBe(503)
    expect(JSON.parse(hostInventory.body)).toEqual({ error: 'authorization_unavailable' })
  })

  it('A1-T07 reports only the host watch reason on /ready when phase-2 is also down', async () => {
    const detailRef = {
      current: authoritativeDetail({
        hostCacheSynced: false,
        safetyInventoryCertified: false,
      }),
    }
    server = mainLikeServer(detailRef)
    server.setReady(true)

    const ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['host_watch_unsynced'],
    })
  })

  it('A1-T08 withholds /ready while starting or stopping even if the probe gate is always true', async () => {
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => true,
      () => true,
      undefined,
      undefined,
      undefined,
      () => true
    )

    let ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({ status: 'starting', ready: false })

    server.setReady(true)
    ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(200)

    server.setReady(false)
    ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({ status: 'starting', ready: false })

    server.setReady(true)
    await server.stop()
    ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({ status: 'starting', ready: false })
  })

  it('A1-T09 fails /ready closed when the probe gate throws', async () => {
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => true,
      () => true,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error('probe authority unavailable')
      }
    )
    server.setReady(true)

    const ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({ status: 'degraded', ready: false })
  })

  it('A1-T10 keeps /ready on the 6-clause gate when the 10th argument is omitted', async () => {
    const detail = authoritativeDetail({ safetyInventoryCertified: false })
    server = new ContextMapperServer(
      new FakeProvider(),
      0,
      undefined,
      undefined,
      () => sixClauseAuthoritative(detail),
      () => false,
      undefined,
      undefined,
      () => detail
    )
    server.setReady(true)

    const ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['safety_pass_uncertified'],
    })
  })

  it('A1-T11 503s both lanes when the MCP watch is unsynced and heals both on the same instance', async () => {
    const detailRef = { current: authoritativeDetail({ mcpServerCacheSynced: false }) }
    server = mainLikeServer(detailRef)
    server.setReady(true)

    let ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(503)
    expect(JSON.parse(ready.body)).toEqual({
      status: 'degraded',
      ready: false,
      reasons: ['mcp_watch_unsynced'],
    })

    let inventory = await invoke(server, '/api/v1/mcpservers')
    expect(inventory.statusCode).toBe(503)

    detailRef.current = authoritativeDetail()
    ready = await invoke(server, '/ready')
    expect(ready.statusCode).toBe(200)
    expect(JSON.parse(ready.body)).toEqual({ status: 'ready', ready: true })

    inventory = await invoke(server, '/api/v1/mcpservers')
    expect(inventory.statusCode).toBe(200)
  })
})
