import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { type DbClient, withTransaction } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { AuthClaims, TeamRole } from '../../profileTypes.js'
import { type AccessPath, type AccessPathBehavior, buildAccessPath } from './accessPath.js'
import { type Capability, isCapability, normalizeCapabilities } from './capabilityRegistry.js'
import { resourceAuthorizationRevision } from './liveAuthorizationResolver.js'
import {
  type CanonicalResourceIdentity,
  type ResourceType,
  canonicalResourceIdentity,
  resourceIdentityKey,
} from './resourceIdentity.js'

export const ACCESS_CATALOG_CONTRACT_VERSION = '2' as const
export const ACCESS_CATALOG_DEFAULT_PAGE_SIZE = 50
export const ACCESS_CATALOG_MAX_PAGE_SIZE = 100

type CatalogRelationship = {
  type: string
  targetResourceId: string
}

type CatalogPathSeed = {
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  teamName?: string
  currentRole?: TeamRole
  behavior: AccessPathBehavior
}

type CatalogSeed = {
  resource: CanonicalResourceIdentity
  relationships: CatalogRelationship[]
  pathSeeds: CatalogPathSeed[]
  resourceRevision?: string
  authorizationResourceRevision: number | string
}

export type AccessCatalogPartialError = {
  sourceCode: string
  category: 'operational_source_unavailable'
  retryable: true
  correlationId?: string
}

export type AccessCatalogPath = {
  accessPathId: string
  kind: 'direct' | 'team'
  safeTeamDescriptor?: { id: string; name?: string; currentRole?: TeamRole }
  capabilities: Capability[]
  behaviorDescriptors: {
    budget?: string
    credentials?: string
    approvalPolicy?: string
    filesystemScope?: string
    runtime?: string
    providerModelPolicy?: string
    auditAttribution: 'user' | 'team'
  }
}

export type AccessCatalogItem = {
  resource: {
    environmentId: string
    type: ResourceType
    id: string
    displayName: string
    resourceRevision?: string
    providerUid?: string
  }
  relationships: CatalogRelationship[]
  capabilities: Capability[]
  accessPaths: AccessCatalogPath[]
}

export type AccessCatalog = {
  contractVersion: typeof ACCESS_CATALOG_CONTRACT_VERSION
  authorizationRevision: string
  generatedAt: string
  complete: boolean
  partialErrors: AccessCatalogPartialError[]
  items: AccessCatalogItem[]
  nextCursor?: string
}

export type AccessCatalogQuery = {
  limit?: number
  cursor?: string
  resourceTypes?: ResourceType[]
}

type AuthoritySnapshot = {
  userId: string
  sessionVersion: number
  userRevision: number
  memberships: Array<{
    teamId: string
    teamName: string
    role: TeamRole
    membershipUpdatedAt: string
    teamRevision: number
  }>
}

type DbSeedRow = {
  resource_type: ResourceType
  logical_id: string
  display_name: string
  kind: 'direct' | 'team'
  grant_id: string
  team_id: string | null
  team_name: string | null
  current_role: TeamRole | null
  capabilities: unknown
  permissions: unknown
  resource_revision: unknown
  authorization_resource_revision?: unknown
  relationship_type: string | null
  relationship_target_type: ResourceType | null
  relationship_target_id: string | null
  provider_uid: string | null
  budget_ref: string | null
  credential_policy_ref: string | null
  approval_policy_ref: string | null
  filesystem_scope_ref: string | null
  runtime_ref: string | null
  provider_model_policy_ref: string | null
}

type K8sShape = {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    deletionTimestamp?: string | null
  }
  spec?: {
    enabled?: boolean
    host?: string
    contextId?: string
    contextRef?: string
    mcpServers?: unknown[]
    sharedFileSystems?: Array<{ name?: string; mountPath?: string }>
    ui?: { title?: string }
  }
  status?: { phase?: string }
}

export class AccessCatalogCursorError extends Error {
  constructor(readonly code: 'invalid_request' | 'access_path_stale') {
    super(code)
    this.name = 'AccessCatalogCursorError'
  }
}

export class AccessCatalogAuthorityUnavailableError extends Error {
  constructor(readonly correlationId?: string) {
    super('authorization authority unavailable')
    this.name = 'AccessCatalogAuthorityUnavailableError'
  }
}

export class AccessCatalogInvalidSessionError extends Error {
  constructor() {
    super('invalid session')
    this.name = 'AccessCatalogInvalidSessionError'
  }
}

function canonicalEnvironmentId(): string {
  const environment = process.env.TRACING_ENVIRONMENT?.trim() || 'development'
  const cluster =
    process.env.TRACING_CLUSTER_NAME?.trim() ||
    process.env.KUBERNETES_CLUSTER_NAME?.trim() ||
    'local-cluster'
  return `${environment}:${cluster}`
}

function asRole(value: unknown): TeamRole | null {
  return value === 'admin' || value === 'inviter' || value === 'member' ? value : null
}

function parseMemberships(value: unknown): AuthoritySnapshot['memberships'] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const teamId = String(row.teamId || '').trim()
    const role = asRole(row.role)
    if (!teamId || !role) return []
    return [
      {
        teamId,
        teamName: String(row.teamName || ''),
        role,
        membershipUpdatedAt: String(row.membershipUpdatedAt || ''),
        teamRevision: Number(row.teamRevision || 1),
      },
    ]
  })
}

