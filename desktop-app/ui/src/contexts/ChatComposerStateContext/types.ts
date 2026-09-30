import type { ReactNode } from 'react'
import type {
  ComposerFileAttachment,
  ComposerFileRefusal,
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
  composerFileAttachments: ComposerFileAttachment[]
  /** Why the documents of the last attach were not attached (#678). */
  composerFileRefusals: ComposerFileRefusal[]
  composerReferenceAttachments: ComposerReferenceAttachment[]
  agentSending: boolean
  agentError: string | null
  failedAgentSend: FailedAgentSend | null
  activeMessageCount: number
  composerFocusRequestId: number
}

export interface ChatComposerStateProviderProps {
  value: ChatComposerStateContextValue
  children: ReactNode
}
