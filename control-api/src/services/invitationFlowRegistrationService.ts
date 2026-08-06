import { config } from '../config.js'
import { memberRegistrationServiceRequest } from '../memberRegistrationServiceClient.js'

export type InvitationDeliveryInput = {
  email: string
  invitationUuid: string
  teamName: string | null
  teamNames: string[]
  purpose: 'member_invitation' | 'password_reset'
  issuedAt: string
  expiresAt: string
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
  await memberRegistrationServiceRequest<{ sent: true; registered: true }>(
    'POST',
    '/invitations-flow/invitations',
    {
      destinationBaseUrl: config.desktopProfileUiBaseUrl,
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

export async function registerAndSendInvitations(
  invitations: readonly InvitationDeliveryInput[]
): Promise<{ results: Array<{ invitationUuid: string; sent: boolean; error?: string }> }> {
  const results: Array<{ invitationUuid: string; sent: boolean; error?: string }> = []
  for (const invitation of invitations) {
    try {
      await registerAndSendInvitation(
        invitation.email,
        invitation.invitationUuid,
        invitation.teamName,
        invitation.issuedAt,
        invitation.expiresAt,
        {
          purpose: invitation.purpose,
          teamNames: invitation.teamNames,
        }
      )
      results.push({ invitationUuid: invitation.invitationUuid, sent: true })
    } catch (error) {
      results.push({
        invitationUuid: invitation.invitationUuid,
        sent: false,
        error: error instanceof Error ? error.message : 'Invitation delivery failed',
      })
    }
  }
  return { results }
}

export async function validateInvitationFlowToken(
  token: string,
  email?: string
): Promise<{ email: string; invitationUuid: string }> {
  const result = await memberRegistrationServiceRequest<{
    valid: true
    email: string
    invitationUuid: string
  }>('POST', '/invitations-flow/validate', {
    destinationBaseUrl: config.desktopProfileUiBaseUrl,
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
  await memberRegistrationServiceRequest<{ stored: true }>(
    'POST',
    '/invitations-flow/desktop-authorizations',
    {
      destinationBaseUrl: config.desktopProfileUiBaseUrl,
      body: {
        email,
        authorizationToken,
      },
    }
  )
}
