import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { type DbClient, withTransaction } from '../../db.js'
import type { AuthClaims, TeamRole } from '../../profileTypes.js'
import { type AccessPath, buildAccessPath, selectEquivalentAccessPath } from './accessPath.js'
import { type Capability, isCapability, normalizeCapabilities } from './capabilityRegistry.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

type MembershipSnapshot = {
  teamId: string
  role: TeamRole
  membershipUpdatedAt: string
  teamRevision: number
}

type PrincipalSnapshot = {
  userId: string
  userRevision: number
  resourceRevision: number
  sessionVersion: number
  sessionLive: boolean
  memberships: MembershipSnapshot[]
}

type GrantCandidate = {
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  capabilities: Capability[]
  budgetRef: string | null
  credentialPolicyRef: string | null
  approvalPolicyRef: string | null
  filesystemScopeRef: string | null
  runtimeRef: string | null
  providerModelPolicyRef: string | null
  auditSubject: string
}

export type LiveAuthorizationInput = {
  principalUserId: string
  sid?: string
  requiredCapability: string
  resource: CanonicalResourceIdentity
  operationTarget?: Record<string, unknown>
  requestedAccessPathId?: string
  requireSelectedPath?: boolean
}

export type LiveAuthorizationResult =
  | {
      status: 'allowed'
      effectiveCapabilities: Capability[]
      paths: AccessPath[]
      selectedPath?: AccessPath
      authorizationRevision: string
      resolvedBehavior: AccessPath['behavior'] | null
    }
  | { status: 'denied'; code: 'forbidden' | 'unknown_capability' | 'session_not_live' }
  | { status: 'not_found'; code: 'not_found' }
  | {
      status: 'access_path_required'
      code: 'access_path_required'
      safePathDescriptors: Array<{ id: string; kind: 'direct' | 'team'; teamId?: string }>
    }
  | {
      status: 'access_path_stale'
      code: 'access_path_stale'
      currentAuthorizationRevision: string
    }
  | {
      status: 'unavailable'
      dependencyClass: 'authorization_store'
      retryable: true
      correlationId?: string
    }

export class AuthorizationRequestMemo {
  private readonly values = new Map<string, Promise<LiveAuthorizationResult>>()

  getOrCreate(
    input: LiveAuthorizationInput,
    factory: () => Promise<LiveAuthorizationResult>
  ): Promise<LiveAuthorizationResult> {
    const key = JSON.stringify([
      input.principalUserId,
      input.sid ?? null,
      input.requiredCapability,
      input.resource.environmentId,
      input.resource.type,
      input.resource.logicalId,
      stableOperationTarget(input.operationTarget),
      input.requestedAccessPathId ?? null,
      input.requireSelectedPath ?? false,
    ])
    const existing = this.values.get(key)
    if (existing) return existing
    const created = factory()
    this.values.set(key, created)
    return created
  }
}

function parseMemberships(value: unknown): MembershipSnapshot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const teamId = String(row.teamId || '').trim()
    const role = String(row.role || '') as TeamRole
    if (!teamId || !['admin', 'inviter', 'member'].includes(role)) return []
    return [
      {
        teamId,
        role,
        membershipUpdatedAt: String(row.membershipUpdatedAt || ''),
        teamRevision: Number(row.teamRevision || 1),
      },
    ]
  })
}

