import {
  ControlApiError,
  ControlApiTransportError,
  ControlApiUnexpectedResponseError,
  controlApiRequest,
} from '../controlApiClient.js'
import type { InvitationPreview } from './invitationsService.js'

type AuthContext = {
  userId: string
  email: string
  sessionToken: string
}

type ResetPasswordDomainError =
  'not_found' | 'forbidden' | 'not_pending' | 'expired' | 'invalid_invitation' | 'invalid_password'

function invitationPasswordDomainError(
  error: ControlApiError
):
  | 'not_found'
  | 'forbidden'
  | 'not_accepted'
  | 'not_pending'
  | 'expired'
  | 'invalid_password'
  | null {
  const code = error.code
  if (error.status === 400 && code === 'invalid_password') return 'invalid_password'
  if (error.status === 401 && code === 'user_retired') return 'not_found'
  if (error.status === 403 && code === 'forbidden') return 'forbidden'
  if (error.status === 404 && code === 'not_found') return 'not_found'
  if (error.status === 409 && code === 'invitation_not_accepted') return 'not_accepted'
  if (error.status === 409 && code === 'invitation_not_pending') return 'not_pending'
  if (error.status === 410 && code === 'expired') return 'expired'
  return null
}

function resetPasswordDomainError(error: ControlApiError): ResetPasswordDomainError | null {
  const code = error.code
  if (error.status === 400 && code === 'invalid_password') return 'invalid_password'
  if (error.status === 400 && code === 'invalid_invitation') return 'invalid_invitation'
  if (error.status === 401 && code === 'user_retired') return 'invalid_invitation'
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

function passwordAuthorityUnavailable(): ControlApiError {
  return new ControlApiError(
    'Password recovery authority unavailable',
    503,
    { error: 'authority_unavailable' },
    { 'retry-after': '2' }
  )
}

export async function setupInvitationPassword(
  auth: AuthContext,
  invitationId: string,
  password: string
): Promise<{
  error?:
    'not_found' | 'forbidden' | 'not_accepted' | 'not_pending' | 'expired' | 'invalid_password'
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
    if (error instanceof ControlApiTransportError) throw passwordAuthorityUnavailable()
    if (
      error instanceof ControlApiError &&
      error.status === 500 &&
      error.code === 'internal_error'
    ) {
      throw error
    }
    if (error instanceof ControlApiError && [429, 503].includes(error.status)) throw error
    if (error instanceof ControlApiError) {
      const domainError = invitationPasswordDomainError(error)
      if (domainError) return { error: domainError }
      if (error.status === 401) throw passwordAuthorityUnavailable()
      if (error.status >= 500) throw passwordAuthorityUnavailable()
      throw new ControlApiUnexpectedResponseError()
    }
    throw error
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
    if (error instanceof ControlApiTransportError) throw unknownRecoveryOutcome()
    if (error instanceof ControlApiError && error.status === 429) throw error
    if (error instanceof ControlApiError) {
      if (error.status === 500 && error.code === 'internal_error') throw error
      if (
        error.status === 503 &&
        (error.code === 'authority_unavailable' || error.code === 'recovery_outcome_unknown')
      ) {
        throw error
      }
      const domainError = resetPasswordDomainError(error)
      if (domainError) return { error: domainError }
      if (error.status === 401) throw passwordAuthorityUnavailable()
      if (error.status >= 500) throw unknownRecoveryOutcome()
      throw new ControlApiUnexpectedResponseError()
    }
    throw error
  }
}
