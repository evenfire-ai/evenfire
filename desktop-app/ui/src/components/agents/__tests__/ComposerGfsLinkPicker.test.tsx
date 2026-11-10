// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import type {
  GfsBrowserChild,
  useGfsBrowserController,
} from '@hooks/domain/useGfsBrowserController'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { ComposerGfsLinkPicker } from '../ComposerGfsLinkPicker'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function render(ui: ReactNode, controller?: ReturnType<typeof useGfsBrowserController>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (controller?.sessionScope && controller.sessionGeneration !== null)
    queryClient.setQueryData(
      desktopQueryKeys.gfsAccessible(controller.sessionScope, 'main', controller.sessionGeneration),
      {
        pages: [{ items: controller.accessibleResources, nextCursor: null }],
        pageParams: [undefined],
      }
    )
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function resource(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  readable?: boolean
): GfsBrowserChild {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind,
    path: `/${name}`,
    version: 1,
    bytes: 12,
    readable,
  }
}

function baseController(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof useGfsBrowserController> {
  return {
    crumbs: [],
    current: null,
    sessionScope: 'env:user:team',
    sessionGeneration: 1,
    accessState: 'active',
    isSessionAuthorityActive: vi.fn(() => true),
    handleAuthorityFailure: vi.fn(() => false),
    items: [],
    accessibleResources: [],
    accessibleSnapshotRevision: 1,
    accessibleSnapshotData: undefined,
    isAccessibleSnapshotCurrent: vi.fn(() => true),
    loading: false,
    loadingAccessible: false,
    error: null,
    accessibleError: null,
    accessibleNotice: null,
    discoveryFailure: null,
    hasMore: false,
    hasMoreAccessible: false,
    isFetchingMore: false,
    isFetchingMoreAccessible: false,
    retryChildren: vi.fn(),
    retryDiscovery: vi.fn(),
    loadMore: vi.fn(),
    loadMoreAccessible: vi.fn(),
    openChild: vi.fn(),
    openResource: vi.fn(),
    goToCrumb: vi.fn(),
    reset: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useGfsBrowserController>
}

describe('ComposerGfsLinkPicker', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async (resourceId: string) => ({
            ...delegationAffordances(new Set(resourceId === 'secret-file' ? [] : ['read']), false),
          })),
        },
      } as unknown as Window['clerum'],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as Partial<typeof window>).clerum
  })

  it('lists only exact-authorized rows and inserts a folder from its main row', async () => {
    const folder = resource('folder-a', 'Folder A', 'directory')
    const secret = resource('secret-file', 'Secret file', 'file', false)
    const controller = baseController({ accessibleResources: [folder, secret] })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const onInsert = vi.fn()
    const onSessionScope = vi.fn()
    render(
      <ComposerGfsLinkPicker
        controller={controller}
        rootAnchorRef={{ current: null }}
        sessionId={7}
        onInsert={onInsert}
        onSessionScope={onSessionScope}
        onEscapeRoot={vi.fn()}
      />,
      controller
    )

    const folderRow = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    expect(screen.queryByRole('menuitem', { name: 'Insert link to Folder A' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Expand folder Folder A' })).toBeTruthy()
    expect(screen.queryByText('Secret file')).toBeNull()
    expect(onSessionScope).toHaveBeenCalledWith(7, 'env:user:team', 1)

    fireEvent.click(folderRow)
    expect(onInsert).toHaveBeenCalledWith(
      { label: 'Folder A', uri: folder.gfsUri, resourceId: folder.resourceId },
      'env:user:team',
      7,
      1,
      expect.any(Function),
      expect.any(Function)
    )
    expect(controller.openResource).not.toHaveBeenCalled()
  })

  it('supports arrow and Home/End menu navigation', async () => {
    const controller = baseController({
      accessibleResources: [
        resource('folder-a', 'Folder A', 'directory'),
        resource('file-a', 'File A', 'file'),
      ],
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    render(
      <ComposerGfsLinkPicker
        controller={controller}
        rootAnchorRef={{ current: null }}
        sessionId={8}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={vi.fn()}
      />,
      controller
    )

    const folderRow = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    const insertFile = await screen.findByRole('menuitem', { name: 'Insert link to File A' })
    folderRow.focus()
    fireEvent.keyDown(folderRow, { key: 'End' })
    expect(document.activeElement).toBe(insertFile)
    fireEvent.keyDown(insertFile, { key: 'Home' })
    expect(document.activeElement).toBe(folderRow)
  })

  it('inserts an exact file URI from the root list', async () => {
    const file = resource('exact-file', 'Notes.md', 'file')
    const controller = baseController({
      accessibleResources: [file],
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const onInsert = vi.fn()
    const onEscapeRoot = vi.fn()
    const { container } = render(
      <ComposerGfsLinkPicker
        controller={controller}
        rootAnchorRef={{ current: null }}
        sessionId={9}
        onInsert={onInsert}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />,
      controller
    )

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Insert link to Notes.md' }))
    expect(onInsert).toHaveBeenCalledWith(
      { label: 'Notes.md', uri: 'gfs://main/exact-file', resourceId: 'exact-file' },
      'env:user:team',
      9,
      1,
      expect.any(Function),
      expect.any(Function)
    )
    expect(container.querySelector('[role="menu"]')).toBeTruthy()
    expect(onEscapeRoot).not.toHaveBeenCalled()
  })

  it('sanitizes bidi controls in displayed and inserted GFS names while retaining the URI', async () => {
    const maliciousName = 'invoice.pdf\u202Eexe'
    const resourceId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const uri = `gfs://main/${resourceId}`
    const file = resource(resourceId, maliciousName, 'file')
    const controller = baseController({ accessibleResources: [file] })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const onInsert = vi.fn()
    render(
      <ComposerGfsLinkPicker
        controller={controller}
        rootAnchorRef={{ current: null }}
        sessionId={13}
        onInsert={onInsert}
        onSessionScope={vi.fn()}
        onEscapeRoot={vi.fn()}
      />,
      controller
    )

    const safeName = 'invoice.pdfexe'
    const insert = await screen.findByRole('menuitem', { name: `Insert link to ${safeName}` })
    expect(screen.queryByText(maliciousName)).toBeNull()
    fireEvent.click(insert)

    expect(onInsert).toHaveBeenCalledWith(
      { label: 'invoice.pdfexe', uri, resourceId },
      'env:user:team',
      13,
      1,
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('uses Escape to close the root picker when no folder is active', () => {
    const onEscapeRoot = vi.fn()
    const controller = baseController({
      accessibleResources: [resource('child', 'Child', 'directory')],
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller)
    const { unmount } = render(
      <ComposerGfsLinkPicker
        controller={controller}
        rootAnchorRef={{ current: null }}
        sessionId={11}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )

    const escape = () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    escape()
    expect(onEscapeRoot).toHaveBeenCalledOnce()
    unmount()

    const rootController = baseController()
    hookMock.useGfsBrowserController.mockReturnValue(rootController)
    render(
      <ComposerGfsLinkPicker
        controller={rootController}
        rootAnchorRef={{ current: null }}
        sessionId={11}
        onInsert={vi.fn()}
        onSessionScope={vi.fn()}
        onEscapeRoot={onEscapeRoot}
      />
    )
    escape()
    expect(onEscapeRoot).toHaveBeenCalledTimes(2)
  })
})
