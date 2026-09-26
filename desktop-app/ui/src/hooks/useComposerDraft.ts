import { useCallback, useSyncExternalStore } from 'react'
import {
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
  agentRef?: string
): readonly [string, (value: string) => void] {
  const subscribe = useCallback(
    (listener: () => void) => subscribeComposerDraft(chatId, listener, agentRef),
    [agentRef, chatId]
  )
  const draft = useSyncExternalStore(subscribe, () => getComposerDraft(chatId, agentRef))
  const setDraft = useCallback(
    (value: string) => setComposerDraft(chatId, value, agentRef),
    [agentRef, chatId]
  )
  return [draft, setDraft] as const
}
