import type { DbClient } from '../../db.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import type {
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
}>

export type OperationalIndexedRelationship = OperationalRelationshipRecord

export type OperationalResourceGraphResult =
  | Readonly<{
      status: 'current'
      resource: OperationalIndexedResource
      relationships: readonly OperationalIndexedRelationship[]
      sourceStateRevision: string
      relationshipsRevision: string
    }>
  | Readonly<{ status: 'not_found'; sourceStateRevision: string }>
  | Readonly<{ status: 'unavailable'; safeCode: string }>

const SOURCE_FAMILIES_BY_TYPE: Readonly<
  Partial<Record<AccessResourceType, readonly OperationalSourceFamily[]>>
> = Object.freeze({
  host: ['host'],
  context: ['context'],
  mcp_server: ['mcp_server', 'context', 'host'],
  workflow_recipe: ['workflow_recipe'],
  shared_filesystem: ['shared_filesystem', 'context'],
  sandbox_app: ['workflow_recipe'],
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
  return budget.runProducer(async () => {
    budget.assertActive()
    const result = await db.query(text, values)
    if (result.rows.length > 0) {
      budget.charge({ kind: 'dbRowsReturned', amount: result.rows.length })
    }
    budget.assertActive()
    return result
  })
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
    stateRows.map(row => [row.source_family, row.generation, row.resource_version, row.status])
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
            deleted_at, observed_generation, content_bytes
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
    `SELECT environment_id, source_type, source_id, relationship_type,
            target_type, target_id, relationship_instance_id, behavior_attributes,
            source_family, source_provider_uid, source_resource_version,
            observed_generation, content_bytes
       FROM operational_resource_relationships
      WHERE environment_id = $1
        AND (
          (source_type = $2 AND source_id = $3)
          OR (target_type = $2 AND target_id = $3)
          OR (
            $2 = 'mcp_server'
            AND relationship_type = 'uses_context'
            AND target_type = 'context'
            AND target_id IN (
              SELECT mcp_edge.source_id
                FROM operational_resource_relationships mcp_edge
               WHERE mcp_edge.environment_id = $1
                 AND mcp_edge.relationship_type = 'includes_mcp_server'
                 AND mcp_edge.target_type = 'mcp_server'
                 AND mcp_edge.target_id = $3
            )
          )
      )
      ORDER BY source_type, source_id, relationship_type,
               target_type, target_id, relationship_instance_id
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
  return Object.freeze({
    status: 'current',
    resource,
    relationships,
    sourceStateRevision,
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
