/**
 * Composer draft store — the single source of truth for unsent composer text,
 * keyed per chat. It lives at module scope (not in React state or the chat
 * controller) so drafts survive both the inline→docked composer swap and page
 * navigation, while typing only re-renders the one component that subscribes via
 * `useComposerDraft`. Empty drafts are not retained, so the map self-prunes.
 */

type Listener = () => void

/** Legacy no-chat key retained for callers that do not yet provide an agent. */
const NO_CHAT_DRAFT_KEY = '__no_chat__'

const drafts = new Map<string, string>()
let revision = 0
const revisions = new Map<string, number>()
const listenersByKey = new Map<string, Set<Listener>>()

function keyFor(chatId: string | null, agentRef?: string): string {
  if (chatId) return chatId
  const agent = agentRef?.trim()
  return agent ? `${NO_CHAT_DRAFT_KEY}:${agent}` : NO_CHAT_DRAFT_KEY
}

function emit(key: string): void {
  const listeners = listenersByKey.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

export function getComposerDraftRevision(chatId: string | null, agentRef?: string): number {
  return revisions.get(keyFor(chatId, agentRef)) ?? 0
}

export function getComposerDraft(chatId: string | null, agentRef?: string): string {
  return drafts.get(keyFor(chatId, agentRef)) ?? ''
}

export function setComposerDraft(chatId: string | null, value: string, agentRef?: string): void {
  const key = keyFor(chatId, agentRef)
  if ((drafts.get(key) ?? '') === value) return
  revisions.set(key, ++revision)
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit(key)
}

export function clearComposerDraft(chatId: string | null, agentRef?: string): void {
  setComposerDraft(chatId, '', agentRef)
}

/** Clears the draft for a chat and the "no chat yet" bucket (used on send). */
export function clearComposerDraftAfterSend(chatId: string | null, agentRef?: string): void {
  clearComposerDraft(null, agentRef)
  if (chatId) clearComposerDraft(chatId)
}

/** Drop drafts on logout or principal/team change and notify mounted composers. */
export function clearAllComposerDrafts(): void {
  for (const key of [...drafts.keys()]) {
    drafts.delete(key)
    revisions.set(key, ++revision)
    emit(key)
  }
}

export function subscribeComposerDraft(
  chatId: string | null,
  listener: Listener,
  agentRef?: string
): () => void {
  const key = keyFor(chatId, agentRef)
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
  revisions.clear()
  listenersByKey.clear()
}