async function loadAuthoritySnapshot(
  db: Pick<DbClient, 'query'>,
  claims: AuthClaims
): Promise<AuthoritySnapshot | null> {
  const result = await db.query(
    `WITH active_memberships AS (
       SELECT tm.team_id,
              t.name AS team_name,
              tm.role,
              tm.updated_at,
              COALESCE(atr.revision, 1) AS team_revision
         FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
    LEFT JOIN authorization_team_revisions atr ON atr.team_id = tm.team_id
        WHERE tm.user_id = $1
          AND tm.status = 'active'
     )
     SELECT u.id AS user_id,
            COALESCE(aur.revision, 1) AS user_revision,
            CASE
              WHEN $2::text IS NULL THEN 0
              ELSE s.session_version
            END AS session_version,
            CASE WHEN $2::text IS NULL THEN TRUE ELSE s.sid IS NOT NULL END AS session_live,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'teamId', am.team_id,
                  'teamName', am.team_name,
                  'role', am.role,
                  'membershipUpdatedAt', am.updated_at,
                  'teamRevision', am.team_revision
                ) ORDER BY am.team_id
              ) FILTER (WHERE am.team_id IS NOT NULL),
              '[]'::jsonb
            ) AS memberships
       FROM users u
  LEFT JOIN authorization_user_revisions aur ON aur.user_id = u.id
  LEFT JOIN external_user_sessions s
         ON s.sid::text = $2
        AND s.user_id = u.id
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > NOW()
        AND s.absolute_expires_at > NOW()
  LEFT JOIN active_memberships am ON TRUE
      WHERE u.id = $1
   GROUP BY u.id, aur.revision, s.session_version, s.sid`,
    [claims.userId, claims.sessionContract === 'v2' ? (claims.sid ?? null) : null]
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row || row.session_live !== true) return null
  return {
    userId: String(row.user_id),
    sessionVersion: Number(row.session_version || 0),
    userRevision: Number(row.user_revision || 1),
    memberships: parseMemberships(row.memberships),
  }
}

