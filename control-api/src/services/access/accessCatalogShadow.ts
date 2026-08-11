import {
  aggregateAccessShadowComparisonsTotal,
  aggregateAccessShadowDifferencesTotal,
} from '../../observability/metrics.js'
import type { ExternalSessionAuthorityContext } from '../auth/externalSessionAuthentication.js'
import { type AccessCatalogItem, buildAccessCatalog } from './accessCatalogCoordinator.js'
import {
  ACCESS_EXECUTION_LIMIT_CLAMPS,
  AccessBudgetExceededError,
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from './accessExecutionBudget.js'
import type { CatalogFamily } from './catalogContracts.js'
import { configuredUserAccessIntent } from './userAccessPolicy.js'
import { resolveEffectiveUserAccessPolicy } from './userAccessRuntimePolicy.js'

const SHADOW_MAX_IDENTITIES = 100
const SHADOW_MAX_IN_FLIGHT = ACCESS_EXECUTION_LIMIT_CLAMPS.producerConcurrency
let shadowInFlight = 0

export type CatalogShadowScope =
  | Readonly<{
      kind: 'relationship'
      type?: string
      targetResourceId: string
    }>
  | Readonly<{
      kind: 'behavior-json'
      dimension: 'filesystemScope' | 'runtime'
      field: string
      equals: string
    }>

export type CatalogShadowOutcome =
  | 'match'
  | 'catalog_only'
  | 'legacy_only'
  | 'both_differ'
  | 'partial'
  | 'skipped_capacity'
  | 'skipped_unavailable'
  | 'skipped_legacy_incomplete'

function jsonBehaviorMatches(
  item: AccessCatalogItem,
  scope: Extract<CatalogShadowScope, { kind: 'behavior-json' }>
): boolean {
  return item.accessPaths.some(path => {
    const dimension = path.behaviorDescriptors[scope.dimension]
    if (dimension.state !== 'known' || typeof dimension.value !== 'string') return false
    try {
      const value = JSON.parse(dimension.value) as Record<string, unknown>
      return String(value?.[scope.field] ?? '') === scope.equals
    } catch {
      return false
    }
  })
}

function inScope(item: AccessCatalogItem, scope: CatalogShadowScope | undefined): boolean {
  if (!scope) return true
  if (scope.kind === 'behavior-json') return jsonBehaviorMatches(item, scope)
  return item.relationships.some(
    relationship =>
      relationship.targetResourceId === scope.targetResourceId &&
      (!scope.type || relationship.type === scope.type)
  )
}

function safeLegacyIds(values: readonly string[]): Set<string> | null {
  if (values.length > SHADOW_MAX_IDENTITIES) return null
  const output = new Set<string>()
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || normalized.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
      return null
    }
    output.add(normalized)
  }
  return output
}

function record(
  family: CatalogFamily,
  outcome: CatalogShadowOutcome,
  catalogOnly = 0,
  legacyOnly = 0
): CatalogShadowOutcome {
  aggregateAccessShadowComparisonsTotal.inc({ family, outcome }, 1)
  if (catalogOnly > 0) {
    aggregateAccessShadowDifferencesTotal.inc({ family, direction: 'catalog_only' }, catalogOnly)
  }
  if (legacyOnly > 0) {
    aggregateAccessShadowDifferencesTotal.inc({ family, direction: 'legacy_only' }, legacyOnly)
  }
  return outcome
}

export async function compareAccessCatalogShadow(
  input: {
    session: ExternalSessionAuthorityContext
    family: CatalogFamily
    legacyLogicalIds: readonly string[]
    legacyComplete: boolean
    scope?: CatalogShadowScope
  },
  options: {
    enabled?: boolean
    buildCatalog?: typeof buildAccessCatalog
  } = {}
): Promise<CatalogShadowOutcome> {
  if (!input.legacyComplete) return record(input.family, 'skipped_legacy_incomplete')
  const legacy = safeLegacyIds(input.legacyLogicalIds)
  if (!legacy) return record(input.family, 'skipped_legacy_incomplete')
  if (options.enabled === undefined) {
    try {
      const policy = await resolveEffectiveUserAccessPolicy()
      if (!policy.computeCatalogShadow) return 'skipped_unavailable'
    } catch {
      return record(input.family, 'skipped_unavailable')
    }
  } else if (!options.enabled) {
    return 'skipped_unavailable'
  }

  const parent = AccessExecutionBudget.create('catalog')
  const child = parent.child({
    producerCalls: 8,
    objects: 200,
    decodedBytes: 2 * 1024 * 1024,
    accessPaths: 512,
    relationships: 1_024,
    dbRowsReturned: 1_024,
    responseBytes: 2 * 1024 * 1024,
  })
  try {
    const catalog = await (options.buildCatalog ?? buildAccessCatalog)(
      { session: input.session, families: [input.family], limit: SHADOW_MAX_IDENTITIES },
      { budget: child }
    )
    if (!catalog.complete || catalog.nextCursor) return record(input.family, 'partial')
    const aggregate = new Set(
      catalog.items.filter(item => inScope(item, input.scope)).map(item => item.resource.logicalId)
    )
    const catalogOnly = [...aggregate].filter(value => !legacy.has(value)).length
    const legacyOnly = [...legacy].filter(value => !aggregate.has(value)).length
    const outcome: CatalogShadowOutcome =
      catalogOnly === 0 && legacyOnly === 0
        ? 'match'
        : catalogOnly > 0 && legacyOnly > 0
          ? 'both_differ'
          : catalogOnly > 0
            ? 'catalog_only'
            : 'legacy_only'
    return record(input.family, outcome, catalogOnly, legacyOnly)
  } catch (error) {
    if (
      error instanceof AccessBudgetExceededError ||
      error instanceof AccessExecutionCancelledError
    ) {
      return record(input.family, 'skipped_capacity')
    }
    return record(input.family, 'skipped_unavailable')
  } finally {
    child.close()
    parent.close()
  }
}

export function scheduleAccessCatalogShadow(input: {
  session: ExternalSessionAuthorityContext | undefined
  family: CatalogFamily
  legacyLogicalIds: readonly string[]
  legacyComplete: boolean
  scope?: CatalogShadowScope
}): void {
  if (!input.session || configuredUserAccessIntent.catalogMode === 'off') return
  if (shadowInFlight >= SHADOW_MAX_IN_FLIGHT) {
    record(input.family, 'skipped_capacity')
    return
  }
  shadowInFlight += 1
  setImmediate(() => {
    void compareAccessCatalogShadow({ ...input, session: input.session! }).finally(() => {
      shadowInFlight = Math.max(0, shadowInFlight - 1)
    })
  })
}
