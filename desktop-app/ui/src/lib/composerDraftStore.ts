/**
 * Composer draft store — the single source of truth for unsent composer text,
 * keyed per chat. It lives at module scope (not in React state or the chat
 * controller) so drafts survive both the inline→docked composer swap and page
 * navigation, while typing only re-renders the one component that subscribes via
 * `useComposerDraft`. Empty drafts are not retained, so the map self-prunes.
 */

type Listener = () => void

/**
 * Draft key used while no chat is active yet (before the first send creates one).
 * This bucket is shared, not per-agent: it assumes at most one "no active chat"
 * composer is mounted at a time (true today — the inline composer renders only when
 * `!activeChatId`). A future split-view that showed two no-chat composers at once
 * would make them share this draft.
 */
const NO_CHAT_DRAFT_KEY = '__no_chat__'

const drafts = new Map<string, string>()
const listenersByKey = new Map<string, Set<Listener>>()

function keyFor(chatId: string | null): string {
  return chatId ?? NO_CHAT_DRAFT_KEY
}

function emit(key: string): void {
  const listeners = listenersByKey.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

export function getComposerDraft(chatId: string | null): string {
  return drafts.get(keyFor(chatId)) ?? ''
}

export function setComposerDraft(chatId: string | null, value: string): void {
  const key = keyFor(chatId)
  if ((drafts.get(key) ?? '') === value) return
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit(key)
}

export function clearComposerDraft(chatId: string | null): void {
  setComposerDraft(chatId, '')
}

/** Clears the draft for a chat and the "no chat yet" bucket (used on send). */
export function clearComposerDraftAfterSend(chatId: string | null): void {
  clearComposerDraft(null)
  if (chatId) clearComposerDraft(chatId)
}

export function subscribeComposerDraft(chatId: string | null, listener: Listener): () => void {
  const key = keyFor(chatId)
  let listeners = listenersByKey.get(key)
  if (!listeners) {
    listeners = new Set()
    listenersByKey.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByKey.delete(key)
  }
}

/** Test helper: wipe all drafts and listeners. */
export function resetComposerDraftStore(): void {
  drafts.clear()
  listenersByKey.clear()
}
