import { createHash, randomBytes } from 'node:crypto'
import { CANONICAL_GUID_RE } from './validation.js'

export const MICROSOFT_PROVIDER_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'User.Read.All',
  'GroupMember.Read.All',
] as const

const MICROSOFT_GRAPH_ORIGIN = 'https://graph.microsoft.com'
const MAX_GRAPH_PAGES = 50
const MAX_GRAPH_ATTEMPTS = 4
const MAX_GRAPH_RETRY_DELAY_MS = 5_000

export type MicrosoftTokenResponse = {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
  scope: string[]
}

export type MicrosoftGraphUser = {
  id: string
  displayName: string
  mail: string
  userPrincipalName: string
  accountEnabled: boolean
}

export type MicrosoftGraphTeam = {
  id: string
  displayName: string
  description: string
}

type FetchLike = typeof fetch

type GraphCollection<T> = {
  value?: T[]
  '@odata.nextLink'?: string
}

function microsoftAuthority(tenantId: string): string {
  const normalized = tenantId.trim()
  if (!CANONICAL_GUID_RE.test(normalized)) {
    throw new Error('Microsoft directory tenant ID must be a UUID')
  }
  return `https://login.microsoftonline.com/${normalized}/oauth2/v2.0`
}

export function createPkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function buildMicrosoftAuthorizeUrl(input: {
  tenantId: string
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  prompt?: 'select_account' | 'consent'
}): string {
  const url = new URL(`${microsoftAuthority(input.tenantId)}/authorize`)
  url.searchParams.set('client_id', input.clientId.trim())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', MICROSOFT_PROVIDER_SCOPES.join(' '))
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', input.prompt || 'select_account')
  return url.toString()
}