async function loadPrincipalSnapshot(
  input: LiveAuthorizationInput,
  db: Pick<DbClient, 'query'>
): Promise<PrincipalSnapshot | null> {
  const result = await db.query(
    `WITH active_memberships AS (
       SELECT tm.team_id,
              tm.role,
              tm.updated_at,
              COALESCE(atr.revision, 1) AS team_revision
         FROM team_members tm
    LEFT JOIN authorization_team_revisions atr ON atr.team_id = tm.team_id
        WHERE tm.user_id = $1
          AND tm.status = 'active'
     )
     SELECT u.id AS user_id,
            COALESCE(aur.revision, 1) AS user_revision,
            COALESCE(arr.revision, 1) AS resource_revision,
            CASE
              WHEN $2::text IS NULL THEN TRUE
              ELSE EXISTS (
                SELECT 1
                  FROM external_user_sessions s
                 WHERE s.sid::text = $2
                   AND s.user_id = u.id
                   AND s.revoked_at IS NULL
                   AND s.idle_expires_at > NOW()
                   AND s.absolute_expires_at > NOW()
              )
            END AS session_live,
            COALESCE(
              (SELECT s.session_version
                 FROM external_user_sessions s
                WHERE s.sid::text = $2
                  AND s.user_id = u.id),
              0
            ) AS session_version,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'teamId', am.team_id,
                  'role', am.role,
                  'membershipUpdatedAt', am.updated_at,
                  'teamRevision', am.team_revision
                ) ORDER BY am.team_id
              ) FILTER (WHERE am.team_id IS NOT NULL),
              '[]'::jsonb
            ) AS memberships
       FROM users u
  LEFT JOIN authorization_user_revisions aur ON aur.user_id = u.id
  LEFT JOIN authorization_resource_revisions arr
         ON arr.environment_id = $3
        AND arr.resource_type = $4
        AND arr.resource_id = $5
  LEFT JOIN active_memberships am ON TRUE
      WHERE u.id = $1
   GROUP BY u.id, aur.revision, arr.revision`,
    [
      input.principalUserId,
      input.sid ?? null,
      input.resource.environmentId,
      input.resource.type,
      input.resource.logicalId,
    ]
  )
  const row = result.rows[0] as
    | {
        user_id: string
        user_revision: number | string
        resource_revision: number | string
        session_version: number | string
        session_live: boolean
        memberships: unknown
      }
    | undefined
  if (!row) return null
  return {
    userId: row.user_id,
    userRevision: Number(row.user_revision || 1),
    resourceRevision: Number(row.resource_revision || 1),
    sessionVersion: Number(row.session_version || 0),
    sessionLive: Boolean(row.session_live),
    memberships: parseMemberships(row.memberships),
  }
}

export function resourceAuthorizationRevision(input: {
  userId: string
  userRevision: number
  sessionVersion: number
  memberships: readonly MembershipSnapshot[]
  resource: CanonicalResourceIdentity
  resourceRevision: number | string
  candidates: readonly GrantCandidate[]
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'authorization_revision_v1',
        input.userId,
        input.userRevision,
        input.sessionVersion,
        input.memberships.map(membership => [
          membership.teamId,
          membership.role,
          membership.membershipUpdatedAt,
          membership.teamRevision,
        ]),
        input.resource.environmentId,
        input.resource.type,
        input.resource.logicalId,
        input.resourceRevision,
        [...input.candidates]
          .sort((left, right) =>
            JSON.stringify([left.kind, left.teamId ?? '', left.grantId]).localeCompare(
              JSON.stringify([right.kind, right.teamId ?? '', right.grantId])
            )
          )
          .map(candidate => [
            candidate.kind,
            candidate.grantId,
            candidate.teamId ?? null,
            candidate.currentRole ?? null,
            normalizeCapabilities(candidate.capabilities),
            candidate.budgetRef,
            candidate.credentialPolicyRef,
            candidate.approvalPolicyRef,
            candidate.filesystemScopeRef,
            candidate.runtimeRef,
            candidate.providerModelPolicyRef,
            candidate.auditSubject,
          ]),
      ])
    )
    .digest('base64url')
}

function stableOperationTarget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableOperationTarget)
  if (!value || typeof value !== 'object') return value ?? null
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableOperationTarget(item)])
  )
}

function grantLookupId(resource: CanonicalResourceIdentity): string {
  if (resource.type === 'host') {
    const prefix = `${config.hostsNamespace}/`
    return resource.logicalId.startsWith(prefix) ? resource.logicalId.slice(prefix.length) : ''
  }
  if (resource.type === 'context') {
    const prefix = `${config.contextsNamespace}/`
    return resource.logicalId.startsWith(prefix) ? resource.logicalId.slice(prefix.length) : ''
  }
  return resource.logicalId
}

function applyOperationTarget(
  input: LiveAuthorizationInput,
  candidates: GrantCandidate[]
): GrantCandidate[] | null {
  const target = input.operationTarget
  if (!target) return candidates
  const targetTeamId = typeof target.teamId === 'string' ? target.teamId.trim() : ''
  if (targetTeamId) {
    if (input.resource.type === 'team' && input.resource.logicalId !== targetTeamId) return null
    if (input.resource.type !== 'team') {
      return candidates.filter(
        candidate => candidate.kind === 'team' && candidate.teamId === targetTeamId
      )
    }
  }
  const targetUserId = typeof target.userId === 'string' ? target.userId.trim() : ''
  if (targetUserId && input.resource.type === 'user' && input.resource.logicalId !== targetUserId) {
    return null
  }
  return candidates
}

