import type { DbClient } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import {
  type AccessPathBehavior,
  type AccessPathSeed,
  knownBehavior,
  unknownBehavior,
} from './accessPath.js'
import type { AuthorizationMembershipRevision } from './authorizationRevision.js'
import {
  type AccessCapability,
  capabilitiesForTeamRole,
  gfsPermissionsToCapabilities,
  normalizeAccessCapabilities,
} from './capabilityRegistry.js'
import type { ValidatedOperationTarget } from './operationTarget.js'
import type { OperationalResourceGraphResult } from './operationalAccessReader.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type OperationalPathBinding = Readonly<{
  resourceType: 'host' | 'context' | 'mcp_server' | 'workflow_recipe' | 'shared_filesystem'
  logicalId: string
  providerUid: string
  relationships: readonly Readonly<{
    instanceId: string
    behaviorAttributes: Readonly<Record<string, string | number | boolean>>
  }>[]
}>

export type AuthorityCandidate = AccessPathSeed &
  Readonly<{ operationalBindings: readonly OperationalPathBinding[] }>

export type PrincipalAuthoritySnapshot = Readonly<{
  userId: string
  sessionContract: 'v1' | 'v2'
  sessionLive: boolean
  sessionRevision: string
  userRevision: string
  resourceRevision: string
  memberships: readonly AuthorizationMembershipRevision[]
}>

export type ResourceAuthorityResult = Readonly<{
  exists: boolean
  candidates: readonly AuthorityCandidate[]
  relationships: readonly Readonly<{
    type: string
    targetResourceId: string
    instanceId?: string
  }>[]
  validUntil: Date | null
}>

function rowCountCharge(budget: AccessExecutionBudget, rows: readonly unknown[]): void {
  if (rows.length > 0) budget.charge({ kind: 'dbRowsReturned', amount: rows.length })
}

async function query(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget,
  text: string,
  values: unknown[]
) {
  return budget.runProducer(async () => {
    const result = await db.query(text, values)
    rowCountCharge(budget, result.rows)
    return result
  })
}

function memberships(value: unknown): AuthorizationMembershipRevision[] {
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
        teamRevision: String(row.teamRevision ?? '1'),
      }),
    ]
  })
}

