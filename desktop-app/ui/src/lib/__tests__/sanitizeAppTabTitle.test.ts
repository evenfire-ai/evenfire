import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MAX_TAB_TITLE_LEN } from '../../constants/workspaceTabs'
import { sanitizeAppTabTitle } from '../sanitizeAppTabTitle'

const cp = (code: number) => String.fromCodePoint(code)

// One representative code point per denylisted range. Asserted against the real
// sanitizer output (not a hand-copied regex), so a silent narrowing of the
// removal policy in the source fails this test.
const STRIPPED_REPRESENTATIVES: ReadonlyArray<readonly [string, number]> = [
  ['C0 low (U+0000–U+0008)', 0x0001],
  ['C0 high (U+000E–U+001F)', 0x000e],
  ['DEL (U+007F)', 0x007f],
  ['C1 (U+0080–U+009F)', 0x0085],
  ['zero-width space (U+200B)', 0x200b],
  ['LRM bidi mark (U+200E)', 0x200e],
  ['RLM bidi mark (U+200F)', 0x200f],
  ['ALM bidi mark (U+061C)', 0x061c],
  ['word joiner (U+2060)', 0x2060],
  ['bidi override (U+202A–U+202E)', 0x202e],
  ['bidi isolate (U+2066–U+2069)', 0x2066],
  ['BOM / ZWNBSP (U+FEFF)', 0xfeff],
  ['invisible tag char (U+E0001)', 0xe0001],
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

  it('preserves legitimate non-Latin script format characters (collateral of R3-M2)', () => {
    // The Cf category also holds script-shaping formatters that are real text,
    // not hazards. A category-based strip (\p{Cf}) corrupts them; the explicit
    // denylist must leave every one intact. Repro of the collateral regression:
    // 'سورة۝٢' carries U+06DD (ARABIC END OF AYAH), a visible verse ornament.
    const arabicAyah = `سورة${cp(0x06dd)}${cp(0x0662)}`
    expect(sanitizeAppTabTitle(arabicAyah)).toBe(arabicAyah)
    expect(sanitizeAppTabTitle(`a${cp(0x0600)}b`)).toBe(`a${cp(0x0600)}b`) // ARABIC NUMBER SIGN
    expect(sanitizeAppTabTitle(`a${cp(0x070f)}b`)).toBe(`a${cp(0x070f)}b`) // SYRIAC ABBREV MARK
    expect(sanitizeAppTabTitle(`a${cp(0x1d173)}b`)).toBe(`a${cp(0x1d173)}b`) // musical (astral)
  })

  it('preserves the ZWJ/ZWNJ shaping joiners (legitimate Unicode, not a hazard)', () => {
    // ZWJ (U+200D) fuses an emoji sequence into one glyph; stripping it splits
    // 👩‍💻 into 👩💻. ZWNJ (U+200C) controls shaping/ligatures in Persian and
    // Indic scripts. The denylist leaves the U+200C-U+200D gap open for both.
    const zwjEmoji = `Build ${cp(0x1f469)}${cp(0x200d)}${cp(0x1f4bb)}`
    expect(sanitizeAppTabTitle(zwjEmoji)).toBe(zwjEmoji)
    expect(sanitizeAppTabTitle(`a${cp(0x200c)}b`)).toBe(`a${cp(0x200c)}b`)
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
