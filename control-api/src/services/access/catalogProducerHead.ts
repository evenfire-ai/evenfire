import {
  type CatalogFamily,
  type CatalogIdentityCandidate,
  type CatalogProducerPage,
  type CatalogRequestContext,
  type ProducerContinuation,
  catalogKey,
} from './catalogContracts.js'
import { catalogQuery } from './catalogProducerDatabase.js'
import { CatalogProducerContractError } from './catalogProducerErrors.js'
import { operationalReadiness } from './catalogProducerReadiness.js'
import type { OperationalSourceFamily } from './operationalAccessProjection.js'

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

/** Builds a bounded, private per-arm producer head for one catalog family. */
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
