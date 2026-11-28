import { useCallback, useId, useRef, useState } from 'react'
import { useAgentChatActionsContext } from '@contexts/AgentChatActionsContext'
import { useReportShellOverlay } from '@hooks/useReportShellOverlay'
import type {
  ConfirmedChatDeleteController,
  ConfirmedChatDeleteTarget,
  PendingChatDelete,
} from './useConfirmedChatDelete.types'

/**
 * The confirmed deletion of a conversation, shared by every surface that
 * offers it: the sidebar, the session list and the chat header.
 *
 * `request` captures the delete fence first, so a confirmed delete is bound to
 * the access the user held when they asked for it; the confirmation opens only
 * once that succeeded. `confirm` waits for the deletion, so the confirmation
 * does not close on a delete that failed. While the confirmation is open the
 * shell is told to hide the native embedded-app view, which would otherwise
 * paint over the dialog in the chat drawer.
 */
export function useConfirmedChatDelete(): ConfirmedChatDeleteController {
  const { captureChatDeleteFence, handleDeleteChatForAgent } = useAgentChatActionsContext()
  const overlaySource = useId()
  const requestSequence = useRef(0)
  const [pending, setPending] = useState<PendingChatDelete | null>(null)
  useReportShellOverlay(overlaySource, pending !== null)

  const request = useCallback(
    async (target: ConfirmedChatDeleteTarget) => {
      // Only the latest request may open a confirmation: a slower, earlier one
      // would otherwise replace the deletion the user asked for last.
      const sequence = ++requestSequence.current
      try {
        const deletion = await captureChatDeleteFence(target.agentRef)
        if (sequence !== requestSequence.current) return
        setPending({ ...target, deletion })
      } catch {
        // captureChatDeleteFence reports the failure through the shared chat toast.
      }
    },
    [captureChatDeleteFence]
  )

  const cancel = useCallback(() => {
    requestSequence.current += 1
    setPending(null)
  }, [])

  const confirm = useCallback(async () => {
    const target = pending
    if (!target) return
    try {
      const outcome = await handleDeleteChatForAgent(
        target.agentRef,
        target.chatId,
        target.deletion
      )
      if (outcome !== 'retryable-failure') {
        setPending(current => (current === target ? null : current))
      }
    } catch {
      // Unexpected producer rejection has no verified retry eligibility.
      // The controller owns feedback; require a fresh request and fence.
      setPending(current => (current === target ? null : current))
    }
  }, [handleDeleteChatForAgent, pending])

  return { pending, request, cancel, confirm }
}
