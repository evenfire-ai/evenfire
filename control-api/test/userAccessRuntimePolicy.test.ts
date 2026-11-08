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
  return { policy, runtime }
}

describe('resolveEffectiveUserAccessPolicy caching (X4)', () => {
  const savedFlags = Object.fromEntries(FLAG_NAMES.map(name => [name, process.env[name]]))

  beforeEach(() => {
    mocks.assemblePr2Readiness.mockReset()
    mocks.withAccessDatabaseTransaction.mockReset()
    mocks.withAccessDatabaseTransaction.mockImplementation(
      async (_budget: unknown, work: (db: unknown) => Promise<unknown>) => work({ query: vi.fn() })
    )
  })

  afterEach(() => {
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

  it('reads PR 2 readiness on every call when action context v2 is configured', async () => {
    const { policy, runtime } = await loadRuntimePolicy({
      CONTROL_API_USER_ACCESS_ACTION_CONTEXT_V2: 'true',
    })
    expect(policy.configuredUserAccessIntent.actionContextV2).toBe(true)
    const readyHops = Object.fromEntries(
      Object.keys(policy.reconstructionReadiness.pr2RuntimeHops).map(hop => [hop, 'ready'])
    )
    mocks.assemblePr2Readiness.mockResolvedValue(readyHops)

    // PR 1 readiness keeps action context unavailable, so compilation still
    // refuses the configured intent after reading the current evidence.
    for (let call = 0; call < 2; call += 1) {
      await expect(runtime.resolveEffectiveUserAccessPolicy()).rejects.toThrowError(
        new policy.UserAccessPolicyConfigurationError('action_context_unavailable')
      )
    }

    expect(mocks.withAccessDatabaseTransaction).toHaveBeenCalledTimes(2)
    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(2)
    for (const [, environmentId] of mocks.assemblePr2Readiness.mock.calls) {
      expect(typeof environmentId).toBe('string')
    }
  })

  it('reads PR 2 readiness on every call when rpc delegation v2 is configured', async () => {
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

    expect(mocks.assemblePr2Readiness).toHaveBeenCalledTimes(2)
  })
})
