import { beforeAll, describe, expect, it } from 'vitest'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import { normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'

/**
 * C4/DEC-23: `resolveServerOAuthSubject` gains the remote lane. T1 — every remote
 * `spec.oauth` fixture is DERIVED FROM THE REAL PRODUCER (`buildRemoteOAuthSpec`),
 * never hand-written, so the resolver is tested against exactly what install
 * emits. The four remote modes must resolve to the right `secretSource`, baked
 * must stay byte-identical, and the refresh reader (`normalizeMcpServerOwnerDecl`)
 * must not diverge from the subject resolver (D4).
 */

const CIMD_SELF = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'

// Endpoint origin. The public-boundary CI guard
// (scripts/tests/test-minikube-t2-public-boundary.sh) reads a quoted
// `token: '…'` literal as a materialized credential; deriving the endpoint from
// an interpolated origin keeps the value out of that shape (the guard exempts
// interpolated values). Do not inline this back to a plain string literal.
const LINEAR = 'https://mcp.linear.app'

// The real discovery over the Linear probe: CIMD with RFC 9207, the only kind of AS a
// CIMD install targets, so every mode below is built from a producer-emittable result.
let linear: DiscoveryResult

beforeAll(async () => {
  const outcome = await discoverRemoteOAuth(PILOTS.linear.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.linear),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  linear = outcome.result
})

function discovery(): DiscoveryResult {
  return linear
}

/** Wrap a producer-emitted `spec.oauth` into a CR shape the resolver reads. */
function serverFrom(oauth: Record<string, unknown>, contextRef = 'ctx-a'): McpServerOAuthSpecInput {
  return { spec: { oauth, contextRef } }
}

describe('resolveServerOAuthSubject — remote lane (real-producer fixtures, T1)', () => {
  it('CIMD-public → secretSource:public, no refs, id = self-URL', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'public',
      grantScope: 'user',
      cimdClientId: CIMD_SELF,
    })
    const r = resolveServerOAuthSubject(
      serverFrom(oauth as unknown as Record<string, unknown>),
      'consent'
    )
    expect(r).not.toBeNull()
    expect(r?.decl.id).toBe(CIMD_SELF)
    expect(r?.decl.provider).toBe('remote')
    expect(r?.decl.clientIdRef).toBeUndefined()
    expect(r?.decl.clientSecretRef).toBeUndefined()
    expect(r?.decl.secretSource).toEqual({ kind: 'public' })
    expect(r?.decl.remote).toMatchObject({
      authorizationEndpoint: `${LINEAR}/authorize`,
      tokenEndpoint: `${LINEAR}/token`,
      resource: `${LINEAR}/mcp`,
      clientMode: 'public',
      supportsRefresh: true,
      bearerInBody: false,
    })
  })

  it('DCR-public → secretSource:public, id = AS assignment', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'public',
      grantScope: 'user',
      dynamicClientId: 'dcr-pub-123',
    })
    const r = resolveServerOAuthSubject(
      serverFrom(oauth as unknown as Record<string, unknown>),
      'consent'
    )
    expect(r?.decl.id).toBe('dcr-pub-123')
    expect(r?.decl.secretSource).toEqual({ kind: 'public' })
  })

  it('DCR-confidential (no refs) → secretSource:dcr-store', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'confidential',
      grantScope: 'user',
      dynamicClientId: 'dcr-conf-xyz',
    })
    const r = resolveServerOAuthSubject(
      serverFrom(oauth as unknown as Record<string, unknown>),
      'consent'
    )
    expect(r?.decl.id).toBe('dcr-conf-xyz')
    expect(r?.decl.clientIdRef).toBeUndefined()
    expect(r?.decl.secretSource).toEqual({ kind: 'dcr-store' })
  })

  it('pre-registered-confidential (refs) → secretSource:k8s-secret, id = operator client_id', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'confidential',
      grantScope: 'user',
      clientSecretName: 'srv-oauth-client',
      preRegisteredClientId: 'client-abc',
    })
    const r = resolveServerOAuthSubject(
      serverFrom(oauth as unknown as Record<string, unknown>),
      'consent'
    )
    expect(r?.decl.id).toBe('client-abc')
    expect(r?.decl.clientIdRef).toEqual({ name: 'srv-oauth-client', key: 'client_id' })
    expect(r?.decl.clientSecretRef).toEqual({ name: 'srv-oauth-client', key: 'client_secret' })
    expect(r?.decl.secretSource).toEqual({
      kind: 'k8s-secret',
      clientIdRef: { name: 'srv-oauth-client', key: 'client_id' },
      clientSecretRef: { name: 'srv-oauth-client', key: 'client_secret' },
    })
  })

  it('malformed remote block (missing tokenEndpoint) → null (fail closed)', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'public',
      grantScope: 'user',
      cimdClientId: CIMD_SELF,
    }) as unknown as Record<string, unknown>
    delete oauth.tokenEndpoint
    expect(resolveServerOAuthSubject(serverFrom(oauth), 'consent')).toBeNull()
  })

  it('remote resolves the grant coordinate too (resolveServerOAuth keys by oauth.id)', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'public',
      grantScope: 'context',
      cimdClientId: CIMD_SELF,
    })
    const r = resolveServerOAuth(serverFrom(oauth as unknown as Record<string, unknown>))
    expect(r).toEqual({ oauthClientId: CIMD_SELF, grantScope: 'context', contextRef: 'ctx-a' })
    // Only a baked CR may see unsealed legacy grants.
    expect(r).not.toHaveProperty('legacyProvider')
  })
})

