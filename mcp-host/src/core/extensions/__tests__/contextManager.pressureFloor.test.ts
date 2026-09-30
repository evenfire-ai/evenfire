/**
 * Compaction must follow billed usage as a floor, and a tier that leaves the
 * request over the gate has to keep going. Lead Scout task c58e7744 sat at
 * 210748/256000 after a keep-8 cut archived nothing: the fat tokens were tool
 * results inside the only live turn, dry-run ignored the billed input, and
 * two no-op attempts then disabled compaction for the rest of the task.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { estimateTokens } from '../../conversation/compaction'
import type { LlmPort } from '../../interfaces'
import { validateToolLinkages } from '../../orchestration/toolUseLoop'
import { heuristicCount } from '../../tokenizer/heuristic'
import { tokenizerDryrunDelta, tokenizerDryrunTierMismatchTotal } from '../../tokenizer/metrics'
import type { TokenCounter } from '../../tokenizer/tokenCounter'
import type { ChatMessage } from '../../types'
import { PressureContextManager, tierDecisionTokens } from '../contextManager'

function messageWithHeuristic(target: number): ChatMessage {
  // ASCII with no JSON escapes: heuristicCount is ceil(chars / 4) + 4.
  const chars = (target - 4) * 4
  return { role: 'user', content: 'a'.repeat(chars) }
}

function observingCounter(input: {
  observed: number | null
  baseline: number | null
  count?: number
  withBaselineMethod?: boolean
}): TokenCounter {
  const counter: TokenCounter = {
    providerName: 'codex-subscription',
    modelName: 'gpt-5.6-sol',
    count: vi.fn(async () => input.count ?? 1_000_000),
    countSync: vi.fn(() => input.count ?? 1_000_000),
    warmup: vi.fn(async () => {}),
    recordObservedUsage: vi.fn(),
    lastObservedInputTokens: vi.fn(() => input.observed),
  }
  if (input.withBaselineMethod !== false) {
    counter.lastObservedDecisionHeuristic = vi.fn(() => input.baseline)
  }
  return counter
}

describe('tierDecisionTokens billed floor', () => {
  it('raises a dry-run decision by billed input plus heuristic growth', async () => {
    const messages = [messageWithHeuristic(170_000)]
    expect(heuristicCount(messages)).toBe(170_000)
    const decision = await tierDecisionTokens(
      messages,
      [],
      observingCounter({ observed: 210_000, baseline: 160_000 }),
      true
    )
    // 210000 + (170000 - 160000). The 1.3× fallback count must not be the decision.
    expect(decision).toBe(220_000)
  })

  it('floors a dry-run decision at billed input when no heuristic baseline was stored', async () => {
    const messages = [messageWithHeuristic(170_000)]
    const decision = await tierDecisionTokens(
      messages,
      [],
      observingCounter({ observed: 210_000, baseline: null, withBaselineMethod: false }),
      true
    )
    expect(decision).toBe(210_000)
  })

  it('keeps a stale observation as a floor after the history shrinks', async () => {
    const messages = [messageWithHeuristic(100_000)]
    const decision = await tierDecisionTokens(
      messages,
      [],
      observingCounter({ observed: 210_000, baseline: 160_000 }),
      true
    )
    // 210000 + (100000 - 160000) = 150000, which still beats the shrunk heuristic.
    expect(decision).toBe(150_000)
  })

  it('keeps the byte heuristic when the counter has no observation', async () => {
    const messages = [messageWithHeuristic(170_000)]
    const decision = await tierDecisionTokens(
      messages,
      [],
      observingCounter({ observed: null, baseline: null }),
      true
    )
    expect(decision).toBe(170_000)
  })
})

describe('PressureContextManager same-call escalation', () => {
  function tailHeavyHistory(): ChatMessage[] {
    const huge = 'h'.repeat(8_000)
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'user', content: 'x' })
      msgs.push({ role: 'assistant', content: 'y' })
    }
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user', content: `${huge} user ${i}` })
      msgs.push({ role: 'assistant', content: `${huge} assistant ${i}` })
    }
    return msgs
  }

  it('escalates a keep-8 cut that leaves the tail over the gate', async () => {
    const msgs = tailHeavyHistory()
    const full = estimateTokens(msgs)
    const kept8 = [msgs[0], ...msgs.slice(-16)]
    const kept5 = [msgs[0], ...msgs.slice(-10)]
    const maxTokens = Math.ceil(full / 0.82)
    expect(full / maxTokens).toBeGreaterThanOrEqual(0.8)
    expect(full / maxTokens).toBeLessThan(0.85)
    expect(estimateTokens(kept8) / maxTokens).toBeGreaterThanOrEqual(0.8)
    expect(estimateTokens(kept5) / maxTokens).toBeLessThan(0.8)

    const appendDailyLog = vi.fn<(markdown: string) => Promise<void>>(async () => {})
    const complete = vi.fn(async () => ({
      content: 'summary',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop' as const,
    }))
    const manager = new PressureContextManager(
      maxTokens,
      { appendDailyLog } as unknown as ConstructorParameters<typeof PressureContextManager>[1],
      { complete, completeWithTools: vi.fn(), modelName: () => 'test' } as unknown as LlmPort
    )
    const conv = makeFakeConversation()

    const result = await manager.manage(msgs, conv)

    expect(result.filter(m => m.role === 'user')).toHaveLength(5)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(appendDailyLog).toHaveBeenCalledTimes(1)
    expect(appendDailyLog.mock.calls[0][0]).toContain('15 turns summarized')
    expect(appendDailyLog.mock.calls[0][0]).not.toContain('Context Compacted')
    expect(conv.compactionState?.ineffectiveCount).toBe(0)
    expect(conv.compactionState?.stoppedForTask).toBe(false)
  })
})

describe('PressureContextManager in-tail tool collapse', () => {
  it('collapses stale tool results when every tier leaves one fat turn over the gate', async () => {
    const fat = 'f'.repeat(20_000)
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Are these the best companies to approach?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'old', name: 'search', arguments: { q: 'old' } }],
      },
      { role: 'tool', content: fat, tool_call_id: 'old', name: 'search' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'new', name: 'search', arguments: { q: 'new' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'new', name: 'search' },
    ]
    const tokens = estimateTokens(msgs)
    const maxTokens = Math.ceil(tokens / 0.82)
    expect(tokens / maxTokens).toBeGreaterThanOrEqual(0.8)
    expect(tokens / maxTokens).toBeLessThan(0.85)
    const manager = new PressureContextManager(maxTokens, undefined, undefined, undefined, {
      prePruneEnabled: true,
    })
    const conv = makeFakeConversation()

    const result = await manager.manage(msgs, conv)

    const stale = result.find(m => m.tool_call_id === 'old')
    const fresh = result.find(m => m.tool_call_id === 'new')
    expect(stale?.content).not.toBe(fat)
    expect(stale?.content).toContain('[search]')
    expect(stale?.content).toContain('bytes')
    expect(fresh?.content).toBe('ok')
    expect(() => validateToolLinkages(result)).not.toThrow()
    expect(estimateTokens(result) / maxTokens).toBeLessThan(0.8)
    expect(conv.compactionState?.ineffectiveCount).toBe(0)
    expect(conv.compactionState?.stoppedForTask).toBe(false)
  })

  it('caps a trailing tool result that alone exceeds the gate and keeps a preview', async () => {
    const fat = `PREVIEW_START_${'z'.repeat(20_000)}UNIQUE_TAIL_MARKER`
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'check the latest filing' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'only', name: 'fetch', arguments: {} }],
      },
      { role: 'tool', content: fat, tool_call_id: 'only', name: 'fetch' },
    ]
    const tokens = estimateTokens(msgs)
    const maxTokens = Math.ceil(tokens / 0.9)
    const toolTokens = estimateTokens([msgs[2]])
    expect(tokens / maxTokens).toBeGreaterThanOrEqual(0.8)
    expect(toolTokens / maxTokens).toBeGreaterThanOrEqual(0.8)
    const manager = new PressureContextManager(maxTokens)
    const conv = makeFakeConversation()

    const result = await manager.manage(msgs, conv)

    const tool = result.find(m => m.tool_call_id === 'only')
    expect(tool?.content.startsWith('PREVIEW_START_')).toBe(true)
    expect(tool?.content).not.toContain('UNIQUE_TAIL_MARKER')
    expect(tool?.content.length).toBeLessThan(fat.length)
    expect(() => validateToolLinkages(result)).not.toThrow()
    expect(estimateTokens(result) / maxTokens).toBeLessThan(0.8)
    expect(conv.compactionState?.ineffectiveCount).toBe(0)
  })
})

describe('dry-run metrics stay on the byte heuristic', () => {
  beforeEach(() => {
    tokenizerDryrunTierMismatchTotal.reset()
    tokenizerDryrunDelta.reset()
  })

  function mismatch(from: string, to: string): number {
    const samples = (
      tokenizerDryrunTierMismatchTotal as unknown as {
        hashMap: Record<string, { value: number; labels: { from: string; to: string } }>
      }
    ).hashMap
    let total = 0
    for (const sample of Object.values(samples)) {
      if (sample.labels.from === from && sample.labels.to === to) total += sample.value
    }
    return total
  }

  it('records the heuristic tier when billed input is what crosses the gate', async () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user', content: `question ${i}` })
      msgs.push({ role: 'assistant', content: `answer ${i}` })
    }
    const heuristic = heuristicCount(msgs)
    const maxTokens = Math.ceil(heuristic / 0.5)
    const counter = observingCounter({
      observed: Math.ceil(maxTokens * 0.9),
      baseline: heuristic,
      count: heuristic,
    })
    const manager = new PressureContextManager(maxTokens, undefined, undefined, counter, {
      dryRun: true,
    })

    const result = await manager.manage(msgs, makeFakeConversation())

    expect(result.filter(m => m.role === 'user').length).toBeLessThan(
      msgs.filter(m => m.role === 'user').length
    )
    expect(mismatch('passthrough', 'summarize')).toBe(0)
    expect(mismatch('passthrough', 'truncate')).toBe(0)
    expect(mismatch('passthrough', 'workspace')).toBe(0)
    expect(counter.count).toHaveBeenCalledTimes(1)
    const counts = (await tokenizerDryrunDelta.get()).values.filter(sample =>
      String(sample.metricName).endsWith('_count')
    )
    expect(counts).toEqual([
      expect.objectContaining({
        labels: { provider: 'codex-subscription', tier_chosen: 'passthrough' },
        value: 1,
      }),
    ])
  })
})
