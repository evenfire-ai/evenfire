import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpManager } from '../manager'
import {
  MCP_PROXY_HOST_AUTH_CHALLENGE,
  type McpProxyHostAuthorization,
} from '../proxyAuth'
import type { McpServerInfo } from '../../types'

type Authority = {
  targetUrl: string
  ready: boolean
  enabled: boolean
  revision: string
}

type UpstreamStats = {
  connections: number
  requests: number
  bytes: number
  mcpHeaders: string[]
  headerNames: string[][]
}

type ProxyObservation = {
  serverName: string
  method: string
  hostIdentity: string
  destination: string | null
}

const PRIVATE_IDENTITY_HEADER = ['proxy', 'authorization'].join('-')
const MCP_AUTH_HEADER = ['author', 'ization'].join('')

const fixtureValue = (kind: string, suffix: string): string =>
  ['fixture', kind, suffix].join('-')

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

class InstrumentedMcpUpstream {
  readonly stats: UpstreamStats = {
    connections: 0,
    requests: 0,
    bytes: 0,
    mcpHeaders: [],
    headerNames: [],
  }

  private readonly server = createServer((request, response) => this.handle(request, response))
  private readonly transports = new Map<string, StreamableHTTPServerTransport>()
  private readonly mcpServers = new Map<string, McpServer>()

  constructor(readonly label: string) {
    this.server.on('connection', () => {
      this.stats.connections += 1
    })
  }

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('upstream did not bind')
    return `http://127.0.0.1:${address.port}/mcp`
  }

  async close(): Promise<void> {
    for (const server of this.mcpServers.values()) await server.close()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private createMcpServer(): McpServer {
    const server = new McpServer({ name: `np08-${this.label}`, version: '1.0.0' })
    server.registerTool(
      'echo',
      { description: `echo from ${this.label}` },
      async () => ({ content: [{ type: 'text' as const, text: this.label }] })
    )
    return server
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.stats.requests += 1
    const declaredBytes = Number(request.headers['content-length'] ?? 0)
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > 0) this.stats.bytes += declaredBytes
    const mcpHeader = request.headers.authorization
    if (typeof mcpHeader === 'string') this.stats.mcpHeaders.push(mcpHeader)
    this.stats.headerNames.push(Object.keys(request.headers).map(name => name.toLowerCase()).sort())

    if (request.method === 'GET' && request.headers.accept?.includes('text/event-stream')) {
      response.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'text/event-stream',
      })
      response.end('id: event-a\nevent: ready\ndata: ok\n\n')
      return
    }

    const sessionId = request.headers['mcp-session-id']
    if (typeof sessionId === 'string' && this.transports.has(sessionId)) {
      await this.transports.get(sessionId)!.handleRequest(request, response)
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const server = this.createMcpServer()
    transport.onclose = () => {
      const current = transport.sessionId
      if (current) this.transports.delete(current)
    }
    await server.connect(transport)
    await transport.handleRequest(request, response)
    if (transport.sessionId) {
      this.transports.set(transport.sessionId, transport)
      this.mcpServers.set(transport.sessionId, server)
    }
  }
}

