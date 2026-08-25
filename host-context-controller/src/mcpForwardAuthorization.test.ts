import { describe, expect, it, vi } from 'vitest'
import {
  McpAuthorizationError,
  McpAuthorizationService,
  type AuthorityContext,
  type AuthorityHost,
  type AuthorityMcpServer,
  type McpAuthorizationStore,
} from './mcpAuthorization'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'

const principal = (hostName: string, hostUid: string): VerifiedMcpHostPrincipal => ({
  subject: 'mcp-host/standalone',
  hostName,
  hostUid,
  namespace: 'mcp-host',
  jti: `jti-${hostName}`,
  issuedAt: 100,
  expiresAt: 400,
  audiences: ['host-context-controller'],
})

const metadata = (uid: string, resourceVersion: string, generation = 1) => ({
  uid,
  resourceVersion,
  generation,
})

function host(name: string, uid: string, contextRef: string): AuthorityHost {
  return {
    name,
    namespace: 'mcp-host',
    metadata: metadata(`host-uid-${uid}`, '1'),
    contextRef,
  }
}

function context(name: string, servers: string[]): AuthorityContext {
  return {
    name,
    namespace: 'mcp-server',
    metadata: metadata(`context-uid-${name}`, '1'),
    mcpServers: servers,
  }
}

function server(name: string, contextName: string): AuthorityMcpServer {
  return {
    name,
    namespace: 'mcp-server',
    metadata: metadata(`server-uid-${name}`, '1'),
    contextRef: contextName,
    transport: {
      type: 'streamableHttp',
      url: `http://${name}.mcp-server.svc.cluster.local:3000/mcp`,
    },
    enabled: true,
    status: { deployed: true, ready: true, authoritative: true },
  }
}

function makeStore(
  hosts: Record<string, AuthorityHost>,
  contexts: Record<string, AuthorityContext>,
  servers: Record<string, AuthorityMcpServer>
): McpAuthorizationStore {
  return {
    readHost: vi.fn(async name => hosts[name] ?? null),
    readContext: vi.fn(async name => contexts[name] ?? null),
    readMcpServer: vi.fn(async name => servers[name] ?? null),
    readSecretMetadata: vi.fn(async () => null),
    readSecret: vi.fn(async () => null),
  }
}

describe('McpAuthorizationService live forwarding', () => {
  it('allows only the current live Host -> Context -> McpServer binding without Secret reads', async () => {
    const servers = {
      'server-a': server('server-a', 'context-a'),
      'server-b': server('server-b', 'context-b'),
    }
    const store = makeStore(
      {
        'host-a': host('host-a', 'a', 'context-a'),
        'host-b': host('host-b', 'b', 'context-b'),
      },
      {
        'context-a': context('context-a', ['server-a']),
        'context-b': context('context-b', ['server-b']),
      },
      servers
    )
    const service = new McpAuthorizationService(store, () => 200)

    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).resolves.toMatchObject({
      serverName: 'server-a',
      contextRef: 'context-a',
      destinationRevision: expect.any(String),
    })
    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-b')
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      service.getLiveForwardTarget(principal('host-b', 'host-uid-b'), 'server-a')
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.readSecretMetadata).not.toHaveBeenCalled()
    expect(store.readSecret).not.toHaveBeenCalled()
  })

  it('projects managed stdio to the internal Streamable HTTP bridge', async () => {
    const managedStdio = server('server-a', 'context-a')
    managedStdio.transport = { type: 'stdio', port: 3000 }
    managedStdio.managed = true
    const store = makeStore(
      { 'host-a': host('host-a', 'a', 'context-a') },
      { 'context-a': context('context-a', ['server-a']) },
      { 'server-a': managedStdio }
    )
    const service = new McpAuthorizationService(store, () => 200)

    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).resolves.toMatchObject({
      targetUrl: 'http://server-a.mcp-server.svc.cluster.local:3000/mcp',
    })
  })

  it.each([
    ['a destination bound to another McpServer', 'http://server-b.mcp-server.svc.cluster.local:3000/mcp'],
    ['a destination with the wrong port', 'http://server-a.mcp-server.svc.cluster.local:3001/mcp'],
  ])('denies %s before returning a live forwarding grant', async (_label, targetUrl) => {
    const serverA = server('server-a', 'context-a')
    serverA.transport = { type: 'streamableHttp', url: targetUrl }
    const store = makeStore(
      { 'host-a': host('host-a', 'a', 'context-a') },
      { 'context-a': context('context-a', ['server-a']) },
      { 'server-a': serverA }
    )
    const service = new McpAuthorizationService(store, () => 200)

    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('denies an McpServer whose live contextRef disagrees with Context membership', async () => {
    const store = makeStore(
      { 'host-a': host('host-a', 'a', 'context-a') },
      { 'context-a': context('context-a', ['server-a']) },
      { 'server-a': server('server-a', 'context-b') }
    )
    const service = new McpAuthorizationService(store, () => 200)

    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('fails closed when readiness or authority is not live', async () => {
    const notReady = server('server-a', 'context-a')
    notReady.status.ready = false
    const store = makeStore(
      { 'host-a': host('host-a', 'a', 'context-a') },
      { 'context-a': context('context-a', ['server-a']) },
      { 'server-a': notReady }
    )
    const service = new McpAuthorizationService(store, () => 200)
    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).rejects.toMatchObject({
      code: 'not_found',
    })

    notReady.status.ready = true
    notReady.status.authoritative = false
    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('revalidates live identity before returning a destination', async () => {
    const first = server('server-a', 'context-a')
    const replaced = {
      ...server('server-a', 'context-b'),
      metadata: metadata('server-uid-replaced', '2', 2),
    }
    const store = makeStore(
      { 'host-a': host('host-a', 'a', 'context-a') },
      {
        'context-a': context('context-a', ['server-a']),
        'context-b': context('context-b', ['server-a']),
      },
      { 'server-a': first }
    )
    const readServer = vi
      .spyOn(store, 'readMcpServer')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replaced)
    const service = new McpAuthorizationService(store, () => 200)

    await expect(
      service.getLiveForwardTarget(principal('host-a', 'host-uid-a'), 'server-a')
    ).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(readServer).toHaveBeenCalledTimes(2)
  })
})
