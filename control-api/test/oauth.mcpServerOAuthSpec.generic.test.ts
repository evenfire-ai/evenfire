import { describe, expect, it } from 'vitest'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'
import { normalizeMcpServerOwnerDecl } from '../src/routes/mcpOauth.js'

/**
 * S3.2 / DEC-28 — `resolveServerOAuthSubject` gains the generic self-hosted lane.
 * There is NO install-producer for the generic carril in scope (deferred), so the
 * `spec.oauth` bytes here represent apiserver-stored CR data (the untrusted INPUT
 * to the resolver), not another layer's output — the resolver itself is the
 * producer of the decl under test. This mirrors how the remote lane's callback /
 * tokenHelper / authorizeUrl tests construct CR bytes inline.
 *
 * Invariants: public (neither ref) → secretSource:public + no refs; confidential
 * (both refs) → secretSource:k8s-secret + refs carried; provider label is the
 * synthetic 'generic' (never an ADAPTERS key); malformed knobs / half-declared
 * refs fail closed to null; the baked lane is unaffected; and the refresh reader
 * (`normalizeMcpServerOwnerDecl`) does not diverge from the subject resolver (D4).
 */

const KNOBS = {
  source: 'generic' as const,
  id: 'my-generic-client',
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  tokenRequestFormat: 'form' as const,
  tokenAuthMethod: 'body' as const,
  scopeSeparator: 'space' as const,
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
  scopes: ['read', 'write'],
  grantScope: 'user' as const,
}

function serverFrom(oauth: Record<string, unknown>, contextRef = 'ctx-a'): McpServerOAuthSpecInput {
  return { spec: { oauth, contextRef } }
}

describe('resolveServerOAuthSubject — generic lane (DEC-28)', () => {
  it('public (neither ref) → secretSource:public, no refs, provider label generic', () => {
    const r = resolveServerOAuthSubject(serverFrom({ ...KNOBS }))
    expect(r).not.toBeNull()
    expect(r?.decl.id).toBe('my-generic-client')
    expect(r?.decl.provider).toBe('generic')
    expect(r?.decl.clientIdRef).toBeUndefined()
    expect(r?.decl.clientSecretRef).toBeUndefined()
    expect(r?.decl.secretSource).toEqual({ kind: 'public' })
    expect(r?.decl.remote).toBeUndefined()
    expect(r?.decl.generic).toMatchObject({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      tokenRequestFormat: 'form',
      tokenAuthMethod: 'body',
      scopeSeparator: 'space',
      sendScope: true,
      usePkce: true,
      includeResponseType: true,
      supportsRefresh: true,
    })
  })

  it('confidential (both refs) → secretSource:k8s-secret, refs carried', () => {
    const r = resolveServerOAuthSubject(
      serverFrom({
        ...KNOBS,
        clientIdRef: { name: 'gen-creds', key: 'client_id' },
        clientSecretRef: { name: 'gen-creds', key: 'client_secret' },
      })
    )
    expect(r?.decl.clientIdRef).toEqual({ name: 'gen-creds', key: 'client_id' })
    expect(r?.decl.clientSecretRef).toEqual({ name: 'gen-creds', key: 'client_secret' })
    expect(r?.decl.secretSource).toEqual({
      kind: 'k8s-secret',
      clientIdRef: { name: 'gen-creds', key: 'client_id' },
      clientSecretRef: { name: 'gen-creds', key: 'client_secret' },
    })
  })

  it('optional knobs (refreshEndpoint, resource, extraAuthorizeParams) are carried', () => {
    const r = resolveServerOAuthSubject(
      serverFrom({
        ...KNOBS,
        refreshEndpoint: 'https://idp.example.com/refresh',
        resource: 'https://api.example.com',
        extraAuthorizeParams: { audience: 'aud-1', dropped: 42 },
      })
    )
    expect(r?.decl.generic?.refreshEndpoint).toBe('https://idp.example.com/refresh')
    expect(r?.decl.generic?.resource).toBe('https://api.example.com')
    // Only string-valued extra params survive.
    expect(r?.decl.generic?.extraAuthorizeParams).toEqual({ audience: 'aud-1' })
  })

  it('half-declared refs (only one) fail closed to null', () => {
    expect(
      resolveServerOAuthSubject(serverFrom({ ...KNOBS, clientIdRef: { name: 'x', key: 'y' } }))
    ).toBeNull()
    expect(
      resolveServerOAuthSubject(serverFrom({ ...KNOBS, clientSecretRef: { name: 'x', key: 'y' } }))
    ).toBeNull()
  })

  it('malformed wire enum fails closed to null', () => {
    expect(
      resolveServerOAuthSubject(serverFrom({ ...KNOBS, tokenRequestFormat: 'xml' }))
    ).toBeNull()
    expect(
      resolveServerOAuthSubject(serverFrom({ ...KNOBS, tokenAuthMethod: 'header' }))
    ).toBeNull()
    expect(
      resolveServerOAuthSubject(serverFrom({ ...KNOBS, scopeSeparator: 'semicolon' }))
    ).toBeNull()
  })

  it('missing required endpoint fails closed to null', () => {
    const { tokenEndpoint: _drop, ...noToken } = KNOBS
    expect(resolveServerOAuthSubject(serverFrom(noToken))).toBeNull()
  })

  it('resolveServerOAuth keys the grant coordinate by oauth.id (grantScope respected)', () => {
    const r = resolveServerOAuth(serverFrom({ ...KNOBS, grantScope: 'context' }))
    expect(r).toEqual({
      oauthClientId: 'my-generic-client',
      grantScope: 'context',
      contextRef: 'ctx-a',
    })
  })
})

describe('baked lane is unaffected by the generic branch', () => {
  it('a baked confidential server still resolves to the confidential-K8s decl', () => {
    const r = resolveServerOAuthSubject(
      serverFrom({
        id: 'google-drive',
        provider: 'google',
        clientIdRef: { name: 'creds', key: 'client-id' },
        clientSecretRef: { name: 'creds', key: 'client-secret' },
        scopes: ['a'],
        backgroundAccess: true,
      })
    )
    expect(r?.decl.provider).toBe('google')
    expect('generic' in (r?.decl ?? {})).toBe(false)
    expect('secretSource' in (r?.decl ?? {})).toBe(false)
  })
})

describe('normalizeMcpServerOwnerDecl (refresh reader) matches the subject resolver (D4)', () => {
  it('generic public: carries the generic routing + secretSource:public', () => {
    const normalized = normalizeMcpServerOwnerDecl({
      metadata: { name: 'gen-server', namespace: 'mcp-server' },
      spec: { oauth: { ...KNOBS } as never },
    })
    const decl = normalized?.spec?.oauthClients?.[0]
    expect(decl?.id).toBe('my-generic-client')
    expect(decl?.generic?.tokenEndpoint).toBe('https://idp.example.com/token')
    expect(decl?.secretSource).toEqual({ kind: 'public' })
  })

  it('generic confidential: carries secretSource:k8s-secret', () => {
    const normalized = normalizeMcpServerOwnerDecl({
      spec: {
        oauth: {
          ...KNOBS,
          clientIdRef: { name: 'gen-creds', key: 'client_id' },
          clientSecretRef: { name: 'gen-creds', key: 'client_secret' },
        } as never,
      },
    })
    expect(normalized?.spec?.oauthClients?.[0]?.secretSource).toEqual({
      kind: 'k8s-secret',
      clientIdRef: { name: 'gen-creds', key: 'client_id' },
      clientSecretRef: { name: 'gen-creds', key: 'client_secret' },
    })
  })
})