export function accessCatalogGrantSql(): string {
  return `WITH active_memberships AS (
      SELECT tm.team_id, t.name AS team_name, tm.role
        FROM team_members tm
        JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1
         AND tm.status = 'active'
    ), catalog_paths AS (
      SELECT 'user'::text AS resource_type,
             u.id::text AS logical_id,
             COALESCE(NULLIF(u.name, ''), u.email) AS display_name,
             'direct'::text AS kind,
             'users:' || u.id AS grant_id,
             NULL::uuid AS team_id, NULL::text AS team_name, NULL::text AS current_role,
             ARRAY['user.profile.read']::text[] AS capabilities,
             NULL::text[] AS permissions,
             u.updated_at::text AS resource_revision,
             NULL::text AS relationship_type, NULL::text AS relationship_target_type,
             NULL::text AS relationship_target_id, NULL::text AS provider_uid,
             NULL::text AS budget_ref, NULL::text AS credential_policy_ref,
             NULL::text AS approval_policy_ref, NULL::text AS filesystem_scope_ref,
             NULL::text AS runtime_ref, NULL::text AS provider_model_policy_ref
        FROM users u WHERE u.id = $1
      UNION ALL
      SELECT 'team', am.team_id::text, am.team_name, 'team',
             'team_members:' || am.team_id || ':' || $1,
             am.team_id, am.team_name, am.role,
             CASE am.role
               WHEN 'admin' THEN ARRAY[
                 'team.read','team.manage','team.member.read','team.member.invite','team.member.manage'
               ]::text[]
               WHEN 'inviter' THEN ARRAY['team.read','team.member.read','team.member.invite']::text[]
               ELSE ARRAY['team.read']::text[]
             END,
             NULL::text[], NULL::text, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL
        FROM active_memberships am
      UNION ALL
      SELECT 'host', ua.agent_name, ua.agent_name, 'direct',
             'user_agents:' || ua.user_id || ':' || ua.agent_name,
             NULL, NULL, NULL, ARRAY['host.read']::text[], NULL::text[], ua.created_at::text,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM user_agents ua WHERE ua.user_id = $1
      UNION ALL
      SELECT 'host', ta.agent_name, ta.agent_name, 'team',
             'team_agents:' || ta.team_id || ':' || ta.agent_name,
             am.team_id, am.team_name, am.role, ARRAY['host.read']::text[], NULL::text[],
             ta.created_at::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM team_agents ta JOIN active_memberships am ON am.team_id = ta.team_id
      UNION ALL
      SELECT 'context', uc.context_id, uc.context_id, 'direct',
             'user_contexts:' || uc.user_id || ':' || uc.context_id,
             NULL, NULL, NULL, ARRAY['context.read']::text[], NULL::text[], uc.created_at::text,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM user_contexts uc WHERE uc.user_id = $1
      UNION ALL
      SELECT 'context', tc.context_id, tc.context_id, 'team',
             'team_contexts:' || tc.team_id || ':' || tc.context_id,
             am.team_id, am.team_name, am.role, ARRAY['context.read']::text[], NULL::text[],
             tc.created_at::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM team_contexts tc JOIN active_memberships am ON am.team_id = tc.team_id
      UNION ALL
      SELECT 'workflow_recipe', uwt.recipe_namespace || '/' || uwt.recipe_name,
             uwt.recipe_name, 'direct',
             'user_workflow_triggers:' || uwt.user_id || ':' ||
               uwt.recipe_namespace || '/' || uwt.recipe_name,
             NULL, NULL, NULL, ARRAY['workflow.read']::text[], NULL::text[], uwt.created_at::text,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM user_workflow_triggers uwt WHERE uwt.user_id = $1
      UNION ALL
      SELECT 'workflow_recipe', twt.recipe_namespace || '/' || twt.recipe_name,
             twt.recipe_name, 'team',
             'team_workflow_triggers:' || twt.team_id || ':' ||
               twt.recipe_namespace || '/' || twt.recipe_name,
             am.team_id, am.team_name, am.role, ARRAY['workflow.read']::text[], NULL::text[],
             twt.created_at::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM team_workflow_triggers twt JOIN active_memberships am ON am.team_id = twt.team_id
      UNION ALL
      SELECT 'workflow_run', wr.run_id::text, wr.run_id::text, 'direct',
             'workflow_runs:user:' || wr.run_id,
             NULL, NULL, NULL, ARRAY['workflow.read']::text[], NULL::text[], wr.updated_at::text,
             'recipe', 'workflow_recipe', wr.recipe_namespace || '/' || wr.recipe_name,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM workflow_runs wr
        JOIN user_workflow_triggers uwt
          ON uwt.user_id = $1
         AND uwt.recipe_namespace = wr.recipe_namespace
         AND uwt.recipe_name = wr.recipe_name
       WHERE wr.actor_type = 'user' AND wr.actor_id = $1
      UNION ALL
      SELECT 'workflow_run', wr.run_id::text, wr.run_id::text, 'team',
             'workflow_runs:team:' || am.team_id || ':' || wr.run_id,
             am.team_id, am.team_name, am.role, ARRAY['workflow.read']::text[], NULL::text[],
             wr.updated_at::text, 'recipe', 'workflow_recipe',
             wr.recipe_namespace || '/' || wr.recipe_name,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM workflow_runs wr
        JOIN active_memberships am
          ON am.team_id = wr.team_id OR am.team_id::text = wr.usage_team_id
        JOIN team_workflow_triggers twt
          ON twt.team_id = am.team_id
         AND twt.recipe_namespace = wr.recipe_namespace
         AND twt.recipe_name = wr.recipe_name
      UNION ALL
      SELECT 'workflow_approval', war.id::text, war.id::text, 'direct',
             'workflow_approval_requests:user:' || war.id,
             NULL, NULL, NULL, ARRAY['workflow.approval.decide']::text[], NULL::text[],
             war.requested_at::text, 'recipe', 'workflow_recipe',
             war.recipe_namespace || '/' || war.recipe_name,
             NULL, NULL, NULL, 'approval:' || war.id, NULL, NULL, NULL
        FROM workflow_approval_requests war
        JOIN user_workflow_triggers uwt
          ON uwt.user_id = $1
         AND uwt.recipe_namespace = war.recipe_namespace
         AND uwt.recipe_name = war.recipe_name
       WHERE war.target_user_id = $1 AND war.status = 'pending' AND war.expires_at > NOW()
      UNION ALL
      SELECT 'workflow_approval', war.id::text, war.id::text, 'team',
             'workflow_approval_requests:team:' || am.team_id || ':' || war.id,
             am.team_id, am.team_name, am.role, ARRAY['workflow.approval.decide']::text[],
             NULL::text[], war.requested_at::text, 'recipe', 'workflow_recipe',
             war.recipe_namespace || '/' || war.recipe_name,
             NULL, NULL, NULL, 'approval:' || war.id, NULL, NULL, NULL
        FROM workflow_approval_requests war
        JOIN active_memberships am ON am.team_id = war.target_team_id
        JOIN team_workflow_triggers twt
          ON twt.team_id = am.team_id
         AND twt.recipe_namespace = war.recipe_namespace
         AND twt.recipe_name = war.recipe_name
       WHERE war.status = 'pending' AND war.expires_at > NOW()
      UNION ALL
      SELECT 'gfs_resource', gr.resource_id::text, r.name,
             CASE WHEN gr.subject_type = 'user' THEN 'direct' ELSE 'team' END,
             'gfs_grants:' || gr.id,
             am.team_id, am.team_name, am.role, ARRAY[]::text[], gr.permissions,
             r.updated_at::text, 'parent', 'gfs_resource', r.parent_resource_id::text,
             NULL, NULL, NULL, NULL,
             'gfs:' || gr.drive || ':' || gr.resource_id, NULL, NULL
        FROM gfs_grants gr
        JOIN gfs_resources r ON r.resource_id = gr.resource_id AND r.deleted_at IS NULL
   LEFT JOIN active_memberships am
          ON gr.subject_type = 'team' AND am.team_id::text = gr.subject_id
       WHERE (gr.subject_type = 'user' AND gr.subject_id = $1::text)
          OR (gr.subject_type = 'team' AND am.team_id IS NOT NULL)
      UNION ALL
      SELECT 'gfs_resource', gs.resource_id::text, r.name,
             CASE WHEN gs.subject_type = 'user' THEN 'direct' ELSE 'team' END,
             'gfs_shares:' || gs.id,
             am.team_id, am.team_name, am.role, ARRAY[]::text[], gs.permissions,
             r.updated_at::text, 'parent', 'gfs_resource', r.parent_resource_id::text,
             NULL, NULL, NULL, NULL,
             'gfs:' || gs.drive || ':' || gs.resource_id, NULL, NULL
        FROM gfs_shares gs
        JOIN gfs_resources r ON r.resource_id = gs.resource_id AND r.deleted_at IS NULL
   LEFT JOIN active_memberships am
          ON gs.subject_type = 'team' AND am.team_id::text = gs.subject_id
       WHERE (gs.subject_type = 'user' AND gs.subject_id = $1::text)
          OR (gs.subject_type = 'team' AND am.team_id IS NOT NULL)
      UNION ALL
      SELECT 'notification', nd.id::text, nd.event_type, 'direct',
             'notification_deliveries:' || nd.id,
             NULL, NULL, NULL, ARRAY['notification.read']::text[], NULL::text[],
             nd.created_at::text, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL
        FROM notification_deliveries nd
       WHERE nd.audience->>'userId' = $1::text
         AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
      UNION ALL
      SELECT 'notification', nd.id::text, nd.event_type, 'team',
             'notification_deliveries:team:' || am.team_id || ':' || nd.id,
             am.team_id, am.team_name, am.role, ARRAY['notification.read']::text[],
             NULL::text[], nd.created_at::text, 'team', 'team', am.team_id::text,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM notification_deliveries nd
        JOIN active_memberships am ON am.team_id::text = nd.audience->>'teamId'
       WHERE nd.expires_at IS NULL OR nd.expires_at > NOW()
    )
    SELECT cp.resource_type,
           cp.logical_id,
           cp.display_name,
           cp.kind,
           cp.grant_id,
           cp.team_id,
           cp.team_name,
           cp.current_role,
           cp.capabilities,
           cp.permissions,
           cp.resource_revision,
           COALESCE(arr.revision, 1) AS authorization_resource_revision,
           cp.relationship_type,
           cp.relationship_target_type,
           cp.relationship_target_id,
           cp.provider_uid,
           cp.budget_ref,
           cp.credential_policy_ref,
           cp.approval_policy_ref,
           cp.filesystem_scope_ref,
           cp.runtime_ref,
           cp.provider_model_policy_ref
      FROM catalog_paths cp
 LEFT JOIN authorization_resource_revisions arr
        ON arr.environment_id = $2
       AND arr.resource_type = cp.resource_type
       AND arr.resource_id = cp.logical_id`
}

