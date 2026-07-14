import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { __resetBudgetCheckCache } from '../src/services/budgets/check.js'
import { sweepExpiredReservations } from '../src/services/budgets/reservations.js'
import { issueMcpHostAccessJwt } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
// Transaction client used by the danger-zone reservation path (reservations.ts).
// Its query goes through a SEPARATE spy so we can assert BEGIN/lock/INSERT/COMMIT
// and simulate concurrent pending without touching the read-only pull queries.
const mockTxQuery = vi.fn()
const mockTxRelease = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockTxQuery(...args),
        release: () => mockTxRelease(),
      }),
  },
}))

// Capture structured logs so we can assert the observation-mode signal
// (`budget_would_block`) without touching real pino transports.
const mockLogWarn = vi.fn()
const mockLogError = vi.fn()
vi.mock('../src/observability/logger.js', () => {
  const makeLogger = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'warn') return mockLogWarn
          if (prop === 'error') return mockLogError
          if (prop === 'child') return () => makeLogger()
          return () => {}
        },
      }
    )
  return { rootLogger: makeLogger() }
})

const BASE_REQUEST = {
  host_ref: 'trader',
  context_ref: 'trader-context',
  provider: 'openai',
  model: 'gpt-4o',
  source_kind: 'desktop' as const,
}

function app() {
  return createApp(new MockGateway('mcp-server') as never)
}

function token(): string {
  return issueMcpHostAccessJwt('mcp-host', 'standalone', ['trader']).token
}

function authedCheck(body: Record<string, unknown> = BASE_REQUEST) {
  return request(app())
    .post('/api/v1/internal/budgets/check')
    .set('Authorization', `Bearer ${token()}`)
    .send(body)
}

function budgetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'budget',
    enabled: true,
    scope: {},
    unit: 'tokens',
    currency: null,
    limit_amount: '1000',
    period: 'monthly',
    timezone: 'UTC',
    min_start_amount: '0',
    max_task_amount: null,
    enforcement: 'warn',
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

// Per-test fixtures consumed by the SQL dispatcher below.
let budgetsRows: Record<string, unknown>[] = []
let teamRows: Record<string, unknown>[] = []
let priceRows: Record<string, unknown>[] = []
// Ordered spend results; budgets are evaluated in the order of `budgetsRows`.
// An entry may be an Error to simulate a spend computation failure.
let spendQueue: Array<{ rows: unknown[] } | Error> = []
let budgetsListCalls = 0
// Danger-zone reservation fixtures: the pending SUM the transaction sees, the
// id returned by INSERT, and an optional Error to fail the whole tx (lock/insert).
let pendingSum = '0'
let reservationId = '99999999-9999-4999-8999-999999999999'
let txError: Error | null = null
// rowCount returned by a DELETE FROM budget_pending_reservations (release/sweep).
let deleteRowCount = 0

