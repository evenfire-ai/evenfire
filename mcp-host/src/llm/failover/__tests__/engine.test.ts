import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import { FailoverEngine } from '../engine'
import type { FailoverSwitchEvent, LlmPolicy, ModelPair } from '../types'

const PRIMARY: ModelPair = { provider: 'claude', model: 'claude-sonnet-4-6' }

function policy(overrides: Partial<LlmPolicy> = {}): LlmPolicy {
  return {
    cooldownSeconds: 300,
    triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
    fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
    ...overrides,
  }
}

/** A classifier that reads `LlmError` fields (as the agent glue does). */
function classify(err: unknown): { code: LlmErrorCode; retryable: boolean } | null {
  if (err instanceof LlmError) return { code: err.code as LlmErrorCode, retryable: err.retryable }
  return null
}

function llmError(code: LlmErrorCode, retryable: boolean): LlmError {
  return new LlmError('boom', 'claude', code, retryable)
}

describe('FailoverEngine', () => {
  let metricInc: Mock<(labels: { from: string; to: string; reason: string }) => void>
  let onSwitch: Mock<(event: FailoverSwitchEvent) => void>
  let now: number

  beforeEach(() => {
    metricInc = vi.fn()
    onSwitch = vi.fn()
    now = 1_000_000
  })

  function engine(p: LlmPolicy = policy()): FailoverEngine {
    return new FailoverEngine(p, {
      now: () => now,
      onSwitch: e => onSwitch(e),
      metricInc: l => metricInc(l),
    })
  }

  it('serves the primary and does not switch when the call succeeds', async () => {
    const e = engine()
    const build = vi.fn(t => () => Promise.resolve(`ok:${t.kind}`))
    const res = await e.run(PRIMARY, build, classify)
    expect(res).toBe('ok:primary')
    expect(metricInc).not.toHaveBeenCalled()
    expect(e.servedBy()).toEqual({ ...PRIMARY, fallback: false })
  })

  it.each([
    [LlmErrorCode.InsufficientQuota, false, 'insufficient_quota'],
    [LlmErrorCode.AuthenticationFailed, false, 'auth'],
    [LlmErrorCode.RateLimited, true, 'rate_limited'],
    [LlmErrorCode.ModelOverloaded, true, 'provider_unavailable'],
    [LlmErrorCode.ApiCallFailed, true, 'provider_unavailable'],
  ])(
    'each eligible class (%s) triggers a switch to the fallback',
    async (code, retryable, reason) => {
      const e = engine()
      const res = await e.run(
        PRIMARY,
        t =>
          t.kind === 'primary'
            ? () => Promise.reject(llmError(code, retryable))
            : () => Promise.resolve('fallback-served'),
        classify
      )
      expect(res).toBe('fallback-served')
      expect(metricInc).toHaveBeenCalledWith({
        from: 'claude/claude-sonnet-4-6',
        to: 'openai/gpt-5.4',
        reason,
      })
      expect(onSwitch).toHaveBeenCalledWith({
        from: PRIMARY,
        to: { provider: 'openai', model: 'gpt-5.4' },
        reason,
      })
      expect(e.servedBy()).toEqual({ provider: 'openai', model: 'gpt-5.4', fallback: true })
    }
  )

  it('does NOT trigger on a non-eligible error (400/validation) — propagates', async () => {
    const e = engine()
    const err = llmError(LlmErrorCode.ApiCallFailed, false) // 400 → not retryable
    await expect(
      e.run(
        PRIMARY,
        t => (t.kind === 'primary' ? () => Promise.reject(err) : () => Promise.resolve('nope')),
        classify
      )
    ).rejects.toBe(err)
    expect(metricInc).not.toHaveBeenCalled()
  })

  it('respects a restricted triggerOn: an out-of-set class propagates', async () => {
    const e = engine(policy({ triggerOn: ['auth'] }))
    const err = llmError(LlmErrorCode.RateLimited, true) // rate_limited not in triggerOn
    await expect(
      e.run(
        PRIMARY,
        t => (t.kind === 'primary' ? () => Promise.reject(err) : () => Promise.resolve('nope')),
        classify
      )
    ).rejects.toBe(err)
    expect(metricInc).not.toHaveBeenCalled()
  })

  it('advances through an ordered list when the first fallback also fails', async () => {
    const e = engine(
      policy({
        fallbacks: [
          { provider: 'openai', model: 'gpt-5.4' },
          { provider: 'zai', model: 'glm-5.1' },
        ],
      })
    )
    const res = await e.run(
      PRIMARY,
      t => {
        if (t.kind === 'primary')
          return () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
        if (t.kind === 'fallback' && t.index === 0)
          return () => Promise.reject(llmError(LlmErrorCode.ModelOverloaded, true))
        return () => Promise.resolve('second-fallback')
      },
      classify
    )
    expect(res).toBe('second-fallback')
    expect(metricInc).toHaveBeenCalledTimes(2)
    expect(metricInc).toHaveBeenNthCalledWith(1, {
      from: 'claude/claude-sonnet-4-6',
      to: 'openai/gpt-5.4',
      reason: 'rate_limited',
    })
    expect(metricInc).toHaveBeenNthCalledWith(2, {
      from: 'openai/gpt-5.4',
      to: 'zai/glm-5.1',
      reason: 'provider_unavailable',
    })
    expect(e.servedBy()).toEqual({ provider: 'zai', model: 'glm-5.1', fallback: true })
  })

  it('skips an unconstructible fallback (null builder) without a phantom switch', async () => {
    const e = engine(
      policy({
        fallbacks: [
          { provider: 'openai', model: 'gpt-5.4' }, // unconstructible
          { provider: 'zai', model: 'glm-5.1' },
        ],
      })
    )
    const res = await e.run(
      PRIMARY,
      t => {
        if (t.kind === 'primary')
          return () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
        if (t.kind === 'fallback' && t.index === 0) return null // skip
        return () => Promise.resolve('third')
      },
      classify
    )
    expect(res).toBe('third')
    // Exactly one switch: primary → the SECOND fallback (the skipped one emits none).
    expect(metricInc).toHaveBeenCalledTimes(1)
    expect(metricInc).toHaveBeenCalledWith({
      from: 'claude/claude-sonnet-4-6',
      to: 'zai/glm-5.1',
      reason: 'rate_limited',
    })
  })

  it('is sticky: while cooling, the next call starts at the fallback (no primary retry)', async () => {
    const e = engine()
    // Call 1: primary fails eligibly → cooldown set, fallback serves.
    await e.run(
      PRIMARY,
      t =>
        t.kind === 'primary'
          ? () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
          : () => Promise.resolve('fb1'),
      classify
    )
    // Call 2 within the cooldown window: primary must NOT be attempted.
    const primaryBuild = vi.fn(() => () => Promise.resolve('primary-should-not-run'))
    const res = await e.run(
      PRIMARY,
      t => (t.kind === 'primary' ? primaryBuild() : () => Promise.resolve('fb2')),
      classify
    )
    expect(res).toBe('fb2')
    expect(primaryBuild).not.toHaveBeenCalled()
    // No new switch recorded on call 2 (already on the fallback).
    expect(metricInc).toHaveBeenCalledTimes(1)
  })

  it('lazy recovery: after the cooldown expires the primary is retried', async () => {
    const e = engine(policy({ cooldownSeconds: 300 }))
    await e.run(
      PRIMARY,
      t =>
        t.kind === 'primary'
          ? () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
          : () => Promise.resolve('fb'),
      classify
    )
    expect(e.servedBy()?.fallback).toBe(true)
    // Advance past the cooldown.
    now += 300_000 + 1
    const res = await e.run(PRIMARY, () => () => Promise.resolve('primary-recovered'), classify)
    expect(res).toBe('primary-recovered')
    expect(e.servedBy()).toEqual({ ...PRIMARY, fallback: false })
  })

  it('exhausted list propagates the last error (canned fallback is the last resort)', async () => {
    const e = engine()
    const lastErr = llmError(LlmErrorCode.ModelOverloaded, true)
    await expect(
      e.run(
        PRIMARY,
        t =>
          t.kind === 'primary'
            ? () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
            : () => Promise.reject(lastErr),
        classify
      )
    ).rejects.toBe(lastErr)
  })

  it('clearCooldown lets the next call retry the primary immediately (key recovery)', async () => {
    const e = engine()
    await e.run(
      PRIMARY,
      t =>
        t.kind === 'primary'
          ? () => Promise.reject(llmError(LlmErrorCode.AuthenticationFailed, false))
          : () => Promise.resolve('fb'),
      classify
    )
    // Without clearing, the primary would be skipped (cooling) — clear it.
    e.clearCooldown()
    const res = await e.run(PRIMARY, () => () => Promise.resolve('primary-immediately'), classify)
    expect(res).toBe('primary-immediately')
    expect(e.servedBy()).toEqual({ ...PRIMARY, fallback: false })
  })

  it('passes the correct FULL-list index to the builder as it advances (index alignment)', async () => {
    const e = engine(
      policy({
        fallbacks: [
          { provider: 'openai', model: 'gpt-5.4' }, // index 0 — unconstructible
          { provider: 'zai', model: 'glm-5.1' }, // index 1 — serves
        ],
      })
    )
    const seenIndexes: number[] = []
    const res = await e.run(
      PRIMARY,
      t => {
        if (t.kind === 'primary')
          return () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
        seenIndexes.push(t.index)
        if (t.index === 0) return null // unconstructible → skip
        return () => Promise.resolve(`served-${t.index}`)
      },
      classify
    )
    expect(res).toBe('served-1')
    // The builder saw both full-list indices in order (0 skipped, 1 served).
    expect(seenIndexes).toEqual([0, 1])
  })

  it('honours an Attempt.servedModel override for servedBy + the metric to-label', async () => {
    // FIX-2: a same-provider fallback serves the SESSION model, not entry.model.
    // The builder returns { run, servedModel } and the engine must use that model
    // for servedBy and the `to` metric label instead of the target's entry model.
    const e = engine(policy({ fallbacks: [{ provider: 'claude', model: 'claude-haiku-4-5' }] }))
    const res = await e.run(
      PRIMARY,
      t =>
        t.kind === 'primary'
          ? () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
          : { run: () => Promise.resolve('served'), servedModel: 'claude-sonnet-4-6' },
      classify
    )
    expect(res).toBe('served')
    expect(e.servedBy()).toEqual({ provider: 'claude', model: 'claude-sonnet-4-6', fallback: true })
    expect(metricInc).toHaveBeenCalledWith({
      from: 'claude/claude-sonnet-4-6',
      to: 'claude/claude-sonnet-4-6',
      reason: 'rate_limited',
    })
  })

  it('setPolicy resets the sticky cooldown', async () => {
    const e = engine()
    await e.run(
      PRIMARY,
      t =>
        t.kind === 'primary'
          ? () => Promise.reject(llmError(LlmErrorCode.RateLimited, true))
          : () => Promise.resolve('fb'),
      classify
    )
    e.setPolicy(policy())
    expect(e.servedBy()).toBeNull()
    // After reset the primary is attempted again immediately.
    const res = await e.run(PRIMARY, () => () => Promise.resolve('primary'), classify)
    expect(res).toBe('primary')
  })
})
