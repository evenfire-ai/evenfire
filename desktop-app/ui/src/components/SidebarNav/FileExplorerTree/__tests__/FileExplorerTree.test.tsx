// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FOLDER_HOVER_EXPAND_DELAY_MS } from '@constants/gfsBrowser'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { desktopQueryDefaults } from '@lib/queryClient'
import { activeWorkspaceTab, openFilesTab } from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
import {
  accessibleResource,
  childView,
  downloadResult,
  homeView,
  listAccessiblePage,
  listChildrenPage,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
// ── drag-and-drop (rev-2 D1) ─────────────────────────────────────────────────

import { GfsDragSessionProvider, useGfsDragSession } from '@/gfs/dragSession'
import { FileExplorerTree } from '..'

function SessionProbe({ onApi }: { onApi: (api: ReturnType<typeof useGfsDragSession>) => void }) {
  onApi(useGfsDragSession())
  return null
}

// useGfsBrowserController only reads { isAuthenticated, me, runtimeConfigState }
// from AuthContext. Mock just those so the tree's controller instance stands up
// without the full provider tree.
vi.mock('@contexts/AuthContext', () => ({
  useAuthContext: () => ({
    isAuthenticated: true,
    me: { id: 'user-1', teamId: 'team-1' },
    runtimeConfigState: { envKey: 'test' },
  }),
}))

// T1: every `window.clerum.gfs.*` value below is produced by the REAL main-process
// producer (`GfsClient` in desktop-app/src, run through its transport seam and the
// IPC structured-clone boundary), not hand-written against the renderer `.d.ts`.
// See ui/src/gfs/__fixtures__/gfsProducerFixtures.ts for why a typed hand-built
// mock proved nothing. `childView`/`accessibleResource`/`resolvedFile` are typed
// against the producer's own server-contract inputs and only ever flow THROUGH
// the producer; `listChildrenPage`/`listAccessiblePage`/`downloadResult` return
// what the renderer actually receives.
type Producers = {
  getHome?: () => Promise<Awaited<ReturnType<typeof homeView>>>
  listAccessible?: (drive?: string, cursor?: string) => Promise<unknown>
  listChildren?: (resourceId: string, drive?: string, cursor?: string) => Promise<unknown>
  download?: (uri: string) => Promise<unknown>
}

function installClerum(producers: Producers) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        getHome: producers.getHome ?? vi.fn(async () => homeView()),
        listAccessible: producers.listAccessible ?? vi.fn(async () => listAccessiblePage([])),
        listChildren: producers.listChildren ?? vi.fn(async () => listChildrenPage([])),
        download:
          producers.download ??
          vi.fn(async () => downloadResult(resolvedFile('fallback', 'fallback.bin'))),
      },
    },
  })
}

function renderTree(
  props: Partial<Parameters<typeof FileExplorerTree>[0]> = {},
  productionQueryDefaults = false
) {
  const onOpenFolder = props.onOpenFolder ?? vi.fn()
  const onOpenPreview = props.onOpenPreview ?? vi.fn()
  const pushToast = props.pushToast ?? vi.fn()
  const queryClient = new QueryClient(
    productionQueryDefaults
      ? { defaultOptions: desktopQueryDefaults }
      : { defaultOptions: { queries: { retry: false } } }
  )
  render(
    <QueryClientProvider client={queryClient}>
      <FileExplorerTree
        onOpenFolder={onOpenFolder}
        onOpenPreview={onOpenPreview}
        pushToast={pushToast}
      />
    </QueryClientProvider>
  )
  return { onOpenFolder, onOpenPreview, pushToast, queryClient }
}

beforeEach(() => {
  // jsdom has no object-URL implementation; the download fallback needs both.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:x'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('My home', () => {
  it('shows the server-provided non-main home as an expandable My home that opens on double-click', async () => {
    const listChildren = vi.fn(async () =>
      listChildrenPage([childView('child-1', 'Projects', 'directory', { drive: 'private' })])
    )
    installClerum({ getHome: async () => homeView({ drive: 'private' }), listChildren })
    const { onOpenFolder } = renderTree()
    // Until the home loads, My home is the disabled flat entry; once ready it
    // is a collapsed folder row.
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'My home' }).getAttribute('aria-expanded')).toBe(
        'false'
      )
    )
    const home = screen.getByRole('treeitem', { name: 'My home' })
    fireEvent.click(within(home).getByRole('button', { name: 'Expand My home' }))
    expect(await within(home).findByRole('treeitem', { name: 'Projects' })).toBeTruthy()
    expect(listChildren).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'private',
      undefined
    )
    fireEvent.doubleClick(within(home).getAllByRole('button', { name: 'My home' })[0]!)
    expect(onOpenFolder).toHaveBeenCalledWith('gfs://private/aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa')
    fireEvent.click(screen.getByRole('treeitem', { name: 'Shared with me' }))
    expect(onOpenFolder).toHaveBeenCalledWith(null)
  })

  it('lists the caller home only as My home, never under Shared with me', async () => {
    installClerum({
      getHome: async () => homeView(),
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'fixture', 'directory'),
          accessibleResource('team-1', 'Team folder', 'directory'),
          accessibleResource('other-home', 'someone-else', 'directory'),
        ])
      ),
    })
    renderTree()
    const shared = await screen.findByRole('tree', { name: 'Shared files' })
    // Witnesses: what others share stays listed, including another user's home.
    expect(await within(shared).findByRole('treeitem', { name: 'Team folder' })).toBeTruthy()
    expect(within(shared).getByRole('treeitem', { name: 'someone-else' })).toBeTruthy()
    expect(within(shared).queryByRole('treeitem', { name: 'fixture' })).toBeNull()
    expect(within(shared).queryByRole('treeitem', { name: 'My home' })).toBeNull()
    const destinations = screen.getByRole('tree', { name: 'File destinations' })
    expect(within(destinations).getByRole('treeitem', { name: 'My home' })).toBeTruthy()
  })

  it('shows pending and refetches until ready', async () => {
    vi.useFakeTimers()
    const getHome = vi
      .fn()
      .mockImplementationOnce(() =>
        homeView({
          state: 'pending',
          drive: null,
          path: null,
          resourceId: null,
          heldPermissions: [],
        })
      )
      .mockImplementation(() => homeView())
    installClerum({ getHome })
    renderTree()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('Your home folder is being prepared')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: 'My home' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_010)
    })
    expect(getHome).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Your home folder is being prepared')).toBeNull()
    expect(screen.getByRole('treeitem', { name: 'My home' }).hasAttribute('disabled')).toBe(false)
  })

  it('shows conflict and unavailable honestly, while retired hides only My home', async () => {
    installClerum({ getHome: async () => homeView({ state: 'conflict', resourceId: null }) })
    const first = renderTree()
    expect(
      await screen.findByText('Your home folder needs attention from an administrator')
    ).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: 'Shared with me' })).toBeTruthy()
    cleanup()
    const listAccessible = vi.fn(async () =>
      listAccessiblePage([accessibleResource('shared', 'Shared project', 'directory')])
    )
    installClerum({
      getHome: async () => {
        throw new Error('home service unavailable')
      },
      listAccessible,
    })
    renderTree()
    expect(await screen.findAllByText('home service unavailable')).not.toHaveLength(0)
    expect(await screen.findByRole('button', { name: 'Shared project' })).toBeTruthy()
    expect(listAccessible).toHaveBeenCalledWith(undefined, undefined)
    cleanup()
    installClerum({ getHome: async () => homeView({ state: 'retired' }) })
    renderTree()
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'My home' })).toBeNull())
    expect(screen.getByRole('treeitem', { name: 'Shared with me' })).toBeTruthy()
    expect(first.onOpenFolder).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — lazy fetch and expand/collapse', () => {
  it('keeps the sidebar empty node during a cached-empty root refetch', async () => {
    const emptyPage = await listAccessiblePage([])
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => refetchPage)
    installClerum({ listAccessible })

    const { queryClient } = renderTree({}, true)
    const emptyState = await screen.findByText('No shared files yet.')
    const accessibleKey = desktopQueryKeys.gfsAccessible('test:user-1:team-1', 'main')

    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: accessibleKey })
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(accessibleKey)?.fetchStatus).toBe('fetching')
    })

    expect(emptyState.isConnected).toBe(true)
    expect(screen.getByText('No shared files yet.')).toBe(emptyState)
    expect(screen.queryByRole('status', { name: 'Loading files…' })).toBeNull()

    await act(async () => resolveRefetch(emptyPage))
    expect(emptyState.isConnected).toBe(true)
  })

  it('does not fetch a folder before it is expanded, then loads and hides its children', async () => {
    const listChildren = vi.fn(async () =>
      listChildrenPage([childView('sub-1', 'Sub', 'directory'), childView('r-1', 'r.md', 'file')])
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    renderTree()

    await screen.findByRole('button', { name: 'Reports' })
    // Lazy: the root list rendered without any per-node children fetch.
    expect(listChildren).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Reports' }))

    expect(await screen.findByRole('button', { name: 'Sub' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'r.md' })).toBeTruthy()
    expect(listChildren).toHaveBeenCalledWith('reports', 'main', undefined)

    // Collapsing hides the children again (a container is collapsible at any level).
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Reports' }))
    expect(screen.queryByRole('button', { name: 'Sub' })).toBeNull()
  })
})