function defaultTxImpl(sql: unknown): Promise<{ rows: unknown[]; rowCount: number | null }> {
  const s = String(sql)
  if (txError && /advisory_xact_lock|INSERT INTO budget_pending_reservations/.test(s)) {
    return Promise.reject(txError)
  }
  if (/SELECT COALESCE\(SUM\(est_amount\)/.test(s)) {
    return Promise.resolve({ rows: [{ pending: pendingSum }], rowCount: 1 })
  }
  if (/INSERT INTO budget_pending_reservations/.test(s)) {
    return Promise.resolve({ rows: [{ id: reservationId }], rowCount: 1 })
  }
  // BEGIN / COMMIT / ROLLBACK / advisory_xact_lock
  return Promise.resolve({ rows: [], rowCount: 0 })
}

beforeEach(() => {
  __resetBudgetCheckCache()
  budgetsRows = []
  teamRows = []
  priceRows = []
  spendQueue = []
  budgetsListCalls = 0
  pendingSum = '0'
  reservationId = '99999999-9999-4999-8999-999999999999'
  txError = null
  deleteRowCount = 0
  mockLogWarn.mockReset()
  mockLogError.mockReset()
  mockTxRelease.mockReset()
  mockTxQuery.mockReset()
  mockTxQuery.mockImplementation((sql: unknown) => defaultTxImpl(sql))
  mockPoolQuery.mockReset()
  mockPoolQuery.mockImplementation((sql: unknown) => {
    const s = String(sql)
    if (/team_contexts/.test(s)) {
      return Promise.resolve({ rows: teamRows, rowCount: teamRows.length })
    }
    if (/FROM token_budgets/.test(s)) {
      budgetsListCalls++
      return Promise.resolve({ rows: budgetsRows, rowCount: budgetsRows.length })
    }
    // Usage-rollup queries must be matched BEFORE the price branch: a cost-unit
    // spend query LEFT JOINs llm_model_prices, so it also contains that string —
    // route it to the spend queue, not the standalone getActivePrice lookup.
    if (/usage_5min|usage_daily/.test(s)) {
      const next = spendQueue.shift()
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next ?? { rows: [{ spent: '0' }] })
    }
    if (/llm_model_prices/.test(s)) {
      return Promise.resolve({ rows: priceRows, rowCount: priceRows.length })
    }
    if (/DELETE FROM budget_pending_reservations/.test(s)) {
      return Promise.resolve({ rows: [], rowCount: deleteRowCount })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
})

describe('POST /api/v1/internal/budgets/check', () => {
  it('rejects requests without an mcp-host JWT (401)', async () => {
    await request(app()).post('/api/v1/internal/budgets/check').send(BASE_REQUEST).expect(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('rejects an invalid body (400) and an unknown key', async () => {
    await authedCheck({ host_ref: 'trader' }).expect(400) // missing provider/model/source_kind
    await authedCheck({ ...BASE_REQUEST, bogus: 1 }).expect(400)
  })

  it('resolves team_id from context_ref and matches a team-scoped budget', async () => {
    teamRows = [{ team_id: 'team-X' }]
    budgetsRows = [budgetRow({ scope: { team_id: ['team-X'] } })]
    spendQueue = [{ rows: [{ spent: '100' }] }]

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.matched).toHaveLength(1)
    expect(res.body.matched[0]).toMatchObject({ unit: 'tokens', remaining: 900, limit: 1000 })

    // The team was resolved with the earliest-bound DISTINCT ON, parameterized.
    const teamCall = mockPoolQuery.mock.calls.find(c => /team_contexts/.test(String(c[0])))
    expect(teamCall).toBeDefined()
    expect(String(teamCall![0])).toMatch(/DISTINCT ON \(context_id\)/)
    expect((teamCall![1] as unknown[])[0]).toBe('trader-context')
  })

  it('uses the context-resolved team when body team_id agrees (matches, no override)', async () => {
    teamRows = [{ team_id: 'team-X' }]
    budgetsRows = [budgetRow({ scope: { team_id: ['team-X'] } })]
    spendQueue = [{ rows: [{ spent: '100' }] }]

    const res = await authedCheck({ ...BASE_REQUEST, team_id: 'team-X' }).expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.matched).toHaveLength(1)
    // A legit agreeing body must NOT trip the spoof-override audit log.
    const override = mockLogWarn.mock.calls.find(c => c[1] === 'budget_check_team_binding_override')
    expect(override).toBeUndefined()
  })

  it('overrides a spoofed body team_id with the context-resolved team (no cross-tenant leak)', async () => {
    // Body claims team-attacker but the context canonically resolves to team-real.
    // Matching must use team-real: the attacker-scoped budget must NOT match and
    // the real-team budget MUST, and the disagreement is audited.
    teamRows = [{ team_id: 'team-real' }]
    budgetsRows = [
      budgetRow({ id: 'atk', name: 'attacker', scope: { team_id: ['team-attacker'] } }),
      budgetRow({ id: 'real', name: 'real', scope: { team_id: ['team-real'] } }),
    ]
    spendQueue = [{ rows: [{ spent: '100' }] }] // only the real-team budget matches

    const res = await authedCheck({ ...BASE_REQUEST, team_id: 'team-attacker' }).expect(200)
    expect(res.body.matched).toHaveLength(1)
    expect(res.body.matched[0].id).toBe('real')

    const override = mockLogWarn.mock.calls.find(c => c[1] === 'budget_check_team_binding_override')
    expect(override).toBeDefined()
    expect(override![0]).toMatchObject({
      bodyTeamId: 'team-attacker',
      resolvedTeamId: 'team-real',
    })
  })

  it('trusts the body team_id when there is no context_ref (documented residual)', async () => {
    // Workflow/cron may carry a team_id with no context to canonicalize it.
    budgetsRows = [budgetRow({ scope: { team_id: ['team-Y'] } })]
    spendQueue = [{ rows: [{ spent: '100' }] }]

    const res = await authedCheck({
      ...BASE_REQUEST,
      context_ref: null,
      team_id: 'team-Y',
    }).expect(200)
    expect(res.body.matched).toHaveLength(1)
    // No context → no team_contexts resolution query at all.
    const teamCall = mockPoolQuery.mock.calls.find(c => /team_contexts/.test(String(c[0])))
    expect(teamCall).toBeUndefined()
  })

  it('falls back to body team_id when the context has no team binding (resolves null)', async () => {
    teamRows = [] // context not bound to any team yet → resolveTeamForContext → null
    budgetsRows = [budgetRow({ scope: { team_id: ['team-Z'] } })]
    spendQueue = [{ rows: [{ spent: '100' }] }]

    const res = await authedCheck({ ...BASE_REQUEST, team_id: 'team-Z' }).expect(200)
    expect(res.body.matched).toHaveLength(1)
  })

  it('matches a global budget but not a non-matching scoped budget', async () => {
    budgetsRows = [
      budgetRow({ id: 'g', name: 'global', scope: {} }),
      budgetRow({ id: 's', name: 'scoped', scope: { provider: ['anthropic'] } }),
    ]
    spendQueue = [{ rows: [{ spent: '0' }] }] // only the global budget computes spend

    const res = await authedCheck().expect(200)
    expect(res.body.matched).toHaveLength(1)
    expect(res.body.matched[0].id).toBe('g')
  })

  it('denies when a block budget has remaining < min_start_amount', async () => {
    budgetsRows = [
      budgetRow({ enforcement: 'block', min_start_amount: '100', limit_amount: '1000' }),
    ]
    spendQueue = [{ rows: [{ spent: '950' }] }] // remaining 50 < 100

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reason).toBe('budget_exceeded')
  })

  it('never denies for a warn budget, but emits budget_would_block', async () => {
    budgetsRows = [
      budgetRow({ enforcement: 'warn', min_start_amount: '100', limit_amount: '1000' }),
    ]
    spendQueue = [{ rows: [{ spent: '950' }] }] // remaining 50 < 100

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(mockLogWarn).toHaveBeenCalled()
    const logged = mockLogWarn.mock.calls.find(c => c[1] === 'budget_would_block')
    expect(logged).toBeDefined()
  })

  it('returns the strictest per-task brake (MIN) per unit', async () => {
    budgetsRows = [
      budgetRow({ id: 'a', unit: 'tokens', enforcement: 'block', max_task_amount: '1000' }),
      budgetRow({ id: 'b', unit: 'tokens', enforcement: 'block', max_task_amount: '500' }),
      budgetRow({
        id: 'c',
        unit: 'cost',
        currency: 'USD',
        enforcement: 'block',
        max_task_amount: '5',
      }),
    ]
    spendQueue = [
      { rows: [{ spent: '0' }] },
      { rows: [{ spent: '0' }] },
      { rows: [{ provider: 'openai', model: 'gpt-4o', priced: true, tokens: '0', amount: '0' }] },
    ]

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.maxTaskTokens).toBe(500)
    expect(res.body.maxTaskCost).toBe(5)
  })

  it('does not let a warn budget impose a per-task brake', async () => {
    budgetsRows = [
      budgetRow({ id: 'w', unit: 'tokens', enforcement: 'warn', max_task_amount: '500' }),
    ]
    spendQueue = [{ rows: [{ spent: '0' }] }]

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.maxTaskTokens ?? null).toBeNull()
  })

  it('returns the active price for (provider, model)', async () => {
    budgetsRows = []
    priceRows = [
      {
        input_token_price: '3.00',
        output_token_price: '15.00',
        cache_read_token_price: '0.30',
        cache_write_token_price: '3.75',
        currency: 'USD',
      },
    ]
    const res = await authedCheck().expect(200)
    expect(res.body.price).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      currency: 'USD',
    })
  })

  it('returns price=null when the model is unpriced', async () => {
    budgetsRows = []
    priceRows = []
    const res = await authedCheck().expect(200)
    expect(res.body.price).toBeNull()
  })

  it('propagates unpriced models from a matched cost budget (surface, not deny)', async () => {
    budgetsRows = [
      budgetRow({ id: 'c', unit: 'cost', currency: 'USD', enforcement: 'block', scope: {} }),
    ]
    spendQueue = [
      {
        rows: [
          { provider: 'openai', model: 'gpt-4o', priced: true, tokens: '1000', amount: '2.5' },
          { provider: 'anthropic', model: 'claude-x', priced: false, tokens: '500', amount: '0' },
        ],
      },
    ]

    const res = await authedCheck().expect(200)
    // Under-counted model is surfaced, not denied.
    expect(res.body.allowed).toBe(true)
    expect(res.body.unpriced).toEqual([{ provider: 'anthropic', model: 'claude-x' }])
    const logged = mockLogWarn.mock.calls.find(c => c[1] === 'budget_unpriced_usage')
    expect(logged).toBeDefined()
    expect(logged![0]).toMatchObject({ budgetId: 'c', unpriced: [{ model: 'claude-x' }] })
  })

  it('dedups unpriced pairs across multiple matched cost budgets', async () => {
    budgetsRows = [
      budgetRow({ id: 'c1', unit: 'cost', currency: 'USD', enforcement: 'warn', scope: {} }),
      budgetRow({ id: 'c2', unit: 'cost', currency: 'USD', enforcement: 'warn', scope: {} }),
    ]
    const unpricedRows = {
      rows: [{ provider: 'anthropic', model: 'claude-x', priced: false, tokens: '5', amount: '0' }],
    }
    spendQueue = [unpricedRows, unpricedRows]

    const res = await authedCheck().expect(200)
    expect(res.body.unpriced).toEqual([{ provider: 'anthropic', model: 'claude-x' }])
  })

  it('returns an empty unpriced list when everything is priced', async () => {
    budgetsRows = [budgetRow({ id: 'c', unit: 'cost', currency: 'USD', scope: {} })]
    spendQueue = [
      { rows: [{ provider: 'openai', model: 'gpt-4o', priced: true, tokens: '1', amount: '0.1' }] },
    ]
    const res = await authedCheck().expect(200)
    expect(res.body.unpriced).toEqual([])
  })

  it('denies (not bypass) when a block budget fails to compute spent', async () => {
    budgetsRows = [budgetRow({ enforcement: 'block', min_start_amount: '0' })]
    spendQueue = [new Error('db blew up')]

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reason).toBe('budget_eval_error')
    expect(mockLogError).toHaveBeenCalled()
  })

  it('degrades to team=null (200) when team resolution fails', async () => {
    budgetsRows = [] // global path; the request still succeeds without a team
    mockPoolQuery.mockImplementation((sql: unknown) => {
      const s = String(sql)
      if (/team_contexts/.test(s)) return Promise.reject(new Error('team query failed'))
      if (/FROM token_budgets/.test(s)) return Promise.resolve({ rows: budgetsRows, rowCount: 0 })
      if (/llm_model_prices/.test(s))
        return Promise.resolve({ rows: priceRows, rowCount: priceRows.length })
      return Promise.resolve({ rows: [{ spent: '0' }], rowCount: 1 })
    })
    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(mockLogWarn).toHaveBeenCalled()
  })

  it('returns price=null (200) when the price lookup fails', async () => {
    mockPoolQuery.mockImplementation((sql: unknown) => {
      const s = String(sql)
      if (/team_contexts/.test(s)) return Promise.resolve({ rows: teamRows, rowCount: 0 })
      if (/FROM token_budgets/.test(s)) return Promise.resolve({ rows: [], rowCount: 0 })
      if (/llm_model_prices/.test(s)) return Promise.reject(new Error('price query failed'))
      return Promise.resolve({ rows: [{ spent: '0' }], rowCount: 1 })
    })
    const res = await authedCheck().expect(200)
    expect(res.body.price).toBeNull()
    expect(mockLogWarn).toHaveBeenCalled()
  })

  it('caches budget definitions within the TTL (no re-query)', async () => {
    budgetsRows = [] // no matched budgets → no spend queries
    await authedCheck().expect(200)
    await authedCheck().expect(200)
    expect(budgetsListCalls).toBe(1)
  })
})

