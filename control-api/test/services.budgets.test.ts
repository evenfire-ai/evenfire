import { describe, expect, it, vi } from 'vitest'
import {
  BudgetUnpricedModelsError,
  BudgetValidationError,
  type TokenBudget,
  budgetScopeSchema,
  buildScopeSql,
  computeBudgetSpent,
  createBudget,
  createBudgetSchema,
  findCostBudgetsPinningModel,
  findUnpricedScopedModels,
  releaseReservation,
  scopeMatches,
  updateBudget,
} from '../src/services/budgets/index.js'

function fakeDb(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as Parameters<typeof createBudget>[1]
}

const BASE_BUDGET: TokenBudget = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'team budget',
  enabled: true,
  scope: {},
  unit: 'cost',
  currency: 'USD',
  limit_amount: 500,
  period: 'monthly',
  timezone: 'UTC',
  min_start_amount: 0,
  max_task_amount: null,
  enforcement: 'warn',
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
}

describe('budgets scope schema + helpers', () => {
  it('accepts allowlisted dimensions with string[] values', () => {
    const res = budgetScopeSchema.safeParse({
      team_id: ['t1', 't2'],
      provider: ['openai'],
    })
    expect(res.success).toBe(true)
  })

  it('rejects an arbitrary (non-allowlisted) scope key', () => {
    const res = budgetScopeSchema.safeParse({ drop_table: ['x'] })
    expect(res.success).toBe(false)
  })

  it('rejects a non-string[] value', () => {
    const res = budgetScopeSchema.safeParse({ team_id: [1, 2] })
    expect(res.success).toBe(false)
  })

  it('rejects an empty value array', () => {
    const res = budgetScopeSchema.safeParse({ team_id: [] })
    expect(res.success).toBe(false)
  })

  describe('buildScopeSql', () => {
    it('ANDs keys and ORs values into IN clauses with bound params', () => {
      const { sql, params } = buildScopeSql({ team_id: ['t1', 't2'], provider: ['openai'] }, 3)
      expect(sql).toBe(' AND team_id IN ($3, $4) AND provider IN ($5)')
      expect(params).toEqual(['t1', 't2', 'openai'])
    })

    it('returns empty sql for global ({}) scope', () => {
      expect(buildScopeSql({}, 3)).toEqual({ sql: '', params: [] })
    })

    it('skips non-allowlisted keys defensively', () => {
      const { sql, params } = buildScopeSql({ bogus: ['x'], team_id: ['t1'] } as never, 3)
      expect(sql).toBe(' AND team_id IN ($3)')
      expect(params).toEqual(['t1'])
    })
  })

  describe('scopeMatches', () => {
    it('matches everything for empty scope', () => {
      expect(scopeMatches({}, { team_id: 'anything' })).toBe(true)
    })

    it('ANDs keys / ORs values', () => {
      const scope = { team_id: ['t1', 't2'], provider: ['openai'] }
      expect(scopeMatches(scope, { team_id: 't2', provider: 'openai' })).toBe(true)
      expect(scopeMatches(scope, { team_id: 't3', provider: 'openai' })).toBe(false)
      expect(scopeMatches(scope, { team_id: 't1', provider: 'claude' })).toBe(false)
    })

    it('a null request value never matches a constrained key', () => {
      expect(scopeMatches({ team_id: ['t1'] }, { team_id: null })).toBe(false)
    })
  })
})

describe('createBudgetSchema', () => {
  it("requires currency when unit='cost'", () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'cost',
      limit_amount: 10,
      period: 'daily',
    })
    expect(res.success).toBe(false)
  })

  it("allows missing currency when unit='tokens'", () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 1000,
      period: 'daily',
    })
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data).toMatchObject({
        enabled: true,
        timezone: 'UTC',
        min_start_amount: 0,
        enforcement: 'block',
        scope: {},
      })
    }
  })

  it('rejects a non-positive limit_amount', () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 0,
      period: 'daily',
    })
    expect(res.success).toBe(false)
  })

  it('rejects an invalid timezone', () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 10,
      period: 'daily',
      timezone: 'Mars/Olympus',
    })
    expect(res.success).toBe(false)
  })

  it('rejects a valid non-UTC timezone (pinned to UTC in this version)', () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 10,
      period: 'daily',
      timezone: 'America/New_York',
    })
    expect(res.success).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 10,
      period: 'daily',
      bogus: 'x',
    })
    expect(res.success).toBe(false)
  })

  it('rejects an arbitrary scope key', () => {
    const res = createBudgetSchema.safeParse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 10,
      period: 'daily',
      scope: { evil: ['x'] },
    })
    expect(res.success).toBe(false)
  })
})

