import { apiGet, apiSend } from './api'

export interface ConnectedAccount {
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: string
}

export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const res = (await apiGet('/api/v1/oauth/grants')) as { grants: ConnectedAccount[] }
  return Array.isArray(res.grants) ? res.grants : []
}

export async function revokeConnectedAccount(a: ConnectedAccount): Promise<void> {
  await apiSend(
    'DELETE',
    `/api/v1/oauth/grants/${encodeURIComponent(a.recipeNamespace)}/${encodeURIComponent(a.recipeName)}/${encodeURIComponent(a.oauthClientId)}`
  )
}
