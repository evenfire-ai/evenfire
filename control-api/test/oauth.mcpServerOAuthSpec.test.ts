import { describe, expect, it } from 'vitest'
import {
  type McpServerOAuthSpecInput,
  buildMcpServerGrantKey,
  resolveServerOAuth,
  resolveServerOAuthSubject,
} from '../src/oauth/mcpServerOAuthSpec.js'

/**
 * Direct branch coverage for the pure producers in mcpServerOAuthSpec — the
 * fail-closed `null` returns and grant-scope defaulting. Every
 * downstream seam (broker, callback, authorize-URL) trusts these to reject a
 * malformed `spec.oauth`, so they get a table test of their own (T1: the
 * producer is exercised where it lives, not only through a consumer).
 */

/**
 * `legacyContextRef` models a CR written while installs still stamped a Context
 * on the server: the field may linger on stored objects and must be ignored.
 */
function server(
  oauth: Record<string, unknown> | undefined,
  legacyContextRef?: unknown
): McpServerOAuthSpecInput {
  return {
    spec: {
      ...(oauth ? { oauth } : {}),
      ...(legacyContextRef !== undefined ? { contextRef: legacyContextRef } : {}),
    },
  } as McpServerOAuthSpecInput
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
    expect(r).not.toHaveProperty('contextRef')
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

  it('never surfaces a Context, even when a stored CR still carries spec.contextRef', () => {
    for (const legacy of ['', 'ctx-Z', undefined]) {
      expect(
        resolveServerOAuthSubject(server({ ...FULL_OAUTH }, legacy), 'consent')
      ).not.toHaveProperty('contextRef')
      expect(resolveServerOAuth(server({ ...FULL_OAUTH }, legacy))).not.toHaveProperty('contextRef')
    }
  })

  it('drops non-string scope entries (never emits a non-string scope)', () => {
    const r = resolveServerOAuthSubject(
      server({ ...FULL_OAUTH, scopes: ['ok', 5, null, 'yes'] }),
      'consent'
    )
    expect(r?.decl.scopes).toEqual(['ok', 'yes'])
  })

  // Cross-check the two producers agree on oauthClientId + grantScope.
  it('agrees with resolveServerOAuth on id / grantScope', () => {
    const input = server({ ...FULL_OAUTH, grantScope: 'context' }, 'ctx-A')
    const subject = resolveServerOAuthSubject(input, 'consent')
    const resolved = resolveServerOAuth(input)
    expect(subject?.decl.id).toBe(resolved?.oauthClientId)
    expect(subject?.grantScope).toBe(resolved?.grantScope)
  })

  // The consent callback keys the grant it writes from the subject's coordinate;
  // it must be the very value the broker and the presence rails derive.
  it('carries the resolveServerOAuth coordinate of the same CR, legacy provider included', () => {
    const input = {
      metadata: { uid: 'uid-1' },
      spec: { oauth: { ...FULL_OAUTH, grantScope: 'context' } },
    } as McpServerOAuthSpecInput
    const subject = resolveServerOAuthSubject(input, 'consent')
    expect(subject?.coordinate).toEqual(resolveServerOAuth(input))
    expect(subject?.coordinate).toMatchObject({ legacyProvider: 'google', crUid: 'uid-1' })
  })
})

describe('buildMcpServerGrantKey — context flavor keys by the supplied Context', () => {
  const coords = { mcpServerName: 'gdrive', mcpServersNamespace: 'mcp-server', userId: 'u-1' }

  it('keys a context server by the caller-supplied contextId, never by the CR or the userId', () => {
    const resolved = resolveServerOAuth(
      server({ ...FULL_OAUTH, grantScope: 'context' }, 'ctx-owner')
    )
    if (!resolved) throw new Error('fixture did not resolve')
    expect(buildMcpServerGrantKey(resolved, { ...coords, contextId: 'ctx-1' })).toEqual({
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeNamespace: 'mcp-server',
      recipeName: 'gdrive',
      contextId: 'ctx-1',
      oauthClientId: 'google-drive',
      crUid: undefined,
      legacyProvider: 'google',
    })
    expect(buildMcpServerGrantKey(resolved, { ...coords, contextId: 'ctx-2' })).toMatchObject({
      contextId: 'ctx-2',
    })
  })

  it.each([[undefined], ['']])('returns null for a context server with contextId %j', contextId => {
    const resolved = resolveServerOAuth(
      server({ ...FULL_OAUTH, grantScope: 'context' }, 'ctx-owner')
    )
    if (!resolved) throw new Error('fixture did not resolve')
    expect(buildMcpServerGrantKey(resolved, { ...coords, contextId })).toBeNull()
  })

  it('ignores contextId for a per-user server', () => {
    const resolved = resolveServerOAuth(server({ ...FULL_OAUTH, grantScope: 'user' }))
    if (!resolved) throw new Error('fixture did not resolve')
    expect(buildMcpServerGrantKey(resolved, { ...coords, contextId: 'ctx-1' })).toMatchObject({
      grantKind: 'user',
      userId: 'u-1',
    })
    expect(buildMcpServerGrantKey(resolved, { ...coords, contextId: 'ctx-1' })).not.toHaveProperty(
      'contextId'
    )
  })
})
