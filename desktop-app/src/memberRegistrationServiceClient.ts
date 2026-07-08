import { config } from './config.js'
import { requestJson } from './httpClient.js'
import type { DesktopSetupCompletion, InvitationFlowProfileLookup } from './types.js'

function url(path: string): string {
  return `${config.memberRegistrationServiceBaseUrl.replace(/\/+$/, '')}${path}`
}

export class MemberRegistrationServiceClient {
  async getInvitationProfile(email: string): Promise<InvitationFlowProfileLookup> {
    return requestJson<InvitationFlowProfileLookup>(
      'POST',
      url('/api/v1/invitations-flow/profile'),
      {
        body: { email },
      }
    )
  }

  async completeDesktopSetup(
    email: string,
    authorizationToken: string
  ): Promise<DesktopSetupCompletion> {
    return requestJson<DesktopSetupCompletion>(
      'POST',
      url('/api/v1/invitations-flow/desktop-setup/complete'),
      {
        body: { email, authorizationToken },
      }
    )
  }
}
