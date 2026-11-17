/**
 * PATCH approval-mode core. The route stores the requested mode. The ceiling
 * and the channel cap are read from the live snapshot at call time, and the
 * cap comes from the session's stored channel type, not from the key.
 */
import {
  type ApprovalConfigSnapshot,
  type ApprovalMode,
  readChannelCap,
  readModeCeiling,
} from '../core/approval/approvalMode'
import type { ConversationManager } from '../core/conversation/conversation'
import type { SetApprovalModeResult } from '../server/types'
import { serializeSessionKey } from '../session'

const APPROVAL_MODES = new Set<ApprovalMode>(['manual', 'auto', 'allow_all'])

export interface SessionApprovalModeDeps {
  convManager: ConversationManager
  approvalSnapshot: () => ApprovalConfigSnapshot
}

function isApprovalMode(value: string): value is ApprovalMode {
  return APPROVAL_MODES.has(value as ApprovalMode)
}

export async function applySessionApprovalMode(
  deps: SessionApprovalModeDeps,
  userSub: string,
  agent: string,
  chatId: string,
  rawMode: string
): Promise<SetApprovalModeResult> {
  if (!isApprovalMode(rawMode)) {
    return { ok: false, reason: 'invalid_mode' }
  }
  const key = serializeSessionKey({
    userId: userSub,
    channelType: 'rpc',
    channelId: agent,
    threadId: chatId,
  })
  const conversation = await deps.convManager.getSessionByKeyForUserAsync(key, userSub)
  if (!conversation) return { ok: false, reason: 'not_found' }
  const live = deps.approvalSnapshot()
  const stored = await deps.convManager.setApprovalMode(
    conversation,
    rawMode,
    {
      ceiling: readModeCeiling(live),
      cap: readChannelCap(live, conversation.channel_type),
    },
    'route',
    userSub
  )
  return { ok: true, ...stored }
}
