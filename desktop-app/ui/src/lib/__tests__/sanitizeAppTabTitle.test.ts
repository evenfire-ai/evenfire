import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MAX_TAB_TITLE_LEN } from '../../constants/workspaceTabs'
import { sanitizeAppTabTitle } from '../sanitizeAppTabTitle'

const cp = (code: number) => String.fromCodePoint(code)

// One representative code point per stripped range. Asserted against the real
// sanitizer output (not a hand-copied regex), so a silent deletion of any range
// from the source denylist fails this test.
const STRIPPED_REPRESENTATIVES: ReadonlyArray<readonly [string, number]> = [
  ['C0 low (U+0000–U+0008)', 0x0001],
  ['C0 high (U+000E–U+001F)', 0x000e],
  ['DEL (U+007F)', 0x007f],
  ['C1 (U+0080–U+009F)', 0x0085],
  ['zero-width (U+200B–U+200D)', 0x200c],
  ['bidi override (U+202A–U+202E)', 0x202e],
  ['bidi isolate (U+2066–U+2069)', 0x2066],
  ['BOM / ZWNBSP (U+FEFF)', 0xfeff],
]

const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('sanitizeAppTabTitle (mini-spec 08 §2)', () => {
  it('passes a normal title through, only trimming and collapsing whitespace', () => {
    expect(sanitizeAppTabTitle('  Ticket 42 — Acme  ')).toBe('Ticket 42 — Acme')
    expect(sanitizeAppTabTitle('Report  \t v2')).toBe('Report v2')
  })

  it('returns empty for a control / whitespace-only input', () => {
    expect(sanitizeAppTabTitle('')).toBe('')
    expect(sanitizeAppTabTitle('   \t\n ')).toBe('')
    expect(sanitizeAppTabTitle(`${cp(0x202e)}${cp(0x200b)}${cp(0xfeff)}`)).toBe('')
  })

  it('removes one representative from every stripped range', () => {
    for (const [label, code] of STRIPPED_REPRESENTATIVES) {
      expect(sanitizeAppTabTitle(`a${cp(code)}b`), label).toBe('ab')
    }
  })

  it('keeps whitespace control characters, collapsing them instead of dropping', () => {
    // U+0009–U+000D are NOT in the denylist: they must survive removal and fold
    // to a single space, not vanish and glue the words together.
    expect(sanitizeAppTabTitle('a\tb\nc')).toBe('a b c')
  })

  it('truncates to MAX_TAB_TITLE_LEN with a trailing ellipsis', () => {
    const out = sanitizeAppTabTitle('x'.repeat(MAX_TAB_TITLE_LEN + 50))
    expect(out.length).toBe(MAX_TAB_TITLE_LEN)
    expect(out.endsWith('…')).toBe(true)
  })

  it('truncates on a code-point boundary, never splitting a surrogate pair', () => {
    // Each 😀 is one code point / two UTF-16 code units. A code-unit slice would
    // cut the last pair in half and leave a lone high surrogate before the '…'.
    const out = sanitizeAppTabTitle('😀'.repeat(MAX_TAB_TITLE_LEN + 5))
    expect(hasLoneSurrogate(out)).toBe(false)
    expect(Array.from(out).length).toBeLessThanOrEqual(MAX_TAB_TITLE_LEN)
    expect(out.endsWith('…')).toBe(true)
  })

  it('property: output stays within the code-point bound, is idempotent, and never leaks a lone surrogate', () => {
    // A char generator biased toward the dangerous ranges the sanitizer targets
    // (control, bidi, zero-width, whitespace) mixed with printable ASCII AND
    // astral code points, so the fuzz exercises removal + collapse + code-point
    // truncation together — including the surrogate-boundary case.
    const titleChar = fc
      .oneof(
        fc.integer({ min: 0x20, max: 0x7e }),
        fc.integer({ min: 0x00, max: 0x1f }),
        fc.integer({ min: 0x1f300, max: 0x1faff }), // astral (emoji planes)
        fc.constantFrom(
          0x0007,
          0x001b,
          0x007f,
          0x0085,
          0x009f,
          0x2028,
          0x2029,
          0x200b,
          0x200d,
          0x202a,
          0x202e,
          0x2066,
          0x2069,
          0xfeff,
          0x09,
          0x0a,
          0x20
        )
      )
      .map(code => String.fromCodePoint(code))
    const titleArb = fc.array(titleChar, { maxLength: 200 }).map(chars => chars.join(''))
    fc.assert(
      fc.property(titleArb, raw => {
        const once = sanitizeAppTabTitle(raw)
        expect(Array.from(once).length).toBeLessThanOrEqual(MAX_TAB_TITLE_LEN)
        expect(hasLoneSurrogate(once)).toBe(false)
        expect(sanitizeAppTabTitle(once)).toBe(once)
      })
    )
  })
})
