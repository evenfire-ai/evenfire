import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { ChatComposerStateContext } from '../contexts/ChatComposerStateContext/context'
import {
  cancelPendingResourceComposerPrefill,
  claimPendingResourceComposerPrefill,
  getComposerDraft,
  getComposerDraftOwnerConflict,
  setComposerDraft,
  subscribeComposerDraft,
} from '../lib/composerDraftStore'

export type ComposerDraftWriteResult =
  | { accepted: true }
  | { accepted: false; reason: 'owned-by-another-tab'; ownerTabId: string | null }

/**
 * Subscribes to the per-chat composer draft and keeps a rejected keystroke in
 * transient component state until the owner scope changes or the write succeeds.
 */
export function useComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): readonly [string, (value: string) => ComposerDraftWriteResult, string | null] {
  const composerState = useContext(ChatComposerStateContext)
  const destinationTabId =
    workspaceTabId === undefined ? (composerState?.workspaceChatTabId ?? null) : workspaceTabId
  const draftScope = JSON.stringify([chatId, agentRef ?? null, destinationTabId])
  const [transientDraft, setTransientDraft] = useState<{ scope: string; value: string } | null>(
    null
  )
  useEffect(() => {
    setTransientDraft(null)
    if (!destinationTabId) return
    if (chatId) {
      cancelPendingResourceComposerPrefill(destinationTabId)
      return
    }
    if (!agentRef) return
    claimPendingResourceComposerPrefill(destinationTabId, agentRef)
  }, [agentRef, chatId, destinationTabId])
  const subscribe = useCallback(
    (listener: () => void) => subscribeComposerDraft(chatId, listener, agentRef, destinationTabId),
    [agentRef, chatId, destinationTabId]
  )
  const getOwnerConflict = useCallback(
    () => getComposerDraftOwnerConflict(chatId, agentRef, destinationTabId),
    [agentRef, chatId, destinationTabId]
  )
  const draft = useSyncExternalStore(subscribe, () =>
    getComposerDraft(chatId, agentRef, destinationTabId)
  )
  const ownerConflictTabId = useSyncExternalStore(subscribe, getOwnerConflict, getOwnerConflict)
  const setDraft = useCallback(
    (value: string): ComposerDraftWriteResult => {
      if (setComposerDraft(chatId, value, agentRef, destinationTabId)) {
        setTransientDraft(null)
        return { accepted: true }
      }

      const ownerTabId = getComposerDraftOwnerConflict(chatId, agentRef, destinationTabId)
      setTransientDraft({ scope: draftScope, value })
      return { accepted: false, reason: 'owned-by-another-tab', ownerTabId }
    },
    [agentRef, chatId, destinationTabId, draftScope]
  )
  const visibleDraft = transientDraft?.scope === draftScope ? transientDraft.value : draft
  return [visibleDraft, setDraft, ownerConflictTabId] as const
}
