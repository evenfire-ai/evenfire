/**
 * The single owner of a conversation's tool-denial policy.
 *
 * A denial blocks one exact tool name in one conversation until the user who
 * denied it approves that tool again. It survives a restart (persisted on
 * `sessions.denied_tools` as `[{ tool, userId }]`, migration 016).
 *
 * Every rule lives here, used by both decision lanes (ApprovalController and
 * the guardrail `ask` lane in toolUseLoopToolBatch) and both persistence ends
 * (sqliteConversationStore writes, reconstruct reads):
 *   - recordDenial: the latest denier wins, and the deny also revokes an
 *     earlier "Always approve" for that tool.
 *   - liftDenial: only the recorded denier lifts it. An unknown denier (legacy
 *     row) lets any approver lift it; a missing approver id never lifts a
 *     known denier's denial.
 *   - isDenied / hasActiveDenials: the checks the gates use.
 *
 * The cron lane opts out through ApprovalController's `honorDenials:false`;
 * the guardrail lane needs no opt-out because an unattended `ask` already
 * fails safe to deny.
 */
import type { Conversation } from '../types'

/** Denied tool name → id of the user who denied it (null when unknown). */
export type Denials = Map<string, string | null>

type WithDenials = Pick<Conversation, 'denials'>

export function isDenied(conversation: WithDenials, toolName: string): boolean {
  return conversation.denials?.has(toolName) === true
}

export function hasActiveDenials(conversation: WithDenials): boolean {
  return (conversation.denials?.size ?? 0) > 0
}

export function recordDenial(
  conversation: Pick<Conversation, 'denials' | 'auto_approved_tools'>,
  toolName: string,
  userId?: string
): void {
  conversation.denials ??= new Map()
  conversation.denials.set(toolName, userId || null)
  conversation.auto_approved_tools.delete(toolName)
}

export type LiftOutcome = 'not_denied' | 'lifted' | 'kept_for_denier'

export function liftDenial(
  conversation: WithDenials,
  toolName: string,
  userId?: string
): LiftOutcome {
  if (!conversation.denials?.has(toolName)) return 'not_denied'
  const denier = conversation.denials.get(toolName) ?? null
  if (denier !== null && denier !== userId) return 'kept_for_denier'
  conversation.denials.delete(toolName)
  return 'lifted'
}

/** The persisted `sessions.denied_tools` JSON: `[{ tool, userId }]`. */
export function serializeDenials(conversation: WithDenials): string {
  return JSON.stringify(
    [...(conversation.denials ?? [])].map(([tool, userId]) => ({ tool, userId }))
  )
}

/**
 * Parse the persisted JSON. NULL is no denials. A malformed value (or entry)
 * calls `onUnreadable`: it cannot say which tools were denied, so those tools
 * go through the normal gate again.
 */
export function parseDenials(raw: string | null | undefined, onUnreadable: () => void): Denials {
  const denials: Denials = new Map()
  if (!raw) return denials
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    onUnreadable()
    return new Map()
  }
  if (!Array.isArray(parsed)) {
    onUnreadable()
    return denials
  }
  for (const entry of parsed) {
    const tool = (entry as { tool?: unknown } | null)?.tool
    if (!entry || typeof entry !== 'object' || typeof tool !== 'string' || tool.length === 0) {
      onUnreadable()
      continue
    }
    const userId = (entry as { userId?: unknown }).userId
    denials.set(tool, typeof userId === 'string' && userId.length > 0 ? userId : null)
  }
  return denials
}
