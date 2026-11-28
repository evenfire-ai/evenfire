import type { ReactNode, RefObject } from 'react'
import type { ChatDeleteFence } from '../../../../src/types'
import type { ComposerImageAttachment, ComposerReferenceAttachment } from '../../uiTypes'

/** Outcome of the fenced storage mutation, independent of navigation. */
export type ChatDeleteOutcome = 'deleted' | 'retryable-failure' | 'stale-authority'

export interface QueuedChatDelete {
  agentRef: string
  fence: ChatDeleteFence
  hostAuthorityEpoch: number
}

/**
 * Stable, cross-cutting chat actions. These are `useCallback` handlers plus the
 * scroll ref — split out from chat state so action-only consumers (e.g. FleetBoard)
 * never re-render on streaming/state churn.
 */
export interface AgentChatActionsContextValue {
  chatEndRef: RefObject<HTMLDivElement | null>
  scrollChatToBottom: () => void
  handleCreateChat: () => Promise<void>
  handleRenameChat: (chatId: string, newTitle: string) => Promise<void>
  handleRenameChatForAgent: (agentRef: string, chatId: string, newTitle: string) => Promise<void>
  captureChatDeleteFence: (agentRef: string) => Promise<QueuedChatDelete>
  handleDeleteChat: (chatId: string, deletion: QueuedChatDelete) => Promise<void>
  handleDeleteChatForAgent: (
    agentRef: string,
    chatId: string,
    deletion: QueuedChatDelete
  ) => Promise<ChatDeleteOutcome>
  handleSelectChat: (chatId: string) => Promise<void>
  clearComposerSendError: () => void
  handleAddComposerImageAttachments: (attachments: ComposerImageAttachment[]) => void
  handleUpdateComposerImageAttachment: (attachment: ComposerImageAttachment) => void
  handleRemoveComposerImageAttachment: (attachmentId: string) => void
  handleAddComposerFiles: (files: File[], draft: string) => void
  handleRemoveComposerFileAttachment: (attachmentId: string) => void
  handleAddComposerReferenceAttachments: (attachments: ComposerReferenceAttachment[]) => void
  handleRemoveComposerReferenceAttachment: (attachmentId: string) => void
  handleClearComposerAttachments: () => void
  handleSendAgentMessage: (text: string, workspaceTabId?: string | null) => Promise<void>
  handleRetryFailedAgentSend: () => Promise<void>
  handleRecoverFailedAgentSend: (workspaceTabId?: string | null) => void
  handleDiscardFailedAgentSend: () => void
}

export interface AgentChatActionsProviderProps {
  value: AgentChatActionsContextValue
  children: ReactNode
}
