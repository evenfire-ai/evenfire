import { describe, expect, it } from 'vitest'
import { readUpstreamErrorHint } from '../src/grokTransport'

describe('readUpstreamErrorHint', () => {
  it('returns a collapsed, capped hint from the upstream error body', async () => {
    const body = '{\n  "error": "client version is no longer supported",\n  "code": 426\n}'
    await expect(readUpstreamErrorHint({ text: async () => body })).resolves.toBe(
      '{ "error": "client version is no longer supported", "code": 426 }'
    )
  })

  it('drops credential-shaped values and caps the length', async () => {
    const token = 'a'.repeat(64)
    const hint = await readUpstreamErrorHint({
      text: async () => `unauthorized: Bearer ${token} for key=${token} ${'x'.repeat(600)}`,
    })
    expect(hint).not.toContain(token)
    expect(hint).toContain('[redacted]')
    expect(hint.length).toBeLessThanOrEqual(300)
  })

  it('is empty when the body cannot be read', async () => {
    await expect(
      readUpstreamErrorHint({
        text: async () => {
          throw new Error('stream closed')
        },
      })
    ).resolves.toBe('')
  })
})
