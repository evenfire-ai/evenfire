import { describe, expect, it } from 'vitest'
import { validateDisplayField } from '../src/routes/admin/resourceFieldValidation.js'

// R4-M1 (producer side): empty / whitespace-only must be rejected. The edit UI
// never sends '' (it omits the field), so rejecting does not break "clear".
describe('validateDisplayField — empty / whitespace-only (R4-M1)', () => {
  it('accepts a normal single-line label', () => {
    expect(validateDisplayField('ok', 'f')).toBeNull()
  })

  it('skips an absent (undefined) field — presence is optional', () => {
    expect(validateDisplayField(undefined, 'f')).toBeNull()
  })

  it('rejects the empty string', () => {
    const issue = validateDisplayField('', 'f')
    expect(issue).not.toBeNull()
    expect(issue?.field).toBe('f')
    expect(issue?.message).toContain('empty or whitespace-only')
  })

  it('rejects a whitespace-only string', () => {
    const issue = validateDisplayField('   ', 'f')
    expect(issue).not.toBeNull()
    expect(issue?.message).toContain('empty or whitespace-only')
  })
})
