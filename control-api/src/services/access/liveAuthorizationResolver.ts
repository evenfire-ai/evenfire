import { config } from '../../config.js'
import { type DbClient, withTransaction } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { AuthClaims, TeamRole } from '../../profileTypes.js'
import { type AccessPath, buildAccessPath, selectEquivalentAccessPath } from './accessPath.js'
import {
  type AuthorizationGrantCandidate,
  type AuthorizationMembershipSnapshot,
  bindAuthorizationRelationships,
  mergeAuthorizationRevisionValues,
  resourceAuthorizationRevision,
} from './authorizationRevision.js'
import { type Capability, isCapability, normalizeCapabilities } from './capabilityRegistry.js'
import { scopedLogicalId, sharedFilesystemScopeRef } from './operationalAccessProjection.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

type MembershipSnapshot = AuthorizationMembershipSnapshot

type PrincipalSnapshot = {
  userId: string
  userRevision: number
  resourceRevision: number
  sessionVersion: number
  sessionLive: boolean
  memberships: MembershipSnapshot[]
}

type GrantCandidate = AuthorizationGrantCandidate

export type LiveAuthorizationInput = {
  principalUserId: string
  sid?: string
  requiredCapability: string
  resource: CanonicalResourceIdentity
  operationTarget?: Record<string, unknown>
  requestedAccessPathId?: string
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
      dependencyClass: 'authorization_store' | 'operational_resource_store'
      retryable: true
      correlationId?: string
    }

type OperationalResourceShape = {
  metadata?: {
    name?: string
    namespace?: string
    deletionTimestamp?: string | null
  }
  spec?: {
    enabled?: boolean
    contextRef?: string
    mcpServers?: unknown[]
    sharedFileSystems?: Array<{ name?: string; mountPath?: string }>
    ui?: unknown
  }
}

type OperationalAuthorizationContext = {
  relationships: Array<{ type: string; targetResourceId: string }>
  relatedContextNames: string[]
  relatedHostNames: string[]
  filesystemScopes: Map<string, string>
}

type OperationalAuthorizationLookup =
  | { status: 'current'; context: OperationalAuthorizationContext }
  | { status: 'not_found' }
  | { status: 'unavailable' }

const EMPTY_OPERATIONAL_CONTEXT: OperationalAuthorizationContext = {
  relationships: [],
  relatedContextNames: [],
  relatedHostNames: [],
  filesystemScopes: new Map(),
}

function operationalIdentity(
  logicalId: string,
  expectedNamespace?: string
): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator <= 0 || separator === logicalId.length - 1) return null
  const namespace = logicalId.slice(0, separator)
  const name = logicalId.slice(separator + 1)
  if (expectedNamespace && namespace !== expectedNamespace) return null
  return { namespace, name }
}

function isCurrentOperationalResource(
  value: unknown,
  identity: { namespace: string; name: string }
): value is OperationalResourceShape {
  if (!value || typeof value !== 'object') return false
  const resource = value as OperationalResourceShape
  const namespace = resource.metadata?.namespace?.trim() || identity.namespace
  return (
    resource.metadata?.name?.trim() === identity.name &&
    namespace === identity.namespace &&
    !resource.metadata?.deletionTimestamp &&
    resource.spec?.enabled !== false
  )
}

function operationalErrorIsNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const response =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : null
  const body =
    response?.body && typeof response.body === 'object'
      ? (response.body as Record<string, unknown>)
      : null
  return (
    record.statusCode === 404 ||
    record.code === 404 ||
    response?.statusCode === 404 ||
    body?.code === 404
  )
}

function activeOperationalResources(
  values: unknown,
  namespace: string
): OperationalResourceShape[] {
  if (!Array.isArray(values)) return []
  return values.filter((value): value is OperationalResourceShape => {
    if (!value || typeof value !== 'object') return false
    const resource = value as OperationalResourceShape
    const name = resource.metadata?.name?.trim()
    const resourceNamespace = resource.metadata?.namespace?.trim() || namespace
    return Boolean(
      name &&
      resourceNamespace === namespace &&
      !resource.metadata?.deletionTimestamp &&
      resource.spec?.enabled !== false
    )
  })
}