describe('FileExplorerTree — sort ordering', () => {
  it('renders folders before files, each group alphabetical', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('f-b', 'b.txt', 'file'),
          accessibleResource('d-z', 'Zeta', 'directory'),
          accessibleResource('d-a', 'Alpha', 'directory'),
          accessibleResource('f-a', 'a.txt', 'file'),
        ])
      ),
    })

    renderTree()

    const tree = await screen.findByRole('tree', { name: 'Shared files' })
    const names = within(tree)
      .getAllByRole('treeitem')
      .map(item => item.querySelector('.da-file-explorer__name')?.textContent)
    expect(names).toEqual(['Alpha', 'Zeta', 'a.txt', 'b.txt'])
  })
})

describe('FileExplorerTree — sanitizes externally-controlled GFS names in chrome', () => {
  it('cleans bidi/zero-width code points from the folder label and its toggle accessible name', async () => {
    installClerum({
      // A GFS folder name carrying a bidi override + zero-width — attacker input.
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('evil', `Re‮ports​`, 'directory')])
      ),
    })

    renderTree()

    // The visible label and the toggle's accessible name both show the sanitized
    // string; the raw bidi/zero-width variant never reaches the accessible tree.
    expect(await screen.findByRole('button', { name: 'Reports' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand Reports' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: `Re‮ports​` })).toBeNull()
  })

  it('shows the cleaned name in the download toast while the raw name stays for the on-disk file', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('z', `arch‮ive.zip`, 'file')])
      ),
      download: vi.fn(async () => downloadResult(resolvedFile('z', `arch‮ive.zip`))),
    })

    const { pushToast } = renderTree()

    fireEvent.click(await screen.findByRole('button', { name: 'archive.zip' }))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Downloaded archive.zip', 'success'))
  })
})

describe('FileExplorerTree — folder double-click cancels the deferred toggle', () => {
  // The real browser fires click → click → dblclick; a single fireEvent.doubleClick
  // dispatches only dblclick, so it never exercises the setTimeout cancellation.
  // A folder's single-click toggle is deferred; this drives the full sequence and
  // advances the 250ms window to prove the double-click cancels that toggle.
  it('folder: the double-click opens the tab once and never runs the deferred toggle', async () => {
    const listChildren = vi.fn(async () =>
      listChildrenPage([childView('sub-1', 'Sub', 'directory')])
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    const { onOpenFolder } = renderTree()

    const folderButton = await screen.findByRole('button', { name: 'Reports' })
    const treeitem = folderButton.closest('[role="treeitem"]') as HTMLElement

    vi.useFakeTimers()
    try {
      fireEvent.click(folderButton)
      fireEvent.click(folderButton)
      fireEvent.doubleClick(folderButton)
      act(() => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(onOpenFolder).toHaveBeenCalledWith('gfs://main/reports')
    // The deferred single-click (toggle) was cancelled: the folder did not
    // expand and its children were never fetched by the toggle.
    expect(treeitem.getAttribute('aria-expanded')).toBe('false')
    expect(listChildren).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — rapid double-click on a file', () => {
  it('file: every click of a previewable file routes to preview with the same resource, never a download', async () => {
    const onOpenPreview = vi.fn()
    const download = vi.fn(async () => downloadResult(resolvedFile('img-1', 'photo.png')))
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('img-1', 'photo.png', 'file')])
      ),
      download,
    })

    renderTree({ onOpenPreview })

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })

    // Files have no single/double-click deferral, so a real double-click
    // (click → click → dblclick) activates more than once. Preview has no
    // component-level in-flight guard — production idempotency comes from the host
    // deduping preview tabs by gfsUri (covered in workspaceTabs.test.ts), so this
    // asserts the component contract, not that host layer: under the rapid gesture
    // the preview branch always stays ahead of the download guard, so every
    // activation targets the same previewable resource and none falls through to a
    // download. A regression that reordered the guard would fail here.
    fireEvent.click(fileButton)
    fireEvent.click(fileButton)
    fireEvent.doubleClick(fileButton)

    await waitFor(() => expect(onOpenPreview).toHaveBeenCalled())
    for (const [preview] of onOpenPreview.mock.calls) {
      expect(preview).toEqual(
        expect.objectContaining({ kind: 'image', gfsUri: 'gfs://main/img-1', name: 'photo.png' })
      )
    }
    expect(download).not.toHaveBeenCalled()
  })

  it('file: a double-click on a non-previewable file downloads and toasts exactly once', async () => {
    const download = vi.fn(async () => downloadResult(resolvedFile('zip-1', 'archive.zip')))
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('zip-1', 'archive.zip', 'file')])
      ),
      download,
    })

    const { onOpenPreview, pushToast } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'archive.zip' })

    // The real double-click sequence: two clicks then the dblclick, driven
    // synchronously so the in-flight download is still running when the later
    // events arrive. The download has no host-level dedupe (unlike preview), so
    // without the in-flight guard this saves the file and toasts three times.
    fireEvent.click(fileButton)
    fireEvent.click(fileButton)
    fireEvent.doubleClick(fileButton)

    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Downloaded archive.zip', 'success'))
    expect(download).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(onOpenPreview).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — Enter activates', () => {
  it('folder: Enter opens the files tab and does not expand', async () => {
    const listChildren = vi.fn(async () => listChildrenPage([]))
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    const { onOpenFolder } = renderTree()

    const folderButton = await screen.findByRole('button', { name: 'Reports' })
    const treeitem = folderButton.closest('[role="treeitem"]') as HTMLElement

    fireEvent.keyDown(folderButton, { key: 'Enter' })

    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(onOpenFolder).toHaveBeenCalledWith('gfs://main/reports')
    expect(treeitem.getAttribute('aria-expanded')).toBe('false')
    expect(listChildren).not.toHaveBeenCalled()
  })

  it('file: Enter opens the preview tab', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('img-1', 'photo.png', 'file')])
      ),
    })

    const { onOpenPreview } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })
    fireEvent.keyDown(fileButton, { key: 'Enter' })

    expect(onOpenPreview).toHaveBeenCalledTimes(1)
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', gfsUri: 'gfs://main/img-1', name: 'photo.png' })
    )
  })
})

