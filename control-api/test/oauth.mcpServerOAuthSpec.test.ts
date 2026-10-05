import { describe, expect, it } from 'vitest'
import {
  type McpServerOAuthSpecInput,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'

/**
 * Direct branch coverage for the pure producers in mcpServerOAuthSpec — the
 * fail-closed `null` returns and grant-scope / contextRef defaulting. Every
 * downstream seam (broker, callback, authorize-URL) trusts these to reject a
 * malformed `spec.oauth`, so they get a table test of their own (T1: the
 * producer is exercised where it lives, not only through a consumer).
 */

function server(
  oauth: Record<string, unknown> | undefined,
  contextRef?: unknown
): McpServerOAuthSpecInput {
  return {
    spec: { ...(oauth ? { oauth } : {}), ...(contextRef !== undefined ? { contextRef } : {}) },
  }
}

const FULL_OAUTH = {
  id: 'google-drive',
  provider: 'google',
  clientIdRef: { name: 'creds', key: 'client-id' },
  clientSecretRef: { name: 'creds', key: 'client-secret' },
  scopes: ['a', 'b'],
  backgroundAccess: true,
}

describe('resolveServerOAuthSubject — fail-closed branches (U5)', () => {
  it('returns the full decl + routing for a well-formed context server', () => {
    const r = resolveServerOAuthSubject(
      server({ ...FULL_OAUTH, grantScope: 'context' }, 'ctx-A'),
      'consent'
    )
    expect(r).not.toBeNull()
    expect(r?.decl).toEqual({
      id: 'google-drive',
      provider: 'google',
      clientIdRef: { name: 'creds', key: 'client-id' },
      clientSecretRef: { name: 'creds', key: 'client-secret' },
      scopes: ['a', 'b'],
      backgroundAccess: true,
    })
    expect(r?.grantScope).toBe('context')
    expect(r?.contextRef).toBe('ctx-A')
  })

  it('returns null when spec.oauth is absent', () => {
    expect(resolveServerOAuthSubject(server(undefined), 'consent')).toBeNull()
  })

  it('returns null when id is missing or empty', () => {
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, id: undefined }), 'consent')
    ).toBeNull()
    expect(resolveServerOAuthSubject(server({ ...FULL_OAUTH, id: '' }), 'consent')).toBeNull()
  })

  it('returns null when provider is missing or empty', () => {
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, provider: undefined }), 'consent')
    ).toBeNull()
    expect(resolveServerOAuthSubject(server({ ...FULL_OAUTH, provider: '' }), 'consent')).toBeNull()
  })

  it('returns null when clientIdRef (or its key) is missing', () => {
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, clientIdRef: undefined }), 'consent')
    ).toBeNull()
    expect(
      resolveServerOAuthSubject(
        server({ ...FULL_OAUTH, clientIdRef: { name: 'creds' } }),
        'consent'
      )
    ).toBeNull()
  })

  it('returns null when clientSecretRef (or its key) is missing', () => {
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, clientSecretRef: undefined }), 'consent')
    ).toBeNull()
    expect(
      resolveServerOAuthSubject(
        server({ ...FULL_OAUTH, clientSecretRef: { key: 'client-secret' } }),
        'consent'
      )
    ).toBeNull()
  })

  it('defaults grantScope to "user" for missing / non-"context" values', () => {
    expect(resolveServerOAuthSubject(server({ ...FULL_OAUTH }), 'consent')?.grantScope).toBe('user')
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, grantScope: 'garbage' }), 'consent')
        ?.grantScope
    ).toBe('user')
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH, grantScope: 'context' }), 'consent')
        ?.grantScope
    ).toBe('context')
  })

  it('normalizes an empty / absent contextRef to undefined', () => {
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH }, ''), 'consent')?.contextRef
    ).toBeUndefined()
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH }), 'consent')?.contextRef
    ).toBeUndefined()
    expect(
      resolveServerOAuthSubject(server({ ...FULL_OAUTH }, 'ctx-Z'), 'consent')?.contextRef
    ).toBe('ctx-Z')
  })

  it('drops non-string scope entries (never emits a non-string scope)', () => {
    const r = resolveServerOAuthSubject(
      server({ ...FULL_OAUTH, scopes: ['ok', 5, null, 'yes'] }),
      'consent'
    )
    expect(r?.decl.scopes).toEqual(['ok', 'yes'])
  })

  // Cross-check the two producers agree on oauthClientId + grantScope + contextRef.
  it('agrees with resolveServerOAuth on id / grantScope / contextRef', () => {
    const input = server({ ...FULL_OAUTH, grantScope: 'context' }, 'ctx-A')
    const subject = resolveServerOAuthSubject(input, 'consent')
    const resolved = resolveServerOAuth(input)
    expect(subject?.decl.id).toBe(resolved?.oauthClientId)
    expect(subject?.grantScope).toBe(resolved?.grantScope)
    expect(subject?.contextRef).toBe(resolved?.contextRef)
  })
})
