/** Channel notifications keep at most this many characters of parameter JSON. */
export const APPROVAL_NOTIFICATION_PARAMETER_LIMIT = 200

/**
 * True when `approvalNotificationBody` shows the full parameter JSON.
 * An empty parameter object is rendered as "none", not as a truncation.
 */
export function approvalParametersWithinNotificationLimit(
  parameters: Record<string, unknown>
): boolean {
  if (Object.keys(parameters).length === 0) return true
  return JSON.stringify(parameters).length <= APPROVAL_NOTIFICATION_PARAMETER_LIMIT
}
