import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  loadThrows: false,
  encodeThrows: false,
  encodeLengthThrows: false,
  metric: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../metrics', () => ({ tokenizerFallbackTotal: { inc: state.metric } }))
vi.mock('../../../logger', () => ({ logger: { warn: state.warn } }))

vi.mock('tiktoken', () => {
  const encoder = {
    encode: (text: string) => {
      if (state.encodeThrows) throw new Error('wasm crashed')
      // 1 token per UTF-16 unit: enough to tell the real path from the fallback.
      return new Uint32Array(text.length)
    },
  }
  return {
    get_encoding: () => {
      if (state.loadThrows) throw new Error('wasm unavailable')
      return encoder
    },
    encoding_for_model: () => encoder,
  }
})

vi.mock('../encodeLength', async importOriginal => {
  const actual = await importOriginal<typeof import('../encodeLength')>()
  return {
    ...actual,
    encodeLength: (...args: Parameters<typeof actual.encodeLength>) => {
      if (state.encodeLengthThrows) throw new Error('encode exploded')
      return actual.encodeLength(...args)
    },
  }
})

async function loadEstimate() {
  vi.resetModules()
  const { bpeTokenEstimate } = await import('../bpeEstimate')
  return bpeTokenEstimate
}

describe('bpeTokenEstimate — encoder failure fallback', () => {
  beforeEach(() => {
    state.loadThrows = false
    state.encodeThrows = false
    state.encodeLengthThrows = false
    state.metric.mockClear()
    state.warn.mockClear()
  })

  it('uses the real encoder while it works', async () => {
    const estimate = await loadEstimate()
    expect(estimate('abcd')).toBe(4)
  })

  it('returns the exact UTF-8 byte length when the encoder cannot load', async () => {
    state.loadThrows = true
    const estimate = await loadEstimate()
    const text = '日本語テキストです'
    expect(estimate(text)).toBe(Buffer.byteLength(text, 'utf8'))
    expect(estimate(text)).toBe(Buffer.byteLength(text, 'utf8'))
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(state.metric).toHaveBeenCalledWith({ provider: 'openai', reason: 'bpe_estimate_failed' })
  })

  it('returns the exact UTF-8 byte length when an encode fails', async () => {
    const estimate = await loadEstimate()
    state.encodeThrows = true
    const text = '😀🎉 emoji and more'
    expect(() => estimate(text)).not.toThrow()
    expect(estimate(text)).toBe(Buffer.byteLength(text, 'utf8'))
    state.encodeThrows = false
    expect(estimate('abcd')).toBe(4)
  })

  it('returns the exact UTF-8 byte length when the length helper throws and then recovers', async () => {
    const estimate = await loadEstimate()
    state.encodeLengthThrows = true
    const text = 'fallback please'
    expect(estimate(text)).toBe(Buffer.byteLength(text, 'utf8'))
    state.encodeLengthThrows = false
    expect(estimate('abcd')).toBe(4)
  })

  it('returns 0 for empty text on every path', async () => {
    const estimate = await loadEstimate()
    expect(estimate('')).toBe(0)
    state.loadThrows = true
    const failed = await loadEstimate()
    expect(failed('')).toBe(0)
  })
})
