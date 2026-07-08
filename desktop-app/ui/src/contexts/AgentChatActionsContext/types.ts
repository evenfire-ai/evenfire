import type { ReactNode, RefObject } from 'react'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'

/**
 * Stable, cross-cutting chat actions. These are `useCallback` handlers plus the
 * scroll ref — split out from chat state so action-only consumers (e.g. FleetBoard)
 * never re-render on streaming/state churn.
 */
export interface AgentChatActionsContextValue {
  chatEndRef: RefObject<HTMLDivElement | null>
  handleCreateChat: () => Promise<void>
  handleRenameChat: (chatId: string, newTitle: string) => Promise<void>
  handleRenameChatForAgent: (agentRef: string, chatId: string, newTitle: string) => Promise<void>
  handleDeleteChat: (chatId: string) => Promise<void>
  handleDeleteChatForAgent: (agentRef: string, chatId: string) => Promise<void>
  handleSelectChat: (chatId: string) => Promise<void>
  clearComposerSendError: () => void
  handleAddComposerImageAttachments: (attachments: ComposerImageAttachment[]) => void
  handleUpdateComposerImageAttachment: (attachment: ComposerImageAttachment) => void
  handleRemoveComposerImageAttachment: (attachmentId: string) => void
  handleAddComposerReferenceAttachments: (attachments: ComposerReferenceAttachment[]) => void
  handleRemoveComposerReferenceAttachment: (attachmentId: string) => void
  handleSendAgentMessage: (text: string) => Promise<void>
  handleRetryFailedAgentSend: () => Promise<void>
}

export interface AgentChatActionsProviderProps {
  value: AgentChatActionsContextValue
  children: ReactNode
}
