import { apiGet, apiSend } from './api'

export type OAuthOwnerKind = 'recipe' | 'mcpserver'

export interface ConnectedAccount {
  ownerKind: OAuthOwnerKind
  recipeNamespace: string
  recipeName: string
  oauthClientId: string
  provider: string
  background: boolean
  updatedAt: string
  // Present only when ownerKind === 'mcpserver'; equals recipeName.
  mcpServerName?: string
}

export interface GrantSource {
  // Owner-kind label, never inferred from the resource name.
  typeLabel: string
  // Provider detail to show as the row subtitle, or null when the provider is a
  // raw remote-lane token that would be meaningless to the user (the server
  // name already identifies the grant).
  detail: string | null
}

// mcp-server grants on the remote/generic lane carry a synthetic provider token
// (see fase-7.2 DEC-R2 §2). It is not a recognizable third-party account name,
// so it must not surface raw in the UI.
const RAW_MCP_SERVER_PROVIDERS = new Set(['remote', 'generic'])

export function connectedAccountKey(a: ConnectedAccount): string {
  return `${a.ownerKind}/${a.recipeNamespace}/${a.recipeName}/${a.oauthClientId}`
}

export function connectedAccountName(a: ConnectedAccount): string {
  return a.mcpServerName ?? a.recipeName
}

export function describeGrantSource(a: ConnectedAccount): GrantSource {
  if (a.ownerKind === 'mcpserver') {
    const showsRawProvider = RAW_MCP_SERVER_PROVIDERS.has(a.provider)
    return { typeLabel: 'MCP server', detail: showsRawProvider ? null : a.provider }
  }
  return { typeLabel: 'Plugin', detail: a.provider }
}

export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const res = (await apiGet('/api/v1/oauth/grants')) as { grants?: ConnectedAccount[] }
  const grants = Array.isArray(res.grants) ? res.grants : []
  // Default to the recipe lane when ownerKind is absent, preserving the
  // pre-owner-generalization behavior for any grant that predates the field.
  return grants.map(g => ({
    ...g,
    ownerKind: g.ownerKind === 'mcpserver' ? 'mcpserver' : 'recipe',
  }))
}

export async function revokeConnectedAccount(a: ConnectedAccount): Promise<void> {
  await apiSend(
    'DELETE',
    `/api/v1/oauth/grants/${encodeURIComponent(a.recipeNamespace)}/${encodeURIComponent(a.recipeName)}/${encodeURIComponent(a.oauthClientId)}`,
    undefined,
    { ownerKind: a.ownerKind }
  )
}
