/**
 * Composer draft store — the single source of truth for unsent composer text,
 * keyed per chat and, for blank chats, per agent within the workspace tab.
 * Resource prefills that begin before agent selection are held by the exact
 * destination workspace tab and can only be claimed there.
 */

type Listener = () => void

type ResourcePrefill = { requestId: number; revision: number; uri: string }
type TabDraft = { key: string; value: string; requestId?: number }

/** Legacy no-chat key retained for callers that do not yet provide an agent. */
const NO_CHAT_DRAFT_KEY = '__no_chat__'
const drafts = new Map<string, string>()
let revision = 0
const revisions = new Map<string, number>()
const listenersByKey = new Map<string, Set<Listener>>()
const automaticResourcePrefills = new Set<string>()
const pendingResourcePrefillsByTab = new Map<string, ResourcePrefill>()
const tabDrafts = new Map<string, Map<string, TabDraft>>()
const tabRevisions = new Map<string, Map<string, number>>()
let resourcePrefillRequestSequence = 0

function keyFor(chatId: string | null, agentRef?: string): string {
  if (chatId) return chatId
  const agent = agentRef?.trim()
  return agent ? `${NO_CHAT_DRAFT_KEY}:${agent}` : NO_CHAT_DRAFT_KEY
}

function tabListenerKey(tabId: string): string {
  return `__workspace_tab_draft__:${tabId}`
}

function emit(key: string): void {
  const listeners = listenersByKey.get(key)
  if (!listeners) return
  for (const listener of listeners) listener()
}

function setDraftByKey(key: string, value: string): boolean {
  if ((drafts.get(key) ?? '') === value) return false
  revisions.set(key, ++revision)
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit(key)
  return true
}

function getTabDraft(tabId: string, key: string): TabDraft | undefined {
  return tabDrafts.get(tabId)?.get(key)
}

function setTabRevision(tabId: string, key: string): number {
  const nextRevision = ++revision
  let revisionsForTab = tabRevisions.get(tabId)
  if (!revisionsForTab) {
    revisionsForTab = new Map()
    tabRevisions.set(tabId, revisionsForTab)
  }
  revisionsForTab.set(key, nextRevision)
  return nextRevision
}

function setTabDraft(tabId: string, key: string, value: string, requestId?: number): void {
  const current = getTabDraft(tabId, key)
  if ((current?.value ?? '') === value) return
  setTabRevision(tabId, key)
  let draftsForTab = tabDrafts.get(tabId)
  if (value) {
    if (!draftsForTab) {
      draftsForTab = new Map()
      tabDrafts.set(tabId, draftsForTab)
    }
    const ownerRequestId = requestId ?? current?.requestId
    draftsForTab.set(key, {
      key,
      value,
      ...(ownerRequestId === undefined ? {} : { requestId: ownerRequestId }),
    })
  } else if (draftsForTab) {
    draftsForTab.delete(key)
    if (draftsForTab.size === 0) tabDrafts.delete(tabId)
  }
  emit(tabListenerKey(tabId))
  emit(key)
}

function removePendingResourcePrefill(tabId: string): void {
  if (!pendingResourcePrefillsByTab.delete(tabId)) return
  setTabRevision(tabId, NO_CHAT_DRAFT_KEY)
  emit(tabListenerKey(tabId))
}

/** Return the conflicting workspace owner for this exact draft key, if any. */
export function getComposerDraftOwnerConflict(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): string | null {
  // Blank Chat drafts are workspace-tab-owned. Matching agent names do not
  // make two tabs share a slot, and tab-less legacy callers use their own
  // independent slot, so neither can conflict with a workspace tab.
  void chatId
  void agentRef
  void workspaceTabId
  return null
}

export function getComposerDraftRevision(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): number {
  const key = keyFor(chatId, agentRef)
  if (chatId === null && workspaceTabId) {
    const tabDraft = getTabDraft(workspaceTabId, key)
    if (tabDraft) return tabRevisions.get(workspaceTabId)?.get(key) ?? 0
    const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
    if (pending) return pending.revision
    return tabRevisions.get(workspaceTabId)?.get(key) ?? 0
  }
  return revisions.get(key) ?? 0
}

export function getComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): string {
  const key = keyFor(chatId, agentRef)
  if (workspaceTabId) {
    const tabDraft = getTabDraft(workspaceTabId, key)
    if (tabDraft) return tabDraft.value
    const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
    if (pending && chatId === null) return pending.uri
  }
  if (workspaceTabId && chatId === null) return ''
  return drafts.get(key) ?? ''
}

