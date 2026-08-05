import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerProvider } from './k8sClient'
import { ContextMapperServer } from './server'

class FakeProvider implements McpServerProvider {
  getAllServers() {
    return []
  }

  getAllServerInfos() {
    return []
  }

  async getServerInfosByContext() {
    return []
  }

  async getAuthToken() {
    return undefined
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
    if (headers) {
      Object.assign(this.headers, headers)
    }
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk
    }
  }
}

async function invoke(server: ContextMapperServer, path: string) {
  const req = {
    method: 'GET',
    url: path,
    headers: {},
  }
  const res = new MockResponse()
  await (
    server as unknown as {
      handleRequest: (
        req: { method: string; url: string; headers: Record<string, string> },
        res: MockResponse
      ) => Promise<void>
    }
  ).handleRequest(req, res)
  return res
}

describe('ContextMapperServer readiness', () => {
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
    expect(JSON.parse(response.body)).toEqual({ status: 'starting', ready: false })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Context mapper is still starting',
    })

    server.setReady(true)

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      servers: [],
      contextRef: '*',
    })
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
    expect(errorLog).toHaveBeenCalledWith(
      '[Server] Provider authority readiness check failed:',
      authorityError
    )
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
})
