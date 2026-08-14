'use strict'

/**
 * Shared free-text display-field validation — the single source of truth for the
 * rule that both control-api (admin CRUD) and control-ui (edit preflight) apply
 * to free-text display fields (host.spec.host, context.spec.displayName): only
 * trimmed length and control/bidi characters are constrained.
 *
 * This is a PURE, browser-safe leaf: zero imports of Node/K8s/env. Extracted
 * from control-api's resourceFieldValidation so the regex and length bound are
 * derived, never duplicated by hand across services (D4).
 */

/** Max length for a free-text display field (post-trim). */
const DISPLAY_FIELD_MAX_LENGTH = 120

// Characters rejected in display fields:
//   - C0 range + DEL (\x00-\x1f, \x7f): newlines and tabs are control characters
//     too — a display name is a single-line label.
//   - C1 range (\x80-\x9f): the second control block. U+0085 (NEL) is a line
//     terminator that breaks the "single-line label" invariant, and U+009B (CSI)
//     opens an ANSI escape sequence — both must be rejected like C0/DEL.
//   - Unicode bidirectional formatting: embeddings/overrides (U+202A–U+202E:
//     LRE/RLE/PDF/LRO/RLO) and isolates (U+2066–U+2069: LRI/RLI/FSI/PDI). These
//     reorder surrounding text and let an admin craft a spec.host/displayName
//     that visually impersonates another resource in the UI/desktop (spoofing).
//   - Line/paragraph separators (U+2028/U+2029): line breaks a single-line label
//     must not contain (JS regex `.`/`\s` and JSON treat them specially too).
// Deliberately NOT rejected: directional marks (U+200E/U+200F/U+061C) and
// zero-width/invisible characters (U+200B–U+200D, U+2060, U+FEFF). This set is
// the canonical Trojan-Source bidi mitigation; zero-width joiners (U+200D) are
// legitimate in emoji sequences, so blanket-rejecting them would break valid
// display names. Confusable/invisible-glyph spoofing is out of scope here.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/

/**
 * Validate a free-text display field (present only). Returns an issue or null.
 * Skips when the field is absent (undefined) — display fields are optional.
 * Measures over `.trim()` but does NOT mutate the value.
 */
function validateDisplayField(value, field) {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    return { field, message: `${field} must be a string` }
  }
  if (CONTROL_CHAR_RE.test(value)) {
    return {
      field,
      message: `${field} must not contain control or bidirectional formatting characters`,
    }
  }
  if (value.trim().length === 0) {
    return { field, message: `${field} must not be empty or whitespace-only` }
  }
  if (value.trim().length > DISPLAY_FIELD_MAX_LENGTH) {
    return {
      field,
      message: `${field} must be at most ${DISPLAY_FIELD_MAX_LENGTH} characters`,
    }
  }
  return null
}

module.exports = {
  DISPLAY_FIELD_MAX_LENGTH,
  CONTROL_CHAR_RE,
  validateDisplayField,
}