export async function loadPrincipalAuthoritySnapshot(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  session: ExternalSessionAuthorityContext
  resource: CanonicalResourceIdentity
}): Promise<PrincipalAuthoritySnapshot | null> {
  const result = await query(
    input.db,
    input.budget,
    `WITH active_memberships AS (
       SELECT tm.team_id, tm.role, tm.updated_at,
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
                     s.current_jti::text = $4
                     OR (
                       s.prior_jti::text = $4
                       AND s.prior_jti_expires_at >= NOW()
                     )
                   )
              )
              ELSE (
                $7::bigint IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM external_v1_session_revocations r
                   WHERE r.token_hash = $6
                     AND r.user_id = u.id
                     AND r.expires_at > NOW()
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM external_user_session_security_epochs e
                   WHERE e.user_id = u.id
                     AND $7::bigint * 1000 <= EXTRACT(EPOCH FROM e.valid_after) * 1000
                )
              )
            END AS session_live,
            CASE
              WHEN $2::text = 'v2' THEN COALESCE((
                SELECT s.session_version::text || ':' || s.current_jti::text || ':' ||
                       COALESCE(s.revoked_at::text, '') || ':' || s.idle_expires_at::text || ':' ||
                       s.absolute_expires_at::text
                  FROM external_user_sessions s
                 WHERE s.sid::text = $3 AND s.user_id = u.id
              ), 'missing')
              ELSE COALESCE((
                SELECT EXTRACT(EPOCH FROM e.valid_after)::text
                  FROM external_user_session_security_epochs e
                 WHERE e.user_id = u.id
              ), '0') || ':' || $6
            END AS session_revision,
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
         ON arr.environment_id = $8
        AND arr.resource_type = $9
        AND arr.resource_id = $10
  LEFT JOIN active_memberships am ON TRUE
      WHERE u.id = $1
   GROUP BY u.id, aur.revision, arr.revision`,
    [
      input.session.userId,
      input.session.contract,
      input.session.contract === 'v2' ? input.session.sid : null,
      input.session.contract === 'v2' ? input.session.jti : null,
      input.session.contract === 'v2' ? input.session.sessionVersion : null,
      input.session.contract === 'v1' ? input.session.tokenHash : null,
      input.session.contract === 'v1' ? input.session.issuedAt : null,
      input.resource.environmentId,
      input.resource.type,
      input.resource.logicalId,
    ]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return Object.freeze({
    userId: String(row.user_id),
    sessionContract: input.session.contract,
    sessionLive: row.session_live === true,
    sessionRevision: String(row.session_revision),
    userRevision: String(row.user_revision ?? '1'),
    resourceRevision: String(row.resource_revision ?? '1'),
    memberships: Object.freeze(memberships(row.memberships)),
  })
}

function behavior(input: {
  userId: string
  kind: 'direct' | 'team'
  teamId?: string
  runtimeSensitive?: boolean
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
}): AccessPathBehavior {
  const runtimeSensitive = input.runtimeSensitive === true
  return Object.freeze({
    capabilities: Object.freeze([]),
    budget: runtimeSensitive ? unknownBehavior() : knownBehavior(null),
    credentialPolicy: runtimeSensitive ? unknownBehavior() : knownBehavior(null),
    approvalPolicy:
      input.approvalRef !== undefined
        ? knownBehavior(input.approvalRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    filesystemScope:
      input.filesystemScope !== undefined
        ? knownBehavior(input.filesystemScope)
        : knownBehavior(null),
    runtime:
      input.runtimeRef !== undefined
        ? knownBehavior(input.runtimeRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    providerModelPolicy:
      input.providerModelRef !== undefined
        ? knownBehavior(input.providerModelRef)
        : runtimeSensitive
          ? unknownBehavior()
          : knownBehavior(null),
    audit: knownBehavior(input.kind === 'team' ? `team:${input.teamId}` : `user:${input.userId}`),
  })
}

function candidate(input: {
  userId: string
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  capabilities: readonly AccessCapability[]
  runtimeSensitive?: boolean
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
  operationalBindings?: readonly OperationalPathBinding[]
}): AuthorityCandidate {
  return Object.freeze({
    kind: input.kind,
    grantId: input.grantId,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.currentRole ? { currentRole: input.currentRole } : {}),
    behavior: Object.freeze({
      ...behavior(input),
      capabilities: Object.freeze(normalizeAccessCapabilities(input.capabilities)),
    }),
    operationalBindings: Object.freeze([...(input.operationalBindings ?? [])]),
  })
}

function candidateFromGrantRow(input: {
  row: Record<string, unknown>
  userId: string
  capabilities: readonly AccessCapability[]
  runtimeSensitive?: boolean
  operationalBindings?: readonly OperationalPathBinding[]
  filesystemScope?: string | null
  runtimeRef?: string | null
  providerModelRef?: string | null
  approvalRef?: string | null
}): AuthorityCandidate | null {
  const kind = input.row.kind === 'direct' ? 'direct' : input.row.kind === 'team' ? 'team' : null
  const grantId = String(input.row.grant_id ?? '')
  if (!kind || !grantId) return null
  const teamId = kind === 'team' ? String(input.row.team_id ?? '') : undefined
  const currentRole = kind === 'team' ? (String(input.row.current_role) as TeamRole) : undefined
  if (kind === 'team' && (!teamId || !['admin', 'inviter', 'member'].includes(currentRole!))) {
    return null
  }
  return candidate({
    userId: input.userId,
    kind,
    grantId,
    ...(teamId ? { teamId } : {}),
    ...(currentRole ? { currentRole } : {}),
    capabilities: input.capabilities,
    runtimeSensitive: input.runtimeSensitive,
    operationalBindings: input.operationalBindings,
    filesystemScope: input.filesystemScope,
    runtimeRef: input.runtimeRef,
    providerModelRef: input.providerModelRef,
    approvalRef: input.approvalRef,
  })
}

function scopedName(logicalId: string): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator < 1 || separator === logicalId.length - 1) return null
  return { namespace: logicalId.slice(0, separator), name: logicalId.slice(separator + 1) }
}

