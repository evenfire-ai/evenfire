import type { DbClient } from '../../db.js'
import type { TeamRole } from '../../profileTypes.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import type { AccessPathSeed } from './accessPath.js'
import type { OperationalSourceFamily } from './operationalAccessProjection.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export const CATALOG_FAMILIES = [
  'user',
  'team',
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'workflow_run',
  'workflow_approval',
  'notification',
  'gfs_resource',
  'shared_filesystem',
  'sandbox_app',
] as const

export type CatalogFamily = (typeof CATALOG_FAMILIES)[number]
export type CatalogKey = readonly [
  environmentId: string,
  resourceType: CatalogFamily,
  logicalId: string,
]

export type ProducerContinuation = Readonly<{
  afterKey: CatalogKey | null
  exhausted: boolean
  opaqueState?: string
}>

export type CatalogIdentityCandidate = Readonly<{
  key: CatalogKey
  canonicalId: string
  validUntil: string | null
}>

export type SafeCatalogPartialError = Readonly<{
  producer: CatalogFamily
  code: 'operational_source_unavailable' | 'operational_source_relisting'
  retryable: true
}>

export type CatalogProducerPage = Readonly<{
  candidates: readonly CatalogIdentityCandidate[]
  continuation: ProducerContinuation
  hasMore: boolean
  sourceRevision: string
  sourceCompleteness: 'complete' | 'partial'
  partialErrors: readonly SafeCatalogPartialError[]
}>

export type CatalogRelationship = Readonly<{
  type: string
  targetResourceId: string
  instanceId?: string
}>

export type HydratedCatalogResource = Readonly<{
  key: CatalogKey
  resource: CanonicalResourceIdentity
  accessPaths: readonly AccessPathSeed[]
  relationships: readonly CatalogRelationship[]
  authorizationResourceRevision: string
  authorizationSourceRevision: string
  authorizationRelationshipsRevision: string
  validUntil: string | null
}>

export type CatalogPrincipalSnapshot = Readonly<{
  userId: string
  sessionContract: 'v1' | 'v2'
  sessionRevision: string
  userRevision: string
  authorizationRevision: string
  memberships: readonly Readonly<{
    teamId: string
    role: TeamRole
    membershipUpdatedAt: string
    teamRevision: string
  }>[]
}>

export type CatalogOperationalSourceState = Readonly<{
  family: OperationalSourceFamily
  generation: string
  resourceVersion: string | null
  status: 'current' | 'relisting' | 'unavailable'
}>

export type CatalogRequestContext = Readonly<{
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  principal: CatalogPrincipalSnapshot
  environmentId: string
  sourceStates: ReadonlyMap<OperationalSourceFamily, CatalogOperationalSourceState>
}>

export interface CatalogProducer {
  readonly family: CatalogFamily
  readonly requiredOperationalSources: readonly OperationalSourceFamily[]
  listCanonicalKeys(
    context: CatalogRequestContext,
    continuation: ProducerContinuation,
    take: number
  ): Promise<CatalogProducerPage>
  hydrateCanonicalKeys(
    context: CatalogRequestContext,
    keys: readonly CatalogKey[]
  ): Promise<readonly HydratedCatalogResource[]>
}

export function catalogKey(
  environmentId: string,
  family: CatalogFamily,
  logicalId: string
): CatalogKey {
  return Object.freeze([environmentId, family, logicalId])
}

/** Exact lexicographic ordering of the unsigned UTF-8 bytes for stored catalog text. */
export function compareCatalogText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function compareCatalogKey(left: CatalogKey, right: CatalogKey): number {
  return (
    compareCatalogText(left[0], right[0]) ||
    compareCatalogText(left[1], right[1]) ||
    compareCatalogText(left[2], right[2])
  )
}

export function catalogKeyEquals(left: CatalogKey, right: CatalogKey): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2]
}
