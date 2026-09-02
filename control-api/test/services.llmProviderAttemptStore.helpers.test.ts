import { describe, expect, it } from 'vitest'
import {
  CODEX_IN_FLIGHT_USAGE_GRACE_MS,
  isLinkedCodexInFlightWithoutUsage,
  isLinkedCodexUsageReady,
  linkedCodexExactUsage,
} from '../src/services/llmProviderAttemptStore.js'

const recentCreatedAt = new Date('2026-09-02T07:40:00.000Z')
const nowMs = recentCreatedAt.getTime() + 60_000

describe('linked Codex usage predicates', () => {
  it('treats success plus both token counts as usage-ready', () => {
    expect(
      isLinkedCodexUsageReady({
        outcome: 'success',
        usageInputTokens: 3,
        usageOutputTokens: 2,
      })
    ).toBe(true)
    expect(
      isLinkedCodexUsageReady({
        outcome: 'success',
        usageInputTokens: 3,
        usageOutputTokens: null,
      })
    ).toBe(false)
    expect(
      isLinkedCodexUsageReady({
        outcome: 'unknown',
        usageInputTokens: 3,
        usageOutputTokens: 2,
      })
    ).toBe(false)
  })

  it('keeps recent authorized and redeemed rows in flight', () => {
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'authorized',
          outcome: null,
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: recentCreatedAt,
        },
        nowMs
      )
    ).toBe(true)
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'redeemed',
          outcome: null,
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: recentCreatedAt,
        },
        nowMs
      )
    ).toBe(true)
  })

  it('treats finalized rows as terminal even when usage never arrived', () => {
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'finalized',
          outcome: 'success',
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: recentCreatedAt,
        },
        nowMs
      )
    ).toBe(false)
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'finalized',
          outcome: 'success',
          usageInputTokens: 3,
          usageOutputTokens: 2,
          createdAt: recentCreatedAt,
        },
        nowMs
      )
    ).toBe(false)
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'finalized',
          outcome: 'error',
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: recentCreatedAt,
        },
        nowMs
      )
    ).toBe(false)
  })

  it('ages out authorized and redeemed rows after the usage grace', () => {
    const stale = new Date(nowMs - CODEX_IN_FLIGHT_USAGE_GRACE_MS - 1)
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'authorized',
          outcome: null,
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: stale,
        },
        nowMs
      )
    ).toBe(false)
    expect(
      isLinkedCodexInFlightWithoutUsage(
        {
          status: 'redeemed',
          outcome: null,
          usageInputTokens: null,
          usageOutputTokens: null,
          createdAt: stale,
        },
        nowMs
      )
    ).toBe(false)
  })

  it('fails loudly instead of pinning an attempt in flight forever when created_at is unreadable', () => {
    // N-15: the old default returned true, which wedges the invocation behind
    // ledger_pending for good and hides the corrupt timestamp.
    for (const createdAt of [null, undefined, 'not-a-timestamp']) {
      expect(() =>
        isLinkedCodexInFlightWithoutUsage(
          {
            status: 'authorized',
            outcome: null,
            usageInputTokens: null,
            usageOutputTokens: null,
            createdAt,
          },
          nowMs
        )
      ).toThrow(/created_at is missing or unparseable/)
    }
  })
})

describe('linkedCodexExactUsage', () => {
  it('returns the token pair only for a usage-ready row', () => {
    expect(
      linkedCodexExactUsage({ outcome: 'success', usageInputTokens: 12, usageOutputTokens: 7 })
    ).toEqual({ inputTokens: 12, outputTokens: 7 })
    // A genuine zero-token success is not the same as a missing pair.
    expect(
      linkedCodexExactUsage({ outcome: 'success', usageInputTokens: 0, usageOutputTokens: 0 })
    ).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('never fabricates a token pair', () => {
    expect(linkedCodexExactUsage(null)).toBeNull()
    expect(
      linkedCodexExactUsage({ outcome: 'error', usageInputTokens: 12, usageOutputTokens: 7 })
    ).toBeNull()
    expect(
      linkedCodexExactUsage({ outcome: 'success', usageInputTokens: 12, usageOutputTokens: null })
    ).toBeNull()
    expect(
      linkedCodexExactUsage({ outcome: 'success', usageInputTokens: null, usageOutputTokens: null })
    ).toBeNull()
  })
})
