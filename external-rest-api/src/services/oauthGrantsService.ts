import { controlApiRequest, controlApiRequestWithStatus } from '../controlApiClient.js'

export interface OauthGrantSummary {
  ownerKind: 'recipe' | 'mcpserver'
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: string
  mcpServerName?: string
}

export async function listOauthGrants(
  sessionToken: string
): Promise<{ grants: OauthGrantSummary[] }> {
  return controlApiRequest('GET', '/external/oauth/grants', { userSessionToken: sessionToken })
}

export async function revokeOauthGrant(
  sessionToken: string,
  recipeNamespace: string,
  recipeName: string,
  oauthClientId: string,
  ownerKind?: string
): Promise<void> {
  const enc = encodeURIComponent
  await controlApiRequestWithStatus<null>(
    'DELETE',
    `/external/oauth/grants/${enc(recipeNamespace)}/${enc(recipeName)}/${enc(oauthClientId)}`,
    // ownerKind is propagated verbatim; control-api validates it (400 on an
    // invalid value) and forces the owner namespace server-side.
    { userSessionToken: sessionToken, query: ownerKind ? { ownerKind } : undefined }
  )
}
