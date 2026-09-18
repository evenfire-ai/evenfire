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
 * - remove non-whitespace C0/C1 control characters (whitespace controls such as
 *   tab/newline survive removal so they can be collapsed, not dropped);
 * - remove bidi overrides/embeddings/isolates and zero-width / BOM code points;
 * - collapse any run of whitespace to a single space and trim;
 * - truncate to `MAX_TAB_TITLE_LEN` code points, replacing the tail with an
 *   ellipsis so the result never exceeds the bound;
 * - an input that is empty after sanitizing yields `''`: the caller keeps the
 *   previous title rather than blanking the tab.
 *
 * The denylist is declared as numeric code-point ranges and compiled with
 * `new RegExp`, NOT written as embedded literal bytes or `\u` escapes. A
 * security denylist built from invisible characters can be mutated with no
 * visible diff by an editor or formatter pass; numeric ranges keep every
 * stripped span legible and diff-safe in review, and the compiled regex still
 * matches the exact code points.
 *
 * Ranges: non-whitespace C0 (U+0000-U+0008, U+000E-U+001F), DEL + C1
 * (U+007F-U+009F), zero-width (U+200B-U+200D), bidi overrides/embeddings
 * (U+202A-U+202E), bidi isolates (U+2066-U+2069), and BOM/ZWNBSP (U+FEFF).
 * U+0009-U+000D (tab, LF, VT, FF, CR) are intentionally NOT removed here: they
 * are whitespace and collapse to a single space in the next step.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200d],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
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
