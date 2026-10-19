/**
 * Composer draft store — the single source of truth for unsent composer text,
 * keyed per chat. Resource prefills that begin before agent selection are held
 * by the exact destination workspace tab and can only be claimed there.
 */

type Listener = () => void

type ResourcePrefill = { requestId: number; uri: string }
type TabDraft = { key: string; value: string; requestId?: number }
type DraftOwner = { tabId: string; requestId: number }

/** Legacy no-chat key retained for callers that do not yet provide an agent. */
const NO_CHAT_DRAFT_KEY = '__no_chat__'
const drafts = new Map<string, string>()
let revision = 0
const revisions = new Map<string, number>()
const listenersByKey = new Map<string, Set<Listener>>()
const pendingResourcePrefillsByTab = new Map<string, ResourcePrefill>()
const resourceDraftOwnersByKey = new Map<string, DraftOwner>()
const tabDrafts = new Map<string, TabDraft>()
const tabRevisions = new Map<string, number>()
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

function setDraftByKey(key: string, value: string): void {
  if ((drafts.get(key) ?? '') === value) return
  revisions.set(key, ++revision)
  if (value) drafts.set(key, value)
  else drafts.delete(key)
  emit(key)
}

function setTabDraft(tabId: string, key: string, value: string, requestId?: number): void {
  const current = tabDrafts.get(tabId)
  if ((current?.key === key ? current.value : '') === value) return
  tabRevisions.set(tabId, ++revision)
  if (value) {
    const ownerRequestId = requestId ?? (current?.key === key ? current.requestId : undefined)
    tabDrafts.set(tabId, {
      key,
      value,
      ...(ownerRequestId === undefined ? {} : { requestId: ownerRequestId }),
    })
  } else tabDrafts.delete(tabId)
  emit(tabListenerKey(tabId))
}

function removePendingResourcePrefill(tabId: string): void {
  if (!pendingResourcePrefillsByTab.delete(tabId)) return
  emit(tabListenerKey(tabId))
}

export function getComposerDraftRevision(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): number {
  if (workspaceTabId) {
    const tabDraft = tabDrafts.get(workspaceTabId)
    if (tabDraft?.key === keyFor(chatId, agentRef)) return tabRevisions.get(workspaceTabId) ?? 0
  }
  return revisions.get(keyFor(chatId, agentRef)) ?? 0
}

export function getComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): string {
  const key = keyFor(chatId, agentRef)
  if (workspaceTabId) {
    const tabDraft = tabDrafts.get(workspaceTabId)
    if (tabDraft?.key === key) return tabDraft.value
    const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
    if (pending && chatId === null) return pending.uri
  }
  const owner = resourceDraftOwnersByKey.get(key)
  if (owner && owner.tabId !== workspaceTabId) return ''
  return drafts.get(key) ?? ''
}

/** Reserve a canonical resource prefill for one exact blank workspace tab. */
export function setResourceComposerPrefill(
  workspaceTabId: string,
  uri: string,
  agentRef: string | null
): boolean {
  if (!workspaceTabId || getComposerDraft(null, agentRef ?? undefined, workspaceTabId)) {
    return false
  }
  const requestId = ++resourcePrefillRequestSequence
  const key = keyFor(null, agentRef ?? undefined)
  const existing = drafts.get(key) ?? ''
  const existingOwner = resourceDraftOwnersByKey.get(key)

  if (agentRef) {
    if (existing && !existingOwner) return false
    if (existingOwner && existingOwner.tabId !== workspaceTabId) {
      setTabDraft(workspaceTabId, key, uri, requestId)
      return true
    }
    resourceDraftOwnersByKey.set(key, { tabId: workspaceTabId, requestId })
    setDraftByKey(key, uri)
    return true
  }

  pendingResourcePrefillsByTab.set(workspaceTabId, { requestId, uri })
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
  const existing = drafts.get(key) ?? ''
  const owner = resourceDraftOwnersByKey.get(key)
  if (existing && !owner) {
    removePendingResourcePrefill(workspaceTabId)
    return
  }
  if (owner?.tabId === workspaceTabId) {
    removePendingResourcePrefill(workspaceTabId)
    return
  }
  if (owner && owner.tabId !== workspaceTabId) {
    setTabDraft(workspaceTabId, key, pending.uri, pending.requestId)
    removePendingResourcePrefill(workspaceTabId)
    return
  }

  resourceDraftOwnersByKey.set(key, { tabId: workspaceTabId, requestId: pending.requestId })
  setDraftByKey(key, pending.uri)
  removePendingResourcePrefill(workspaceTabId)
}