describe('createBudget / updateBudget', () => {
  it('serializes scope to jsonb and persists fields', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...BASE_BUDGET, scope: { team_id: ['t1'] } }],
      rowCount: 1,
    })
    const input = createBudgetSchema.parse({
      name: 'team budget',
      unit: 'cost',
      currency: 'USD',
      limit_amount: 500,
      period: 'monthly',
      scope: { team_id: ['t1'] },
    })
    const budget = await createBudget(input, fakeDb(query))
    expect(budget.scope).toEqual({ team_id: ['t1'] })
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toMatch(/\$3::jsonb/)
    expect(params[2]).toBe(JSON.stringify({ team_id: ['t1'] }))
  })

  it('maps a pg check violation (23514) to BudgetValidationError', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('check'), { code: '23514' }))
    await expect(
      createBudget(
        createBudgetSchema.parse({
          name: 'b',
          unit: 'tokens',
          limit_amount: 10,
          period: 'daily',
        }),
        fakeDb(query)
      )
    ).rejects.toBeInstanceOf(BudgetValidationError)
  })

  it('update only sets provided columns (jsonb cast on scope)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [BASE_BUDGET], rowCount: 1 })
    await updateBudget(
      BASE_BUDGET.id,
      { enabled: false, scope: { provider: ['openai'] } },
      fakeDb(query)
    )
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toMatch(/enabled = \$1/)
    expect(String(sql)).toMatch(/scope = \$2::jsonb/)
    expect(String(sql)).toMatch(/updated_at = NOW\(\)/)
    expect(params[0]).toBe(false)
    expect(params[1]).toBe(JSON.stringify({ provider: ['openai'] }))
    expect(params[2]).toBe(BASE_BUDGET.id)
  })
})

describe('findUnpricedScopedModels (create/edit guard, prevention a)', () => {
  it('returns [] without querying when the scope pins no model', async () => {
    const query = vi.fn()
    const res = await findUnpricedScopedModels({ provider: ['openai'] }, fakeDb(query))
    expect(res).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('checks each provider×model pair when provider is pinned', async () => {
    // Only (openai, gpt-4o) is priced; the other three pairs are unpriced.
    const query = vi.fn().mockResolvedValue({
      rows: [{ provider: 'openai', model: 'gpt-4o' }],
      rowCount: 1,
    })
    const res = await findUnpricedScopedModels(
      { provider: ['openai', 'anthropic'], model: ['gpt-4o', 'claude-x'] },
      fakeDb(query)
    )
    expect(res).toEqual([
      { provider: 'openai', model: 'claude-x' },
      { provider: 'anthropic', model: 'gpt-4o' },
      { provider: 'anthropic', model: 'claude-x' },
    ])
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toMatch(/provider = ANY\(\$1::text\[\]\) AND model = ANY\(\$2::text\[\]\)/)
    expect(params).toEqual([
      ['openai', 'anthropic'],
      ['gpt-4o', 'claude-x'],
    ])
  })

  it('requires SOME active price (any provider) when only model is pinned', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ model: 'gpt-4o' }], rowCount: 1 })
    const res = await findUnpricedScopedModels({ model: ['gpt-4o', 'claude-x'] }, fakeDb(query))
    expect(res).toEqual([{ provider: null, model: 'claude-x' }])
    const [sql] = query.mock.calls[0]
    expect(String(sql)).toMatch(/SELECT DISTINCT model FROM llm_model_prices/)
  })

  it('returns [] when every pinned model is priced', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ model: 'gpt-4o' }], rowCount: 1 })
    const res = await findUnpricedScopedModels({ model: ['gpt-4o'] }, fakeDb(query))
    expect(res).toEqual([])
  })
})

