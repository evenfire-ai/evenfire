import { describe, expect, it } from 'vitest'
import type { DbClient } from '../src/db.js'
import { listUserGrantsForClient, listUserOAuthGrants } from '../src/oauth/store.js'

function fakeDb(rows: unknown[]): { db: DbClient; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = []
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows } as never
    },
  } as unknown as DbClient
  return { db, calls }
}

describe('store list', () => {
  it('listUserOAuthGrants defaults to the recipe domain and maps rows (byte-identical, + ownerKind)', async () => {
    const { db, calls } = fakeDb([
      {
        owner_kind: 'recipe',
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'leadforge',
        oauth_client_id: 'google-gmail',
        provider: 'google',
        background: true,
        updated_at: new Date('2026-06-01'),
      },
    ])
    const out = await listUserOAuthGrants(db, 'user-1')
    expect(calls[0].text).toContain("grant_kind = 'user'")
    // The default filters to the recipe owner domain (invariant 3).
    expect(calls[0].text).toContain('owner_kind = $2')
    expect(calls[0].values).toEqual(['user-1', 'recipe'])
    expect(out[0]).toEqual({
      ownerKind: 'recipe',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      oauthClientId: 'google-gmail',
      provider: 'google',
      background: true,
      updatedAt: new Date('2026-06-01'),
    })
    // Recipe grants carry no mcpServerName.
    expect(out[0]).not.toHaveProperty('mcpServerName')
  })

  it("listUserOAuthGrants('all') drops the owner filter and derives mcpServerName for mcpserver rows", async () => {
    const { db, calls } = fakeDb([
      {
        owner_kind: 'mcpserver',
        recipe_namespace: 'mcp-servers',
        recipe_name: 'gdrive',
        oauth_client_id: 'self://url',
        provider: 'remote',
        background: false,
        updated_at: new Date('2026-06-03'),
      },
    ])
    const out = await listUserOAuthGrants(db, 'user-1', 'all')
    // No owner_kind filter and no owner param when listing all domains.
    expect(calls[0].text).not.toContain('owner_kind =')
    expect(calls[0].values).toEqual(['user-1'])
    expect(out[0]).toEqual({
      ownerKind: 'mcpserver',
      recipeNamespace: 'mcp-servers',
      recipeName: 'gdrive',
      oauthClientId: 'self://url',
      provider: 'remote',
      background: false,
      updatedAt: new Date('2026-06-03'),
      mcpServerName: 'gdrive',
    })
  })

  it('listUserGrantsForClient scopes to recipe+client and returns userId+background', async () => {
    const { db, calls } = fakeDb([
      { user_id: 'a', background: true, updated_at: new Date('2026-06-02') },
    ])
    const out = await listUserGrantsForClient(db, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      oauthClientId: 'google-gmail',
    })
    expect(calls[0].values).toEqual(['sandbox-recipes', 'leadforge', 'google-gmail'])
    expect(out).toEqual([{ userId: 'a', background: true, updatedAt: new Date('2026-06-02') }])
  })
})
