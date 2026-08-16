import { describe, expect, it } from 'vitest'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import {
  type AuthorityContext,
  type AuthorityHost,
  type AuthorityMcpServer,
  type AuthoritySecret,
  McpAuthorizationService,
  type McpAuthorizationStore,
  toPublicMcpTransport,
} from './mcpAuthorization'

const meta = (uid: string, resourceVersion: string) => ({ uid, resourceVersion })
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
const principalB: VerifiedMcpHostPrincipal = {
  ...principal,
  subject: 'mcp-host/standalone-b',
  hostName: 'host-b',
  hostUid: 'host-uid-b',
  jti: 'jti-b',
}
const host: AuthorityHost = {
  name: 'host-a',
  namespace: 'mcp-host',
  metadata: meta('host-uid-a', '10'),
  contextRef: 'context-a',
}
const context: AuthorityContext = {
  name: 'context-a',
  namespace: 'mcp-server',
  metadata: meta('context-uid-a', '20'),
  mcpServers: ['server-a'],
}
const contextB: AuthorityContext = {
  name: 'context-b',
  namespace: 'mcp-server',
  metadata: meta('context-uid-b', '21'),
  mcpServers: ['server-b'],
}
const server: AuthorityMcpServer = {
  name: 'server-a',
  namespace: 'mcp-server',
  metadata: meta('server-uid-a', '30'),
  transport: { type: 'streamableHttp', url: 'http://server-a/mcp' },
  auth: { type: 'bearer', secretRef: 'server-a-auth', secretKey: 'token' },
  enabled: true,
  status: { deployed: true, ready: true, authoritative: false },
}
const serverB: AuthorityMcpServer = {
  ...server,
  name: 'server-b',
  metadata: meta('server-uid-b', '31'),
  transport: { type: 'streamableHttp', url: 'http://server-b/mcp' },
  auth: { type: 'bearer', secretRef: 'server-b-auth', secretKey: 'token' },
}
const secret: AuthoritySecret = {
  name: 'server-a-auth',
  namespace: 'mcp-server',
  metadata: meta('secret-uid-a', '40'),
  data: { token: Buffer.from('credential-value').toString('base64') },
}

class FakeStore implements McpAuthorizationStore {
  secretMetadataReads = 0
  secretValueReads = 0
  secretMetadataSequence: Array<AuthoritySecret | null> = [secret]
  secretSequence: Array<AuthoritySecret | null> = [secret]
  hostSequence: Array<AuthorityHost | null> | null = null
  contextSequence: Array<AuthorityContext | null> | null = null
  serverSequence: Array<AuthorityMcpServer | null> | null = null
  hostReads = 0
  contextReads = 0
  serverReads = 0
  hostObject: AuthorityHost | null = host
  contextObject: AuthorityContext | null = context
  serverObject: AuthorityMcpServer | null = server

  async readHost() {
    this.hostReads += 1
    return this.hostSequence
      ? this.hostSequence[Math.min(this.hostReads - 1, this.hostSequence.length - 1)]
      : this.hostObject
  }
  async readContext() {
    this.contextReads += 1
    return this.contextSequence
      ? this.contextSequence[Math.min(this.contextReads - 1, this.contextSequence.length - 1)]
      : this.contextObject
  }
  async readMcpServer() {
    this.serverReads += 1
    return this.serverSequence
      ? this.serverSequence[Math.min(this.serverReads - 1, this.serverSequence.length - 1)]
      : this.serverObject
  }
  async readSecretMetadata() {
    this.secretMetadataReads += 1
    const value =
      this.secretMetadataSequence[
        Math.min(this.secretMetadataReads - 1, this.secretMetadataSequence.length - 1)
      ]
    return value ? { name: value.name, namespace: value.namespace, metadata: value.metadata } : null
  }
  async readSecret() {
    this.secretValueReads += 1
    return this.secretSequence[Math.min(this.secretValueReads - 1, this.secretSequence.length - 1)]
  }
}

