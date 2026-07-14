import { describe, expect, it } from 'vitest'
import { getBudgetsUsingPrice, getUnpricedModelsError } from '../api'

// Builds an Error shaped like the ones formatApiError produces: message plus a
// preserved structured `.body` (and `.code`) from the JSON error response.
function apiError(body: Record<string, unknown>): Error {
  const error = new Error('400 Bad Request - blocked')
  ;(error as Error & { code?: string; body?: unknown }).code =
    typeof body.error === 'string' ? (body.error as string) : undefined
  ;(error as Error & { body?: unknown }).body = body
  return error
}

describe('getUnpricedModelsError', () => {
  it('extracts the offending models from a 400 unpriced_models body', () => {
    const models = getUnpricedModelsError(
      apiError({
        error: 'unpriced_models',
        message: 'add prices',
        models: [{ provider: 'openai', model: 'gpt-5' }],
      })
    )
    expect(models).toEqual([{ provider: 'openai', model: 'gpt-5' }])
  })

  it('accepts provider: null (scope pins a model but not a provider)', () => {
    // Regression: control-api returns provider:null when the scope pins a model
    // without a provider. The coercion must NOT drop it (else the whole list
    // empties and the raw "400 Bad Request" string leaks through).
    const models = getUnpricedModelsError(
      apiError({
        error: 'unpriced_models',
        message: 'add prices',
        models: [{ provider: null, model: 'kimi-k2.5' }],
      })
    )
    expect(models).toEqual([{ provider: null, model: 'kimi-k2.5' }])
  })

  it('returns null for a different error code', () => {
    expect(getUnpricedModelsError(apiError({ error: 'validation' }))).toBeNull()
  })

  it('returns null (falls through to generic error) when the list is empty or malformed', () => {
    expect(getUnpricedModelsError(apiError({ error: 'unpriced_models', models: [] }))).toBeNull()
    expect(getUnpricedModelsError(apiError({ error: 'unpriced_models' }))).toBeNull()
    expect(
      getUnpricedModelsError(apiError({ error: 'unpriced_models', models: [{ model: 'x' }] }))
    ).toBeNull()
  })

  it('returns null for a plain Error with no structured body', () => {
    expect(getUnpricedModelsError(new Error('boom'))).toBeNull()
  })
})

describe('getBudgetsUsingPrice', () => {
  it('extracts the budgets from a 409 price_in_use_by_budget body', () => {
    const budgets = getBudgetsUsingPrice(
      apiError({
        error: 'price_in_use_by_budget',
        budgets: [{ id: 'b1', name: 'Monthly cap' }],
      })
    )
    expect(budgets).toEqual([{ id: 'b1', name: 'Monthly cap' }])
  })

  it('returns null for a different error code', () => {
    expect(getBudgetsUsingPrice(apiError({ error: 'conflict' }))).toBeNull()
  })

  it('returns null when the budgets list is empty or malformed', () => {
    expect(
      getBudgetsUsingPrice(apiError({ error: 'price_in_use_by_budget', budgets: [] }))
    ).toBeNull()
    expect(getBudgetsUsingPrice(apiError({ error: 'price_in_use_by_budget' }))).toBeNull()
  })
})
