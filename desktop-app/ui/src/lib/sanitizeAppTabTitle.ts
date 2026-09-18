import { MAX_TAB_TITLE_LEN } from '../constants/workspaceTabs'

/**
 * Sanitize a plugin-controlled app tab title before it reaches the host chrome
 * (mini-spec 08 §2). An app embed's `document.title` is attacker-influenceable,
 * so a raw title can carry control characters, bidi overrides, or invisible
 * code points that corrupt the tab strip layout, the visual order of labels, or
 * the accessible names of the tab and its close button, and can be arbitrarily
 * long. This is the single entry-border sanitizer; every render site inherits
 * the cleaned value from the store, so none re-sanitizes.
 *
 * The contract (pure, idempotent: `sanitize(sanitize(x)) === sanitize(x)`):
 * - remove the code points in `UNSAFE_RANGES` — non-whitespace C0/C1 controls,
 *   DEL, the bidi marks/overrides/embeddings/isolates, zero-width and other
 *   invisible formatters, BOM, interlinear-annotation anchors, and the astral
 *   Unicode tag characters;
 * - collapse any run of whitespace to a single space and trim;
 * - truncate to `MAX_TAB_TITLE_LEN` code points, replacing the tail with an
 *   ellipsis so the result never exceeds the bound;
 * - an input that is empty after sanitizing yields `''`: the caller keeps the
 *   previous title rather than blanking the tab.
 *
 * WHY an explicit numeric-range denylist and NOT the Unicode categories
 * `\p{Cc}\p{Cf}`: the format category `\p{Cf}` also contains legitimate,
 * script-shaping code points that real titles use and must survive — e.g. the
 * Arabic sign/number marks (U+0600-U+0605, U+06DD ARABIC END OF AYAH, a VISIBLE
 * ornament around a verse number), the Syriac abbreviation mark (U+070F), Kaithi
 * (U+110BD/U+110CD), Egyptian-hieroglyph format controls (U+13430-U+13440), and
 * musical-notation formatters (U+1D173-U+1D17A). Stripping the whole Cf category
 * corrupts non-Latin text; the denylist targets only the actual layout/order/
 * invisibility hazards and leaves every legitimate script formatter alone.
 *
 * The denylist is declared as numeric code-point ranges and compiled with
 * `new RegExp`, NOT written as embedded literal bytes or `\u` escapes. A
 * security denylist built from invisible characters can be mutated with no
 * visible diff by an editor or formatter pass; numeric ranges keep every
 * stripped span legible and diff-safe in review, and the compiled regex still
 * matches the exact code points. The `u` flag lets a range whose bounds are
 * built with `String.fromCodePoint` (e.g. the astral tag chars U+E0000-U+E007F)
 * match those code points singly rather than as surrogate halves.
 *
 * U+0009-U+000D (tab, LF, VT, FF, CR) are intentionally absent from the denylist:
 * they are whitespace, survive the removal, and collapse to a single space in the
 * next step rather than gluing adjacent words together.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008], // C0 controls (excludes tab/LF/VT/FF/CR)
  [0x000e, 0x001f], // C0 controls (excludes CR)
  [0x007f, 0x009f], // DEL + C1 controls
  [0x061c, 0x061c], // ARABIC LETTER MARK (bidi)
  [0x200b, 0x200d], // ZWSP, ZWNJ, ZWJ (zero-width)
  [0x200e, 0x200f], // LRM, RLM (bidi marks)
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO (bidi embeddings/overrides)
  [0x2060, 0x2064], // WORD JOINER + invisible math operators
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI (bidi isolates)
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0xe0000, 0xe007f], // Unicode tag characters (astral; invisible fingerprinting)
]

const STRIP_UNSAFE_CHARS = new RegExp(
  `[${UNSAFE_RANGES.map(([lo, hi]) =>
    lo === hi ? String.fromCodePoint(lo) : `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`
  ).join('')}]`,
  'gu'
)

export function sanitizeAppTabTitle(raw: string): string {
  const collapsed = raw.replace(STRIP_UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim()
  // Count and slice by code point, not UTF-16 code unit, so truncation never
  // splits a surrogate pair and leaves a lone half dangling before the ellipsis.
  const points = Array.from(collapsed)
  if (points.length <= MAX_TAB_TITLE_LEN) return collapsed
  return `${points
    .slice(0, MAX_TAB_TITLE_LEN - 1)
    .join('')
    .trimEnd()}…`
}
