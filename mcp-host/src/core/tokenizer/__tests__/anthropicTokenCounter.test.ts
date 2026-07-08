import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../types'
import { AnthropicTokenCounter } from '../anthropicTokenCounter'
import { heuristicCount } from '../heuristic'

function makeClient(stub: (params: unknown) => unknown) {
  return {
    beta: {
      messages: {
        countTokens: vi.fn((params: unknown) => Promise.resolve(stub(params))),
      },
    },
  } as unknown as ConstructorParameters<typeof AnthropicTokenCounter>[0]
}

describe('AnthropicTokenCounter', () => {
  it('calls beta.messages.countTokens with the translated payload', async () => {
    let received: { model: string; system?: string; messages: unknown[] } | null = null
    const client = makeClient(params => {
      received = params as never
      return { input_tokens: 99 }
    })
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7')
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Hello, Claude' },
    ]
    const n = await counter.count(msgs)
    expect(n).toBe(99)
    expect(received).toBeTruthy()
    expect(received!.model).toBe('claude-opus-4-7')
    expect(received!.system).toBe('sys')
    expect(received!.messages).toHaveLength(1)
  })

  it('falls back to heuristic × 1.5 on error', async () => {
    const client = makeClient(() => {
      throw Object.assign(new Error('rate'), { status: 429 })
    })
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7')
    const msgs: ChatMessage[] = [{ role: 'user', content: 'one two three four five' }]
    const heuristic = heuristicCount(msgs)
    expect(await counter.count(msgs)).toBe(Math.ceil(heuristic * 1.5))
  })

  it('offline mode skips the network', async () => {
    const fn = vi.fn()
    const client = {
      beta: { messages: { countTokens: fn } },
    } as unknown as ConstructorParameters<typeof AnthropicTokenCounter>[0]
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7', { offline: true })
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    const n = await counter.count(msgs)
    expect(fn).not.toHaveBeenCalled()
    expect(n).toBe(Math.ceil(heuristicCount(msgs) * 1.5))
  })

  it('records and recalls observed usage', () => {
    const client = makeClient(() => ({ input_tokens: 1 }))
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7')
    expect(counter.lastObservedInputTokens()).toBeNull()
    counter.recordObservedUsage({ input_tokens: 555, output_tokens: 22 })
    expect(counter.lastObservedInputTokens()).toBe(555)
  })

  it('countSync returns the heuristic upper bound (no sync path on Anthropic)', () => {
    const client = makeClient(() => ({ input_tokens: 1 }))
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7')
    const msgs: ChatMessage[] = [{ role: 'user', content: 'one two three' }]
    expect(counter.countSync(msgs)).toBe(Math.ceil(heuristicCount(msgs) * 1.5))
  })

  it('countSync folds tool schemas into the heuristic so the tools bucket is non-zero (#12)', () => {
    const client = makeClient(() => ({ input_tokens: 1 }))
    const counter = new AnthropicTokenCounter(client, 'claude-opus-4-7')
    const tools: ToolDefinition[] = [
      {
        name: 'search',
        description: 'd',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]
    // With no messages, the old impl returned 0; the fix folds the tool schema
    // in so `countSync([], tools)` is strictly > 0 (the breakdown depends on it).
    const toolsOnly = counter.countSync([], tools)
    expect(toolsOnly).toBeGreaterThan(0)

    // Adding a tool must raise the count vs messages alone — proving tools are
    // actually summed and not dropped.
    const msgs: ChatMessage[] = [{ role: 'user', content: 'one two three' }]
    const withoutTools = counter.countSync(msgs)
    const withTools = counter.countSync(msgs, tools)
    expect(withTools).toBeGreaterThan(withoutTools)
  })
})
