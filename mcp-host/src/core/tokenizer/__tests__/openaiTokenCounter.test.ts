import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../types'
import { OpenAITokenCounter } from '../openaiTokenCounter'

describe('OpenAITokenCounter', () => {
  it('counts a simple user message with the expected overhead', async () => {
    const counter = new OpenAITokenCounter('gpt-4o-mini')
    await counter.warmup()
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Hello, world!' }]
    const n = counter.countSync(msgs)
    // 3 (msg overhead) + N (content) + 3 (trailing prime). We can't pin the
    // exact tiktoken value across versions, but it's bounded.
    expect(n).toBeGreaterThanOrEqual(8)
    expect(n).toBeLessThanOrEqual(15)
  })

  it('countSync without warmup falls back to heuristic upper bound', () => {
    const counter = new OpenAITokenCounter('gpt-4o-mini')
    const msgs: ChatMessage[] = [{ role: 'user', content: 'one two three' }]
    const n = counter.countSync(msgs)
    expect(n).toBeGreaterThan(0)
  })

  it('encodes tool_calls payload', async () => {
    const counter = new OpenAITokenCounter('gpt-4o-mini')
    await counter.warmup()
    const withTools: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'abc', name: 'my_tool', arguments: { foo: 'bar' } }],
      },
    ]
    const without: ChatMessage[] = [{ role: 'assistant', content: '' }]
    expect(counter.countSync(withTools)).toBeGreaterThan(counter.countSync(without))
  })

  it('encodes tool definitions', async () => {
    const counter = new OpenAITokenCounter('gpt-4o-mini')
    await counter.warmup()
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    const tools: ToolDefinition[] = [
      {
        name: 'tool_one',
        description: 'first tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ]
    expect(counter.countSync(msgs, tools)).toBeGreaterThan(counter.countSync(msgs))
  })

  it('records and recalls observed usage', () => {
    const counter = new OpenAITokenCounter('gpt-4o-mini')
    expect(counter.lastObservedInputTokens()).toBeNull()
    counter.recordObservedUsage({ input_tokens: 42, output_tokens: 3 })
    expect(counter.lastObservedInputTokens()).toBe(42)
  })

  it('warmup falls back to cl100k_base for unknown models', async () => {
    const counter = new OpenAITokenCounter('totally-not-a-real-model-xyz')
    await counter.warmup()
    const n = counter.countSync([{ role: 'user', content: 'hi' }])
    expect(n).toBeGreaterThan(0)
  })
})
