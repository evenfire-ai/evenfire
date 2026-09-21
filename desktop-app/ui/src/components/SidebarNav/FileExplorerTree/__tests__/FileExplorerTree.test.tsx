// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { desktopQueryDefaults } from '@lib/queryClient'
import { activeWorkspaceTab, openFilesTab } from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
import {
  accessibleResource,
  childView,
  downloadResult,
  listAccessiblePage,
  listChildrenPage,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { FileExplorerTree } from '..'

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
  listAccessible?: (drive?: string, cursor?: string) => Promise<unknown>
  listChildren?: (resourceId: string, drive?: string, cursor?: string) => Promise<unknown>
  download?: (uri: string) => Promise<unknown>
}

function installClerum(producers: Producers) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        listAccessible: producers.listAccessible ?? vi.fn(async () => listAccessiblePage([])),
        listChildren: producers.listChildren ?? vi.fn(async () => listChildrenPage([])),
        download:
          producers.download ??
          vi.fn(async () => downloadResult(resolvedFile('fallback', 'fallback.bin'))),
      },
    },
  })
}

function renderTree(props: Partial<Parameters<typeof FileExplorerTree>[0]> = {}) {
  const onOpenFolder = props.onOpenFolder ?? vi.fn()
  const onOpenPreview = props.onOpenPreview ?? vi.fn()
  const pushToast = props.pushToast ?? vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <FileExplorerTree
        onOpenFolder={onOpenFolder}
        onOpenPreview={onOpenPreview}
        pushToast={pushToast}
      />
    </QueryClientProvider>
  )
  return { onOpenFolder, onOpenPreview, pushToast }
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
  vi.restoreAllMocks()
})

describe('FileExplorerTree — lazy fetch and expand/collapse', () => {
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
