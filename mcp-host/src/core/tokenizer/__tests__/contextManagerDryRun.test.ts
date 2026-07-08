/**
 * P.2 — dry-run gating of the PressureContextManager. Verifies that:
 *  - when `dryRun: true` (default during the bake-week), the heuristic
 *    decides the tier even if the counter reports a different number; the
 *    delta histogram and tier-mismatch counter are still emitted;
 *  - when `dryRun: false`, the counter drives the tier directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { PressureContextManager } from '../../extensions/contextManager'
import type { ChatMessage } from '../../types'
import { heuristicCount } from '../heuristic'
import { tokenizerDryrunTierMismatchTotal } from '../metrics'
import type { TokenCounter } from '../tokenCounter'

function makeCounter(value: number): TokenCounter {
  return {
    providerName: 'claude',
    modelName: 'claude-opus-4-7',
    count: vi.fn(async () => value),
    countSync: vi.fn(() => value),
    warmup: vi.fn(async () => {}),
    recordObservedUsage: vi.fn(),
    lastObservedInputTokens: vi.fn(() => null),
  }
}

function tinyMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a b c d e f' },
    { role: 'assistant', content: 'g h i j k l' },
  ]
}

function getMismatchCount(from: string, to: string): number {
  const samples = (
    tokenizerDryrunTierMismatchTotal as unknown as {
      hashMap: Record<string, { value: number; labels: { from: string; to: string } }>
    }
  ).hashMap
  let total = 0
  for (const key of Object.keys(samples)) {
    const sample = samples[key]
    if (sample.labels.from === from && sample.labels.to === to) total += sample.value
  }
  return total
}

describe('PressureContextManager dry-run', () => {
  beforeEach(() => {
    tokenizerDryrunTierMismatchTotal.reset()
  })

  it('keeps heuristic-driven tier selection when dryRun=true', async () => {
    const msgs = tinyMessages()
    const heuristic = heuristicCount(msgs)
    // Heuristic-driven decision: choose maxTokens so heuristic/max ≈ 0.5
    // → passthrough. Counter reports a value high enough to trip the
    // truncate tier (would keep 3 turns if it controlled the decision).
    const maxTokens = Math.ceil(heuristic / 0.5)
    const counter = makeCounter(maxTokens * 2) // would force truncate
    const manager = new PressureContextManager(maxTokens, undefined, undefined, counter, {
      dryRun: true,
    })
    const result = await manager.manage(msgs, makeFakeConversation())
    // Passthrough: same reference.
    expect(result).toBe(msgs)
    expect(getMismatchCount('passthrough', 'truncate')).toBeGreaterThanOrEqual(1)
  })

  it('lets the counter drive the tier when dryRun=false', async () => {
    const msgs = tinyMessages()
    const heuristic = heuristicCount(msgs)
    // Same setup as above (heuristic would passthrough) but with dryRun
    // disabled the counter's high value should trigger compaction.
    const maxTokens = Math.ceil(heuristic / 0.5)
    const counter = makeCounter(maxTokens * 2)
    const manager = new PressureContextManager(maxTokens, undefined, undefined, counter, {
      dryRun: false,
    })
    const result = await manager.manage(msgs, makeFakeConversation())
    expect(result).not.toBe(msgs)
  })

  it('falls back to heuristic when no counter is provided', async () => {
    const msgs = tinyMessages()
    const manager = new PressureContextManager(1_000_000) // huge budget
    const result = await manager.manage(msgs, makeFakeConversation())
    expect(result).toBe(msgs) // passthrough
  })
})