/** Reserve a canonical resource prefill for one exact blank workspace tab. */
export function setResourceComposerPrefill(
  workspaceTabId: string,
  uri: string,
  agentRef: string | null
): boolean {
  if (!workspaceTabId) return false
  const requestId = ++resourcePrefillRequestSequence
  const key = keyFor(null, agentRef ?? undefined)
  if (getTabDraft(workspaceTabId, key)) return false
  if (pendingResourcePrefillsByTab.has(workspaceTabId)) return false

  if (agentRef) {
    // A resource prefill belongs to its destination tab. Another tab may own
    // an independent draft for this same agent without blocking this request.
    setTabDraft(workspaceTabId, key, uri, requestId)
    return true
  }

  const pendingRevision = ++revision
  pendingResourcePrefillsByTab.set(workspaceTabId, { requestId, revision: pendingRevision, uri })
  emit(tabListenerKey(workspaceTabId))
  return true
}

/** Claim a pre-agent prefill only from the exact workspace tab that owns it. */
export function claimPendingResourceComposerPrefill(
  workspaceTabId: string,
  agentRef: string
): void {
  const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
  const agent = agentRef.trim()
  if (!pending || !agent) return

  const key = keyFor(null, agent)
  const current = getTabDraft(workspaceTabId, key)
  if (current?.value) {
    removePendingResourcePrefill(workspaceTabId)
    return
  }
  setTabDraft(workspaceTabId, key, pending.uri, pending.requestId)
  removePendingResourcePrefill(workspaceTabId)
}

export function setComposerDraft(
  chatId: string | null,
  value: string,
  agentRef?: string,
  workspaceTabId?: string | null
): boolean {
  const key = keyFor(chatId, agentRef)
  if (chatId === null && workspaceTabId) {
    const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
    const currentTabDraft = getTabDraft(workspaceTabId, key)
    if (currentTabDraft) {
      removePendingResourcePrefill(workspaceTabId)
      setTabDraft(workspaceTabId, key, value, currentTabDraft?.requestId)
      return true
    }
    if (pending) {
      removePendingResourcePrefill(workspaceTabId)
      setTabDraft(workspaceTabId, key, value, pending.requestId)
      return true
    }
    setTabDraft(workspaceTabId, key, value)
    return true
  }
  setDraftByKey(key, value)
  return true
}

export function clearComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): boolean {
  const key = keyFor(chatId, agentRef)
  if (chatId === null && workspaceTabId) {
    const tabDraft = getTabDraft(workspaceTabId, key)
    if (tabDraft) setTabDraft(workspaceTabId, key, '')
    removePendingResourcePrefill(workspaceTabId)
    return true
  }
  return setDraftByKey(key, '') || !drafts.has(key)
}

/** Cancel an unclaimed request when its destination workspace tab closes. */
export function cancelPendingResourceComposerPrefill(workspaceTabId: string): void {
  removePendingResourcePrefill(workspaceTabId)
}

/** Release resource-owned draft state when its workspace destination closes. */
export function releaseComposerDraftForWorkspaceTab(workspaceTabId: string): void {
  removePendingResourcePrefill(workspaceTabId)
  for (const key of tabDrafts.get(workspaceTabId)?.keys() ?? []) {
    setTabDraft(workspaceTabId, key, '')
  }
}

/** Drop drafts and pending resource requests on logout or principal/team change. */
export function clearAllComposerDrafts(): void {
  automaticResourcePrefills.clear()
  const changedKeys = new Set(drafts.keys())
  const changedTabs = new Set([...pendingResourcePrefillsByTab.keys(), ...tabDrafts.keys()])
  for (const key of drafts.keys()) revisions.set(key, ++revision)
  drafts.clear()
  for (const tabId of pendingResourcePrefillsByTab.keys()) {
    setTabRevision(tabId, NO_CHAT_DRAFT_KEY)
  }
  pendingResourcePrefillsByTab.clear()
  for (const [tabId, draftsForTab] of tabDrafts) {
    for (const key of draftsForTab.keys()) {
      changedKeys.add(key)
      setTabRevision(tabId, key)
    }
  }
  tabDrafts.clear()
  for (const key of changedKeys) emit(key)
  for (const tabId of changedTabs) emit(tabListenerKey(tabId))
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
  agentRef?: string,
  workspaceTabId?: string | null
): () => void {
  const keys = [
    keyFor(chatId, agentRef),
    ...(workspaceTabId ? [tabListenerKey(workspaceTabId)] : []),
  ]
  for (const key of keys) {
    let listeners = listenersByKey.get(key)
    if (!listeners) {
      listeners = new Set()
      listenersByKey.set(key, listeners)
    }
    listeners.add(listener)
  }
  return () => {
    for (const key of keys) {
      const listeners = listenersByKey.get(key)
      if (!listeners) continue
      listeners.delete(listener)
      if (listeners.size === 0) listenersByKey.delete(key)
    }
  }
}

/** Test helper: wipe all drafts and listeners. */
export function resetComposerDraftStore(): void {
  drafts.clear()
  revisions.clear()
  listenersByKey.clear()
  automaticResourcePrefills.clear()
  pendingResourcePrefillsByTab.clear()
  tabDrafts.clear()
  tabRevisions.clear()
  resourcePrefillRequestSequence = 0
}