describe('FileExplorerTree — file single-click activates', () => {
  it('opens the preview tab and selects a previewable file on single-click', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('img-1', 'photo.png', 'file')])
      ),
    })

    const { onOpenPreview } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })
    const treeitem = fileButton.closest('[role="treeitem"]') as HTMLElement
    expect(treeitem.getAttribute('aria-selected')).toBe('false')

    // A single-click activates a file immediately — no 250ms deferral.
    fireEvent.click(fileButton)

    expect(onOpenPreview).toHaveBeenCalledTimes(1)
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', gfsUri: 'gfs://main/img-1', name: 'photo.png' })
    )
    // Activating a file also selects it, so selection still follows a single-click.
    await waitFor(() => expect(treeitem.getAttribute('aria-selected')).toBe('true'))
  })

  it('downloads a non-previewable file on single-click and toasts success', async () => {
    const download = vi.fn(async () => downloadResult(resolvedFile('zip-1', 'archive.zip')))
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('zip-1', 'archive.zip', 'file')])
      ),
      download,
    })

    const { onOpenPreview, pushToast } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'archive.zip' })
    fireEvent.click(fileButton)

    await waitFor(() => expect(download).toHaveBeenCalledWith('gfs://main/zip-1'))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Downloaded archive.zip', 'success'))
    expect(onOpenPreview).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — folder single-click toggles, not navigates', () => {
  it('expands a folder on single-click of its label and never opens a files tab', async () => {
    const listChildren = vi.fn(async () =>
      listChildrenPage([childView('sub-1', 'Sub', 'directory')])
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    const { onOpenFolder } = renderTree()

    const folderButton = await screen.findByRole('button', { name: 'Reports' })
    const treeitem = folderButton.closest('[role="treeitem"]') as HTMLElement

    // The folder toggle is deferred; nothing happens until the 250ms window
    // elapses without a double-click cancelling it.
    vi.useFakeTimers()
    try {
      fireEvent.click(folderButton)
      act(() => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // The single-click toggled the folder open and fetched its children — it did
    // NOT open the folder's files tab (that stays a double-click / Enter gesture).
    await waitFor(() => expect(treeitem.getAttribute('aria-expanded')).toBe('true'))
    await waitFor(() => expect(listChildren).toHaveBeenCalledWith('reports', 'main', undefined))
    expect(onOpenFolder).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — folder activation focuses an existing files tab', () => {
  // Drives the real `openFilesTab` reducer (the tab store producer) so the
  // observable outcome — tab count and which tab is active — is asserted (T4),
  // not an intermediate call. Opening a folder that already has a files tab
  // must focus it; a folder with no tab must create one.
  function Harness({ initialState }: { initialState: WorkspaceTabsState }) {
    const [state, setState] = useState(initialState)
    const counter = useRef(0)
    return (
      <>
        <div data-testid="tab-count">{state.tabs.length}</div>
        <div data-testid="active-path">{activeWorkspaceTab(state)?.files?.path ?? 'none'}</div>
        <FileExplorerTree
          onOpenFolder={uri =>
            setState(current =>
              openFilesTab(current, { id: `files-new-${(counter.current += 1)}`, path: uri })
            )
          }
          onOpenPreview={vi.fn()}
          pushToast={vi.fn()}
        />
      </>
    )
  }

  it('focuses the existing tab instead of creating another, and creates one when none exists', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('reports', 'Reports', 'directory'),
          accessibleResource('archive', 'Archive', 'directory'),
        ])
      ),
    })

    const initialState: WorkspaceTabsState = {
      tabs: [
        { id: 'chat-1', kind: 'chat', title: 'New chat', chat: { agentRef: null, chatId: null } },
        { id: 'files-1', kind: 'files', title: 'Reports', files: { path: 'gfs://main/reports' } },
      ],
      activeTabId: 'chat-1',
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <Harness initialState={initialState} />
      </QueryClientProvider>
    )

    const tree = await screen.findByRole('tree', { name: 'Shared files' })

    // Double-clicking the folder that already has a files tab focuses it: no new
    // tab, and that tab becomes active.
    fireEvent.doubleClick(within(tree).getByRole('button', { name: 'Reports' }))
    await waitFor(() =>
      expect(screen.getByTestId('active-path').textContent).toBe('gfs://main/reports')
    )
    expect(screen.getByTestId('tab-count').textContent).toBe('2')

    // A folder with no existing tab creates one.
    fireEvent.doubleClick(within(tree).getByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(screen.getByTestId('active-path').textContent).toBe('gfs://main/archive')
    )
    expect(screen.getByTestId('tab-count').textContent).toBe('3')
  })
})

describe('FileExplorerTree — expanded folder revalidates its listing (R1-H5)', () => {
  // The sidebar is a persistent surface. Folder contents change out-of-band
  // (agents, other sessions, operator writes never pass through this client), so
  // an expanded folder must revalidate on window focus — not serve its first
  // page forever under the app's Infinity staleTime.
  //
  // This test runs under the REAL desktop cache policy (`desktopQueryDefaults`:
  // Infinity staleTime, refetch flags off by default). The loose harness client
  // the other tests use inherits TanStack's default refetchOnWindowFocus:true,
  // which would refetch anyway and hide the bug — so it must NOT be used here.
  it('re-fetches an expanded folder on window focus and renders the new children', async () => {
    // The producer returns a DIFFERENT children page on the second fetch: the
    // out-of-band change the sidebar must surface without a hard reload.
    let call = 0
    const listChildren = vi.fn(async () => {
      call += 1
      return call === 1
        ? listChildrenPage([childView('old-1', 'old.md', 'file')])
        : listChildrenPage([childView('new-1', 'new.md', 'file')])
    })
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <QueryClientProvider client={queryClient}>
        <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
    expect(await screen.findByRole('button', { name: 'old.md' })).toBeTruthy()

    // Return focus to the window (force a false→true transition so the focus
    // listener fires). Under Infinity staleTime, only refetchOnWindowFocus:
    // 'always' triggers a refetch of the still-fresh listing.
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })

    try {
      // Observable output (T4): the tree renders the NEW child and drops the stale
      // one — not a refetch spy count.
      expect(await screen.findByRole('button', { name: 'new.md' })).toBeTruthy()
      await waitFor(() => expect(screen.queryByRole('button', { name: 'old.md' })).toBeNull())
    } finally {
      // Restore event-driven focus detection so this global state does not leak.
      focusManager.setFocused(undefined)
    }
  })

  it('purges cached children when an expanded folder is authoritatively denied', async () => {
    let call = 0
    const listChildren = vi.fn(async () => {
      call += 1
      if (call === 1) return listChildrenPage([childView('private-1', 'private.md', 'file')])
      throw new Error('403 Forbidden: httpStatus=403')
    })
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
      ),
      listChildren,
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <QueryClientProvider client={queryClient}>
        <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
      </QueryClientProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Reports' }))
    expect(await screen.findByRole('button', { name: 'private.md' })).toBeTruthy()

    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })

    try {
      await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'private.md' })).toBeNull())
    } finally {
      focusManager.setFocused(undefined)
    }
  })
})

