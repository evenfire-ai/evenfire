import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../types'
import { FallbackTokenCounter } from '../fallbackTokenCounter'
import { heuristicCount } from '../heuristic'
import { tokenizerFallbackTotal } from '../metrics'

function getMetric(provider: 'zai' | 'bailian'): number {
  // prom-client `Counter.get()` returns aggregated values; we read the inc-only label.
  const samples = (
    tokenizerFallbackTotal as unknown as {
      hashMap: Record<string, { value: number; labels: { provider: string; reason: string } }>
    }
  ).hashMap
  let total = 0
  for (const key of Object.keys(samples)) {
    const sample = samples[key]
    if (sample.labels.provider === provider && sample.labels.reason === 'no_native_api') {
      total += sample.value
    }
  }
  return total
}

describe('FallbackTokenCounter', () => {
  beforeEach(() => {
    tokenizerFallbackTotal.reset()
  })

  it('returns heuristic × biasFactor', async () => {
    const counter = new FallbackTokenCounter('zai', 'glm-4-plus', 1.3)
    const msgs: ChatMessage[] = [{ role: 'user', content: 'one two three four five' }]
    const heuristic = heuristicCount(msgs) // 10
    expect(await counter.count(msgs)).toBe(Math.ceil(heuristic * 1.3))
  })

  it('increments the fallback metric on every call', async () => {
    const counter = new FallbackTokenCounter('zai', 'glm-4-plus')
    expect(getMetric('zai')).toBe(0)
    await counter.count([{ role: 'user', content: 'hi' }])
    expect(getMetric('zai')).toBe(1)
    counter.countSync([{ role: 'user', content: 'hi' }])
    expect(getMetric('zai')).toBe(2)
  })

  it('records and recalls observed usage', () => {
    const counter = new FallbackTokenCounter('bailian', 'qwen-plus')
    expect(counter.lastObservedInputTokens()).toBeNull()
    counter.recordObservedUsage({ input_tokens: 1234, output_tokens: 99 })
    expect(counter.lastObservedInputTokens()).toBe(1234)
  })

  it('factors tool schemas into the count', async () => {
    const counter = new FallbackTokenCounter('zai', 'glm-4-plus', 1.3)
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello world' }]
    const tools: ToolDefinition[] = [
      {
        name: 'my_tool',
        description: 'desc',
        parameters: { type: 'object', properties: { foo: { type: 'string' } } },
      },
    ]
    const withTools = await counter.count(msgs, tools)
    const withoutTools = await counter.count(msgs)
    expect(withTools).toBeGreaterThan(withoutTools)
  })
})