function publicRelationships(graph: OperationalResourceGraphResult | null) {
  if (!graph || graph.status !== 'current') return []
  return graph.relationships.map(relationship =>
    Object.freeze({
      type: relationship.relationshipType,
      targetResourceId: `${relationship.targetType}:${relationship.targetId}`,
      instanceId: relationship.relationshipInstanceId,
    })
  )
}

async function loadSimpleOperationalGrantCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  userId: string
  resource: CanonicalResourceIdentity
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
}): Promise<AuthorityCandidate[]> {
  const identity = scopedName(input.resource.logicalId)
  if (!identity) return []
  const isHost = input.resource.type === 'host'
  const isContext = input.resource.type === 'context'
  const isRecipe = ['workflow_recipe', 'sandbox_app'].includes(input.resource.type)
  if (!isHost && !isContext && !isRecipe) return []
  const result = await query(
    input.db,
    input.budget,
    `WITH candidates AS (
       SELECT 'direct'::text AS kind,
              'user_agents:' || ua.user_id || ':' || ua.agent_name AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role
         FROM user_agents ua
        WHERE $2::text = 'host' AND ua.user_id = $1 AND ua.agent_name = $4
       UNION ALL
       SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
              ta.team_id, tm.role
         FROM team_agents ta
         JOIN team_members tm ON tm.team_id = ta.team_id
        WHERE $2::text = 'host' AND tm.user_id = $1 AND tm.status = 'active'
          AND ta.agent_name = $4
       UNION ALL
       SELECT 'direct', 'user_contexts:' || uc.user_id || ':' || uc.context_id,
              NULL, NULL
         FROM user_contexts uc
        WHERE $2::text = 'context' AND uc.user_id = $1 AND uc.context_id = $4
       UNION ALL
       SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
              tc.team_id, tm.role
         FROM team_contexts tc
         JOIN team_members tm ON tm.team_id = tc.team_id
        WHERE $2::text = 'context' AND tm.user_id = $1 AND tm.status = 'active'
          AND tc.context_id = $4
       UNION ALL
       SELECT 'direct', 'user_workflow_triggers:' || uwt.user_id || ':' ||
              uwt.recipe_namespace || '/' || uwt.recipe_name,
              NULL, NULL
         FROM user_workflow_triggers uwt
        WHERE $2::text IN ('workflow_recipe','sandbox_app') AND uwt.user_id = $1
          AND uwt.recipe_namespace = $3 AND uwt.recipe_name = $4
       UNION ALL
       SELECT 'team', 'team_workflow_triggers:' || twt.team_id || ':' ||
              twt.recipe_namespace || '/' || twt.recipe_name,
              twt.team_id, tm.role
         FROM team_workflow_triggers twt
         JOIN team_members tm ON tm.team_id = twt.team_id
        WHERE $2::text IN ('workflow_recipe','sandbox_app')
          AND tm.user_id = $1 AND tm.status = 'active'
          AND twt.recipe_namespace = $3 AND twt.recipe_name = $4
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id
     LIMIT $5`,
    [
      input.userId,
      input.resource.type,
      identity.namespace,
      identity.name,
      input.budget.limits.accessPaths + 1,
    ]
  )
  const capabilities: AccessCapability[] = isHost
    ? [
        'host.read',
        'host.use',
        'host.activity.read',
        'remote_desktop.use',
        'chat.read',
        'chat.message.invoke',
        'task.read',
        'task.manage',
        'model.read',
        'model.select',
        'session.read',
        'session.manage',
      ]
    : isContext
      ? ['context.read', 'context.use']
      : input.resource.type === 'sandbox_app'
        ? ['sandbox_app.read', 'sandbox_app.use', 'sandbox_oauth.vend']
        : ['workflow.read', 'workflow.trigger']
  const relevantRelationships = input.graph.relationships.filter(
    relationship => relationship.sourceType === input.resource.type || isRecipe
  )
  const runtimeRef = JSON.stringify(
    relevantRelationships.map(relationship => relationship.relationshipInstanceId).sort()
  )
  const bindingType =
    input.resource.type === 'sandbox_app' ? 'workflow_recipe' : input.resource.type
  const bindingProviderUid =
    input.resource.type === 'sandbox_app'
      ? relevantRelationships.find(relationship => relationship.sourceType === 'workflow_recipe')
          ?.sourceProviderUid
      : input.graph.resource.providerUid
  if (!bindingProviderUid) return []
  return (result.rows as Record<string, unknown>[]).flatMap(row => {
    const value = candidateFromGrantRow({
      row,
      userId: input.userId,
      capabilities,
      runtimeSensitive: true,
      runtimeRef,
      operationalBindings: [
        {
          resourceType: bindingType as OperationalPathBinding['resourceType'],
          logicalId: input.resource.logicalId,
          providerUid: bindingProviderUid,
          relationships: relevantRelationships.map(relationship => ({
            instanceId: relationship.relationshipInstanceId,
            behaviorAttributes: relationship.behaviorAttributes,
          })),
        },
      ],
    })
    return value ? [value] : []
  })
}

