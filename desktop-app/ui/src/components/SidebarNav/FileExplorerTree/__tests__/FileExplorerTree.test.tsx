// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { activeWorkspaceTab, openFilesTab } from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
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

// T1: the fixtures are typed against the real preload wire contract
// (window.clerum.gfs.listChildren / listAccessible in desktop-app/src/renderer.d.ts),
// which is the shape the main-process producer emits. That producer runs in the
// Electron main process and cannot be called from jsdom, so the fixture mirrors
// the typed boundary — a drift in the contract breaks this factory at compile.
type ChildWire = Awaited<ReturnType<typeof window.clerum.gfs.listChildren>>['items'][number]

function node(
  id: string,
  name: string,
  kind: 'file' | 'directory',
  overrides: Partial<ChildWire> = {}
): ChildWire {
  return {
    resourceId: id,
    rid: id,
    gfsUri: `gfs://main/${id}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind,
    path: `/${name}`,
    version: 1,
    bytes: 4,
    ...overrides,
  }
}

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
        listAccessible:
          producers.listAccessible ?? vi.fn(async () => ({ items: [], nextCursor: null })),
        listChildren:
          producers.listChildren ?? vi.fn(async () => ({ items: [], nextCursor: null })),
        download: producers.download ?? vi.fn(async () => ({ bytes: new ArrayBuffer(4) })),
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
    const listChildren = vi.fn(async () => ({
      items: [node('sub-1', 'Sub', 'directory'), node('r-1', 'r.md', 'file')],
      nextCursor: null,
    }))
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('reports', 'Reports', 'directory')],
        nextCursor: null,
      })),
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
      listAccessible: vi.fn(async () => ({
        items: [
          node('f-b', 'b.txt', 'file'),
          node('d-z', 'Zeta', 'directory'),
          node('d-a', 'Alpha', 'directory'),
          node('f-a', 'a.txt', 'file'),
        ],
        nextCursor: null,
      })),
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
      listAccessible: vi.fn(async () => ({
        // A GFS folder name carrying a bidi override + zero-width — attacker input.
        items: [node('evil', `Re‮ports​`, 'directory')],
        nextCursor: null,
      })),
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
      listAccessible: vi.fn(async () => ({
        items: [node('z', `arch‮ive.zip`, 'file')],
        nextCursor: null,
      })),
    })

    const { pushToast } = renderTree()

    fireEvent.doubleClick(await screen.findByRole('button', { name: 'archive.zip' }))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Downloaded archive.zip', 'success'))
  })
})

describe('FileExplorerTree — single-vs-double click cancels the deferred single', () => {
  // The real browser fires click → click → dblclick; a single fireEvent.doubleClick
  // dispatches only dblclick, so it never exercises the setTimeout cancellation.
  // These drive the full sequence and advance the 250ms window to prove the
  // deferred single-click action was cancelled by the double-click.
  it('folder: the double-click opens the tab once and never runs the deferred toggle', async () => {
    const listChildren = vi.fn(async () => ({
      items: [node('sub-1', 'Sub', 'directory')],
      nextCursor: null,
    }))
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('reports', 'Reports', 'directory')],
        nextCursor: null,
      })),
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

  it('file: the double-click previews once and the deferred select adds nothing', async () => {
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('img-1', 'photo.png', 'file')],
        nextCursor: null,
      })),
    })

    const { onOpenPreview } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })

    vi.useFakeTimers()
    try {
      fireEvent.click(fileButton)
      fireEvent.click(fileButton)
      fireEvent.doubleClick(fileButton)
      expect(onOpenPreview).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(300)
      })
    } finally {
      vi.useRealTimers()
    }

    // Advancing past the single-click window adds no second activation.
    expect(onOpenPreview).toHaveBeenCalledTimes(1)
  })
})

describe('FileExplorerTree — Enter activates (§3.A.4)', () => {
  it('folder: Enter opens the files tab and does not expand', async () => {
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('reports', 'Reports', 'directory')],
        nextCursor: null,
      })),
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
      listAccessible: vi.fn(async () => ({
        items: [node('img-1', 'photo.png', 'file')],
        nextCursor: null,
      })),
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

describe('FileExplorerTree — single-click never navigates', () => {
  it('selects a file on single-click without opening a preview tab', async () => {
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('img-1', 'photo.png', 'file')],
        nextCursor: null,
      })),
    })

    const { onOpenPreview } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })
    const treeitem = fileButton.closest('[role="treeitem"]') as HTMLElement
    expect(treeitem.getAttribute('aria-selected')).toBe('false')

    fireEvent.click(fileButton)

    // The deferred single-click resolves to selection only (aria-selected), and
    // never to a preview tab — even after the single-vs-double window elapses.
    await waitFor(() => expect(treeitem.getAttribute('aria-selected')).toBe('true'))
    expect(onOpenPreview).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree — double-click activation', () => {
  it('opens a preview tab for a previewable file on double-click', async () => {
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('img-1', 'photo.png', 'file')],
        nextCursor: null,
      })),
    })
    const { onOpenPreview } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'photo.png' })
    fireEvent.doubleClick(fileButton)

    expect(onOpenPreview).toHaveBeenCalledTimes(1)
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', gfsUri: 'gfs://main/img-1', name: 'photo.png' })
    )
  })

  it('downloads a non-previewable file on double-click and toasts success', async () => {
    const download = vi.fn(async () => ({ bytes: new ArrayBuffer(8) }))
    installClerum({
      listAccessible: vi.fn(async () => ({
        items: [node('zip-1', 'archive.zip', 'file')],
        nextCursor: null,
      })),
      download,
    })

    const { onOpenPreview, pushToast } = renderTree()

    const fileButton = await screen.findByRole('button', { name: 'archive.zip' })
    fireEvent.doubleClick(fileButton)

    await waitFor(() => expect(download).toHaveBeenCalledWith('gfs://main/zip-1'))
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith('Downloaded archive.zip', 'success'))
    expect(onOpenPreview).not.toHaveBeenCalled()
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
      listAccessible: vi.fn(async () => ({
        items: [node('reports', 'Reports', 'directory'), node('archive', 'Archive', 'directory')],
        nextCursor: null,
      })),
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
