import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type GfsResourceNavigationContext,
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationOwnerPresent,
} from './gfsResourceNavigationIntent'
import {
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  openFilesTab,
} from './workspaceTabs'

const request: GfsResourceNavigationRequest = {
  id: 1084,
  uri: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ownerTabId: 'files-a',
  intentSequence: 17,
  principalGeneration: 3,
  createDestination: false,
}

function eligibleContext(): GfsResourceNavigationContext {
  return {
    intentSequence: request.intentSequence,
    principalGeneration: request.principalGeneration,
    activeTabId: request.ownerTabId,
    tabs: [{ id: request.ownerTabId, kind: 'files' }],
  }
}

describe('GFS resource navigation intent ownership', () => {
  it('binds a link to the active Files tab, or to a stable root destination', () => {
    const activeFiles = openFilesTab(createWorkspaceTabsState('chat'), {
      id: 'files-a',
      path: request.uri,
    })
    expect(assignGfsResourceNavigationOwner(activeFiles)).toEqual({
      ownerTabId: 'files-a',
      createDestination: false,
    })

    const existingRoot = openFilesTab(activeFiles, { id: 'files-root' })
    expect(assignGfsResourceNavigationOwner(existingRoot)).toEqual({
      ownerTabId: 'files-root',
      createDestination: false,
    })

    expect(assignGfsResourceNavigationOwner(createEmptyWorkspaceTabsState())).toEqual({
      ownerTabId: null,
      createDestination: true,
    })
  })

  it('allows completion only for the unchanged owner, intent, and principal', () => {
    const context = eligibleContext()
    expect(canCompleteGfsResourceNavigation(request, context)).toBe(true)
    expect(isGfsResourceNavigationOwnerPresent(request, context.tabs)).toBe(true)

    expect(canCompleteGfsResourceNavigation(request, { ...context, activeTabId: 'files-b' })).toBe(
      false
    )
    expect(
      canCompleteGfsResourceNavigation(request, {
        ...context,
        tabs: [{ id: 'files-b', kind: 'files' }],
      })
    ).toBe(false)
    expect(
      canCompleteGfsResourceNavigation(request, {
        ...context,
        principalGeneration: context.principalGeneration + 1,
      })
    ).toBe(false)
    expect(isGfsResourceNavigationOwnerPresent(request, [])).toBe(false)
  })

  it('rejects every strictly newer navigation intent, regardless of resolution order', () => {
    const context = eligibleContext()
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), offset => {
        const sequence = request.intentSequence + offset
        expect(
          canCompleteGfsResourceNavigation(request, { ...context, intentSequence: sequence })
        ).toBe(false)
      })
    )
  })
})