export function setComposerDraft(
  chatId: string | null,
  value: string,
  agentRef?: string,
  workspaceTabId?: string | null
): void {
  const key = keyFor(chatId, agentRef)
  if (chatId === null && workspaceTabId) {
    const pending = pendingResourcePrefillsByTab.get(workspaceTabId)
    const owner = resourceDraftOwnersByKey.get(key)
    const currentTabDraft = tabDrafts.get(workspaceTabId)
    if (currentTabDraft?.key === key || (owner && owner.tabId !== workspaceTabId)) {
      removePendingResourcePrefill(workspaceTabId)
      setTabDraft(workspaceTabId, key, value, currentTabDraft?.requestId)
      return
    }
    if (pending) {
      removePendingResourcePrefill(workspaceTabId)
      if ((drafts.get(key) ?? '') && !owner) {
        setTabDraft(workspaceTabId, key, value)
        return
      }
      if (!value) {
        if (owner?.tabId === workspaceTabId) resourceDraftOwnersByKey.delete(key)
        setDraftByKey(key, '')
        return
      }
      resourceDraftOwnersByKey.set(key, { tabId: workspaceTabId, requestId: pending.requestId })
      setDraftByKey(key, value)
      return
    }
    if (owner?.tabId === workspaceTabId && !value) resourceDraftOwnersByKey.delete(key)
  }
  setDraftByKey(key, value)
}

export function clearComposerDraft(
  chatId: string | null,
  agentRef?: string,
  workspaceTabId?: string | null
): void {
  const key = keyFor(chatId, agentRef)
  if (workspaceTabId) {
    const tabDraft = tabDrafts.get(workspaceTabId)
    if (tabDraft?.key === key) {
      setTabDraft(workspaceTabId, key, '')
      return
    }
    removePendingResourcePrefill(workspaceTabId)
    const owner = resourceDraftOwnersByKey.get(key)
    if (owner && owner.tabId !== workspaceTabId) return
    if (owner?.tabId === workspaceTabId) resourceDraftOwnersByKey.delete(key)
  } else {
    resourceDraftOwnersByKey.delete(key)
  }
  setDraftByKey(key, '')
}

/** Cancel an unclaimed request when its destination workspace tab closes. */
export function cancelPendingResourceComposerPrefill(workspaceTabId: string): void {
  removePendingResourcePrefill(workspaceTabId)
}

/** Release resource-owned draft state when its workspace destination closes. */
export function releaseComposerDraftForWorkspaceTab(workspaceTabId: string): void {
  removePendingResourcePrefill(workspaceTabId)
  const tabDraft = tabDrafts.get(workspaceTabId)
  if (tabDraft) setTabDraft(workspaceTabId, tabDraft.key, '')

  for (const [key, owner] of resourceDraftOwnersByKey) {
    if (owner.tabId !== workspaceTabId) continue
    resourceDraftOwnersByKey.delete(key)
    setDraftByKey(key, '')
  }
}

/** Drop drafts and pending resource requests on logout or principal/team change. */
export function clearAllComposerDrafts(): void {
  const changedKeys = new Set([...drafts.keys(), ...resourceDraftOwnersByKey.keys()])
  const changedTabs = new Set([...pendingResourcePrefillsByTab.keys(), ...tabDrafts.keys()])
  for (const key of drafts.keys()) revisions.set(key, ++revision)
  drafts.clear()
  resourceDraftOwnersByKey.clear()
  pendingResourcePrefillsByTab.clear()
  for (const tabId of tabDrafts.keys()) tabRevisions.set(tabId, ++revision)
  tabDrafts.clear()
  for (const key of changedKeys) emit(key)
  for (const tabId of changedTabs) emit(tabListenerKey(tabId))
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
  pendingResourcePrefillsByTab.clear()
  resourceDraftOwnersByKey.clear()
  tabDrafts.clear()
  tabRevisions.clear()
  resourcePrefillRequestSequence = 0
}