describe('McpAuthorizationService', () => {
  it('keeps two Host/Context grant sets disjoint in both directions', async () => {
    const storeA = new FakeStore()
    const storeB = new FakeStore()
    storeB.hostObject = {
      name: 'host-b',
      namespace: 'mcp-host',
      metadata: meta('host-uid-b', '11'),
      contextRef: 'context-b',
    }
    storeB.contextObject = contextB
    storeB.serverObject = serverB
    storeB.secretMetadataSequence = [
      {
        name: 'server-b-auth',
        namespace: 'mcp-server',
        metadata: meta('secret-uid-b', '41'),
      },
    ]
    storeB.secretSequence = [
      {
        name: 'server-b-auth',
        namespace: 'mcp-server',
        metadata: meta('secret-uid-b', '41'),
        data: { token: Buffer.from('credential-b').toString('base64') },
      },
    ]

    const serviceA = new McpAuthorizationService(storeA)
    const serviceB = new McpAuthorizationService(storeB)
    await expect(serviceA.listServers(principal)).resolves.toEqual([
      expect.objectContaining({ name: 'server-a' }),
    ])
    await expect(serviceB.listServers(principalB)).resolves.toEqual([
      expect.objectContaining({ name: 'server-b' }),
    ])
    await expect(serviceA.getCredential(principal, 'server-b')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(serviceB.getCredential(principalB, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(storeA.secretMetadataReads).toBe(1)
    expect(storeA.secretValueReads).toBe(0)
    expect(storeB.secretMetadataReads).toBe(1)
    expect(storeB.secretValueReads).toBe(0)
  })

  it('projects only valid TCP ports into the public transport contract', () => {
    expect(toPublicMcpTransport({ type: 'streamableHttp', port: 65_535 })).toEqual({
      type: 'streamableHttp',
      port: 65_535,
    })
    for (const port of [0, -1, 65_536, 1.5]) {
      expect(toPublicMcpTransport({ type: 'streamableHttp', port })).toEqual({
        type: 'streamableHttp',
      })
    }
  })

  it('returns only the current Context inventory and an opaque Secret-aware revision', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    expect(inventory).toEqual([
      expect.objectContaining({
        name: 'server-a',
        authRequired: true,
        credentialRevision: expect.any(String),
        status: { deployed: true, ready: true, authoritative: false },
      }),
    ])
    expect(inventory[0]).not.toHaveProperty('contextRef')
    expect(inventory[0]).not.toHaveProperty('auth')
    expect(JSON.stringify(inventory)).not.toContain('credential-value')
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(0)
  })

  it('authorizes before Secret read and returns the same revision for a stable credential', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    const credential = await service.getCredential(principal, 'server-a')
    expect(credential).toEqual({
      token: 'credential-value',
      credentialRevision: inventory[0].credentialRevision,
    })
  })

  it('performs zero Secret reads for a cross-Context or unknown target', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-b')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('uses the same opaque denial for a cross-Context and an unknown target', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    const denied = await Promise.allSettled([
      service.getCredential(principal, 'server-b'),
      service.getCredential(principal, 'unknown-server'),
    ])
    expect(
      denied.map(result => (result.status === 'rejected' ? result.reason.code : null))
    ).toEqual(['not_found', 'not_found'])
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('does not read Secret metadata or values for a disabled or deleting server', async () => {
    const store = new FakeStore()
    store.serverObject = { ...server, enabled: false }
    const service = new McpAuthorizationService(store)
    await expect(service.listServers(principal)).resolves.toEqual([])
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)

    store.serverObject = { ...server, metadata: { ...server.metadata, deletionTimestamp: 'now' } }
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('returns a null token without reading a Secret when the server has no auth', async () => {
    const store = new FakeStore()
    store.serverObject = { ...server, auth: { type: 'none' } }
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-a')).resolves.toEqual({
      token: null,
      credentialRevision: expect.any(String),
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('changes the credential revision when the McpServer secretKey changes', async () => {
    const store = new FakeStore()
    store.serverObject = { ...server, auth: { ...server.auth!, secretKey: 'rotated' } }
    store.secretSequence = [
      {
        ...secret,
        data: {
          token: Buffer.from('old').toString('base64'),
          rotated: Buffer.from('new').toString('base64'),
        },
      },
    ]
    store.secretMetadataSequence = [store.secretSequence[0]]
    const service = new McpAuthorizationService(store)
    const first = await service.getCredential(principal, 'server-a')
    store.serverObject = { ...server, auth: { ...server.auth!, secretKey: 'token' } }
    store.secretMetadataReads = 0
    store.secretValueReads = 0
    const second = await service.getCredential(principal, 'server-a')
    expect(first.credentialRevision).not.toBe(second.credentialRevision)
    expect(first.token).toBe('new')
    expect(second.token).toBe('old')
  })

  it('enumerates no foreign server and performs zero Secret reads outside the Context grant', async () => {
    const store = new FakeStore()
    store.contextObject = { ...context, mcpServers: [] }
    const service = new McpAuthorizationService(store)

    await expect(service.listServers(principal)).resolves.toEqual([])
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('performs zero Secret reads when an old JWT is rebound to a recreated Host name', async () => {
    const store = new FakeStore()
    store.hostObject = { ...host, metadata: meta('replacement-uid', '11') }
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'unauthorized',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it.each([
    ['missing', null],
    ['deleting', { ...host, metadata: { ...host.metadata, deletionTimestamp: 'now' } }],
  ])('performs zero Secret reads when the authenticated Host is %s', async (_state, value) => {
    const store = new FakeStore()
    store.hostObject = value
    const service = new McpAuthorizationService(store)

    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'unauthorized',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it.each([
    ['missing', null],
    ['deleting', { ...context, metadata: { ...context.metadata, deletionTimestamp: 'now' } }],
  ])('performs zero Secret reads when the live Context is %s', async (_state, value) => {
    const store = new FakeStore()
    store.contextObject = value
    const service = new McpAuthorizationService(store)

    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('discards inventory when the Host binding changes before the response', async () => {
    const store = new FakeStore()
    store.hostSequence = [host, { ...host, metadata: meta('host-uid-a', '11') }]
    const service = new McpAuthorizationService(store)

    await expect(service.listServers(principal)).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(0)
  })

  it('discards inventory when the Context allowlist changes before the response', async () => {
    const store = new FakeStore()
    store.contextSequence = [
      context,
      { ...context, metadata: meta('context-uid-a', '21'), mcpServers: [] },
    ]
    const service = new McpAuthorizationService(store)

    await expect(service.listServers(principal)).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(0)
  })

  it('discards a credential when the Secret changes during the post-read fence', async () => {
    const store = new FakeStore()
    store.secretMetadataSequence = [secret, { ...secret, metadata: meta('secret-uid-a', '41') }]
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(2)
    expect(store.secretValueReads).toBe(1)
  })

  it('discards a credential when the McpServer changes during the post-read fence', async () => {
    const store = new FakeStore()
    store.serverSequence = [server, { ...server, metadata: meta('server-uid-a', '31') }]
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(2)
    expect(store.secretValueReads).toBe(1)
  })

  it('fails closed when the McpServer disappears during the post-read fence', async () => {
    const store = new FakeStore()
    store.serverSequence = [server, null]
    const service = new McpAuthorizationService(store)

    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(1)
  })

  it('discards a credential when the McpServer is recreated under the same name', async () => {
    const store = new FakeStore()
    store.serverSequence = [server, { ...server, metadata: meta('replacement-server-uid', '1') }]
    const service = new McpAuthorizationService(store)

    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(2)
    expect(store.secretValueReads).toBe(1)
  })

  it('fails closed when the Secret disappears during the post-read fence', async () => {
    const store = new FakeStore()
    store.secretMetadataSequence = [secret, null]
    const service = new McpAuthorizationService(store)

    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'authorization_unavailable',
    })
    expect(store.secretMetadataReads).toBe(2)
    expect(store.secretValueReads).toBe(1)
  })

  it('fails closed when the Context disappears during the post-read fence', async () => {
    const store = new FakeStore()
    store.contextSequence = [context, null]
    const service = new McpAuthorizationService(store)
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(1)
  })

  it('rejects an expired principal before any Kubernetes authority read', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store, () => principal.expiresAt)
    await expect(service.getCredential(principal, 'server-a')).rejects.toMatchObject({
      code: 'unauthorized',
    })
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })
})
