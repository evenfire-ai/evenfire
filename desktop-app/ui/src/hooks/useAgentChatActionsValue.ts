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
  const handleCreateChat = useStableCallback(vm.handleCreateChat)
  const handleRenameChat = useStableCallback(vm.handleRenameChat)
  const handleRenameChatForAgent = useStableCallback(vm.handleRenameChatForAgent)
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
  const handleAddComposerReferenceAttachments = useStableCallback(
    vm.handleAddComposerReferenceAttachments
  )
  const handleRemoveComposerReferenceAttachment = useStableCallback(
    vm.handleRemoveComposerReferenceAttachment
  )
  const handleSendAgentMessage = useStableCallback(vm.handleSendAgentMessage)
  const handleRetryFailedAgentSend = useStableCallback(vm.handleRetryFailedAgentSend)

  return useMemo(
    () => ({
      chatEndRef,
      handleCreateChat,
      handleRenameChat,
      handleRenameChatForAgent,
      handleDeleteChat,
      handleDeleteChatForAgent,
      handleSelectChat,
      clearComposerSendError,
      handleAddComposerImageAttachments,
      handleUpdateComposerImageAttachment,
      handleRemoveComposerImageAttachment,
      handleAddComposerReferenceAttachments,
      handleRemoveComposerReferenceAttachment,
      handleSendAgentMessage,
      handleRetryFailedAgentSend,
    }),
    [
      chatEndRef,
      handleCreateChat,
      handleRenameChat,
      handleRenameChatForAgent,
      handleDeleteChat,
      handleDeleteChatForAgent,
      handleSelectChat,
      clearComposerSendError,
      handleAddComposerImageAttachments,
      handleUpdateComposerImageAttachment,
      handleRemoveComposerImageAttachment,
      handleAddComposerReferenceAttachments,
      handleRemoveComposerReferenceAttachment,
      handleSendAgentMessage,
      handleRetryFailedAgentSend,
    ]
  )
}
