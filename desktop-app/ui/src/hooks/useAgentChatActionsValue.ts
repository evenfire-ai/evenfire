import { useMemo } from 'react'
import type { AgentChatActionsContextValue } from '@contexts/AgentChatActionsContext'
import type { useAppController } from './useAppController'
import { useStableCallback } from './useStableCallback'

type AppVm = ReturnType<typeof useAppController>

/**
 * Builds the AgentChatActionsContext value with every handler wrapped in a
 * referentially-stable callback. Because all deps are stable (the wrappers never
 * change identity and `chatEndRef` is a ref), this value object is created once and
 * never re-renders action-only consumers (e.g. FleetBoard) — even when an
 * underlying handler's closure deps (chatList, attachments, error flags) change.
 */
export function useAgentChatActionsValue(vm: AppVm): AgentChatActionsContextValue {
  const chatEndRef = vm.chatEndRef
  const scrollChatToBottom = useStableCallback(vm.scrollChatToBottom)
  // This context is the UI-event boundary; the underlying create API retains
  // rejection for programmatic awaiters and restoration remains controller-owned.
  const handleCreateChat = useStableCallback(async () => {
    try {
      await vm.handleCreateChat()
    } catch (error) {
      vm.pushToast(
        `Could not create conversation: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    }
  })
  const handleRenameChat = useStableCallback(vm.handleRenameChat)
  const handleRenameChatForAgent = useStableCallback(vm.handleRenameChatForAgent)
  const captureChatDeleteFence = useStableCallback(vm.captureChatDeleteFence)
  const handleDeleteChat = useStableCallback(vm.handleDeleteChat)
  const handleDeleteChatForAgent = useStableCallback(vm.handleDeleteChatForAgent)
  const handleSelectChat = useStableCallback(vm.handleSelectChat)
  const clearComposerSendError = useStableCallback(vm.clearComposerSendError)
  const handleAddComposerImageAttachments = useStableCallback(vm.handleAddComposerImageAttachments)
  const handleUpdateComposerImageAttachment = useStableCallback(
    vm.handleUpdateComposerImageAttachment
  )
  const handleRemoveComposerImageAttachment = useStableCallback(
    vm.handleRemoveComposerImageAttachment
  )
  const handleAddComposerFiles = useStableCallback(vm.handleAddComposerFiles)
  const handleRemoveComposerFileAttachment = useStableCallback(
    vm.handleRemoveComposerFileAttachment
  )
  const handleAddComposerReferenceAttachments = useStableCallback(
    vm.handleAddComposerReferenceAttachments
  )
  const handleRemoveComposerReferenceAttachment = useStableCallback(
    vm.handleRemoveComposerReferenceAttachment
  )
  const handleSendAgentMessage = useStableCallback(vm.handleSendAgentMessage)
  const handleRetryFailedAgentSend = useStableCallback(vm.handleRetryFailedAgentSend)
  const handleRecoverFailedAgentSend = useStableCallback(vm.handleRecoverFailedAgentSend)
  const handleDiscardFailedAgentSend = useStableCallback(vm.handleDiscardFailedAgentSend)

  return useMemo(
    () => ({
      chatEndRef,
      scrollChatToBottom,
      handleCreateChat,
      handleRenameChat,
      handleRenameChatForAgent,
      captureChatDeleteFence,
      handleDeleteChat,
      handleDeleteChatForAgent,
      handleSelectChat,
      clearComposerSendError,
      handleAddComposerImageAttachments,
      handleUpdateComposerImageAttachment,
      handleRemoveComposerImageAttachment,
      handleAddComposerFiles,
      handleRemoveComposerFileAttachment,
      handleAddComposerReferenceAttachments,
      handleRemoveComposerReferenceAttachment,
      handleSendAgentMessage,
      handleRetryFailedAgentSend,
      handleRecoverFailedAgentSend,
      handleDiscardFailedAgentSend,
    }),
    [
      chatEndRef,
      scrollChatToBottom,
      handleCreateChat,
      handleRenameChat,
      handleRenameChatForAgent,
      captureChatDeleteFence,
      handleDeleteChat,
      handleDeleteChatForAgent,
      handleSelectChat,
      clearComposerSendError,
      handleAddComposerImageAttachments,
      handleUpdateComposerImageAttachment,
      handleRemoveComposerImageAttachment,
      handleAddComposerFiles,
      handleRemoveComposerFileAttachment,
      handleAddComposerReferenceAttachments,
      handleRemoveComposerReferenceAttachment,
      handleSendAgentMessage,
      handleRetryFailedAgentSend,
      handleRecoverFailedAgentSend,
      handleDiscardFailedAgentSend,
    ]
  )
}
