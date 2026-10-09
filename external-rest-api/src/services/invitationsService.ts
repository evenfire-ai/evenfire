import { ControlApiError, controlApiRequest } from '../controlApiClient.js'

type AuthContext = {
  userId: string
  email: string
  sessionToken: string
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
  email: string
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
    token: string
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
      token: string
    }>('POST', '/external/invitations/accept', {
      body: {
        email,
        token,
      },
    })
    return { data }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('(400)')) return { error: 'invalid' }
    if (message.includes('(404)')) return { error: 'not_found' }
    if (message.includes('(403)')) return { error: 'forbidden' }
    if (message.includes('(410)')) return { error: 'expired' }
    return { error: 'not_pending' }
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
    const message = error instanceof Error ? error.message : ''
    if (message.includes('(404)')) return { error: 'not_found' }
    return { error: 'invalid_password' }
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

export async function setupInvitationPassword(
  auth: AuthContext,
  invitationId: string,
  password: string
): Promise<{
  error?:
    | 'not_found'
    | 'forbidden'
    | 'not_accepted'
    | 'not_pending'
    | 'expired'
    | 'invalid_password'
  data?: InvitationPreview & { passwordUpdated: boolean }
}> {
  try {
    const data = await controlApiRequest<InvitationPreview & { passwordUpdated: boolean }>(
      'POST',
      '/external/invitations/password',
      {
        body: {
          userId: auth.userId,
          email: auth.email,
          invitationId,
          password,
        },
        userSessionToken: auth.sessionToken,
      }
    )
    return { data }
  } catch (error) {
    if (error instanceof ControlApiError && [429, 503].includes(error.status)) throw error
    const message = error instanceof Error ? error.message : ''
    if (message.includes('(404)')) return { error: 'not_found' }
    if (message.includes('(403)')) return { error: 'forbidden' }
    if (message.includes('(409)')) return { error: 'not_accepted' }
    if (message.includes('(410)')) return { error: 'expired' }
    return { error: 'invalid_password' }
  }
}

export async function setupInvitationPasswordWithToken(
  token: string,
  email: string,
  invitationId: string,
  password: string
): Promise<{
  error?:
    | 'not_found'
    | 'forbidden'
    | 'not_accepted'
    | 'not_pending'
    | 'expired'
    | 'invalid_invitation'
    | 'invalid_password'
  data?: InvitationPreview & { passwordUpdated: boolean; token: string }
}> {
  try {
    const data = await controlApiRequest<
      InvitationPreview & { passwordUpdated: boolean; token: string }
    >('POST', '/external/invitations/password-token', {
      body: { email, token, invitationId, password },
    })
    return { data }
  } catch (error) {
    if (error instanceof ControlApiError && [429, 503].includes(error.status)) throw error
    if (
      error instanceof ControlApiError &&
      error.status === 400 &&
      error.body &&
      typeof error.body === 'object' &&
      'error' in error.body &&
      error.body.error === 'invalid_invitation'
    ) {
      return { error: 'invalid_invitation' }
    }
    const message = error instanceof Error ? error.message : ''
    if (message.includes('(404)')) return { error: 'not_found' }
    if (message.includes('(403)')) return { error: 'forbidden' }
    if (message.includes('(409)')) return { error: 'not_pending' }
    if (message.includes('(410)')) return { error: 'expired' }
    return { error: 'invalid_password' }
  }
}
