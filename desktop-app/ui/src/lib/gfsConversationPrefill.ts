import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  claimAutomaticResourcePrefill,
  getComposerDraft,
  setComposerDraft,
  setResourceComposerPrefill,
} from './composerDraftStore'
import type { WorkspaceTab } from './workspaceTabs.types'

export type GfsConversationContext = { uri: string; sourceTabId: string }

let latestGfsConversationContext: GfsConversationContext | null = null

function resourceUriForTab(tab: WorkspaceTab | null | undefined): string | null {
  const rawUri =
    tab?.kind === 'files' ? tab.files?.path : tab?.kind === 'preview' ? tab.preview?.gfsUri : null
  return rawUri ? normalizeGfsResourceUri(rawUri) : null
}

/** Retain the exact visible GFS route while the user moves between workspace surfaces. */
export function recordLatestGfsConversationContext(tab: WorkspaceTab): void {
  const uri = resourceUriForTab(tab)
  latestGfsConversationContext = uri ? { uri, sourceTabId: tab.id } : null
}

export function getLatestGfsConversationContext(): GfsConversationContext | null {
  return latestGfsConversationContext
}

/** Forget resource context when the authenticated principal changes or logs out. */
export function clearLatestGfsConversationContext(): void {
  latestGfsConversationContext = null
}

/** Prefill a persisted chat once for an exact resource context, and only if its draft is empty. */
export function prefillEmptyConversationWithGfsResource(
  chatId: string | null,
  agentRef: string | null,
  context: GfsConversationContext | null = latestGfsConversationContext
): boolean {
  if (!chatId || !agentRef || !context) return false
  const key = `${agentRef}\u0000${chatId}\u0000${context.uri}`
  if (!claimAutomaticResourcePrefill(key)) return false
  if (getComposerDraft(chatId, agentRef) !== '') return false
  setComposerDraft(chatId, context.uri, agentRef)
  return true
}

export function prefillNewConversationWithGfsResource(
  tab: WorkspaceTab | null | undefined,
  agentRef: string | null,
  destinationWorkspaceTabId: string | null | undefined
): boolean {
  const context = latestGfsConversationContext
  if (!context) return false
  if (tab?.kind !== 'files' && tab?.kind !== 'preview') return false
  const visibleUri = resourceUriForTab(tab)
  if (!visibleUri || tab.id !== context.sourceTabId || visibleUri !== context.uri) return false
  const uri = context.uri
  if (!uri || !destinationWorkspaceTabId) return false
  return setResourceComposerPrefill(destinationWorkspaceTabId, uri, agentRef)
}