async function loadDerivedOperationalCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  userId: string
  resource: CanonicalResourceIdentity
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
}): Promise<AuthorityCandidate[]> {
  if (input.resource.type !== 'mcp_server' && input.resource.type !== 'shared_filesystem') {
    return []
  }
  const derivedResourceType = input.resource.type
  const directEdges = input.graph.relationships.filter(relationship => {
    if (input.resource.type === 'mcp_server') {
      return (
        relationship.relationshipType === 'includes_mcp_server' &&
        relationship.targetId === input.resource.logicalId
      )
    }
    return (
      relationship.relationshipType === 'mounts_shared_filesystem' &&
      relationship.targetId === input.resource.logicalId
    )
  })
  const contextIds = [...new Set(directEdges.map(edge => edge.sourceId))]
  const hostEdges =
    input.resource.type === 'mcp_server'
      ? input.graph.relationships.filter(
          relationship =>
            relationship.relationshipType === 'uses_context' &&
            relationship.targetType === 'context' &&
            contextIds.includes(relationship.targetId)
        )
      : []
  const hostIds = [...new Set(hostEdges.map(edge => edge.sourceId))]
  const contextNames = contextIds.map(value => scopedName(value)?.name ?? '').filter(Boolean)
  const hostNames = hostIds.map(value => scopedName(value)?.name ?? '').filter(Boolean)
  if (contextNames.length === 0 && hostNames.length === 0) return []
  const result = await query(
    input.db,
    input.budget,
    `WITH context_names AS (SELECT UNNEST($2::text[]) AS name),
          host_names AS (SELECT UNNEST($3::text[]) AS name),
          candidates AS (
       SELECT 'direct'::text AS kind,
              'user_contexts:' || uc.user_id || ':' || uc.context_id AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role,
              'context'::text AS source_type, uc.context_id AS source_name
         FROM user_contexts uc JOIN context_names requested ON requested.name = uc.context_id
        WHERE uc.user_id = $1
       UNION ALL
       SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
              tc.team_id, tm.role, 'context', tc.context_id
         FROM team_contexts tc JOIN context_names requested ON requested.name = tc.context_id
         JOIN team_members tm ON tm.team_id = tc.team_id
        WHERE tm.user_id = $1 AND tm.status = 'active'
       UNION ALL
       SELECT 'direct', 'user_agents:' || ua.user_id || ':' || ua.agent_name,
              NULL, NULL, 'host', ua.agent_name
         FROM user_agents ua JOIN host_names requested ON requested.name = ua.agent_name
        WHERE ua.user_id = $1
       UNION ALL
       SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
              ta.team_id, tm.role, 'host', ta.agent_name
         FROM team_agents ta JOIN host_names requested ON requested.name = ta.agent_name
         JOIN team_members tm ON tm.team_id = ta.team_id
        WHERE tm.user_id = $1 AND tm.status = 'active'
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id, source_type, source_name
     LIMIT $4`,
    [input.userId, contextNames, hostNames, input.budget.limits.accessPaths + 1]
  )
  const output: AuthorityCandidate[] = []
  for (const row of result.rows as Record<string, unknown>[]) {
    const sourceType = String(row.source_type)
    const sourceName = String(row.source_name)
    if (sourceType === 'context') {
      const contextId = contextIds.find(value => scopedName(value)?.name === sourceName)
      if (!contextId) continue
      for (const edge of directEdges.filter(value => value.sourceId === contextId)) {
        const filesystemScope =
          input.resource.type === 'shared_filesystem'
            ? JSON.stringify({
                contextId,
                relationshipInstanceId: edge.relationshipInstanceId,
                mountPath: edge.behaviorAttributes.mountPath,
                readOnly: true,
              })
            : undefined
        const value = candidateFromGrantRow({
          row: {
            ...row,
            grant_id: `${String(row.grant_id)}:${edge.relationshipInstanceId}`,
          },
          userId: input.userId,
          capabilities:
            input.resource.type === 'mcp_server'
              ? ['mcp_server.read', 'mcp_server.use']
              : ['shared_filesystem.read'],
          runtimeSensitive: input.resource.type === 'mcp_server',
          runtimeRef: edge.relationshipInstanceId,
          filesystemScope,
          operationalBindings: [
            {
              resourceType: 'context',
              logicalId: contextId,
              providerUid: edge.sourceProviderUid,
              relationships: [
                {
                  instanceId: edge.relationshipInstanceId,
                  behaviorAttributes: edge.behaviorAttributes,
                },
              ],
            },
            {
              resourceType: derivedResourceType,
              logicalId: input.resource.logicalId,
              providerUid: input.graph.resource.providerUid,
              relationships: [],
            },
          ],
        })
        if (value) output.push(value)
      }
      continue
    }
    const hostId = hostIds.find(value => scopedName(value)?.name === sourceName)
    if (!hostId) continue
    for (const hostEdge of hostEdges.filter(value => value.sourceId === hostId)) {
      const contextEdge = directEdges.find(value => value.sourceId === hostEdge.targetId)
      if (!contextEdge) continue
      const value = candidateFromGrantRow({
        row: {
          ...row,
          grant_id: `${String(row.grant_id)}:${hostEdge.relationshipInstanceId}:${contextEdge.relationshipInstanceId}`,
        },
        userId: input.userId,
        capabilities: ['mcp_server.read', 'mcp_server.use'],
        runtimeSensitive: true,
        runtimeRef: JSON.stringify([
          hostEdge.relationshipInstanceId,
          contextEdge.relationshipInstanceId,
        ]),
        operationalBindings: [
          {
            resourceType: 'host',
            logicalId: hostId,
            providerUid: hostEdge.sourceProviderUid,
            relationships: [
              {
                instanceId: hostEdge.relationshipInstanceId,
                behaviorAttributes: hostEdge.behaviorAttributes,
              },
            ],
          },
          {
            resourceType: 'context',
            logicalId: hostEdge.targetId,
            providerUid: contextEdge.sourceProviderUid,
            relationships: [
              {
                instanceId: contextEdge.relationshipInstanceId,
                behaviorAttributes: contextEdge.behaviorAttributes,
              },
            ],
          },
          {
            resourceType: 'mcp_server',
            logicalId: input.resource.logicalId,
            providerUid: input.graph.resource.providerUid,
            relationships: [],
          },
        ],
      })
      if (value) output.push(value)
    }
  }
  return output
}

