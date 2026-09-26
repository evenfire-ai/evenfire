import type { ReactNode } from 'react'
import type {
  ComposerImageAttachment,
  ComposerReferenceAttachment,
  FailedAgentSend,
} from '../../uiTypes'

/**
 * Composer-owned state, read only by ComposerPanel. Exposes `activeMessageCount`
 * (a scalar) instead of the hot `activeMessages` array so the composer doesn't
 * re-render on every message append — it only needs to know whether the chat is
 * empty (for auto-focus).
 */
export interface ChatComposerStateContextValue {
  activeChatId: string | null
  composerImageAttachments: ComposerImageAttachment[]
  composerReferenceAttachments: ComposerReferenceAttachment[]
  agentSending: boolean
  agentError: string | null
  failedAgentSend: FailedAgentSend | null
  activeMessageCount: number
  composerFocusRequestId: number
  /**
   * Bumps `composerFocusRequestId` so the mounted composer focuses (and
   * scrolls) itself. Stable identity — safe in deps. Used by surfaces outside
   * the composer (e.g. TASK-42 resend) to draw attention to a repopulated draft.
   */
  requestComposerFocus: () => void
}

export interface ChatComposerStateProviderProps {
  value: ChatComposerStateContextValue
  children: ReactNode
}
