/**
 * Shared validation utilities.
 *
 * Replaces repetitive validation patterns with reusable functions.
 */
import { type InviteRole, type TeamRole, isValidInviteRole, isValidTeamRole } from './constants.js'

/**
 * Normalize and deduplicate a string array.
 *
 * Common pattern: [...new Set(items.map(String).map(v => v.trim()).filter(Boolean))]
 *
 * @param items - Array of unknown items to normalize
 * @returns Deduplicated, trimmed, non-empty string array
 */
export function normalizeStringArray(items: unknown[]): string[] {
  return [
    ...new Set(
      items
        .map(String)
        .map(v => v.trim())
        .filter(Boolean)
    ),
  ]
}

/**
 * Validate that a string is non-empty after trimming.
 *
 * @param value - The value to validate
 * @param fieldName - Field name for error messages
 * @throws {Error} If value is empty or only whitespace
 */
export function requireNonEmpty(value: string, fieldName: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${fieldName} is required`)
  }
}

/**
 * Validate and normalize a team role.
 *
 * @param value - The role value to validate
 * @param defaultValue - Default value if invalid
 * @returns Valid team role
 */
export function validateTeamRole(value: unknown, defaultValue: TeamRole = 'member'): TeamRole {
  const role = String(value || defaultValue).trim()
  if (!isValidTeamRole(role)) {
    throw new Error(`Invalid team role: ${role}. Must be one of: admin, inviter, member`)
  }
  return role
}

/**
 * Validate and normalize an invitation role.
 *
 * @param value - The role value to validate
 * @param defaultValue - Default value if invalid
 * @returns Valid invitation role
 */
export function validateInviteRole(
  value: unknown,
  defaultValue: InviteRole = 'member'
): InviteRole {
  const role = String(value || defaultValue).trim()
  if (!isValidInviteRole(role)) {
    throw new Error(`Invalid invite role: ${role}. Must be one of: admin, inviter, member`)
  }
  return role
}

/**
 * Validate email format (basic check).
 *
 * @param email - Email to validate
 * @returns true if valid email format
 */
export function isValidEmail(email: string): boolean {
  const trimmed = email.trim()
  if (!trimmed) return false
  // Basic email validation - must contain @ and have characters before and after
  const atIndex = trimmed.indexOf('@')
  return atIndex > 0 && atIndex < trimmed.length - 1
}

/**
 * Safely parse an array from unknown input.
 *
 * @param value - Value to parse as array
 * @param defaultValue - Default if not an array
 * @returns Array or default
 */
export function parseArray<T>(value: unknown, defaultValue: T[] = []): T[] {
  if (Array.isArray(value)) {
    return value as T[]
  }
  return defaultValue
}
