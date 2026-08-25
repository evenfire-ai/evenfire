import { describe, expect, it, vi } from 'vitest'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import {
  type AuthorityContext,
  type AuthorityHost,
  type AuthorityMcpServer,
  type AuthoritySecret,
  type AuthoritySecretMetadata,
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
  secretMetadataSequence: Array<AuthoritySecretMetadata | null> = [secret]
  secretSequence: Array<AuthoritySecret | null> = [secret]
  hostSequence: Array<AuthorityHost | null> | null = null
  contextSequence: Array<AuthorityContext | null> | null = null
  serverSequence: Array<AuthorityMcpServer | null> | null = null
  hostObjects: Map<string, AuthorityHost | null> | null = null
  contextObjects: Map<string, AuthorityContext | null> | null = null
  serverObjects: Map<string, AuthorityMcpServer | null> | null = null
  secretMetadataObjects: Map<string, AuthoritySecretMetadata | null> | null = null
  secretObjects: Map<string, AuthoritySecret | null> | null = null
  hostReads = 0
  contextReads = 0
  serverReads = 0
  hostObject: AuthorityHost | null = host
  contextObject: AuthorityContext | null = context
  serverObject: AuthorityMcpServer | null = server

  async listMcpServers(): Promise<AuthorityMcpServer[]> {
    return this.serverObject ? [this.serverObject] : []
  }

  async readHost(name: string) {
    this.hostReads += 1
    if (this.hostObjects) return this.hostObjects.get(name) ?? null
    return this.hostSequence
      ? this.hostSequence[Math.min(this.hostReads - 1, this.hostSequence.length - 1)]
      : this.hostObject
  }
  async readContext(name: string) {
    this.contextReads += 1
    if (this.contextObjects) return this.contextObjects.get(name) ?? null
    return this.contextSequence
      ? this.contextSequence[Math.min(this.contextReads - 1, this.contextSequence.length - 1)]
      : this.contextObject
  }
  async readMcpServer(name: string) {
    this.serverReads += 1
    if (this.serverObjects) return this.serverObjects.get(name) ?? null
    return this.serverSequence
      ? this.serverSequence[Math.min(this.serverReads - 1, this.serverSequence.length - 1)]
      : this.serverObject
  }
  async readSecretMetadata(name: string) {
    this.secretMetadataReads += 1
    if (this.secretMetadataObjects) return this.secretMetadataObjects.get(name) ?? null
    const value =
      this.secretMetadataSequence[
        Math.min(this.secretMetadataReads - 1, this.secretMetadataSequence.length - 1)
      ]
    return value ? { name: value.name, namespace: value.namespace, metadata: value.metadata } : null
  }
  async readSecret(name: string) {
    this.secretValueReads += 1
    if (this.secretObjects) return this.secretObjects.get(name) ?? null
    return this.secretSequence[Math.min(this.secretValueReads - 1, this.secretSequence.length - 1)]
  }
}

async function expectCredentialFailure(
  service: McpAuthorizationService,
  code: string
): Promise<void> {
  const error = await service.getCredential(principal, 'server-a').then(
    () => null,
    reason => reason
  )
  expect(error).toMatchObject({ code })
  expect(error).not.toHaveProperty('token')
  expect(JSON.stringify(error)).not.toContain(
    Buffer.from(secret.data.token, 'base64').toString('utf8')
  )
}

