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

// Control characters (C0 range + DEL) are rejected in display fields. Newlines
// and tabs are control characters too — a display name is a single-line label.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

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
    return { field, message: `${field} must not contain control characters` }
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
