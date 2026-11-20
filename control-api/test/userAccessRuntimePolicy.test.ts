import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assemblePr2Readiness: vi.fn(),
  withAccessDatabaseTransaction: vi.fn(),
}))

vi.mock('../src/services/access/pr2ReadinessEvidence.js', () => ({
  assemblePr2Readiness: mocks.assemblePr2Readiness,
}))
vi.mock('../src/services/access/accessDatabaseQuery.js', () => ({
  withAccessDatabaseTransaction: mocks.withAccessDatabaseTransaction,
}))

const FLAG_NAMES = [
  'CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2',
  'CONTROL_API_USER_ACCESS_RPC_DELEGATION_V2',
] as const

async function loadRuntimePolicy(flags: Partial<Record<(typeof FLAG_NAMES)[number], string>>) {
  for (const name of FLAG_NAMES) {
    if (flags[name] === undefined) delete process.env[name]
    else process.env[name] = flags[name]
  }
  vi.resetModules()
  const policy = await import('../src/services/access/userAccessPolicy.js')
  const runtime = await import('../src/services/access/userAccessRuntimePolicy.js')
  const budgets = await import('../src/services/access/accessExecutionBudget.js')
  return { policy, runtime, budgets }
}

async function loadActionContextV2() {
  const loaded = await loadRuntimePolicy({ CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2: 'true' })
  expect(loaded.policy.configuredUserAccessIntent.actionContextV2).toBe(true)
  const readyHops = Object.fromEntries(
    Object.keys(loaded.policy.reconstructionReadiness.pr2RuntimeHops).map(hop => [hop, 'ready'])
  )
  mocks.assemblePr2Readiness.mockResolvedValue(readyHops)
  // PR 1 readiness keeps action context unavailable, so compilation still
  // refuses the configured intent after reading the current evidence.
  const unavailable = new loaded.policy.UserAccessPolicyConfigurationError(
    'action_context_unavailable'
  )
  return { ...loaded, unavailable }
}

const T0 = 1_900_000_000_000

describe('resolveEffectiveUserAccessPolicy caching (X4, C12 P5b)', () => {
  const savedFlags = Object.fromEntries(FLAG_NAMES.map(name => [name, process.env[name]]))

  beforeEach(() => {
    mocks.assemblePr2Readiness.mockReset()
    mocks.withAccessDatabaseTransaction.mockReset()
    mocks.withAccessDatabaseTransaction.mockImplementation(
      async (_budget: unknown, work: (db: unknown) => Promise<unknown>) => work({ query: vi.fn() })
    )
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const name of FLAG_NAMES) {
      if (savedFlags[name] === undefined) delete process.env[name]
      else process.env[name] = savedFlags[name]
    }
    vi.resetModules()
  })

  it('compiles the configured policy once and reads no PR 2 readiness with the flags off', async () => {
    const { policy, runtime } = await loadRuntimePolicy({})
    expect(policy.configuredUserAccessIntent.actionContextV2).toBe(false)
    expect(policy.configuredUserAccessIntent.rpcDelegationV2).toBe(false)

    const first = await runtime.resolveEffectiveUserAccessPolicy()
    const second = await runtime.resolveEffectiveUserAccessPolicy()

    // One compiled object for both calls: the configured policy was compiled once.
    expect(second).toBe(first)
    expect(first).toEqual(
      policy.compileUserAccessPolicy(
        policy.configuredUserAccessIntent,
        policy.reconstructionReadiness
      )
    )
    expect(first.actionContextV2).toBe(false)
    expect(first.rpcDelegationV2).toBe(false)
    expect(mocks.withAccessDatabaseTransaction).not.toHaveBeenCalled()
    expect(mocks.assemblePr2Readiness).not.toHaveBeenCalled()
  })

  it('reuses one readiness read for 1 s when action context v2 is configured, then reads again', async () => {
    const { runtime, unavailable } = await loadActionContextV2()

    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(unavailable)
    vi.setSystemTime(T0 + 999)
    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(unavailable)

    // Liveness: both calls compiled after a successful readiness read (the
    // compile error), and one read served both.
    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(1)
    expect(typeof mocks.assemblePr2Readiness.mock.calls[0]![1]).toBe('string')

    vi.setSystemTime(T0 + 1_000)
    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(unavailable)

    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(2)
  })

  it('reuses one readiness read for 1 s when rpc delegation v2 is configured', async () => {
    const { policy, runtime } = await loadRuntimePolicy({
      CONTROL_API_USER_ACCESS_RPC_DELEGATION_V2: 'true',
    })
    expect(policy.configuredUserAccessIntent.rpcDelegationV2).toBe(true)
    mocks.assemblePr2Readiness.mockResolvedValue(policy.reconstructionReadiness.pr2RuntimeHops)

    for (let call = 0; call < 2; call += 1) {
      await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(
        new policy.UserAccessPolicyConfigurationError('rpc_v2_requires_action_context')
      )
    }

    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(1)
  })

  it('never caches a failed read: the next call reads again', async () => {
    const { runtime, unavailable } = await loadActionContextV2()
    const outage = new Error('readiness database unavailable')
    mocks.withAccessDatabaseTransaction.mockRejectedValueOnce(outage)

    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toBe(outage)
    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(unavailable)

    // Same instant, two reads: the failure was not served from the cache.
    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(1)
  })

  it('shares one read between concurrent cold calls', async () => {
    const { runtime, unavailable } = await loadActionContextV2()
    let finishRead!: () => void
    mocks.withAccessDatabaseTransaction.mockImplementationOnce(
      async (_budget: unknown, work: (db: unknown) => Promise<unknown>) => {
        await new Promise<void>(resolve => (finishRead = resolve))
        return work({ query: vi.fn() })
      }
    )

    const calls = Array.from({ length: 10 }, () =>
      runtime.resolveEffectiveUserAccessPolicy().then(
        () => 'resolved',
        (error: unknown) => error
      )
    )
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
    finishRead()
    const outcomes = await Promise.all(calls)

    expect(outcomes).toHaveLength(10)
    for (const outcome of outcomes) expect(outcome).toEqual(unavailable)
    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(1)
  })

  it('bounds a caller by its own budget without cancelling the shared read', async () => {
    const { runtime, budgets, unavailable } = await loadActionContextV2()
    let finishRead!: () => void
    let readBudget: { signal: AbortSignal } | undefined
    mocks.withAccessDatabaseTransaction.mockImplementationOnce(
      async (budget: { signal: AbortSignal }, work: (db: unknown) => Promise<unknown>) => {
        readBudget = budget
        await new Promise<void>(resolve => (finishRead = resolve))
        return work({ query: vi.fn() })
      }
    )
    const requestBudget = budgets.AccessExecutionBudget.create('action')

    const waiting = runtime
      .resolveEffectiveUserAccessPolicy({ budget: requestBudget })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
    requestBudget.cancel()
    const cancelled = await waiting

    expect(cancelled).toBeInstanceOf(budgets.AccessExecutionCancelledError)
    // The read runs under its own budget, which the caller's cancel left alone.
    expect(readBudget).toBeDefined()
    expect(readBudget).not.toBe(requestBudget)
    expect(readBudget!.signal.aborted).toBe(false)

    finishRead()
    await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(unavailable)
    // The next caller got the shared read's result: still one read.
    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(1)
    requestBudget.close()
  })
})
