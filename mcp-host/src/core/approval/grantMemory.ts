import { createHash } from 'node:crypto'
import type { Conversation } from '../types'
import type { ApprovalMode } from './approvalMode'

/**
 * Drops grants that belong to the effective mode that just ended.
 * `cron_manage` task grants stay. Named non-shell Always grants stay.
 * Shell's session grant and the auto-only shell slot do not.
 */
export function clearModeScopedGrants(conversation: Conversation): void {
  const taskGrants = conversation.task_approved_tools
  if (taskGrants) {
    for (const toolName of [...taskGrants]) {
      if (toolName !== 'cron_manage') taskGrants.delete(toolName)
    }
  }
  conversation.auto_approved_tools.delete('shell_exec')
  conversation.auto_shell_grants = { wholeTool: false, commands: new Set() }
}

/**
 * Remember the effective mode for this in-memory session.
 * The first observation is stored and does not clear. A later difference clears.
 */
export function syncEffectiveMode(
  conversation: Conversation,
  effective: ApprovalMode
): { changed: boolean; previous?: ApprovalMode } {
  const previous = conversation.last_effective_approval_mode
  if (previous === undefined) {
    conversation.last_effective_approval_mode = effective
    return { changed: false }
  }
  if (previous === effective) return { changed: false, previous }
  clearModeScopedGrants(conversation)
  conversation.last_effective_approval_mode = effective
  return { changed: true, previous }
}

/** Opaque id for L1–L4. SHA-256 hex, never the session key or Conversation.id. */
export function approvalLogId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
