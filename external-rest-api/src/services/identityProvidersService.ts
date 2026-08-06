import { controlApiRequest } from '../controlApiClient.js'

export type PublicIdentityProviderConnection = {
  id: string
  provider: 'microsoft'
  displayName: string
}

export function listIdentityProviders(): Promise<{ items: PublicIdentityProviderConnection[] }> {
  return controlApiRequest('GET', '/external/auth/providers')
}

export function startMicrosoftIdentityProviderLogin(input: {
  connectionId: string
  flow: 'profile_login' | 'desktop_login' | 'invitation_link'
  returnUrl: string
  invitationToken?: string
  flowBinding: string
}): Promise<{ authorizeUrl: string }> {
  return controlApiRequest('POST', '/external/auth/providers/microsoft/start', { body: input })
}

export function exchangeIdentityProviderLogin(
  code: string,
  flowBinding: string
): Promise<{
  token: string
  me: unknown
}> {
  return controlApiRequest('POST', '/external/auth/providers/exchange', {
    body: { code, flowBinding },
  })
}
