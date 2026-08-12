import type { DbClient } from '../../db.js'
import { runAccessDatabaseQuery } from './accessDatabaseQuery.js'
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
  values: unknown[],
  options: { chargeProducer?: boolean } = {}
) {
  return runAccessDatabaseQuery(db, budget, text, values, options)
}

export type BoundedKeyArm = Readonly<{
  sql: string
  orderBy?: string
  duplicateCapable?: boolean
  hasValidUntil?: boolean
}>

export function boundedKeyUnionSql(arms: readonly (string | BoundedKeyArm)[]): string {
  if (arms.length === 0) throw new CatalogProducerContractError('key_arms_missing')
  const names = arms.map((_, index) => `source_${index}`)
  const sources = arms
    .map((arm, index) => {
      const definition = typeof arm === 'string' ? { sql: arm } : arm
      const after = `arm_after_${index}`
      const sourceSql = definition.sql.replaceAll('$2', `${after}.after_key`).replaceAll(
        '$7',
        `CASE WHEN POSITION('/' IN ${after}.after_key) > 0
                THEN SPLIT_PART(${after}.after_key, '/', 2) ELSE '' END`
      )
      return `${names[index]} AS MATERIALIZED (
          SELECT '${names[index]}'::text AS source_arm, bounded_arm.logical_id,
                 ${definition.hasValidUntil ? 'bounded_arm.valid_until' : 'NULL::timestamptz'}
                   AS valid_until
            FROM (
              SELECT COALESCE(NULLIF($8::jsonb ->> '${names[index]}', ''), $2) AS after_key
               WHERE $9::jsonb IS NULL OR $9::jsonb ? '${names[index]}'
            ) ${after}
            CROSS JOIN LATERAL (${sourceSql}) bounded_arm
          ORDER BY ${definition.orderBy ?? 'logical_id'}
          LIMIT $4
        )`
    })
    .join(',\n')
  const union = names
    .map(
      (name, index) => `SELECT '${name}'::text AS source_arm,
                       COALESCE((
                         SELECT jsonb_agg(jsonb_build_object(
                           'logical_id', logical_id,
                           'valid_until', valid_until
                         ) ORDER BY logical_id)
                           FROM ${name}
                       ), '[]'::jsonb) AS source_rows,
                       ${
                         (typeof arms[index] === 'string' ? false : arms[index].duplicateCapable)
                           ? `(SELECT COUNT(*) FROM ${name}) >= $4`
                           : 'FALSE'
                       } AS source_saturated
                 WHERE $9::jsonb IS NULL OR $9::jsonb ? '${name}'`
    )
    .join('\nUNION ALL\n')
  return `WITH ${sources}
    SELECT source_arm, source_rows, source_saturated
      FROM (${union}) bounded_sources
     WHERE $1::uuid IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL
       AND $5::text IS NOT NULL AND $6::text IS NOT NULL AND $7::text IS NOT NULL
     ORDER BY source_arm`
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
  extraValues?: readonly unknown[] | ((after: string) => readonly unknown[])
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
  type ArmCandidate = Readonly<{ logicalId: string; validUntil: string | null }>
  type ArmState = { after: string; exhausted: boolean; candidates: ArmCandidate[] }
  const arms = new Map<string, ArmState>()
  const candidates: CatalogIdentityCandidate[] = []
  let firstQuery = true
  let loaded = false
  const refill = async (armNames: readonly string[] | null) => {
    const result = await catalogQuery(
      context.db,
      context.budget,
      input.sql,
      [
        context.principal.userId,
        after,
        context.environmentId,
        input.take + 1,
        ...(typeof input.extraValues === 'function'
          ? input.extraValues(after)
          : (input.extraValues ?? [])),
        JSON.stringify(Object.fromEntries([...arms].map(([name, arm]) => [name, arm.after]))),
        armNames === null
          ? null
          : JSON.stringify(Object.fromEntries(armNames.map(name => [name, true]))),
      ],
      { chargeProducer: firstQuery }
    )
    firstQuery = false
    const rawByArm = new Map<string, ArmCandidate[]>()
    const saturation = new Map<string, boolean>()
    for (const row of result.rows as Record<string, unknown>[]) {
      const armName = typeof row.source_arm === 'string' ? row.source_arm : ''
      if (!armName) throw new CatalogProducerContractError('source_arm_invalid')
      if (typeof row.source_saturated !== 'boolean') {
        throw new CatalogProducerContractError('source_saturation_invalid')
      }
      saturation.set(armName, row.source_saturated)
      if (!Array.isArray(row.source_rows)) {
        throw new CatalogProducerContractError('source_rows_invalid')
      }
      const state = arms.get(armName) ?? { after, exhausted: false, candidates: [] }
      const values: ArmCandidate[] = []
      for (const sourceRow of row.source_rows) {
        if (!sourceRow || typeof sourceRow !== 'object' || Array.isArray(sourceRow)) {
          throw new CatalogProducerContractError('source_rows_invalid')
        }
        const sourceValue = sourceRow as Record<string, unknown>
        const logicalId = typeof sourceValue.logical_id === 'string' ? sourceValue.logical_id : ''
        if (!logicalId || logicalId <= state.after) {
          throw new CatalogProducerContractError('keys_not_strictly_ordered')
        }
        let validUntil: string | null = null
        if (sourceValue.valid_until !== null && sourceValue.valid_until !== undefined) {
          const timestamp = new Date(String(sourceValue.valid_until))
          if (Number.isNaN(timestamp.getTime())) {
            throw new CatalogProducerContractError('candidate_valid_until_invalid')
          }
          validUntil = timestamp.toISOString()
        }
        const previous = values.at(-1)
        if (!previous || previous.logicalId !== logicalId) values.push({ logicalId, validUntil })
        else if (
          previous.validUntil === null ||
          (validUntil !== null && validUntil < previous.validUntil)
        ) {
          values[values.length - 1] = { logicalId, validUntil }
        }
      }
      rawByArm.set(armName, values)
    }
    for (const [armName, saturated] of saturation) {
      const state = arms.get(armName) ?? { after, exhausted: false, candidates: [] }
      if (state.candidates.length === 0) state.candidates = rawByArm.get(armName) ?? []
      state.exhausted = !saturated
      arms.set(armName, state)
    }
    loaded = true
  }
  await refill(null)
  while (candidates.length < input.take + 1) {
    const heads = [...arms.entries()]
      .filter(([, state]) => state.candidates.length > 0)
      .map(([name, state]) => ({ name, state, candidate: state.candidates[0] }))
    if (heads.length === 0) {
      const refillable = [...arms.values()].some(state => !state.exhausted)
      if (!refillable) break
      await refill(
        [...arms.entries()]
          .filter(([, state]) => !state.exhausted && state.candidates.length === 0)
          .map(([name]) => name)
      )
      continue
    }
    const logicalId = heads.map(head => head.candidate.logicalId).sort()[0]
    const contributors = heads.filter(head => head.candidate.logicalId === logicalId)
    const validUntil =
      contributors
        .map(head => head.candidate.validUntil)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null
    candidates.push(
      Object.freeze({
        key: catalogKey(context.environmentId, input.family, logicalId),
        canonicalId: `${input.family}:${logicalId}`,
        validUntil,
      })
    )
    for (const { state } of contributors) {
      const consumed = state.candidates.shift()!
      state.after = consumed.logicalId
    }
    if (contributors.some(({ state }) => state.candidates.length === 0 && !state.exhausted)) {
      await refill(
        contributors
          .filter(({ state }) => state.candidates.length === 0 && !state.exhausted)
          .map(({ name }) => name)
      )
    }
  }
  if (!loaded) throw new CatalogProducerContractError('source_arms_missing')
  const hasMore =
    candidates.length > input.take ||
    [...arms.values()].some(state => !state.exhausted || state.candidates.length > 0)
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