// ── P2b: danger-zone anti-race reservation (§0.8, §5.4) ─────────────────────
describe('POST /api/v1/internal/budgets/check — danger-zone reservation', () => {
  function dangerBudget(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return budgetRow({
      id: '33333333-3333-4333-8333-333333333333',
      enforcement: 'block',
      unit: 'tokens',
      limit_amount: '1000',
      min_start_amount: '0',
      max_task_amount: '100',
      ...overrides,
    })
  }

  it('does NOT reserve outside the danger zone (no transaction, no reservationId)', async () => {
    // remaining 1000 >= max_task_amount 100 → safe zone → pure P1 pull, no lock.
    budgetsRows = [dangerBudget()]
    spendQueue = [{ rows: [{ spent: '0' }] }]

    const res = await authedCheck().expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.reservationIds).toEqual([])
    expect(mockTxQuery).not.toHaveBeenCalled()
    expect(mockTxRelease).not.toHaveBeenCalled()
  })

  it('reserves inside the danger zone when allowed and returns the reservationId', async () => {
    // remaining 50 < max_task_amount 100 → danger; pending 0 → effective 50 >= 0.
    budgetsRows = [dangerBudget()]
    spendQueue = [{ rows: [{ spent: '950' }] }]
    pendingSum = '0'
    reservationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const res = await authedCheck({ ...BASE_REQUEST, task_ref: 'task-1' }).expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.reservationIds).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])

    // The reservation ran inside a transaction with the per-budget advisory lock,
    // the pending sum filtered on expires_at > NOW(), and it COMMITted.
    const txSql = mockTxQuery.mock.calls.map(c => String(c[0]))
    expect(txSql).toContain('BEGIN')
    expect(txSql).toContain('COMMIT')
    expect(txSql.some(s => /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(s))).toBe(true)
    expect(txSql.some(s => /SUM\(est_amount\)[\s\S]*expires_at > NOW\(\)/.test(s))).toBe(true)
    expect(txSql.some(s => /INSERT INTO budget_pending_reservations/.test(s))).toBe(true)
    expect(mockTxRelease).toHaveBeenCalledTimes(1)

    // The INSERT persists the caller's host_ref (bound to hostRefs[0]) so a later
    // release can be scoped to this host. host_ref is the 4th positional param.
    const insertCall = mockTxQuery.mock.calls.find(c =>
      /INSERT INTO budget_pending_reservations/.test(String(c[0]))
    )
    expect(String(insertCall![0])).toMatch(/budget_id, est_amount, task_ref, host_ref, expires_at/)
    expect((insertCall![1] as unknown[])[3]).toBe('trader')
  })

  it('excludes the current task_ref from the pending sum (no self double-count)', async () => {
    // A retried check of the SAME in-flight task must not count its own prior
    // reservation as a competitor — the pending SUM excludes it by task_ref.
    budgetsRows = [dangerBudget()]
    spendQueue = [{ rows: [{ spent: '950' }] }]

    await authedCheck({ ...BASE_REQUEST, task_ref: 'task-self' }).expect(200)

    const pendingCall = mockTxQuery.mock.calls.find(c => /SUM\(est_amount\)/.test(String(c[0])))
    expect(pendingCall).toBeDefined()
    expect(String(pendingCall![0])).toMatch(/task_ref IS DISTINCT FROM \$2/)
    expect((pendingCall![1] as unknown[])[1]).toBe('task-self')
  })

  it('does NOT add a self-exclusion clause when the check carries no task_ref', async () => {
    budgetsRows = [dangerBudget()]
    spendQueue = [{ rows: [{ spent: '950' }] }]

    await authedCheck(BASE_REQUEST).expect(200)

    const pendingCall = mockTxQuery.mock.calls.find(c => /SUM\(est_amount\)/.test(String(c[0])))
    expect(pendingCall).toBeDefined()
    expect(String(pendingCall![0])).not.toMatch(/task_ref IS DISTINCT FROM/)
    expect((pendingCall![1] as unknown[]).length).toBe(1)
  })

  it('denies a concurrent check that sees the prior reservation as pending', async () => {
    // P1 alone would allow (remaining 50 >= min_start 10), but pending 50 from a
    // concurrent task pushes effective_remaining to 0 < 10 → deny (no INSERT).
    budgetsRows = [dangerBudget({ min_start_amount: '10' })]
    spendQueue = [{ rows: [{ spent: '950' }] }]
    pendingSum = '50'

    const res = await authedCheck({ ...BASE_REQUEST, task_ref: 'task-2' }).expect(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reason).toBe('budget_exceeded')
    expect(res.body.reservationIds).toEqual([])
    const txSql = mockTxQuery.mock.calls.map(c => String(c[0]))
    expect(txSql.some(s => /INSERT INTO budget_pending_reservations/.test(s))).toBe(false)
  })

  it('degrades to the P1 decision (allow) when the reservation tx fails', async () => {
    // Danger zone, but the lock/insert blows up. P1 alone allows (remaining 50 >=
    // min_start 0) → allow without reservation; never a stricter-than-P1 deny.
    budgetsRows = [dangerBudget()]
    spendQueue = [{ rows: [{ spent: '950' }] }]
    txError = new Error('advisory lock failed')

    const res = await authedCheck({ ...BASE_REQUEST, task_ref: 'task-3' }).expect(200)
    expect(res.body.allowed).toBe(true)
    expect(res.body.reservationIds).toEqual([])
    expect(mockLogError).toHaveBeenCalled()
  })

  it('degrades to the P1 decision (deny) on tx failure when P1 would already deny', async () => {
    // Danger zone + tx failure, but P1 alone already denies (remaining 50 <
    // min_start 100). Fail-open of the reservation must NOT bypass that deny.
    budgetsRows = [dangerBudget({ min_start_amount: '100' })]
    spendQueue = [{ rows: [{ spent: '950' }] }]
    txError = new Error('insert failed')

    const res = await authedCheck({ ...BASE_REQUEST, task_ref: 'task-4' }).expect(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reason).toBe('budget_exceeded')
  })

  it('releases a reservation it created when another budget denies globally', async () => {
    // Budget A reserves in the danger zone (allows on its own); budget B denies
    // the request globally. The task will not run, so A's reservation must be
    // cleaned up here rather than leaking until TTL (robust to a lost mcp-host
    // release / a non-P2b client).
    const A = dangerBudget({ id: '33333333-3333-4333-8333-333333333333' })
    const B = budgetRow({
      id: '44444444-4444-4444-8444-444444444444',
      enforcement: 'block',
      unit: 'tokens',
      limit_amount: '1000',
      min_start_amount: '2000', // remaining 1000 < 2000 → deny
      max_task_amount: null, // safe zone → pure P1 deny, no reservation
    })
    budgetsRows = [A, B]
    spendQueue = [{ rows: [{ spent: '950' }] }, { rows: [{ spent: '0' }] }]
    reservationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    const res = await authedCheck({ ...BASE_REQUEST, task_ref: 'task-5' }).expect(200)
    expect(res.body.allowed).toBe(false)
    expect(res.body.reservationIds).toEqual([])
    const deleteCall = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(deleteCall).toBeDefined()
  })
})

