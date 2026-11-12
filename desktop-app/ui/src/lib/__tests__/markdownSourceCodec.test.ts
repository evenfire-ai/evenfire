import { describe, expect, it } from 'vitest'
import { decodeMarkdownSource, encodeMarkdownSource } from '../markdownSourceCodec'

describe('Markdown source codec', () => {
  it('preserves a UTF-8 BOM byte-for-byte across an unchanged edit buffer', () => {
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Café')])
    const decoded = decodeMarkdownSource(original)

    expect(decoded.startsWith('\uFEFF')).toBe(true)
    expect(encodeMarkdownSource(decoded)).toEqual(original)
  })

  it('rejects malformed and truncated UTF-8 instead of creating replacement text', () => {
    expect(() => decodeMarkdownSource(new Uint8Array([0x23, 0x20, 0xc3]))).toThrow()
    expect(() => decodeMarkdownSource(new Uint8Array([0xff, 0xfe, 0x23]))).toThrow()
  })

  it('keeps the BOM when the user edits a supported BOM-prefixed file', () => {
    const decoded = decodeMarkdownSource(new Uint8Array([0xef, 0xbb, 0xbf, 0x23]))
    const edited = decoded.replace('#', '# Edited')
    expect(encodeMarkdownSource(edited).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
  })
})
