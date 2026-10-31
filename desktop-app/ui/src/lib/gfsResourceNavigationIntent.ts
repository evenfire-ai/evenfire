import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { activeWorkspaceTab } from './workspaceTabs'
import type { WorkspaceTab, WorkspaceTabsState } from './workspaceTabs.types'

export interface GfsResourceNavigationRequest {
  readonly id: number
  readonly uri: string
  readonly ownerTabId: string
  readonly intentSequence: number
  readonly principalGeneration: number
  readonly userNavigationGenerationAtActivation: number
  readonly createDestination: boolean
}

export type GfsResourceNavigationOwnerAssignment =
  | { readonly ownerTabId: string; readonly createDestination: false }
  | { readonly ownerTabId: null; readonly createDestination: true }

export interface GfsResourceNavigationContext {
  intentSequence: number
  principalGeneration: number
  userNavigationGeneration: number
  activeTabId: string | null
  tabs: readonly Pick<WorkspaceTab, 'id' | 'kind'>[]
}

/** Assign a link to the current Files tab or to a new, isolated destination. */
export function assignGfsResourceNavigationOwner(
  workspaceTabs: WorkspaceTabsState,
  uri: string
): GfsResourceNavigationOwnerAssignment {
  const active = activeWorkspaceTab(workspaceTabs)
  if (active?.kind === 'files') {
    return { ownerTabId: active.id, createDestination: false }
  }

  const canonicalUri = normalizeGfsResourceUri(uri)
  const exactOwner = canonicalUri
    ? workspaceTabs.tabs.find(
        tab =>
          tab.kind === 'files' && normalizeGfsResourceUri(tab.files?.path ?? '') === canonicalUri
      )
    : undefined
  if (exactOwner?.kind === 'files') {
    return { ownerTabId: exactOwner.id, createDestination: false }
  }

  return { ownerTabId: null, createDestination: true }
}

/** An activation is valid only until the next explicit user navigation. */
export function isGfsResourceNavigationActivationCurrent(
  userNavigationGenerationAtActivation: number,
  currentUserNavigationGeneration: number
): boolean {
  return (
    Number.isSafeInteger(userNavigationGenerationAtActivation) &&
    userNavigationGenerationAtActivation >= 0 &&
    Number.isSafeInteger(currentUserNavigationGeneration) &&
    currentUserNavigationGeneration >= 0 &&
    userNavigationGenerationAtActivation === currentUserNavigationGeneration
  )
}

/** A completion is eligible only for its exact current tab, intent, and principal. */
export function canCompleteGfsResourceNavigation(
  request: GfsResourceNavigationRequest,
  context: GfsResourceNavigationContext
): boolean {
  return (
    request.intentSequence === context.intentSequence &&
    request.principalGeneration === context.principalGeneration &&
    request.userNavigationGenerationAtActivation === context.userNavigationGeneration &&
    context.activeTabId === request.ownerTabId &&
    context.tabs.some(tab => tab.id === request.ownerTabId && tab.kind === 'files')
  )
}

export function isGfsResourceNavigationOwnerPresent(
  request: GfsResourceNavigationRequest,
  tabs: readonly Pick<WorkspaceTab, 'id' | 'kind'>[]
): boolean {
  return tabs.some(tab => tab.id === request.ownerTabId && tab.kind === 'files')
}