describe('findCostBudgetsPinningModel (delete/disable guard, prevention b)', () => {
  it('queries cost budgets pinning the (provider, model) via jsonb containment', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 'b1', name: 'cap' }],
      rowCount: 1,
    })
    const res = await findCostBudgetsPinningModel('openai', 'gpt-4o', fakeDb(query))
    expect(res).toEqual([{ id: 'b1', name: 'cap' }])
    const [sql, params] = query.mock.calls[0]
    const text = String(sql)
    expect(text).toMatch(/unit = 'cost'/)
    expect(text).toMatch(/scope -> 'model' \? \$2/)
    expect(text).toMatch(/NOT \(scope \? 'provider'\) OR scope -> 'provider' \? \$1/)
    expect(params).toEqual(['openai', 'gpt-4o'])
  })

  it('returns [] when no cost budget pins the model', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await findCostBudgetsPinningModel('openai', 'gpt-4o', fakeDb(query))).toEqual([])
  })
})

describe('createBudget cost-model pricing guard', () => {
  function guardedDb(unpricedRows: unknown[]) {
    return fakeDb(
      vi.fn().mockImplementation((sql: string) => {
        if (/llm_model_prices/.test(String(sql))) {
          return Promise.resolve({ rows: unpricedRows, rowCount: unpricedRows.length })
        }
        // INSERT ... RETURNING
        return Promise.resolve({ rows: [BASE_BUDGET], rowCount: 1 })
      })
    )
  }

  it('rejects a cost budget pinning an unpriced model with BudgetUnpricedModelsError', async () => {
    const input = createBudgetSchema.parse({
      name: 'b',
      unit: 'cost',
      currency: 'USD',
      limit_amount: 10,
      period: 'daily',
      scope: { model: ['mystery-model'] },
    })
    // No matching price rows → the model is unpriced.
    await expect(createBudget(input, guardedDb([]))).rejects.toBeInstanceOf(
      BudgetUnpricedModelsError
    )
  })

  it('allows a cost budget when the pinned model has an active price', async () => {
    const input = createBudgetSchema.parse({
      name: 'b',
      unit: 'cost',
      currency: 'USD',
      limit_amount: 10,
      period: 'daily',
      scope: { model: ['gpt-4o'] },
    })
    const budget = await createBudget(input, guardedDb([{ model: 'gpt-4o' }]))
    expect(budget.id).toBe(BASE_BUDGET.id)
  })

  it('does not run the guard for a tokens budget pinning a model', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [BASE_BUDGET], rowCount: 1 })
    const input = createBudgetSchema.parse({
      name: 'b',
      unit: 'tokens',
      limit_amount: 10,
      period: 'daily',
      scope: { model: ['mystery-model'] },
    })
    await createBudget(input, fakeDb(query))
    // Only the INSERT ran — no llm_model_prices lookup.
    const pricingCall = query.mock.calls.find(c => /llm_model_prices/.test(String(c[0])))
    expect(pricingCall).toBeUndefined()
  })

  it('rejects unit=cost when the scope includes Codex subscription', async () => {
    const query = vi.fn()
    const input = createBudgetSchema.parse({
      name: 'codex cost',
      unit: 'cost',
      currency: 'USD',
      limit_amount: 25,
      period: 'monthly',
      scope: { provider: ['codex-subscription'] },
    })
    await expect(createBudget(input, fakeDb(query))).rejects.toMatchObject({
      name: 'BudgetValidationError',
      message: /unit tokens, not cost/,
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('allows a tokens budget scoped to Codex subscription', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [BASE_BUDGET], rowCount: 1 })
    const input = createBudgetSchema.parse({
      name: 'codex tokens',
      unit: 'tokens',
      limit_amount: 10000,
      period: 'monthly',
      scope: { provider: ['codex-subscription'] },
    })
    await createBudget(input, fakeDb(query))
    expect(query).toHaveBeenCalled()
  })
})

