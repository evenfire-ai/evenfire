import type { DbClient } from '../../db.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import {
  type CatalogFamily,
  type CatalogIdentityCandidate,
  type CatalogOperationalSourceState,
  type CatalogProducerPage,
  type CatalogRequestContext,
  type ProducerContinuation,
  type SafeCatalogPartialError,
  catalogKey,
  compareCatalogKey,
} from './catalogContracts.js'
import type { OperationalSourceFamily } from './operationalAccessProjection.js'

export class CatalogProducerContractError extends Error {
  constructor(readonly code: string) {
    super(`Catalog producer contract violation: ${code}`)
    this.name = 'CatalogProducerContractError'
  }
}

export async function catalogQuery(
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

export type BoundedKeyArm = Readonly<{ sql: string; orderBy?: string }>

export function boundedKeyUnionSql(arms: readonly (string | BoundedKeyArm)[]): string {
  if (arms.length === 0) throw new CatalogProducerContractError('key_arms_missing')
  const names = arms.map((_, index) => `source_${index}`)
  const sources = arms
    .map((arm, index) => {
      const definition = typeof arm === 'string' ? { sql: arm } : arm
      return `${names[index]} AS MATERIALIZED (
          ${definition.sql}
          ORDER BY ${definition.orderBy ?? 'logical_id'}
          LIMIT $4
        )`
    })
    .join(',\n')
  const union = names.map(name => `SELECT logical_id FROM ${name}`).join('\nUNION ALL\n')
  return `WITH ${sources}
    SELECT logical_id
      FROM (${union}) bounded_sources
     WHERE $1::uuid IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL
       AND $5::text IS NOT NULL AND $6::text IS NOT NULL AND $7::text IS NOT NULL
     GROUP BY logical_id
     ORDER BY logical_id
     LIMIT $4`
}

function validateContinuation(
  family: CatalogFamily,
  environmentId: string,
  continuation: ProducerContinuation
): string {
  if (continuation.exhausted) return ''
  if (!continuation.afterKey) return ''
  const [cursorEnvironment, cursorFamily, logicalId] = continuation.afterKey
  if (cursorEnvironment !== environmentId || cursorFamily !== family || !logicalId) {
    throw new CatalogProducerContractError('continuation_family_mismatch')
  }
  return logicalId
}

function sourceRevision(states: readonly CatalogOperationalSourceState[]): string {
  return revisionOfValues(
    states.map(state => [state.family, state.generation, state.resourceVersion, state.status])
  )
}

export function operationalReadiness(
  context: CatalogRequestContext,
  family: CatalogFamily,
  required: readonly OperationalSourceFamily[]
):
  | Readonly<{ status: 'current'; sourceRevision: string }>
  | Readonly<{
      status: 'partial'
      sourceRevision: string
      errors: readonly SafeCatalogPartialError[]
    }> {
  if (required.length === 0) return { status: 'current', sourceRevision: 'database' }
  const states = required.flatMap(source => {
    const value = context.sourceStates.get(source)
    return value ? [value] : []
  })
  const errors: SafeCatalogPartialError[] = []
  for (const source of required) {
    const state = context.sourceStates.get(source)
    if (!state || state.status !== 'current') {
      errors.push(
        Object.freeze({
          producer: family,
          code:
            state?.status === 'relisting'
              ? 'operational_source_relisting'
              : 'operational_source_unavailable',
          retryable: true,
        })
      )
    }
  }
  return errors.length === 0
    ? { status: 'current', sourceRevision: sourceRevision(states) }
    : {
        status: 'partial',
        sourceRevision: sourceRevision(states),
        errors: Object.freeze(errors),
      }
}

export async function listBoundedProducerKeys(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  requiredOperationalSources: readonly OperationalSourceFamily[]
  continuation: ProducerContinuation
  take: number
  sql: string
  extraValues?: readonly unknown[]
}): Promise<CatalogProducerPage> {
  const { context } = input
  if (
    !Number.isSafeInteger(input.take) ||
    input.take < 1 ||
    input.take > context.budget.limits.publicPageSize ||
    input.take + 1 > context.budget.limits.keyCandidatesPerCall
  ) {
    throw new CatalogProducerContractError('take_invalid')
  }
  const readiness = operationalReadiness(context, input.family, input.requiredOperationalSources)
  if (readiness.status === 'partial') {
    return Object.freeze({
      candidates: Object.freeze([]),
      continuation: Object.freeze({ afterKey: input.continuation.afterKey, exhausted: false }),
      hasMore: false,
      sourceRevision: readiness.sourceRevision,
      sourceCompleteness: 'partial',
      partialErrors: readiness.errors,
    })
  }
  if (input.continuation.exhausted) {
    return Object.freeze({
      candidates: Object.freeze([]),
      continuation: input.continuation,
      hasMore: false,
      sourceRevision: readiness.sourceRevision,
      sourceCompleteness: 'complete',
      partialErrors: Object.freeze([]),
    })
  }
  const after = validateContinuation(input.family, context.environmentId, input.continuation)
  const result = await catalogQuery(context.db, context.budget, input.sql, [
    context.principal.userId,
    after,
    context.environmentId,
    input.take + 1,
    ...(input.extraValues ?? []),
  ])
  if (result.rows.length > input.take + 1) {
    throw new CatalogProducerContractError('key_query_exceeded_take')
  }
  const candidates: CatalogIdentityCandidate[] = []
  let prior = after
  for (const row of result.rows as Record<string, unknown>[]) {
    const logicalId = typeof row.logical_id === 'string' ? row.logical_id : ''
    if (!logicalId || logicalId <= prior) {
      throw new CatalogProducerContractError('keys_not_strictly_ordered')
    }
    const key = catalogKey(context.environmentId, input.family, logicalId)
    if (candidates.length > 0 && compareCatalogKey(candidates.at(-1)!.key, key) >= 0) {
      throw new CatalogProducerContractError('keys_not_strictly_ordered')
    }
    candidates.push(Object.freeze({ key, canonicalId: `${input.family}:${logicalId}` }))
    prior = logicalId
  }
  const hasMore = candidates.length > input.take
  return Object.freeze({
    candidates: Object.freeze(candidates),
    continuation: Object.freeze({
      afterKey: candidates.at(-1)?.key ?? input.continuation.afterKey,
      exhausted: !hasMore,
    }),
    hasMore,
    sourceRevision: readiness.sourceRevision,
    sourceCompleteness: 'complete',
    partialErrors: Object.freeze([]),
  })
}

export function validateHydrationKeys(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  keys: readonly (readonly [string, CatalogFamily, string])[]
}): string[] {
  if (input.keys.length > input.context.budget.limits.keyCandidatesPerCall) {
    throw new CatalogProducerContractError('hydrate_key_count_exceeded')
  }
  const logicalIds: string[] = []
  for (const key of input.keys) {
    if (key[0] !== input.context.environmentId || key[1] !== input.family || !key[2]) {
      throw new CatalogProducerContractError('hydrate_key_mismatch')
    }
    if (logicalIds.at(-1) !== undefined && key[2] <= logicalIds.at(-1)!) {
      throw new CatalogProducerContractError('hydrate_keys_not_strictly_ordered')
    }
    logicalIds.push(key[2])
  }
  return logicalIds
}
