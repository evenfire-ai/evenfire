import { describe, expect, it } from 'vitest'
import { composerImageBudgetBytes } from '../attachments'

describe('composerImageBudgetBytes', () => {
  it('counts the decoded bytes of canonical base64 the way rpc-proxy and mcp-host do', () => {
    // The PNG signature: 12 characters with one `=` decode to 8 bytes.
    const signature = 'iVBORw0KGgo='
    expect(composerImageBudgetBytes(signature, 'decoded')).toBe(8)
    expect(composerImageBudgetBytes(signature, 'decoded')).toBe(atob(signature).length)
    expect(composerImageBudgetBytes('AA==', 'decoded')).toBe(1)
    expect(composerImageBudgetBytes('AAAA', 'decoded')).toBe(3)
  })

  it('refuses base64 whose length is not a multiple of four instead of measuring it', () => {
    // Witness: the canonical value of the same bytes is measured.
    expect(composerImageBudgetBytes('iVBORw0KGgo=', 'decoded')).toBe(8)
    for (const malformed of ['iVBORw0KGgo', 'iVBORw0KGgo==', 'A', 'AAAAA']) {
      expect(() => composerImageBudgetBytes(malformed, 'decoded'), malformed).toThrow(
        'Image data is not canonical base64.'
      )
    }
  })
})