describe('updateBudget cost-model pricing guard (merged effective row)', () => {
  // Route by SQL so the conditional getBudget + pricing lookup + UPDATE can each
  // be answered independently and inspected.
  function mergeDb(
    existing: TokenBudget | null,
    unpricedRows: unknown[],
    updateRows: unknown[] = [BASE_BUDGET]
  ) {
    const query = vi.fn().mockImplementation((sql: string) => {
      const s = String(sql)
      if (/llm_model_prices/.test(s)) {
        return Promise.resolve({ rows: unpricedRows, rowCount: unpricedRows.length })
      }
      if (/UPDATE token_budgets/.test(s)) {
        return Promise.resolve({ rows: updateRows, rowCount: updateRows.length })
      }
      if (/FROM token_budgets/.test(s)) {
        return Promise.resolve({
          rows: existing ? [existing] : [],
          rowCount: existing ? 1 : 0,
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    return { db: fakeDb(query), query }
  }

  it('rejects flipping unit→cost over an existing scope.model with no price', async () => {
    const existing: TokenBudget = {
      ...BASE_BUDGET,
      unit: 'tokens',
      currency: null,
      scope: { model: ['mystery-model'] },
    }
    const { db } = mergeDb(existing, []) // no price rows → unpriced
    await expect(updateBudget(BASE_BUDGET.id, { unit: 'cost' }, db)).rejects.toBeInstanceOf(
      BudgetUnpricedModelsError
    )
  })

  it('rejects adding an unpriced scope.model to an existing cost budget', async () => {
    const existing: TokenBudget = { ...BASE_BUDGET, unit: 'cost', scope: {} }
    const { db, query } = mergeDb(existing, [])
    await expect(
      updateBudget(BASE_BUDGET.id, { scope: { model: ['mystery-model'] } }, db)
    ).rejects.toBeInstanceOf(BudgetUnpricedModelsError)
    // getBudget was consulted for the effective unit, and the UPDATE never ran.
    expect(query.mock.calls.find(c => /UPDATE token_budgets/.test(String(c[0])))).toBeUndefined()
  })

  it('allows adding a scope.model that has an active price to a cost budget', async () => {
    const existing: TokenBudget = { ...BASE_BUDGET, unit: 'cost', scope: {} }
    const { db } = mergeDb(existing, [{ model: 'gpt-4o' }])
    const res = await updateBudget(BASE_BUDGET.id, { scope: { model: ['gpt-4o'] } }, db)
    expect(res).not.toBeNull()
  })

  it('does NOT validate (nor read existing) when flipping unit→tokens', async () => {
    const { db, query } = mergeDb({ ...BASE_BUDGET, unit: 'cost' }, [])
    const res = await updateBudget(BASE_BUDGET.id, { unit: 'tokens' }, db)
    expect(res).not.toBeNull()
    // Guard short-circuits: no pricing lookup and no getBudget SELECT.
    expect(query.mock.calls.find(c => /llm_model_prices/.test(String(c[0])))).toBeUndefined()
    expect(
      query.mock.calls.find(c => /SELECT[\s\S]*FROM token_budgets/.test(String(c[0])))
    ).toBeUndefined()
  })

  it('falls through to a clean 404 (null) when the budget does not exist', async () => {
    // getBudget → none; effectiveScope stays undefined so the guard is skipped;
    // the UPDATE returns no row → null, never a spurious BudgetUnpricedModelsError.
    const { db, query } = mergeDb(null, [], [])
    const res = await updateBudget(BASE_BUDGET.id, { unit: 'cost' }, db)
    expect(res).toBeNull()
    expect(query.mock.calls.find(c => /llm_model_prices/.test(String(c[0])))).toBeUndefined()
  })
})

describe('computeBudgetSpent', () => {
  it("unit='tokens': sums the 4 counters across both tiers, no price JOIN", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ spent: '12345' }], rowCount: 1 })
    const res = await computeBudgetSpent(
      { ...BASE_BUDGET, unit: 'tokens', currency: null, limit_amount: 100000 },
      fakeDb(query)
    )
    expect(res.spent).toBe(12345)
    expect(res.remaining).toBe(100000 - 12345)
    expect(res.unpriced).toEqual([])
    const [sql, params] = query.mock.calls[0]
    const text = String(sql)
    // stitch: daily tier bounded by period_start..start_of_today, 5min from today
    expect(text).toMatch(/FROM usage_daily, bounds/)
    expect(text).toMatch(/bucket >= bounds\.period_start AND bucket < bounds\.start_of_today/)
    expect(text).toMatch(/FROM usage_5min, bounds/)
    expect(text).toMatch(/bucket >= bounds\.start_of_today/)
    expect(text).toMatch(/input_tokens \+ output_tokens \+ cache_read_tokens \+ cache_write_tokens/)
    expect(text).not.toMatch(/llm_model_prices/)
    // monthly → date_trunc field 'month', tz 'UTC'
    expect(params[0]).toBe('month')
    expect(params[1]).toBe('UTC')
  })

  it("unit='cost': LEFT JOINs prices, sums amount, surfaces unpriced models", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { provider: 'openai', model: 'gpt-4o', priced: true, tokens: '1000', amount: '2.5000' },
        { provider: 'claude', model: 'mystery', priced: false, tokens: '500', amount: '0' },
      ],
      rowCount: 2,
    })
    const res = await computeBudgetSpent({ ...BASE_BUDGET, limit_amount: 500 }, fakeDb(query))
    expect(res.spent).toBeCloseTo(2.5)
    expect(res.remaining).toBeCloseTo(497.5)
    expect(res.unpriced).toEqual([{ provider: 'claude', model: 'mystery' }])
    const [sql] = query.mock.calls[0]
    const text = String(sql)
    expect(text).toMatch(/LEFT JOIN llm_model_prices p/)
    expect(text).toMatch(/p\.enabled/)
    expect(text).toMatch(/COALESCE\(p\.input_token_price, 0\)/)
    expect(text).toMatch(/\/ 1e6/)
  })

  it('daily budget reads only usage_5min (period_start == start_of_today)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ spent: '7' }], rowCount: 1 })
    await computeBudgetSpent(
      {
        ...BASE_BUDGET,
        unit: 'tokens',
        currency: null,
        period: 'daily',
        timezone: 'America/New_York',
      },
      fakeDb(query)
    )
    const [sql, params] = query.mock.calls[0]
    // both bounds use date_trunc('day', ...) for a daily budget
    expect(params[0]).toBe('day')
    expect(params[1]).toBe('America/New_York')
    // the daily-tier subquery still emits the empty range guard
    expect(String(sql)).toMatch(/bucket < bounds\.start_of_today/)
  })

  it('passes scope values as bound params for both tiers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ spent: '0' }], rowCount: 1 })
    await computeBudgetSpent(
      {
        ...BASE_BUDGET,
        unit: 'tokens',
        currency: null,
        scope: { team_id: ['t1'], provider: ['openai'] },
      },
      fakeDb(query)
    )
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toMatch(/team_id IN \(\$3\)/)
    expect(String(sql)).toMatch(/provider IN \(\$4\)/)
    expect(params).toEqual(['month', 'UTC', 't1', 'openai'])
  })
})