describe('FileExplorerTree — unreadable rows refuse activation (R1-H1)', () => {
  // A `readable: false` child (a folder grant without inheritance; a file whose
  // parent does not inherit) is listed but cannot be opened. The tree must
  // refuse to open its preview / download / files tab and mark it, the same way
  // FilesPage.openResource already does — not fire an activation that 403s.
  // `readable` is carried by the REAL producer (GfsChildView.readable) through
  // GfsClient + the IPC clone, so the fixture emits it via childView overrides.
  async function renderExpandedVault(props: Partial<Parameters<typeof FileExplorerTree>[0]> = {}) {
    const listChildren = vi.fn(async () =>
      listChildrenPage([
        childView('locked', 'Locked', 'directory', { readable: false }),
        childView('secret', 'secret.pdf', 'file', { readable: false }),
      ])
    )
    const download = vi.fn(async () => downloadResult(resolvedFile('secret', 'secret.pdf')))
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('vault', 'Vault', 'directory')])
      ),
      listChildren,
      download,
    })
    const handles = renderTree(props)
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Vault' }))
    // Wait for the unreadable children to render (marked "No access"). The label
    // button's accessible name carries the file name plus the "No access" badge.
    await screen.findByRole('button', { name: /secret\.pdf.*No access/ })
    return { ...handles, download }
  }

  it('file: single-click and Enter on an unreadable file toast and never preview or download', async () => {
    const { onOpenPreview, pushToast, download } = await renderExpandedVault()

    const fileButton = screen.getByRole('button', { name: /secret\.pdf.*No access/ })

    fireEvent.click(fileButton)
    fireEvent.keyDown(fileButton, { key: 'Enter' })

    // The observable outcome: no preview descriptor, no download — only the
    // access toast, once per activation attempt.
    expect(onOpenPreview).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('You do not have read access to secret.pdf', 'error')
    expect(pushToast).toHaveBeenCalledTimes(2)
    // The row is marked non-actionable.
    expect(within(fileButton).getByText('No access')).toBeTruthy()
  })

  it('folder: double-click and Enter on an unreadable folder toast and never open a files tab', async () => {
    const { onOpenFolder, pushToast } = await renderExpandedVault()

    const folderButton = screen.getByRole('button', { name: /^Locked.*No access/ })

    fireEvent.doubleClick(folderButton)
    fireEvent.keyDown(folderButton, { key: 'Enter' })

    // The observable outcome: no files tab opened — only the access toast.
    expect(onOpenFolder).not.toHaveBeenCalled()
    expect(pushToast).toHaveBeenCalledWith('You do not have read access to Locked', 'error')
    expect(pushToast).toHaveBeenCalledTimes(2)
    expect(within(folderButton).getByText('No access')).toBeTruthy()
  })
})

describe('FileExplorerTree — shared revoked access across controller mounts (R1-H2)', () => {
  // The sidebar tree, FilesPage and FilePreviewPage each mount their OWN
  // `useGfsBrowserController`. A session-authority 401 in any one of them must
  // revoke ALL of them, and a retry in one must re-activate all — otherwise a
  // 401 in the tree leaves FilesPage live against caches the session can no
  // longer authorize, and FilesPage's Retry never re-enables the still-mounted
  // tree. The revoked flag is shared through the query cache, so every mount on
  // the SAME queryClient observes it. This second mount is an independent
  // controller consumer, not the tree's own instance.
  function AccessStateProbe() {
    const ctrl = useGfsBrowserController()
    return <div data-testid="probe-access">{ctrl.accessState}</div>
  }

  it('revokes a second mount from a tree 401 and re-activates both on retry (not the empty state)', async () => {
    // Discovery succeeds; the 401 comes from the tree's own listChildren — an
    // operation-surface authority failure that ONLY the tree's controller
    // observes. Under per-mount state the probe would never see it.
    const listAccessible = vi.fn(async () =>
      listAccessiblePage([accessibleResource('reports', 'Reports', 'directory')])
    )
    let childrenCall = 0
    const listChildren = vi.fn(async () => {
      childrenCall += 1
      if (childrenCall === 1) throw new Error('401 Unauthorized')
      return listChildrenPage([childView('r-1', 'r.md', 'file')])
    })
    installClerum({ listAccessible, listChildren })

    // ONE queryClient shared by both mounts is the sharing boundary. Run it
    // under the REAL desktop cache policy so nothing but the shared flag carries
    // the revoke across mounts.
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(
      <QueryClientProvider client={queryClient}>
        <FileExplorerTree onOpenFolder={vi.fn()} onOpenPreview={vi.fn()} pushToast={vi.fn()} />
        <AccessStateProbe />
      </QueryClientProvider>
    )

    await screen.findByRole('button', { name: 'Reports' })
    expect(screen.getByTestId('probe-access').textContent).toBe('active')

    // Expand the folder → the tree's listChildren 401s → the tree revokes.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Reports' }))

    // (a) The tree shows the unauthorized + retry surface — NOT "No shared files
    // yet." (b) The independent second mount reads revoked (shared flag).
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    expect(screen.queryByText('No shared files yet.')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('probe-access').textContent).toBe('revoked'))

    // (c) Retry from the tree re-activates BOTH mounts and re-enables the
    // queries, so discovery reloads and the tree renders its root again.
    fireEvent.click(screen.getByRole('button', { name: 'Retry file access' }))
    await waitFor(() => expect(screen.getByTestId('probe-access').textContent).toBe('active'))
    expect(await screen.findByRole('button', { name: 'Reports' })).toBeTruthy()
  })
})

describe('FileExplorerTree — download-path authority wiring (R1-H8)', () => {
  // The review flagged that the tree's fail-closed authority wiring was never
  // exercised: a mutant that dropped it would ship green. The listChildren-401
  // path is now covered by the R1-H2 test above; this covers the OTHER live
  // mutant — the download catch in `handleActivateFile` that routes an operation
  // 401 through `handleAuthorityFailure`. Delete that `if (authorityFailure(...))
  // return` and this test goes red (the raw error toasts and the tree never
  // reaches the revoked surface). A 403 here would be a per-resource denial
  // (operation surface does not treat it as session authority) — this asserts a
  // session 401, which must revoke.
  it('revokes the session when activating a non-previewable file 401s on download', async () => {
    const download = vi.fn(async () => {
      throw new Error('401 Unauthorized')
    })
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('zip-1', 'archive.zip', 'file')])
      ),
      download,
    })

    const { onOpenPreview, pushToast } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'archive.zip' })
    fireEvent.click(fileButton)

    // The download 401 is classified as session authority on the operation
    // surface, so the tree revokes and swaps in the unauthorized + retry surface
    // instead of surfacing the raw error as a toast.
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    await waitFor(() => expect(download).toHaveBeenCalledWith('gfs://main/zip-1'))
    expect(onOpenPreview).not.toHaveBeenCalled()
    // The authority path pre-empts the error toast (the catch returns before it).
    expect(pushToast).not.toHaveBeenCalledWith('401 Unauthorized', 'error')
  })
})

