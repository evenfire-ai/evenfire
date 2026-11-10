// @vitest-environment jsdom
// R32 readiness acceptance: real sidebar P3 + Composer bind + real createFolder mutation/invalidation.
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsBrowserController } from '@hooks/domain/useGfsBrowserController'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { ComposerGfsLinkPicker } from '../ComposerGfsLinkPicker'

const auth = {
  isAuthenticated: true,
  sessionGeneration: 1,
  me: { id: 'user-1', teamId: 'team-1' },
  runtimeConfigState: { envKey: 'test' },
} as unknown as AuthContextValue
const folder = accessibleResource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Folder A', 'directory')
const key = desktopQueryKeys.gfsChildren('test:user-1:team-1', folder.resourceId, 'main', 1)
const clients: QueryClient[] = []

function Picker() {
  const controller = useGfsBrowserController({ pickerAuthorityManaged: true })
  const rootAnchorRef = useRef<HTMLElement | null>(null)
  return (
    <ComposerGfsLinkPicker
      controller={controller}
      rootAnchorRef={rootAnchorRef}
      sessionId={22}
      onInsert={() => {}}
      onSessionScope={() => {}}
      onEscapeRoot={() => {}}
    />
  )
}

function ActualCreateFolderMutation() {
  const controller = useGfsBrowserController()
  return (
    <button type="button" onClick={() => void controller.createFolder('root', 'created-by-r32')}>
      Create folder
    </button>
  )
}

function Harness({
  initialRoot,
  showSidebar = true,
  showComposer = true,
  showMutation = true,
}: {
  initialRoot?: Awaited<ReturnType<typeof listAccessiblePage>>
  showSidebar?: boolean
  showComposer?: boolean
  showMutation?: boolean
}) {
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: desktopQueryDefaults })
    if (initialRoot) {
      value.setQueryData(desktopQueryKeys.gfsAccessible('test:user-1:team-1', 'main', 1), {
        pages: [initialRoot],
        pageParams: [undefined],
      })
    }
    clients.push(value)
    return value
  })
  return (
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        {showSidebar ? (
          <FileExplorerTree onOpenFolder={() => {}} onOpenPreview={() => {}} pushToast={() => {}} />
        ) : null}
        {showComposer ? <Picker /> : null}
        {showMutation ? <ActualCreateFolderMutation /> : null}
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'clerum')
})