describe('releaseReservation host scoping', () => {
  it('scopes the DELETE by host_ref for id+task_ref, id-only, and task_ref-only', async () => {
    const idQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    await releaseReservation(
      { reservationId: 'r-1', taskRef: 't-1', hostRef: 'trader' },
      { query: idQuery }
    )
    expect(String(idQuery.mock.calls[0][0])).toMatch(
      /\(id = \$1 OR task_ref = \$2\) AND host_ref = \$3/
    )
    expect(idQuery.mock.calls[0][1]).toEqual(['r-1', 't-1', 'trader'])

    const idOnly = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    await releaseReservation({ reservationId: 'r-1', hostRef: 'trader' }, { query: idOnly })
    expect(String(idOnly.mock.calls[0][0])).toMatch(/id = \$1 AND host_ref = \$2/)
    expect(idOnly.mock.calls[0][1]).toEqual(['r-1', 'trader'])

    const taskOnly = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    await releaseReservation({ taskRef: 't-1', hostRef: 'trader' }, { query: taskOnly })
    expect(String(taskOnly.mock.calls[0][0])).toMatch(/task_ref = \$1 AND host_ref = \$2/)
    expect(taskOnly.mock.calls[0][1]).toEqual(['t-1', 'trader'])
  })

  it("deletes 0 rows when another host's host_ref does not match (griefing blocked)", async () => {
    // Postgres would match no rows because host_ref differs; the mock returns the
    // rowCount the real DELETE would yield (0) to encode that behavior.
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const deleted = await releaseReservation({ taskRef: 't-1', hostRef: 'other-host' }, { query })
    expect(deleted).toBe(0)
    expect(query.mock.calls[0][1]).toEqual(['t-1', 'other-host'])
  })
})
