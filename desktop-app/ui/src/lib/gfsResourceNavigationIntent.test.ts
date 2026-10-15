import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type GfsResourceNavigationContext,
  type GfsResourceNavigationRequest,
  assignGfsResourceNavigationOwner,
  canCompleteGfsResourceNavigation,
  isGfsResourceNavigationActivationCurrent,
  isGfsResourceNavigationOwnerPresent,
} from './gfsResourceNavigationIntent'
import {
  createEmptyWorkspaceTabsState,
  createWorkspaceTabsState,
  openFilesTab,
  selectWorkspaceTab,
} from './workspaceTabs'

const request: GfsResourceNavigationRequest = {
  id: 1084,
  uri: 'gfs://main/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ownerTabId: 'files-a',
  intentSequence: 17,
  principalGeneration: 3,
  userNavigationGenerationAtActivation: 8,
  createDestination: false,
}

function eligibleContext(): GfsResourceNavigationContext {
  return {
    intentSequence: request.intentSequence,
    principalGeneration: request.principalGeneration,
    userNavigationGeneration: request.userNavigationGenerationAtActivation,
    activeTabId: request.ownerTabId,
    tabs: [{ id: request.ownerTabId, kind: 'files' }],
  }
}

describe('GFS resource navigation intent ownership', () => {
  it('binds a link to active Files or creates a new destination without reusing an inactive root', () => {
    const activeFiles = openFilesTab(createWorkspaceTabsState('chat'), {
      id: 'files-a',
      path: request.uri,
    })
    expect(assignGfsResourceNavigationOwner(activeFiles, request.uri)).toEqual({
      ownerTabId: 'files-a',
      createDestination: false,
    })

    const inactiveRoot = openFilesTab(createWorkspaceTabsState('chat'), { id: 'files-root' })
    const chatSelected = selectWorkspaceTab(inactiveRoot, 'chat')
    expect(assignGfsResourceNavigationOwner(chatSelected, request.uri)).toEqual({
      ownerTabId: null,
      createDestination: true,
    })

    const exactResourceTab = selectWorkspaceTab(
      openFilesTab(createWorkspaceTabsState('chat'), {
        id: 'files-exact',
        path: request.uri,
      }),
      'chat'
    )
    expect(assignGfsResourceNavigationOwner(exactResourceTab, request.uri)).toEqual({
      ownerTabId: 'files-exact',
      createDestination: false,
    })

    expect(assignGfsResourceNavigationOwner(createEmptyWorkspaceTabsState(), request.uri)).toEqual({
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
    expect(
      canCompleteGfsResourceNavigation(request, {
        ...context,
        userNavigationGeneration: context.userNavigationGeneration + 1,
      })
    ).toBe(false)
  })

  it('rejects activations superseded by every newer explicit user navigation', () => {
    expect(isGfsResourceNavigationActivationCurrent(8, 8)).toBe(true)
    expect(isGfsResourceNavigationActivationCurrent(7, 8)).toBe(false)
    expect(isGfsResourceNavigationActivationCurrent(-1, 0)).toBe(false)
    expect(isGfsResourceNavigationActivationCurrent(Number.NaN, 0)).toBe(false)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (activationGeneration, offset) => {
          expect(
            isGfsResourceNavigationActivationCurrent(
              activationGeneration,
              activationGeneration + offset
            )
          ).toBe(false)
        }
      )
    )
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
