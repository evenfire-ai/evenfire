import type { OAuthClientDecl, RecipeWithOAuthClients } from './callback.js'

/**
 * Resolve one recipe OAuth client by its canonical id.
 *
 * Both a missing id and an ambiguous duplicate id fail closed. Provider names
 * are deliberately not part of identity: distinct client ids may share one
 * provider.
 */
export function resolveExactRecipeOAuthClient(
  recipe: RecipeWithOAuthClients,
  oauthClientId: string
): OAuthClientDecl | null {
  const matches = (recipe.spec?.oauthClients ?? []).filter(client => client.id === oauthClientId)
  return matches.length === 1 ? matches[0] : null
}
