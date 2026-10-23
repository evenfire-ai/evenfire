import { ControlApiError, controlApiRequest } from '../controlApiClient.js'

type AuthContext = {
  userId: string
  email: string
  sessionToken: string
}

function passwordAuthorityUnavailable(): ControlApiError {
  return new ControlApiError(
    'Password recovery authority unavailable',
    503,
    { error: 'authority_unavailable' },
    { 'retry-after': '2' }
  )
}

export type InvitationPreview = {
  id: string
  teamId: string | null
  teamName: string | null
  teams?: Array<{ id: string; name: string; role: string }>
  email: string
  role: string
  purpose?: 'member_invitation' | 'password_reset' | 'admin_desktop_access'
  status: string
  expiresAt: string
  acceptedAt: string | null
  userId: string | null
  passwordPending: boolean
}

export async function listPendingInvitations(email: string, sessionToken: string) {
  const result = await controlApiRequest<{ items: unknown[] }>(
    'GET',
    '/external/invitations/pending',
    {
      query: { email: email.toLowerCase() },
      userSessionToken: sessionToken,
    }
  )
  return result.items
}

export async function acceptInvitation(
  token: string,
  email: string,
  sessionContract?: 'v2'
): Promise<{
  error?: 'not_found' | 'forbidden' | 'not_pending' | 'expired' | 'invalid'
  data?: {
    accepted: true
    teamId: string | null
    teamName: string | null
    teams?: Array<{ id: string; name: string; role: string }>
    role: string
    email: string
    userId: string
    // A replay of an already accepted invitation is an explicit success without
    // a session: control-api does not mint one for a token that no longer
    // proves a pending capability.
    replay?: true
    token?: string
  }
}> {
  try {
    const data = await controlApiRequest<{
      accepted: true
      teamId: string | null
      teamName: string | null
      teams?: Array<{ id: string; name: string; role: string }>
      role: string
      email: string
      userId: string
      replay?: true
      token?: string
    }>('POST', '/external/invitations/accept', {
      body: {
        email,
        token,
        ...(sessionContract ? { sessionContract } : {}),
      },
    })
    return { data }
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error
    if (error.status === 400) return { error: 'invalid' }
    if (error.status === 404) return { error: 'not_found' }
    if (error.status === 403) return { error: 'forbidden' }
    if (error.status === 410) return { error: 'expired' }
    if (error.status === 409) return { error: 'not_pending' }
    throw error
  }
}

export async function createDesktopAuthorization(
  auth: AuthContext,
  password: string
): Promise<{
  error?: 'invalid_password' | 'not_found'
  data?: {
    authorizationToken: string
    expiresInSeconds: number
  }
}> {
  try {
    const data = await controlApiRequest<{
      authorizationToken: string
      expiresInSeconds: number
    }>('POST', '/external/invitations/desktop-authorization', {
      body: {
        userId: auth.userId,
        email: auth.email,
        password,
      },
      userSessionToken: auth.sessionToken,
    })
    return { data }
  } catch (error) {
    if (error instanceof ControlApiError && [429, 503].includes(error.status)) throw error
    if (error instanceof ControlApiError) {
      if (error.status === 404 && error.code === 'not_found') {
        return { error: 'not_found' }
      }
      if (error.status === 401 && error.code === 'invalid_password') {
        return { error: 'invalid_password' }
      }
    }
    throw passwordAuthorityUnavailable()
  }
}

export async function getInvitationByToken(token: string): Promise<InvitationPreview | null> {
  try {
    return await controlApiRequest<InvitationPreview>(
      'GET',
      `/external/invitations/token/${encodeURIComponent(token)}`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('(404)')) return null
    throw error
  }
}
