import type { DbClient } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import { query } from './accessAuthorityQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import type { AuthorizationMembershipRevision } from './authorizationRevision.js'

export type PrincipalAuthoritySnapshot = Readonly<{
  userId: string
  sessionContract: 'v1' | 'v2'
  sessionLive: boolean
  sessionRevision: string
  memberships: readonly AuthorizationMembershipRevision[]
}>

export type LogicalSessionCheckpointAuthority = Readonly<{
  contract: 'v2'
  authorityMode: 'logical_session_checkpoint'
  userId: string
  sid: string
  sessionVersion: number
}>

/**
 * Continuation of a workflow run the user already started: authority is
 * anchored on the user and their live grants, not on a login session. The
 * snapshot answers `sessionLive` from `users.lifecycle_state` alone, uses a
 * constant `sessionRevision`, and reads no `external_user_sessions` row. `sid`
 * and `sessionVersion` are the stored binding's values; they are echoed in the
 * attribution and never compared with a session row.
 */
export type UserGrantContinuationAuthority = Readonly<{
  contract: 'v2'
  authorityMode: 'user_grant_continuation'
  userId: string
  sid: string
  sessionVersion: number
}>

export type AccessAuthoritySession =
  | ExternalSessionAuthorityContext
  | LogicalSessionCheckpointAuthority
  | UserGrantContinuationAuthority

export function parseAuthorizationMemberships(value: unknown): AuthorizationMembershipRevision[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const teamId = String(row.teamId ?? '')
    const role = String(row.role ?? '') as TeamRole
    if (!teamId || !['admin', 'inviter', 'member'].includes(role)) return []
    return [
      Object.freeze({
        teamId,
        role,
        membershipUpdatedAt: new Date(String(row.membershipUpdatedAt)).toISOString(),
      }),
    ]
  })
}

export async function loadPrincipalAuthoritySnapshot(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  session: AccessAuthoritySession
}): Promise<PrincipalAuthoritySnapshot | null> {
  const session = input.session
  const userAnchored =
    'authorityMode' in session && session.authorityMode === 'user_grant_continuation'
  // The user-anchored mode passes no session coordinates, so the session
  // subqueries below match no `external_user_sessions` row for it.
  const sessionAnchoredV2 = session.contract === 'v2' && !userAnchored ? session : null
  const result = await query(
    input.db,
    input.budget,
    `WITH active_memberships AS (
       SELECT tm.team_id, tm.role, tm.updated_at
         FROM team_members tm
        WHERE tm.user_id = $1
          AND tm.status = 'active'
     )
     SELECT u.id AS user_id,
            CASE
              WHEN u.lifecycle_state <> 'active' THEN FALSE
              WHEN $7::boolean THEN TRUE
              WHEN $2::text = 'v2' THEN EXISTS (
                SELECT 1
                  FROM external_user_sessions s
                 WHERE s.sid::text = $3
                   AND s.user_id = u.id
                   AND s.session_version = $5
                   AND s.revoked_at IS NULL
                   AND s.idle_expires_at > NOW()
                   AND s.absolute_expires_at > NOW()
                   AND (
                     $6::boolean
                     OR s.current_jti::text = $4
                     OR (
                       s.prior_jti::text = $4
                       AND s.prior_jti_expires_at >= NOW()
                     )
                   )
              )
              ELSE FALSE
            END AS session_live,
            CASE
              WHEN $7::boolean THEN 'user_grant_continuation'
              WHEN $2::text = 'v2' THEN COALESCE((
                SELECT s.session_version::text || ':' || s.current_jti::text || ':' ||
                       COALESCE(s.revoked_at::text, '') || ':' || s.absolute_expires_at::text
                  FROM external_user_sessions s
                 WHERE s.sid::text = $3 AND s.user_id = u.id
              ), 'missing')
              ELSE 'missing'
            END AS session_revision,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'teamId', am.team_id,
                  'role', am.role,
                  'membershipUpdatedAt', am.updated_at
                ) ORDER BY am.team_id
              ) FILTER (WHERE am.team_id IS NOT NULL),
              '[]'::jsonb
            ) AS memberships
       FROM users u
  LEFT JOIN active_memberships am ON TRUE
      WHERE u.id = $1
   GROUP BY u.id`,
    [
      input.session.userId,
      input.session.contract,
      sessionAnchoredV2?.sid ?? null,
      sessionAnchoredV2 && !('authorityMode' in sessionAnchoredV2) ? sessionAnchoredV2.jti : null,
      sessionAnchoredV2?.sessionVersion ?? null,
      'authorityMode' in session && session.authorityMode === 'logical_session_checkpoint',
      userAnchored,
    ]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return Object.freeze({
    userId: String(row.user_id),
    sessionContract: input.session.contract,
    sessionLive: row.session_live === true,
    sessionRevision: String(row.session_revision),
    memberships: Object.freeze(parseAuthorizationMemberships(row.memberships)),
  })
}
