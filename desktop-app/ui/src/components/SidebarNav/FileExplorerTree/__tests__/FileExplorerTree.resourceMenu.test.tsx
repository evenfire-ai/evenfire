// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue, useAuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GfsActionHost } from '@components/GfsActionHost'
import { useGfsActionOverlay } from '@components/GfsActionHost/overlay'
import {
  accessibleResource,
  affordancesFailureMessage,
  childView,
  listAccessiblePage,
  listChildrenPage,
  moveResourceReceipt,
  resolveResource,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { GfsDragSessionProvider } from '@/gfs/dragSession'
import { FileExplorerTree } from '..'

const authFor = (teamId: string) =>
  ({
    isAuthenticated: true,
    me: { id: 'user-1', teamId },
    runtimeConfigState: { envKey: 'test' },
    sessionGeneration: 7,
  }) as unknown as AuthContextValue

type Deferred = { resourceId: string; release: (held: string[]) => void }

/**
 * Affordances answered by the real AppService producer, each read held until
 * the test releases it with the bits it grants.
 */
function deferredAffordances() {
  const pending: Deferred[] = []
  const produce = appServiceAffordanceProducer(
    resourceId =>
      new Promise(resolve => {
        pending.push({ resourceId, release: held => resolve(heldPermissionResponse(held)) })
      })
  )
  const affordances = vi.fn((resourceId: string, drive?: string) => produce(resourceId, drive))
  const release = async (resourceId: string, held: string[]) => {
    const index = pending.findIndex(entry => entry.resourceId === resourceId)
    expect(index).toBeGreaterThanOrEqual(0)
    const [entry] = pending.splice(index, 1)
    await act(async () => {
      entry!.release(held)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  return { affordances, release, pending }
}

function installClerum(gfs: Record<string, unknown>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 7) },
      gfs: {
        listAccessible: vi.fn(async () => listAccessiblePage([])),
        listChildren: vi.fn(async () => listChildrenPage([])),
        ...gfs,
      },
    },
  })
}

const overlayHistory: boolean[] = []
const previewsOpened: unknown[] = []

function Shell() {
  const overlay = useGfsActionOverlay()
  overlayHistory.push(overlay.overlayOpen)
  return (
    <GfsActionHost
      pushToast={() => undefined}
      refreshFilesLocation={() => undefined}
      onActionOpenChange={overlay.onActionOpenChange}
    >
      <FileExplorerTree
        onOpenFolder={() => undefined}
        onOpenPreview={preview => previewsOpened.push(preview)}
        pushToast={() => undefined}
        onGfsMenuOpenChange={overlay.onGfsMenuOpenChange}
      />
    </GfsActionHost>
  )
}

/**
 * Runs `onTeamChange` in the layout phase of the commit that publishes a new
 * team: after every render of that commit, before any passive effect.
 */
function TeamChangeProbe({ onTeamChange }: { onTeamChange?: () => void }) {
  const teamId = (useAuthContext().me as { teamId?: string } | null)?.teamId
  const previous = useRef(teamId)
  useLayoutEffect(() => {
    if (previous.current === teamId) return
    previous.current = teamId
    onTeamChange?.()
  }, [onTeamChange, teamId])
  return null
}

