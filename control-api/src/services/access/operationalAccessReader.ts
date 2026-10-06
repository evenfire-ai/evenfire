import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import type { CatalogOperationalSourceState } from './catalogContracts.js'
import { canonicalContextLogicalIdSql } from './contextIdentitySql.js'
import type {
  OperationalBehaviorSources,
  OperationalRelationshipRecord,
  OperationalResourceType,
  OperationalSourceFamily,
} from './operationalAccessProjection.js'
import type { AccessResourceType } from './resourceIdentity.js'

export type OperationalIndexedResource = Readonly<{
  environmentId: string
  resourceType: OperationalResourceType
  logicalId: string
  sourceFamily: OperationalSourceFamily
  providerUid: string
  providerResourceVersion: string
  displayName: string
  enabled: boolean
  deletedAt: string | null
  observedGeneration: number | null
  contentBytes: number
  behaviorSources: OperationalBehaviorSources
}>

export type OperationalIndexedRelationship = OperationalRelationshipRecord

export type OperationalResourceGraphResult =
  | Readonly<{
      status: 'current'
      resource: OperationalIndexedResource
      resources: readonly OperationalIndexedResource[]
      relationships: readonly OperationalIndexedRelationship[]
      sourceStateRevision: string
      relationshipsRevision: string
    }>
  | Readonly<{ status: 'not_found'; sourceStateRevision: string }>
  | Readonly<{ status: 'unavailable'; safeCode: string }>

export function operationalResourceGraphKey(
  resourceType: AccessResourceType,
  logicalId: string
): string {
  return JSON.stringify([resourceType, logicalId])
}

/**
 * Restrict a loaded live graph to one selected runtime path. The graph loader
 * intentionally returns the complete candidate neighborhood for derived
 * resources (for example, every Context that includes an MCP server). A path
 * must not inherit policy from sibling Hosts or Contexts in that neighborhood.
 */
export function selectOperationalPathGraph(input: {
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
  contextId?: string
  hostId?: string
  recipeId?: string
}): Extract<OperationalResourceGraphResult, { status: 'current' }> | null {
  const { graph } = input
  const root = graph.resource
  const resourcesByKey = new Map(
    graph.resources.map(resource => [
      JSON.stringify([resource.resourceType, resource.logicalId]),
      resource,
    ])
  )
  let contextId = input.contextId
  let recipeId = input.recipeId
  if (!recipeId && root.resourceType === 'workflow_recipe') recipeId = root.logicalId
  if (!recipeId && root.resourceType === 'sandbox_app') {
    const recipeIds = new Set(
      graph.relationships
        .filter(
          relationship =>
            relationship.sourceType === 'workflow_recipe' &&
            relationship.relationshipType === 'exposes_sandbox_app' &&
            relationship.targetType === 'sandbox_app' &&
            relationship.targetId === root.logicalId
        )
        .map(relationship => relationship.sourceId)
    )
    if (recipeIds.size !== 1) return null
    recipeId = [...recipeIds][0]
  }
  if (!contextId && root.resourceType === 'context') contextId = root.logicalId
  if (!contextId && ['host', 'workflow_recipe', 'sandbox_app'].includes(root.resourceType)) {
    const sourceType = root.resourceType === 'sandbox_app' ? 'workflow_recipe' : root.resourceType
    const sourceId = root.resourceType === 'sandbox_app' ? recipeId : root.logicalId
    const contextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === sourceType &&
        relationship.sourceId === sourceId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context'
    )
    if (contextEdges.length > 1) return null
    if (contextEdges.length === 1) contextId = contextEdges[0]!.targetId
  }

  if (contextId && !resourcesByKey.has(JSON.stringify(['context', contextId]))) return null

  let hostId = input.hostId
  if (!hostId && root.resourceType === 'host') hostId = root.logicalId
  if (hostId && !resourcesByKey.has(JSON.stringify(['host', hostId]))) return null
  if (recipeId && !resourcesByKey.has(JSON.stringify(['workflow_recipe', recipeId]))) return null
  if (hostId) {
    const hostContextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === 'host' &&
        relationship.sourceId === hostId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context'
    )
    if (
      hostContextEdges.length > 1 ||
      (contextId &&
        (hostContextEdges.length !== 1 || hostContextEdges[0]!.targetId !== contextId)) ||
      (!contextId && hostContextEdges.length !== 0)
    ) {
      return null
    }
  }
  if (recipeId && contextId) {
    const recipeContextEdges = graph.relationships.filter(
      relationship =>
        relationship.sourceType === 'workflow_recipe' &&
        relationship.sourceId === recipeId &&
        relationship.relationshipType === 'uses_context' &&
        relationship.targetType === 'context' &&
        relationship.targetId === contextId
    )
    if (recipeContextEdges.length !== 1) return null
  }

  const selectedRelationships = graph.relationships.filter(relationship => {
    if (contextId && relationship.sourceType === 'context' && relationship.sourceId === contextId) {
      return true
    }
    if (
      hostId &&
      relationship.sourceType === 'host' &&
      relationship.sourceId === hostId &&
      relationship.relationshipType === 'uses_context' &&
      relationship.targetId === contextId
    ) {
      return true
    }
    if (
      recipeId &&
      relationship.sourceType === 'workflow_recipe' &&
      relationship.sourceId === recipeId &&
      ((relationship.relationshipType === 'uses_context' && relationship.targetId === contextId) ||
        (root.resourceType === 'sandbox_app' &&
          relationship.relationshipType === 'exposes_sandbox_app' &&
          relationship.targetId === root.logicalId))
    ) {
      return true
    }
    if (relationship.sourceType === root.resourceType && relationship.sourceId === root.logicalId) {
      return true
    }
    return false
  })

  const selectedKeys = new Set<string>([
    JSON.stringify([root.resourceType, root.logicalId]),
    ...(contextId ? [JSON.stringify(['context', contextId])] : []),
    ...(hostId ? [JSON.stringify(['host', hostId])] : []),
    ...(recipeId ? [JSON.stringify(['workflow_recipe', recipeId])] : []),
  ])
  for (const relationship of selectedRelationships) {
    for (const [type, id] of [
      [relationship.sourceType, relationship.sourceId],
      [relationship.targetType, relationship.targetId],
    ] as const) {
      if (
        ['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(type)
      ) {
        selectedKeys.add(JSON.stringify([type, id]))
      }
    }
  }
  const resources = [...selectedKeys]
    .map(key => resourcesByKey.get(key))
    .filter((resource): resource is OperationalIndexedResource => Boolean(resource))
  if (resources.length !== selectedKeys.size) return null

  const relationships = Object.freeze(
    selectedRelationships.sort((left, right) =>
      compareCanonicalUtf8Text(left.relationshipInstanceId, right.relationshipInstanceId)
    )
  )
  return Object.freeze({
    ...graph,
    resources: Object.freeze(resources),
    relationships,
    relationshipsRevision: revisionOfValues(
      relationships.map(relationship => [
        relationship.sourceType,
        relationship.sourceId,
        relationship.relationshipType,
        relationship.targetType,
        relationship.targetId,
        relationship.relationshipInstanceId,
        relationship.behaviorAttributes,
        relationship.sourceProviderUid,
        relationship.sourceResourceVersion,
      ])
    ),
  })
}

