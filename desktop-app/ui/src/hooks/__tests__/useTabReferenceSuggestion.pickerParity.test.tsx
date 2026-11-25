// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { DESKTOP_ROUTES } from '@constants/navigation'
import { ComposerGlobalFilesModal } from '../../components/agents/ComposerGlobalFilesModal'
import { listAccessiblePage } from '../../gfs/__fixtures__/gfsProducerFixtures'
import {
  type NavigationResolution,
  gfscResourceView,
  resolvedNavigation,
} from '../../gfs/__fixtures__/navigationResolutionFixtures'
import {
  activeWorkspaceTab,
  createEmptyWorkspaceTabsState,
  openFilesTab,
} from '../../lib/workspaceTabs'
import { useTabReferenceSuggestion } from '../useTabReferenceSuggestion'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** The modal reads only these controller fields; see ComposerGlobalFilesModal.test.tsx. */
function pickerController(accessibleResources: unknown[]) {
  return {
    current: null,
    crumbs: [],
    items: [],
    accessibleResources,
    loading: false,
    loadingAccessible: false,
    error: null,
    errorUpdatedAt: 0,
    accessibleError: null,
    accessibleNotice: null,
    discoveryFailure: null,
    retryDiscovery: vi.fn(),
    retryChildren: vi.fn(),
    hasMore: false,
    hasMoreAccessible: false,
    isFetchingMore: false,
    isFetchingMoreAccessible: false,
    loadMore: vi.fn(),
    loadMoreAccessible: vi.fn(),
    openChild: vi.fn(),
    openResource: vi.fn(),
    goToCrumb: vi.fn(),
    reset: vi.fn(),
  }
}

describe('useTabReferenceSuggestion — picker parity', () => {
  it('suggests exactly the reference the picker attaches for the same file', async () => {
    const view = await gfscResourceView({
      resourceId: '0b9f3c1e-7a42-4d4e-9c1a-5f6e7d8c9b0a',
      name: 'report.md',
      version: 3,
      bytes: 11,
    })

    const page = await listAccessiblePage([view])
    hookMock.useGfsBrowserController.mockReturnValue(pickerController(page.items))
    const onAdd = vi.fn()
    render(<ComposerGlobalFilesModal attachedIds={[]} onAdd={onAdd} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Attach 1' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
    const [pickerReference] = onAdd.mock.calls[0]![0]

    const answer: NavigationResolution = await resolvedNavigation(view)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { resolveForNavigation: async () => answer } } as unknown as Window['clerum'],
    })
    const hook = renderHook(() =>
      useTabReferenceSuggestion({
        activeTab: activeWorkspaceTab(
          openFilesTab(createEmptyWorkspaceTabsState(), { id: 'files-1', path: view.gfsUri })
        ),
        navItem: DESKTOP_ROUTES.files,
        filesResolvedLocation: { gfsUri: view.gfsUri, kind: 'file' },
        authorityScope: 'dev:true:user-1:',
        drawerVisible: true,
      })
    )
    await act(async () => {})
    expect(hook.result.current.candidate).toEqual(pickerReference)
  })
})
