/**
 * #1043 — the continuation timing knobs must stop the Host at config load when
 * they are set to anything that is not a positive safe integer. A silent
 * `parseInt` fallback would shorten or extend the resumable window, the claim
 * lease and the inline-byte TTL with no signal at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const KNOBS = [
  'CLERUM_MODEL_STEP_CHECKPOINT_TTL_HOURS',
  'CLERUM_MODEL_STEP_CLAIM_LEASE_SECONDS',
  'CLERUM_MODEL_STEP_ATTACHMENT_TTL_MINUTES',
] as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('model-step checkpoint timing config', () => {
  it.each(
    KNOBS.flatMap(name =>
      ['abc', '-1', '0', '', '1.5', '2147483648'].map(value => ({ name, value }))
    )
  )('rejects $name=$value at config load', async ({ name, value }) => {
    vi.resetModules()
    vi.stubEnv(name, value)
    await expect(import('./config')).rejects.toThrow(name)

    // Positive liveness witness: with the same knob set to a valid value the
    // module loads and every converted window stays positive.
    vi.resetModules()
    vi.stubEnv(name, '1')
    const { config } = await import('./config')
    expect(config.modelStepCheckpointTtlMs).toBeGreaterThan(0)
    expect(config.modelStepClaimLeaseMs).toBeGreaterThan(0)
    expect(config.modelStepAttachmentTtlMs).toBeGreaterThan(0)
  })

  it('keeps the documented defaults only while the variables are absent', async () => {
    vi.resetModules()
    for (const name of KNOBS) vi.stubEnv(name, undefined)
    const { config } = await import('./config')
    expect(config.modelStepCheckpointTtlMs).toBe(168 * 3_600_000)
    expect(config.modelStepClaimLeaseMs).toBe(300_000)
    expect(config.modelStepAttachmentTtlMs).toBe(3_600_000)
  })

  it('converts an explicit valid override into milliseconds', async () => {
    vi.resetModules()
    vi.stubEnv('CLERUM_MODEL_STEP_CHECKPOINT_TTL_HOURS', '2')
    vi.stubEnv('CLERUM_MODEL_STEP_CLAIM_LEASE_SECONDS', '45')
    vi.stubEnv('CLERUM_MODEL_STEP_ATTACHMENT_TTL_MINUTES', '5')
    const { config } = await import('./config')
    expect(config.modelStepCheckpointTtlMs).toBe(7_200_000)
    expect(config.modelStepClaimLeaseMs).toBe(45_000)
    expect(config.modelStepAttachmentTtlMs).toBe(300_000)
  })

  it('rejects a claim lease whose renewal timer would overflow and accepts the largest safe one', async () => {
    // The continuation renews every third of the lease (setInterval), so the
    // knob must keep `claimLeaseMs / 3` at or below Node's maximum timer delay.
    vi.resetModules()
    vi.stubEnv('CLERUM_MODEL_STEP_CLAIM_LEASE_SECONDS', '6442451')
    await expect(import('./config')).rejects.toThrow('CLERUM_MODEL_STEP_CLAIM_LEASE_SECONDS')

    // Positive witness: the largest whole second that still fits loads and the
    // derived renewal interval stays inside the timer bound.
    vi.resetModules()
    vi.stubEnv('CLERUM_MODEL_STEP_CLAIM_LEASE_SECONDS', '6442450')
    const { config } = await import('./config')
    expect(config.modelStepClaimLeaseMs).toBe(6_442_450_000)
    expect(config.modelStepClaimLeaseMs / 3).toBeLessThanOrEqual(2_147_483_647)
  })
})
