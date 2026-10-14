import { activeWorkspaceTab } from './workspaceTabs'
import type { WorkspaceTab, WorkspaceTabsState } from './workspaceTabs.types'

export interface GfsResourceNavigationRequest {
  readonly id: number
  readonly uri: string
  readonly ownerTabId: string
  readonly intentSequence: number
  readonly principalGeneration: number
  readonly createDestination: boolean
}

export type GfsResourceNavigationOwnerAssignment =
  | { readonly ownerTabId: string; readonly createDestination: false }
  | { readonly ownerTabId: null; readonly createDestination: true }

export interface GfsResourceNavigationContext {
  intentSequence: number
  principalGeneration: number
  activeTabId: string | null
  tabs: readonly Pick<WorkspaceTab, 'id' | 'kind'>[]
}

/** Assign a link to the current Files tab, an existing root, or a reserved root ID. */
export function assignGfsResourceNavigationOwner(
  workspaceTabs: WorkspaceTabsState
): GfsResourceNavigationOwnerAssignment {
  const active = activeWorkspaceTab(workspaceTabs)
  if (active?.kind === 'files') {
    return { ownerTabId: active.id, createDestination: false }
  }

  const root = workspaceTabs.tabs.find(tab => tab.kind === 'files' && tab.files?.path == null)
  if (root) return { ownerTabId: root.id, createDestination: false }

  return { ownerTabId: null, createDestination: true }
}

/** A completion is eligible only for its exact current tab, intent, and principal. */
export function canCompleteGfsResourceNavigation(
  request: GfsResourceNavigationRequest,
  context: GfsResourceNavigationContext
): boolean {
  return (
    request.intentSequence === context.intentSequence &&
    request.principalGeneration === context.principalGeneration &&
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