class InstrumentedProxy {
  readonly observations: ProxyObservation[] = []
  private readonly server = createServer((request, response) => this.handle(request, response))
  private readonly authority = new Map<string, Map<string, Authority>>()
  private readonly expiredIdentities = new Set<string>()
  private readonly upstreams = new Map<string, string>()

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('proxy did not bind')
    return `http://127.0.0.1:${address.port}`
  }

  async close(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  setUpstream(serverName: string, targetUrl: string): void {
    this.upstreams.set(serverName, targetUrl)
  }

  grant(hostIdentity: string, serverName: string, authority: Authority): void {
    this.expiredIdentities.delete(hostIdentity)
    const grants = this.authority.get(hostIdentity) ?? new Map<string, Authority>()
    grants.set(serverName, authority)
    this.authority.set(hostIdentity, grants)
  }

  revoke(hostIdentity: string, serverName: string): void {
    this.authority.get(hostIdentity)?.delete(serverName)
    this.expiredIdentities.add(hostIdentity)
  }

  getGrant(hostIdentity: string, serverName: string): Authority | undefined {
    return this.authority.get(hostIdentity)?.get(serverName)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === '/events' && request.method === 'GET') {
      const hostIdentity = this.readBearer(request.headers[PRIVATE_IDENTITY_HEADER])
      if (!hostIdentity || !this.authority.has(hostIdentity)) {
        response.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE,
        })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('event: ready\\ndata: ok\\n\\n')
      return
    }

    const match = /^\/servers\/([^/]+)\/mcp$/.exec(request.url ?? '')
    if (!match || !['GET', 'POST'].includes(request.method ?? '')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    const body = await readRequestBody(request)
    const hostIdentity = this.readBearer(request.headers[PRIVATE_IDENTITY_HEADER])
    const serverName = match[1]
    const grant = hostIdentity ? this.getGrant(hostIdentity, serverName) : undefined
    this.observations.push({
      serverName,
      method: request.method ?? '',
      hostIdentity: hostIdentity ?? '',
      destination: grant?.targetUrl ?? null,
    })

    if (!hostIdentity) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE,
      })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (this.expiredIdentities.has(hostIdentity)) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': MCP_PROXY_HOST_AUTH_CHALLENGE,
      })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (!grant || !grant.ready || !grant.enabled) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'forbidden' }))
      return
    }

    const targetUrl = this.upstreams.get(serverName)
    if (!targetUrl || targetUrl !== grant.targetUrl) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unavailable' }))
      return
    }

    const upstreamHeaders = new Headers()
    for (const name of [
      MCP_AUTH_HEADER,
      'accept',
      'content-type',
      'mcp-session-id',
      'mcp-protocol-version',
      'last-event-id',
    ]) {
      const value = request.headers[name]
      if (typeof value === 'string') upstreamHeaders.set(name, value)
    }
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(targetUrl)
      const forwardedHeaders: Record<string, string> = {}
      upstreamHeaders.forEach((value, name) => {
        forwardedHeaders[name] = value
      })
      const upstreamRequest = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: request.method,
          headers: forwardedHeaders,
        },
        upstreamResponse => {
          const responseHeaders: Record<string, string> = {}
          for (const name of ['content-type', 'cache-control', 'mcp-session-id', 'mcp-protocol-version']) {
            const value = upstreamResponse.headers[name]
            if (typeof value === 'string') responseHeaders[name] = value
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
          upstreamResponse.pipe(response)
          upstreamResponse.once('end', resolve)
          upstreamResponse.once('error', reject)
        }
      )
      upstreamRequest.once('error', reject)
      upstreamRequest.end(body)
    })
  }

  private readBearer(value: string | string[] | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const match = /^Bearer ([^\s,]+)$/.exec(value)
    return match?.[1]
  }
}

function serverInfo(name: 'server-a' | 'server-b', proxyUrl: string): McpServerInfo {
  return {
    name,
    contextRef: name === 'server-a' ? 'context-a' : 'context-b',
    transport: { type: 'streamableHttp', url: `${proxyUrl}/servers/${name}/mcp` },
    enabled: true,
    authRequired: true,
    status: { deployed: true, ready: true, authoritative: true },
  }
}

function rotatingHostIdentity(initial: string): McpProxyHostAuthorization & {
  setHostIdentity(value: string): void
  refreshCount: number
} {
  let current = initial
  let refreshCount = 0
  return {
    getAccessToken: () => current,
    refreshOnUnauthorized: async () => {
      refreshCount += 1
      current = 'host-a-rotated'
    },
    setHostIdentity: value => {
      current = value
    },
    get refreshCount() {
      return refreshCount
    },
  }
}

