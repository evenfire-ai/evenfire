/**
 * Base utilities for channel adapters.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORKFLOW_APPROVAL_DECISION_COMMAND_RE =
  /^[\\/](?:approve|deny)\s+([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i

/**
 * Check if sender is in the allowed list.
 * Normalizes for comparison (case-insensitive, strips @).
 */
export function isAllowedSender(sender: string, allowedSenders: Set<string>): boolean {
  const normalizedSender = sender.toLowerCase().replace(/^@/, '')
  const normalizedAllowed = new Set([...allowedSenders].map(s => s.toLowerCase().replace(/^@/, '')))
  return normalizedAllowed.has(normalizedSender)
}

/** Slash commands that must work in channel threads even when replyOnlyWhenMentioned is set. */
export function isInlineApprovalCommand(content: string): boolean {
  const t = content.trim().toLowerCase()
  if (
    t === '/approve' ||
    t === '/approve always' ||
    t === '/deny' ||
    t === '\\approve' ||
    t === '\\approve always' ||
    t === '\\deny'
  ) {
    return true
  }
  return isWorkflowApprovalDecisionCommand(t)
}

/** Workflow approval decisions are user-facing commands by workflow recipe name only. */
export function isWorkflowApprovalDecisionCommand(content: string): boolean {
  const t = content.trim().toLowerCase()
  const match = WORKFLOW_APPROVAL_DECISION_COMMAND_RE.exec(t)
  if (!match) return false
  return match[1] !== 'always' && !UUID_RE.test(match[1])
}