type DndProducers = Producers & {
  affordances?: (resourceId: string, drive?: string) => Promise<unknown>
  resolve?: (uri: string) => Promise<unknown>
  moveResource?: (
    resourceId: string,
    destinationId: string,
    drive?: string,
    ifMatch?: number,
    newName?: string
  ) => Promise<unknown>
}

function installDndClerum(producers: DndProducers) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        getHome: producers.getHome ?? vi.fn(async () => homeView()),
        listAccessible: producers.listAccessible ?? vi.fn(async () => listAccessiblePage([])),
        listChildren: producers.listChildren ?? vi.fn(async () => listChildrenPage([])),
        download:
          producers.download ??
          vi.fn(async () => downloadResult(resolvedFile('fallback', 'fallback.bin'))),
        affordances: producers.affordances ?? vi.fn(async () => ({ held: ['read'] })),
        resolve:
          producers.resolve ??
          vi.fn(async () => {
            throw new Error('resolve not stubbed')
          }),
        moveResource:
          producers.moveResource ?? vi.fn(async () => ({ resourceId: 'x', version: 2 })),
      },
    },
  })
}

function dragTypes() {
  return {
    types: ['application/x-evenfire-gfs-resource'],
    files: [],
    effectAllowed: 'move',
    dropEffect: 'none',
    setData: vi.fn(),
  }
}

function renderTreeWithSession(props: Partial<Parameters<typeof FileExplorerTree>[0]> = {}) {
  const onOpenFolder = props.onOpenFolder ?? vi.fn()
  const onOpenPreview = props.onOpenPreview ?? vi.fn()
  const pushToast = props.pushToast ?? vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <GfsDragSessionProvider>
        <FileExplorerTree
          onOpenFolder={onOpenFolder}
          onOpenPreview={onOpenPreview}
          pushToast={pushToast}
        />
      </GfsDragSessionProvider>
    </QueryClientProvider>
  )
  return { onOpenFolder, onOpenPreview, pushToast }
}