function renderShell(onTeamChange?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (teamId: string) => (
    <AuthContext.Provider value={authFor(teamId)}>
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <Shell />
          <TeamChangeProbe onTeamChange={onTeamChange} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  const rendered = render(tree('team-1'))
  return { queryClient, switchTeam: (teamId: string) => rendered.rerender(tree(teamId)) }
}

function menuItem(menu: HTMLElement, name: string) {
  return within(menu).queryByRole('menuitem', { name }) as HTMLButtonElement | null
}

beforeEach(() => {
  overlayHistory.length = 0
  previewsOpened.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FileExplorerTree row resource menu (S-1)', () => {
  async function folderWithTwoFiles() {
    const bits = deferredAffordances()
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-d', 'Docs', 'directory', { permissions: ['read'] }),
        ])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([
          childView('file-a', 'a.txt', 'file', { parentResourceId: 'folder-d' }),
          childView('file-b', 'b.bin', 'file', { parentResourceId: 'folder-d' }),
        ])
      ),
      affordances: bits.affordances,
    })
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }))
    await screen.findByRole('button', { name: 'a.txt' })
    return bits
  }

  it('keeps bit-dependent items inert while pending and drops bits that arrive for an older opening', async () => {
    const bits = await folderWithTwoFiles()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.txt' }), {
      clientX: 30,
      clientY: 40,
    })
    const menuA = await screen.findByRole('menu', { name: 'Actions for a.txt' })
    // Built optimistically: listed, but inert until the bits settle.
    expect(menuItem(menuA, 'Rename')?.disabled).toBe(true)
    expect(menuItem(menuA, 'Delete')?.disabled).toBe(true)
    expect(menuItem(menuA, 'Move to')?.disabled).toBe(true)
    expect(menuItem(menuA, 'Download')?.disabled).toBe(false)
    expect(menuItem(menuA, 'Preview')?.disabled).toBe(false)

    // A second opening on another row before the first one's bits land.
    fireEvent.contextMenu(screen.getByRole('button', { name: 'b.bin' }), {
      clientX: 30,
      clientY: 60,
    })
    const menuB = await screen.findByRole('menu', { name: 'Actions for b.bin' })
    expect(screen.queryByRole('menu', { name: 'Actions for a.txt' })).toBeNull()

    await bits.release('file-a', ['read', 'write', 'delete', 'manage_acl'])
    await bits.release('folder-d', ['read'])
    // a.txt's late write bit never reaches b.bin's menu.
    expect(menuItem(menuB, 'Rename')?.disabled).toBe(true)
    expect(menuItem(menuB, 'Delete')?.disabled).toBe(true)

    await bits.release('file-b', ['read'])
    await waitFor(() => expect(menuItem(menuB, 'Rename')).toBeNull())
    expect(menuItem(menuB, 'Delete')).toBeNull()
    expect(menuItem(menuB, 'Move to')).toBeNull()
    expect(menuItem(menuB, 'Download')?.disabled).toBe(false)
    // Two openings, two rows and one parent they share: within K1's two per opening.
    expect(bits.affordances).toHaveBeenCalledTimes(3)
  })

  it('withholds only Move when the parent read fails, keeping the row bits', async () => {
    const rateLimited = await affordancesFailureMessage(429, {
      code: 'rate_limited',
      message: 'slow down',
    })
    const rowBits = appServiceAffordanceProducer(async () =>
      heldPermissionResponse(['read', 'write'])
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-d', 'Docs', 'directory', { permissions: ['read'] }),
        ])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('file-a', 'a.txt', 'file', { parentResourceId: 'folder-d' })])
      ),
      affordances: vi.fn(async (resourceId: string, drive?: string) => {
        if (resourceId === 'folder-d') throw new Error(rateLimited)
        return rowBits(resourceId, drive)
      }),
    })
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }))
    const menu = await openMenuOn('a.txt')
    await waitFor(() => expect(menuItem(menu, 'Rename')?.disabled).toBe(false))
    expect(menuItem(menu, 'Move to')).toBeNull()
    expect(menuItem(menu, 'Delete')).toBeNull()
  })

  it('keeps the shared rate-limit pause for a reopening after a 429', async () => {
    const rateLimited = await affordancesFailureMessage(429, {
      code: 'rate_limited',
      message: 'slow down',
    })
    const affordances = vi.fn(async () => {
      throw new Error(rateLimited)
    })
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-d', 'Docs', 'directory', { permissions: ['read'] }),
        ])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('file-a', 'a.txt', 'file', { parentResourceId: 'folder-d' })])
      ),
      affordances,
    })
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }))
    const menu = await openMenuOn('a.txt')
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(2))
    // A failed row read keeps every bit-dependent item inert.
    await waitFor(() => expect(menuItem(menu, 'Rename')?.disabled).toBe(true))
    fireEvent.keyDown(menu, { key: 'Escape' })

    const reopened = await openMenuOn('a.txt')
    await waitFor(() => expect(menuItem(reopened, 'Rename')?.disabled).toBe(true))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(affordances).toHaveBeenCalledTimes(2)
  })

  it('reuses fresh bits for a reopening without another read', async () => {
    const bits = await folderWithTwoFiles()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.txt' }), {
      clientX: 30,
      clientY: 40,
    })
    await bits.release('file-a', ['read', 'write'])
    await bits.release('folder-d', ['read', 'write', 'delete'])
    const menu = screen.getByRole('menu', { name: 'Actions for a.txt' })
    await waitFor(() => expect(menuItem(menu, 'Rename')?.disabled).toBe(false))
    expect(menuItem(menu, 'Move to')?.disabled).toBe(false)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Actions for a.txt' })).toBeNull()
    bits.affordances.mockClear()

    fireEvent.keyDown(screen.getByRole('button', { name: 'a.txt' }), {
      key: 'F10',
      shiftKey: true,
    })
    const reopened = await screen.findByRole('menu', { name: 'Actions for a.txt' })
    await waitFor(() => expect(menuItem(reopened, 'Rename')?.disabled).toBe(false))
    expect(bits.affordances).not.toHaveBeenCalled()
  })

  it('hands the chosen action to the host and closes the menu without uncovering the window', async () => {
    const bits = await folderWithTwoFiles()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'a.txt' }), {
      clientX: 30,
      clientY: 40,
    })
    await bits.release('file-a', ['read', 'write'])
    await bits.release('folder-d', ['read'])
    const menu = screen.getByRole('menu', { name: 'Actions for a.txt' })
    await waitFor(() => expect(menuItem(menu, 'Rename')?.disabled).toBe(false))
    expect(overlayHistory.at(-1)).toBe(true)
    overlayHistory.length = 0

    fireEvent.click(menuItem(menu, 'Rename')!)

    expect(screen.queryByRole('menu', { name: 'Actions for a.txt' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: 'Rename file' })).toBeTruthy()
    // Fresh bits from the menu let the host open without another read.
    expect(bits.pending).toHaveLength(0)
    expect(overlayHistory).not.toContain(false)
  })
})

