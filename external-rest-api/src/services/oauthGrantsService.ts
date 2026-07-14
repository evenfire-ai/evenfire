import { controlApiRequest, controlApiRequestWithStatus } from '../controlApiClient.js'

export interface OauthGrantSummary {
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: string
}

export async function listOauthGrants(sessionToken: string): Promise<{ grants: OauthGrantSummary[] }> {
  return controlApiRequest('GET', '/external/oauth/grants', { userSessionToken: sessionToken })
}

export async function revokeOauthGrant(
  sessionToken: string,
  recipeNamespace: string,
  recipeName: string,
  oauthClientId: string
): Promise<void> {
  const enc = encodeURIComponent
  await controlApiRequestWithStatus<null>(
    'DELETE',
    `/external/oauth/grants/${enc(recipeNamespace)}/${enc(recipeName)}/${enc(oauthClientId)}`,
    { userSessionToken: sessionToken }
  )
}
