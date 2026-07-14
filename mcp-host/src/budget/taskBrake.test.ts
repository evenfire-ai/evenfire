import { describe, expect, it } from 'vitest'
import {
  type TaskBrakeConfig,
  type TaskTokenBaseline,
  evaluateTaskBrake,
  snapshotTaskTokenBaseline,
} from './taskBrake'

const ZERO_BASELINE: TaskTokenBaseline = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
}

const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, currency: 'USD' }

function brake(overrides: Partial<TaskBrakeConfig> = {}): TaskBrakeConfig {
  return { baseline: ZERO_BASELINE, ...overrides }
}

describe('snapshotTaskTokenBaseline', () => {
  it('captures the four counters, defaulting absent ones to 0', () => {
    expect(snapshotTaskTokenBaseline({ input_tokens: 10, output_tokens: 20 })).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
  })

  it('captures cache counters when present', () => {
    expect(
      snapshotTaskTokenBaseline({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
      })
    ).toEqual({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 })
  })
})

describe('evaluateTaskBrake — no caps configured', () => {
  it('returns null (no-op) when neither maxTaskTokens nor maxTaskCost is set', () => {
    expect(evaluateTaskBrake(brake(), { input_tokens: 999_999, output_tokens: 999_999 })).toBeNull()
  })

  it('returns null when maxTaskTokens is null', () => {
    expect(evaluateTaskBrake(brake({ maxTaskTokens: null }), { input_tokens: 999_999 })).toBeNull()
  })

  it('returns null when maxTaskCost is set but no price is available', () => {
    expect(
      evaluateTaskBrake(brake({ maxTaskCost: 0.000001, price: null }), { input_tokens: 999_999 })
    ).toBeNull()
  })
})

describe('evaluateTaskBrake — token cap', () => {
  it('does not trip when the delta is under the cap', () => {
    const trip = evaluateTaskBrake(brake({ maxTaskTokens: 1000 }), {
      input_tokens: 400,
      output_tokens: 300,
    })
    expect(trip).toBeNull()
  })

  it('does not trip exactly at the cap (strictly-greater semantics)', () => {
    expect(
      evaluateTaskBrake(brake({ maxTaskTokens: 1000 }), { input_tokens: 600, output_tokens: 400 })
    ).toBeNull()
  })

  it('trips when the summed delta exceeds the cap', () => {
    const trip = evaluateTaskBrake(brake({ maxTaskTokens: 1000 }), {
      input_tokens: 600,
      output_tokens: 300,
      cache_read_tokens: 50,
      cache_write_tokens: 60,
    })
    expect(trip).toEqual({ unit: 'tokens', limit: 1000, spent: 1010 })
  })

  it('measures the DELTA: a non-zero baseline does not trip a small current task', () => {
    // Session already accumulated 1,000,000 tokens (a long-lived session). The
    // brake must measure THIS task's delta vs the baseline, not the raw total.
    const baseline: TaskTokenBaseline = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    }
    const trip = evaluateTaskBrake(brake({ maxTaskTokens: 1000, baseline }), {
      input_tokens: 1_000_500, // this task spent only 500
    })
    expect(trip).toBeNull()
  })

  it('measures the DELTA: trips only on this task overspend above a non-zero baseline', () => {
    const baseline: TaskTokenBaseline = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    }
    const trip = evaluateTaskBrake(brake({ maxTaskTokens: 1000, baseline }), {
      input_tokens: 1_002_000, // this task spent 2000 > 1000
    })
    expect(trip).toEqual({ unit: 'tokens', limit: 1000, spent: 2000 })
  })
})

describe('evaluateTaskBrake — cost cap', () => {
  it('does not trip when the delta cost is under the cap', () => {
    // input delta 1000 * 3 / 1e6 = 0.003
    const trip = evaluateTaskBrake(brake({ maxTaskCost: 0.01, price: PRICE }), {
      input_tokens: 1000,
    })
    expect(trip).toBeNull()
  })

  it('does not trip when the delta cost is exactly at the cap (strictly-greater)', () => {
    // input 1_000_000 * 3 / 1e6 = 3.0, exactly maxTaskCost
    expect(
      evaluateTaskBrake(brake({ maxTaskCost: 3.0, price: PRICE }), { input_tokens: 1_000_000 })
    ).toBeNull()
  })

  it('trips when the delta cost exceeds the cap', () => {
    // input 1_000_000 * 3 / 1e6 = 3.0; output 100_000 * 15 / 1e6 = 1.5 → 4.5 > 1.0
    const trip = evaluateTaskBrake(brake({ maxTaskCost: 1.0, price: PRICE }), {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    })
    expect(trip?.unit).toBe('cost')
    expect(trip?.limit).toBe(1.0)
    expect(trip?.spent).toBeCloseTo(4.5, 6)
  })

  it('prices cache read/write separately when computing the delta cost', () => {
    // cacheWrite 1_000_000 * 3.75 / 1e6 = 3.75 > 1.0
    const trip = evaluateTaskBrake(brake({ maxTaskCost: 1.0, price: PRICE }), {
      cache_write_tokens: 1_000_000,
    })
    expect(trip?.unit).toBe('cost')
    expect(trip?.spent).toBeCloseTo(3.75, 6)
  })

  it('token cap takes precedence when both caps would trip', () => {
    const trip = evaluateTaskBrake(
      brake({ maxTaskTokens: 100, maxTaskCost: 0.0001, price: PRICE }),
      { input_tokens: 1_000_000 }
    )
    expect(trip?.unit).toBe('tokens')
  })
})