describe('FileExplorerTree row resource menu: bits and session', () => {
  it('gates a forest root on the permissions its listing carries, like the Files root view', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read'] }),
        ])
      ),
      affordances: vi.fn(
        appServiceAffordanceProducer(async () =>
          heldPermissionResponse(['read', 'write', 'delete', 'manage_acl'])
        )
      ),
    })
    renderShell()
    const menu = await openMenuOn('shared.txt')
    await waitFor(() => expect(menuItem(menu, 'Download')).not.toBeNull())
    await waitFor(() => expect(menuItem(menu, 'Rename')).toBeNull())
    expect(menuItem(menu, 'Delete')).toBeNull()
    expect(vi.mocked(window.clerum.gfs.affordances)).not.toHaveBeenCalled()
  })

  it('fails the session closed when the menu reads a 401 for its bits', async () => {
    const unauthorized = await affordancesFailureMessage(401, {
      code: 'unauthorized',
      message: 'session expired',
    })
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('folder-d', 'Docs', 'directory', { permissions: ['read'] }),
        ])
      ),
      listChildren: vi.fn(async () =>
        listChildrenPage([childView('file-a', 'a.txt', 'file', { parentResourceId: 'folder-d' })])
      ),
      affordances: vi.fn(async () => {
        throw new Error(unauthorized)
      }),
    })
    renderShell()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Docs' }))
    await openMenuOn('a.txt')
    expect(await screen.findByText('File access is not authorized')).toBeTruthy()
    expect(screen.queryByRole('menu', { name: 'Actions for a.txt' })).toBeNull()
  })

  it('closes an open menu when the session changes team', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read'] }),
        ])
      ),
      affordances: appServiceAffordanceProducer(async () => heldPermissionResponse(['read'])),
    })
    const { switchTeam } = renderShell()
    await openMenuOn('shared.txt')
    expect(overlayHistory.at(-1)).toBe(true)

    act(() => switchTeam('team-2'))

    expect(screen.queryByRole('menu', { name: 'Actions for shared.txt' })).toBeNull()
    expect(overlayHistory.at(-1)).toBe(false)
  })
})

