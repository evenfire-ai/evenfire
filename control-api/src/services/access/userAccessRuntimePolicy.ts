import { config } from '../../config.js'
import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery, withAccessDatabaseTransaction } from './accessDatabaseQuery.js'
import { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import {
  OPERATIONAL_SOURCE_FAMILIES,
  type OperationalSourceFamily,
  canonicalEnvironmentId,
} from './operationalAccessProjection.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type ConfiguredUserAccessIntent,
  type DeploymentReadiness,
  type EffectiveUserAccessPolicy,
  UserAccessPolicyConfigurationError,
  compileUserAccessPolicy,
  configuredUserAccessIntent,
  reconstructionReadiness,
} from './userAccessPolicy.js'

type RuntimeSourceState = Readonly<{
  family: OperationalSourceFamily
  generation: number
  resourceVersion: string
  status: 'current' | 'relisting' | 'unavailable'
  lastSuccessAt: Date
}>

type RuntimePolicyOptions = Readonly<{
  intent?: ConfiguredUserAccessIntent
  db?: Pick<DbClient, 'query'>
  budget?: AccessExecutionBudget
  indexerEnabled?: boolean
  readinessMaxAgeMs?: number | null
  now?: Date
}>

const DATABASE_ONLY_FAMILIES: readonly CatalogFamily[] = Object.freeze([
  'user',
  'team',
  'workflow_run',
  'workflow_approval',
  'notification',
  'gfs_resource',
])

const REQUIRED_SOURCES: Readonly<
  Partial<Record<CatalogFamily, readonly OperationalSourceFamily[]>>
> = Object.freeze({
  host: ['host'],
  context: ['context'],
  mcp_server: ['host', 'context', 'mcp_server'],
  workflow_recipe: ['workflow_recipe'],
  shared_filesystem: ['context', 'shared_filesystem'],
  sandbox_app: ['workflow_recipe'],
})

function needsOperationalReadiness(intent: ConfiguredUserAccessIntent): boolean {
  return intent.catalogMode !== 'off'
}

function unavailableReadiness(): DeploymentReadiness {
  return Object.freeze({
    ...reconstructionReadiness,
    revision: 'runtime-readiness-unavailable',
    snapshot: 'unavailable',
    catalogOperationalFamilies: new Set<CatalogFamily>(),
  })
}

function parseSourceStates(
  rows: readonly Record<string, unknown>[]
): readonly RuntimeSourceState[] {
  const seen = new Set<string>()
  return Object.freeze(
    rows.map(row => {
      const family = String(row.source_family) as OperationalSourceFamily
      const generation = Number(row.generation)
      const resourceVersion = typeof row.resource_version === 'string' ? row.resource_version : ''
      const status = String(row.status)
      const lastSuccessAt = row.last_success_at ? new Date(String(row.last_success_at)) : null
      if (
        !OPERATIONAL_SOURCE_FAMILIES.includes(family) ||
        seen.has(family) ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        !resourceVersion ||
        !['current', 'relisting', 'unavailable'].includes(status) ||
        !lastSuccessAt ||
        !Number.isFinite(lastSuccessAt.getTime())
      ) {
        throw new UserAccessPolicyConfigurationError('runtime_readiness_invalid')
      }
      seen.add(family)
      return Object.freeze({
        family,
        generation,
        resourceVersion,
        status: status as RuntimeSourceState['status'],
        lastSuccessAt,
      })
    })
  )
}

function runtimeReadiness(
  states: readonly RuntimeSourceState[],
  now: Date,
  maxAgeMs: number
): DeploymentReadiness {
  const currentSources = new Set<OperationalSourceFamily>()
  for (const state of states) {
    const age = now.getTime() - state.lastSuccessAt.getTime()
    if (state.status === 'current' && age >= 0 && age <= maxAgeMs) {
      currentSources.add(state.family)
    }
  }
  const operationalFamilies = new Set<CatalogFamily>(DATABASE_ONLY_FAMILIES)
  for (const family of CATALOG_FAMILIES) {
    const required = REQUIRED_SOURCES[family]
    if (required?.every(source => currentSources.has(source))) operationalFamilies.add(family)
  }
  return Object.freeze({
    ...reconstructionReadiness,
    revision: revisionOfValues([
      reconstructionReadiness.revision,
      maxAgeMs,
      states.map(state => [
        state.family,
        state.generation,
        state.resourceVersion,
        state.status,
        state.lastSuccessAt.toISOString(),
      ]),
    ]),
    snapshot: 'current',
    catalogOperationalFamilies: operationalFamilies,
  })
}

export async function resolveEffectiveUserAccessPolicy(
  options: RuntimePolicyOptions = {}
): Promise<EffectiveUserAccessPolicy> {
  const intent = options.intent ?? configuredUserAccessIntent
  if (!needsOperationalReadiness(intent)) {
    return compileUserAccessPolicy(intent, reconstructionReadiness)
  }

  const indexerEnabled = options.indexerEnabled ?? config.operationalAccessIndexerEnabled
  const maxAgeMs =
    options.readinessMaxAgeMs === undefined
      ? config.operationalAccessReadinessMaxAgeMs
      : options.readinessMaxAgeMs
  if (!indexerEnabled || !Number.isSafeInteger(maxAgeMs) || Number(maxAgeMs) < 1) {
    return compileUserAccessPolicy(intent, unavailableReadiness())
  }
  const validatedMaxAgeMs = Number(maxAgeMs)

  const ownedBudget = options.budget ? null : AccessExecutionBudget.create('action')
  const budget = options.budget ?? ownedBudget!
  try {
    const query = (db: Pick<DbClient, 'query'>) =>
      runAccessDatabaseQuery(
        db,
        budget,
        `SELECT source_family, generation, resource_version, status, last_success_at
         FROM operational_catalog_source_state
        WHERE environment_id = $1
          AND source_family = ANY($2::text[])
        ORDER BY source_family`,
        [canonicalEnvironmentId(), OPERATIONAL_SOURCE_FAMILIES]
      )
    const result = options.db
      ? await query(options.db)
      : await withAccessDatabaseTransaction(
          budget,
          db =>
            db.query(
              `SELECT source_family, generation, resource_version, status, last_success_at
               FROM operational_catalog_source_state
              WHERE environment_id = $1
                AND source_family = ANY($2::text[])
              ORDER BY source_family`,
              [canonicalEnvironmentId(), OPERATIONAL_SOURCE_FAMILIES]
            ),
          { mode: 'read_only' }
        )
    const states = parseSourceStates(result.rows as Record<string, unknown>[])
    return compileUserAccessPolicy(
      intent,
      runtimeReadiness(states, options.now ?? new Date(), validatedMaxAgeMs)
    )
  } catch (error) {
    if (error instanceof UserAccessPolicyConfigurationError) throw error
    return compileUserAccessPolicy(intent, unavailableReadiness())
  } finally {
    ownedBudget?.close()
  }
}
