import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import { ChatComposerStateContext } from '../contexts/ChatComposerStateContext/context'
import {
  cancelPendingResourceComposerPrefill,
  claimPendingResourceComposerPrefill,
  getComposerDraft,
  setComposerDraft,
  subscribeComposerDraft,
} from '../lib/composerDraftStore'

/**
 * Subscribes to the per-chat composer draft. Only components that call this hook
 * re-render on keystrokes — the chat controller and other context consumers do
 * not. Returns a `[draft, setDraft]` pair scoped to `chatId`.
 */
export function useComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): readonly [string, (value: string) => void] {
  const composerState = useContext(ChatComposerStateContext)
  const destinationTabId =
    workspaceTabId === undefined ? (composerState?.workspaceChatTabId ?? null) : workspaceTabId
  useEffect(() => {
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
  const draft = useSyncExternalStore(subscribe, () =>
    getComposerDraft(chatId, agentRef, destinationTabId)
  )
  const setDraft = useCallback(
    (value: string) => setComposerDraft(chatId, value, agentRef, destinationTabId),
    [agentRef, chatId, destinationTabId]
  )
  return [draft, setDraft] as const
}
