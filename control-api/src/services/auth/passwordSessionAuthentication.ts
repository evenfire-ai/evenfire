import { type DbClient, withTransaction } from '../../db.js'
import type { EffectiveUserAccessPolicy } from '../access/userAccessPolicy.js'
import { passwordLoginData } from '../directory/login.js'
import {
  type ExternalSessionContract,
  issueExternalUserSession,
} from './externalSessionIssuance.js'

type PasswordLoginSuccess = {
  user: {
    id: string
    email: string
    name: string | null
    picture: string | null
  }
  membership: {
    team_id: string | null
    role: 'admin' | 'inviter' | 'member'
    team_name: string | null
  }
  credentialHash: string
  authGeneration: number
}

export async function authenticatePasswordAndIssueSession(input: {
  email: string
  password: string
  contract: ExternalSessionContract
  policy: EffectiveUserAccessPolicy
}) {
  const login = await passwordLoginData(input)
  if (!login || !('user' in login)) return login
  const authenticatedLogin = login as PasswordLoginSuccess

  return withTransaction(async (db: Pick<DbClient, 'query'>) => {
    const credential = await db.query(
      `SELECT id, lifecycle_state, lifecycle_version
         FROM users
        WHERE id = $1
          AND email = $2
          AND password_hash = $3
        FOR NO KEY UPDATE`,
      [authenticatedLogin.user.id, authenticatedLogin.user.email, authenticatedLogin.credentialHash]
    )
    const lockedUser = credential.rows[0] as
      | { lifecycle_state: unknown; lifecycle_version: unknown }
      | undefined
    if (!lockedUser) return null

    const issued = await issueExternalUserSession(
      {
        contract: input.contract,
        userId: authenticatedLogin.user.id,
        email: authenticatedLogin.user.email,
        teamId: authenticatedLogin.membership.team_id,
        role: authenticatedLogin.membership.role,
        authGeneration: authenticatedLogin.authGeneration,
        authenticationMethods: ['pwd'],
      },
      {
        db,
        policy: input.policy,
        lockedUser: {
          lifecycleState: lockedUser.lifecycle_state,
          lifecycleVersion: lockedUser.lifecycle_version,
        },
      }
    )
    return { ...authenticatedLogin, issued }
  })
}
