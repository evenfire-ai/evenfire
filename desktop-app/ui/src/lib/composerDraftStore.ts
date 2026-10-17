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
const PENDING_RESOURCE_DRAFT_KEY = '__pending_resource_new_chat__'

const drafts = new Map<string, string>()
let revision = 0
const revisions = new Map<string, number>()
const listenersByKey = new Map<string, Set<Listener>>()
const automaticResourcePrefills = new Set<string>()

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
  const key = keyFor(chatId, agentRef)
  const value = drafts.get(key)
  if (value !== undefined) return value
  // A resource prefill may be created before ChatPage selects its initial agent.
  // Keep that specific pending value visible until the composer claims it.
  return !chatId ? (drafts.get(PENDING_RESOURCE_DRAFT_KEY) ?? '') : ''
}

export function setPendingResourceComposerDraft(value: string): void {
  setDraftByKey(PENDING_RESOURCE_DRAFT_KEY, value)
}

/** Move a pre-agent resource draft into the first selected agent's bucket. */
export function claimPendingNewChatDraft(agentRef: string): void {
  const agent = agentRef.trim()
  if (!agent) return
  const pending = drafts.get(PENDING_RESOURCE_DRAFT_KEY)
  if (!pending) return
  const agentKey = keyFor(null, agent)
  if (!drafts.has(agentKey)) setComposerDraft(null, pending, agent)
  setDraftByKey(PENDING_RESOURCE_DRAFT_KEY, '')
}

export function setComposerDraft(chatId: string | null, value: string, agentRef?: string): void {
  setDraftByKey(keyFor(chatId, agentRef), value)
}

function setDraftByKey(key: string, value: string): void {
  if ((drafts.get(key) ?? '') === value) return
  revisions.set(key, ++revision)
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit(key)
}

export function clearComposerDraft(chatId: string | null, agentRef?: string): void {
  setComposerDraft(chatId, '', agentRef)
}

/** Drop drafts on logout or principal/team change and notify mounted composers. */
export function clearAllComposerDrafts(): void {
  automaticResourcePrefills.clear()
  for (const key of [...drafts.keys()]) {
    drafts.delete(key)
    revisions.set(key, ++revision)
    emit(key)
  }
}

/** Claim one automatic resource prefill for a chat and exact context key. */
export function claimAutomaticResourcePrefill(key: string): boolean {
  if (automaticResourcePrefills.has(key)) return false
  automaticResourcePrefills.add(key)
  return true
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
  automaticResourcePrefills.clear()
}
