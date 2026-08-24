import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { McpServerProvider } from './k8sClient'
import type { LiveForwardTarget, SystemMcpServerInfo } from './mcpAuthorization'
import { McpAuthorizationError, type McpAuthorizationService } from './mcpAuthorization'
import type { McpProxyAuthenticator, VerifiedMcpProxySystemPrincipal } from './mcpProxyAuthentication'
import { ContextMapperServer, McpHostApiRateLimiter } from './server'
import type { McpServerInfo } from './types'

class Provider implements McpServerProvider {
  getAllServers() {
    return []
  }

  getAllServerInfos(): McpServerInfo[] {
    return []
  }

  async getServerInfosByContext() {
    return []
  }

  onChange() {}
  async start() {}
  async stop() {}
}

class Response {
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

  end(body?: string): void {
    if (body) this.body += body
  }
}

async function invoke(
  server: ContextMapperServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
  const headers = options.headers ?? {}
  const request = Readable.from(options.body === undefined ? [] : [options.body])
  Object.assign(request, {
    method: options.method ?? 'GET',
    url: path,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
  })
  const response = new Response()
  await (
    server as unknown as {
      handleRequest(request: Readable, response: Response): Promise<void>
    }
  ).handleRequest(request, response)
  return response
}

const systemPrincipal: VerifiedMcpProxySystemPrincipal = {
  authType: 'system',
  subject: 'system:serviceaccount:mcp-server:mcp-proxy',
  uid: 'sa-uid',
  audiences: ['host-context-controller'],
}

const directory: SystemMcpServerInfo[] = [
  {
    name: 'server-a',
    contextRef: 'context-a',
    transport: {
      type: 'streamableHttp',
      url: 'http://server-a.mcp-server.svc.cluster.local:3000/mcp',
    },
    enabled: true,
    status: { deployed: true, ready: true, authoritative: true },
    destinationRevision: 'revision-a',
  },
]

const target: LiveForwardTarget = {
  serverName: 'server-a',
  contextRef: 'context-a',
  targetUrl: 'http://server-a.mcp-server.svc.cluster.local:3000/mcp',
  destinationRevision: 'revision-a',
}

function makeServer(authorization: Partial<McpAuthorizationService> = {}): ContextMapperServer {
  const systemAuthenticator: McpProxyAuthenticator = {
    authenticateSystem: vi.fn(async () => systemPrincipal),
    authenticateHost: vi.fn(() => ({
      subject: 'mcp-host/standalone',
      hostName: 'host-a',
      hostUid: 'host-uid-a',
      namespace: 'mcp-host',
      jti: 'host-jti',
      issuedAt: 1,
      expiresAt: 4_000_000_000,
      audiences: ['host-context-controller'],
    })),
  } as unknown as McpProxyAuthenticator
  return new ContextMapperServer(
    new Provider(),
    0,
    undefined,
    undefined,
    () => true,
    () => true,
    undefined,
    authorization as McpAuthorizationService,
    systemAuthenticator
  )
}

describe('ContextMapperServer system MCP proxy routes', () => {
  let server: ContextMapperServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('serves a system-authenticated metadata-only directory', async () => {
    const authorization = {
      listSystemServers: vi.fn(async () => directory),
    }
    server = makeServer(authorization)
    server.setReady(true)

    const response = await invoke(server, '/api/v2/system/mcpservers', {
      headers: { authorization: 'fixture-system' },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ schemaVersion: 1, servers: directory })
    expect(response.body).not.toContain('secret')
    expect(response.headers['Cache-Control']).toBe('no-store, private')
  })

  it('authorizes a live Host target with separate system and Host headers', async () => {
    const authorization = {
      getLiveForwardTarget: vi.fn(async () => target),
    }
    server = makeServer(authorization)
    server.setReady(true)

    const response = await invoke(server, '/api/v2/system/mcpservers/authorize', {
      method: 'POST',
      headers: {
        authorization: 'fixture-system',
        'x-clerum-host-authorization': 'fixture-host',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ serverName: 'server-a' }),
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      schemaVersion: 1,
      serverName: target.serverName,
      targetUrl: target.targetUrl,
      destinationRevision: target.destinationRevision,
    })
    expect(authorization.getLiveForwardTarget).toHaveBeenCalledWith(
      expect.objectContaining({ hostName: 'host-a' }),
      'server-a'
    )
  })

  it('limits the live authorize decision per authenticated Host before the target read', async () => {
    const authorization = {
      getLiveForwardTarget: vi.fn(async () => target),
    }
    server = makeServer(authorization)
    ;(server as unknown as { mcpRateLimiter: McpHostApiRateLimiter }).mcpRateLimiter =
      new McpHostApiRateLimiter(1)
    server.setReady(true)
    const request = {
      method: 'POST' as const,
      headers: {
        authorization: 'fixture-system',
        'x-clerum-host-authorization': 'fixture-host',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ serverName: 'server-a' }),
    }

    const first = await invoke(server, '/api/v2/system/mcpservers/authorize', request)
    const second = await invoke(server, '/api/v2/system/mcpservers/authorize', request)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(429)
    expect(authorization.getLiveForwardTarget).toHaveBeenCalledOnce()
  })

  it('maps cross-context and unavailable target results to opaque 403/503 responses', async () => {
    const denied = {
      getLiveForwardTarget: vi.fn(async () => {
        throw new McpAuthorizationError('not_found')
      }),
    }
    server = makeServer(denied)
    server.setReady(true)
    const request = {
      method: 'POST' as const,
      headers: {
        authorization: 'fixture-system',
        'x-clerum-host-authorization': 'fixture-host',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ serverName: 'server-b' }),
    }
    let response = await invoke(server, '/api/v2/system/mcpservers/authorize', request)
    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ error: 'forbidden' })

    const unavailable = {
      getLiveForwardTarget: vi.fn(async () => {
        throw new McpAuthorizationError('authorization_unavailable')
      }),
    }
    server = makeServer(unavailable)
    server.setReady(true)
    response = await invoke(server, '/api/v2/system/mcpservers/authorize', request)
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ error: 'authorization_unavailable' })
  })
})