async function loadOperationalAuthorizationContext(
  input: LiveAuthorizationInput,
  gateway: Pick<K8sGateway, 'getResource' | 'listResource'> | undefined
): Promise<OperationalAuthorizationLookup> {
  const type = input.resource.type
  if (
    ![
      'host',
      'context',
      'mcp_server',
      'workflow_recipe',
      'shared_filesystem',
      'sandbox_app',
    ].includes(type)
  ) {
    return { status: 'current', context: EMPTY_OPERATIONAL_CONTEXT }
  }
  if (!gateway) return { status: 'unavailable' }

  try {
    if (type === 'host') {
      const identity = operationalIdentity(input.resource.logicalId, config.hostsNamespace)
      if (!identity) return { status: 'not_found' }
      const host = await gateway.getResource('hosts', identity.name, identity.namespace)
      if (!isCurrentOperationalResource(host, identity)) return { status: 'not_found' }
      const contextRef = (host.spec?.contextRef ?? '').trim()
      return {
        status: 'current',
        context: {
          ...EMPTY_OPERATIONAL_CONTEXT,
          relationships: contextRef
            ? [
                {
                  type: 'context',
                  targetResourceId: `context:${scopedLogicalId(
                    config.contextsNamespace,
                    contextRef
                  )}`,
                },
              ]
            : [],
        },
      }
    }

    if (type === 'context') {
      const identity = operationalIdentity(input.resource.logicalId, config.contextsNamespace)
      if (!identity) return { status: 'not_found' }
      const [context, rawMcpServers, rawFilesystems] = await Promise.all([
        gateway.getResource('contexts', identity.name, identity.namespace),
        gateway.listResource('mcpservers', config.mcpServersNamespace),
        gateway.listResource('sharedfilesystems', config.sharedFilesystemsNamespace),
      ])
      if (!isCurrentOperationalResource(context, identity)) return { status: 'not_found' }
      const currentMcpNames = new Set(
        activeOperationalResources(rawMcpServers, config.mcpServersNamespace).flatMap(resource =>
          resource.metadata?.name?.trim() ? [resource.metadata.name.trim()] : []
        )
      )
      const currentFilesystemNames = new Set(
        activeOperationalResources(rawFilesystems, config.sharedFilesystemsNamespace).flatMap(
          resource => (resource.metadata?.name?.trim() ? [resource.metadata.name.trim()] : [])
        )
      )
      const mcpNames = (context.spec?.mcpServers ?? []).flatMap(value =>
        typeof value === 'string' && currentMcpNames.has(value.trim()) ? [value.trim()] : []
      )
      const filesystemNames = (context.spec?.sharedFileSystems ?? []).flatMap(reference => {
        const name = reference.name?.trim()
        const mountPath = reference.mountPath?.trim()
        return name && mountPath && currentFilesystemNames.has(name) ? [name] : []
      })
      return {
        status: 'current',
        context: {
          ...EMPTY_OPERATIONAL_CONTEXT,
          relationships: [
            ...mcpNames.map(name => ({
              type: 'mcp_server',
              targetResourceId: `mcp_server:${scopedLogicalId(config.mcpServersNamespace, name)}`,
            })),
            ...filesystemNames.map(name => ({
              type: 'shared_filesystem',
              targetResourceId: `shared_filesystem:${scopedLogicalId(
                config.sharedFilesystemsNamespace,
                name
              )}`,
            })),
          ],
        },
      }
    }

    if (type === 'workflow_recipe' || type === 'sandbox_app') {
      const identity = operationalIdentity(input.resource.logicalId)
      if (!identity) return { status: 'not_found' }
      const recipe = await gateway.getResource('workflowrecipes', identity.name, identity.namespace)
      if (!isCurrentOperationalResource(recipe, identity)) return { status: 'not_found' }
      if (type === 'sandbox_app' && !recipe.spec?.ui) return { status: 'not_found' }
      return {
        status: 'current',
        context: {
          ...EMPTY_OPERATIONAL_CONTEXT,
          relationships:
            type === 'sandbox_app'
              ? [
                  {
                    type: 'recipe',
                    targetResourceId: `workflow_recipe:${input.resource.logicalId}`,
                  },
                ]
              : recipe.spec?.ui
                ? [
                    {
                      type: 'sandbox_app',
                      targetResourceId: `sandbox_app:${input.resource.logicalId}`,
                    },
                  ]
                : [],
        },
      }
    }

    if (type === 'mcp_server') {
      const identity = operationalIdentity(input.resource.logicalId, config.mcpServersNamespace)
      if (!identity) return { status: 'not_found' }
      const [server, rawContexts, rawHosts] = await Promise.all([
        gateway.getResource('mcpservers', identity.name, identity.namespace),
        gateway.listResource('contexts', config.contextsNamespace),
        gateway.listResource('hosts', config.hostsNamespace),
      ])
      if (!isCurrentOperationalResource(server, identity)) return { status: 'not_found' }
      const contexts = activeOperationalResources(rawContexts, config.contextsNamespace).filter(
        context =>
          (context.spec?.mcpServers ?? []).some(
            value => typeof value === 'string' && value.trim() === identity.name
          )
      )
      const contextNames = contexts.flatMap(context =>
        context.metadata?.name?.trim() ? [context.metadata.name.trim()] : []
      )
      const contextNameSet = new Set(contextNames)
      const hostNames = activeOperationalResources(rawHosts, config.hostsNamespace).flatMap(
        host => {
          const name = host.metadata?.name?.trim()
          const contextRef = host.spec?.contextRef?.trim()
          return name && contextRef && contextNameSet.has(contextRef) ? [name] : []
        }
      )
      return {
        status: 'current',
        context: {
          ...EMPTY_OPERATIONAL_CONTEXT,
          relatedContextNames: [...new Set(contextNames)].sort(),
          relatedHostNames: [...new Set(hostNames)].sort(),
          relationships: [
            ...contextNames.map(name => ({
              type: 'context',
              targetResourceId: `context:${scopedLogicalId(config.contextsNamespace, name)}`,
            })),
            ...hostNames.map(name => ({
              type: 'host',
              targetResourceId: `host:${scopedLogicalId(config.hostsNamespace, name)}`,
            })),
          ],
        },
      }
    }

    const identity = operationalIdentity(
      input.resource.logicalId,
      config.sharedFilesystemsNamespace
    )
    if (!identity) return { status: 'not_found' }
    const [filesystem, rawContexts] = await Promise.all([
      gateway.getResource('sharedfilesystems', identity.name, identity.namespace),
      gateway.listResource('contexts', config.contextsNamespace),
    ])
    if (!isCurrentOperationalResource(filesystem, identity)) return { status: 'not_found' }
    const filesystemScopes = new Map<string, string>()
    const contextNames: string[] = []
    for (const context of activeOperationalResources(rawContexts, config.contextsNamespace)) {
      const contextName = context.metadata?.name?.trim()
      if (!contextName) continue
      for (const reference of context.spec?.sharedFileSystems ?? []) {
        const name = reference.name?.trim()
        const mountPath = reference.mountPath?.trim()
        if (name !== identity.name || !mountPath) continue
        contextNames.push(contextName)
        filesystemScopes.set(
          contextName,
          sharedFilesystemScopeRef({
            contextLogicalId: scopedLogicalId(config.contextsNamespace, contextName),
            filesystemLogicalId: input.resource.logicalId,
            mountPath,
          })
        )
      }
    }
    return {
      status: 'current',
      context: {
        ...EMPTY_OPERATIONAL_CONTEXT,
        relatedContextNames: [...new Set(contextNames)].sort(),
        filesystemScopes,
        relationships: contextNames.map(name => ({
          type: 'context',
          targetResourceId: `context:${scopedLogicalId(config.contextsNamespace, name)}`,
        })),
      },
    }
  } catch (error) {
    return operationalErrorIsNotFound(error) ? { status: 'not_found' } : { status: 'unavailable' }
  }
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

async function operationTargetRelationshipIsCurrent(
  input: LiveAuthorizationInput,
  db: Pick<DbClient, 'query'>
): Promise<boolean> {
  const target = input.operationTarget
  if (!target) return true

  const targetTeamId = typeof target.teamId === 'string' ? target.teamId.trim() : ''
  const targetUserId = typeof target.userId === 'string' ? target.userId.trim() : ''
  if (targetTeamId && input.resource.type === 'team' && targetTeamId !== input.resource.logicalId) {
    return false
  }
  if (targetUserId && input.resource.type === 'user') {
    return targetUserId === input.resource.logicalId
  }
  if (
    targetUserId &&
    input.resource.type === 'team' &&
    ['team.member.read', 'team.member.manage'].includes(input.requiredCapability)
  ) {
    const result = await db.query(
      `SELECT 1
         FROM team_members
        WHERE team_id = $1
          AND user_id = $2
          AND status = 'active'
        LIMIT 1`,
      [input.resource.logicalId, targetUserId]
    )
    return (result.rowCount ?? 0) > 0
  }
  return true
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
  db: Pick<DbClient, 'query'>,
  operational: OperationalAuthorizationContext
): Promise<{
  exists: boolean
  candidates: GrantCandidate[]
  resourceRevision: number | string
  relationships: Array<{ type: string; targetResourceId: string }>
}> {
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
      resourceRevision: snapshot.resourceRevision,
      relationships: [],
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
      resourceRevision: snapshot.resourceRevision,
      relationships: [],
    }
  }

  if (input.resource.type === 'mcp_server' || input.resource.type === 'shared_filesystem') {
    const includeHosts = input.resource.type === 'mcp_server'
    const result = await db.query(
      `WITH context_names AS (
         SELECT UNNEST($2::text[]) AS resource_name
       ), host_names AS (
         SELECT UNNEST($3::text[]) AS resource_name
       ), candidates AS (
         SELECT 'direct'::text AS kind,
                'user_contexts:' || uc.user_id || ':' || uc.context_id AS grant_id,
                NULL::uuid AS team_id, NULL::text AS current_role,
                uc.context_id AS source_id, 'context'::text AS source_type,
                COALESCE(arr.revision, 1) AS authorization_resource_revision
           FROM user_contexts uc
           JOIN context_names requested ON requested.resource_name = uc.context_id
      LEFT JOIN authorization_resource_revisions arr
             ON arr.environment_id = $4
            AND arr.resource_type = 'context'
            AND arr.resource_id = $5::text || '/' || uc.context_id
          WHERE uc.user_id = $1
         UNION ALL
         SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
                tc.team_id, tm.role, tc.context_id, 'context', COALESCE(arr.revision, 1)
           FROM team_contexts tc
           JOIN context_names requested ON requested.resource_name = tc.context_id
           JOIN team_members tm
             ON tm.team_id = tc.team_id
            AND tm.user_id = $1
            AND tm.status = 'active'
      LEFT JOIN authorization_resource_revisions arr
             ON arr.environment_id = $4
            AND arr.resource_type = 'context'
            AND arr.resource_id = $5::text || '/' || tc.context_id
         UNION ALL
         SELECT 'direct', 'user_agents:' || ua.user_id || ':' || ua.agent_name,
                NULL, NULL, ua.agent_name, 'host', COALESCE(arr.revision, 1)
           FROM user_agents ua
           JOIN host_names requested ON requested.resource_name = ua.agent_name
      LEFT JOIN authorization_resource_revisions arr
             ON arr.environment_id = $4
            AND arr.resource_type = 'host'
            AND arr.resource_id = $6::text || '/' || ua.agent_name
          WHERE ua.user_id = $1 AND $7::boolean
         UNION ALL
         SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
                ta.team_id, tm.role, ta.agent_name, 'host', COALESCE(arr.revision, 1)
           FROM team_agents ta
           JOIN host_names requested ON requested.resource_name = ta.agent_name
           JOIN team_members tm
             ON tm.team_id = ta.team_id
            AND tm.user_id = $1
            AND tm.status = 'active'
      LEFT JOIN authorization_resource_revisions arr
             ON arr.environment_id = $4
            AND arr.resource_type = 'host'
            AND arr.resource_id = $6::text || '/' || ta.agent_name
          WHERE $7::boolean
       )
       SELECT * FROM candidates`,
      [
        input.principalUserId,
        operational.relatedContextNames,
        operational.relatedHostNames,
        input.resource.environmentId,
        config.contextsNamespace,
        config.hostsNamespace,
        includeHosts,
      ]
    )
    const rows = result.rows as Record<string, unknown>[]
    const resourceName = input.resource.logicalId.split('/').pop() ?? ''
    const candidates = rows.flatMap(row => {
      const sourceType = String(row.source_type || '')
      const sourceId = String(row.source_id || '')
      const candidate = candidateFromRow(
        {
          ...row,
          capabilities:
            input.resource.type === 'mcp_server' ? ['mcp_server.read'] : ['shared_filesystem.read'],
        },
        input.principalUserId
      )
      if (!candidate) return []
      if (input.resource.type === 'mcp_server') {
        candidate.grantId = `${candidate.grantId}:mcp-server:${resourceName}`
      } else {
        const scope = operational.filesystemScopes.get(sourceId)
        if (sourceType !== 'context' || !scope) return []
        candidate.grantId = `${candidate.grantId}:shared-filesystem:${resourceName}`
        candidate.filesystemScopeRef = scope
      }
      return [candidate]
    })
    return {
      exists: candidates.length > 0,
      candidates,
      resourceRevision: mergeAuthorizationRevisionValues(
        rows.map(row => String(row.authorization_resource_revision || 1))
      ),
      relationships: rows.map(row => {
        const sourceType = String(row.source_type)
        const sourceId = String(row.source_id)
        return {
          type: sourceType,
          targetResourceId: `${sourceType}:${scopedLogicalId(
            sourceType === 'host' ? config.hostsNamespace : config.contextsNamespace,
            sourceId
          )}`,
        }
      }),
    }
  }

  const teamIds = snapshot.memberships.map(membership => membership.teamId)
  const resourceLookupId = grantLookupId(input.resource)
  if (!resourceLookupId) {
    return {
      exists: false,
      candidates: [],
      resourceRevision: snapshot.resourceRevision,
      relationships: operational.relationships,
    }
  }
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
       SELECT 'direct', 'workflow_runs:user:' || wr.run_id,
              NULL, NULL, ARRAY['workflow.read']::text[], NULL::text[], NULL::text
         FROM workflow_runs wr
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = wr.recipe_namespace
          AND uwt.recipe_name = wr.recipe_name, requested r
        WHERE r.resource_type = 'workflow_run' AND wr.run_id::text = r.resource_id
          AND wr.actor_type = 'user' AND wr.actor_id = $1
       UNION ALL
       SELECT 'team', 'workflow_runs:team:' || tm.team_id || ':' || wr.run_id,
              tm.team_id, tm.role, ARRAY['workflow.read']::text[], NULL::text[], NULL::text
         FROM workflow_runs wr
         JOIN team_members tm
           ON (tm.team_id = wr.team_id OR tm.team_id::text = wr.usage_team_id)
          AND tm.user_id = $1
          AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = wr.recipe_namespace
          AND twt.recipe_name = wr.recipe_name, requested r
        WHERE r.resource_type = 'workflow_run' AND wr.run_id::text = r.resource_id
       UNION ALL
       SELECT 'direct', 'workflow_approval_requests:user:' || war.id,
              NULL, NULL, ARRAY['workflow.approval.decide']::text[], NULL::text[], NULL::text
         FROM workflow_approval_requests war
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = war.recipe_namespace
          AND uwt.recipe_name = war.recipe_name, requested r
        WHERE r.resource_type = 'workflow_approval' AND war.id::text = r.resource_id
          AND war.target_user_id = $1 AND war.status = 'pending' AND war.expires_at > NOW()
       UNION ALL
       SELECT 'team', 'workflow_approval_requests:team:' || tm.team_id || ':' || war.id,
              tm.team_id, tm.role, ARRAY['workflow.approval.decide']::text[],
              NULL::text[], NULL::text
         FROM workflow_approval_requests war
         JOIN team_members tm
           ON tm.team_id = war.target_team_id
          AND tm.user_id = $1
          AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = war.recipe_namespace
          AND twt.recipe_name = war.recipe_name, requested r
        WHERE r.resource_type = 'workflow_approval' AND war.id::text = r.resource_id
          AND war.status = 'pending' AND war.expires_at > NOW()
       UNION ALL
       SELECT CASE WHEN g.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_grants:' || g.id,
              CASE WHEN g.subject_type = 'team' THEN g.subject_id::uuid ELSE NULL END,
              tm.role, NULL::text[], g.permissions,
              'gfs:' || g.drive || ':' || g.resource_id
         FROM gfs_grants g
         JOIN gfs_resources gr ON gr.resource_id = g.resource_id AND gr.deleted_at IS NULL
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
         JOIN gfs_resources gr ON gr.resource_id = s.resource_id AND gr.deleted_at IS NULL
    LEFT JOIN team_members tm ON s.subject_type = 'team'
          AND tm.team_id::text = s.subject_id AND tm.user_id = $1 AND tm.status = 'active', requested r
        WHERE r.resource_type = 'gfs_resource' AND s.resource_id::text = r.resource_id
          AND ((s.subject_type = 'user' AND s.subject_id = $1::text)
            OR (s.subject_type = 'team' AND s.subject_id = ANY($4::text[])))
       UNION ALL
       SELECT 'direct', 'notification_deliveries:' || nd.id,
              NULL, NULL, ARRAY['notification.read']::text[], NULL::text[], NULL::text
         FROM notification_deliveries nd, requested r
        WHERE r.resource_type = 'notification' AND nd.id::text = r.resource_id
          AND nd.audience->>'userId' = $1::text
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
       UNION ALL
       SELECT 'team', 'notification_deliveries:team:' || tm.team_id || ':' || nd.id,
              tm.team_id, tm.role, ARRAY['notification.read']::text[], NULL::text[], NULL::text
         FROM notification_deliveries nd
         JOIN team_members tm
           ON tm.team_id::text = nd.audience->>'teamId'
          AND tm.user_id = $1
          AND tm.status = 'active', requested r
        WHERE r.resource_type = 'notification' AND nd.id::text = r.resource_id
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
     )
     SELECT c.*, TRUE AS resource_exists
       FROM candidates c`,
    [input.principalUserId, input.resource.type, resourceLookupId, teamIds]
  )
  const rows = result.rows as Record<string, unknown>[]
  const candidates = rows.flatMap(row => {
    const candidate = candidateFromRow(row, input.principalUserId)
    if (!candidate) return []
    if (input.resource.type === 'sandbox_app') {
      candidate.grantId = `${candidate.grantId}:sandbox-app`
      candidate.capabilities = ['sandbox_app.read']
    } else if (input.resource.type === 'workflow_approval') {
      candidate.approvalPolicyRef = `approval:${input.resource.logicalId}`
    }
    return [candidate]
  })
  const relationships = [...operational.relationships]
  if (input.resource.type === 'notification') {
    for (const teamId of candidates.flatMap(candidate => candidate.teamId ?? [])) {
      relationships.push({ type: 'team', targetResourceId: `team:${teamId}` })
    }
  } else if (['workflow_run', 'workflow_approval', 'gfs_resource'].includes(input.resource.type)) {
    const relationshipResult = await db.query(
      `SELECT relationship_type, target_resource_id
         FROM (
           SELECT 'recipe'::text AS relationship_type,
                  'workflow_recipe:' || wr.recipe_namespace || '/' || wr.recipe_name
                    AS target_resource_id
             FROM workflow_runs wr
            WHERE $1::text = 'workflow_run' AND wr.run_id::text = $2
           UNION ALL
           SELECT 'recipe',
                  'workflow_recipe:' || war.recipe_namespace || '/' || war.recipe_name
             FROM workflow_approval_requests war
            WHERE $1::text = 'workflow_approval' AND war.id::text = $2
           UNION ALL
           SELECT 'parent', 'gfs_resource:' || gr.parent_resource_id::text
             FROM gfs_resources gr
            WHERE $1::text = 'gfs_resource'
              AND gr.resource_id::text = $2
              AND gr.deleted_at IS NULL
              AND gr.parent_resource_id IS NOT NULL
         ) relationships`,
      [input.resource.type, input.resource.logicalId]
    )
    for (const row of relationshipResult.rows as Array<Record<string, unknown>>) {
      relationships.push({
        type: String(row.relationship_type),
        targetResourceId: String(row.target_resource_id),
      })
    }
  }
  let resourceRevision: number | string = snapshot.resourceRevision
  if (input.resource.type === 'sandbox_app') {
    const revisionResult = await db.query(
      `SELECT COALESCE(revision, 1) AS revision
         FROM authorization_resource_revisions
        WHERE environment_id = $1
          AND resource_type = 'workflow_recipe'
          AND resource_id = $2`,
      [input.resource.environmentId, input.resource.logicalId]
    )
    const row = revisionResult.rows[0] as { revision?: unknown } | undefined
    resourceRevision = String(row?.revision || 1)
  }
  return {
    exists: rows.length > 0,
    candidates,
    resourceRevision,
    relationships,
  }
}

export async function resolveLiveAuthorizationInTransaction(
  input: LiveAuthorizationInput,
  db: Pick<DbClient, 'query'>,
  operational: OperationalAuthorizationContext = EMPTY_OPERATIONAL_CONTEXT
): Promise<LiveAuthorizationResult> {
  if (!isCapability(input.requiredCapability)) {
    return { status: 'denied', code: 'unknown_capability' }
  }
  const snapshot = await loadPrincipalSnapshot(input, db)
  if (!snapshot) return { status: 'not_found', code: 'not_found' }
  if (!snapshot.sessionLive) return { status: 'denied', code: 'session_not_live' }
  if (!(await operationTargetRelationshipIsCurrent(input, db))) {
    return { status: 'denied', code: 'forbidden' }
  }
  const grants = await loadGrantCandidates(input, snapshot, db, operational)
  if (!grants.exists) return { status: 'not_found', code: 'not_found' }
  const targetedCandidates = applyOperationTarget(input, grants.candidates)
  if (!targetedCandidates || targetedCandidates.length === 0) {
    return { status: 'denied', code: 'forbidden' }
  }
  const relationships = [
    ...new Map(
      grants.relationships.map(relationship => [
        JSON.stringify([relationship.type, relationship.targetResourceId]),
        relationship,
      ])
    ).values(),
  ]
  const revision = resourceAuthorizationRevision({
    userId: snapshot.userId,
    userRevision: snapshot.userRevision,
    sessionVersion: snapshot.sessionVersion,
    memberships: snapshot.memberships,
    resource: input.resource,
    resourceRevision: bindAuthorizationRelationships(grants.resourceRevision, relationships),
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
  if (!selectedPath) {
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
  options: {
    memo?: AuthorizationRequestMemo
    correlationId?: string
    gateway?: Pick<K8sGateway, 'getResource' | 'listResource'>
  } = {}
): Promise<LiveAuthorizationResult> {
  const execute = async () => {
    const operational = await loadOperationalAuthorizationContext(input, options.gateway)
    if (operational.status === 'not_found') {
      return { status: 'not_found' as const, code: 'not_found' as const }
    }
    if (operational.status === 'unavailable') {
      return {
        status: 'unavailable' as const,
        dependencyClass: 'operational_resource_store' as const,
        retryable: true as const,
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      }
    }
    try {
      return await withTransaction(async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return resolveLiveAuthorizationInTransaction(input, db, operational.context)
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
