import type { TeamRole } from '../../profileTypes.js'
import { signExternalSessionToken } from '../../utils/auth/externalSessionAuthToken.js'
import { createUserSession } from './userSessionService.js'

export type ExternalSessionContract = 'v1' | 'v2'

export function requestedExternalSessionContract(value: unknown): ExternalSessionContract {
  return value === 'v2' ? 'v2' : 'v1'
}

export async function issueExternalUserSession(input: {
  contract: ExternalSessionContract
  userId: string
  email: string
  teamId: string | null
  role: TeamRole
  authenticationMethods: string[]
}): Promise<{ token: string; contract: ExternalSessionContract }> {
  if (input.contract === 'v2') {
    const session = await createUserSession({
      userId: input.userId,
      email: input.email,
      authenticationMethods: input.authenticationMethods,
    })
    return { token: session.token, contract: 'v2' }
  }
  return {
    token: signExternalSessionToken({
      userId: input.userId,
      email: input.email,
      teamId: input.teamId,
      role: input.role,
    }),
    contract: 'v1',
  }
}
