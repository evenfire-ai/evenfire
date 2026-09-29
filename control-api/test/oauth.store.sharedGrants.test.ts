import { describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../src/oauth/mcpServerOAuthSpec.js'
import {
  bootstrapSharedOAuthGrant,
  deleteOAuthGrant,
  getOAuthGrant,
  oauthGrantExists,
  refreshOAuthGrantTokens,
  upsertOAuthGrant,
} from '../src/oauth/store.js'

const KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

function fakeDb(
  rows: unknown[] = [],
  rowCount?: number
): {
  db: DbClient
  calls: { text: string; values: unknown[] }[]
} {
  const calls: { text: string; values: unknown[] }[] = []
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows, rowCount: rowCount ?? rows.length } as never
    },
  } as unknown as DbClient
  return { db, calls }
}

const SHARED_KEY = {
  grantKind: 'shared' as const,
  ownerKind: 'mcpserver' as const,
  recipeNamespace: 'mcp-server',
  recipeName: 'gdrive',
  contextId: 'ctx-9',
  oauthClientId: 'google-drive',
}

// A reader key of a non-baked lane: it carries the live CR uid but no legacyProvider.
const SHARED_READ_KEY = { ...SHARED_KEY, crUid: 'uid-1' }

/** Reader key derived from a baked CR, exactly as the broker/gate/sweep build it. */
function bakedReaderKey(grantScope: 'user' | 'context', userId?: string) {
  const resolved = resolveServerOAuth({
    metadata: { uid: 'uid-1', name: 'gdrive' },
    spec: {
      contextRef: 'ctx-9',
      oauth: { id: 'google-drive', provider: 'google', grantScope },
    },
  })
  if (!resolved) throw new Error('fixture: server did not resolve as OAuth')
  const key = buildMcpServerGrantKey(resolved, {
    mcpServerName: 'gdrive',
    mcpServersNamespace: 'mcp-server',
    userId,
  })
  if (!key) throw new Error('fixture: no grant key')
  return key
}

