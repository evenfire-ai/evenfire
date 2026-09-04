import { config } from '../../config.js'
import type { TeamRole } from '../../profileTypes.js'
import { type AuthorityCandidate, authorityCandidate } from './accessAuthorityStore.js'
import {
  canonicalAccessPathSeeds,
  databaseRelationshipsRevision,
  revisionOfValues,
} from './authorizationRevision.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import type { AccessCapability } from './capabilityRegistry.js'
import { gfsPermissionsToCapabilities } from './capabilityRegistry.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogKey,
  type CatalogProducer,
  type CatalogProducerPage,
  type CatalogRelationship,
  type CatalogRequestContext,
  type HydratedCatalogResource,
  type ProducerContinuation,
  catalogKey,
} from './catalogContracts.js'
import {
  DERIVED_OPERATIONAL_HYDRATION_SQL,
  GFS_HYDRATION_SQL,
  NOTIFICATION_HYDRATION_SQL,
  SIMPLE_OPERATIONAL_HYDRATION_SQL,
  TEAM_HYDRATION_SQL,
  USER_HYDRATION_SQL,
  WORKFLOW_APPROVAL_HYDRATION_SQL,
  WORKFLOW_RUN_HYDRATION_SQL,
} from './catalogHydrationSql.js'
import { CATALOG_KEY_SQL } from './catalogProducerSql.js'
import {
  CatalogProducerContractError,
  catalogQuery,
  listBoundedProducerKeys,
  operationalReadiness,
  validateHydrationKeys,
} from './catalogProducerSupport.js'
import type { OperationalSourceFamily } from './operationalAccessProjection.js'
import { canonicalResourceIdentity } from './resourceIdentity.js'
import { listGfsProducerKeys } from './teamGfsTopK.js'

const REQUIRED_SOURCES: Readonly<Record<CatalogFamily, readonly OperationalSourceFamily[]>> =
  Object.freeze({
    user: [],
    team: [],
    host: ['host'],
    context: ['context'],
    mcp_server: ['host', 'context', 'mcp_server'],
    workflow_recipe: ['workflow_recipe'],
    workflow_run: [],
    workflow_approval: [],
    notification: [],
    gfs_resource: [],
    shared_filesystem: ['context', 'shared_filesystem'],
    sandbox_app: ['workflow_recipe'],
  })

type JsonRecord = Record<string, unknown>

function records(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) throw new CatalogProducerContractError('json_array_invalid')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CatalogProducerContractError('json_record_invalid')
    }
    return item as JsonRecord
  })
}

function boundedString(value: unknown, label: string, maximum = 1_024): string {
  const result = typeof value === 'string' ? value : String(value ?? '')
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new CatalogProducerContractError(`${label}_invalid`)
  }
  return result
}

function nullableString(value: unknown, maximum = 1_024): string | null {
  if (value === null || value === undefined) return null
  return boundedString(value, 'nullable_string', maximum)
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new CatalogProducerContractError(`${label}_invalid`)
  }
  return result
}

function teamRole(value: unknown): TeamRole | undefined {
  return ['admin', 'inviter', 'member'].includes(String(value))
    ? (String(value) as TeamRole)
    : undefined
}

function kindOf(row: JsonRecord): 'direct' | 'team' {
  if (row.kind === 'direct' || row.kind === 'team') return row.kind
  throw new CatalogProducerContractError('path_kind_invalid')
}

function relationValue(row: JsonRecord, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake]
}

function catalogRelationship(row: JsonRecord): CatalogRelationship {
  const type = boundedString(
    relationValue(row, 'type', 'relationship_type'),
    'relationship_type',
    128
  )
  const explicitTarget = relationValue(row, 'targetResourceId', 'target_resource_id')
  const targetResourceId = explicitTarget
    ? boundedString(explicitTarget, 'relationship_target', 1_536)
    : `${boundedString(row.target_type, 'relationship_target_type', 64)}:${boundedString(
        row.target_id,
        'relationship_target_id'
      )}`
  const instance = relationValue(row, 'instanceId', 'relationship_instance_id')
  return Object.freeze({
    type,
    targetResourceId,
    ...(instance ? { instanceId: boundedString(instance, 'relationship_instance', 256) } : {}),
  })
}