describe('R32 R105 mutation replacement failure', () => {
  it('starts eligible Composer root discovery while the menu is closed', async () => {
    const listAccessible = vi.fn(async () => listAccessiblePage([folder]))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })

    render(<Harness showSidebar={false} showComposer showMutation={false} />)
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
  })

  it.each([
    ['sidebar', true, false],
    ['composer', false, true],
  ] as const)(
    '%s-first in-flight root discovery is reused by the other consumer',
    async (_name, showSidebar, showComposer) => {
      let rootResolve!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
      const pendingRoot = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
        rootResolve = resolve
      })
      const listAccessible = vi.fn(() => pendingRoot)
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          auth: { getSessionGeneration: vi.fn(async () => 1) },
          gfs: {
            listAccessible,
            listChildren: vi.fn(async () => listChildrenPage([])),
            affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
          },
        },
      })

      const view = render(<Harness showSidebar={showSidebar} showComposer={showComposer} />)
      await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
      view.rerender(<Harness showSidebar showComposer />)
      await act(async () => {
        rootResolve(await listAccessiblePage([folder]))
        await Promise.resolve()
      })
      await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
      expect(listAccessible).toHaveBeenCalledTimes(1)
    }
  )

  it('shares one concurrent root refresh and withholds cached roots until that current result', async () => {
    let rootResolve!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const pendingRoot = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      rootResolve = resolve
    })
    const listAccessible = vi.fn(() => pendingRoot)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })

    // Cache seeding and the later consumer mount intentionally share one clock
    // tick. A timestamp-only freshness check would incorrectly treat the
    // pre-bind root as fresh while this required revalidation is still pending.
    const sameTick = 1_800_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(sameTick)
    render(<Harness initialRoot={await listAccessiblePage([folder])} />)
    dateNow.mockRestore()
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Expand Folder A' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Insert folder Folder A' })).toBeNull()

    await act(async () => {
      rootResolve(await listAccessiblePage([folder]))
      await Promise.resolve()
    })
    await screen.findByRole('button', { name: 'Expand Folder A' })
    await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    expect(listAccessible).toHaveBeenCalledTimes(1)
  })

  it('revalidates a completed sidebar cache for a late Composer binding before showing it', async () => {
    let freshResolve!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const pendingFresh = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      freshResolve = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(await listAccessiblePage([folder]))
      .mockReturnValueOnce(pendingFresh)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })

    const view = render(<Harness showSidebar showComposer={false} />)
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    await screen.findByRole('treeitem', { name: /Folder A/ })
    view.rerender(<Harness showSidebar showComposer />)
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('menuitem', { name: 'Insert folder Folder A' })).toBeNull()

    await act(async () => {
      freshResolve(await listAccessiblePage([folder]))
      await Promise.resolve()
    })
    await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    expect(listAccessible).toHaveBeenCalledTimes(2)
  })

  it('coalesces the eligible mutation F, exposes a retry, and does not auto-start F2', async () => {
    const cursors: Array<string | undefined> = []
    let p3Resolve!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let f1Reject!: (error: Error) => void
    const p3 = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      p3Resolve = resolve
    })
    const f1 = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>((_resolve, reject) => {
      f1Reject = reject
    })
    const listChildren = vi.fn((resourceId: string, _drive: string, cursor?: string) => {
      expect(resourceId).toBe(folder.resourceId)
      cursors.push(cursor)
      if (cursors.length === 1)
        return listChildrenPage(
          [childView('b'.repeat(32), 'Page 1.md', 'file', { parentResourceId: folder.resourceId })],
          'cursor-2'
        )
      if (cursors.length === 2)
        return listChildrenPage(
          [childView('c'.repeat(32), 'Page 2.md', 'file', { parentResourceId: folder.resourceId })],
          'cursor-3'
        )
      if (cursors.length === 3) return p3
      if (cursors.length === 4) return f1
      throw new Error('unexpected automatic full/page request ' + cursors.length)
    })
    const createFolder = vi.fn(async () => ({ resourceId: 'created-by-r32' }))
    const listAccessible = vi.fn(async () => listAccessiblePage([folder]))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          listChildren,
          createFolder,
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })

    const view = render(<Harness />)
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    const client = await waitFor(() => {
      const value = clients[0]
      if (!value) throw new Error('QueryClient not mounted')
      return value
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Folder A' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(1)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(client.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(2)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(3))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Insert folder Folder A' }))
    await waitFor(() => expect(view.container.querySelector('.composer-gfs-picker')).not.toBeNull())

    // This is the actual useMutation -> IPC success -> refreshGfs -> QueryClient invalidation path.
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(4))
    expect(cursors).toEqual([undefined, 'cursor-2', 'cursor-3', undefined])

    await act(async () => {
      f1Reject(new Error('replacement full failed'))
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await waitFor(() =>
      expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
        'replacement full failed'
      )
    )
    expect(view.container.querySelector('.composer-gfs-picker')?.textContent).not.toContain(
      'Page 1.md'
    )
    expect(view.container.querySelector('.composer-gfs-picker')?.textContent).not.toContain(
      'Page 2.md'
    )
    const sidebarLoadMore = Array.from(view.container.querySelectorAll('button')).find(
      button => button.textContent === 'Load more'
    )
    expect(sidebarLoadMore?.disabled).toBe(true)
    expect(view.container.querySelector('.composer-gfs-picker-more')).toBeNull()

    // The mutation-owned F is eligible for this post-bind debt. Its failure consumes the
    // automatic opportunity; settling the canceled physical P3 must not launch F2.
    await act(async () => {
      p3Resolve(
        await listChildrenPage([
          childView('d'.repeat(32), 'Late P3.md', 'file', { parentResourceId: folder.resourceId }),
        ])
      )
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    expect(listChildren).toHaveBeenCalledTimes(4)
    expect(cursors).toEqual([undefined, 'cursor-2', 'cursor-3', undefined])

    const retry = within(screen.getByRole('menu', { name: 'Folder A contents' })).queryByRole(
      'button',
      { name: 'Retry file listing' }
    )
    expect(
      retry,
      'failed Composer child listing must expose an actionable full Retry'
    ).not.toBeNull()
    fireEvent.click(retry!)
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(5))
    expect(cursors[4]).toBeUndefined()
  })

  it('a distinct later mutation event may start its own full request after the prior failure', async () => {
    let p3Resolve!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    const p3 = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      p3Resolve = resolve
    })
    const listChildren = vi.fn((_resourceId: string, _drive: string, cursor?: string) => {
      if (listChildren.mock.calls.length === 1)
        return listChildrenPage(
          [childView('b'.repeat(32), 'Page 1.md', 'file', { parentResourceId: folder.resourceId })],
          'cursor-2'
        )
      if (listChildren.mock.calls.length === 2)
        return listChildrenPage(
          [childView('c'.repeat(32), 'Page 2.md', 'file', { parentResourceId: folder.resourceId })],
          'cursor-3'
        )
      if (listChildren.mock.calls.length === 3) return p3
      if (listChildren.mock.calls.length === 4 && cursor === undefined)
        return Promise.reject(new Error('current full failed'))
      if (
        (listChildren.mock.calls.length === 5 || listChildren.mock.calls.length === 6) &&
        cursor === undefined
      )
        return listChildrenPage(
          [
            childView('e'.repeat(32), 'Updated after failure.md', 'file', {
              parentResourceId: folder.resourceId,
            }),
          ],
          null
        )
      throw new Error('unexpected request after distinct source update')
    })
    const createFolder = vi.fn(async () => ({ resourceId: 'created-by-r32' }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([folder])),
          listChildren,
          createFolder,
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Folder A' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(clients[0]?.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(1)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(clients[0]?.getQueryData<{ pages: unknown[] }>(key)?.pages).toHaveLength(2)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(3))
    fireEvent.mouseEnter(await screen.findByRole('menuitem', { name: 'Insert folder Folder A' }))

    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(4))
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getAllByText('current full failed').length).toBeGreaterThan(0)
    )
    expect(listChildren.mock.calls[3]?.[2]).toBeUndefined()

    await act(async () => {
      p3Resolve(
        await listChildrenPage([
          childView('d'.repeat(32), 'Late P3.md', 'file', { parentResourceId: folder.resourceId }),
        ])
      )
      for (let i = 0; i < 20; i++) await Promise.resolve()
    })
    expect(listChildren).toHaveBeenCalledTimes(4)

    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))
    await waitFor(() => expect(createFolder).toHaveBeenCalledTimes(2))
    // The sidebar's active child observer refreshes for the mutation, then the
    // Composer panel remounts after its parent projection returns and performs
    // the R54-required post-bind reopen freshness read. They settle sequentially,
    // so Query cannot deduplicate them as one in-flight operation.
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(6))
    expect(listChildren.mock.calls[4]?.[2]).toBeUndefined()
    expect(listChildren.mock.calls[5]?.[2]).toBeUndefined()
    await waitFor(() =>
      expect(document.querySelector('.composer-gfs-picker')?.textContent).toContain(
        'Updated after failure.md'
      )
    )
  })

  it('keeps full Retry in keyboard navigation and restores focus after successful recovery', async () => {
    const listChildren = vi.fn((_resourceId: string, _drive: string, cursor?: string) => {
      if (listChildren.mock.calls.length === 1) {
        return listChildrenPage(
          [
            childView('b'.repeat(32), 'Readable.md', 'file', {
              parentResourceId: folder.resourceId,
            }),
          ],
          'cursor-2'
        )
      }
      if (listChildren.mock.calls.length === 2)
        return Promise.reject(new Error('forward page failed'))
      if (listChildren.mock.calls.length === 3 && cursor === undefined) {
        return listChildrenPage([
          childView('c'.repeat(32), 'Recovered.md', 'file', {
            parentResourceId: folder.resourceId,
          }),
        ])
      }
      throw new Error('unexpected child request')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([folder])),
          listChildren,
          affordances: vi.fn(async () => delegationAffordances(new Set(['read']), false)),
        },
      },
    })

    render(<Harness showSidebar={false} />)
    const folderRow = await screen.findByRole('menuitem', { name: 'Insert folder Folder A' })
    fireEvent.mouseEnter(folderRow)
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))
    await screen.findByRole('menuitem', { name: 'Insert link to Readable.md' })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    const retry = await screen.findByRole('button', { name: 'Retry file listing' })
    expect(screen.getByRole('menuitem', { name: 'Insert link to Readable.md' })).not.toBeNull()

    const childMenu = screen.getByRole('menu', { name: 'Folder A contents' })
    const readableRow = within(childMenu).getByRole('menuitem', {
      name: 'Insert link to Readable.md',
    })
    readableRow.focus()
    fireEvent.keyDown(readableRow, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(retry)

    fireEvent.click(retry)
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(3))
    const recoveredRow = await within(childMenu).findByRole('menuitem', {
      name: 'Insert link to Recovered.md',
    })
    expect(childMenu.querySelector('button[aria-label="Retry file listing"]')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(recoveredRow))
    expect(screen.queryByText('forward page failed')).toBeNull()
  })
})
