import { describe, expect, it, vi } from 'vitest'
import { type Tiktoken, get_encoding } from 'tiktoken'
import { ENCODE_SLICE_UTF16_UNITS, encodeLength } from '../encodeLength'

const encoder = get_encoding('cl100k_base')

describe('encodeLength', () => {
  it('treats special-token syntax as ordinary text instead of throwing', () => {
    const text = 'before <|endoftext|> after'
    // Raw tiktoken rejects this shape; the helper must count it.
    expect(() => encoder.encode(text)).toThrow(/special token/)
    expect(encodeLength(encoder, text)).toBe(encoder.encode(text, [], []).length)
  })

  it('returns 0 for the empty string', () => {
    expect(encodeLength(encoder, '')).toBe(0)
  })

  it('matches whole-string encoding for long ASCII runs', () => {
    const text = 'a'.repeat(10_000)
    expect(encodeLength(encoder, text)).toBe(encoder.encode(text, [], []).length)
  })

  it('keeps the token count at a slice boundary', () => {
    const boundary = ENCODE_SLICE_UTF16_UNITS
    for (const text of [
      'x'.repeat(boundary),
      'x'.repeat(boundary + 1),
      'x'.repeat(boundary - 1),
      'y'.repeat(boundary * 3 + 7),
    ]) {
      expect(encodeLength(encoder, text)).toBe(encoder.encode(text, [], []).length)
    }
  })

  it('never splits a surrogate pair at the slice boundary', () => {
    // Position the emoji so its high surrogate is the last unit of slice 1.
    const text = 'z'.repeat(ENCODE_SLICE_UTF16_UNITS - 1) + '😀' + 'q'.repeat(64)
    const sliced = encodeLength(encoder, text)
    expect(sliced).toBe(encoder.encode(text, [], []).length)
    // An unpaired surrogate would be replaced with U+FFFD and change the count.
    expect(sliced).toBeGreaterThan(0)
    expect(sliced).not.toBe(encodeLength(encoder, text.replace('😀', '\uFFFD')))
  })

  it('never under-counts a separator-free mix of CJK, emoji and dense runs', () => {
    const dense = 'x'.repeat(ENCODE_SLICE_UTF16_UNITS * 2)
    const cjk = '日本語テキストです'.repeat(40)
    const emoji = '😀🎉🚀'.repeat(37)
    for (const text of [dense, cjk, emoji, cjk + emoji + dense]) {
      const whole = encoder.encode(text, [], []).length
      const sliced = encodeLength(encoder, text)
      // A hard cut inside a dense run may over-count by a token or two; it must
      // never lose tokens, because an under-count is what overflows a budget.
      expect(sliced).toBeGreaterThanOrEqual(whole)
      expect(sliced - whole).toBeLessThanOrEqual(2)
    }
  })

  it('matches whole-string encoding exactly when every chunk ends at a clean line break', () => {
    const lines: string[] = []
    for (let i = 0; i < 80; i++) lines.push(`row-${i.toString().padStart(4, '0')}=ok`)
    const text = `${lines.join('\n')}\n`
    expect(text.length).toBeLessThan(ENCODE_SLICE_UTF16_UNITS)
    expect(encodeLength(encoder, text)).toBe(encoder.encode(text, [], []).length)
    const repeated = text.repeat(3)
    expect(repeated.length).toBeGreaterThan(ENCODE_SLICE_UTF16_UNITS)
    expect(encodeLength(encoder, repeated)).toBe(encoder.encode(repeated, [], []).length)
  })

  it('stays within two tokens of whole-string encoding on separated real text', () => {
    const lines: string[] = []
    for (let i = 0; i < 120; i++) {
      lines.push(`line ${i}: 日本語テキスト 😀🎉 ${'q'.repeat(24)}`)
    }
    const text = `${lines.join('\n')}\n`
    expect(text.length).toBeGreaterThan(ENCODE_SLICE_UTF16_UNITS * 2)
    const whole = encoder.encode(text, [], []).length
    const sliced = encodeLength(encoder, text)
    // Greedy pre-tokenization at a cut can over-count by one token. The
    // bounded guarantee for real text is: never lose tokens, drift <= 2.
    expect(sliced).toBeGreaterThanOrEqual(whole)
    expect(sliced - whole).toBeLessThanOrEqual(2)
  })

  it('keeps every slice at or below the UTF-16 bound', () => {
    const dense = 'x'.repeat(ENCODE_SLICE_UTF16_UNITS * 5 + 17)
    const text = `head\n${dense}\ntail`
    const encode = vi.fn((slice: string) => new Uint32Array(slice.length))
    expect(encodeLength({ encode } as unknown as Tiktoken, text)).toBe(text.length)
    expect(encode.mock.calls.length).toBeGreaterThan(1)
    for (const [slice] of encode.mock.calls) {
      expect(slice.length).toBeLessThanOrEqual(ENCODE_SLICE_UTF16_UNITS)
    }
  })

  it('passes complete surrogate pairs and explicit special-token options to each real call', () => {
    const text = 'z'.repeat(1023) + '😀' + 'x'.repeat(4096) + '<|endoftext|>'
    const encode = vi.fn((slice: string, allowed: string[], disallowed: string[]) => {
      expect(new TextDecoder().decode(new TextEncoder().encode(slice))).toBe(slice)
      expect(allowed).toEqual([])
      expect(disallowed).toEqual([])
      return new Uint32Array(1)
    })
    expect(encodeLength({ encode } as unknown as Tiktoken, text)).toBeGreaterThan(1)
    expect(encode.mock.calls.map(([slice]) => slice).join('')).toBe(text)
  })

  it('matches whole-string encoding exactly for line-oriented content', () => {
    const logs =
      '2026-10-02T19:00:00Z INFO host=control-api msg="request completed" status=200 ms=42 path=/v1/runtime\n'.repeat(
        500
      )
    const fences = '```ts\nconst x: number = 1\nexport { x }\n```\n'.repeat(300)
    const jsonl = Array.from(
      { length: 500 },
      (_, i) => `{"i":${i},"kind":"page","bytes":65536,"ok":true}`
    )
      .join('\n')
      .concat('\n')
    for (const text of [logs, fences, jsonl]) {
      expect(text.length).toBeGreaterThan(ENCODE_SLICE_UTF16_UNITS * 2)
      expect(encodeLength(encoder, text)).toBe(encoder.encode(text, [], []).length)
    }
  })

  it('stays under 1% over-count on prose with multibyte characters', () => {
    const proseEs =
      'La plataforma procesa documentos adjuntos y los pagina por rango de bytes sin romper caracteres multibyte. '.repeat(
        90
      )
    const proseEn =
      'The service streams attachment pages in bounded windows and never splits a multi byte character or a surrogate pair. '.repeat(
        70
      )
    for (const text of [proseEs, proseEn]) {
      const whole = encoder.encode(text, [], []).length
      const sliced = encodeLength(encoder, text)
      expect(sliced).toBeGreaterThanOrEqual(whole)
      expect((sliced - whole) / whole).toBeLessThan(0.01)
    }
  })
})
