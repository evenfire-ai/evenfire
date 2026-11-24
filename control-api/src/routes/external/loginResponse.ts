import type { TeamRole } from '../../profileTypes.js'
import type { ExternalSessionContract } from '../../services/auth/externalSessionIssuance.js'

/** What a member sign-in answers with: the issued session and who it is for. */
export type ExternalLoginResponseBody = {
  token: string
  sessionContract: ExternalSessionContract
  me: {
    id: string
    email: string
    name: string | null
    picture: string | null
    teamId: string | null
    teamName: string | null
    role: TeamRole
  }
}

/**
 * The `{ token, sessionContract, me }` body of a member sign-in, shared by
 * password login and Desktop sign-in redeem so both answer the same shape.
 * Google login keeps its own body, which also carries `isNewUser`.
 */
export function externalLoginResponseBody(
  issued: Readonly<{ token: string; contract: ExternalSessionContract }>,
  user: Readonly<{ id: string; email: string; name: string | null; picture: string | null }>,
  membership: Readonly<{ team_id: string | null; team_name: string | null; role: TeamRole }>
): ExternalLoginResponseBody {
  return {
    token: issued.token,
    sessionContract: issued.contract,
    me: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      // A teamless member's team id is null, never an empty string.
      teamId: membership.team_id || null,
      teamName: membership.team_name,
      role: membership.role,
    },
  }
}