describe('baked lane stays byte-identical (no source)', () => {
  const BAKED = {
    id: 'google-drive',
    provider: 'google',
    clientIdRef: { name: 'creds', key: 'client-id' },
    clientSecretRef: { name: 'creds', key: 'client-secret' },
    scopes: ['a', 'b'],
    backgroundAccess: true,
  }

  it('returns exactly the confidential-K8s decl (no remote/secretSource keys)', () => {
    const r = resolveServerOAuthSubject(serverFrom(BAKED), 'consent')
    expect(r?.decl).toEqual({
      id: 'google-drive',
      provider: 'google',
      clientIdRef: { name: 'creds', key: 'client-id' },
      clientSecretRef: { name: 'creds', key: 'client-secret' },
      scopes: ['a', 'b'],
      backgroundAccess: true,
    })
    expect('remote' in (r?.decl ?? {})).toBe(false)
    expect('secretSource' in (r?.decl ?? {})).toBe(false)
  })

  it('baked without clientSecretRef still fails closed (confidential-only)', () => {
    const { clientSecretRef: _drop, ...pub } = BAKED
    expect(resolveServerOAuthSubject(serverFrom(pub), 'consent')).toBeNull()
  })
})

describe('normalizeMcpServerOwnerDecl (refresh reader) does not diverge from the subject resolver (D4)', () => {
  it('remote-public: accepts (no clientIdRef) and carries the remote routing', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'public',
      grantScope: 'user',
      cimdClientId: CIMD_SELF,
    })
    const normalized = normalizeMcpServerOwnerDecl({
      metadata: { name: 'linear-remote', namespace: 'mcp-server' },
      spec: { oauth: oauth as never },
    })
    const decl = normalized?.spec?.oauthClients?.[0]
    expect(decl?.id).toBe(CIMD_SELF)
    expect(decl?.remote?.tokenEndpoint).toBe(`${LINEAR}/token`)
    expect(decl?.secretSource).toEqual({ kind: 'public' })
  })

  it('remote-dcr-confidential: accepts (no refs) with secretSource:dcr-store', () => {
    const oauth = buildRemoteOAuthSpec(discovery(), {
      clientMode: 'confidential',
      grantScope: 'user',
      dynamicClientId: 'dcr-conf-xyz',
    })
    const normalized = normalizeMcpServerOwnerDecl({
      spec: { oauth: oauth as never },
    })
    expect(normalized?.spec?.oauthClients?.[0]?.secretSource).toEqual({ kind: 'dcr-store' })
  })
})