function permissionsToCapabilities(values: unknown): Capability[] {
  if (!Array.isArray(values)) return []
  return values.flatMap(value => {
    const candidate = `gfs.${String(value)}`
    return isCapability(candidate) ? [candidate] : []
  })
}

function rowCapabilities(row: DbSeedRow): Capability[] {
  const values =
    Array.isArray(row.permissions) && row.permissions.length
      ? permissionsToCapabilities(row.permissions)
      : Array.isArray(row.capabilities)
        ? row.capabilities.filter(isCapability)
        : []
  return normalizeCapabilities(values)
}

function relationshipFromRow(row: DbSeedRow): CatalogRelationship[] {
  if (!row.relationship_type || !row.relationship_target_type || !row.relationship_target_id) {
    return []
  }
  return [
    {
      type: row.relationship_type,
      targetResourceId: `${row.relationship_target_type}:${row.relationship_target_id}`,
    },
  ]
}

function pathSeedFromRow(row: DbSeedRow, userId: string): CatalogPathSeed | null {
  if (row.kind !== 'direct' && row.kind !== 'team') return null
  const role = asRole(row.current_role)
  if (row.kind === 'team' && (!row.team_id || !role)) return null
  return {
    kind: row.kind,
    grantId: row.grant_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.team_name ? { teamName: row.team_name } : {}),
    ...(role ? { currentRole: role } : {}),
    behavior: {
      capabilities: rowCapabilities(row),
      budgetRef: row.budget_ref,
      credentialPolicyRef: row.credential_policy_ref,
      approvalPolicyRef: row.approval_policy_ref,
      filesystemScopeRef: row.filesystem_scope_ref,
      runtimeRef: row.runtime_ref,
      providerModelPolicyRef: row.provider_model_policy_ref,
      auditSubject: row.kind === 'team' ? `team:${row.team_id}` : `user:${userId}`,
    },
  }
}

function rowToSeed(row: DbSeedRow, environmentId: string, userId: string): CatalogSeed | null {
  const pathSeed = pathSeedFromRow(row, userId)
  if (!pathSeed || !row.logical_id || !row.display_name) return null
  return {
    resource: canonicalResourceIdentity({
      environmentId,
      type: row.resource_type,
      logicalId: row.logical_id,
      displayName: row.display_name,
      providerUid: row.provider_uid,
    }),
    relationships: relationshipFromRow(row),
    pathSeeds: [pathSeed],
    authorizationResourceRevision: Number(row.authorization_resource_revision || 1),
    ...(row.resource_revision ? { resourceRevision: String(row.resource_revision) } : {}),
  }
}

function pathSeedKey(path: CatalogPathSeed): string {
  return JSON.stringify([path.kind, path.teamId ?? '', path.grantId])
}

function relationshipKey(relationship: CatalogRelationship): string {
  return JSON.stringify([relationship.type, relationship.targetResourceId])
}

export function mergeCatalogSeeds(seeds: readonly CatalogSeed[]): CatalogSeed[] {
  const merged = new Map<string, CatalogSeed>()
  for (const seed of seeds) {
    const key = resourceIdentityKey(seed.resource)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, {
        ...seed,
        relationships: [...seed.relationships],
        pathSeeds: [...seed.pathSeeds],
      })
      continue
    }
    const relationships = new Map(current.relationships.map(item => [relationshipKey(item), item]))
    for (const relationship of seed.relationships) {
      relationships.set(relationshipKey(relationship), relationship)
    }
    const paths = new Map(current.pathSeeds.map(item => [pathSeedKey(item), item]))
    for (const path of seed.pathSeeds) paths.set(pathSeedKey(path), path)
    current.relationships = [...relationships.values()].sort((a, b) =>
      relationshipKey(a).localeCompare(relationshipKey(b))
    )
    current.pathSeeds = [...paths.values()].sort((a, b) =>
      pathSeedKey(a).localeCompare(pathSeedKey(b))
    )
    if (seed.resourceRevision) current.resourceRevision = seed.resourceRevision
    current.authorizationResourceRevision = seed.authorizationResourceRevision
    if (seed.resource.providerUid) current.resource.providerUid = seed.resource.providerUid
    current.resource.displayName = seed.resource.displayName
  }
  return [...merged.values()].sort((a, b) =>
    resourceIdentityKey(a.resource).localeCompare(resourceIdentityKey(b.resource))
  )
}

