import { RFC1123_RE } from '../../http/rfc1123.js'

/**
 * Application-level validation of resource identifiers and display fields for the
 * generic admin CRUD router (hosts | contexts | communication-channels |
 * mcp-servers).
 *
 * Design (spec alfredo-agent-rename, Decision #7 + F0.3):
 *   - IDENTIFIERS are RFC1123 and enforced HERE, not in the CRD schema. Hardening
 *     an existing field on a live CRD makes the apiserver validate the whole
 *     object on every write (including controller /status patches) and would
 *     reject writes on legacy CRs. So the rules live in control-api instead.
 *   - DISPLAY fields (host.spec.host, context.spec.displayName) are FREE TEXT:
 *     only trimmed length and control characters are constrained.
 *   - RATCHET: on update a field is validated ONLY IF its value changed vs the
 *     current CR, so a legacy resource whose display/identifier is out of norm is
 *     never blocked for unrelated edits.
 */

/** Max length for a free-text display field (post-trim). */
export const DISPLAY_FIELD_MAX_LENGTH = 120

// Characters rejected in display fields:
//   - C0 range + DEL (\x00-\x1f, \x7f): newlines and tabs are control characters
//     too — a display name is a single-line label.
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
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\u2028\u2029]/

export interface FieldIssue {
  field: string
  message: string
}

/**
 * Validate a `metadata.name` as an RFC1123 DNS label. Returns the FIX-A1 error
 * envelope (`{error:'invalid_name', field:'metadata.name', message}`) or null.
 * A missing/non-string name is rejected the same way an empty one is: the K8s
 * apiserver requires a valid name and we would otherwise collapse its 422 to 500.
 */
export function validateResourceName(
  name: unknown
): { error: 'invalid_name'; field: 'metadata.name'; message: string } | null {
  if (typeof name === 'string' && RFC1123_RE.test(name)) return null
  return {
    error: 'invalid_name',
    field: 'metadata.name',
    message:
      'metadata.name must be a valid RFC1123 DNS label: lowercase alphanumeric characters or ' +
      "'-', starting and ending with an alphanumeric character, at most 63 characters.",
  }
}

/**
 * Validate a free-text display field (present only). Returns an issue or null.
 * Skips when the field is absent (undefined) — display fields are optional.
 */
export function validateDisplayField(value: unknown, field: string): FieldIssue | null {
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
  if (value.trim().length > DISPLAY_FIELD_MAX_LENGTH) {
    return {
      field,
      message: `${field} must be at most ${DISPLAY_FIELD_MAX_LENGTH} characters`,
    }
  }
  return null
}

/**
 * Validate an identifier field (present only) as RFC1123. Returns an issue or
 * null. Skips when absent — presence of identifiers is enforced by the CRD
 * schema / apiserver, not here.
 */
export function validateIdentifierField(value: unknown, field: string): FieldIssue | null {
  if (value === undefined) return null
  if (typeof value === 'string' && RFC1123_RE.test(value)) return null
  return {
    field,
    message:
      `${field} must be a valid RFC1123 DNS label: lowercase alphanumeric characters or ` +
      "'-', starting and ending with an alphanumeric character, at most 63 characters.",
  }
}

/**
 * Collect display/identifier field issues for a hosts|contexts spec, applying the
 * ratchet: when `currentSpec` is provided (update), a field is validated only if
 * its value differs from the current CR; when null (create), every present field
 * is validated.
 */
export function collectResourceSpecFieldIssues(
  plural: 'hosts' | 'contexts',
  spec: Record<string, unknown>,
  currentSpec: Record<string, unknown> | null
): FieldIssue[] {
  const issues: FieldIssue[] = []
  const changed = (key: string): boolean => currentSpec === null || spec[key] !== currentSpec[key]

  if (plural === 'hosts') {
    if (changed('host')) {
      const issue = validateDisplayField(spec.host, 'spec.host')
      if (issue) issues.push(issue)
    }
  } else {
    if (changed('displayName')) {
      const issue = validateDisplayField(spec.displayName, 'spec.displayName')
      if (issue) issues.push(issue)
    }
    if (changed('contextId')) {
      const issue = validateIdentifierField(spec.contextId, 'spec.contextId')
      if (issue) issues.push(issue)
    }
  }

  return issues
}