async function tokenRequest(
  tenantId: string,
  body: URLSearchParams,
  fetchFn: FetchLike
): Promise<MicrosoftTokenResponse> {
  const response = await fetchFn(`${microsoftAuthority(tenantId)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
    scope?: unknown
    error?: unknown
    error_description?: unknown
  } | null
  if (!response.ok || typeof payload?.access_token !== 'string') {
    const detail = String(payload?.error_description || payload?.error || response.statusText)
    throw new Error(`Microsoft token exchange failed: ${detail}`)
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresIn: Number(payload.expires_in || 3600),
    scope: String(payload.scope || '')
      .split(/\s+/)
      .filter(Boolean),
  }
}

export function exchangeMicrosoftAuthorizationCode(
  input: {
    tenantId: string
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    codeVerifier: string
  },
  fetchFn: FetchLike = fetch
): Promise<MicrosoftTokenResponse> {
  return tokenRequest(
    input.tenantId,
    new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      scope: MICROSOFT_PROVIDER_SCOPES.join(' '),
    }),
    fetchFn
  )
}

export function refreshMicrosoftAccessToken(
  input: {
    tenantId: string
    clientId: string
    clientSecret: string
    refreshToken: string
  },
  fetchFn: FetchLike = fetch
): Promise<MicrosoftTokenResponse> {
  return tokenRequest(
    input.tenantId,
    new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      scope: MICROSOFT_PROVIDER_SCOPES.join(' '),
    }),
    fetchFn
  )
}

async function graphJson<T>(
  pathOrUrl: string,
  accessToken: string,
  fetchFn: FetchLike
): Promise<T> {
  const url = new URL(pathOrUrl, `${MICROSOFT_GRAPH_ORIGIN}/v1.0/`)
  if (url.origin !== MICROSOFT_GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/')) {
    throw new Error('Microsoft Graph returned an invalid continuation URL')
  }
  for (let attempt = 1; attempt <= MAX_GRAPH_ATTEMPTS; attempt += 1) {
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null
    if (response.ok && payload) return payload

    const retryable = [429, 502, 503, 504].includes(response.status)
    if (!retryable || attempt === MAX_GRAPH_ATTEMPTS) {
      throw new Error(
        `Microsoft Graph request failed: ${payload?.error?.message || response.statusText}`
      )
    }
    const retryAfter = String(response.headers.get('retry-after') || '').trim()
    const retryAfterSeconds = Number(retryAfter)
    const retryAfterDate = Date.parse(retryAfter)
    const requestedDelay = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1_000
      : Number.isFinite(retryAfterDate)
        ? Math.max(0, retryAfterDate - Date.now())
        : 250 * 2 ** (attempt - 1)
    await new Promise(resolve =>
      setTimeout(resolve, Math.min(MAX_GRAPH_RETRY_DELAY_MS, Math.max(0, requestedDelay)))
    )
  }
  throw new Error('Microsoft Graph request failed')
}

async function graphCollection<T>(
  path: string,
  accessToken: string,
  fetchFn: FetchLike
): Promise<T[]> {
  const items: T[] = []
  let next: string | null = path
  let pages = 0
  while (next && pages < MAX_GRAPH_PAGES) {
    const payload: GraphCollection<T> = await graphJson<GraphCollection<T>>(
      next,
      accessToken,
      fetchFn
    )
    items.push(...(Array.isArray(payload.value) ? payload.value : []))
    next = typeof payload['@odata.nextLink'] === 'string' ? payload['@odata.nextLink'] : null
    pages += 1
  }
  if (next) throw new Error('Microsoft Graph directory result exceeded the supported page limit')
  return items
}

export async function getMicrosoftCurrentUser(
  accessToken: string,
  fetchFn: FetchLike = fetch
): Promise<MicrosoftGraphUser> {
  const user = await graphJson<Record<string, unknown>>(
    '/v1.0/me?$select=id,displayName,mail,userPrincipalName,accountEnabled',
    accessToken,
    fetchFn
  )
  const id = String(user.id || '').trim()
  const userPrincipalName = String(user.userPrincipalName || '')
    .trim()
    .toLowerCase()
  if (!id || !userPrincipalName) throw new Error('Microsoft Graph user identity is incomplete')
  return {
    id,
    displayName: String(user.displayName || userPrincipalName).trim(),
    mail: String(user.mail || '')
      .trim()
      .toLowerCase(),
    userPrincipalName,
    accountEnabled: user.accountEnabled !== false,
  }
}

export async function listMicrosoftUsers(
  accessToken: string,
  fetchFn: FetchLike = fetch
): Promise<MicrosoftGraphUser[]> {
  const users = await graphCollection<Record<string, unknown>>(
    '/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=999',
    accessToken,
    fetchFn
  )
  return users
    .map(user => ({
      id: String(user.id || '').trim(),
      displayName: String(user.displayName || user.userPrincipalName || '').trim(),
      mail: String(user.mail || '')
        .trim()
        .toLowerCase(),
      userPrincipalName: String(user.userPrincipalName || '')
        .trim()
        .toLowerCase(),
      accountEnabled: user.accountEnabled !== false,
    }))
    .filter(user => user.id && user.userPrincipalName)
}

export async function listMicrosoftTeams(
  accessToken: string,
  fetchFn: FetchLike = fetch
): Promise<MicrosoftGraphTeam[]> {
  const groups = await graphCollection<Record<string, unknown>>(
    "/v1.0/groups?$filter=resourceProvisioningOptions/Any(x:x%20eq%20'Team')&$select=id,displayName,description&$top=999",
    accessToken,
    fetchFn
  )
  return groups
    .map(group => ({
      id: String(group.id || '').trim(),
      displayName: String(group.displayName || '').trim(),
      description: String(group.description || '').trim(),
    }))
    .filter(group => group.id && group.displayName)
}

export async function listMicrosoftTeamMemberIds(
  accessToken: string,
  teamId: string,
  fetchFn: FetchLike = fetch
): Promise<string[]> {
  if (!CANONICAL_GUID_RE.test(teamId)) throw new Error('Invalid Microsoft Team ID')
  const members = await graphCollection<Record<string, unknown>>(
    `/v1.0/groups/${encodeURIComponent(teamId)}/members/microsoft.graph.user?$select=id&$top=999`,
    accessToken,
    fetchFn
  )
  return members.map(member => String(member.id || '').trim()).filter(Boolean)
}