function scopedLogicalId(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

function providerProjection(resource: K8sShape): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        resource.metadata?.uid ?? null,
        resource.metadata?.resourceVersion ?? null,
        resource.metadata?.deletionTimestamp ?? null,
        resource.spec?.enabled ?? null,
        resource.spec?.contextRef ?? null,
        resource.spec?.mcpServers ?? null,
        resource.spec?.sharedFileSystems ?? null,
        resource.spec?.ui ? true : false,
      ])
    )
    .digest('base64url')
}

type OperationalSourceResult =
  | { sourceCode: string; status: 'fulfilled'; resources: K8sShape[] }
  | { sourceCode: string; status: 'rejected' }

async function loadOperationalSources(gateway: K8sGateway): Promise<OperationalSourceResult[]> {
  const sources = [
    { sourceCode: 'hosts', plural: 'hosts' as const, namespace: config.hostsNamespace },
    { sourceCode: 'contexts', plural: 'contexts' as const, namespace: config.contextsNamespace },
    {
      sourceCode: 'mcp_servers',
      plural: 'mcpservers' as const,
      namespace: config.mcpServersNamespace,
    },
    {
      sourceCode: 'workflow_recipes',
      plural: 'workflowrecipes' as const,
      namespace: config.sandboxNamespace,
    },
    {
      sourceCode: 'shared_filesystems',
      plural: 'sharedfilesystems' as const,
      namespace: config.sharedFilesystemsNamespace,
    },
  ]
  const settled = await Promise.allSettled(
    sources.map(source => gateway.listResource(source.plural, source.namespace))
  )
  return settled.map((result, index) => {
    const sourceCode = sources[index]!.sourceCode
    if (result.status === 'rejected') return { sourceCode, status: 'rejected' }
    return {
      sourceCode,
      status: 'fulfilled',
      resources: Array.isArray(result.value) ? (result.value as K8sShape[]) : [],
    }
  })
}

function operationalMap(
  results: OperationalSourceResult[],
  sourceCode: string,
  namespace: string
): Map<string, K8sShape> | null {
  const source = results.find(result => result.sourceCode === sourceCode)
  if (!source || source.status === 'rejected') return null
  const mapped = new Map<string, K8sShape>()
  for (const resource of source.resources) {
    const name = resource.metadata?.name?.trim()
    if (!name || resource.metadata?.deletionTimestamp || resource.spec?.enabled === false) continue
    const reportedNamespace = resource.metadata?.namespace?.trim() || namespace
    if (reportedNamespace !== namespace) continue
    mapped.set(scopedLogicalId(namespace, name), resource)
  }
  return mapped
}

function propagatePath(
  path: CatalogPathSeed,
  grantSuffix: string,
  capabilities: Capability[],
  behaviorOverrides: Partial<AccessPathBehavior> = {}
): CatalogPathSeed {
  return {
    ...path,
    grantId: `${path.grantId}:${grantSuffix}`,
    behavior: {
      ...path.behavior,
      ...behaviorOverrides,
      capabilities,
    },
  }
}

