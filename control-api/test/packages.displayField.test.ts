import { describe, expect, it } from 'vitest'
import {
  CONTROL_CHAR_RE,
  DISPLAY_FIELD_MAX_LENGTH,
  validateDisplayField,
} from '@clerum/display-field'

// T1: the producer under test IS the shared package `@clerum/display-field`.
// This exercises the canonical rule directly (not via control-api's re-export),
// pinning the exact semantics both control-api and control-ui depend on.
describe('@clerum/display-field · validateDisplayField', () => {
  it('accepts a normal single-line label → null', () => {
    expect(validateDisplayField('My Host', 'spec.host')).toBeNull()
  })

  it('skips an absent (undefined) field → null (optional)', () => {
    expect(validateDisplayField(undefined, 'spec.host')).toBeNull()
  })

  it('rejects a non-string number → "must be a string" with field propagated', () => {
    const issue = validateDisplayField(42, 'spec.host')
    expect(issue).not.toBeNull()
    expect(issue?.field).toBe('spec.host')
    expect(issue?.message).toContain('must be a string')
  })

  it('rejects a non-string object → "must be a string"', () => {
    const issue = validateDisplayField({}, 'spec.displayName')
    expect(issue).not.toBeNull()
    expect(issue?.field).toBe('spec.displayName')
    expect(issue?.message).toContain('must be a string')
  })

  describe('control / bidi characters → "control..." with field propagated', () => {
    const cases: Array<[string, string]> = [
      ['C0 (\\x01)', 'a\x01b'],
      ['C1 U+0085 NEL', 'a\u0085b'],
      ['C1 U+009B CSI', 'a\u009bb'],
      ['bidi U+202E RLO', 'a\u202eb'],
      ['line separator U+2028', 'a\u2028b'],
      ['paragraph separator U+2029', 'a\u2029b'],
    ]
    for (const [label, value] of cases) {
      it(`rejects ${label}`, () => {
        const issue = validateDisplayField(value, 'spec.host')
        expect(issue).not.toBeNull()
        expect(issue?.field).toBe('spec.host')
        expect(issue?.message).toContain('control')
      })
    }
  })

  // T5: the "Deliberately NOT rejected" comment in index.cjs is a security
  // invariant (over-rejecting would break valid emoji/RTL display names). Pin the
  // boundary the Trojan-Source rationale depends on: these pass BY DESIGN.
  describe('deliberately allowed characters → null (must not over-reject)', () => {
    const allowed: Array<[string, string]> = [
      ['ZWJ U+200D (emoji sequences)', 'a‍b'],
      ['ZWSP U+200B', 'a​b'],
      ['ZWNJ U+200C', 'a‌b'],
      ['LRM U+200E', 'a‎b'],
      ['RLM U+200F', 'a‏b'],
      ['ALM U+061C', 'a؜b'],
      ['word joiner U+2060', 'a⁠b'],
      ['BOM/ZWNBSP U+FEFF', 'a﻿b'],
    ]
    for (const [label, value] of allowed) {
      it(`accepts ${label}`, () => {
        expect(validateDisplayField(value, 'spec.host')).toBeNull()
      })
    }
  })

  it('rejects the empty string → "empty or whitespace-only"', () => {
    const issue = validateDisplayField('', 'spec.host')
    expect(issue).not.toBeNull()
    expect(issue?.message).toContain('empty or whitespace-only')
  })

  it('rejects a whitespace-only string → "empty or whitespace-only"', () => {
    const issue = validateDisplayField('   ', 'spec.host')
    expect(issue).not.toBeNull()
    expect(issue?.message).toContain('empty or whitespace-only')
  })

  it(`rejects ${DISPLAY_FIELD_MAX_LENGTH + 1} chars → "at most ${DISPLAY_FIELD_MAX_LENGTH}"`, () => {
    const issue = validateDisplayField('a'.repeat(DISPLAY_FIELD_MAX_LENGTH + 1), 'spec.host')
    expect(issue).not.toBeNull()
    expect(issue?.field).toBe('spec.host')
    expect(issue?.message).toContain(`at most ${DISPLAY_FIELD_MAX_LENGTH}`)
  })

  it(`accepts exactly ${DISPLAY_FIELD_MAX_LENGTH} chars → null`, () => {
    expect(validateDisplayField('a'.repeat(DISPLAY_FIELD_MAX_LENGTH), 'spec.host')).toBeNull()
  })

  it('exposes the canonical constants', () => {
    expect(DISPLAY_FIELD_MAX_LENGTH).toBe(120)
    expect(CONTROL_CHAR_RE).toBeInstanceOf(RegExp)
    expect(CONTROL_CHAR_RE.test('a\x01b')).toBe(true)
    expect(CONTROL_CHAR_RE.test('clean')).toBe(false)
  })
})