const SOURCE_FAMILIES_BY_TYPE: Readonly<
  Partial<Record<AccessResourceType, readonly OperationalSourceFamily[]>>
> = Object.freeze({
  host: ['host', 'context', 'mcp_server', 'shared_filesystem'],
  context: ['context', 'mcp_server', 'shared_filesystem'],
  mcp_server: ['mcp_server', 'context', 'host', 'shared_filesystem'],
  workflow_recipe: ['workflow_recipe', 'context', 'mcp_server', 'shared_filesystem'],
  shared_filesystem: ['shared_filesystem', 'context', 'mcp_server'],
  sandbox_app: ['workflow_recipe', 'context', 'mcp_server', 'shared_filesystem'],
})

export function isOperationalAccessResourceType(type: AccessResourceType): boolean {
  return Boolean(SOURCE_FAMILIES_BY_TYPE[type])
}

function sourceFamilyForType(type: AccessResourceType): OperationalSourceFamily | null {
  if (type === 'sandbox_app') return 'workflow_recipe'
  if (['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(type)) {
    return type as OperationalSourceFamily
  }
  return null
}

function integer(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}_invalid`)
  return result
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value, 'operational_generation')
}

function behaviorAttributes(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('operational_relationship_behavior_invalid')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 16) throw new Error('operational_relationship_behavior_invalid')
  const normalized: Record<string, string | number | boolean> = {}
  for (const [key, item] of entries) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key) ||
      !['string', 'number', 'boolean'].includes(typeof item) ||
      (typeof item === 'string' && item.length > 1_024) ||
      (typeof item === 'number' && !Number.isFinite(item))
    ) {
      throw new Error('operational_relationship_behavior_invalid')
    }
    normalized[key] = item as string | number | boolean
  }
  return Object.freeze(normalized)
}

function parseResource(row: Record<string, unknown>): OperationalIndexedResource {
  const sourceValue = row.behavior_sources
  const source =
    sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)
      ? (sourceValue as Record<string, unknown>)
      : {}
  const policySource = (value: unknown): OperationalBehaviorSources['credentialPolicy'] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return Object.freeze({ state: 'unknown', fingerprint: null })
    }
    const policy = value as Record<string, unknown>
    if (
      (policy.state !== 'known' && policy.state !== 'unknown') ||
      (policy.fingerprint !== null &&
        (typeof policy.fingerprint !== 'string' || policy.fingerprint.length === 0))
    ) {
      return Object.freeze({ state: 'unknown', fingerprint: null })
    }
    return Object.freeze({
      state: policy.state,
      fingerprint: typeof policy.fingerprint === 'string' ? policy.fingerprint : null,
    })
  }
  const strings = (value: unknown): readonly string[] | null =>
    Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 1_024)
      ? Object.freeze([...value])
      : null
  let targetsValid = Array.isArray(source.providerModelTargets)
  const targets = Array.isArray(source.providerModelTargets)
    ? source.providerModelTargets.flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          targetsValid = false
          return []
        }
        const target = value as Record<string, unknown>
        if (
          typeof target.provider !== 'string' ||
          target.provider.length === 0 ||
          target.provider.length > 200 ||
          typeof target.model !== 'string' ||
          target.model.length === 0 ||
          target.model.length > 400
        ) {
          targetsValid = false
          return []
        }
        return [Object.freeze({ provider: target.provider, model: target.model })]
      })
    : []
  const versionValid = source.version === 1
  const unknownPolicy = Object.freeze({ state: 'unknown' as const, fingerprint: null })
  const credentialReferenceNames = strings(source.credentialReferenceNames)
  const credentialReferenceFingerprints = strings(source.credentialReferenceFingerprints)
  const credentialModeValid =
    source.credentialMode === null || typeof source.credentialMode === 'string'
  const credentialConfiguredValid = typeof source.credentialPolicyConfigured === 'boolean'
  const approvalValid =
    source.requiresApproval === null || typeof source.requiresApproval === 'boolean'
  const approvalConfiguredValid = typeof source.approvalPolicyConfigured === 'boolean'
  const credentialPolicy =
    versionValid &&
    credentialReferenceNames &&
    credentialReferenceFingerprints &&
    credentialModeValid
      ? policySource(source.credentialPolicy)
      : unknownPolicy
  return Object.freeze({
    environmentId: String(row.environment_id),
    resourceType: String(row.resource_type) as OperationalResourceType,
    logicalId: String(row.logical_id),
    sourceFamily: String(row.source_family) as OperationalSourceFamily,
    providerUid: String(row.provider_uid),
    providerResourceVersion: String(row.provider_resource_version),
    displayName: typeof row.display_name === 'string' ? row.display_name : String(row.logical_id),
    enabled: row.enabled === true,
    deletedAt: row.deleted_at ? new Date(String(row.deleted_at)).toISOString() : null,
    observedGeneration: nullableInteger(row.observed_generation),
    contentBytes: integer(row.content_bytes, 'operational_content_bytes'),
    behaviorSources: Object.freeze({
      version: 1,
      credentialPolicy,
      credentialMode:
        versionValid && typeof source.credentialMode === 'string' ? source.credentialMode : null,
      credentialPolicyConfigured:
        versionValid && credentialConfiguredValid
          ? (source.credentialPolicyConfigured as boolean)
          : null,
      credentialReferenceNames: credentialReferenceNames ?? Object.freeze([]),
      credentialReferenceFingerprints: credentialReferenceFingerprints ?? Object.freeze([]),
      providerModelPolicy:
        versionValid && targetsValid ? policySource(source.providerModelPolicy) : unknownPolicy,
      providerModelTargets: Object.freeze(targets),
      approvalPolicy:
        versionValid && approvalValid ? policySource(source.approvalPolicy) : unknownPolicy,
      approvalPolicyConfigured:
        versionValid && approvalConfiguredValid
          ? (source.approvalPolicyConfigured as boolean)
          : null,
      requiresApproval:
        versionValid && typeof source.requiresApproval === 'boolean'
          ? source.requiresApproval
          : null,
      runtimePolicy: versionValid ? policySource(source.runtimePolicy) : unknownPolicy,
    }),
  })
}

function parseRelationship(row: Record<string, unknown>): OperationalIndexedRelationship {
  return Object.freeze({
    environmentId: String(row.environment_id),
    sourceType: String(row.source_type) as OperationalResourceType,
    sourceId: String(row.source_id),
    relationshipType: String(
      row.relationship_type
    ) as OperationalIndexedRelationship['relationshipType'],
    targetType: String(row.target_type) as OperationalResourceType,
    targetId: String(row.target_id),
    relationshipInstanceId: String(row.relationship_instance_id),
    behaviorAttributes: behaviorAttributes(row.behavior_attributes),
    sourceFamily: String(row.source_family) as OperationalSourceFamily,
    sourceProviderUid: String(row.source_provider_uid),
    sourceResourceVersion: String(row.source_resource_version),
    observedGeneration: nullableInteger(row.observed_generation),
    contentBytes: integer(row.content_bytes, 'operational_relationship_content_bytes'),
  })
}

async function budgetedQuery(
  db: Pick<DbClient, 'query'>,
  budget: AccessExecutionBudget,
  text: string,
  values: unknown[]
) {
  return runAccessDatabaseQuery(db, budget, text, values)
}

/**
 * Load heterogeneous operational resource graphs with a constant number of
 * database statements, keeping every graph keyed by its full resource identity.
 */
export async function loadOperationalResourceGraphs(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  environmentId: string
  roots: readonly Readonly<{ resourceType: AccessResourceType; logicalId: string }>[]
  sourceStates?: ReadonlyMap<OperationalSourceFamily, CatalogOperationalSourceState>
}): Promise<ReadonlyMap<string, OperationalResourceGraphResult>> {
  const roots = [
    ...new Map(
      input.roots.map(root => {
        const requiredFamilies = SOURCE_FAMILIES_BY_TYPE[root.resourceType]
        const targetFamily = sourceFamilyForType(root.resourceType)
        if (!requiredFamilies || !targetFamily) {
          throw new Error('operational_resource_type_unsupported')
        }
        const key = operationalResourceGraphKey(root.resourceType, root.logicalId)
        return [key, { ...root, key, requiredFamilies, targetFamily }] as const
      })
    ).values(),
  ]
  if (roots.length === 0) return new Map()

  let sourceStates = input.sourceStates
  if (!sourceStates) {
    const requiredFamilies = [...new Set(roots.flatMap(root => root.requiredFamilies))].sort(
      compareCanonicalUtf8Text
    )
    const states = await budgetedQuery(
      input.db,
      input.budget,
      `SELECT source_family, generation, resource_version, status, safe_error_code
         FROM operational_catalog_source_state
        WHERE environment_id = $1
          AND source_family = ANY($2::text[])
        ORDER BY source_family`,
      [input.environmentId, requiredFamilies]
    )
    sourceStates = new Map(
      (states.rows as Record<string, unknown>[]).map(row => [
        String(row.source_family) as OperationalSourceFamily,
        Object.freeze({
          family: String(row.source_family) as OperationalSourceFamily,
          generation: String(row.generation),
          resourceVersion:
            row.resource_version === null || row.resource_version === undefined
              ? null
              : String(row.resource_version),
          status: String(row.status) as CatalogOperationalSourceState['status'],
        }),
      ])
    )
  }

  const sourceRevisionByRoot = new Map<string, string>()
  const readyRoots: typeof roots = []
  const graphs = new Map<string, OperationalResourceGraphResult>()
  for (const root of roots) {
    const states = [...root.requiredFamilies].sort(compareCanonicalUtf8Text).flatMap(family => {
      const state = sourceStates.get(family)
      return state ? [state] : []
    })
    const sourceStateRevision = revisionOfValues(
      states.map(state => [state.family, state.generation, state.status])
    )
    sourceRevisionByRoot.set(root.key, sourceStateRevision)
    if (
      states.length !== root.requiredFamilies.length ||
      states.some(state => state.status !== 'current')
    ) {
      graphs.set(root.key, { status: 'unavailable', safeCode: 'operational_source_not_current' })
      continue
    }
    readyRoots.push(root)
    graphs.set(root.key, { status: 'not_found', sourceStateRevision })
  }
  if (readyRoots.length === 0) return graphs

  const rootResult = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT resource.environment_id, resource.resource_type, resource.logical_id,
            resource.source_family, resource.provider_uid,
            resource.provider_resource_version, resource.display_name, resource.enabled,
            resource.deleted_at, resource.observed_generation, resource.content_bytes,
            resource.behavior_sources
       FROM operational_resource_index resource
      WHERE resource.environment_id = $1
        AND (resource.resource_type, resource.logical_id, resource.source_family) IN (
          SELECT value->>0, value->>1, value->>2
            FROM jsonb_array_elements($2::jsonb) AS value
        )
      ORDER BY resource.resource_type, resource.logical_id`,
    [
      input.environmentId,
      JSON.stringify(
        readyRoots.map(root => [root.resourceType, root.logicalId, root.targetFamily])
      ),
    ]
  )
  const rootResources = new Map<string, OperationalIndexedResource>()
  for (const row of rootResult.rows as Record<string, unknown>[]) {
    const resource = parseResource(row)
    rootResources.set(
      operationalResourceGraphKey(resource.resourceType, resource.logicalId),
      resource
    )
  }
  const currentResources = [...rootResources.values()].filter(
    resource => resource.enabled && !resource.deletedAt
  )
  for (const resource of rootResources.values()) {
    if (!resource.enabled || resource.deletedAt) {
      graphs.set(operationalResourceGraphKey(resource.resourceType, resource.logicalId), {
        status: 'not_found',
        sourceStateRevision: sourceRevisionByRoot.get(
          operationalResourceGraphKey(resource.resourceType, resource.logicalId)
        )!,
      })
    }
  }
  if (currentResources.length === 0) return graphs
  for (const resource of currentResources) {
    input.budget.chargeOperationalObject(Math.max(1, resource.contentBytes), true)
  }

  const activeRoots = currentResources.map(resource => [resource.resourceType, resource.logicalId])
  const relationshipLimit = input.budget.remaining('relationships') + 1
  const relationshipResult = await budgetedQuery(
    input.db,
    input.budget,
    `WITH roots AS (
       SELECT value->>0 AS resource_type, value->>1 AS logical_id
         FROM jsonb_array_elements($2::jsonb) AS value
     ),
     relationship_rows AS (
       SELECT relationship.environment_id, relationship.source_type,
              relationship.source_id, relationship.relationship_type,
              relationship.target_type,
              CASE WHEN relationship.relationship_type = 'uses_context'
                THEN ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')}
                ELSE relationship.target_id
              END AS target_id,
              relationship.relationship_instance_id, relationship.behavior_attributes,
              relationship.source_family, relationship.source_provider_uid,
              relationship.source_resource_version, relationship.observed_generation,
              relationship.content_bytes
         FROM operational_resource_relationships relationship
        WHERE relationship.environment_id = $1
         AND relationship.relationship_type <> 'context_identity_alias'
         AND (relationship.relationship_type <> 'uses_context'
           OR ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')} IS NOT NULL)
     ),
     context_ids AS (
       SELECT roots.resource_type, roots.logical_id, edge.target_id AS context_id
         FROM roots
         JOIN relationship_rows edge
           ON edge.source_type = roots.resource_type
          AND edge.source_id = roots.logical_id
          AND edge.relationship_type = 'uses_context'
          AND edge.target_type = 'context'
        WHERE roots.resource_type IN ('host', 'workflow_recipe')
       UNION
       SELECT roots.resource_type, roots.logical_id, edge.source_id AS context_id
         FROM roots
         JOIN relationship_rows edge
           ON edge.source_type = 'context'
          AND edge.target_type = roots.resource_type
          AND edge.target_id = roots.logical_id
          AND edge.relationship_type = CASE roots.resource_type
            WHEN 'mcp_server' THEN 'includes_mcp_server'
            WHEN 'shared_filesystem' THEN 'mounts_shared_filesystem'
          END
        WHERE roots.resource_type IN ('mcp_server', 'shared_filesystem')
       UNION
       SELECT roots.resource_type, roots.logical_id, recipe_edge.target_id AS context_id
         FROM roots
         JOIN relationship_rows expose_edge
           ON roots.resource_type = 'sandbox_app'
          AND expose_edge.relationship_type = 'exposes_sandbox_app'
          AND expose_edge.target_type = 'sandbox_app'
          AND expose_edge.target_id = roots.logical_id
         JOIN relationship_rows recipe_edge
           ON recipe_edge.source_type = 'workflow_recipe'
          AND recipe_edge.source_id = expose_edge.source_id
          AND recipe_edge.relationship_type = 'uses_context'
          AND recipe_edge.target_type = 'context'
     ),
     selected_edges AS (
       SELECT roots.resource_type AS graph_resource_type,
              roots.logical_id AS graph_logical_id, edge.*
         FROM roots
         JOIN relationship_rows edge
           ON edge.source_type = roots.resource_type
          AND edge.source_id = roots.logical_id
       UNION
       SELECT roots.resource_type, roots.logical_id, edge.*
         FROM roots
         JOIN relationship_rows edge
           ON roots.resource_type <> 'context'
          AND edge.target_type = roots.resource_type
          AND edge.target_id = roots.logical_id
       UNION
       SELECT context_ids.resource_type, context_ids.logical_id, edge.*
         FROM context_ids
         JOIN relationship_rows edge
           ON edge.source_type = 'context'
          AND edge.source_id = context_ids.context_id
          AND (
            context_ids.resource_type NOT IN ('mcp_server', 'shared_filesystem')
            OR (
              context_ids.resource_type = 'mcp_server'
              AND edge.relationship_type = 'includes_mcp_server'
              AND edge.target_type = 'mcp_server'
              AND edge.target_id = context_ids.logical_id
            )
            OR (
              context_ids.resource_type = 'shared_filesystem'
              AND edge.relationship_type = 'mounts_shared_filesystem'
              AND edge.target_type = 'shared_filesystem'
              AND edge.target_id = context_ids.logical_id
            )
          )
       UNION
       SELECT roots.resource_type, roots.logical_id, edge.*
         FROM roots
         JOIN context_ids
           ON context_ids.resource_type = roots.resource_type
          AND context_ids.logical_id = roots.logical_id
         JOIN relationship_rows edge
           ON roots.resource_type = 'mcp_server'
          AND edge.source_type = 'host'
          AND edge.relationship_type = 'uses_context'
          AND edge.target_type = 'context'
          AND edge.target_id = context_ids.context_id
       UNION
       SELECT roots.resource_type, roots.logical_id, edge.*
         FROM roots
         JOIN relationship_rows edge
           ON roots.resource_type = 'sandbox_app'
          AND edge.relationship_type = 'exposes_sandbox_app'
          AND edge.target_type = 'sandbox_app'
          AND edge.target_id = roots.logical_id
       UNION
       SELECT roots.resource_type, roots.logical_id, recipe_edge.*
         FROM roots
         JOIN relationship_rows expose_edge
           ON roots.resource_type = 'sandbox_app'
          AND expose_edge.relationship_type = 'exposes_sandbox_app'
          AND expose_edge.target_type = 'sandbox_app'
          AND expose_edge.target_id = roots.logical_id
         JOIN relationship_rows recipe_edge
           ON recipe_edge.source_type = 'workflow_recipe'
          AND recipe_edge.source_id = expose_edge.source_id
          AND recipe_edge.relationship_type = 'uses_context'
          AND recipe_edge.target_type = 'context'
     )
     SELECT graph_resource_type, graph_logical_id, environment_id, source_type,
            source_id, relationship_type, target_type, target_id,
            relationship_instance_id, behavior_attributes, source_family,
            source_provider_uid, source_resource_version, observed_generation,
            content_bytes
       FROM selected_edges
      ORDER BY graph_resource_type, graph_logical_id,
               source_type, source_id, relationship_type,
               target_type, target_id, relationship_instance_id
      LIMIT $3`,
    [input.environmentId, JSON.stringify(activeRoots), relationshipLimit]
  )
  const relationshipRows = relationshipResult.rows as Array<
    Record<string, unknown> & { graph_resource_type: string; graph_logical_id: string }
  >
  if (relationshipRows.length >= relationshipLimit) {
    input.budget.charge({
      kind: 'relationships',
      amount: relationshipRows.length,
      authorityRequired: true,
    })
  }
  const relationshipsByRoot = new Map<string, OperationalIndexedRelationship[]>()
  const resourceKeysByRoot = new Map<string, Map<string, readonly [string, string]>>()
  for (const resource of currentResources) {
    const graphKey = operationalResourceGraphKey(resource.resourceType, resource.logicalId)
    const keys = new Map<string, readonly [string, string]>()
    keys.set(JSON.stringify([resource.resourceType, resource.logicalId]), [
      resource.resourceType,
      resource.logicalId,
    ])
    resourceKeysByRoot.set(graphKey, keys)
    relationshipsByRoot.set(graphKey, [])
  }
  for (const row of relationshipRows) {
    const graphKey = operationalResourceGraphKey(
      row.graph_resource_type as AccessResourceType,
      row.graph_logical_id
    )
    const list = relationshipsByRoot.get(graphKey)
    const keys = resourceKeysByRoot.get(graphKey)
    if (!list || !keys) continue
    const relationship = parseRelationship(row)
    list.push(relationship)
    for (const [type, id] of [
      [relationship.sourceType, relationship.sourceId],
      [relationship.targetType, relationship.targetId],
    ] as const) {
      if (
        ['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(type)
      ) {
        keys.set(JSON.stringify([type, id]), [type, id])
      }
    }
  }
  const allResourceKeys = new Map<string, readonly [string, string]>()
  for (const keys of resourceKeysByRoot.values()) {
    for (const [key, value] of keys) allResourceKeys.set(key, value)
  }
  const relatedResult = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT environment_id, resource_type, logical_id, source_family,
            provider_uid, provider_resource_version, display_name, enabled,
            deleted_at, observed_generation, content_bytes, behavior_sources
       FROM operational_resource_index
      WHERE environment_id = $1
        AND (resource_type, logical_id) IN (
          SELECT value->>0, value->>1
            FROM jsonb_array_elements($2::jsonb) AS value
        )
      ORDER BY resource_type, logical_id`,
    [input.environmentId, JSON.stringify([...allResourceKeys.values()])]
  )
  const resourcesByKey = new Map<string, OperationalIndexedResource>()
  for (const row of relatedResult.rows as Record<string, unknown>[]) {
    const resource = parseResource(row)
    resourcesByKey.set(JSON.stringify([resource.resourceType, resource.logicalId]), resource)
  }
  const missingResourceByRoot = new Set<string>()
  for (const [graphKey, keys] of resourceKeysByRoot) {
    if ([...keys.keys()].some(key => !resourcesByKey.has(key))) {
      missingResourceByRoot.add(graphKey)
    }
  }
  input.budget.charge({
    kind: 'decodedBytes',
    amount: Math.max(1, Buffer.byteLength(JSON.stringify(relatedResult.rows), 'utf8')),
  })

  for (const resource of currentResources) {
    const graphKey = operationalResourceGraphKey(resource.resourceType, resource.logicalId)
    const sourceStateRevision = sourceRevisionByRoot.get(graphKey)!
    if (missingResourceByRoot.has(graphKey)) {
      graphs.set(graphKey, {
        status: 'unavailable',
        safeCode: 'operational_related_resource_incomplete',
      })
      continue
    }
    const relationships = relationshipsByRoot.get(graphKey) ?? []
    if (relationships.length > 0) {
      input.budget.charge({ kind: 'relationships', amount: relationships.length })
    }
    const relationshipBytes = relationships.reduce(
      (total, relationship) => total + relationship.contentBytes,
      0
    )
    if (relationshipBytes > 0)
      input.budget.charge({ kind: 'decodedBytes', amount: relationshipBytes })
    const resources = [...(resourceKeysByRoot.get(graphKey)?.keys() ?? [])]
      .map(key => resourcesByKey.get(key))
      .filter((value): value is OperationalIndexedResource => Boolean(value))
    graphs.set(
      graphKey,
      Object.freeze({
        status: 'current',
        resource,
        resources: Object.freeze(resources),
        relationships: Object.freeze(relationships),
        sourceStateRevision,
        relationshipsRevision: revisionOfValues(
          relationships
            .filter(
              relationship =>
                relationship.sourceType === resource.resourceType &&
                relationship.sourceId === resource.logicalId
            )
            .map(relationship => [
              relationship.sourceType,
              relationship.sourceId,
              relationship.relationshipType,
              relationship.targetType,
              relationship.targetId,
              relationship.relationshipInstanceId,
              relationship.behaviorAttributes,
              relationship.sourceProviderUid,
              relationship.sourceResourceVersion,
            ])
        ),
      })
    )
  }
  return graphs
}

export async function loadOperationalResourceGraph(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  environmentId: string
  resourceType: AccessResourceType
  logicalId: string
}): Promise<OperationalResourceGraphResult> {
  const requiredFamilies = SOURCE_FAMILIES_BY_TYPE[input.resourceType]
  const targetFamily = sourceFamilyForType(input.resourceType)
  if (!requiredFamilies || !targetFamily) {
    throw new Error('operational_resource_type_unsupported')
  }

  const states = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT source_family, generation, resource_version, status, safe_error_code
       FROM operational_catalog_source_state
      WHERE environment_id = $1
        AND source_family = ANY($2::text[])
      ORDER BY source_family`,
    [input.environmentId, requiredFamilies]
  )
  const stateRows = states.rows as Record<string, unknown>[]
  const sourceStateRevision = revisionOfValues(
    stateRows.map(row => [row.source_family, row.generation, row.status])
  )
  if (
    stateRows.length !== requiredFamilies.length ||
    stateRows.some(row => row.status !== 'current')
  ) {
    return { status: 'unavailable', safeCode: 'operational_source_not_current' }
  }

  const resourceResult = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT environment_id, resource_type, logical_id, source_family,
            provider_uid, provider_resource_version, display_name, enabled,
            deleted_at, observed_generation, content_bytes, behavior_sources
       FROM operational_resource_index
      WHERE environment_id = $1
        AND resource_type = $2
        AND logical_id = $3
        AND source_family = $4
      LIMIT 1`,
    [input.environmentId, input.resourceType, input.logicalId, targetFamily]
  )
  const rawResource = resourceResult.rows[0] as Record<string, unknown> | undefined
  if (!rawResource) return { status: 'not_found', sourceStateRevision }
  const resource = parseResource(rawResource)
  input.budget.chargeOperationalObject(Math.max(1, resource.contentBytes), true)
  if (!resource.enabled || resource.deletedAt) {
    return { status: 'not_found', sourceStateRevision }
  }

  const relationshipResult = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT relationship.environment_id, relationship.source_type,
            relationship.source_id, relationship.relationship_type,
            relationship.target_type,
            CASE WHEN relationship.relationship_type = 'uses_context'
              THEN ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')}
              ELSE relationship.target_id
            END AS target_id,
            relationship.relationship_instance_id, relationship.behavior_attributes,
            relationship.source_family, relationship.source_provider_uid,
            relationship.source_resource_version, relationship.observed_generation,
            relationship.content_bytes
       FROM operational_resource_relationships relationship
      WHERE relationship.environment_id = $1
        AND relationship.relationship_type <> 'context_identity_alias'
        AND (relationship.relationship_type <> 'uses_context'
          OR ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')} IS NOT NULL)
        AND (
          $2 NOT IN ('mcp_server', 'shared_filesystem')
          OR relationship.source_type <> 'context'
          OR (
            $2 = 'mcp_server'
            AND relationship.relationship_type = 'includes_mcp_server'
            AND relationship.target_type = 'mcp_server'
            AND relationship.target_id = $3
          )
          OR (
            $2 = 'shared_filesystem'
            AND relationship.relationship_type = 'mounts_shared_filesystem'
            AND relationship.target_type = 'shared_filesystem'
            AND relationship.target_id = $3
          )
        )
        AND (
          (relationship.source_type = $2 AND relationship.source_id = $3)
          OR ($2 <> 'context' AND relationship.target_type = $2 AND
              (CASE WHEN relationship.relationship_type = 'uses_context'
                THEN ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')}
                ELSE relationship.target_id
              END) = $3)
          OR (
            relationship.source_type = 'context'
            AND relationship.source_id IN (
              SELECT ${canonicalContextLogicalIdSql('$1', 'context_edge.target_id')}
                FROM operational_resource_relationships context_edge
               WHERE context_edge.environment_id = $1
                 AND context_edge.source_type = $2
                 AND context_edge.source_id = $3
                 AND context_edge.relationship_type = 'uses_context'
                 AND context_edge.target_type = 'context'
              UNION
              SELECT mcp_edge.source_id
                FROM operational_resource_relationships mcp_edge
               WHERE $2 = 'mcp_server'
                 AND mcp_edge.environment_id = $1
                 AND mcp_edge.relationship_type = 'includes_mcp_server'
                 AND mcp_edge.target_type = 'mcp_server'
                 AND mcp_edge.target_id = $3
              UNION
              SELECT mount_edge.source_id
                FROM operational_resource_relationships mount_edge
               WHERE $2 = 'shared_filesystem'
                 AND mount_edge.environment_id = $1
                 AND mount_edge.relationship_type = 'mounts_shared_filesystem'
                 AND mount_edge.target_type = 'shared_filesystem'
                 AND mount_edge.target_id = $3
              UNION
              SELECT ${canonicalContextLogicalIdSql('$1', 'recipe_edge.target_id')}
                FROM operational_resource_relationships recipe_edge
               WHERE $2 = 'workflow_recipe'
                 AND recipe_edge.environment_id = $1
                 AND recipe_edge.source_type = 'workflow_recipe'
                 AND recipe_edge.source_id = $3
                 AND recipe_edge.relationship_type = 'uses_context'
                 AND recipe_edge.target_type = 'context'
              UNION
              SELECT ${canonicalContextLogicalIdSql('$1', 'recipe_edge.target_id')}
                FROM operational_resource_relationships expose_edge
                JOIN operational_resource_relationships recipe_edge
                  ON recipe_edge.environment_id = expose_edge.environment_id
                 AND recipe_edge.source_type = 'workflow_recipe'
                 AND recipe_edge.source_id = expose_edge.source_id
                 AND recipe_edge.relationship_type = 'uses_context'
                 AND recipe_edge.target_type = 'context'
               WHERE $2 = 'sandbox_app'
                 AND expose_edge.environment_id = $1
                 AND expose_edge.relationship_type = 'exposes_sandbox_app'
                 AND expose_edge.target_type = 'sandbox_app'
                 AND expose_edge.target_id = $3
            )
          )
          OR (
            $2 = 'mcp_server'
            AND relationship.source_type = 'host'
            AND relationship.relationship_type = 'uses_context'
            AND relationship.target_type = 'context'
            AND ${canonicalContextLogicalIdSql('$1', 'relationship.target_id')} IN (
              SELECT mcp_edge.source_id
                FROM operational_resource_relationships mcp_edge
               WHERE mcp_edge.environment_id = $1
                 AND mcp_edge.relationship_type = 'includes_mcp_server'
                 AND mcp_edge.target_type = 'mcp_server'
                 AND mcp_edge.target_id = $3
            )
          )
          OR (
            $2 = 'sandbox_app'
            AND relationship.source_type = 'workflow_recipe'
            AND relationship.source_id IN (
              SELECT expose_edge.source_id
                FROM operational_resource_relationships expose_edge
               WHERE expose_edge.environment_id = $1
                 AND expose_edge.relationship_type = 'exposes_sandbox_app'
                 AND expose_edge.target_type = 'sandbox_app'
                 AND expose_edge.target_id = $3
            )
          )
        )
      ORDER BY relationship.source_type, relationship.source_id,
               relationship.relationship_type, relationship.target_type,
               target_id, relationship.relationship_instance_id
      LIMIT $4`,
    [
      input.environmentId,
      input.resourceType,
      input.logicalId,
      input.budget.limits.relationships + 1,
    ]
  )
  if (relationshipResult.rows.length > input.budget.limits.relationships) {
    input.budget.charge({
      kind: 'relationships',
      amount: relationshipResult.rows.length,
      authorityRequired: true,
    })
  }
  const relationships = Object.freeze(
    (relationshipResult.rows as Record<string, unknown>[]).map(parseRelationship)
  )
  if (relationships.length > 0) {
    input.budget.charge({ kind: 'relationships', amount: relationships.length })
    const relationshipBytes = relationships.reduce(
      (total, relationship) => total + relationship.contentBytes,
      0
    )
    if (relationshipBytes > 0) {
      input.budget.charge({ kind: 'decodedBytes', amount: relationshipBytes })
    }
  }
  const relationshipPairs = relationships.flatMap(relationship => [
    [relationship.sourceType, relationship.sourceId],
    [relationship.targetType, relationship.targetId],
  ])
  const resourceKeys = new Map<string, readonly [string, string]>([
    [
      JSON.stringify([resource.resourceType, resource.logicalId]),
      [resource.resourceType, resource.logicalId],
    ],
  ])
  for (const [type, id] of relationshipPairs) {
    if (['host', 'context', 'mcp_server', 'workflow_recipe', 'shared_filesystem'].includes(type)) {
      resourceKeys.set(JSON.stringify([type, id]), [type, id])
    }
  }
  const relatedResult = await budgetedQuery(
    input.db,
    input.budget,
    `SELECT environment_id, resource_type, logical_id, source_family,
            provider_uid, provider_resource_version, display_name, enabled,
            deleted_at, observed_generation, content_bytes, behavior_sources
       FROM operational_resource_index
      WHERE environment_id = $1
        AND (resource_type, logical_id) IN (
          SELECT value->>0, value->>1
            FROM jsonb_array_elements($2::jsonb) AS value
        )
      ORDER BY resource_type, logical_id`,
    [input.environmentId, JSON.stringify([...resourceKeys.values()])]
  )
  const resources = Object.freeze(
    (relatedResult.rows as Record<string, unknown>[]).map(parseResource)
  )
  if (resources.length !== resourceKeys.size) {
    return { status: 'unavailable', safeCode: 'operational_related_resource_incomplete' }
  }
  input.budget.charge({
    kind: 'decodedBytes',
    amount: Math.max(1, Buffer.byteLength(JSON.stringify(resources), 'utf8')),
  })
  return Object.freeze({
    status: 'current',
    resource,
    resources,
    relationships,
    sourceStateRevision,
    relationshipsRevision: revisionOfValues(
      relationships
        .filter(
          relationship =>
            relationship.sourceType === resource.resourceType &&
            relationship.sourceId === resource.logicalId
        )
        .map(relationship => [
          relationship.sourceType,
          relationship.sourceId,
          relationship.relationshipType,
          relationship.targetType,
          relationship.targetId,
          relationship.relationshipInstanceId,
          relationship.behaviorAttributes,
          relationship.sourceProviderUid,
          relationship.sourceResourceVersion,
        ])
    ),
  })
}
