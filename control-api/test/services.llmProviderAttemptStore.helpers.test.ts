import { describe, expect, it } from 'vitest'
import {
  isLinkedCodexInFlightWithoutUsage,
  isLinkedCodexUsageReady,
} from '../src/services/llmProviderAttemptStore.js'

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

  it('keeps authorized, redeemed, and usage-less success finalized in flight', () => {
    expect(
      isLinkedCodexInFlightWithoutUsage({
        status: 'authorized',
        outcome: null,
        usageInputTokens: null,
        usageOutputTokens: null,
      })
    ).toBe(true)
    expect(
      isLinkedCodexInFlightWithoutUsage({
        status: 'redeemed',
        outcome: null,
        usageInputTokens: null,
        usageOutputTokens: null,
      })
    ).toBe(true)
    expect(
      isLinkedCodexInFlightWithoutUsage({
        status: 'finalized',
        outcome: 'success',
        usageInputTokens: null,
        usageOutputTokens: null,
      })
    ).toBe(true)
    expect(
      isLinkedCodexInFlightWithoutUsage({
        status: 'finalized',
        outcome: 'success',
        usageInputTokens: 3,
        usageOutputTokens: 2,
      })
    ).toBe(false)
    expect(
      isLinkedCodexInFlightWithoutUsage({
        status: 'finalized',
        outcome: 'error',
        usageInputTokens: null,
        usageOutputTokens: null,
      })
    ).toBe(false)
  })
})