describe('oauth store — shared (context-identity) grants', () => {
  it('bootstrapSharedOAuthGrant issues INSERT … ON CONFLICT DO UPDATE fenced by cr_uid, returns inserted', async () => {
    const { db, calls } = fakeDb([{ id: 1 }], 1)
    const out = await bootstrapSharedOAuthGrant(db, KEY, {
      ...SHARED_KEY,
      bootstrappedByUserId: 'user-1',
      provider: 'google',
      accessToken: 'A',
      refreshToken: 'R',
      accessTokenExpiresInSec: 3600,
      crUid: 'uid-1',
    })
    expect(out.inserted).toBe(true)
    expect(calls[0].text).toContain('INSERT INTO oauth_grants')
    expect(calls[0].text).toContain('ON CONFLICT')
    // R3-H5: same-uid conflict no-ops (first bootstrapper wins), a DIFFERENT uid /
    // legacy row is replaced — expressed as DO UPDATE guarded on cr_uid DISTINCT.
    expect(calls[0].text).toContain('DO UPDATE SET')
    expect(calls[0].text).toContain('oauth_grants.cr_uid IS DISTINCT FROM EXCLUDED.cr_uid')
    expect(calls[0].text).toContain('bootstrapped_by_user_id')
    expect(calls[0].text).toContain("'shared'")
    // owner, ns, name, contextId, clientId, bootstrappedBy are bound in order,
    // and cr_uid is the last bound param.
    expect(calls[0].values.slice(0, 6)).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'ctx-9',
      'google-drive',
      'user-1',
    ])
    expect((calls[0].values as unknown[]).at(-1)).toBe('uid-1')
  })

  it('bootstrapSharedOAuthGrant reports inserted=false when the conflict no-ops', async () => {
    const { db } = fakeDb([], 0)
    const out = await bootstrapSharedOAuthGrant(db, KEY, {
      ...SHARED_KEY,
      bootstrappedByUserId: 'user-2',
      provider: 'google',
      accessToken: 'A',
    })
    expect(out.inserted).toBe(false)
  })

  it('refreshOAuthGrantTokens(shared) is a plain UPDATE by key and never touches bootstrapped_by_user_id', async () => {
    // R1-B1: the shared "Refresh path ONLY" UPDATE now lives in
    // refreshOAuthGrantTokens (folded out of upsertOAuthGrant); upsertOAuthGrant
    // rejects shared grants (asserted below).
    const { db, calls } = fakeDb([{ id: 1 }], 1)
    const out = await refreshOAuthGrantTokens(db, KEY, {
      ...SHARED_KEY,
      provider: 'google',
      accessToken: 'A2',
      refreshToken: 'R2',
      accessTokenExpiresInSec: 3600,
    })
    expect(out.updated).toBe(true)
    expect(calls[0].text).toContain('UPDATE oauth_grants')
    expect(calls[0].text).toContain('RETURNING id')
    expect(calls[0].text).not.toContain('INSERT INTO oauth_grants')
    expect(calls[0].text).not.toContain('bootstrapped_by_user_id')
    expect(calls[0].text).toContain("grant_kind = 'shared'")
    expect(calls[0].values.slice(0, 5)).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'ctx-9',
      'google-drive',
    ])
  })

  it('refreshOAuthGrantTokens returns updated=false when no row matched (grant deleted mid-refresh)', async () => {
    const { db } = fakeDb([], 0)
    const out = await refreshOAuthGrantTokens(db, KEY, {
      ...SHARED_KEY,
      provider: 'google',
      accessToken: 'A2',
    })
    expect(out.updated).toBe(false)
  })

  it('upsertOAuthGrant rejects a shared grant (consent uses bootstrapSharedOAuthGrant)', async () => {
    const { db } = fakeDb()
    await expect(
      upsertOAuthGrant(db, KEY, { ...SHARED_KEY, provider: 'google', accessToken: 'A2' })
    ).rejects.toThrow('does not handle shared grants')
  })

  it('getOAuthGrant(shared) filters owner_kind + context_id + grant_kind=shared and maps audit columns', async () => {
    const { db, calls } = fakeDb([
      {
        owner_kind: 'mcpserver',
        recipe_namespace: 'mcp-server',
        recipe_name: 'gdrive',
        user_id: null,
        context_id: 'ctx-9',
        bootstrapped_by_user_id: 'user-1',
        oauth_client_id: 'google-drive',
        grant_kind: 'shared',
        provider: 'google',
        access_token_encrypted: (await import('../src/oauth/encryption.js')).encryptOAuthSecret(
          KEY,
          'A'
        ),
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        updated_at: new Date(),
        background: false,
        cr_uid: 'uid-1',
      },
    ])
    const row = await getOAuthGrant(db, KEY, SHARED_READ_KEY)
    expect(row?.grantKind).toBe('shared')
    expect(row?.ownerKind).toBe('mcpserver')
    expect(row?.contextId).toBe('ctx-9')
    expect(row?.bootstrappedByUserId).toBe('user-1')
    expect(row?.accessToken).toBe('A')
    expect(row?.crUid).toBe('uid-1')
    expect(calls[0].text).toContain("grant_kind = 'shared'")
    expect(calls[0].text).toContain('context_id = $4')
    expect(calls[0].text).toContain('AND cr_uid = $6')
    expect(calls[0].text).not.toContain('cr_uid IS NULL')
    expect(calls[0].values).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'ctx-9',
      'google-drive',
      'uid-1',
    ])
  })

  it('oauthGrantExists(shared) is scoped to the context key and the installation', async () => {
    const { db, calls } = fakeDb([{ '?column?': 1 }])
    const exists = await oauthGrantExists(db, SHARED_READ_KEY)
    expect(exists).toBe(true)
    expect(calls[0].text).toContain("grant_kind = 'shared'")
    expect(calls[0].text).toContain('AND cr_uid = $6')
    expect(calls[0].text).not.toContain('cr_uid IS NULL')
    expect(calls[0].values).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'ctx-9',
      'google-drive',
      'uid-1',
    ])
  })

  it('a baked reader key also admits unsealed rows of its own provider only (shared)', async () => {
    const key = bakedReaderKey('context')
    for (const read of [
      (db: DbClient) => getOAuthGrant(db, KEY, key),
      (db: DbClient) => oauthGrantExists(db, key),
    ]) {
      const { db, calls } = fakeDb()
      await read(db)
      expect(calls[0].text).toContain('AND (cr_uid = $6 OR (cr_uid IS NULL AND provider = $7))')
      expect(calls[0].values).toEqual([
        'mcpserver',
        'mcp-server',
        'gdrive',
        'ctx-9',
        'google-drive',
        'uid-1',
        'google',
      ])
    }
  })

  it('an mcp-server reader key without a uid matches nothing and issues no query', async () => {
    const { db, calls } = fakeDb([{ '?column?': 1 }])
    expect(await oauthGrantExists(db, SHARED_KEY)).toBe(false)
    expect(await getOAuthGrant(db, KEY, SHARED_KEY)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('deleteOAuthGrant(shared) deletes the single shared row by context key', async () => {
    const { db, calls } = fakeDb()
    await deleteOAuthGrant(db, SHARED_KEY)
    expect(calls[0].text).toContain('DELETE FROM oauth_grants')
    expect(calls[0].text).toContain("grant_kind = 'shared'")
    expect(calls[0].values).toEqual(['mcpserver', 'mcp-server', 'gdrive', 'ctx-9', 'google-drive'])
  })
})

describe('oauth store — owner_kind on user/service ops (recipe domain unchanged)', () => {
  it('upsertOAuthGrant(user) defaults owner_kind=recipe and includes it in the conflict target', async () => {
    const { db, calls } = fakeDb()
    await upsertOAuthGrant(db, KEY, {
      grantKind: 'user',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      userId: 'user-1',
      oauthClientId: 'google-gmail',
      provider: 'google',
      accessToken: 'A',
    })
    expect(calls[0].text).toContain('owner_kind')
    expect(calls[0].text).toContain(
      'ON CONFLICT (owner_kind, recipe_namespace, recipe_name, user_id, oauth_client_id)'
    )
    expect(calls[0].values[0]).toBe('recipe')
  })

  it('getOAuthGrant(user) with explicit ownerKind=mcpserver scopes the lookup', async () => {
    const { db, calls } = fakeDb()
    await getOAuthGrant(db, KEY, {
      grantKind: 'user',
      ownerKind: 'mcpserver',
      recipeNamespace: 'mcp-server',
      recipeName: 'gdrive',
      userId: 'user-1',
      oauthClientId: 'google-drive',
      crUid: 'uid-1',
    })
    expect(calls[0].text).toContain('owner_kind = $1')
    expect(calls[0].text).toContain('AND cr_uid = $6')
    expect(calls[0].text).not.toContain('cr_uid IS NULL')
    expect(calls[0].values).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'user-1',
      'google-drive',
      'uid-1',
    ])
  })

  it('getOAuthGrant(user) with a baked reader key admits unsealed rows of its provider', async () => {
    const { db, calls } = fakeDb()
    await getOAuthGrant(db, KEY, bakedReaderKey('user', 'user-1'))
    expect(calls[0].text).toContain('AND (cr_uid = $6 OR (cr_uid IS NULL AND provider = $7))')
    expect(calls[0].values).toEqual([
      'mcpserver',
      'mcp-server',
      'gdrive',
      'user-1',
      'google-drive',
      'uid-1',
      'google',
    ])
  })

  it('getOAuthGrant(user) in the recipe domain carries no installation fence', async () => {
    const { db, calls } = fakeDb()
    await getOAuthGrant(db, KEY, {
      grantKind: 'user',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      userId: 'user-1',
      oauthClientId: 'google-gmail',
    })
    expect(calls[0].text).not.toContain('cr_uid =')
    expect(calls[0].values).toEqual([
      'recipe',
      'sandbox-recipes',
      'leadforge',
      'user-1',
      'google-gmail',
    ])
  })
})
