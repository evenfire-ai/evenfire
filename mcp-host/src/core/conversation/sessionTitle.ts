import {
  MAX_SESSION_TITLE_BYTES,
  MAX_SESSION_TITLE_CODE_POINTS,
  normalizeSessionTitle,
} from '@clerum/action-context-contracts'

/**
 * Pure derivation of the server-authoritative auto-title for a session's first
 * turn (spec 15, Fase A). The title is materialized once, on turn 1, into
 * `sessions.title` via COALESCE and projected to the desktop catalog so a client
 * with no local cache no longer has to fabricate a `Remote · <id>` placeholder.
 *
 * This helper is deliberately NOT responsible for redaction: the caller
 * (TaskExecutor) redacts the FULL user input with the operator secret list
 * BEFORE calling this, because truncating first would break literal secret
 * matching (a value split across the 60-code-point cut would never match). The
 * fixed order is: redact(full input) → deriveAutoTitle (normalize + strip
 * invisibles + collapse + truncate).
 *
 * The first input can come from a third party (channel sessions: Slack/Telegram)
 * and is stored verbatim, so this also normalizes (NFC) and strips invisible
 * control/format code points — bidi overrides (U+202A–202E, U+2066–2069) and
 * zero-width chars that JS `\s` does not match and that could spoof or hide text
 * in the title. Redaction tokens (`[REDACTED:…]`) contain none of these, so they
 * pass through intact.
 */

/** Single suffix for a truncated title, shared so client/server stay unified. */
export const AUTO_TITLE_SUFFIX = '…' // … (U+2026 HORIZONTAL ELLIPSIS)

/**
 * Maximum length of the title *content* (excluding the suffix), counted in
 * Unicode code points — never UTF-16 units — so a surrogate pair (emoji, etc.)
 * is never sliced in half.
 */
export const AUTO_TITLE_MAX_CODE_POINTS = 60

/** Rename caps (spec 15 §5). Code-point cap for BMP text; byte cap binds first
 *  for astral-heavy titles (up to 4 bytes/code point). */
export const MAX_TITLE_CODE_POINTS = MAX_SESSION_TITLE_CODE_POINTS
export const MAX_TITLE_BYTES = MAX_SESSION_TITLE_BYTES

/**
 * Shared text-sanitization core for BOTH the auto-title derivation and the
 * user rename (spec 15 §5, D4 — one implementation of the rule). Normalizes
 * and folds whitespace, strips invisible control/format code points, and
 * collapses/trims. Does NOT truncate and does NOT redact (the caller owns
 * redaction and any length policy).
 *
 * Order matters: fold `\s+` → space BEFORE stripping `\p{C}`, because `\n`/`\t`
 * are themselves `\p{C}` — a strip-before-collapse order would delete them and
 * glue two words together. A second collapse removes a double space left when a
 * stripped format char sat between two spaces.
 */
export const normalizeTitleText = normalizeSessionTitle

/**
 * Derive a short session title from a (already-redacted) user input.
 *
 * Rules (spec §2.4, with the client's `substring(0, lastIndexOf(' ',60) || 60)`
 * bug corrected — that expression yields the garbage title `"…"` when the first
 * 60 chars have no space, because `lastIndexOf` returns -1):
 *   1. NFC-normalize, fold whitespace, and strip invisible control/format chars.
 *   2. If ≤ 60 code points, return as-is.
 *   3. Otherwise cut at the last space within the first 60 code points; if there
 *      is no space, cut at 60 hard. Append the suffix in both cases.
 */
export function deriveAutoTitle(userInput: string): string {
  const collapsed = normalizeTitleText(userInput)
  // Code points, not UTF-16 units — Array.from iterates by code point.
  const codePoints = Array.from(collapsed)
  if (codePoints.length <= AUTO_TITLE_MAX_CODE_POINTS) return collapsed

  // Last space strictly within the first MAX code points. `> 0` (not `>= 0`)
  // guards against an empty content slice — a leading space cannot occur here
  // because collapse trims, but this keeps the invariant explicit.
  let lastSpace = -1
  for (let i = 0; i < AUTO_TITLE_MAX_CODE_POINTS; i++) {
    if (codePoints[i] === ' ') lastSpace = i
  }
  const cut = lastSpace > 0 ? lastSpace : AUTO_TITLE_MAX_CODE_POINTS
  return codePoints.slice(0, cut).join('') + AUTO_TITLE_SUFFIX
}