function teamCapabilities(role: TeamRole): Capability[] {
  const capabilities: Capability[] = ['team.read']
  if (role === 'admin') {
    capabilities.push('team.manage', 'team.member.read', 'team.member.invite', 'team.member.manage')
  } else if (role === 'inviter') {
    capabilities.push('team.member.read', 'team.member.invite')
  }
  return capabilities
}

function gfsCapabilities(values: unknown): Capability[] {
  const permissions = Array.isArray(values) ? values.map(String) : []
  return permissions.flatMap(permission => {
    const capability = `gfs.${permission}`
    return isCapability(capability) ? [capability] : []
  })
}

function candidateFromRow(row: Record<string, unknown>, userId: string): GrantCandidate | null {
  const kind = row.kind === 'team' ? 'team' : row.kind === 'direct' ? 'direct' : null
  const grantId = String(row.grant_id || '').trim()
  if (!kind || !grantId) return null
  const role = String(row.current_role || '') as TeamRole
  const capabilities = normalizeCapabilities(
    row.permissions
      ? gfsCapabilities(row.permissions)
      : Array.isArray(row.capabilities)
        ? row.capabilities
        : []
  )
  return {
    kind,
    grantId,
    ...(kind === 'team' ? { teamId: String(row.team_id || ''), currentRole: role } : {}),
    capabilities,
    budgetRef: typeof row.budget_ref === 'string' ? row.budget_ref : null,
    credentialPolicyRef:
      typeof row.credential_policy_ref === 'string' ? row.credential_policy_ref : null,
    approvalPolicyRef: typeof row.approval_policy_ref === 'string' ? row.approval_policy_ref : null,
    filesystemScopeRef:
      typeof row.filesystem_scope_ref === 'string' ? row.filesystem_scope_ref : null,
    runtimeRef: typeof row.runtime_ref === 'string' ? row.runtime_ref : null,
    providerModelPolicyRef:
      typeof row.provider_model_policy_ref === 'string' ? row.provider_model_policy_ref : null,
    auditSubject: kind === 'team' ? `team:${String(row.team_id || '')}` : `user:${userId}`,
  }
}