function hydrateOperationalSeeds(
  dbSeeds: CatalogSeed[],
  results: OperationalSourceResult[],
  environmentId: string
): CatalogSeed[] {
  const hosts = operationalMap(results, 'hosts', config.hostsNamespace)
  const contexts = operationalMap(results, 'contexts', config.contextsNamespace)
  const mcpServers = operationalMap(results, 'mcp_servers', config.mcpServersNamespace)
  const recipes = operationalMap(results, 'workflow_recipes', config.sandboxNamespace)
  const sharedFilesystems = operationalMap(
    results,
    'shared_filesystems',
    config.sharedFilesystemsNamespace
  )
  const kept: CatalogSeed[] = []
  const derived: CatalogSeed[] = []
  const contextSeeds = new Map<string, CatalogSeed>()
  const hostContextPaths: Array<{ contextName: string; host: CatalogSeed }> = []

  for (const seed of dbSeeds) {
    if (seed.resource.type === 'host') {
      const logicalId = scopedLogicalId(config.hostsNamespace, seed.resource.logicalId)
      const resource = hosts?.get(logicalId)
      if (hosts && !resource) continue
      if (resource) {
        seed.resource = canonicalResourceIdentity({
          environmentId,
          type: 'host',
          logicalId,
          displayName:
            resource.spec?.host?.trim() || resource.metadata?.name || seed.resource.displayName,
          providerUid: resource.metadata?.uid,
        })
        seed.resourceRevision = providerProjection(resource)
        const contextRef = resource.spec?.contextRef?.trim()
        if (contextRef) {
          seed.relationships.push({
            type: 'context',
            targetResourceId: `context:${scopedLogicalId(config.contextsNamespace, contextRef)}`,
          })
          hostContextPaths.push({ contextName: contextRef, host: seed })
        }
      } else {
        seed.resource = canonicalResourceIdentity({
          environmentId,
          type: 'host',
          logicalId,
          displayName: seed.resource.displayName,
        })
      }
    } else if (seed.resource.type === 'context') {
      const logicalId = scopedLogicalId(config.contextsNamespace, seed.resource.logicalId)
      const resource = contexts?.get(logicalId)
      if (contexts && !resource) continue
      seed.resource = canonicalResourceIdentity({
        environmentId,
        type: 'context',
        logicalId,
        displayName: resource?.metadata?.name || seed.resource.displayName,
        providerUid: resource?.metadata?.uid,
      })
      if (resource) seed.resourceRevision = providerProjection(resource)
      contextSeeds.set(seed.resource.logicalId, seed)
    } else if (seed.resource.type === 'workflow_recipe') {
      const resource = recipes?.get(seed.resource.logicalId)
      if (recipes && !resource) continue
      if (resource) {
        seed.resource = canonicalResourceIdentity({
          environmentId,
          type: 'workflow_recipe',
          logicalId: seed.resource.logicalId,
          displayName: resource.metadata?.name || seed.resource.displayName,
          providerUid: resource.metadata?.uid,
        })
        seed.resourceRevision = providerProjection(resource)
        if (resource.spec?.ui) {
          const appIdentity = canonicalResourceIdentity({
            environmentId,
            type: 'sandbox_app',
            logicalId: seed.resource.logicalId,
            displayName: resource.spec.ui.title?.trim() || seed.resource.displayName,
            providerUid: resource.metadata?.uid,
          })
          derived.push({
            resource: appIdentity,
            authorizationResourceRevision: seed.authorizationResourceRevision,
            resourceRevision: providerProjection(resource),
            relationships: [{ type: 'recipe', targetResourceId: seed.resource.canonicalId }],
            pathSeeds: seed.pathSeeds.map(path =>
              propagatePath(path, 'sandbox-app', ['sandbox_app.read'])
            ),
          })
          seed.relationships.push({
            type: 'sandbox_app',
            targetResourceId: appIdentity.canonicalId,
          })
        }
      }
    }
    kept.push(seed)
  }

  if (contexts) {
    const byContextName = new Map(
      [...contexts.entries()].map(([id, resource]) => [resource.metadata?.name ?? id, resource])
    )
    for (const contextSeed of contextSeeds.values()) {
      const contextName = contextSeed.resource.logicalId.split('/').pop() || ''
      const contextResource = byContextName.get(contextName)
      if (!contextResource) continue
      const mcpNames = Array.isArray(contextResource.spec?.mcpServers)
        ? contextResource.spec!.mcpServers!.filter(
            (value): value is string => typeof value === 'string' && Boolean(value.trim())
          )
        : []
      for (const name of mcpNames) {
        const logicalId = scopedLogicalId(config.mcpServersNamespace, name.trim())
        const server = mcpServers?.get(logicalId)
        if (mcpServers && !server) continue
        const identity = canonicalResourceIdentity({
          environmentId,
          type: 'mcp_server',
          logicalId,
          displayName: server?.metadata?.name || name.trim(),
          providerUid: server?.metadata?.uid,
        })
        derived.push({
          resource: identity,
          authorizationResourceRevision: contextSeed.authorizationResourceRevision,
          ...(server ? { resourceRevision: providerProjection(server) } : {}),
          relationships: [{ type: 'context', targetResourceId: contextSeed.resource.canonicalId }],
          pathSeeds: contextSeed.pathSeeds.map(path =>
            propagatePath(path, `mcp-server:${name.trim()}`, ['mcp_server.read'])
          ),
        })
        contextSeed.relationships.push({
          type: 'mcp_server',
          targetResourceId: identity.canonicalId,
        })
      }

      for (const reference of contextResource.spec?.sharedFileSystems ?? []) {
        const name = reference.name?.trim()
        const mountPath = reference.mountPath?.trim()
        if (!name || !mountPath) continue
        const logicalId = scopedLogicalId(config.sharedFilesystemsNamespace, name)
        const sfs = sharedFilesystems?.get(logicalId)
        if (sharedFilesystems && !sfs) continue
        const identity = canonicalResourceIdentity({
          environmentId,
          type: 'shared_filesystem',
          logicalId,
          displayName: sfs?.metadata?.name || name,
          providerUid: sfs?.metadata?.uid,
        })
        const scopeFingerprint = createHash('sha256')
          .update(`${contextSeed.resource.logicalId}\u0000${logicalId}\u0000${mountPath}`)
          .digest('base64url')
        derived.push({
          resource: identity,
          authorizationResourceRevision: contextSeed.authorizationResourceRevision,
          ...(sfs ? { resourceRevision: providerProjection(sfs) } : {}),
          relationships: [{ type: 'context', targetResourceId: contextSeed.resource.canonicalId }],
          pathSeeds: contextSeed.pathSeeds.map(path =>
            propagatePath(path, `shared-filesystem:${name}`, ['shared_filesystem.read'], {
              filesystemScopeRef: `sfs-scope:${scopeFingerprint}`,
            })
          ),
        })
        contextSeed.relationships.push({
          type: 'shared_filesystem',
          targetResourceId: identity.canonicalId,
        })
      }
    }

    // Existing Host discovery authorizes connector names through the Host's
    // Context relationship even when the user has no independent Context grant.
    // Preserve that producer rule while keeping the Host grant as provenance.
    for (const { contextName, host } of hostContextPaths) {
      const contextResource = byContextName.get(contextName)
      if (!contextResource) continue
      const mcpNames = Array.isArray(contextResource.spec?.mcpServers)
        ? contextResource.spec!.mcpServers!.filter(
            (value): value is string => typeof value === 'string' && Boolean(value.trim())
          )
        : []
      for (const name of mcpNames) {
        const logicalId = scopedLogicalId(config.mcpServersNamespace, name.trim())
        const server = mcpServers?.get(logicalId)
        if (mcpServers && !server) continue
        const identity = canonicalResourceIdentity({
          environmentId,
          type: 'mcp_server',
          logicalId,
          displayName: server?.metadata?.name || name.trim(),
          providerUid: server?.metadata?.uid,
        })
        derived.push({
          resource: identity,
          authorizationResourceRevision: host.authorizationResourceRevision,
          ...(server ? { resourceRevision: providerProjection(server) } : {}),
          relationships: [{ type: 'host', targetResourceId: host.resource.canonicalId }],
          pathSeeds: host.pathSeeds.map(path =>
            propagatePath(path, `mcp-server:${name.trim()}`, ['mcp_server.read'])
          ),
        })
      }
    }
  }

  return mergeCatalogSeeds([...kept, ...derived])
}

