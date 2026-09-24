import { describe, expect, it } from 'vitest'
import { BasicSafety } from '../../safety/safety'
import { AUTO_TITLE_MAX_CODE_POINTS, AUTO_TITLE_SUFFIX, deriveAutoTitle } from '../sessionTitle'

describe('deriveAutoTitle — pure truncation (spec 15 §2.4)', () => {
  it('returns a short input unchanged', () => {
    expect(deriveAutoTitle('Plan my trip to Japan')).toBe('Plan my trip to Japan')
  })

  it('collapses whitespace runs (newlines, tabs, multiple spaces) to single spaces', () => {
    expect(deriveAutoTitle('hello \n\t  world\n\nagain')).toBe('hello world again')
  })

  it('trims leading/trailing whitespace', () => {
    expect(deriveAutoTitle('   spaced out   ')).toBe('spaced out')
  })

  it('truncates at the last space within the first 60 code points and appends the suffix', () => {
    // 12 words of 6 chars ("abcdef") joined by spaces → far over 60 chars, with
    // spaces available inside the first 60. Cut must land on a word boundary.
    const input = Array.from({ length: 12 }, () => 'abcdef').join(' ')
    const out = deriveAutoTitle(input)
    expect(out.endsWith(AUTO_TITLE_SUFFIX)).toBe(true)
    const content = out.slice(0, -AUTO_TITLE_SUFFIX.length)
    // No trailing space before the suffix (cut excludes the space).
    expect(content.endsWith(' ')).toBe(false)
    expect(Array.from(content).length).toBeLessThanOrEqual(AUTO_TITLE_MAX_CODE_POINTS)
    // Cut is on a boundary, so the content is a whole-word prefix of the input.
    expect(input.startsWith(content)).toBe(true)
  })

  it('BUG GUARD (§2.4): no space in the first 60 chars → hard cut at 60, NOT the bare suffix', () => {
    // The client's `substring(0, lastIndexOf(' ',60) || 60)` yields "…" here
    // because lastIndexOf returns -1. This must NEVER happen.
    const input = 'x'.repeat(100)
    const out = deriveAutoTitle(input)
    expect(out).not.toBe(AUTO_TITLE_SUFFIX)
    expect(out).toBe('x'.repeat(60) + AUTO_TITLE_SUFFIX)
    expect(Array.from(out).length).toBe(61)
  })

  it('strips bidi overrides and zero-width chars (channel input is stored verbatim, §6)', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE inside a word, and U+200B ZERO WIDTH SPACE
    // between two letters. JS `\s` matches neither, so plain collapse leaves them.
    const bidi = 'abc‮def'
    const zeroWidth = 'a​b'
    const bidiOut = deriveAutoTitle(bidi)
    const zwOut = deriveAutoTitle(zeroWidth)

    expect(bidiOut).toBe('abcdef')
    expect(zwOut).toBe('ab')
    // No invisible control/format code point survives in either title.
    expect(/\p{C}/u.test(bidiOut)).toBe(false)
    expect(/\p{C}/u.test(zwOut)).toBe(false)
  })

  it('folds a newline into a space instead of deleting it (no word-join)', () => {
    // Guards the strip order: `\n` is a `\p{C}` control char, so a naive
    // strip-before-collapse would yield "helloworld".
    expect(deriveAutoTitle('hello\nworld')).toBe('hello world')
  })

  it('counts code points, not UTF-16 units, so a surrogate pair is never split', () => {
    // 😀 is a surrogate pair (2 UTF-16 units, 1 code point). 70 of them exceed
    // the 60 code-point cap; a UTF-16-based cut would slice a pair in half.
    const input = '😀'.repeat(70)
    const out = deriveAutoTitle(input)
    const content = out.slice(0, out.length - AUTO_TITLE_SUFFIX.length)
    // Content must be exactly 60 whole emoji — no lone surrogate.
    expect(Array.from(content)).toEqual(Array.from('😀'.repeat(60)))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
  })
})

describe('auto-title orchestration — redact BEFORE truncate (spec 15 §5)', () => {
  // Exercises the exact composition TaskExecutor uses: the REAL BasicSafety
  // producer (T1) redacts the full input, then deriveAutoTitle truncates. No
  // hand-built redaction fixture.
  const redactThenDerive = (input: string, secrets: Array<{ name: string; value: string }>) => {
    const safety = new BasicSafety(() => secrets)
    const redacted = safety.sanitizeFreeformContent(input, {
      secretWarning: 'Potential secret detected in session title',
    }).content
    return deriveAutoTitle(redacted)
  }

  it('redacts a secret that straddles the 60-code-point cut so it never survives into the title', () => {
    const secret = 'syntheticS3cretValueThatIsQuiteLongAndSpansTheBoundary1234567890'
    // Position the secret so it crosses index 60 of the raw input.
    const prefix = 'my api key is '.padEnd(40, 'z') + ' '
    const input = `${prefix}${secret} and more trailing text here`
    expect(input.indexOf(secret)).toBeLessThan(60)
    expect(input.indexOf(secret) + secret.length).toBeGreaterThan(60)

    const title = redactThenDerive(input, [{ name: 'API_KEY', value: secret }])

    // The literal secret (or any prefix of it long enough to leak) must be gone.
    expect(title.includes(secret)).toBe(false)
    expect(title.includes(secret.slice(0, 20))).toBe(false)
    expect(title.includes('[REDACTED:API_KEY]')).toBe(true)
  })

  it('redacts a well-known secret shape (regex) before truncating', () => {
    const input =
      'here is a token AKIAIOSFODNN7EXAMPLE plus a long tail of words to force truncation'
    const title = redactThenDerive(input, [])
    expect(title.includes('AKIAIOSFODNN7EXAMPLE')).toBe(false)
  })
})
