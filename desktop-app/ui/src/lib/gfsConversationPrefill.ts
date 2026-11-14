import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import {
  getComposerDraft,
  setAutomaticComposerDraft,
  setResourceComposerPrefill,
} from './composerDraftStore'
import type { WorkspaceTab } from './workspaceTabs.types'

export type GfsConversationContext = {
  uri: string
  sourceTabId: string
  activationId: number
  authorityScope: string
}

export interface PersistedConversationPrefillDestination {
  authorityScope: string
  agentRef: string
  chatId: string
  workspaceChatTabId: string
}

export type PersistedConversationActivationOrigin =
  | 'focus'
  | 'visible'
  | 'resource-activation'
  | 'sidebar-session'
  | 'chat-thread-session'
  | 'workspace-chat-tab'
  | 'drawer-chat-switcher'
  | 'header-conversation'

export type PersistedConversationPrefillStatus =
  | 'awaiting-authorization'
  | 'pending-ready'
  | 'bound-eligible'
  | 'suspended-resource'
  | 'consumed'
  | 'superseded'
  | 'terminally-cancelled'
  | 'owner-destroyed'

/**
 * App/selection-owned activation state. ComposerPanel observes this snapshot;
 * it never owns or recreates the activation.
 */
export interface PersistedConversationPrefillReceipt {
  id: number
  intentSequence: number
  authorityScope: string
  origin: PersistedConversationActivationOrigin
  agentRef: string
  chatId: string
  resource: GfsConversationContext
  status: PersistedConversationPrefillStatus
  destinationWorkspaceTabId: string | null
}

let latestGfsConversationContext: GfsConversationContext | null = null
let resourceActivationSequence = 0

function matchesGfsConversationAuthorityScope(
  context: GfsConversationContext,
  authorityScope: string | undefined
): boolean {
  return authorityScope === undefined || context.authorityScope === authorityScope
}

function resourceUriForTab(tab: WorkspaceTab | null | undefined): string | null {
  const rawUri =
    tab?.kind === 'files' ? tab.files?.path : tab?.kind === 'preview' ? tab.preview?.gfsUri : null
  return rawUri ? normalizeGfsResourceUri(rawUri) : null
}

/** Retain the exact visible GFS route while the user moves between workspace surfaces. */
export function recordLatestGfsConversationContext(
  tab: WorkspaceTab,
  forceActivation = false,
  authorityScope = '',
  resourceOwnerPublication = false
): void {
  const uri = resourceUriForTab(tab)
  if (!uri) {
    latestGfsConversationContext = null
    return
  }
  const current = latestGfsConversationContext
  if (
    current?.uri === uri &&
    current.sourceTabId === tab.id &&
    current.authorityScope !== authorityScope &&
    !resourceOwnerPublication
  ) {
    return
  }
  if (
    !forceActivation &&
    current?.uri === uri &&
    current.sourceTabId === tab.id &&
    current.authorityScope === authorityScope
  ) {
    return
  }
  latestGfsConversationContext = {
    uri,
    sourceTabId: tab.id,
    activationId: ++resourceActivationSequence,
    authorityScope,
  }
}

export function getLatestGfsConversationContext(
  authorityScope?: string
): GfsConversationContext | null {
  const context = latestGfsConversationContext
  if (!context || !matchesGfsConversationAuthorityScope(context, authorityScope)) {
    return null
  }
  return context
}

/**
 * A closed source tab retains the exact context by contract. A still-present
 * source must continue to identify the same resource, and an unavailable
 * Preview owner cannot authorize a new or resumed Composer insertion.
 */
export function isGfsConversationContextAvailable(
  context: GfsConversationContext | null,
  tabs: readonly WorkspaceTab[],
  authorityScope?: string
): boolean {
  if (!context || !matchesGfsConversationAuthorityScope(context, authorityScope)) {
    return false
  }
  const owner = tabs.find(tab => tab.id === context.sourceTabId)
  if (!owner) return true
  if (owner.kind === 'files') return resourceUriForTab(owner) === context.uri
  if (owner.kind === 'preview') {
    return !owner.preview?.unavailable && resourceUriForTab(owner) === context.uri
  }
  return false
}

/** Forget resource context when the authenticated principal changes or logs out. */
export function clearLatestGfsConversationContext(): void {
  latestGfsConversationContext = null
}

/** Prefill a persisted chat once for an exact resource context, and only if its draft is empty. */
export function prefillEmptyConversationWithGfsResource(
  chatId: string | null,
  agentRef: string | null,
  context: GfsConversationContext | null = latestGfsConversationContext,
  destination?: PersistedConversationPrefillDestination,
  inputText = ''
): boolean {
  if (!chatId || !agentRef || !context || !destination || inputText !== '') return false
  if (destination.chatId !== chatId || destination.agentRef !== agentRef) return false
  if (destination.authorityScope !== context.authorityScope) return false
  if (
    getComposerDraft(chatId, agentRef, destination.workspaceChatTabId, destination.authorityScope)
  ) {
    return false
  }
  return setAutomaticComposerDraft(destination, context.uri)
}

export function prefillNewConversationWithGfsResource(
  tab: WorkspaceTab | null | undefined,
  agentRef: string | null,
  destinationWorkspaceTabId: string | null | undefined
): boolean {
  const rawUri =
    tab?.kind === 'files' ? tab.files?.path : tab?.kind === 'preview' ? tab.preview?.gfsUri : null
  const uri = rawUri ? normalizeGfsResourceUri(rawUri) : null
  if (!uri || !destinationWorkspaceTabId) return false
  return setResourceComposerPrefill(destinationWorkspaceTabId, uri, agentRef)
}
