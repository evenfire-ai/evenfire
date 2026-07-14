import { describe, expect, it } from 'vitest'
import { buildPastedValue } from '../pasteUtils'

function inputSelection(selectionStart: number | null, selectionEnd: number | null) {
  return { selectionStart, selectionEnd } as HTMLInputElement
}

describe('buildPastedValue', () => {
  it('inserts pasted text at the cursor', () => {
    expect(buildPastedValue('sk--123', 'pasted', inputSelection(3, 3))).toBe('sk-pasted-123')
  })

  it('replaces selected text with pasted text', () => {
    expect(buildPastedValue('sk-old-123', 'new', inputSelection(3, 6))).toBe('sk-new-123')
  })
})
