import { describe, it, expect } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  setUserGrantBackground,
  listBackgroundUserGrants,
  getOAuthGrant,
  oauthGrantExists,
} from '../src/oauth/store.js'

function fakeDb(rows: unknown[] = []): { db: DbClient; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = []
  const db: DbClient = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows, rowCount: rows.length } as never
    },
  } as unknown as DbClient
  return { db, calls }
}

const KEY = {
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'leadforge',
  userId: 'user-1',
  oauthClientId: 'google-gmail',
}

describe('store background', () => {
  it('setUserGrantBackground issues an UPDATE scoped to the user grant', async () => {
    const { db, calls } = fakeDb()
    await setUserGrantBackground(db, KEY, true)
    expect(calls[0].text).toContain('UPDATE oauth_grants')
    expect(calls[0].text).toContain("grant_kind = 'user'")
    expect(calls[0].values).toEqual([
      'sandbox-recipes', 'leadforge', 'user-1', 'google-gmail', true,
    ])
  })

  it('listBackgroundUserGrants filters by background=true user grants and returns userIds', async () => {
    const { db, calls } = fakeDb([{ user_id: 'a' }, { user_id: 'b' }])
    const ids = await listBackgroundUserGrants(db, {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'leadforge',
      oauthClientId: 'google-gmail',
    })
    expect(ids).toEqual(['a', 'b'])
    expect(calls[0].text).toContain('background = true')
    expect(calls[0].text).toContain("grant_kind = 'user'")
  })

  it('getOAuthGrant with requireBackground adds the background filter', async () => {
    const { db, calls } = fakeDb([])
    await getOAuthGrant(db, Buffer.alloc(32), { ...KEY, grantKind: 'user', requireBackground: true })
    expect(calls[0].text).toContain('AND background = true')
  })

  it('getOAuthGrant without requireBackground does NOT filter on background', async () => {
    const { db, calls } = fakeDb([])
    await getOAuthGrant(db, Buffer.alloc(32), { ...KEY, grantKind: 'user' })
    expect(calls[0].text).not.toContain('background = true')
  })

  it('oauthGrantExists with requireBackground adds the background filter', async () => {
    const { db, calls } = fakeDb([])
    await oauthGrantExists(db, { ...KEY, grantKind: 'user', requireBackground: true })
    expect(calls[0].text).toContain('AND background = true')
  })

  it('oauthGrantExists without requireBackground does NOT filter on background', async () => {
    const { db, calls } = fakeDb([])
    await oauthGrantExists(db, { ...KEY, grantKind: 'user' })
    expect(calls[0].text).not.toContain('background = true')
  })
})
