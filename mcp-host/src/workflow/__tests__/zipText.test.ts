/**
 * keepZipTextWhole changes JSZip for the whole process, so these tests pin what
 * it changes: a text part is written as the UTF-8 of its string, which is what
 * JSZip writes anyway unless a character straddles one of its 16K chunks.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { keepZipTextWhole } from '../zipText'

// An emoji whose surrogate pair straddles JSZip's 16K-character chunk edge.
const EDGE = `${'a'.repeat(16383)}\u{1F600}tail`

async function roundTrip(parts: Record<string, [string | Buffer, JSZip.JSZipFileOptions?]>) {
  const zip = new JSZip()
  for (const [name, [data, options]] of Object.entries(parts)) zip.file(name, data, options)
  return JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('keepZipTextWhole', () => {
  it('is needed: without it a character at a chunk edge is written as U+FFFD', async () => {
    const out = await roundTrip({ 'e.xml': [EDGE] })
    expect(await out.file('e.xml')!.async('string')).toContain('�')
  })

  it('writes every part as before, and the character at the edge whole', async () => {
    keepZipTextWhole()
    keepZipTextWhole()
    const plain = 'héllo <x a="1"/>'.repeat(5000)
    const out = await roundTrip({
      'e.xml': [EDGE],
      'p.xml': [plain],
      'b.bin': [Buffer.from([1, 2, 3])],
      's.b64': ['AQID', { base64: true }],
      'r.bin': ['\u0001\u0002\u0003', { binary: true }],
    })
    expect(await out.file('e.xml')!.async('string')).toBe(EDGE)
    expect(await out.file('p.xml')!.async('string')).toBe(plain)
    expect([...(await out.file('b.bin')!.async('nodebuffer'))]).toEqual([1, 2, 3])
    expect([...(await out.file('s.b64')!.async('nodebuffer'))]).toEqual([1, 2, 3])
    expect([...(await out.file('r.bin')!.async('nodebuffer'))]).toEqual([1, 2, 3])
  })
})
