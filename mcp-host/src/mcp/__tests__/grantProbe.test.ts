import { describe, expect, it, vi } from 'vitest'
import {
  type GrantExistsQuery,
  type GrantExistsResult,
  checkGrantExistence,
} from '../grantExistenceClient'
import {
  type GrantExistenceChecker,
  type McpCatalogBootstrapConfig,
  createGrantProbe,
} from '../grantProbe'

function makeConfig(overrides: Partial<McpCatalogBootstrapConfig> = {}): McpCatalogBootstrapConfig {
  return {
    enabled: true,
    waitBudgetMs: 4000,
    probeTimeoutMs: 2000,
    connectTimeoutMs: 8000,
    negativeTtlMs: 15000,
    failureTtlMs: 60000,
    probesPerMin: 20,
    backoffMs: 30000,
    ...overrides,
  }
}

function coord(mcpServerName: string, userId?: string): string {
  return JSON.stringify([mcpServerName, userId ?? null])
}

/**
 * T1 — the checker is the REAL `checkGrantExistence` served by a fake gateway
 * whose grant table is a plain Set of coordinates. `exists` is therefore parsed
 * from a real `{results}` body by the production client, never hand-authored as a
 * `GrantExistsResult`. The gateway echoes the query coordinates exactly as
 * control-api does so the client correlates by tuple.
 */
function checkerBackedByGrants(grants: Set<string>): {
  checker: GrantExistenceChecker
  posts: () => number
} {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { queries: GrantExistsQuery[] }
    const results: GrantExistsResult[] = body.queries.map(q => ({
      mcpServerName: q.mcpServerName,
      ...(q.userId !== undefined ? { userId: q.userId } : {}),
      exists: grants.has(coord(q.mcpServerName, q.userId)),
    }))
    return { status: 200, json: async () => ({ results }) } as unknown as Response
  })
  const checker: GrantExistenceChecker = (queries, opts) =>
    checkGrantExistence(
      {
        gatewayUrl: () => 'http://gw',
        controlToken: () => 'ctl',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: opts.timeoutMs,
      },
      queries
    )
  return { checker, posts: () => fetchImpl.mock.calls.length }
}

/** Drive one bootstrap-style pass for a single coordinate: plan → execute → record. */
async function bootstrapOnce(
  probe: ReturnType<typeof createGrantProbe>,
  query: GrantExistsQuery
): Promise<'asked-present' | 'asked-absent' | 'skipped'> {
  const plan = probe.plan([query])
  if (plan.ask.length === 0) return 'skipped'
  const results = await probe.execute(plan.ask)
  const key = coord(query.mcpServerName, query.userId)
  const match = results.find(r => coord(r.mcpServerName, r.userId) === key)
  if (match?.exists) {
    probe.recordAdmissionOk(key)
    return 'asked-present'
  }
  probe.recordAbsent(key)
  return 'asked-absent'
}

describe('grantProbe — per-minute request budget (invariant 8)', () => {
  it('with probesPerMin=2, three grant-less users in the same minute cost 2 POSTs; the third is budget-exhausted; the next minute resumes', async () => {
    let clock = 1_000_000
    const { checker, posts } = checkerBackedByGrants(new Set()) // nobody has a grant
    const probe = createGrantProbe(checker, makeConfig({ probesPerMin: 2 }), () => clock)

    const users = ['u1', 'u2', 'u3'].map(u => ({ mcpServerName: 'calendar', userId: u }))

    // First two users each cost one POST (each is a distinct coordinate/batch).
    expect(await bootstrapOnce(probe, users[0])).toBe('asked-absent')
    expect(await bootstrapOnce(probe, users[1])).toBe('asked-absent')

    // The third user is over the local budget for this window: no POST at all.
    const third = probe.plan([users[2]])
    expect(third.ask).toHaveLength(0)
    expect(third.budgetExhausted).toEqual([coord('calendar', 'u3')])
    expect(posts()).toBe(2)

    // Next minute: the window resets and u3 (never absent-cached) is probed.
    clock += 60_000
    expect(await bootstrapOnce(probe, users[2])).toBe('asked-absent')
    expect(posts()).toBe(3)
  })
})

describe('grantProbe — negative cache TTL (invariant 9)', () => {
  it('an exists:false result suppresses a second probe until negativeTtlMs elapses', async () => {
    let clock = 5_000_000
    const { checker, posts } = checkerBackedByGrants(new Set())
    const probe = createGrantProbe(checker, makeConfig({ negativeTtlMs: 15_000 }), () => clock)
    const query = { mcpServerName: 'gh', userId: 'alice' }

    // First probe: absent → cached negative.
    expect(await bootstrapOnce(probe, query)).toBe('asked-absent')
    expect(posts()).toBe(1)

    // Before the TTL: no probe, reported as absent-cached.
    clock += 14_999
    const cached = probe.plan([query])
    expect(cached.ask).toHaveLength(0)
    expect(cached.absentCached).toEqual([coord('gh', 'alice')])
    expect(posts()).toBe(1)

    // After the TTL: probed again.
    clock += 2
    expect(await bootstrapOnce(probe, query)).toBe('asked-absent')
    expect(posts()).toBe(2)
  })
})