async function loadGrantCandidates(
  input: LiveAuthorizationInput,
  snapshot: PrincipalSnapshot,
  db: Pick<DbClient, 'query'>
): Promise<{ exists: boolean; candidates: GrantCandidate[] }> {
  if (input.resource.type === 'user') {
    return {
      exists: input.resource.logicalId === input.principalUserId,
      candidates:
        input.resource.logicalId === input.principalUserId
          ? [
              {
                kind: 'direct',
                grantId: `users:${input.principalUserId}`,
                capabilities: ['user.profile.read'],
                budgetRef: null,
                credentialPolicyRef: null,
                approvalPolicyRef: null,
                filesystemScopeRef: null,
                runtimeRef: null,
                providerModelPolicyRef: null,
                auditSubject: `user:${input.principalUserId}`,
              },
            ]
          : [],
    }
  }
  if (input.resource.type === 'team') {
    const membership = snapshot.memberships.find(item => item.teamId === input.resource.logicalId)
    return {
      exists: Boolean(membership),
      candidates: membership
        ? [
            {
              kind: 'team',
              grantId: `team_members:${membership.teamId}:${input.principalUserId}`,
              teamId: membership.teamId,
              currentRole: membership.role,
              capabilities: teamCapabilities(membership.role),
              budgetRef: null,
              credentialPolicyRef: null,
              approvalPolicyRef: null,
              filesystemScopeRef: null,
              runtimeRef: null,
              providerModelPolicyRef: null,
              auditSubject: `team:${membership.teamId}`,
            },
          ]
        : [],
    }
  }

  const teamIds = snapshot.memberships.map(membership => membership.teamId)
  const resourceLookupId = grantLookupId(input.resource)
  if (!resourceLookupId) return { exists: false, candidates: [] }
  const result = await db.query(
    `WITH requested AS (
       SELECT $2::text AS resource_type, $3::text AS resource_id
     ), candidates AS (
       SELECT 'direct'::text AS kind,
              'user_agents:' || ua.user_id || ':' || ua.agent_name AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role,
              ARRAY['host.read']::text[] AS capabilities, NULL::text[] AS permissions,
              NULL::text AS filesystem_scope_ref
         FROM user_agents ua, requested r
        WHERE r.resource_type = 'host' AND ua.user_id = $1 AND ua.agent_name = r.resource_id
       UNION ALL
       SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
              ta.team_id, tm.role, ARRAY['host.read']::text[], NULL::text[], NULL::text
         FROM team_agents ta JOIN team_members tm ON tm.team_id = ta.team_id, requested r
        WHERE r.resource_type = 'host' AND tm.user_id = $1 AND tm.status = 'active'
          AND ta.agent_name = r.resource_id
       UNION ALL
       SELECT 'direct', 'user_contexts:' || uc.user_id || ':' || uc.context_id,
              NULL, NULL, ARRAY['context.read']::text[], NULL::text[], NULL::text
         FROM user_contexts uc, requested r
        WHERE r.resource_type = 'context' AND uc.user_id = $1 AND uc.context_id = r.resource_id
       UNION ALL
       SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
              tc.team_id, tm.role, ARRAY['context.read']::text[], NULL::text[], NULL::text
         FROM team_contexts tc JOIN team_members tm ON tm.team_id = tc.team_id, requested r
        WHERE r.resource_type = 'context' AND tm.user_id = $1 AND tm.status = 'active'
          AND tc.context_id = r.resource_id
       UNION ALL
       SELECT 'direct', 'user_workflow_triggers:' || uwt.user_id || ':' ||
              uwt.recipe_namespace || '/' || uwt.recipe_name,
              NULL, NULL, ARRAY['workflow.read']::text[], NULL::text[], NULL::text
         FROM user_workflow_triggers uwt, requested r
        WHERE r.resource_type IN ('workflow_recipe','sandbox_app') AND uwt.user_id = $1
          AND uwt.recipe_namespace || '/' || uwt.recipe_name = r.resource_id
       UNION ALL
       SELECT 'team', 'team_workflow_triggers:' || twt.team_id || ':' ||
              twt.recipe_namespace || '/' || twt.recipe_name,
              twt.team_id, tm.role, ARRAY['workflow.read']::text[], NULL::text[], NULL::text
         FROM team_workflow_triggers twt JOIN team_members tm ON tm.team_id = twt.team_id, requested r
        WHERE r.resource_type IN ('workflow_recipe','sandbox_app')
          AND tm.user_id = $1 AND tm.status = 'active'
          AND twt.recipe_namespace || '/' || twt.recipe_name = r.resource_id
       UNION ALL
       SELECT CASE WHEN g.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_grants:' || g.id,
              CASE WHEN g.subject_type = 'team' THEN g.subject_id::uuid ELSE NULL END,
              tm.role, NULL::text[], g.permissions,
              'gfs:' || g.drive || ':' || g.resource_id
         FROM gfs_grants g
    LEFT JOIN team_members tm ON g.subject_type = 'team'
          AND tm.team_id::text = g.subject_id AND tm.user_id = $1 AND tm.status = 'active', requested r
        WHERE r.resource_type = 'gfs_resource' AND g.resource_id::text = r.resource_id
          AND ((g.subject_type = 'user' AND g.subject_id = $1::text)
            OR (g.subject_type = 'team' AND g.subject_id = ANY($4::text[])))
       UNION ALL
       SELECT CASE WHEN s.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_shares:' || s.id,
              CASE WHEN s.subject_type = 'team' THEN s.subject_id::uuid ELSE NULL END,
              tm.role, NULL::text[], s.permissions,
              'gfs:' || s.drive || ':' || s.resource_id
         FROM gfs_shares s
    LEFT JOIN team_members tm ON s.subject_type = 'team'
          AND tm.team_id::text = s.subject_id AND tm.user_id = $1 AND tm.status = 'active', requested r
        WHERE r.resource_type = 'gfs_resource' AND s.resource_id::text = r.resource_id
          AND ((s.subject_type = 'user' AND s.subject_id = $1::text)
            OR (s.subject_type = 'team' AND s.subject_id = ANY($4::text[])))
     )
     SELECT c.*, TRUE AS resource_exists
       FROM candidates c`,
    [input.principalUserId, input.resource.type, resourceLookupId, teamIds]
  )
  const rows = result.rows as Record<string, unknown>[]
  return {
    exists: rows.length > 0,
    candidates: rows.flatMap(row => {
      const candidate = candidateFromRow(row, input.principalUserId)
      if (!candidate) return []
      if (input.resource.type === 'sandbox_app') {
        candidate.grantId = `${candidate.grantId}:sandbox-app`
        candidate.capabilities = ['sandbox_app.read']
      }
      return [candidate]
    }),
  }
}

