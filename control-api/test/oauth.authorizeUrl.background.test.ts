import { describe, it, expect } from 'vitest'
import { buildAuthorizeUrl } from '../src/oauth/authorizeUrlHelper.js'

const recipe = {
  spec: {
    oauthClients: [
      { id: 'google-gmail', provider: 'google',
        clientIdRef: { name: 's', key: 'client-id' },
        clientSecretRef: { name: 's', key: 'client-secret' },
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'], backgroundAccess: true },
    ],
  },
}
const deps = {
  recipeReader: { read: async () => recipe },
  secretReader: { read: async () => ({ 'client-id': 'cid' }) },
  stateSecret: 'x'.repeat(40),
}

describe('buildAuthorizeUrl background', () => {
  it('encodes background=true into the signed state', async () => {
    const result = await buildAuthorizeUrl(
      { recipeNamespace: 'sandbox-recipes', recipeName: 'leadforge',
        oauthClientId: 'google-gmail', userId: 'user-1', grantKind: 'user',
        redirectUri: 'https://api/cb', background: true },
      deps as never
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const state = new URL(result.authorizeUrl).searchParams.get('state')!
    const payload = JSON.parse(Buffer.from(state.split('.')[1], 'base64url').toString('utf8'))
    expect(payload.background).toBe(true)
  })
})

const recipeNoBackgroundAccess = {
  spec: {
    oauthClients: [
      { id: 'google-gmail', provider: 'google',
        clientIdRef: { name: 's', key: 'client-id' },
        clientSecretRef: { name: 's', key: 'client-secret' },
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
      // NOTE: backgroundAccess is intentionally absent
    ],
  },
}
const depsNoBackground = {
  recipeReader: { read: async () => recipeNoBackgroundAccess },
  secretReader: { read: async () => ({ 'client-id': 'cid' }) },
  stateSecret: 'x'.repeat(40),
}

describe('buildAuthorizeUrl background_access_not_enabled guard', () => {
  it('returns background_access_not_enabled for user grantKind with background:true when recipe lacks backgroundAccess', async () => {
    const result = await buildAuthorizeUrl(
      { recipeNamespace: 'sandbox-recipes', recipeName: 'leadforge',
        oauthClientId: 'google-gmail', userId: 'user-1', grantKind: 'user',
        redirectUri: 'https://api/cb', background: true },
      depsNoBackground as never
    )
    expect(result.kind).toBe('background_access_not_enabled')
  })

  it('allows user grantKind with background:false (or omitted) when recipe lacks backgroundAccess', async () => {
    const result = await buildAuthorizeUrl(
      { recipeNamespace: 'sandbox-recipes', recipeName: 'leadforge',
        oauthClientId: 'google-gmail', userId: 'user-1', grantKind: 'user',
        redirectUri: 'https://api/cb', background: false },
      depsNoBackground as never
    )
    expect(result.kind).toBe('ok')
  })
})