describe('FileExplorerTree row resource menu: stale openings', () => {
  it('drops a choice made in a menu opened under the previous team', async () => {
    const affordances = vi.fn(
      appServiceAffordanceProducer(async () => heldPermissionResponse(['read', 'write']))
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read', 'write'] }),
        ])
      ),
      affordances,
    })
    let chosen = false
    const { switchTeam } = renderShell(() => {
      const rename = document.querySelector<HTMLButtonElement>('[data-gfs-action="rename"]')
      if (!rename || rename.disabled) return
      chosen = true
      rename.click()
    })
    const menu = await openMenuOn('shared.txt')
    await waitFor(() => expect(menuItem(menu, 'Rename')?.disabled).toBe(false))

    act(() => switchTeam('team-2'))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(chosen).toBe(true)
    expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull()
    expect(affordances).not.toHaveBeenCalled()
  })

  it("keeps focus in the opened menu, where the ContextMenu key's own contextmenu lands", async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read'] }),
        ])
      ),
    })
    renderShell()
    const row = await screen.findByRole('button', { name: 'shared.txt' })
    row.focus()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    const menu = await screen.findByRole('menu', { name: 'Actions for shared.txt' })

    // Chromium raises the key's contextmenu on its keyup, at whatever holds
    // focus by then: the opened menu, not the row.
    const focused = document.activeElement as HTMLElement
    expect(menu.contains(focused)).toBe(true)
    fireEvent.keyUp(focused, { key: 'ContextMenu' })
    fireEvent.contextMenu(focused)
    expect(screen.getByRole('menu', { name: 'Actions for shared.txt' })).toBe(menu)

    // A right-click after it is a new opening.
    fireEvent.mouseDown(row)
    fireEvent.contextMenu(row, { clientX: 5, clientY: 5 })
    const reopened = await screen.findByRole('menu', { name: 'Actions for shared.txt' })
    expect(reopened).not.toBe(menu)
  })

  it('opens once for the ContextMenu key when its menu has nothing to focus', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-u', 'locked.bin', 'file', { permissions: ['read'] }),
        ])
      ),
    })
    // No action host and a file with no preview: the menu has no item to
    // focus, so the key's contextmenu reaches the row.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={authFor('team-1')}>
        <QueryClientProvider client={queryClient}>
          <GfsDragSessionProvider>
            <FileExplorerTree
              onOpenFolder={() => undefined}
              onOpenPreview={() => undefined}
              pushToast={() => undefined}
            />
          </GfsDragSessionProvider>
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const row = await screen.findByRole('button', { name: /locked\.bin/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    const menu = await screen.findByRole('menu', { name: 'Actions for locked.bin' })
    expect(document.activeElement).toBe(row)

    fireEvent.keyUp(row, { key: 'ContextMenu' })
    fireEvent.contextMenu(row)

    expect(screen.getByRole('menu', { name: 'Actions for locked.bin' })).toBe(menu)
  })

  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }, false],
    ['the ContextMenu key, once released', { key: 'ContextMenu' }, true],
  ] as const)(
    'opens on a later contextmenu without a mousedown after %s',
    async (_gesture, key, releases) => {
      installClerum({
        listAccessible: vi.fn(async () =>
          listAccessiblePage([
            accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read'] }),
          ])
        ),
      })
      renderShell()
      const row = await screen.findByRole('button', { name: 'shared.txt' })
      fireEvent.keyDown(row, key)
      const menu = await screen.findByRole('menu', { name: 'Actions for shared.txt' })
      if (releases) {
        fireEvent.keyUp(document.activeElement ?? document.body, { key: 'ContextMenu' })
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
      }
      fireEvent.keyDown(menu, { key: 'Escape' })
      expect(screen.queryByRole('menu', { name: 'Actions for shared.txt' })).toBeNull()

      // VO+Shift+M or a long press: a contextmenu with no mousedown before it.
      fireEvent.contextMenu(row, { clientX: 5, clientY: 5 })
      expect(await screen.findByRole('menu', { name: 'Actions for shared.txt' })).not.toBe(menu)
    }
  )
})

describe('FileExplorerTree forest-root resource menu', () => {
  it('paints its final actions on the first render when no read is needed', async () => {
    const affordances = vi.fn()
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read', 'write'] }),
        ])
      ),
      affordances,
    })
    renderShell()
    const row = await screen.findByRole('button', { name: 'shared.txt' })

    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    const menu = screen.getByRole('menu', { name: 'Actions for shared.txt' })
    const firstPaint = {
      rename: menuItem(menu, 'Rename')?.disabled,
      delete: menuItem(menu, 'Delete')?.disabled,
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // The listing grants write and not delete; no parent means no Move.
    expect(firstPaint).toEqual({ rename: false, delete: undefined })
    expect({
      rename: menuItem(menu, 'Rename')?.disabled,
      delete: menuItem(menu, 'Delete')?.disabled,
    }).toEqual(firstPaint)
    expect(affordances).not.toHaveBeenCalled()
  })
})

