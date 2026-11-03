import { describe, expect, it } from 'vitest'
import {
  MODEL_STEP_AUTO_RETRIES_DEFAULT,
  MODEL_STEP_AUTO_RETRIES_MAX,
  MODEL_STEP_RETRY_DEADLINE_MS,
  MODEL_STEP_RETRY_DELAYS_MS,
  modelStepRetryDelayMs,
} from '../modelStepRetrySchedule'

describe('model-step retry schedule (#1043)', () => {
  it('S1: freezes the nominal sequence, maximum, default and deadline', () => {
    expect(MODEL_STEP_RETRY_DELAYS_MS).toEqual([500, 1500, 3000, 6000, 12000])
    expect(Object.isFrozen(MODEL_STEP_RETRY_DELAYS_MS)).toBe(true)
    expect(MODEL_STEP_AUTO_RETRIES_MAX).toBe(5)
    expect(MODEL_STEP_AUTO_RETRIES_MAX).toBe(MODEL_STEP_RETRY_DELAYS_MS.length)
    expect(MODEL_STEP_AUTO_RETRIES_DEFAULT).toBe(3)
    expect(MODEL_STEP_RETRY_DEADLINE_MS).toBe(60_000)
  })

  it.each([5, -1, 1.5, NaN])('S1: rejects retry index %s', index => {
    expect(() => modelStepRetryDelayMs(index, () => 0.5)).toThrow(RangeError)
    expect(modelStepRetryDelayMs(0, () => 0.5)).toBe(450)
  })

  it('S1j: jitter only shortens each wait and uses the supplied random value', () => {
    expect(MODEL_STEP_RETRY_DELAYS_MS.map((_, i) => modelStepRetryDelayMs(i, () => 0))).toEqual([
      400, 1200, 2400, 4800, 9600,
    ])
    expect(MODEL_STEP_RETRY_DELAYS_MS.map((_, i) => modelStepRetryDelayMs(i, () => 0.5))).toEqual([
      450, 1350, 2700, 5400, 10800,
    ])
    for (let i = 0; i < MODEL_STEP_AUTO_RETRIES_MAX; i++) {
      const delayMs = modelStepRetryDelayMs(i, () => 1 - Number.EPSILON / 2)
      expect(delayMs).toBeLessThanOrEqual(MODEL_STEP_RETRY_DELAYS_MS[i]!)
      expect(delayMs).toBeGreaterThanOrEqual(0.8 * MODEL_STEP_RETRY_DELAYS_MS[i]!)
    }
  })

  it.each([1, -0.1, NaN])('S1j: rejects random value %s', value => {
    expect(() => modelStepRetryDelayMs(0, () => value)).toThrow(RangeError)
    expect(modelStepRetryDelayMs(0, () => 0.5)).toBe(450)
  })
})
