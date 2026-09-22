/**
 * P.2 — dry-run gating of the PressureContextManager. Verifies that:
 *  - when `dryRun: true` (default during the bake-week), the heuristic
 *    decides the tier even if the counter reports a different number; the
 *    delta histogram and tier-mismatch counter are still emitted;
 *  - when `dryRun: false`, the counter drives the tier directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../../logger'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { PressureContextManager } from '../../extensions/contextManager'
import type { ChatMessage, ToolDefinition } from '../../types'
import { heuristicCount, heuristicCountTools } from '../heuristic'
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

  it('T-E1b a failing dry-run counter is reported through the service logger (#731)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const msgs = tinyMessages()
    const counter = makeCounter(0)
    counter.count = vi.fn(async () => {
      throw new Error('counter unavailable')
    })
    const manager = new PressureContextManager(
      Math.ceil(heuristicCount(msgs) / 0.5),
      undefined,
      undefined,
      counter,
      { dryRun: true }
    )

    const result = await manager.manage(msgs, makeFakeConversation())
    // Liveness witness for the `console.warn` negative below: a decision was
    // still made, from the heuristic, so the catch branch really executed.
    // Without this the `not.toHaveBeenCalled` would pass on a `manage()` that
    // threw or never reached the counter at all.
    expect(result).toBe(msgs)
    expect(counter.count).toHaveBeenCalledTimes(1)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'dryrun counter failed; using heuristic'
    )
    expect(consoleSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  it('falls back to heuristic when no counter is provided', async () => {
    const msgs = tinyMessages()
    const manager = new PressureContextManager(1_000_000) // huge budget
    const result = await manager.manage(msgs, makeFakeConversation())
    expect(result).toBe(msgs) // passthrough
  })
})

// The tool schemas travel in the same request the contract caps, so the gauge
// that decides when to compact must count them (review r2, M2b). Every branch
// of `computePressure` — no counter, dry-run, counter-driven — must see them.
describe('PressureContextManager pressure includes the tool schemas', () => {
  function bulkyTools(): ToolDefinition[] {
    return [
      {
        name: 'crm_search_contacts',
        description: 'Search CRM contacts',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'x'.repeat(4_000) } },
        },
      },
    ]
  }

  it('T-R2-2a tools push a conversation below 0.8 into compaction on the heuristic path', async () => {
    const msgs = tinyMessages()
    const tools = bulkyTools()
    const maxTokens = Math.ceil(heuristicCount(msgs) / 0.7)
    // Witness the arithmetic, so the two outcomes below can only differ by the tools term.
    expect(heuristicCount(msgs) / maxTokens).toBeLessThan(0.8)
    expect((heuristicCount(msgs) + heuristicCountTools(tools)) / maxTokens).toBeGreaterThanOrEqual(
      0.95
    )
    const manager = new PressureContextManager(maxTokens)

    expect(await manager.manage(msgs, makeFakeConversation())).toBe(msgs)
    expect(await manager.manage(msgs, makeFakeConversation(), { tools })).not.toBe(msgs)
  })

  it('T-R2-2b dry-run decides from messages plus tools and hands the tools to the counter', async () => {
    const msgs = tinyMessages()
    const tools = bulkyTools()
    const maxTokens = Math.ceil(heuristicCount(msgs) / 0.7)
    const counter = makeCounter(0) // would pass through if it decided
    const manager = new PressureContextManager(maxTokens, undefined, undefined, counter, {
      dryRun: true,
    })

    const result = await manager.manage(msgs, makeFakeConversation(), { tools })

    expect(result).not.toBe(msgs)
    expect(counter.count).toHaveBeenCalledWith(msgs, tools)
  })

  it('T-R2-2c the counter-driven path hands the tools to the counter', async () => {
    const msgs = tinyMessages()
    const tools = bulkyTools()
    const counter = makeCounter(0)
    const manager = new PressureContextManager(1_000, undefined, undefined, counter, {
      dryRun: false,
    })

    const result = await manager.manage(msgs, makeFakeConversation(), { tools })

    // The counter reports 0, so its number decided: passthrough by reference.
    expect(result).toBe(msgs)
    expect(counter.count).toHaveBeenCalledTimes(1)
    expect(counter.count).toHaveBeenCalledWith(msgs, tools)
  })
})