describe('grantProbe — supporting policy behaviors', () => {
  it('deduplicates a coordinate already in flight (P1)', () => {
    const probe = createGrantProbe(
      async () => [],
      makeConfig(),
      () => 1
    )
    const query = { mcpServerName: 'gh', userId: 'alice' }
    const first = probe.plan([query])
    expect(first.ask).toHaveLength(1)
    // Not yet executed: the coordinate stays in flight, so a concurrent plan skips it.
    const second = probe.plan([query])
    expect(second.ask).toHaveLength(0)
    expect(second.inFlight).toEqual([coord('gh', 'alice')])
  })

  it('a checker throw enters global backoff and suppresses the next probe (P4)', async () => {
    let clock = 2_000_000
    const checker = vi.fn(async () => {
      throw new Error('gateway down')
    })
    const probe = createGrantProbe(checker, makeConfig({ backoffMs: 30_000 }), () => clock)
    const query = { mcpServerName: 'gh' }

    const plan = probe.plan([query])
    await expect(probe.execute(plan.ask)).rejects.toThrow(/gateway down/)
    // In-flight was released so a retry is possible once the backoff clears.
    expect(probe.snapshot().inFlight).toBe(0)

    // Within backoff: paused, no checker call.
    clock += 29_999
    const paused = probe.plan([query])
    expect(paused.ask).toHaveLength(0)
    expect(paused.budgetExhausted).toEqual([coord('gh')])

    // After backoff: probes again.
    clock += 2
    const resumed = probe.plan([query])
    expect(resumed.ask).toHaveLength(1)
    expect(checker).toHaveBeenCalledTimes(1)
  })

  it('probeOne returns present/absent/unknown from the injected checker', async () => {
    const grants = new Set([coord('slack')])
    const { checker } = checkerBackedByGrants(grants)
    const probe = createGrantProbe(checker, makeConfig(), () => 1)

    expect(await probe.probeOne({ mcpServerName: 'slack' })).toBe('present')
    expect(await probe.probeOne({ mcpServerName: 'notion' })).toBe('absent')
  })

  it('probeOne is unknown (not absent) when the endpoint throws — fail-open', async () => {
    const probe = createGrantProbe(
      async () => {
        throw new Error('boom')
      },
      makeConfig(),
      () => 1
    )
    expect(await probe.probeOne({ mcpServerName: 'slack' })).toBe('unknown')
  })

  it('caps the planned ask to the remaining budget so a huge candidate set cannot exceed probesPerMin requests', async () => {
    const checker = vi.fn(async (queries: GrantExistsQuery[]) =>
      queries.map(q => ({ mcpServerName: q.mcpServerName, userId: q.userId, exists: false }))
    )
    const probe = createGrantProbe(checker, makeConfig({ probesPerMin: 2 }), () => 1)
    // 2500 distinct coordinates with a 2-unit budget: at ≤1000/chunk the plan may
    // authorize at most 2000, so executing the ask stays within the 2 requests the
    // budget accounts for — the remaining 500 spill to budgetExhausted.
    const queries: GrantExistsQuery[] = Array.from({ length: 2500 }, (_, i) => ({
      mcpServerName: `s${i}`,
    }))
    const plan = probe.plan(queries)
    expect(plan.ask).toHaveLength(2000)
    expect(plan.budgetExhausted).toHaveLength(500)
    await probe.execute(plan.ask)
    expect(checker).toHaveBeenCalledTimes(2)
    expect(probe.snapshot().bucketUsed).toBe(2)
  })

  it('execute chunks the ask into ≤MAX_EXISTS_BATCH batches and charges one budget unit per batch', async () => {
    const checker = vi.fn(async (queries: GrantExistsQuery[]) =>
      queries.map(q => ({ mcpServerName: q.mcpServerName, userId: q.userId, exists: false }))
    )
    const probe = createGrantProbe(checker, makeConfig({ probesPerMin: 5 }), () => 1)
    const ask: GrantExistsQuery[] = Array.from({ length: 1500 }, (_, i) => ({
      mcpServerName: `s${i}`,
    }))
    await probe.execute(ask)
    // 1500 coordinates → two HTTP requests → two budget units.
    expect(checker).toHaveBeenCalledTimes(2)
    expect(probe.snapshot().bucketUsed).toBe(2)
  })
})