function revisionFor(snapshot: AuthoritySnapshot, seeds: readonly CatalogSeed[]): string {
  const projected = seeds.map(seed => [
    resourceIdentityKey(seed.resource),
    seed.resource.displayName,
    seed.resourceRevision ?? null,
    seed.relationships.map(relationshipKey).sort(),
    seed.pathSeeds.map(path => [
      pathSeedKey(path),
      path.teamName ?? null,
      path.currentRole ?? null,
      normalizeCapabilities(path.behavior.capabilities),
      path.behavior.budgetRef,
      path.behavior.credentialPolicyRef,
      path.behavior.approvalPolicyRef,
      path.behavior.filesystemScopeRef,
      path.behavior.runtimeRef,
      path.behavior.providerModelPolicyRef,
      path.behavior.auditSubject,
    ]),
  ])
  return createHash('sha256')
    .update(
      JSON.stringify([
        'access_catalog_authorization_revision_v2',
        snapshot.userId,
        snapshot.sessionVersion,
        snapshot.userRevision,
        snapshot.memberships.map(membership => [
          membership.teamId,
          membership.role,
          membership.membershipUpdatedAt,
          membership.teamRevision,
        ]),
        projected,
      ])
    )
    .digest('base64url')
}

function fingerprint(label: string, value: string | null): string | undefined {
  if (!value) return undefined
  return `fp1_${createHash('sha256').update(`${label}\u0000${value}`).digest('base64url')}`
}

function safePath(path: AccessPath, seed: CatalogPathSeed): AccessCatalogPath {
  return {
    accessPathId: path.id,
    kind: path.kind,
    ...(path.teamId
      ? {
          safeTeamDescriptor: {
            id: path.teamId,
            ...(seed.teamName ? { name: seed.teamName } : {}),
            ...(path.currentRole ? { currentRole: path.currentRole } : {}),
          },
        }
      : {}),
    capabilities: [...path.behavior.capabilities],
    behaviorDescriptors: {
      ...(fingerprint('budget', path.behavior.budgetRef)
        ? { budget: fingerprint('budget', path.behavior.budgetRef) }
        : {}),
      ...(fingerprint('credentials', path.behavior.credentialPolicyRef)
        ? { credentials: fingerprint('credentials', path.behavior.credentialPolicyRef) }
        : {}),
      ...(fingerprint('approval', path.behavior.approvalPolicyRef)
        ? { approvalPolicy: fingerprint('approval', path.behavior.approvalPolicyRef) }
        : {}),
      ...(fingerprint('filesystem', path.behavior.filesystemScopeRef)
        ? { filesystemScope: fingerprint('filesystem', path.behavior.filesystemScopeRef) }
        : {}),
      ...(fingerprint('runtime', path.behavior.runtimeRef)
        ? { runtime: fingerprint('runtime', path.behavior.runtimeRef) }
        : {}),
      ...(fingerprint('provider-model', path.behavior.providerModelPolicyRef)
        ? {
            providerModelPolicy: fingerprint(
              'provider-model',
              path.behavior.providerModelPolicyRef
            ),
          }
        : {}),
      auditAttribution: path.kind === 'team' ? 'team' : 'user',
    },
  }
}

function itemFromSeed(seed: CatalogSeed, snapshot: AuthoritySnapshot): AccessCatalogItem {
  const authorizationRevision = resourceAuthorizationRevision({
    userId: snapshot.userId,
    userRevision: snapshot.userRevision,
    sessionVersion: snapshot.sessionVersion,
    memberships: snapshot.memberships,
    resource: seed.resource,
    resourceRevision: seed.authorizationResourceRevision,
    candidates: seed.pathSeeds.map(path => ({
      kind: path.kind,
      grantId: path.grantId,
      ...(path.teamId ? { teamId: path.teamId } : {}),
      ...(path.currentRole ? { currentRole: path.currentRole } : {}),
      capabilities: [...path.behavior.capabilities],
      budgetRef: path.behavior.budgetRef,
      credentialPolicyRef: path.behavior.credentialPolicyRef,
      approvalPolicyRef: path.behavior.approvalPolicyRef,
      filesystemScopeRef: path.behavior.filesystemScopeRef,
      runtimeRef: path.behavior.runtimeRef,
      providerModelPolicyRef: path.behavior.providerModelPolicyRef,
      auditSubject: path.behavior.auditSubject,
    })),
  })
  const paths = seed.pathSeeds.map(pathSeed => {
    const path = buildAccessPath({
      principalUserId: snapshot.userId,
      resource: seed.resource,
      kind: pathSeed.kind,
      grantId: pathSeed.grantId,
      ...(pathSeed.teamId ? { teamId: pathSeed.teamId } : {}),
      ...(pathSeed.currentRole ? { currentRole: pathSeed.currentRole } : {}),
      authorizationRevision,
      behavior: pathSeed.behavior,
    })
    return safePath(path, pathSeed)
  })
  paths.sort((a, b) =>
    JSON.stringify([
      a.kind === 'direct' ? 0 : 1,
      a.safeTeamDescriptor?.id ?? '',
      a.accessPathId,
    ]).localeCompare(
      JSON.stringify([b.kind === 'direct' ? 0 : 1, b.safeTeamDescriptor?.id ?? '', b.accessPathId])
    )
  )
  return {
    resource: {
      environmentId: seed.resource.environmentId,
      type: seed.resource.type,
      id: seed.resource.canonicalId,
      displayName: seed.resource.displayName,
      ...(seed.resourceRevision ? { resourceRevision: seed.resourceRevision } : {}),
      ...(seed.resource.providerUid ? { providerUid: seed.resource.providerUid } : {}),
    },
    relationships: [...seed.relationships].sort((a, b) =>
      relationshipKey(a).localeCompare(relationshipKey(b))
    ),
    capabilities: normalizeCapabilities(seed.pathSeeds.flatMap(path => path.behavior.capabilities)),
    accessPaths: paths,
  }
}