// ── Claim-binding: the /check body must match the JWT's namespace/host/recipe ──
describe('POST /api/v1/internal/budgets/check — claim binding', () => {
  function sentinelToken(hostRefs: string[] = ['trader']): string {
    return issueMcpHostAccessJwt('mcp-host', 'standalone', hostRefs).token
  }
  function recipeToken(): string {
    return issueMcpHostAccessJwt('sandbox-recipes', 'r1', ['sandbox-recipes/r1']).token
  }
  function check(tok: string, body: Record<string, unknown>) {
    return request(app())
      .post('/api/v1/internal/budgets/check')
      .set('Authorization', `Bearer ${tok}`)
      .send(body)
  }

  it('allows a sentinel token whose body host_ref matches hostRefs[0]', async () => {
    budgetsRows = []
    await check(sentinelToken(['trader']), BASE_REQUEST).expect(200)
  })

  it('rejects a sentinel token whose body host_ref differs from hostRefs[0] (403)', async () => {
    const res = await check(sentinelToken(['trader']), {
      ...BASE_REQUEST,
      host_ref: 'someone-else',
    }).expect(403)
    expect(res.body.error).toBe('claim_binding_violation')
    expect(res.body.reason).toBe('sentinel_token_host_ref_mismatch')
    // Binding runs BEFORE any spend read.
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('rejects a sentinel token carrying a recipe_name (403)', async () => {
    const res = await check(sentinelToken(['trader']), {
      ...BASE_REQUEST,
      recipe_name: 'r1',
    }).expect(403)
    expect(res.body.reason).toBe('sentinel_token_with_recipe_name')
  })

  it('rejects a sentinel token with a workflow source_kind (403)', async () => {
    const res = await check(sentinelToken(['trader']), {
      ...BASE_REQUEST,
      source_kind: 'workflow',
    }).expect(403)
    expect(res.body.reason).toBe('sentinel_token_with_workflow_source')
  })

  it('allows a recipe token whose body matches recipe_name + workflow source + host_ref', async () => {
    budgetsRows = []
    await check(recipeToken(), {
      host_ref: 'sandbox-recipes/r1',
      context_ref: null,
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'workflow',
      recipe_name: 'r1',
    }).expect(200)
  })

  it('rejects a recipe token whose body recipe_name mismatches the claim (403)', async () => {
    const res = await check(recipeToken(), {
      host_ref: 'sandbox-recipes/r1',
      context_ref: null,
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'workflow',
      recipe_name: 'other-recipe',
    }).expect(403)
    expect(res.body.reason).toBe('recipe_token_recipe_name_mismatch')
  })

  it('rejects a recipe token with a non-workflow source_kind (403)', async () => {
    const res = await check(recipeToken(), {
      host_ref: 'sandbox-recipes/r1',
      context_ref: null,
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'desktop',
      recipe_name: 'r1',
    }).expect(403)
    expect(res.body.reason).toBe('recipe_token_non_workflow_source')
  })

  it('rejects a recipe token whose body host_ref differs from hostRefs[0] (403)', async () => {
    const res = await check(recipeToken(), {
      host_ref: 'trader',
      context_ref: null,
      provider: 'openai',
      model: 'gpt-4o',
      source_kind: 'workflow',
      recipe_name: 'r1',
    }).expect(403)
    expect(res.body.reason).toBe('recipe_token_host_ref_mismatch')
  })
})

describe('POST /api/v1/internal/budgets/release', () => {
  function release(body: Record<string, unknown>) {
    return request(app())
      .post('/api/v1/internal/budgets/release')
      .set('Authorization', `Bearer ${token()}`)
      .send(body)
  }

  it('rejects without an mcp-host JWT (401)', async () => {
    await request(app())
      .post('/api/v1/internal/budgets/release')
      .send({ task_ref: 'task-1', host_ref: 'trader' })
      .expect(401)
  })

  it('rejects a body with neither reservationId nor task_ref (400)', async () => {
    await release({ host_ref: 'trader' }).expect(400)
  })

  it('rejects a body missing host_ref (400)', async () => {
    await release({ task_ref: 'task-1' }).expect(400)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(del).toBeUndefined()
  })

  it('deletes by task_ref scoped to host_ref and reports the count', async () => {
    deleteRowCount = 2
    const res = await release({ task_ref: 'task-1', host_ref: 'trader' }).expect(200)
    expect(res.body.released).toBe(2)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(del).toBeDefined()
    expect(String(del![0])).toMatch(/task_ref = \$1 AND host_ref = \$2/)
    expect((del![1] as unknown[])[0]).toBe('task-1')
    expect((del![1] as unknown[])[1]).toBe('trader')
  })

  it('deletes by reservationId scoped to host_ref and reports the count', async () => {
    deleteRowCount = 1
    const res = await release({
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      host_ref: 'trader',
    }).expect(200)
    expect(res.body.released).toBe(1)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(String(del![0])).toMatch(/id = \$1 AND host_ref = \$2/)
    expect((del![1] as unknown[])[1]).toBe('trader')
  })

  it('rejects a malformed (non-UUID) reservationId with 400 (no DB hit)', async () => {
    await release({ reservationId: 'res-1', host_ref: 'trader' }).expect(400)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(del).toBeUndefined()
  })

  it('rejects a host_ref that mismatches the token binding (403, no DB hit)', async () => {
    const res = await release({ task_ref: 'task-1', host_ref: 'someone-else' }).expect(403)
    expect(res.body.error).toBe('claim_binding_violation')
    expect(res.body.reason).toBe('host_ref_mismatch')
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(del).toBeUndefined()
  })

  it('rejects a token from an unrecognized namespace (403)', async () => {
    const stranger = issueMcpHostAccessJwt('other-ns', 'x', ['trader']).token
    const res = await request(app())
      .post('/api/v1/internal/budgets/release')
      .set('Authorization', `Bearer ${stranger}`)
      .send({ task_ref: 'task-1', host_ref: 'trader' })
      .expect(403)
    expect(res.body.reason).toBe('unrecognized_token_binding')
  })

  it('trims host_ref so the binding and the DELETE use the same canonical value', async () => {
    // A whitespace-padded host_ref must pass the binding AND filter the DELETE on
    // the trimmed value (the same normalized form /check persisted) — never pass
    // the binding while matching 0 rows.
    deleteRowCount = 1
    const res = await release({ task_ref: 'task-1', host_ref: '  trader  ' }).expect(200)
    expect(res.body.released).toBe(1)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect((del![1] as unknown[])[1]).toBe('trader')
  })

  it('rejects a whitespace-only host_ref (400)', async () => {
    await release({ task_ref: 'task-1', host_ref: '   ' }).expect(400)
  })

  it('is idempotent: releasing an already-gone reservation returns 200 with 0', async () => {
    deleteRowCount = 0
    const res = await release({ task_ref: 'gone', host_ref: 'trader' }).expect(200)
    expect(res.body.released).toBe(0)
  })
})

describe('sweepExpiredReservations', () => {
  it('deletes rows with expires_at <= NOW() and returns the count', async () => {
    deleteRowCount = 3
    const deleted = await sweepExpiredReservations()
    expect(deleted).toBe(3)
    const del = mockPoolQuery.mock.calls.find(c =>
      /DELETE FROM budget_pending_reservations/.test(String(c[0]))
    )
    expect(del).toBeDefined()
    expect(String(del![0])).toMatch(/expires_at <= NOW\(\)/)
  })
})