describe('NP-08 real mcp-host manager/SDK proxy journey', () => {
  let upstreamA: InstrumentedMcpUpstream
  let upstreamB: InstrumentedMcpUpstream
  let proxy: InstrumentedProxy
  let targetA: string
  let targetB: string
  let proxyUrl: string

  beforeAll(async () => {
    upstreamA = new InstrumentedMcpUpstream('a')
    upstreamB = new InstrumentedMcpUpstream('b')
    targetA = await upstreamA.start()
    targetB = await upstreamB.start()
    proxy = new InstrumentedProxy()
    proxyUrl = await proxy.start()
    proxy.setUpstream('server-a', targetA)
    proxy.setUpstream('server-b', targetB)
  })

  afterAll(async () => {
    await proxy.close()
    await upstreamA.close()
    await upstreamB.close()
  })

  it('keeps Host authority, MCP credentials, live revisions, rotation, and denies on the real SDK path', async () => {
    const hostA = rotatingHostIdentity('host-a')
    const hostB = rotatingHostIdentity('host-b')
    const mcpA = fixtureValue('mcp-auth', 'a')
    const mcpB = fixtureValue('mcp-auth', 'b')
    proxy.grant('host-a', 'server-a', {
      targetUrl: targetA,
      ready: true,
      enabled: true,
      revision: 'a-1',
    })
    proxy.grant('host-b', 'server-b', {
      targetUrl: targetB,
      ready: true,
      enabled: true,
      revision: 'b-1',
    })

    const managerA = new McpManager(proxyUrl, undefined, hostA)
    const managerB = new McpManager(proxyUrl, undefined, hostB)
    try {
      await managerA.addServer(serverInfo('server-a', proxyUrl), mcpA)
      await managerB.addServer(serverInfo('server-b', proxyUrl), mcpB)
      expect(managerA.getConnectedServers()).toEqual(['server-a'])
      expect(managerB.getConnectedServers()).toEqual(['server-b'])

      const positiveA = await managerA.callTool('server-a__echo', {})
      const positiveB = await managerB.callTool('server-b__echo', {})
      expect(positiveA.isError).toBe(false)
      expect(positiveB.isError).toBe(false)

      const beforeCrossA = { ...upstreamA.stats }
      const beforeCrossB = { ...upstreamB.stats }
      await expect(managerA.addServer(serverInfo('server-b', proxyUrl), mcpB)).rejects.toThrow()
      await expect(managerB.addServer(serverInfo('server-a', proxyUrl), mcpA)).rejects.toThrow()
      expect(upstreamA.stats.connections).toBe(beforeCrossA.connections)
      expect(upstreamA.stats.requests).toBe(beforeCrossA.requests)
      expect(upstreamA.stats.bytes).toBe(beforeCrossA.bytes)
      expect(upstreamB.stats.connections).toBe(beforeCrossB.connections)
      expect(upstreamB.stats.requests).toBe(beforeCrossB.requests)
      expect(upstreamB.stats.bytes).toBe(beforeCrossB.bytes)

      const hostAGrant = proxy.getGrant('host-a', 'server-a')!
      hostAGrant.ready = false
      hostAGrant.revision = 'a-revoked'
      const beforeRevoked = { ...upstreamA.stats }
      const revoked = await managerA.callTool('server-a__echo', {})
      expect(revoked.isError).toBe(true)
      expect(upstreamA.stats.connections).toBe(beforeRevoked.connections)
      expect(upstreamA.stats.requests).toBe(beforeRevoked.requests)
      expect(upstreamA.stats.bytes).toBe(beforeRevoked.bytes)

      hostAGrant.ready = true
      hostAGrant.targetUrl = targetB
      hostAGrant.revision = 'a-moved-live'
      proxy.setUpstream('server-a', targetB)
      const moved = await managerA.callTool('server-a__echo', {})
      expect(moved.isError).toBe(false)
      expect(proxy.observations.at(-1)?.destination).toBe(targetB)

      proxy.revoke('host-a', 'server-a')
      proxy.grant('host-a-rotated', 'server-a', {
        targetUrl: targetB,
        ready: true,
        enabled: true,
        revision: 'a-rotated',
      })
      const refreshed = await managerA.callTool('server-a__echo', {})
      expect(refreshed.isError).toBe(false)
      expect(hostA.refreshCount).toBe(1)
      expect(proxy.observations.at(-1)?.hostIdentity).toBe('host-a-rotated')

      const clientA = (managerA as unknown as { clients: Map<string, unknown> }).clients.get('server-a') as {
        reconnect(): Promise<void>
        transport: { resumeStream(lastEventId: string): Promise<void> }
      }
      await clientA.reconnect()
      expect(proxy.observations.at(-1)?.method).toBe('POST')
      expect(proxy.observations.at(-1)?.hostIdentity).toBe('host-a-rotated')

      await clientA.transport.resumeStream('event-a')
      expect(proxy.observations.at(-1)?.method).toBe('GET')
      expect(proxy.observations.at(-1)?.hostIdentity).toBe('host-a-rotated')

      const upstreamNames = new Set([
        'accept',
        'authorization',
        'connection',
        'content-length',
        'content-type',
        'host',
        'mcp-protocol-version',
        'mcp-session-id',
        'last-event-id',
        'user-agent',
      ])
      for (const names of [...upstreamA.stats.headerNames, ...upstreamB.stats.headerNames]) {
        expect(names.filter(name => !upstreamNames.has(name))).toEqual([])
        expect(names).not.toContain(PRIVATE_IDENTITY_HEADER)
      }
      expect(
        [...upstreamA.stats.mcpHeaders, ...upstreamB.stats.mcpHeaders].every(
          value => value === `Bearer ${mcpA}` || value === `Bearer ${mcpB}`
        )
      ).toBe(true)
    } finally {
      await managerA.close()
      await managerB.close()
    }
  })
})