type CursorPayload = {
  v: typeof ACCESS_CATALOG_CONTRACT_VERSION
  revision: string
  filters: string[]
  lastKey: string
}

function cursorSignature(payload: string): string {
  return createHmac('sha256', config.sessionJwtPrivateKey).update(payload).digest('base64url')
}

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `ac2.${body}.${cursorSignature(body)}`
}

function decodeCursor(value: string): CursorPayload {
  const [prefix, body, signature, extra] = value.split('.')
  if (prefix !== 'ac2' || !body || !signature || extra) {
    throw new AccessCatalogCursorError('invalid_request')
  }
  const expected = cursorSignature(body)
  const suppliedBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new AccessCatalogCursorError('invalid_request')
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload
    if (
      parsed.v !== ACCESS_CATALOG_CONTRACT_VERSION ||
      typeof parsed.revision !== 'string' ||
      !Array.isArray(parsed.filters) ||
      !parsed.filters.every(filter => typeof filter === 'string') ||
      typeof parsed.lastKey !== 'string'
    ) {
      throw new Error('invalid cursor')
    }
    return parsed
  } catch {
    throw new AccessCatalogCursorError('invalid_request')
  }
}

export async function buildAccessCatalog(
  claims: AuthClaims,
  gateway: K8sGateway,
  query: AccessCatalogQuery = {},
  options: { now?: Date; correlationId?: string } = {}
): Promise<AccessCatalog> {
  const environmentId = canonicalEnvironmentId()
  let snapshot: AuthoritySnapshot | null = null
  let rows: DbSeedRow[] = []
  try {
    await withTransaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      snapshot = await loadAuthoritySnapshot(db, claims)
      if (!snapshot) return
      const grants = await db.query(accessCatalogGrantSql(), [claims.userId, environmentId])
      rows = grants.rows as DbSeedRow[]
    })
  } catch {
    throw new AccessCatalogAuthorityUnavailableError(options.correlationId)
  }
  if (!snapshot) throw new AccessCatalogInvalidSessionError()

  const dbSeeds = mergeCatalogSeeds(
    rows.flatMap(row => {
      const seed = rowToSeed(row, environmentId, claims.userId)
      return seed ? [seed] : []
    })
  )
  const operational = await loadOperationalSources(gateway)
  const partialErrors: AccessCatalogPartialError[] = operational.flatMap(source =>
    source.status === 'rejected'
      ? [
          {
            sourceCode: source.sourceCode,
            category: 'operational_source_unavailable' as const,
            retryable: true as const,
            ...(options.correlationId ? { correlationId: options.correlationId } : {}),
          },
        ]
      : []
  )
  const hydrated = hydrateOperationalSeeds(dbSeeds, operational, environmentId)
  const authorizationRevision = revisionFor(snapshot, hydrated)
  const filters = [...new Set(query.resourceTypes ?? [])].sort()
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  if (
    cursor &&
    (cursor.revision !== authorizationRevision ||
      JSON.stringify(cursor.filters) !== JSON.stringify(filters))
  ) {
    throw new AccessCatalogCursorError('access_path_stale')
  }
  const limit = Math.max(
    1,
    Math.min(ACCESS_CATALOG_MAX_PAGE_SIZE, query.limit ?? ACCESS_CATALOG_DEFAULT_PAGE_SIZE)
  )
  const filtered = hydrated.filter(
    seed => filters.length === 0 || filters.includes(seed.resource.type)
  )
  const afterCursor = cursor
    ? filtered.filter(seed => resourceIdentityKey(seed.resource) > cursor.lastKey)
    : filtered
  const pageSeeds = afterCursor.slice(0, limit)
  const hasNext = afterCursor.length > pageSeeds.length
  const nextCursor =
    hasNext && pageSeeds.length
      ? encodeCursor({
          v: ACCESS_CATALOG_CONTRACT_VERSION,
          revision: authorizationRevision,
          filters,
          lastKey: resourceIdentityKey(pageSeeds[pageSeeds.length - 1]!.resource),
        })
      : undefined
  return {
    contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
    authorizationRevision,
    generatedAt: (options.now ?? new Date()).toISOString(),
    complete: partialErrors.length === 0,
    partialErrors,
    items: pageSeeds.map(seed => itemFromSeed(seed, snapshot!)),
    ...(nextCursor ? { nextCursor } : {}),
  }
}
