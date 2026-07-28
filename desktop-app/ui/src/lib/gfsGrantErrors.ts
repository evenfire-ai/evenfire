/**
 * Pure presentation map for GFS grant/revoke/list server verdicts.
 *
 * The renderer receives control-api error codes embedded in Electron IPC error
 * messages (e.g. "Error invoking remote method 'gfs:grant': Error: 403
 * Forbidden: foreign_agent_forbidden"), so codes are matched as substrings of
 * the raw message. Unknown errors keep their raw message — fail loud, never
 * swallow a server verdict.
 */

export interface GfsGrantErrorPresentation {
  /** Matched control-api error code, or null when the message is passed through. */
  code: string | null
  message: string
  /**
   * 'quiet' renders as an informational banner (never an error toast) — the
   * caller simply lacks manage access, which is an expected state, not a fault.
   */
  severity: 'error' | 'quiet'
}

const GFS_GRANT_ERROR_MESSAGES: Record<string, string> = {
  agent_manager_forbidden: "Agents can't be given manage or share access.",
  managed_agent_permission_forbidden: 'Managed agents can only be granted read and write.',
  foreign_agent_forbidden: 'You can only grant access to your own agents.',
  subjects_invalid: 'Some selected subjects are invalid and were rejected.',
  escalation_rejected: 'You can only grant permissions you already hold here.',
  manage_acl_required: 'Only people with manage access can view who has access here.',
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function parseInvalidIndexes(message: string): number[] {
  const match = message.match(/invalidIndexes[^[]*\[([\d,\s]*)\]/)
  if (!match || !match[1]?.trim()) return []
  return match[1]
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(index => Number.isInteger(index) && index >= 0)
}

function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retryAfterSeconds[^\d]*(\d+)/)
  if (!match?.[1]) return null
  const seconds = Number.parseInt(match[1], 10)
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null
}

export function describeGfsGrantError(error: unknown): GfsGrantErrorPresentation {
  const raw = rawMessage(error)

  if (/\b429\b/.test(raw) || raw.includes('rate_limited')) {
    const retryAfterSeconds = parseRetryAfterSeconds(raw)
    return {
      code: 'rate_limited',
      message:
        retryAfterSeconds !== null
          ? `Too many permission changes — try again in ${retryAfterSeconds}s.`
          : 'Too many permission changes — try again shortly.',
      severity: 'error',
    }
  }

  for (const [code, message] of Object.entries(GFS_GRANT_ERROR_MESSAGES)) {
    if (!raw.includes(code)) continue
    if (code === 'subjects_invalid') {
      const invalidIndexes = parseInvalidIndexes(raw)
      return {
        code,
        message: invalidIndexes.length
          ? `${message} (subjects ${invalidIndexes.map(index => index + 1).join(', ')})`
          : message,
        severity: 'error',
      }
    }
    return { code, message, severity: code === 'manage_acl_required' ? 'quiet' : 'error' }
  }

  return { code: null, message: raw || 'The permission change failed.', severity: 'error' }
}
