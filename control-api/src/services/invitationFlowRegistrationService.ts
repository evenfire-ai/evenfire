import { config } from '../config.js'
import { memberRegistrationServiceRequest } from '../memberRegistrationServiceClient.js'
import { rootLogger } from '../observability/logger.js'

export function buildInviteAcceptUrl(token: string): string {
  const base = config.inviteAcceptBaseUrl.replace(/\/+$/, '')
  return `${base}/invitations/${token}`
}

export async function registerAndSendInvitation(
  email: string,
  invitationUuid: string,
  teamName: string | null,
  issuedAt: string,
  expiresAt: string,
  options: {
    purpose?: 'member_invitation' | 'password_reset' | 'admin_desktop_access'
    teamNames?: string[]
  } = {}
): Promise<void> {
  if (config.memberRegistrationMode === 'offline') {
    rootLogger.info(
      { event: 'invite_registration_offline', email },
      'offline member-registration: skipping remote invitation send'
    )
    return
  }

  await memberRegistrationServiceRequest<{ sent: true; registered: true }>(
    'POST',
    '/invitations-flow/invitations',
    {
      body: {
        email,
        invitationUuid,
        teamName,
        teamNames: options.teamNames || (teamName ? [teamName] : []),
        purpose: options.purpose === 'password_reset' ? 'password_reset' : 'member_invitation',
        issuedAt,
        expiresAt,
        desktopExternalRestApiBaseUrl: config.desktopExternalRestApiBaseUrl,
        desktopRpcProxyBaseUrl: config.desktopRpcProxyBaseUrl,
        desktopProfileUiBaseUrl: config.desktopProfileUiBaseUrl,
        desktopAppName: config.desktopAppName,
      },
    }
  )
}

export async function validateInvitationFlowToken(
  token: string,
  email?: string
): Promise<{ email: string; invitationUuid: string }> {
  if (config.memberRegistrationMode === 'offline') {
    const { getInvitationByToken } = await import('./directory/index.js')
    const invitation = await getInvitationByToken(token.trim())
    if (!invitation) {
      throw new Error('invalid_invitation')
    }
    if (email && invitation.email.toLowerCase() !== email.trim().toLowerCase()) {
      throw new Error('invalid_invitation')
    }
    return { email: invitation.email, invitationUuid: token.trim() }
  }

  const result = await memberRegistrationServiceRequest<{
    valid: true
    email: string
    invitationUuid: string
  }>('POST', '/invitations-flow/validate', {
    body: {
      token,
      email,
    },
  })
  return {
    email: result.email,
    invitationUuid: result.invitationUuid,
  }
}

export async function storeDesktopAuthorizationToken(
  email: string,
  authorizationToken: string
): Promise<void> {
  if (config.memberRegistrationMode === 'offline') {
    rootLogger.info(
      { event: 'desktop_authorization_offline', email },
      'offline member-registration: desktop authorization not persisted'
    )
    return
  }

  await memberRegistrationServiceRequest<{ stored: true }>(
    'POST',
    '/invitations-flow/desktop-authorizations',
    {
      body: {
        email,
        authorizationToken,
      },
    }
  )
}
