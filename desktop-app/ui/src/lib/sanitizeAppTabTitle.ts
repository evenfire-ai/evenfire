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
 * - remove every code point that Unicode itself defines as non-rendering — the
 *   control category `\p{Cc}` (minus whitespace, handled below) and the
 *   `Default_Ignorable_Code_Point` set (bidi marks/overrides/embeddings/
 *   isolates, zero-width formatters, word joiner, BOM, Hangul fillers, the
 *   astral tag characters, and the rest of the standard's "ignore in rendering"
 *   set) — plus the interlinear-annotation anchors U+FFF9–U+FFFB;
 * - collapse any run of whitespace to a single space and trim;
 * - truncate to `MAX_TAB_TITLE_LEN` code points, replacing the tail with an
 *   ellipsis so the result never exceeds the bound;
 * - an input that is empty after sanitizing yields `''`: the caller keeps the
 *   previous title rather than blanking the tab.
 *
 * WHY the `Default_Ignorable_Code_Point` PROPERTY and not an enumerated list of
 * ranges: an enumerated denylist of invisible characters is never finished —
 * there is always one more zero-width code point to add, and each addition is a
 * new review round. `Default_Ignorable_Code_Point` is Unicode's own, versioned
 * definition of exactly "code points that should be ignored in rendering" — the
 * invisible set. It ALREADY excludes the legitimate, VISIBLE script formatters
 * that a real title uses (e.g. U+0600–U+0605 and U+06DD ARABIC END OF AYAH,
 * U+070F SYRIAC ABBREVIATION MARK, U+110BD/U+110CD Kaithi, U+13430–U+13440
 * Egyptian-hieroglyph controls), so they survive with no per-code-point
 * carve-out. The runtime resolves the property from its own Unicode version
 * (Chromium in the renderer, Node under test); the ignorable ranges are stable
 * by design, including the unassigned tail of the tag / plane-14 blocks.
 *
 * TWO invisible-but-SHAPING exceptions are kept, because they change the
 * rendering of the ADJACENT glyph rather than being pure decoration:
 * - `\p{Join_Control}` — ZWJ (U+200D) fuses an emoji sequence into one glyph
 *   (stripping it splits a "woman technologist" 👩‍💻 into a separate 👩 + 💻);
 *   ZWNJ (U+200C) controls ligatures/shaping in Persian and Indic scripts.
 * - `\p{Variation_Selector}` — VS16 (U+FE0F) is what makes ❤️ render as a
 *   coloured emoji rather than the text glyph ❤, keycaps (1️⃣) depend on it, and
 *   the ideographic selectors (U+E0100–U+E01EF) pick CJK glyph variants in real
 *   names. Stripping these silently corrupts a legitimate, visible title.
 *
 * Whitespace controls U+0009–U+000D are excluded from the `\p{Cc}` removal via
 * the `(?!\s)` guard: they must survive so the next step collapses them to a
 * single space instead of gluing adjacent words together. (U+0085 NEL is
 * `\p{Cc}` but not `\s`, so it is stripped, not kept.)
 *
 * U+FFF9–U+FFFB (interlinear annotation anchors) are the one range Unicode does
 * NOT count as Default_Ignorable, so they are named explicitly — as `\u` escapes,
 * never the literal invisible bytes, so an editor or formatter pass cannot mutate
 * this security denylist with no visible diff.
 *
 * NOT covered — deliberately: a title built only from visible-but-blank glyphs
 * (e.g. U+2800 BRAILLE PATTERN BLANK) renders as an empty-looking tab. No
 * invisible-character filter can catch that (the glyph is visible, just empty),
 * and it is not a spoofing vector here — the label is free text shown to its
 * own owner, never compared against a trusted string. It is a UX edge, not a
 * sanitizer gap.
 */
const STRIP_INVISIBLE =
  /(?!\s)\p{Cc}|(?![\p{Join_Control}\p{Variation_Selector}])\p{Default_Ignorable_Code_Point}|[\uFFF9-\uFFFB]/gu

export function sanitizeAppTabTitle(raw: string): string {
  const collapsed = raw.replace(STRIP_INVISIBLE, '').replace(/\s+/g, ' ').trim()
  // Count and slice by code point, not UTF-16 code unit, so truncation never
  // splits a surrogate pair and leaves a lone half dangling before the ellipsis.
  const points = Array.from(collapsed)
  if (points.length <= MAX_TAB_TITLE_LEN) return collapsed
  return `${points
    .slice(0, MAX_TAB_TITLE_LEN - 1)
    .join('')
    .trimEnd()}…`
}
