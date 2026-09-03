import { describe, expect, it } from 'vitest'
import { validateDisplayField } from '../src/routes/admin/resourceFieldValidation.js'

describe('validateDisplayField', () => {
  it('accepts a normal single-line label', () => {
    expect(validateDisplayField('ok', 'f')).toBeNull()
  })

  it('skips an absent (undefined) field — presence is optional', () => {
    expect(validateDisplayField(undefined, 'f')).toBeNull()
  })

  it('rejects a non-string value', () => {
    const issue = validateDisplayField(42, 'field')
    expect(issue).not.toBeNull()
    expect(issue?.field).toBe('field')
    expect(issue?.message).toContain('must be a string')
  })

  // R4-M4: the C1 control block (\x80-\x9f) must be rejected like C0/DEL.
  describe('C1 control characters (R4-M4)', () => {
    it('rejects U+0085 NEL — a line terminator that breaks the single-line label', () => {
      const issue = validateDisplayField('abcd', 'field')
      expect(issue).not.toBeNull()
      expect(issue?.field).toBe('field')
      expect(issue?.message).toContain('control')
    })

    it('rejects U+009B CSI — opens an ANSI escape sequence', () => {
      const issue = validateDisplayField('abcd', 'field')
      expect(issue).not.toBeNull()
      expect(issue?.message).toContain('control')
    })
  })
})
