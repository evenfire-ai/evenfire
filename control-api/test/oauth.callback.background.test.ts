import { describe, it, expect, vi } from 'vitest'
import { handleOAuthCallback } from '../src/oauth/callback.js'
import { renderSuccessHtml } from '../src/routes/external/oauthCallback.js'
import { signOAuthState } from '../src/oauth/state.js'
import * as store from '../src/oauth/store.js'

const SECRET = 'x'.repeat(40)
const recipe = {
  spec: { oauthClients: [
    { id: 'google-gmail', provider: 'google',
      clientIdRef: { name: 's', key: 'client-id' },
      clientSecretRef: { name: 's', key: 'client-secret' } },
  ] },
}
function deps(tokenJson: object) {
  return {
    db: { query: async () => ({ rows: [] }) } as never,
    recipeReader: { read: async () => recipe },
    secretReader: { read: async () => ({ 'client-id': 'cid', 'client-secret': 'sec' }) },
    fetchFn: (async () => new Response(JSON.stringify(tokenJson), { status: 200 })) as typeof fetch,
    stateSecret: SECRET,
    encryptionKey: Buffer.alloc(32),
  }
}
const input = (background: boolean) => ({
  oauthClientId: 'google-gmail',
  code: 'code', redirectUri: 'https://api/cb',
  state: signOAuthState(SECRET, {
    recipeNamespace: 'sandbox-recipes', recipeName: 'leadforge', userId: 'user-1',
    oauthClientId: 'google-gmail', grantKind: 'user', background,
  }),
})

describe('handleOAuthCallback background', () => {
  it('sets background=true when consented AND a refresh token is returned', async () => {
    const spy = vi.spyOn(store, 'setUserGrantBackground').mockResolvedValue()
    vi.spyOn(store, 'upsertOAuthGrant').mockResolvedValue()
    const res = await handleOAuthCallback(input(true), deps({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.backgroundRequested).toBe(true)
      expect(res.backgroundEnabled).toBe(true)
    }
    expect(spy).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ userId: 'user-1', oauthClientId: 'google-gmail' }), true)
    spy.mockRestore()
  })

  it('does NOT set background when consented but NO refresh token returned', async () => {
    const spy = vi.spyOn(store, 'setUserGrantBackground').mockResolvedValue()
    vi.spyOn(store, 'upsertOAuthGrant').mockResolvedValue()
    const res = await handleOAuthCallback(input(true), deps({ access_token: 'a' }))
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.backgroundRequested).toBe(true)
      expect(res.backgroundEnabled).toBe(false)
    }
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('never sets background for a non-background (plain) connect', async () => {
    const spy = vi.spyOn(store, 'setUserGrantBackground').mockResolvedValue()
    vi.spyOn(store, 'upsertOAuthGrant').mockResolvedValue()
    const res = await handleOAuthCallback(input(false), deps({ access_token: 'a', refresh_token: 'r' }))
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.backgroundRequested).toBe(false)
      expect(res.backgroundEnabled).toBe(false)
    }
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('renderSuccessHtml — background status line', () => {
  it('includes "Background access enabled" copy when backgroundEnabled=true', () => {
    const html = renderSuccessHtml('google', 'google-bot', {
      backgroundRequested: true,
      backgroundEnabled: true,
    })
    expect(html).toContain('Background access enabled')
    expect(html).toContain('manage under Connected accounts')
  })

  it('includes "could not be enabled" copy when backgroundRequested=true and backgroundEnabled=false', () => {
    const html = renderSuccessHtml('google', 'google-bot', {
      backgroundRequested: true,
      backgroundEnabled: false,
    })
    expect(html).toContain('could not be enabled')
    expect(html).toContain('Reconnect to try again')
    expect(html).not.toContain('Background access enabled')
  })

  it('adds no background status line when opts are omitted (plain connect)', () => {
    const html = renderSuccessHtml('google', 'google-bot')
    expect(html).not.toContain('Background access')
    expect(html).not.toContain('could not be enabled')
  })
})
