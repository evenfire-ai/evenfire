import { ControlApiError, controlApiRequest } from '../controlApiClient.js'

type AuthContext = {
  userId: string
  email: string
  sessionToken: string
}

type ResetPasswordDomainError =
  | 'not_found'
  | 'forbidden'
  | 'not_pending'
  | 'expired'
  | 'invalid_invitation'
  | 'invalid_password'

function controlApiErrorCode(error: ControlApiError): string | null {
  if (
    error.body !== null &&
    typeof error.body === 'object' &&
    'error' in error.body &&
    typeof error.body.error === 'string'
  ) {
    return error.body.error
  }
  return null
}

function resetPasswordDomainError(error: ControlApiError): ResetPasswordDomainError | null {
  const code = controlApiErrorCode(error)
  if (error.status === 400 && code === 'invalid_password') return 'invalid_password'
  if (error.status === 400 && code === 'invalid_invitation') return 'invalid_invitation'
  if (error.status === 403 && code === 'forbidden') return 'forbidden'
  if (error.status === 404 && code === 'not_found') return 'not_found'
  if (
    error.status === 409 &&
    (code === 'invitation_not_pending' || code === 'invitation_not_ready')
  ) {
    return 'not_pending'
  }
  if (error.status === 410 && code === 'expired') return 'expired'
  return null
}

function unknownRecoveryOutcome(): ControlApiError {
  return new ControlApiError(
    'Password recovery outcome is unknown',
    503,
    { error: 'recovery_outcome_unknown' },
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
    if (error instanceof ControlApiError) {
      const domainError = resetPasswordDomainError(error)
      if (domainError) return { error: domainError }
      if (error.status < 500) return { error: 'invalid_invitation' }
    }
    throw unknownRecoveryOutcome()
  }
}