async function loadDatabaseCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  snapshot: PrincipalAuthoritySnapshot
  resource: CanonicalResourceIdentity
}): Promise<ResourceAuthorityResult> {
  const { resource, snapshot } = input
  if (resource.type === 'user') {
    const owns = resource.logicalId === snapshot.userId
    return {
      exists: owns,
      candidates: owns
        ? [
            candidate({
              userId: snapshot.userId,
              kind: 'direct',
              grantId: `users:${snapshot.userId}`,
              capabilities: ['user.profile.read'],
            }),
          ]
        : [],
      relationships: [],
      validUntil: null,
    }
  }
  if (resource.type === 'team') {
    const membership = snapshot.memberships.find(value => value.teamId === resource.logicalId)
    return {
      exists: Boolean(membership),
      candidates: membership
        ? [
            candidate({
              userId: snapshot.userId,
              kind: 'team',
              grantId: `team_members:${membership.teamId}:${snapshot.userId}`,
              teamId: membership.teamId,
              currentRole: membership.role,
              capabilities: capabilitiesForTeamRole(membership.role),
            }),
          ]
        : [],
      relationships: [],
      validUntil: null,
    }
  }

  const result = await query(
    input.db,
    input.budget,
    `WITH candidates AS (
       SELECT 'direct'::text AS kind, 'workflow_runs:user:' || wr.run_id AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role,
              NULL::text[] AS permissions, wr.recipe_namespace, wr.recipe_name,
              NULL::timestamptz AS valid_until, wr.team_id::text AS related_team,
              wr.usage_team_id AS usage_team, NULL::text AS drive,
              NULL::text AS parent_resource
         FROM workflow_runs wr
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = wr.recipe_namespace
          AND uwt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_run' AND wr.run_id::text = $3
          AND wr.actor_type = 'user' AND wr.actor_id = $1
          AND wr.team_id IS NULL AND wr.usage_team_id IS NULL
       UNION ALL
       SELECT 'team', 'workflow_runs:team:' || tm.team_id || ':' || wr.run_id,
              tm.team_id, tm.role, NULL, wr.recipe_namespace, wr.recipe_name,
              NULL, wr.team_id::text, wr.usage_team_id, NULL, NULL
         FROM workflow_runs wr
         JOIN team_members tm
           ON (tm.team_id = wr.team_id OR tm.team_id::text = wr.usage_team_id)
          AND tm.user_id = $1 AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = wr.recipe_namespace
          AND twt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_run' AND wr.run_id::text = $3
       UNION ALL
       SELECT 'direct', 'workflow_approvals:user:' || war.id, NULL, NULL, NULL,
              war.recipe_namespace, war.recipe_name, war.expires_at, NULL, NULL, NULL, NULL
         FROM workflow_approval_requests war
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = war.recipe_namespace
          AND uwt.recipe_name = war.recipe_name
        WHERE $2::text = 'workflow_approval' AND war.id::text = $3
          AND war.target_user_id = $1 AND war.status = 'pending' AND war.expires_at > NOW()
       UNION ALL
       SELECT 'team', 'workflow_approvals:team:' || tm.team_id || ':' || war.id,
              tm.team_id, tm.role, NULL, war.recipe_namespace, war.recipe_name,
              war.expires_at, war.target_team_id::text, NULL, NULL, NULL
         FROM workflow_approval_requests war
         JOIN team_members tm
           ON tm.team_id = war.target_team_id AND tm.user_id = $1 AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = war.recipe_namespace
          AND twt.recipe_name = war.recipe_name
        WHERE $2::text = 'workflow_approval' AND war.id::text = $3
          AND war.status = 'pending' AND war.expires_at > NOW()
       UNION ALL
       SELECT CASE WHEN g.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_grants:' || g.id,
              CASE WHEN g.subject_type = 'team' THEN tm.team_id ELSE NULL END,
              tm.role, g.permissions, NULL, NULL, NULL, NULL, NULL, g.drive,
              gr.parent_resource_id::text
         FROM gfs_grants g
         JOIN gfs_resources gr ON gr.resource_id = g.resource_id AND gr.deleted_at IS NULL
    LEFT JOIN team_members tm
           ON g.subject_type = 'team' AND tm.team_id::text = g.subject_id
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'gfs_resource' AND g.resource_id::text = $3
          AND ((g.subject_type = 'user' AND g.subject_id = $1::text)
            OR (g.subject_type = 'team' AND tm.team_id IS NOT NULL))
       UNION ALL
       SELECT CASE WHEN s.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_shares:' || s.id,
              CASE WHEN s.subject_type = 'team' THEN tm.team_id ELSE NULL END,
              tm.role, s.permissions, NULL, NULL, NULL, NULL, NULL, s.drive,
              gr.parent_resource_id::text
         FROM gfs_shares s
         JOIN gfs_resources gr ON gr.resource_id = s.resource_id AND gr.deleted_at IS NULL
    LEFT JOIN team_members tm
           ON s.subject_type = 'team' AND tm.team_id::text = s.subject_id
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'gfs_resource' AND s.resource_id::text = $3
          AND ((s.subject_type = 'user' AND s.subject_id = $1::text)
            OR (s.subject_type = 'team' AND tm.team_id IS NOT NULL))
       UNION ALL
       SELECT 'direct', 'notifications:user:' || nd.id, NULL, NULL, NULL,
              NULL, NULL, nd.expires_at, NULL, NULL, NULL, NULL
         FROM notification_deliveries nd
        WHERE $2::text = 'notification' AND nd.id::text = $3
          AND nd.audience->>'userId' = $1::text
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
       UNION ALL
       SELECT 'team', 'notifications:team:' || tm.team_id || ':' || nd.id,
              tm.team_id, tm.role, NULL, NULL, NULL, nd.expires_at,
              tm.team_id::text, NULL, NULL, NULL
         FROM notification_deliveries nd
         JOIN team_members tm
           ON tm.team_id::text = nd.audience->>'teamId'
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'notification' AND nd.id::text = $3
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id
     LIMIT $4`,
    [snapshot.userId, resource.type, resource.logicalId, input.budget.limits.accessPaths + 1]
  )
  const rows = result.rows as Record<string, unknown>[]
  const candidates = rows.flatMap(row => {
    const type = resource.type
    const capabilities: AccessCapability[] =
      type === 'workflow_run'
        ? [
            'workflow.read',
            'workflow.run.manage',
            'workflow.artifact.read',
            'workflow.artifact.delete',
          ]
        : type === 'workflow_approval'
          ? ['workflow.approval.decide']
          : type === 'gfs_resource'
            ? gfsPermissionsToCapabilities(row.permissions)
            : ['notification.read']
    const value = candidateFromGrantRow({
      row,
      userId: snapshot.userId,
      capabilities,
      runtimeSensitive: type === 'workflow_run',
      approvalRef: type === 'workflow_approval' ? `approval:${resource.logicalId}` : undefined,
      filesystemScope:
        type === 'gfs_resource'
          ? JSON.stringify({ drive: row.drive, resourceId: resource.logicalId })
          : undefined,
    })
    return value ? [value] : []
  })
  const relationships: Array<{
    type: string
    targetResourceId: string
    instanceId?: string
  }> = []
  for (const row of rows) {
    if (resource.type === 'workflow_run' || resource.type === 'workflow_approval') {
      relationships.push(
        Object.freeze({
          type: 'recipe',
          targetResourceId: `workflow_recipe:${String(row.recipe_namespace)}/${String(row.recipe_name)}`,
        })
      )
      continue
    }
    if (resource.type === 'gfs_resource' && row.parent_resource) {
      relationships.push(
        Object.freeze({
          type: 'parent',
          targetResourceId: `gfs_resource:${String(row.parent_resource)}`,
        })
      )
      continue
    }
    if (resource.type === 'notification' && row.related_team) {
      relationships.push(
        Object.freeze({ type: 'team', targetResourceId: `team:${String(row.related_team)}` })
      )
    }
  }
  const validTimes = rows
    .map(row => (row.valid_until ? new Date(String(row.valid_until)) : null))
    .filter((value): value is Date => value !== null)
  return Object.freeze({
    exists: candidates.length > 0,
    candidates: Object.freeze(candidates),
    relationships: Object.freeze(relationships),
    validUntil:
      validTimes.length > 0
        ? new Date(Math.min(...validTimes.map(value => value.getTime())))
        : null,
  })
}

