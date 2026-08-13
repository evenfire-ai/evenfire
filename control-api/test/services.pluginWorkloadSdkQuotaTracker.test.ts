import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import { checkRateLimit } from '../src/services/pluginWorkloadSdkQuotaTracker.js'

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
    countRecentInvocations: vi.fn(),
  }
})

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
  revocationId: null,
  createdAt: '',
  updatedAt: '',
  ...overrides,
})

// The former `consumeQuota` describe block was removed with the function
// itself (issue #348, plan §1.5 — deleted outright, not stubbed, so any
// missed production caller is a compile error).

// ─── Issue #348 (plan D3) — platform per-minute defaults ─────────────────
//
// RED-FIRST (plan §6.6): these tests assert the POST-change ceilings
// (promptBridge 180/min, clientNotifications 200/min, sourced from
// config.pluginSdkPromptBridgeRlPerMin / config.pluginSdkNotificationsRlPerMin).
// Against pre-change code the hardcoded defaults are 60/120, so the
// exactly-at-the-ceiling cases FAIL until Phase 1 step 1.4 lands. Do not
// weaken them to pass early.
//
// Plan D3.3 (per-run leg inert): after Phase 1, `consumeQuota` is DELETED
// (decision §3.2 — delete, don't stub), so a mocked-db assertion here would
// have no symbol to call. The per-run-inert behavior is asserted end-to-end
// in the real-Postgres regression suite instead
// (test/pluginWorkloadSdkSteplessQuota.realPostgres.integration.test.ts,
// plan D4 Tests 1 and 3), where the enforcement path itself — not a mock —
// proves the per-run cap never denies and never resets anything.
describe('checkRateLimit — platform per-minute rate limits (issue #348)', () => {
  beforeEach(() => {
    vi.mocked(sdkDb.countRecentInvocations).mockReset()
  })

  it('allows promptBridge at exactly 180/minute and denies at 181 (platform default)', async () => {
    const noOverrides = grant({ quotaLimits: {} })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(180)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', noOverrides)
    ).resolves.toEqual({ ok: true })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(181)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', noOverrides)
    ).resolves.toMatchObject({
      ok: false,
      error: 'quota_exceeded',
      retryable: false,
      message: expect.stringContaining('180/minute'),
    })
  })

  it('allows clientNotifications at exactly 200/minute and denies at 201, narrowed to the eventType', async () => {
    const noOverrides = grant({ capabilityFamily: 'clientNotifications', quotaLimits: {} })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(200)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'clientNotifications', noOverrides, {
        eventType: 'lead.followup.due',
      })
    ).resolves.toEqual({ ok: true })
    expect(sdkDb.countRecentInvocations).toHaveBeenCalledWith(
      'sandbox-recipes',
      'sdk-recipe',
      'clientNotifications',
      { detail: 'lead.followup.due' }
    )

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(201)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'clientNotifications', noOverrides, {
        eventType: 'lead.followup.due',
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'quota_exceeded',
      retryable: false,
      message: expect.stringContaining('200/minute'),
    })
  })

  it('frees the recipe once the trailing window drains (deny at 181, allow at 0)', async () => {
    const noOverrides = grant({ quotaLimits: {} })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(181)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', noOverrides)
    ).resolves.toMatchObject({ ok: false, error: 'quota_exceeded' })

    // The window is derived from the invocation audit trail (Postgres now()),
    // so a drained window is simply a lower count — no counter to reset.
    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(0)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', noOverrides)
    ).resolves.toEqual({ ok: true })
  })

  it('lets a grant-level maxInvocationsPerMinute override win over the platform default', async () => {
    // Decision §3.1: ENV replaces only the hardcoded fallback constants — a
    // grant override still wins (`grant value ?? config default`).
    const withOverride = grant({ quotaLimits: { maxInvocationsPerMinute: 5 } })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(5)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', withOverride)
    ).resolves.toEqual({ ok: true })

    vi.mocked(sdkDb.countRecentInvocations).mockResolvedValue(6)
    await expect(
      checkRateLimit('sandbox-recipes', 'sdk-recipe', 'promptBridge', withOverride)
    ).resolves.toMatchObject({
      ok: false,
      error: 'quota_exceeded',
      message: expect.stringContaining('5/minute'),
    })
  })
})