describe('McpAuthorizationService', () => {
  it('keeps descriptions out of the global system inventory DTO', async () => {
    const store = new FakeStore()
    const describedServer = {
      ...server,
      contextRef: 'context-a',
      description: ['fixture', 'description'].join(' '),
    }
    store.listMcpServers = async () => [describedServer]
    const service = new McpAuthorizationService(store)

    const inventory = await service.listSystemServers()

    expect(inventory[0]).not.toHaveProperty('description')
    expect(Object.keys(inventory[0]).sort()).toEqual([
      'contextRef',
      'destinationRevision',
      'enabled',
      'name',
      'status',
      'transport',
    ])
  })

  it('omits McpServers that are not attached to any Context from the system inventory', async () => {
    const store = new FakeStore()
    const orphan = { ...server, name: 'orphan-server', contextRef: undefined }
    const attached = { ...server, contextRef: 'context-a' }
    store.listMcpServers = async () => [orphan, attached]
    const service = new McpAuthorizationService(store)

    await expect(service.listSystemServers()).resolves.toEqual([
      expect.objectContaining({ name: 'server-a', contextRef: 'context-a' }),
    ])
  })

  it('keeps two Host/Context grant sets disjoint in both directions', async () => {
    const hostB: AuthorityHost = {
      name: 'host-b',
      namespace: 'mcp-host',
      metadata: meta('host-uid-b', '11'),
      contextRef: 'context-b',
    }
    const secretB: AuthoritySecret = {
      name: 'server-b-auth',
      namespace: 'mcp-server',
      metadata: meta('secret-uid-b', '41'),
      data: { token: Buffer.from('credential-b').toString('base64') },
    }
    const store = new FakeStore()
    store.hostObjects = new Map([
      [host.name, host],
      [hostB.name, hostB],
    ])
    store.contextObjects = new Map([
      [context.name, context],
      [contextB.name, contextB],
    ])
    store.serverObjects = new Map([
      [server.name, server],
      [serverB.name, serverB],
    ])
    store.secretMetadataObjects = new Map([
      [secret.name, secret],
      [secretB.name, secretB],
    ])
    store.secretObjects = new Map([
      [secret.name, secret],
      [secretB.name, secretB],
    ])

    const service = new McpAuthorizationService(store)
    await expect(service.listServers(principal)).resolves.toEqual([
      expect.objectContaining({ name: 'server-a' }),
    ])
    await expect(service.listServers(principalB)).resolves.toEqual([
      expect.objectContaining({ name: 'server-b' }),
    ])
    const readsBeforeForeignRequests = {
      secretMetadata: store.secretMetadataReads,
      secretValue: store.secretValueReads,
    }
    await expect(service.getCredential(principal, 'server-b')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(service.getCredential(principalB, 'server-a')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(store.secretMetadataReads).toBe(readsBeforeForeignRequests.secretMetadata)
    expect(store.secretValueReads).toBe(readsBeforeForeignRequests.secretValue)
    await expect(service.getCredential(principalB, 'server-b')).resolves.toMatchObject({
      token: 'credential-b',
    })
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

  it('returns only the current Context inventory without Secret metadata or credential revisions', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    expect(inventory).toEqual([
      expect.objectContaining({
        name: 'server-a',
        authRequired: true,
        status: { deployed: true, ready: true, authoritative: false },
      }),
    ])
    expect(inventory[0]).toHaveProperty('contextRef', 'context-a')
    expect(inventory[0]).not.toHaveProperty('auth')
    expect(inventory[0]).not.toHaveProperty('credentialRevision')
    expect(JSON.stringify(inventory)).not.toContain('credential-value')
    expect(store.secretMetadataReads).toBe(0)
    expect(store.secretValueReads).toBe(0)
  })

  it('authorizes before Secret read and returns the revision only from the credential route', async () => {
    const store = new FakeStore()
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    expect(store.secretMetadataReads).toBe(0)
    const credential = await service.getCredential(principal, 'server-a')
    expect(credential).toEqual({
      token: 'credential-value',
      credentialRevision: expect.any(String),
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

  it.each(['host', 'context', 'server', 'secret-metadata', 'secret-value'] as const)(
    'fails closed without disclosing a credential when the %s store read errors',
    async read => {
      const store = new FakeStore()
      if (read === 'host')
        vi.spyOn(store, 'readHost').mockRejectedValueOnce(new Error('read failed'))
      if (read === 'context') {
        vi.spyOn(store, 'readContext').mockRejectedValueOnce(new Error('read failed'))
      }
      if (read === 'server') {
        vi.spyOn(store, 'readMcpServer').mockRejectedValueOnce(new Error('read failed'))
      }
      if (read === 'secret-metadata') {
        vi.spyOn(store, 'readSecretMetadata').mockRejectedValueOnce(new Error('read failed'))
      }
      if (read === 'secret-value') {
        vi.spyOn(store, 'readSecret').mockRejectedValueOnce(new Error('read failed'))
      }
      const service = new McpAuthorizationService(store)

      await expectCredentialFailure(service, 'authorization_unavailable')
      if (read !== 'secret-value') expect(store.secretValueReads).toBe(0)
      if (read === 'host' || read === 'context' || read === 'server') {
        expect(store.secretMetadataReads).toBe(0)
      }
    }
  )

  it.each([
    ['missing secretRef', { auth: { type: 'bearer' as const } }, secret],
    ['missing Secret metadata', {}, null],
  ])('rejects %s before any Secret value read', async (_label, serverOverride, metadataValue) => {
    const store = new FakeStore()
    store.serverObject = { ...server, ...(serverOverride as Partial<AuthorityMcpServer>) }
    store.secretMetadataSequence = metadataValue
      ? [metadataValue as AuthoritySecretMetadata]
      : [null]
    const service = new McpAuthorizationService(store)

    await expectCredentialFailure(service, 'credential_unavailable')
    expect(store.secretValueReads).toBe(0)
  })

  it.each([
    ['missing configured key', { other: Buffer.from('other').toString('base64') }],
    ['empty base64', { token: '' }],
    ['malformed base64', { token: 'invalid-test-token' }],
    ['non-UTF8 base64', { token: Buffer.from([0xff]).toString('base64') }],
  ])('rejects %s without returning Secret data', async (_label, data) => {
    const store = new FakeStore()
    store.secretSequence = [{ ...secret, data }]
    const service = new McpAuthorizationService(store)

    await expectCredentialFailure(service, 'credential_unavailable')
    expect(store.secretValueReads).toBe(1)
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
    expect(store.secretMetadataReads).toBe(0)
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
    expect(store.secretMetadataReads).toBe(0)
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

  it('rejects a credential when the Host is rebound during the post-read fence', async () => {
    const store = new FakeStore()
    store.hostSequence = [host, { ...host, metadata: meta('replacement-host-uid', '1') }]
    const service = new McpAuthorizationService(store)

    await expectCredentialFailure(service, 'unauthorized')
    expect(store.secretMetadataReads).toBe(1)
    expect(store.secretValueReads).toBe(1)
  })

  it('rejects a credential when the Context allowlist changes during the post-read fence', async () => {
    const store = new FakeStore()
    store.contextSequence = [context, { ...context, mcpServers: [] }]
    const service = new McpAuthorizationService(store)

    await expectCredentialFailure(service, 'not_found')
    expect(store.secretMetadataReads).toBe(1)
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