export async function loadResourceAuthority(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  snapshot: PrincipalAuthoritySnapshot
  resource: CanonicalResourceIdentity
  operationTarget: ValidatedOperationTarget
  operationalGraph: OperationalResourceGraphResult | null
}): Promise<ResourceAuthorityResult> {
  if (input.resource.type === 'user' || input.resource.type === 'team') {
    return loadDatabaseCandidates(input)
  }
  if (input.operationalGraph?.status === 'current') {
    const candidates = ['mcp_server', 'shared_filesystem'].includes(input.resource.type)
      ? await loadDerivedOperationalCandidates({
          ...input,
          userId: input.snapshot.userId,
          graph: input.operationalGraph,
        })
      : await loadSimpleOperationalGrantCandidates({
          ...input,
          userId: input.snapshot.userId,
          graph: input.operationalGraph,
        })
    return Object.freeze({
      exists: candidates.length > 0,
      candidates: Object.freeze(candidates),
      relationships: Object.freeze(publicRelationships(input.operationalGraph)),
      validUntil: null,
    })
  }
  return loadDatabaseCandidates(input)
}

export async function operationTargetIsCurrentlyValid(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  resource: CanonicalResourceIdentity
  capability: AccessCapability
  operationTarget: ValidatedOperationTarget
}): Promise<boolean> {
  const target = input.operationTarget
  if (!target) return true
  if (target.teamId && target.teamId !== input.resource.logicalId) return false
  if (target.userId && ['team.member.read', 'team.member.manage'].includes(input.capability)) {
    const result = await query(
      input.db,
      input.budget,
      `SELECT 1 FROM team_members
        WHERE team_id = $1 AND user_id = $2 AND status = 'active'
        LIMIT 1`,
      [target.teamId, target.userId]
    )
    return (result.rowCount ?? 0) === 1
  }
  if (input.capability === 'team.member.invite' && target.action !== 'create') {
    const result = await query(
      input.db,
      input.budget,
      `SELECT 1
         FROM invitations invitation
         JOIN invitation_teams assignment ON assignment.invitation_id = invitation.id
        WHERE invitation.id = $1
          AND invitation.status = 'pending'
          AND assignment.team_id = $2
          AND assignment.role = $3
        LIMIT 1`,
      [target.invitationId, target.teamId, target.role]
    )
    return (result.rowCount ?? 0) === 1
  }
  return true
}

export function filterCandidatesForOperationTarget(input: {
  candidates: readonly AuthorityCandidate[]
  capability: AccessCapability
  operationTarget: ValidatedOperationTarget
}): AuthorityCandidate[] {
  const target = input.operationTarget
  if (!target) return [...input.candidates]
  let candidates = [...input.candidates]
  if (target.teamId) {
    candidates = candidates.filter(candidate => candidate.teamId === target.teamId)
  }
  if (
    target.role === 'admin' &&
    ['team.member.invite', 'team.member.manage'].includes(input.capability)
  ) {
    candidates = candidates.filter(candidate => candidate.currentRole === 'admin')
  }
  return candidates
}
