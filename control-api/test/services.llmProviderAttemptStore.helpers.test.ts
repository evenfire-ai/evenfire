import { describe, expect, it } from 'vitest'
import {
  CODEX_IN_FLIGHT_USAGE_GRACE_MS,
  isLinkedCodexInFlightWithoutUsage,
  isLinkedCodexUsageReady,
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
})