function canonicalRelationships(rows: readonly JsonRecord[]): CatalogRelationship[] {
  const values = new Map<string, CatalogRelationship>()
  for (const row of rows) {
    const relationship = catalogRelationship(row)
    values.set(
      JSON.stringify([
        relationship.type,
        relationship.targetResourceId,
        relationship.instanceId ?? null,
      ]),
      relationship
    )
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

function operationalRelationshipsRevision(rows: readonly JsonRecord[]): string {
  return revisionOfValues(
    rows.map(row => [
      row.source_type,
      row.source_id,
      row.relationship_type,
      row.target_type,
      row.target_id,
      row.relationship_instance_id,
      row.behavior_attributes,
      row.source_provider_uid,
      row.source_resource_version,
    ])
  )
}

function commonCandidate(input: {
  context: CatalogRequestContext
  row: JsonRecord
  capabilities: readonly AccessCapability[]
  runtimeSensitive?: boolean
  filesystemScope?: string | null
  runtimeRef?: string | null
  approvalRef?: string | null
}): AuthorityCandidate {
  const kind = kindOf(input.row)
  const teamId = kind === 'team' ? boundedString(input.row.team_id, 'path_team_id', 64) : undefined
  const role = kind === 'team' ? teamRole(input.row.current_role) : undefined
  if (kind === 'team' && !role) throw new CatalogProducerContractError('path_role_invalid')
  return authorityCandidate({
    userId: input.context.principal.userId,
    kind,
    grantId: boundedString(input.row.grant_id, 'path_grant_id', 2_048),
    ...(teamId ? { teamId } : {}),
    ...(role ? { currentRole: role } : {}),
    capabilities: input.capabilities,
    runtimeSensitive: input.runtimeSensitive,
    filesystemScope: input.filesystemScope,
    runtimeRef: input.runtimeRef,
    approvalRef: input.approvalRef,
  })
}

function capabilitiesForFamily(family: CatalogFamily): readonly AccessCapability[] {
  switch (family) {
    case 'user':
      return ['user.profile.read']
    case 'host':
      return [
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
    case 'context':
      return ['context.read', 'context.use']
    case 'mcp_server':
      return ['mcp_server.read', 'mcp_server.use']
    case 'workflow_recipe':
      return ['workflow.read', 'workflow.trigger']
    case 'workflow_run':
      return [
        'workflow.read',
        'workflow.run.manage',
        'workflow.artifact.read',
        'workflow.artifact.delete',
      ]
    case 'workflow_approval':
      return ['workflow.approval.decide']
    case 'notification':
      return ['notification.read']
    case 'shared_filesystem':
      return ['shared_filesystem.read']
    case 'sandbox_app':
      return ['sandbox_app.read', 'sandbox_app.use', 'sandbox_oauth.vend']
    default:
      return []
  }
}

function simpleOperationalCandidates(input: {
  context: CatalogRequestContext
  family: 'host' | 'context' | 'workflow_recipe' | 'sandbox_app'
  logicalId: string
  pathRows: readonly JsonRecord[]
  relationshipRows: readonly JsonRecord[]
}): AuthorityCandidate[] {
  const relevantRelationships = input.relationshipRows.filter(row => {
    const sourceType = String(row.source_type ?? '')
    const sourceId = String(row.source_id ?? '')
    if (input.family === 'sandbox_app') {
      return row.target_type === 'sandbox_app' && row.target_id === input.logicalId
    }
    if (input.family === 'workflow_recipe') return true
    return sourceType === input.family && sourceId === input.logicalId
  })
  const runtimeRef = JSON.stringify(
    relevantRelationships
      .map(row => boundedString(row.relationship_instance_id, 'relationship_instance', 256))
      .sort(compareCanonicalUtf8Text)
  )
  return input.pathRows.map(row =>
    commonCandidate({
      context: input.context,
      row,
      capabilities: capabilitiesForFamily(input.family),
      runtimeSensitive: true,
      runtimeRef,
    })
  )
}

function derivedCandidates(input: {
  context: CatalogRequestContext
  family: 'mcp_server' | 'shared_filesystem'
  pathRows: readonly JsonRecord[]
}): AuthorityCandidate[] {
  return input.pathRows.map(row => {
    const edgeInstance = boundedString(row.edge_instance, 'edge_instance', 256)
    const sourceId = boundedString(row.source_id, 'path_source_id')
    if (input.family === 'shared_filesystem') {
      const edgeBehavior =
        row.edge_behavior && typeof row.edge_behavior === 'object'
          ? (row.edge_behavior as JsonRecord)
          : {}
      return commonCandidate({
        context: input.context,
        row,
        capabilities: capabilitiesForFamily(input.family),
        filesystemScope: JSON.stringify({
          contextId: sourceId,
          relationshipInstanceId: edgeInstance,
          mountPath: boundedString(edgeBehavior.mountPath, 'filesystem_mount_path'),
          readOnly: true,
        }),
        runtimeRef: edgeInstance,
      })
    }
    const hostEdge = nullableString(row.host_edge_instance, 256)
    return commonCandidate({
      context: input.context,
      row,
      capabilities: capabilitiesForFamily(input.family),
      runtimeSensitive: true,
      runtimeRef: hostEdge ? JSON.stringify([hostEdge, edgeInstance]) : edgeInstance,
    })
  })
}

function databaseCandidates(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  logicalId: string
  pathRows: readonly JsonRecord[]
}): AuthorityCandidate[] {
  if (input.family === 'team') {
    return input.pathRows.map(row => {
      const role = teamRole(row.current_role)
      if (!role) throw new CatalogProducerContractError('path_role_invalid')
      const capabilities: AccessCapability[] = ['team.read']
      if (role === 'admin') {
        capabilities.push(
          'team.manage',
          'team.member.read',
          'team.member.invite',
          'team.member.manage'
        )
      } else if (role === 'inviter') {
        capabilities.push('team.member.read', 'team.member.invite')
      }
      return commonCandidate({ context: input.context, row, capabilities })
    })
  }
  if (input.family === 'gfs_resource') {
    return input.pathRows.map(row =>
      commonCandidate({
        context: input.context,
        row,
        capabilities: gfsPermissionsToCapabilities(row.permissions),
        filesystemScope: JSON.stringify({
          drive: boundedString(row.drive, 'gfs_drive', 512),
          resourceId: input.logicalId,
        }),
      })
    )
  }
  return input.pathRows.map(row =>
    commonCandidate({
      context: input.context,
      row,
      capabilities: capabilitiesForFamily(input.family),
      runtimeSensitive: input.family === 'workflow_run',
      approvalRef: input.family === 'workflow_approval' ? `approval:${input.logicalId}` : undefined,
    })
  )
}

function hydrationSql(family: CatalogFamily): string {
  if (family === 'user') return USER_HYDRATION_SQL
  if (family === 'team') return TEAM_HYDRATION_SQL
  if (['host', 'context', 'workflow_recipe', 'sandbox_app'].includes(family)) {
    return SIMPLE_OPERATIONAL_HYDRATION_SQL
  }
  if (family === 'mcp_server' || family === 'shared_filesystem') {
    return DERIVED_OPERATIONAL_HYDRATION_SQL
  }
  if (family === 'workflow_run') return WORKFLOW_RUN_HYDRATION_SQL
  if (family === 'workflow_approval') return WORKFLOW_APPROVAL_HYDRATION_SQL
  if (family === 'notification') return NOTIFICATION_HYDRATION_SQL
  return GFS_HYDRATION_SQL
}

function hydrationValues(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  logicalIds: readonly string[]
}): unknown[] {
  const base = [input.context.principal.userId, input.logicalIds, input.context.environmentId]
  if (input.family === 'user' || input.family === 'team') return base
  if (
    ['workflow_run', 'workflow_approval', 'notification', 'gfs_resource'].includes(input.family)
  ) {
    return [...base, input.context.budget.remaining('accessPaths') + 1]
  }
  return [
    ...base,
    input.family,
    config.hostsNamespace,
    config.contextsNamespace,
    input.context.budget.remaining('accessPaths') + 1,
    input.context.budget.remaining('relationships') + 1,
  ]
}

function decodedHydrationBytes(rows: readonly unknown[]): number {
  try {
    return Math.max(1, Buffer.byteLength(JSON.stringify(rows), 'utf8'))
  } catch {
    throw new CatalogProducerContractError('hydration_not_serializable')
  }
}

function hydrateRows(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  sourceRevision: string
  rows: readonly JsonRecord[]
}): HydratedCatalogResource[] {
  input.context.budget.charge({
    kind: 'decodedBytes',
    amount: decodedHydrationBytes(input.rows),
    authorityRequired: true,
  })
  const hydrated: HydratedCatalogResource[] = []
  let representedPaths = 0
  let representedRelationships = 0
  let rawPaths = 0
  let rawRelationships = 0
  let reportedPathRows = 0
  let reportedRelationshipRows = 0
  for (const row of input.rows) {
    const logicalId = boundedString(row.logical_id, 'resource_logical_id')
    const pathRows = records(row.paths)
    if (pathRows.length === 0) continue
    const relationshipRows = records(row.relationships)
    rawPaths += pathRows.length
    rawRelationships += relationshipRows.length
    reportedPathRows = Math.max(
      reportedPathRows,
      nonNegativeInteger(row.total_path_rows ?? 0, 'total_path_rows')
    )
    reportedRelationshipRows = Math.max(
      reportedRelationshipRows,
      nonNegativeInteger(row.total_relationship_rows ?? 0, 'total_relationship_rows')
    )
    const accessPaths =
      input.family === 'host' ||
      input.family === 'context' ||
      input.family === 'workflow_recipe' ||
      input.family === 'sandbox_app'
        ? simpleOperationalCandidates({
            context: input.context,
            family: input.family,
            logicalId,
            pathRows,
            relationshipRows,
          })
        : input.family === 'mcp_server' || input.family === 'shared_filesystem'
          ? derivedCandidates({ context: input.context, family: input.family, pathRows })
          : databaseCandidates({
              context: input.context,
              family: input.family,
              logicalId,
              pathRows,
            })
    const paths = canonicalAccessPathSeeds(accessPaths)
    const relationships = canonicalRelationships(relationshipRows)
    representedPaths += paths.length
    representedRelationships += relationships.length
    const validUntil = row.valid_until ? new Date(String(row.valid_until)).toISOString() : null
    hydrated.push(
      Object.freeze({
        key: catalogKey(input.context.environmentId, input.family, logicalId),
        resource: canonicalResourceIdentity({
          environmentId: input.context.environmentId,
          type: input.family,
          logicalId,
          displayName: boundedString(row.display_name, 'resource_display_name', 512),
          providerUid: nullableString(row.provider_uid, 256) ?? undefined,
        }),
        accessPaths: Object.freeze(paths),
        relationships: Object.freeze(relationships),
        authorizationResourceRevision: boundedString(
          row.resource_revision ?? '1',
          'resource_revision',
          128
        ),
        authorizationSourceRevision: input.sourceRevision,
        authorizationRelationshipsRevision:
          input.family === 'host' ||
          input.family === 'context' ||
          input.family === 'mcp_server' ||
          input.family === 'workflow_recipe' ||
          input.family === 'shared_filesystem' ||
          input.family === 'sandbox_app'
            ? operationalRelationshipsRevision(relationshipRows)
            : databaseRelationshipsRevision(relationships),
        validUntil,
      })
    )
  }
  const remainingPaths = input.context.budget.remaining('accessPaths')
  const remainingRelationships = input.context.budget.remaining('relationships')
  const requiredPathBudget = Math.max(rawPaths, reportedPathRows)
  const requiredRelationshipBudget = Math.max(rawRelationships, reportedRelationshipRows)
  if (requiredPathBudget > remainingPaths) {
    input.context.budget.charge({
      kind: 'accessPaths',
      amount: requiredPathBudget,
      authorityRequired: true,
    })
  }
  if (requiredRelationshipBudget > remainingRelationships) {
    input.context.budget.charge({
      kind: 'relationships',
      amount: requiredRelationshipBudget,
      authorityRequired: true,
    })
  }
  if (representedPaths > 0) {
    input.context.budget.charge({
      kind: 'accessPaths',
      amount: representedPaths,
      authorityRequired: true,
    })
  }
  if (representedRelationships > 0) {
    input.context.budget.charge({
      kind: 'relationships',
      amount: representedRelationships,
      authorityRequired: true,
    })
  }
  return hydrated
}