describe('FileExplorerTree — drag-and-drop moves', () => {
  it('still opens the confirmation when adjudication resolves after the gesture’s dragend', async () => {
    // Regression: the browser fires dragend ~immediately after drop.
    // clearDragState used to bump the gesture epoch on that dragend, so the
    // drop's own decision — resuming after its async affordances probes — saw
    // a stale epoch and returned silently: no confirmation, no move, no toast.
    // Cache-cold drops (the common case for fresh folders) lost every time.
    const moveResource = vi.fn(async () => ({ resourceId: 'foldera', version: 9 }))
    const delayed = <T,>(value: T) =>
      new Promise<T>(resolve => setTimeout(() => resolve(value), 25))
    const affordances = vi.fn((resourceId: string) =>
      delayed(
        resourceId === 'folderb'
          ? { held: ['read', 'write'] }
          : { held: ['read', 'write', 'delete'] }
      )
    )
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name = id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand'
      const resourceId = id === 'grand' ? 'grand' : id
      return {
        drive: 'main',
        resourceId,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()
    const aRow = rowA.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })
    // The browser ends the gesture right after the drop — before the delayed
    // probes resolve. This used to invalidate the drop's own decision.
    fireEvent.dragEnd(aRow, { dataTransfer })

    await screen.findByRole('dialog', { name: 'Move folder A to B' })
  })

  it('seeds the numbered-name ladder from the destination’s cached children (RP-003)', async () => {
    // B is expanded and its children — A, A (1), A (2) — are in the shared
    // children cache. The blind ladder burned all three attempts on taken
    // names and ended on "The destination changed". Seeded from the cache,
    // the first 409 jumps straight to A (3), and the confirmation suggests
    // that same name.
    const moveResource = vi.fn(
      async (
        _resourceId: string,
        _destinationId: string,
        _drive?: string,
        _ifMatch?: number,
        newName?: string
      ) => {
        if (
          newName === undefined ||
          newName === 'A' ||
          newName === 'A (1)' ||
          newName === 'A (2)'
        ) {
          throw new Error('409 Conflict: a resource with this name already exists httpStatus=409')
        }
        return { resourceId: 'foldera', version: 9 }
      }
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name = id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand'
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      listChildren: vi.fn(async (resourceId: string) => {
        if (resourceId === 'folderb') {
          return listChildrenPage([
            childView('a-dup', 'A', 'directory'),
            childView('a-1', 'A (1)', 'directory'),
            childView('a-2', 'A (2)', 'directory'),
          ])
        }
        return listChildrenPage([])
      }),
      affordances,
      resolve,
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    // Expand B so its children load into the shared children cache — the
    // production path that makes the destination's names known.
    fireEvent.click(screen.getByRole('button', { name: 'Expand B' }))
    await screen.findByRole('button', { name: 'A (1)' })

    const dataTransfer = dragTypes()
    const aRow = rowA.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })
    fireEvent.dragEnd(aRow, { dataTransfer })

    const dialog = await screen.findByRole('dialog', { name: 'Move folder A to B' })
    // The suggestion comes from the cached destination names.
    expect(within(dialog).getByText(/A \(3\)/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(2))
    expect(moveResource).toHaveBeenNthCalledWith(2, 'foldera', 'folderb', 'main', 4, 'A (3)')
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Moved A to B as A (3)', 'success'))
  })

  it('a new gesture after a lost dragend commits the dragged folder, not the stale one', async () => {
    // R1-H2: the browser can lose dragend (e.g. the source row is replaced by
    // a listing refresh mid-drag and dragend fires on a detached node). The
    // stale source must not adjudicate the NEXT gesture's drop: the new
    // trusted gesture takes ownership of the session instead.
    const moveResource = vi.fn(async () => ({ resourceId: 'folderb', version: 9 }))
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderc') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name =
        id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : id === 'folderc' ? 'C' : 'Grand'
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
          accessibleResource('folderc', 'C', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const rowC = await screen.findByRole('button', { name: 'C' })
    const dataTransfer = dragTypes()
    const cRow = rowC.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    // Gesture A starts and its dragend is LOST (no dragEnd fired here).
    fireEvent.dragStart(rowA, { dataTransfer })
    // Gesture B supersedes the stale A and drops onto C.
    fireEvent.dragStart(rowB, { dataTransfer })
    fireEvent.drop(cRow, { dataTransfer })

    // The confirmation must describe B's move — not the stale A.
    await screen.findByRole('dialog', { name: 'Move folder B to C' })
    expect(screen.queryByRole('dialog', { name: 'Move folder A to C' })).toBeNull()
  })

  it('a stale drop’s cleanup does not clear a newer gesture in the tree', async () => {
    // R1-M4: gesture A’s drop adjudication is pending when gesture B starts on
    // the same surface. A’s late resolution must return without ending B: B’s
    // drop must still open the confirmation for B.
    const moveResource = vi.fn(async () => ({ resourceId: 'folderb', version: 9 }))
    type Affordances = { held: string[] }
    let releaseA!: (value: Affordances) => void
    const gatedA = new Promise<Affordances>(resolve => {
      releaseA = resolve
    })
    let aProbePending = true
    const affordances = vi.fn((): Promise<Affordances> => {
      if (aProbePending) {
        aProbePending = false
        return gatedA
      }
      return Promise.resolve({ held: ['read', 'write', 'delete'] })
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name =
        id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : id === 'folderc' ? 'C' : 'Grand'
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
          accessibleResource('folderc', 'C', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const rowC = await screen.findByRole('button', { name: 'C' })
    const dataTransfer = dragTypes()
    const cRow = rowC.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    // Gesture A: its drop adjudication parks on the gated affordances probe.
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.drop(cRow, { dataTransfer })

    // Gesture B starts before A’s adjudication resolves (supersedes A).
    fireEvent.dragStart(rowB, { dataTransfer })

    // A resolves late: wrong epoch — no dialog for A, no commit, no cleanup
    // of B.
    await act(async () => {
      releaseA({ held: ['read', 'write'] })
    })
    expect(screen.queryByRole('dialog', { name: 'Move folder A to C' })).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()

    // B’s drop is still operable and confirms B’s move.
    fireEvent.drop(cRow, { dataTransfer })
    await screen.findByRole('dialog', { name: 'Move folder B to C' })
  })

  it('a stale cross-surface drop cannot open a dialog or release the newer shared gesture', async () => {
    // R1-M4 cross-surface: A’s drop is pending in the tree when another
    // surface begins gesture B (here driven through the session api). A’s
    // surface epoch is unchanged; the shared generation must still reject A
    // and preserve the store now owned by B.
    const moveResource = vi.fn(async () => ({ resourceId: 'foldera', version: 9 }))
    type Affordances = { held: string[] }
    let releaseA!: (value: Affordances) => void
    const gatedA = new Promise<Affordances>(resolve => {
      releaseA = resolve
    })
    let aProbePending = true
    const affordances = vi.fn((): Promise<Affordances> => {
      if (aProbePending) {
        aProbePending = false
        return gatedA
      }
      return Promise.resolve({ held: ['read', 'write', 'delete'] })
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name = id === 'foldera' ? 'A' : id === 'folderc' ? 'C' : 'Grand'
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 1 }),
          accessibleResource('folderc', 'C', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    let sessionApi: ReturnType<typeof useGfsDragSession> | null = null
    const onOpenFolder = vi.fn()
    const onOpenPreview = vi.fn()
    const pushToast = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <FileExplorerTree
            onOpenFolder={onOpenFolder}
            onOpenPreview={onOpenPreview}
            pushToast={pushToast}
          />
          <SessionProbe onApi={api => (sessionApi = api)} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowC = await screen.findByRole('button', { name: 'C' })
    const dataTransfer = dragTypes()
    const cRow = rowC.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    // Gesture A (this surface): drop adjudication parks on the gated probe.
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.drop(cRow, { dataTransfer })

    // The OTHER surface begins gesture B: the shared store superscedes, but
    // this surface’s epoch is untouched.
    expect(
      sessionApi!.beginDrag({
        resourceId: 'file-external',
        gfsUri: 'gfs://main/file-external',
        drive: 'main',
        kind: 'file',
        name: 'ext.txt',
        parentKnown: true,
        parentResourceId: 'grand',
        knownAncestorIds: ['grand'],
        origin: 'files',
        scope: 'test:user-1:team-1',
      })
    ).toBe(true)

    // A resolves late: the shared generation rejects its stale admission.
    await act(async () => {
      releaseA({ held: ['read', 'write'] })
    })
    expect(screen.queryByRole('dialog', { name: 'Move folder A to C' })).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()

    // A’s cleanup must not have ended the shared store’s newer gesture.
    expect(sessionApi!.activeSource()?.resourceId).toBe('file-external')
  })

  it('moves a dragged folder into an unrelated folder through the one confirmation', async () => {
    // Two directly-shared folders under one unshared common parent 'grand':
    // the drop must walk B's (bounded) ancestry, find the common anchor via
    // the root, and admit the move on exact bits.
    const moveResource = vi.fn(async () => ({ resourceId: 'foldera', version: 9 }))
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const parent = id === 'grand' ? null : 'grand'
      const name = id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand'
      const resourceId = id === 'grand' ? 'grand' : id
      return {
        drive: 'main',
        resourceId,
        parentResourceId: parent,
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowA, { dataTransfer })
    const bTreeItem = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.dragEnter(bTreeItem, { dataTransfer })

    // Root-level folder sources resolve ancestry on DROP (bounded), not on
    // hover; hover shows checking until cached bits decide structure-free
    // facts. Drop performs the priority check.
    fireEvent.dragOver(bTreeItem, { dataTransfer })
    fireEvent.drop(bTreeItem, { dataTransfer })

    const dialog = await screen.findByRole('dialog', { name: 'Move folder A to B' })
    expect(
      within(dialog).getByText(
        /Inherited access to this folder and its contents follows the new location/
      )
    ).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    })

    await waitFor(() => {
      expect(moveResource).toHaveBeenCalledWith('foldera', 'folderb', 'main', 4, undefined)
    })
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Moved A to B', 'success'))
    // Folder-impact info accompanies the success toast (rev-2 §1/§8).
    expect(pushToast).toHaveBeenCalledWith(
      'Moving a folder changes who can access its contents — access now follows the new location.',
      'info'
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a checking hover landable (dropEffect move) and only a deny refuses the drop', async () => {
    // Regression: mapping every non-'allowed' verdict to dropEffect 'none'
    // made Chromium CANCEL the drag at release — the drop event never fired,
    // so the drop-time priority check could not run and any hover whose
    // affordances had not resolved yet silently swallowed the gesture.
    const moveResource = vi.fn()
    const affordances = vi.fn(() => new Promise<{ held: string[] }>(() => {}))
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-a', 'A', 'directory'),
          accessibleResource('folder-b', 'B', 'directory'),
        ])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('child-c', 'C', 'directory', { parentResourceId: 'folder-a' })])
      ),
      affordances,
      moveResource,
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    // Authority unresolved (affordances never settle): the hover must stay
    // LANDABLE so the drop-time priority adjudication can decide.
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')

    // Expand A to reveal its child C; a drop into the source's own descendant
    // is structurally denied. The refusal must stay DELIVERABLE (dropEffect
    // 'move', UX matrix §5.3) so the release can present the reason — the
    // tone-keyed tint, not the cursor, carries the denial.
    await act(async () => {
      fireEvent.click(rowA)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'C' })).toBeTruthy()
    })
    const rowC = screen.getByRole('button', { name: 'C' })
    const cRow = rowC.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.dragOver(cRow, { dataTransfer })
    expect(cRow.getAttribute('data-drop-state')).toBe('denied')
    expect(cRow.getAttribute('data-drop-reason')).toBe('descendant')
    expect(dataTransfer.dropEffect).toBe('move')
  })

  it('refuses a same-parent drop before any request or confirmation', async () => {
    const moveResource = vi.fn()
    const affordances = vi.fn(async () => ({ held: ['read', 'write', 'delete'] }))
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('parent-1', 'P', 'directory')])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([
          childView('folder-a', 'A', 'directory', { parentResourceId: 'parent-1' }),
        ])
      ),
      affordances,
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    await screen.findByRole('button', { name: 'P' })
    // Expand P (single-click, deferred) to reveal A.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'P' }))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'A' })).toBeTruthy()
    })

    const rowA = screen.getByRole('button', { name: 'A' })
    const rowP = screen.getByRole('button', { name: 'P' })
    const dataTransfer = dragTypes()
    fireEvent.dragStart(rowA, { dataTransfer })
    const pRow = rowP.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.dragOver(pRow, { dataTransfer })
    expect(pRow.getAttribute('data-drop-state')).toBe('denied')
    expect(pRow.getAttribute('data-drop-reason')).toBe('same-parent')
    fireEvent.drop(pRow, { dataTransfer })

    // A4: the no-op is INFO ("already in"), never an error "cannot".
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('A is already in P.', 'info')
    })
    expect(moveResource).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refuses a drop into the source folder’s own loaded descendant', async () => {
    const moveResource = vi.fn()
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('folder-a', 'A', 'directory')])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('child-c', 'C', 'directory', { parentResourceId: 'folder-a' })])
      ),
      affordances: vi.fn(async () => ({ held: ['read', 'write', 'delete'] })),
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'A' }))
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'C' })).toBeTruthy()
    })

    const rowA = screen.getByRole('button', { name: 'A' })
    const rowC = screen.getByRole('button', { name: 'C' })
    const dataTransfer = dragTypes()
    fireEvent.dragStart(rowA, { dataTransfer })
    const cRow = rowC.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    fireEvent.dragOver(cRow, { dataTransfer })
    expect(cRow.getAttribute('data-drop-state')).toBe('denied')
    expect(cRow.getAttribute('data-drop-reason')).toBe('descendant')
    fireEvent.drop(cRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        'You can’t move A into a folder inside itself.',
        'error'
      )
    })
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('paints and explains a drop of an item onto itself (A1)', async () => {
    // Self-hover used to be skipped entirely, so dropping an item onto itself
    // looked dead: no verdict, no cursor story, no words. The verdict now
    // paints with its `self` reason and the release explains itself, while
    // admission still refuses the mutation.
    const moveResource = vi.fn()
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('folder-a', 'A', 'directory')])
      ),
      affordances: vi.fn(async () => ({ held: ['read', 'write', 'delete'] })),
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const aRow = rowA.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(aRow, { dataTransfer })
    expect(aRow.getAttribute('data-drop-state')).toBe('denied')
    expect(aRow.getAttribute('data-drop-reason')).toBe('self')
    // The denied hover stays deliverable so the refused drop can fire (§5.3).
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(aRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        'You dropped A onto itself. Pick a destination folder.',
        'error'
      )
    })
    expect(moveResource).not.toHaveBeenCalled()
    // The refused drop announces its full reason to the screen reader.
    expect(screen.getByText('You dropped A onto itself. Pick a destination folder.')).toBeTruthy()
  })

  it('updates the reason when a newer gesture denies the same row differently', async () => {
    // The stored verdict must not collapse to its state: gesture 1 denies a
    // row as same-parent; a lost dragend leaves that verdict painted, and
    // gesture 2 denies the SAME row as self. A state-only guard would skip
    // the repaint and leave the stale reason on the row.
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('folder-a', 'A', 'directory')])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('file-1', 'f.md', 'file', { parentResourceId: 'folder-a' })])
      ),
      affordances: vi.fn(async () => ({ held: ['read', 'write', 'delete'] })),
      moveResource: vi.fn(),
    })
    renderTreeWithSession()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'A' }))
    })
    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowF = await screen.findByRole('button', { name: 'f.md' })
    const aRow = rowA.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    // Gesture 1: the file already lives in A → same-parent.
    fireEvent.dragStart(rowF, { dataTransfer })
    fireEvent.dragOver(aRow, { dataTransfer })
    expect(aRow.getAttribute('data-drop-state')).toBe('denied')
    expect(aRow.getAttribute('data-drop-reason')).toBe('same-parent')
    expect(aRow.getAttribute('title')).toBe('f.md is already in A.')

    // The browser lost gesture 1's dragend (R1-H2); gesture 2 supersedes it
    // and denies the same row as self — the reason must repaint.
    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(aRow, { dataTransfer })
    expect(aRow.getAttribute('data-drop-state')).toBe('denied')
    expect(aRow.getAttribute('data-drop-reason')).toBe('self')
    expect(aRow.getAttribute('title')).toBe('You cannot move A into itself.')
  })

  it('refuses a drop whose source parent lacks write, naming the folder that contains it (A7)', async () => {
    const moveResource = vi.fn()
    const affordances = vi.fn(async (resourceId: string) => {
      // The physical source parent holds no write bit; everything else is full.
      if (resourceId === 'parent-1') return { held: ['read'] }
      return { held: ['read', 'write', 'delete'] }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('parent-1', 'P', 'directory')])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([
          childView('folder-a', 'A', 'directory', { parentResourceId: 'parent-1' }),
          childView('folder-b', 'B', 'directory', { parentResourceId: 'parent-1' }),
        ])
      ),
      affordances,
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'P' }))
    })
    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        'You can’t move A out of its current folder because you don’t have edit access to the folder that contains it.',
        'error'
      )
    })
    expect(moveResource).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('refuses a drop whose source parent lacks delete, naming the folder that contains it (A8)', async () => {
    const moveResource = vi.fn()
    const affordances = vi.fn(async (resourceId: string) => {
      // Write but no delete on the physical source parent.
      if (resourceId === 'parent-1') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('parent-1', 'P', 'directory')])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([
          childView('folder-a', 'A', 'directory', { parentResourceId: 'parent-1' }),
          childView('folder-b', 'B', 'directory', { parentResourceId: 'parent-1' }),
        ])
      ),
      affordances,
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'P' }))
    })
    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        'You can’t move A out of its current folder because you don’t have delete access to the folder that contains it.',
        'error'
      )
    })
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('refuses a move of an observed physical root with the top-level copy (A3)', async () => {
    const moveResource = vi.fn()
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('root-1', 'R', 'directory'),
          accessibleResource('folder-b', 'B', 'directory'),
        ])
      ),
      affordances: vi.fn(async () => ({ held: ['read', 'write', 'delete'] })),
      resolve: vi.fn(async () => ({ parentResourceId: null, kind: 'directory', version: 1 })),
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowR = await screen.findByRole('button', { name: 'R' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowR, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(
        'This location is the top level — it can’t be moved.',
        'error'
      )
    })
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('presents an unverifiable drop as a warning, never as a refusal (A10)', async () => {
    const moveResource = vi.fn()
    const affordances = vi.fn(async () => {
      throw new Error('500 Internal Server Error httpStatus=500')
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-a', 'A', 'directory'),
          accessibleResource('folder-b', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve: vi.fn(async () => ({ parentResourceId: 'grand', kind: 'directory', version: 1 })),
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith('500 Internal Server Error', 'warn')
    })
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('keeps a session-lost drop persistently visible after revocation invalidates the gesture (A11)', async () => {
    // The probe 401 both refuses the drop AND revokes the session; the
    // revocation invalidates the gesture's ownership before the drop
    // continuation resumes. The refused drop must still explain itself — as a
    // persistent banner, not a toast — and stay visible next to the revoked
    // surface.
    const moveResource = vi.fn()
    const affordances = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'gfs:affordances': Error: 401 Unauthorized httpStatus=401"
      )
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-a', 'A', 'directory'),
          accessibleResource('folder-b', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve: vi.fn(async () => ({ parentResourceId: 'grand', kind: 'directory', version: 1 })),
      moveResource,
    })
    const { pushToast } = renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
    const dataTransfer = dragTypes()

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })
    fireEvent.drop(bRow, { dataTransfer })

    // The sentence appears on BOTH refusal surfaces: the gated
    // callback-local banner AND the revoked tree surface, which owns it
    // unconditionally and outlives the dead gesture's ownership (A11).
    const sessionEnded = await screen.findAllByText(
      'Your session ended. Sign in again to continue moving files.'
    )
    expect(sessionEnded.length).toBeGreaterThanOrEqual(2)
    expect(
      sessionEnded.some(element => element.closest('.da-file-explorer__revoked') !== null)
    ).toBe(true)
    // The revoked surface stays visible alongside the refusal banner.
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    // A dead session is not a one-shot toast.
    expect(pushToast).not.toHaveBeenCalled()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('dragstart cancels the deferred folder toggle (no expansion after a drag)', async () => {
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('folder-a', 'A', 'directory')])
      ),
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const dataTransfer = dragTypes()
    fireEvent.click(rowA) // schedules the deferred toggle
    fireEvent.dragStart(rowA, { dataTransfer }) // drag cancels the timer
    fireEvent.dragEnd(rowA, { dataTransfer })
    // Within the 250ms window the folder would have expanded without the
    // cancellation; advance and assert it did not.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 320))
    })
    const treeItem = rowA.closest('[role="treeitem"]')!
    expect(treeItem.getAttribute('aria-expanded')).toBe('false')
  })

  it('gives the forest ROOT rows their drop state (RP-019)', async () => {
    // The forest roots are drop targets like any nested row. Before the fix
    // the root node never received its own `dropState`, so the verdict was
    // painted nowhere: the drag looked dead on the very rows the user aims at.
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: id === 'grand' ? null : 'grand',
        name: id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand',
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource: vi.fn(async () => ({ resourceId: 'foldera', version: 9 })),
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })

    // The root row carries the verdict, exactly like a nested row does.
    expect(bRow.getAttribute('data-drop-state')).toBe('checking')
  })

  it('announces the drop verdict to assistive technology (RP-026)', async () => {
    // The verdict is painted on the target row (a tint and a data attribute),
    // which a screen reader never announces. The live region states it.
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: id === 'grand' ? null : 'grand',
        name: id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand',
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource: vi.fn(async () => ({ resourceId: 'foldera', version: 9 })),
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragOver(bRow, { dataTransfer })

    // The verdict is spoken, not only painted — synchronously with the hover,
    // before any probe resolves.
    expect(screen.getByText(/Checking whether you can move into B/)).toBeTruthy()
  })

  it('cancels the hover-expand timer when the drop lands on the row (RP-024)', async () => {
    // The browser does not necessarily fire a dragleave after a drop, so the
    // row's own hover-expand timer survived the drop: the folder expanded
    // after the gesture ended, opening a folder the user never asked for.
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: id === 'grand' ? null : 'grand',
        name: id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand',
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource: vi.fn(async () => ({ resourceId: 'foldera', version: 9 })),
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()
    const bRow = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    // The hover-expand delay is the thing under test: fake the timers only
    // once the rows exist, so the queries above keep their real clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.dragStart(rowA, { dataTransfer })
      // The dwell over the collapsed folder schedules its hover-expand.
      fireEvent.dragOver(bRow, { dataTransfer })
      // The drop ends the gesture.
      fireEvent.drop(bRow, { dataTransfer })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(FOLDER_HOVER_EXPAND_DELAY_MS + 50)
      })

      // B is still collapsed: the user never asked to open it.
      expect(screen.getByRole('button', { name: 'Expand B' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Collapse B' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Shift+F10 opens the existing Move dialog from the tree row', async () => {
    installDndClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([accessibleResource('folder-a', 'A', 'directory')])
      ),
    })
    renderTreeWithSession()

    // The rejected per-row Move affordance stays gone: no row button renders.
    await screen.findByRole('button', { name: 'A' })
    expect(screen.queryByRole('button', { name: 'Move A to another folder' })).toBeNull()

    await act(async () => {
      fireEvent.keyDown(await screen.findByRole('button', { name: 'A' }), {
        key: 'F10',
        shiftKey: true,
      })
    })
    expect(await screen.findByRole('dialog', { name: 'Move folder A' })).toBeTruthy()
  })

  it('drops a folder onto another folder while the home is pending', async () => {
    // The tree's roots carry their own drive; a pending home means the open
    // location has none, and the drop must still be admitted on the rows'.
    const moveResource = vi.fn(async () => ({ resourceId: 'foldera', version: 9 }))
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folderb') return { held: ['read', 'write'] }
      return { held: ['read', 'write', 'delete'] }
    })
    const resolve = vi.fn(async (uri: string) => {
      const id = uri.split('/').pop()
      const name = id === 'foldera' ? 'A' : id === 'folderb' ? 'B' : 'Grand'
      return {
        drive: 'main',
        resourceId: id === 'grand' ? 'grand' : id,
        parentResourceId: id === 'grand' ? null : 'grand',
        name,
        kind: 'directory',
        version: id === 'foldera' ? 4 : 1,
      }
    })
    installDndClerum({
      getHome: async () =>
        homeView({ state: 'pending', drive: null, path: null, resourceId: null }),
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('foldera', 'A', 'directory', { version: 4 }),
          accessibleResource('folderb', 'B', 'directory'),
        ])
      ),
      affordances,
      resolve,
      moveResource,
    })
    renderTreeWithSession()

    const rowA = await screen.findByRole('button', { name: 'A' })
    const rowB = await screen.findByRole('button', { name: 'B' })
    const dataTransfer = dragTypes()
    const bTreeItem = rowB.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!

    fireEvent.dragStart(rowA, { dataTransfer })
    fireEvent.dragEnter(bTreeItem, { dataTransfer })
    fireEvent.dragOver(bTreeItem, { dataTransfer })
    fireEvent.drop(bTreeItem, { dataTransfer })

    const dialog = await screen.findByRole('dialog', { name: 'Move folder A to B' })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    })

    await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(1))
    expect(moveResource).toHaveBeenCalledWith('foldera', 'folderb', 'main', 4, undefined)
  })

  it('never offers the governed home root as a drag source or a Move', async () => {
    const home = await homeView({ resourceId: 'home-1', path: '/Users/me' })
    installDndClerum({
      getHome: async () => home,
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('home-1', 'Home root', 'directory'),
          accessibleResource('sibling-1', 'Team folder', 'directory'),
        ])
      ),
    })
    renderTreeWithSession()

    const homeRow = await screen.findByRole('button', { name: 'My home' })
    expect(homeRow.getAttribute('draggable')).toBe('false')
    expect(homeRow.getAttribute('title')).toBeNull()

    // Witness: a sibling row with the same owner bits is still a drag source.
    const siblingRow = screen.getByRole('button', { name: 'Team folder' })
    expect(siblingRow.getAttribute('draggable')).toBe('true')

    // The keyboard Move path follows the same gate: the sibling opens the
    // dialog, the governed root does not.
    await act(async () => {
      fireEvent.keyDown(homeRow, { key: 'F10', shiftKey: true })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => {
      fireEvent.keyDown(siblingRow, { key: 'F10', shiftKey: true })
    })
    expect(await screen.findByRole('dialog', { name: 'Move folder Team folder' })).toBeTruthy()
  })
})
