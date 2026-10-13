// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
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
  resourceAffordances,
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
  affordances?: (resourceId: string, drive?: string) => Promise<unknown>
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
        affordances: producers.affordances ?? vi.fn(async () => resourceAffordances(['read'])),
      },
    },
  })
}

function renderTree(props: Partial<Parameters<typeof FileExplorerTree>[0]> = {}) {
  const onOpenFolder = props.onOpenFolder ?? vi.fn()
  const onOpenPreview = props.onOpenPreview ?? vi.fn()
  const onResourceAction = props.onResourceAction ?? vi.fn()
  const pushToast = props.pushToast ?? vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <FileExplorerTree
        onOpenFolder={onOpenFolder}
        onOpenPreview={onOpenPreview}
        onResourceAction={onResourceAction}
        pushToast={pushToast}
      />
    </QueryClientProvider>
  )
  return { onOpenFolder, onOpenPreview, onResourceAction, pushToast, queryClient }
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

describe('FileExplorerTree — resource action menus', () => {
  it('keeps a visible, labeled menu on a long row and dispatches its exact resource without toggling', async () => {
    const resource = accessibleResource(
      'folder-1',
      'A very long folder name that will be truncated in the narrow sidebar',
      'directory'
    )
    const onResourceAction = vi.fn()
    const onOpenFolder = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances: vi.fn(async () => resourceAffordances(['read', 'write'])),
    })

    renderTree({ onOpenFolder, onResourceAction })

    const row = await screen.findByRole('treeitem')
    const menuTrigger = within(row).getByRole('button', {
      name: /^Options for A very long folder name/,
    })
    expect(menuTrigger.isConnected).toBe(true)
    expect(menuTrigger.getAttribute('aria-label')).toMatch(/^Options for A very long folder name/)
    fireEvent.click(menuTrigger)

    const menu = await screen.findByRole('menu')
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'New folder' }))

    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'folder-1', gfsUri: resource.gfsUri }),
      'new-folder'
    )
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(onOpenFolder).not.toHaveBeenCalled()
  })

  it('dispatches the row under its own menu even when another file is selected', async () => {
    const first = accessibleResource('first', 'first.png', 'file')
    const second = accessibleResource('second', 'second.png', 'file')
    const onOpenPreview = vi.fn()
    const onResourceAction = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([first, second])),
      affordances: vi.fn(async () => resourceAffordances(['read'])),
    })

    renderTree({ onOpenPreview, onResourceAction })

    const firstRow = (await screen.findByRole('button', { name: 'first.png' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    const secondRow = screen
      .getByRole('button', { name: 'second.png' })
      .closest('[role="treeitem"]') as HTMLElement
    fireEvent.click(within(firstRow).getByRole('button', { name: 'first.png' }))
    expect(firstRow.getAttribute('aria-selected')).toBe('true')
    expect(onOpenPreview).toHaveBeenCalledWith(
      expect.objectContaining({ gfsUri: first.gfsUri, name: first.name })
    )

    fireEvent.click(within(secondRow).getByRole('button', { name: `Options for ${second.name}` }))
    const menu = await screen.findByRole('menu', { name: `Actions for ${second.name}` })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy route' }))

    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'second', gfsUri: second.gfsUri }),
      'copy-route'
    )
    expect(firstRow.getAttribute('aria-selected')).toBe('true')
    expect(secondRow.getAttribute('aria-selected')).toBe('false')
    expect(onOpenPreview).toHaveBeenCalledTimes(1)
  })

  it.each(['Copy route', 'Copy link'])(
    'returns keyboard focus to the same persistent row trigger after %s',
    async actionName => {
      const resource = accessibleResource(
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'focus-target.md',
        'file'
      )
      const onResourceAction = vi.fn()
      installClerum({
        listAccessible: vi.fn(async () => listAccessiblePage([resource])),
        affordances: vi.fn(async () => resourceAffordances(['read'])),
      })
      const user = userEvent.setup()
      renderTree({ onResourceAction })

      const row = await screen.findByRole('treeitem', { name: /focus-target\.md/ })
      const trigger = within(row).getByRole('button', { name: 'Options for focus-target.md' })
      for (let attempt = 0; document.activeElement !== trigger && attempt < 10; attempt += 1) {
        await user.tab()
      }
      expect(document.activeElement).toBe(trigger)

      await user.keyboard('{Enter}')
      const menu = await screen.findByRole('menu', { name: 'Actions for focus-target.md' })
      const menuItems = within(menu).getAllByRole('menuitem')
      const selectedIndex = menuItems.findIndex(item => item.textContent?.trim() === actionName)
      expect(selectedIndex).toBeGreaterThanOrEqual(0)
      await user.keyboard('{Home}')
      for (let index = 0; index < selectedIndex; index += 1) {
        await user.keyboard('{ArrowDown}')
      }
      expect(document.activeElement).toBe(menuItems[selectedIndex])
      await user.keyboard('{Enter}')

      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(trigger.isConnected).toBe(true)
      expect(onResourceAction).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: resource.resourceId, gfsUri: resource.gfsUri }),
        actionName === 'Copy route' ? 'copy-route' : 'copy-link'
      )
    }
  )

  it('does not focus a row trigger after its action unmounts the tree', async () => {
    const resource = accessibleResource(
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'removed-target.md',
      'file'
    )
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances: vi.fn(async () => resourceAffordances(['read'])),
    })
    const user = userEvent.setup()
    let trigger: HTMLButtonElement | null = null
    let unmountTree: () => void = () => {}
    const onResourceAction = vi.fn(() => unmountTree())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function UnmountingHarness() {
      const [visible, setVisible] = useState(true)
      unmountTree = () => setVisible(false)
      return (
        <QueryClientProvider client={queryClient}>
          {visible ? (
            <FileExplorerTree
              onOpenFolder={vi.fn()}
              onOpenPreview={vi.fn()}
              onResourceAction={onResourceAction}
              pushToast={vi.fn()}
            />
          ) : null}
        </QueryClientProvider>
      )
    }
    render(<UnmountingHarness />)

    const row = await screen.findByRole('treeitem', { name: /removed-target\.md/ })
    const triggerButton = within(row).getByRole('button', {
      name: 'Options for removed-target.md',
    }) as HTMLButtonElement
    trigger = triggerButton
    const focusTrigger = vi.spyOn(triggerButton, 'focus')
    for (let attempt = 0; document.activeElement !== triggerButton && attempt < 10; attempt += 1) {
      await user.tab()
    }
    expect(document.activeElement).toBe(triggerButton)
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: 'Actions for removed-target.md' })
    focusTrigger.mockClear()
    const menuItems = within(menu).getAllByRole('menuitem')
    const copyRouteIndex = menuItems.findIndex(item => item.textContent?.trim() === 'Copy route')
    await user.keyboard('{Home}')
    for (let index = 0; index < copyRouteIndex; index += 1) {
      await user.keyboard('{ArrowDown}')
    }
    await user.keyboard('{Enter}')

    await waitFor(() => expect(trigger?.isConnected).toBe(false))
    await new Promise(resolve => window.setTimeout(resolve, 10))
    expect(focusTrigger).not.toHaveBeenCalled()
    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: resource.resourceId, gfsUri: resource.gfsUri }),
      'copy-route'
    )
  })

  it('keeps pointer menu activation without keyboard-only focus restoration', async () => {
    const resource = accessibleResource(
      'dddddddddddddddddddddddddddddddd',
      'pointer-target.md',
      'file'
    )
    const onResourceAction = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances: vi.fn(async () => resourceAffordances(['read'])),
    })
    const user = userEvent.setup()
    renderTree({ onResourceAction })

    const row = await screen.findByRole('treeitem', { name: /pointer-target\.md/ })
    const trigger = within(row).getByRole('button', { name: 'Options for pointer-target.md' })
    await user.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Actions for pointer-target.md' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy route' }))

    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: resource.resourceId, gfsUri: resource.gfsUri }),
      'copy-route'
    )
    expect(document.activeElement).not.toBe(trigger)
  })

  it('keeps focus in a dialog opened by a keyboard row action', async () => {
    const resource = accessibleResource(
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'dialog-target.md',
      'file'
    )
    const onResourceAction = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances: vi.fn(async () => resourceAffordances(['read', 'delete'])),
    })
    const user = userEvent.setup()
    function DialogHarness() {
      const [dialogOpen, setDialogOpen] = useState(false)
      return (
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <FileExplorerTree
            onOpenFolder={vi.fn()}
            onOpenPreview={vi.fn()}
            onResourceAction={(item, action) => {
              onResourceAction(item, action)
              if (action === 'delete') setDialogOpen(true)
            }}
            pushToast={vi.fn()}
          />
          {dialogOpen ? (
            <div role="dialog" aria-label="Delete dialog">
              <button autoFocus>Confirm delete</button>
            </div>
          ) : null}
        </QueryClientProvider>
      )
    }
    render(<DialogHarness />)

    const row = await screen.findByRole('treeitem', { name: /dialog-target\.md/ })
    const trigger = within(row).getByRole('button', { name: 'Options for dialog-target.md' })
    for (let attempt = 0; document.activeElement !== trigger && attempt < 10; attempt += 1) {
      await user.tab()
    }
    expect(document.activeElement).toBe(trigger)
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: 'Actions for dialog-target.md' })
    const items = within(menu).getAllByRole('menuitem')
    const deleteIndex = items.findIndex(item => item.textContent?.trim() === 'Delete')
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    await user.keyboard('{Home}')
    for (let index = 0; index < deleteIndex; index += 1) {
      await user.keyboard('{ArrowDown}')
    }
    await user.keyboard('{Enter}')

    const dialog = await screen.findByRole('dialog', { name: 'Delete dialog' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm delete' })
    await waitFor(() => expect(document.activeElement).toBe(confirm))
    expect(document.activeElement).not.toBe(trigger)
    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: resource.resourceId, gfsUri: resource.gfsUri }),
      'delete'
    )
  })

  it('keeps Escape returning focus to the invoking trigger', async () => {
    const resource = accessibleResource(
      'cccccccccccccccccccccccccccccccc',
      'escape-target.md',
      'file'
    )
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances: vi.fn(async () => resourceAffordances(['read'])),
    })
    const user = userEvent.setup()
    renderTree()

    const row = await screen.findByRole('treeitem', { name: /escape-target\.md/ })
    const trigger = within(row).getByRole('button', { name: 'Options for escape-target.md' })
    for (let attempt = 0; document.activeElement !== trigger && attempt < 10; attempt += 1) {
      await user.tab()
    }
    expect(document.activeElement).toBe(trigger)
    await user.keyboard('{Enter}')
    await screen.findByRole('menu', { name: 'Actions for escape-target.md' })
    await user.keyboard('{Escape}')

    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps exact-row action dispatch connected through nested folders', async () => {
    const root = accessibleResource('root', 'Shared', 'directory')
    const nested = childView('nested', 'Nested folder', 'directory')
    const onResourceAction = vi.fn()
    const onOpenFolder = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([root])),
      listChildren: vi.fn(async () => listChildrenPage([nested])),
    })

    renderTree({ onOpenFolder, onResourceAction })

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Shared' }))
    const nestedRow = (await screen.findByRole('button', { name: 'Nested folder' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    fireEvent.click(within(nestedRow).getByRole('button', { name: 'Options for Nested folder' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Nested folder' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy route' }))

    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'nested', gfsUri: nested.gfsUri }),
      'copy-route'
    )
    expect(nestedRow.getAttribute('aria-expanded')).toBe('false')
    expect(onOpenFolder).not.toHaveBeenCalled()
  })

  it('shows only resource-kind and held-permission actions', async () => {
    const folder = accessibleResource('folder', 'Reports', 'directory')
    const file = accessibleResource('file', 'report.pdf', 'file')
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([folder, file])),
      affordances: vi.fn(async resourceId =>
        resourceAffordances(resourceId === 'folder' ? ['read', 'write'] : ['read'])
      ),
    })

    renderTree()

    const folderRow = (await screen.findByRole('button', { name: 'Reports' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    const folderTrigger = within(folderRow).getByRole('button', { name: 'Options for Reports' })
    fireEvent.click(folderTrigger)
    const folderMenu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    expect(await within(folderMenu).findByRole('menuitem', { name: 'New folder' })).toBeTruthy()
    expect(within(folderMenu).getByRole('menuitem', { name: 'Upload file' })).toBeTruthy()
    expect(within(folderMenu).queryByRole('menuitem', { name: 'Download' })).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).toBe(folderTrigger)
    const fileRow = (await screen.findByRole('button', { name: 'report.pdf' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    fireEvent.click(within(fileRow).getByRole('button', { name: 'Options for report.pdf' }))
    const fileMenu = await screen.findByRole('menu', { name: 'Actions for report.pdf' })
    expect(await within(fileMenu).findByRole('menuitem', { name: 'Copy route' })).toBeTruthy()
    expect(within(fileMenu).getByRole('menuitem', { name: 'Download' })).toBeTruthy()
    expect(within(fileMenu).queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(within(fileMenu).queryByRole('menuitem', { name: 'Share' })).toBeNull()
    expect(within(fileMenu).queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    expect(within(fileMenu).queryByRole('menuitem', { name: 'New folder' })).toBeNull()
    expect(within(fileMenu).queryByRole('menuitem', { name: 'Replace file' })).toBeNull()
  })

  it('revalidates held permissions while the menu stays open', async () => {
    let held = ['read', 'write']
    const affordances = vi.fn(async () => resourceAffordances(held))
    const resource = accessibleResource('folder', 'Reports', 'directory')
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances,
    })

    const { queryClient } = renderTree()
    const row = (await screen.findByRole('button', { name: 'Reports' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Options for Reports' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    expect(await within(menu).findByRole('menuitem', { name: 'Rename' })).toBeTruthy()

    held = ['read']
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: desktopQueryKeys.gfsAffordances('test:user-1:team-1', 'folder', 'main'),
        exact: true,
      })
    })

    await waitFor(() => expect(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeNull())
    expect(affordances).toHaveBeenCalledTimes(2)
  })

  it('hides cached permission actions after the refreshed affordance request is denied', async () => {
    const affordances = vi
      .fn()
      .mockResolvedValueOnce(resourceAffordances(['read', 'write']))
      .mockRejectedValueOnce(new Error('403 Forbidden: httpStatus=403'))
    const resource = accessibleResource('folder', 'Reports', 'directory')
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances,
    })

    const { queryClient } = renderTree()
    const row = (await screen.findByRole('button', { name: 'Reports' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Options for Reports' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    expect(await within(menu).findByRole('menuitem', { name: 'Rename' })).toBeTruthy()

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: desktopQueryKeys.gfsAffordances('test:user-1:team-1', 'folder', 'main'),
        exact: true,
      })
    })

    await waitFor(() => expect(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeNull())
    expect(affordances).toHaveBeenCalledTimes(2)
  })

  it('revokes shared tree access when the per-row affordance refresh returns 401', async () => {
    function AccessStateProbe() {
      const ctrl = useGfsBrowserController()
      return <div data-testid="probe-access">{ctrl.accessState}</div>
    }

    const affordances = vi
      .fn()
      .mockResolvedValueOnce(resourceAffordances(['read', 'write']))
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
    const resource = accessibleResource('folder', 'Reports', 'directory')
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([resource])),
      affordances,
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <FileExplorerTree
          onOpenFolder={vi.fn()}
          onOpenPreview={vi.fn()}
          onResourceAction={vi.fn()}
          pushToast={vi.fn()}
        />
        <AccessStateProbe />
      </QueryClientProvider>
    )
    const row = (await screen.findByRole('button', { name: 'Reports' })).closest(
      '[role="treeitem"]'
    ) as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Options for Reports' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for Reports' })
    expect(await within(menu).findByRole('menuitem', { name: 'Rename' })).toBeTruthy()

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: desktopQueryKeys.gfsAffordances('test:user-1:team-1', 'folder', 'main'),
        exact: true,
      })
    })

    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('probe-access').textContent).toBe('revoked'))
    expect(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(affordances).toHaveBeenCalledTimes(2)
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
          onResourceAction={vi.fn()}
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
        <FileExplorerTree
          onOpenFolder={vi.fn()}
          onOpenPreview={vi.fn()}
          onResourceAction={vi.fn()}
          pushToast={vi.fn()}
        />
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
        <FileExplorerTree
          onOpenFolder={vi.fn()}
          onOpenPreview={vi.fn()}
          onResourceAction={vi.fn()}
          pushToast={vi.fn()}
        />
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

  it('keeps parent-authorized Move available for an unreadable row', async () => {
    const { onResourceAction } = await renderExpandedVault()
    const row = screen
      .getByRole('button', { name: /secret\.pdf.*No access/ })
      .closest('[role="treeitem"]') as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Options for secret.pdf' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for secret.pdf' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))

    expect(onResourceAction).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'secret', readable: false }),
      'move'
    )
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
        <FileExplorerTree
          onOpenFolder={vi.fn()}
          onOpenPreview={vi.fn()}
          onResourceAction={vi.fn()}
          pushToast={vi.fn()}
        />
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