export async function resolveLiveAuthorizationInTransaction(
  input: LiveAuthorizationInput,
  db: Pick<DbClient, 'query'>
): Promise<LiveAuthorizationResult> {
  if (!isCapability(input.requiredCapability)) {
    return { status: 'denied', code: 'unknown_capability' }
  }
  const snapshot = await loadPrincipalSnapshot(input, db)
  if (!snapshot) return { status: 'not_found', code: 'not_found' }
  if (!snapshot.sessionLive) return { status: 'denied', code: 'session_not_live' }
  const grants = await loadGrantCandidates(input, snapshot, db)
  if (!grants.exists) return { status: 'not_found', code: 'not_found' }
  const targetedCandidates = applyOperationTarget(input, grants.candidates)
  if (!targetedCandidates || targetedCandidates.length === 0) {
    return { status: 'denied', code: 'forbidden' }
  }
  const revision = resourceAuthorizationRevision({
    userId: snapshot.userId,
    userRevision: snapshot.userRevision,
    sessionVersion: snapshot.sessionVersion,
    memberships: snapshot.memberships,
    resource: input.resource,
    resourceRevision: snapshot.resourceRevision,
    candidates: targetedCandidates,
  })

  const paths = targetedCandidates
    .filter(candidate => candidate.capabilities.includes(input.requiredCapability as Capability))
    .map(candidate =>
      buildAccessPath({
        principalUserId: input.principalUserId,
        resource: input.resource,
        kind: candidate.kind,
        grantId: candidate.grantId,
        ...(candidate.teamId ? { teamId: candidate.teamId } : {}),
        ...(candidate.currentRole ? { currentRole: candidate.currentRole } : {}),
        authorizationRevision: revision,
        behavior: {
          capabilities: candidate.capabilities,
          budgetRef: candidate.budgetRef,
          credentialPolicyRef: candidate.credentialPolicyRef,
          approvalPolicyRef: candidate.approvalPolicyRef,
          filesystemScopeRef: candidate.filesystemScopeRef,
          runtimeRef: candidate.runtimeRef,
          providerModelPolicyRef: candidate.providerModelPolicyRef,
          auditSubject: candidate.auditSubject,
        },
      })
    )
  if (paths.length === 0) return { status: 'denied', code: 'forbidden' }

  if (input.requestedAccessPathId) {
    const selectedPath = paths.find(path => path.id === input.requestedAccessPathId)
    if (!selectedPath) {
      return {
        status: 'access_path_stale',
        code: 'access_path_stale',
        currentAuthorizationRevision: revision,
      }
    }
    return {
      status: 'allowed',
      effectiveCapabilities: normalizeCapabilities(
        paths.flatMap(path => path.behavior.capabilities)
      ),
      paths,
      selectedPath,
      authorizationRevision: revision,
      resolvedBehavior: selectedPath.behavior,
    }
  }

  const selectedPath = selectEquivalentAccessPath(paths)
  if (input.requireSelectedPath && !selectedPath) {
    return {
      status: 'access_path_required',
      code: 'access_path_required',
      safePathDescriptors: paths.map(path => ({
        id: path.id,
        kind: path.kind,
        ...(path.teamId ? { teamId: path.teamId } : {}),
      })),
    }
  }
  return {
    status: 'allowed',
    effectiveCapabilities: normalizeCapabilities(paths.flatMap(path => path.behavior.capabilities)),
    paths,
    ...(selectedPath ? { selectedPath } : {}),
    authorizationRevision: revision,
    resolvedBehavior: selectedPath?.behavior ?? null,
  }
}

export async function resolveLiveAuthorization(
  input: LiveAuthorizationInput,
  options: { memo?: AuthorizationRequestMemo; correlationId?: string } = {}
): Promise<LiveAuthorizationResult> {
  const execute = async () => {
    try {
      return await withTransaction(async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return resolveLiveAuthorizationInTransaction(input, db)
      })
    } catch {
      return {
        status: 'unavailable' as const,
        dependencyClass: 'authorization_store' as const,
        retryable: true as const,
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      }
    }
  }
  return options.memo ? options.memo.getOrCreate(input, execute) : execute()
}

export function claimsToLiveAuthorizationIdentity(claims: AuthClaims): {
  principalUserId: string
  sid?: string
} {
  return {
    principalUserId: claims.userId,
    ...(claims.sessionContract === 'v2' && claims.sid ? { sid: claims.sid } : {}),
  }
}
