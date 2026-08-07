import { describe, expect, it, vi } from 'vitest'
import * as store from '../src/oauth/store.js'
import { getAccessToken } from '../src/oauth/tokenHelper.js'

const deps = {
  db: { query: async () => ({ rows: [] }) } as never,
  recipeReader: { read: async () => null },
  secretReader: { read: async () => ({}) },
  fetchFn: (async () => new Response('{}')) as typeof fetch,
  encryptionKey: Buffer.alloc(32),
}

describe('getAccessToken requireBackground', () => {
  it('passes requireBackground through to getOAuthGrant', async () => {
    const spy = vi.spyOn(store, 'getOAuthGrant').mockResolvedValue(null)
    await getAccessToken(
      {
        grantKind: 'user',
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'leadforge',
        userId: 'user-1',
        oauthClientId: 'google-gmail',
        requireBackground: true,
      },
      deps
    )
    expect(spy).toHaveBeenCalledWith(
      deps.db,
      deps.encryptionKey,
      expect.objectContaining({ requireBackground: true })
    )
    spy.mockRestore()
  })
})
