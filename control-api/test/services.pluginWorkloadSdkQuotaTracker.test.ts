import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import { consumeQuota } from '../src/services/pluginWorkloadSdkQuotaTracker.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    resolveQuotaPeriodStart: vi.fn(),
    consumePeriodQuota: vi.fn(),
  }
})

const runPeriod = new Date('2026-06-10T12:00:00.000Z')

const grant = (
  overrides: Partial<sdkDb.PluginWorkloadSdkGrant> = {}
): sdkDb.PluginWorkloadSdkGrant => ({
  id: 'g1',
  recipeNamespace: 'sandbox-recipes',
  recipeName: 'sdk-recipe',
  capabilityFamily: 'promptBridge',
  provider: 'zai',
  allowedModels: [],
  allowedEventTypes: [],
  allowedTargetRefs: [],
  allowedUserRefs: [],
  allowedCallers: ['api'],
  quotaLimits: { maxRequestsPerRun: 10 },
  modelPolicies: {},
  promptTargets: [],
  defaultTargetRef: null,
  policyState: 'active',
  policyRevision: 0,
  createdAt: '',
  updatedAt: '',
  ...overrides,
})

describe('consumeQuota', () => {
  beforeEach(() => {
    vi.mocked(sdkDb.resolveQuotaPeriodStart).mockReset()
    vi.mocked(sdkDb.consumePeriodQuota).mockReset()
  })

  it('folds eager-period usage into the atomic run-cap consume (no TOCTOU read)', async () => {
    // For an active run period, the eager subtraction is now resolved INSIDE
    // consumePeriodQuota (foldEagerUsage=true) — a single atomic statement,
    // not a separate read-then-consume.
    vi.mocked(sdkDb.resolveQuotaPeriodStart).mockResolvedValue(runPeriod)
    vi.mocked(sdkDb.consumePeriodQuota).mockResolvedValue(true)

    const result = await consumeQuota('sandbox-recipes', 'sdk-recipe', 'promptBridge', grant())

    expect(result).toEqual({ ok: true })
    expect(sdkDb.consumePeriodQuota).toHaveBeenCalledWith(
      'sandbox-recipes',
      'sdk-recipe',
      'promptBridge',
      10,
      runPeriod,
      true
    )
  })

  it('does not fold eager usage when consuming the eager sentinel period itself', async () => {
    vi.mocked(sdkDb.resolveQuotaPeriodStart).mockResolvedValue(
      sdkDb.PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD
    )
    vi.mocked(sdkDb.consumePeriodQuota).mockResolvedValue(true)

    const result = await consumeQuota('sandbox-recipes', 'sdk-recipe', 'promptBridge', grant())

    expect(result).toEqual({ ok: true })
    expect(sdkDb.consumePeriodQuota).toHaveBeenCalledWith(
      'sandbox-recipes',
      'sdk-recipe',
      'promptBridge',
      10,
      sdkDb.PLUGIN_WORKLOAD_SDK_EAGER_QUOTA_PERIOD,
      false
    )
  })

  it('denies when the atomic consume reports the run cap is exhausted', async () => {
    // The DB statement returns false when runCount+1+eagerUsed > limit. The
    // exhaustion decision now lives entirely in the single atomic statement,
    // so concurrent callers cannot both pass a remaining-1 budget.
    vi.mocked(sdkDb.resolveQuotaPeriodStart).mockResolvedValue(runPeriod)
    vi.mocked(sdkDb.consumePeriodQuota).mockResolvedValue(false)

    const result = await consumeQuota('sandbox-recipes', 'sdk-recipe', 'promptBridge', grant())

    expect(result).toMatchObject({ ok: false, error: 'quota_exceeded' })
  })

  it('is a no-op success when the grant declares no per-run cap', async () => {
    const result = await consumeQuota(
      'sandbox-recipes',
      'sdk-recipe',
      'promptBridge',
      grant({ quotaLimits: {} })
    )
    expect(result).toEqual({ ok: true })
    expect(sdkDb.consumePeriodQuota).not.toHaveBeenCalled()
  })
})
