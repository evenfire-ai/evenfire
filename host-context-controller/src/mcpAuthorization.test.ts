import { describe, expect, it, vi } from 'vitest'
import type { VerifiedMcpHostPrincipal } from './mcpApiAuthentication'
import {
  type AuthorityContext,
  type AuthorityHost,
  type AuthorityMcpServer,
  type AuthoritySecret,
  type AuthoritySecretMetadata,
  deriveAuthKind,
  McpAuthorizationService,
  type McpAuthorizationStore,
  toPublicMcpTransport,
} from './mcpAuthorization'
import type { McpServerOAuth } from './types'

// A complete McpServerOAuth block, shaped like the CRD `spec.oauth` the real
// producer (k8sClient.readMcpServer) projects — never a hand-built partial.
const fullOAuth = (grantScope: 'user' | 'context'): McpServerOAuth => ({
  id: 'oauth-adapter',
  provider: 'google',
  clientIdRef: { name: 'oauth-secret', key: 'client-id' },
  clientSecretRef: { name: 'oauth-secret', key: 'client-secret' },
  grantScope,
})

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

describe('deriveAuthKind (mini-spec 10 §3.1)', () => {
  it.each([
    ['oauth + grantScope=user → oauth-user', { type: 'oauth' as const }, { grantScope: 'user' as const }, true, 'oauth-user'],
    ['oauth + grantScope=context → oauth-context', { type: 'oauth' as const }, { grantScope: 'context' as const }, true, 'oauth-context'],
    ['oauth + grantScope absent → oauth-user (CEL default)', { type: 'oauth' as const }, undefined, true, 'oauth-user'],
    ['bearer (authRequired) → static', { type: 'bearer' as const }, undefined, true, 'static'],
    ['apiKey (authRequired) → static', { type: 'apiKey' as const }, undefined, true, 'static'],
    ['none → undefined (omitted)', { type: 'none' as const }, undefined, false, undefined],
    ['absent auth → undefined', undefined, undefined, false, undefined],
  ])('%s', (_label, auth, oauth, authRequired, expected) => {
    expect(deriveAuthKind(auth as never, oauth as never, authRequired)).toBe(expected)
  })

  it('never collapses an oauth server to static across every grantScope', () => {
    for (const grantScope of ['user', 'context', undefined] as const) {
      const kind = deriveAuthKind(
        { type: 'oauth' },
        grantScope ? { grantScope } : undefined,
        true
      )
      expect(kind).not.toBe('static')
      expect(kind?.startsWith('oauth-')).toBe(true)
    }
  })

  it('is idempotent: same inputs yield the same authKind', () => {
    const a = deriveAuthKind({ type: 'oauth' }, { grantScope: 'context' }, true)
    const b = deriveAuthKind({ type: 'oauth' }, { grantScope: 'context' }, true)
    expect(a).toBe(b)
  })
})

describe('listServers authKind emission (mini-spec 10 §3.2, T1)', () => {
  it.each([
    ['oauth-user', { type: 'oauth' as const }, fullOAuth('user'), 'oauth-user'],
    ['oauth-context', { type: 'oauth' as const }, fullOAuth('context'), 'oauth-context'],
    ['static (bearer)', { type: 'bearer' as const, secretRef: 'server-a-auth', secretKey: 'token' }, undefined, 'static'],
  ])('emits authKind=%s derived from the real producer', async (_label, auth, oauth, expected) => {
    const store = new FakeStore()
    store.serverObject = {
      ...server,
      auth,
      ...(oauth ? { oauth } : {}),
    }
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    expect(inventory[0].authKind).toBe(expected)
    // I1: the wire projection never leaks context/auth identity.
    expect(inventory[0]).not.toHaveProperty('contextRef')
    expect(inventory[0]).not.toHaveProperty('auth')
    expect(inventory[0]).not.toHaveProperty('oauth')
  })

  it('omits authKind entirely for a no-auth server', async () => {
    const store = new FakeStore()
    store.serverObject = { ...server, auth: { type: 'none' } }
    const service = new McpAuthorizationService(store)
    const inventory = await service.listServers(principal)
    expect(inventory[0]).not.toHaveProperty('authKind')
  })
})
