import type { DbClient } from '../../db.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import { parseAuthorizationMemberships } from './accessAuthorityStore.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import type {
  CatalogOperationalSourceState,
  CatalogPrincipalSnapshot,
  CatalogRequestContext,
} from './catalogContracts.js'
import { catalogQuery } from './catalogProducerSupport.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  type OperationalSourceFamily,
} from './operationalAccessProjection.js'

export class CatalogAuthorityError extends Error {
  constructor(readonly code: 'principal_not_found' | 'session_not_live' | 'source_state_invalid') {
    super(`Catalog authority snapshot failed: ${code}`)
    this.name = 'CatalogAuthorityError'
  }
}

function sourceState(row: Record<string, unknown>): CatalogOperationalSourceState {
  const family = String(row.source_family) as OperationalSourceFamily
  const status = String(row.status)
  if (
    !OPERATIONAL_SOURCE_FAMILIES.includes(family) ||
    !['current', 'relisting', 'unavailable'].includes(status)
  ) {
    throw new CatalogAuthorityError('source_state_invalid')
  }
  return Object.freeze({
    family,
    generation: String(row.generation),
    resourceVersion:
      row.resource_version === null || row.resource_version === undefined
        ? null
        : String(row.resource_version),
    status: status as CatalogOperationalSourceState['status'],
  })
}

function catalogAuthorizationRevision(principal: {
  sessionContract: 'v1' | 'v2'
  sessionRevision: string
  userRevision: string
  memberships: CatalogPrincipalSnapshot['memberships']
}): string {
  return `car2_${revisionOfValues([
    'catalog-authority-v2',
    principal.sessionContract,
    principal.sessionRevision,
    principal.userRevision,
    ...principal.memberships.map(membership => [
      membership.teamId,
      membership.role,
      membership.membershipUpdatedAt,
      membership.teamRevision,
    ]),
  ])}`
}

export function catalogSourceStateRevision(
  sourceStates: ReadonlyMap<OperationalSourceFamily, CatalogOperationalSourceState>
): string {
  return `csr1_${revisionOfValues(
    OPERATIONAL_SOURCE_FAMILIES.map(family => {
      const state = sourceStates.get(family)
      return state
        ? [family, state.generation, state.resourceVersion, state.status]
        : [family, 'missing', null, 'unavailable']
    })
  )}`
}

export async function loadCatalogRequestContext(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  session: ExternalSessionAuthorityContext
  environmentId: string
}): Promise<CatalogRequestContext> {
  const principalResult = await catalogQuery(
    input.db,
    input.budget,
    `WITH active_memberships AS (
       SELECT membership.team_id, membership.role, membership.updated_at,
              COALESCE(team_revision.revision, 1) AS team_revision
         FROM team_members membership
    LEFT JOIN authorization_team_revisions team_revision
           ON team_revision.team_id = membership.team_id
        WHERE membership.user_id = $1 AND membership.status = 'active'
     )
     SELECT users.id AS user_id,
            COALESCE(user_revision.revision, 1)::text AS user_revision,
            CASE
              WHEN $2::text = 'v2' THEN EXISTS (
                SELECT 1
                  FROM external_user_sessions session
                 WHERE session.sid::text = $3 AND session.user_id = users.id
                   AND session.session_version = $5 AND session.revoked_at IS NULL
                   AND session.idle_expires_at > NOW() AND session.absolute_expires_at > NOW()
                   AND (
                     session.current_jti::text = $4
                     OR (
                       session.prior_jti::text = $4
                       AND session.prior_jti_expires_at >= NOW()
                     )
                   )
              )
              ELSE (
                $7::bigint IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM external_v1_session_revocations revoked
                   WHERE revoked.token_hash = $6 AND revoked.user_id = users.id
                     AND revoked.expires_at > NOW()
                )
                AND NOT EXISTS (
                  SELECT 1 FROM external_user_session_security_epochs epoch
                   WHERE epoch.user_id = users.id
                     AND $7::bigint * 1000 <= EXTRACT(EPOCH FROM epoch.valid_after) * 1000
                )
              )
            END AS session_live,
            CASE
              WHEN $2::text = 'v2' THEN COALESCE((
                SELECT session.session_version::text || ':' || session.current_jti::text || ':' ||
                       COALESCE(session.revoked_at::text, '') || ':' ||
                       session.idle_expires_at::text || ':' || session.absolute_expires_at::text
                  FROM external_user_sessions session
                 WHERE session.sid::text = $3 AND session.user_id = users.id
              ), 'missing')
              ELSE COALESCE((
                SELECT EXTRACT(EPOCH FROM epoch.valid_after)::text
                  FROM external_user_session_security_epochs epoch
                 WHERE epoch.user_id = users.id
              ), '0') || ':' || $6
            END AS session_revision,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'teamId', membership.team_id,
                  'role', membership.role,
                  'membershipUpdatedAt', membership.updated_at,
                  'teamRevision', membership.team_revision
                ) ORDER BY membership.team_id
              ) FILTER (WHERE membership.team_id IS NOT NULL),
              '[]'::jsonb
            ) AS memberships
       FROM users
  LEFT JOIN authorization_user_revisions user_revision ON user_revision.user_id = users.id
  LEFT JOIN active_memberships membership ON TRUE
      WHERE users.id = $1
   GROUP BY users.id, user_revision.revision`,
    [
      input.session.userId,
      input.session.contract,
      input.session.contract === 'v2' ? input.session.sid : null,
      input.session.contract === 'v2' ? input.session.jti : null,
      input.session.contract === 'v2' ? input.session.sessionVersion : null,
      input.session.contract === 'v1' ? input.session.tokenHash : null,
      input.session.contract === 'v1' ? input.session.issuedAt : null,
    ]
  )
  const row = principalResult.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new CatalogAuthorityError('principal_not_found')
  if (row.session_live !== true) throw new CatalogAuthorityError('session_not_live')
  const memberships = Object.freeze(parseAuthorizationMemberships(row.memberships))
  const partialPrincipal = {
    userId: String(row.user_id),
    sessionContract: input.session.contract,
    sessionRevision: String(row.session_revision),
    userRevision: String(row.user_revision ?? '1'),
    memberships,
  } as const
  const principal: CatalogPrincipalSnapshot = Object.freeze({
    ...partialPrincipal,
    authorizationRevision: catalogAuthorizationRevision(partialPrincipal),
  })

  const sourceResult = await catalogQuery(
    input.db,
    input.budget,
    `SELECT source_family, generation, resource_version, status
       FROM operational_catalog_source_state
      WHERE environment_id = $1
        AND source_family = ANY($2::text[])
      ORDER BY source_family`,
    [input.environmentId, OPERATIONAL_SOURCE_FAMILIES]
  )
  const states = (sourceResult.rows as Record<string, unknown>[]).map(sourceState)
  return Object.freeze({
    db: input.db,
    budget: input.budget,
    principal,
    environmentId: input.environmentId,
    sourceStates: new Map(states.map(state => [state.family, state])),
  })
}
