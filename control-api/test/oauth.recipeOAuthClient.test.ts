import { describe, expect, it } from 'vitest'
import type { OAuthClientDecl, RecipeWithOAuthClients } from '../src/oauth/callback.js'
import { resolveExactRecipeOAuthClient } from '../src/oauth/recipeOAuthClient.js'

function client(id: string, provider: string): OAuthClientDecl {
  return {
    id,
    provider,
    clientIdRef: { name: `${id}-secret`, key: 'client_id' },
    clientSecretRef: { name: `${id}-secret`, key: 'client_secret' },
  }
}

function recipe(oauthClients: OAuthClientDecl[]): RecipeWithOAuthClients {
  return { spec: { oauthClients } }
}

describe('resolveExactRecipeOAuthClient', () => {
  it('selects one exact id when multiple clients share a provider', () => {
    const expected = client('google-calendar', 'google')
    expect(
      resolveExactRecipeOAuthClient(
        recipe([client('google-drive', 'google'), expected]),
        'google-calendar'
      )
    ).toBe(expected)
  })

  it('fails closed for an unknown id', () => {
    expect(
      resolveExactRecipeOAuthClient(recipe([client('google', 'google')]), 'missing')
    ).toBeNull()
  })

  it('fails closed when the current recipe declares the id more than once', () => {
    expect(
      resolveExactRecipeOAuthClient(
        recipe([client('google', 'google'), client('google', 'google')]),
        'google'
      )
    ).toBeNull()
  })
})
