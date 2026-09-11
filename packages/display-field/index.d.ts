/**
 * Shared free-text display-field validation — the single source of truth for the
 * control/bidi-character + trimmed-length rule applied to free-text display
 * fields. PURE, browser-safe leaf; zero Node/K8s/env imports.
 */

/** Regex matching any character rejected in a display field (control/bidi). */
export declare const CONTROL_CHAR_RE: RegExp

/** Max length for a free-text display field (post-trim). */
export declare const DISPLAY_FIELD_MAX_LENGTH: number

export interface FieldIssue {
  field: string
  message: string
}

/**
 * Validate a free-text display field (present only). Returns an issue or null.
 * Skips when the field is absent (undefined) — display fields are optional.
 */
export declare function validateDisplayField(value: unknown, field: string): FieldIssue | null