describe('FileExplorerTree row resource menu focus', () => {
  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard
  })

  it('leaves the row out of reach while Move opened from the keyboard is up', async () => {
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-r', 'report.txt', 'file', {
            parentResourceId: 'source-parent',
            permissions: ['read'],
          }),
        ])
      ),
      affordances: appServiceAffordanceProducer(async () =>
        heldPermissionResponse(['read', 'write', 'delete'])
      ),
    })
    renderShell()
    const row = await screen.findByRole('button', { name: 'report.txt' })
    row.focus()
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    const menu = await screen.findByRole('menu', { name: 'Actions for report.txt' })
    const move = await waitFor(() => {
      const found = menuItem(menu, 'Move to')
      expect(found?.disabled).toBe(false)
      return found!
    })
    move.focus()
    fireEvent.click(move)
    const dialog = await screen.findByRole('dialog', { name: 'Move file report.txt' })

    // Whatever holds focus now gets the next keys.
    const focused = document.activeElement ?? document.body
    fireEvent.keyDown(focused, { key: 'Enter' })
    fireEvent.keyDown(focused, { key: 'F10', shiftKey: true })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(previewsOpened).toEqual([])
    expect(screen.queryByRole('menu', { name: 'Actions for report.txt' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Move file report.txt' })).toBe(dialog)
  })

  it.each([
    ['Preview', false],
    ['Download', false],
    ['Copy file ID', true],
  ] as const)(
    'returns focus to the row after %s chosen from the keyboard',
    async (label, inShareFlyout) => {
      installClerum({
        listAccessible: vi.fn(async () =>
          listAccessiblePage([
            accessibleResource('file-s', 'shared.txt', 'file', { permissions: ['read'] }),
          ])
        ),
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => undefined) },
      })
      renderShell()
      const row = await screen.findByRole('button', { name: 'shared.txt' })
      row.focus()
      fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
      const menu = await screen.findByRole('menu', { name: 'Actions for shared.txt' })
      let list: HTMLElement = menu
      if (inShareFlyout) {
        const share = menuItem(menu, 'Share')!
        share.focus()
        fireEvent.keyDown(share, { key: 'ArrowRight' })
        list = await screen.findByRole('menu', { name: 'Share options for shared.txt' })
      }
      const item = await waitFor(() => {
        const found = menuItem(list, label)
        expect(found?.disabled).toBe(false)
        return found!
      })
      item.focus()
      // A keyboard activation of a button is a click on the focused item.
      fireEvent.click(item)

      await waitFor(() =>
        expect(screen.queryByRole('menu', { name: 'Actions for shared.txt' })).toBeNull()
      )
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'shared.txt' }))
    }
  )
})

async function openMenuOn(name: string) {
  fireEvent.contextMenu(await screen.findByRole('button', { name }), { clientX: 10, clientY: 10 })
  return screen.findByRole('menu', { name: `Actions for ${name}` })
}

describe('FileExplorerTree drag during a host Move (S-10)', () => {
  it('ignores a close while the host Move runs and refuses to drag the resource it moves', async () => {
    let finishMove!: () => void
    const moveGate = new Promise<void>(resolve => {
      finishMove = resolve
    })
    let markMoveStarted!: () => void
    const moveStarted = new Promise<void>(resolve => {
      markMoveStarted = resolve
    })
    const moveResource = vi.fn(async () => {
      markMoveStarted()
      await moveGate
      return moveResourceReceipt('file-r', 'archive-a', 5)
    })
    const resolved = await resolveResource(
      resolvedFile('file-r', 'report.txt', { parentResourceId: 'source-parent', version: 4 })
    )
    installClerum({
      listAccessible: vi.fn(async () =>
        listAccessiblePage([
          accessibleResource('file-r', 'report.txt', 'file', {
            parentResourceId: 'source-parent',
            version: 4,
            permissions: ['read'],
          }),
          accessibleResource('archive-a', 'Archive A', 'directory', {
            permissions: ['read', 'write'],
          }),
        ])
      ),
      affordances: appServiceAffordanceProducer(async () =>
        heldPermissionResponse(['read', 'write', 'delete'])
      ),
      resolve: vi.fn(async () => resolved),
      moveResource,
    })
    renderShell()

    const row = await screen.findByRole('button', { name: 'report.txt' })
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    const menu = await screen.findByRole('menu', { name: 'Actions for report.txt' })
    await waitFor(() => expect(menuItem(menu, 'Move to')?.disabled).toBe(false))
    fireEvent.click(menuItem(menu, 'Move to')!)
    const dialog = await screen.findByRole('dialog', { name: 'Move file report.txt' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive A' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive A)' }))
    await act(async () => {
      await moveStarted
    })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
    expect(screen.getByRole('dialog', { name: 'Move file report.txt' })).toBe(dialog)

    const refused = { types: [] as string[], effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(screen.getByRole('button', { name: 'report.txt' }), {
      dataTransfer: refused,
    })
    expect(refused.setData).not.toHaveBeenCalled()

    await act(async () => {
      finishMove()
      await moveGate
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()
    )
    // Once the host Move settles the same row drags again.
    const admitted = { types: [] as string[], effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(screen.getByRole('button', { name: 'report.txt' }), {
      dataTransfer: admitted,
    })
    expect(admitted.setData).toHaveBeenCalled()
    expect(moveResource).toHaveBeenCalledTimes(1)
  })
})
