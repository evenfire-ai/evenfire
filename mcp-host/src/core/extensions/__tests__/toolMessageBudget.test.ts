import { describe, expect, it } from 'vitest'
import { get_encoding } from 'tiktoken'
import type { TokenCounter } from '../../tokenizer/tokenCounter'
import type { ChatMessage } from '../../types'
import * as contextManager from '../contextManager'

type Measure = (message: ChatMessage, counter: TokenCounter | undefined, dryRun: boolean) => number

function measure(): Measure {
  const candidate = (contextManager as unknown as { toolMessageBudgetTokens?: Measure })
    .toolMessageBudgetTokens
  expect(candidate).toBeTypeOf('function')
  return candidate!
}

describe('tool-message token budget', () => {
  it('accounts for the dense body and tool-message framing with a real BPE witness', () => {
    const encoder = get_encoding('cl100k_base')
    const content = Buffer.from('a deterministic public byte sequence')
      .toString('base64')
      .repeat(2048)
    const message: ChatMessage = {
      role: 'tool',
      name: 'clerum__attachment_read',
      tool_call_id: 'call_public',
      content,
    }
    const whole = encoder.encode(content, [], []).length
    const count = measure()(message, undefined, true)
    expect(count).toBeGreaterThanOrEqual(whole)
    expect(count).toBeGreaterThan(Math.ceil(Buffer.byteLength(content) / 4))
    expect(measure()({ ...message, content: '' }, undefined, true)).toBeGreaterThan(0)
    encoder.free()
  })

  it('uses the larger applicable provider estimate and does not call the network counter', () => {
    let networkCalls = 0
    const counter: TokenCounter = {
      providerName: 'unknown',
      modelName: 'public-unit-fixture',
      count: async () => {
        networkCalls += 1
        return 90_000
      },
      countSync: () => 20_000,
      warmup: async () => {},
      recordObservedUsage: () => {},
      lastObservedInputTokens: () => null,
    }
    const message: ChatMessage = {
      role: 'tool',
      name: 'bounded_tool',
      tool_call_id: 'call_1',
      content: 'small page',
    }
    expect(measure()(message, counter, false)).toBe(20_000)
    expect(measure()(message, counter, true)).toBeLessThan(20_000)
    expect(networkCalls).toBe(0)
  })
})
