import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../types'

const state = vi.hoisted(() => ({
  encodeThrows: false,
  loadThrows: false,
}))

vi.mock('tiktoken', () => {
  const encoder = {
    encode: () => {
      if (state.encodeThrows) throw new Error('wasm crashed')
      return new Uint32Array(3)
    },
  }
  return {
    encoding_for_model: () => {
      if (state.loadThrows) throw new Error('unknown model')
      return encoder
    },
    get_encoding: () => {
      if (state.loadThrows) throw new Error('wasm unavailable')
      return encoder
    },
  }
})

const MESSAGE: ChatMessage = { role: 'user', content: '日本語テキストです' }

function exactUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The framing the healthy path always adds: 3 per message + 3 trailing prime. */
function framing(messageCount: number): number {
  return messageCount * 3 + 3
}

async function createCounter(model: string) {
  // Dynamic import AFTER `vi.mock` installs the controllable encoder.
  const { OpenAITokenCounter } = await import('../openaiTokenCounter')
  return new OpenAITokenCounter(model)
}

describe('OpenAITokenCounter — encoder failure fallback', () => {
  beforeEach(() => {
    state.encodeThrows = false
    state.loadThrows = false
  })

  it('counts normally while the mocked encoder works', async () => {
    const counter = await createCounter('gpt-4o-mini')
    await counter.warmup()
    // 3 (message overhead) + 3 (encoded content) + 3 (trailing prime).
    expect(counter.countSync([MESSAGE])).toBe(9)
    await expect(counter.count([MESSAGE])).resolves.toBe(9)
  })

  it('returns the exact UTF-8 byte length instead of throwing when encode fails', async () => {
    const counter = await createCounter('gpt-4o-mini')
    await counter.warmup()
    state.encodeThrows = true
    expect(() => counter.countSync([MESSAGE])).not.toThrow()
    expect(counter.countSync([MESSAGE])).toBe(exactUtf8Bytes(MESSAGE.content) + framing(1))
    await expect(counter.count([MESSAGE])).resolves.toBe(
      exactUtf8Bytes(MESSAGE.content) + framing(1)
    )
  })

  it('keeps the message framing on the fallback path, including empty content', async () => {
    const counter = await createCounter('gpt-4o-mini')
    await counter.warmup()
    state.encodeThrows = true
    const empty: ChatMessage = { role: 'user', content: '' }
    // The framing is real request weight; a zero here would undercount every
    // budget check that runs while the encoder is unavailable.
    expect(counter.countSync([empty])).toBe(framing(1))
    expect(counter.countSync([empty, empty])).toBe(framing(2))
    expect(counter.countSync([empty])).toBeGreaterThan(0)
  })

  it('counts tool schemas in the byte-length fallback', async () => {
    const counter = await createCounter('gpt-4o-mini')
    await counter.warmup()
    state.encodeThrows = true
    const tools: ToolDefinition[] = [
      { name: 'tool_one', description: 'first tool', parameters: { type: 'object' } },
    ]
    const expected =
      exactUtf8Bytes(MESSAGE.content) +
      framing(1) +
      exactUtf8Bytes(tools[0].name) +
      exactUtf8Bytes(tools[0].description ?? '') +
      exactUtf8Bytes(JSON.stringify(tools[0].parameters))
    expect(counter.countSync([MESSAGE], tools)).toBe(expected)
  })

  it('resolves warmup without throwing when no encoder can be loaded', async () => {
    state.loadThrows = true
    const counter = await createCounter('gpt-4o-mini')
    await expect(counter.warmup()).resolves.toBeUndefined()
    // The counter stays usable after the failed load, not stuck or rejected.
    expect(counter.countSync([MESSAGE])).toBe(exactUtf8Bytes(MESSAGE.content) + framing(1))
  })

  it('cannot treat an unserializable tool schema as free while the encoder is unavailable', async () => {
    const counter = await createCounter('gpt-4o-mini')
    await counter.warmup()
    state.encodeThrows = true
    const parameters: Record<string, unknown> = {}
    parameters.circular = parameters
    const valid: ToolDefinition = {
      name: 'bounded_tool',
      description: '',
      parameters: { type: 'object' },
    }
    expect(counter.countSync([MESSAGE], [valid])).toBeGreaterThan(framing(1))
    const invalid = { ...valid, parameters }
    expect(counter.countSync([MESSAGE], [invalid])).toBe(Number.MAX_SAFE_INTEGER)
  })
})
