import { config } from '../config.js'
import { memberRegistrationServiceRequest } from '../memberRegistrationServiceClient.js'

export async function registerAndSendControlAdminInvitation(
  email: string,
  invitationUuid: string,
  issuedAt: string,
  expiresAt: string,
  options: { desktopTeamNames?: string[] } = {}
): Promise<void> {
  await memberRegistrationServiceRequest<{ sent: true; registered: true }>(
    'POST',
    '/control-admin-invitations/invitations',
    {
      destinationBaseUrl: config.controlUiBaseUrl,
      body: {
        email,
        invitationUuid,
        issuedAt,
        expiresAt,
        controlUiBaseUrl: config.controlUiBaseUrl,
        appName: config.controlUiAppName,
        desktopTeamNames: options.desktopTeamNames || [],
      },
    }
  )
}

export async function validateControlAdminInvitationToken(
  token: string,
  email?: string
): Promise<{ email: string; invitationUuid: string }> {
  const result = await memberRegistrationServiceRequest<{
    valid: true
    email: string
    invitationUuid: string
  }>('POST', '/control-admin-invitations/validate', {
    destinationBaseUrl: config.controlUiBaseUrl,
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

export async function registerAndSendControlAdminEmailConfirmation(
  email: string,
  confirmationUuid: string,
  issuedAt: string,
  expiresAt: string
): Promise<void> {
  await memberRegistrationServiceRequest<{ sent: true; registered: true }>(
    'POST',
    '/control-admin-email-confirmations/confirmations',
    {
      destinationBaseUrl: config.controlUiBaseUrl,
      body: {
        email,
        confirmationUuid,
        issuedAt,
        expiresAt,
        controlUiBaseUrl: config.controlUiBaseUrl,
        appName: config.controlUiAppName,
      },
    }
  )
}

export async function validateControlAdminEmailConfirmationToken(
  token: string,
  email?: string
): Promise<{ email: string; confirmationUuid: string }> {
  const result = await memberRegistrationServiceRequest<{
    valid: true
    email: string
    confirmationUuid: string
  }>('POST', '/control-admin-email-confirmations/validate', {
    destinationBaseUrl: config.controlUiBaseUrl,
    body: {
      token,
      email,
    },
  })
  return {
    email: result.email,
    confirmationUuid: result.confirmationUuid,
  }
}

export async function registerAndSendControlAdminPasswordReset(
  email: string,
  resetUuid: string,
  issuedAt: string,
  expiresAt: string
): Promise<void> {
  await memberRegistrationServiceRequest<{ sent: true; registered: true }>(
    'POST',
    '/control-admin-password-resets/resets',
    {
      destinationBaseUrl: config.controlUiBaseUrl,
      body: {
        email,
        resetUuid,
        issuedAt,
        expiresAt,
        controlUiBaseUrl: config.controlUiBaseUrl,
        appName: config.controlUiAppName,
      },
    }
  )
}

export async function validateControlAdminPasswordResetToken(
  token: string,
  email?: string
): Promise<{ email: string; resetUuid: string }> {
  const result = await memberRegistrationServiceRequest<{
    valid: true
    email: string
    resetUuid: string
  }>('POST', '/control-admin-password-resets/validate', {
    destinationBaseUrl: config.controlUiBaseUrl,
    body: {
      token,
      email,
    },
  })
  return {
    email: result.email,
    resetUuid: result.resetUuid,
  }
}
