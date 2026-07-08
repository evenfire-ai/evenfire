import { describe, expect, it } from 'vitest'
import { redactArtifactBuffer } from '../../artifacts/artifactRedaction'

describe('redactArtifactBuffer', () => {
  it('redacts longer overlapping secret values before shorter substrings', () => {
    const longSecret = 'XAABBYY'
    const shortSecret = 'AABB'
    const { buffer, redactedCount } = redactArtifactBuffer(Buffer.from(longSecret, 'utf-8'), [
      { name: 'SHORT', value: shortSecret },
      { name: 'LONG', value: longSecret },
    ])

    expect(redactedCount).toBe(1)
    expect(buffer.toString('utf-8')).toBe('[REDACTED:LONG]')
  })
})