class SqlCatalogProducer implements CatalogProducer {
  readonly requiredOperationalSources: readonly OperationalSourceFamily[]

  constructor(readonly family: CatalogFamily) {
    this.requiredOperationalSources = REQUIRED_SOURCES[family]
  }

  listCanonicalKeys(
    context: CatalogRequestContext,
    continuation: ProducerContinuation,
    take: number
  ): Promise<CatalogProducerPage> {
    if (this.family === 'gfs_resource') {
      return listGfsProducerKeys({ context, continuation, take })
    }
    const prefix = `${this.family === 'host' ? config.hostsNamespace : config.contextsNamespace}/`
    return listBoundedProducerKeys({
      context,
      family: this.family,
      requiredOperationalSources: this.requiredOperationalSources,
      continuation,
      take,
      sql: CATALOG_KEY_SQL[this.family],
      extraValues: after => [
        config.hostsNamespace,
        config.contextsNamespace,
        after.startsWith(prefix) ? after.slice(prefix.length) : '',
      ],
    })
  }

  async hydrateCanonicalKeys(
    context: CatalogRequestContext,
    keys: readonly CatalogKey[]
  ): Promise<readonly HydratedCatalogResource[]> {
    const logicalIds = validateHydrationKeys({ context, family: this.family, keys })
    if (logicalIds.length === 0) return Object.freeze([])
    const readiness = operationalReadiness(context, this.family, this.requiredOperationalSources)
    if (readiness.status !== 'current') {
      throw new CatalogProducerContractError('operational_source_changed_before_hydration')
    }
    const result = await catalogQuery(
      context.db,
      context.budget,
      hydrationSql(this.family),
      hydrationValues({ context, family: this.family, logicalIds })
    )
    return Object.freeze(
      hydrateRows({
        context,
        family: this.family,
        sourceRevision:
          this.requiredOperationalSources.length === 0
            ? 'database-resource'
            : readiness.sourceRevision,
        rows: result.rows as JsonRecord[],
      })
    )
  }
}

export const catalogProducers: ReadonlyMap<CatalogFamily, CatalogProducer> = new Map(
  CATALOG_FAMILIES.map(family => [family, new SqlCatalogProducer(family)])
)

export function requireCatalogProducer(family: CatalogFamily): CatalogProducer {
  const producer = catalogProducers.get(family)
  if (!producer) throw new CatalogProducerContractError('producer_missing')
  return producer
}
