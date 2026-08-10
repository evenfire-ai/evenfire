import { describe, it, expect } from 'vitest'
import type { DbClient } from '../src/db.js'
import { listUserOAuthGrants, listUserGrantsForClient } from '../src/oauth/store.js'

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
  it('listUserOAuthGrants scopes to the user and maps rows', async () => {
    const { db, calls } = fakeDb([
      {
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
    expect(calls[0].values).toEqual(['user-1'])
    expect(out[0]).toEqual({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      oauthClientId: 'google-gmail',
      provider: 'google',
      background: true,
      updatedAt: new Date('2026-06-01'),
    })
  })

  it('listUserGrantsForClient scopes to recipe+client and returns userId+background', async () => {
    const { db, calls } = fakeDb([{ user_id: 'a', background: true, updated_at: new Date('2026-06-02') }])
    const out = await listUserGrantsForClient(db, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      oauthClientId: 'google-gmail',
    })
    expect(calls[0].values).toEqual(['sandbox-recipes', 'leadforge', 'google-gmail'])
    expect(out).toEqual([{ userId: 'a', background: true, updatedAt: new Date('2026-06-02') }])
  })
})
