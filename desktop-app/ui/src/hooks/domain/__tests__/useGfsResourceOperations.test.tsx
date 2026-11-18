// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  affordancesResult,
  childView,
  createFolderResult,
  gfsRouteFailureMessage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  moveResourceReceipt,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { publishGfsOpenLocation, readGfsOpenLocations } from '@/lib/gfsOpenLocations'
import { desktopQueryKeys } from '../queryKeys'
import { useGfsBrowserController } from '../useGfsBrowserController'
import { useGfsResourceOperations } from '../useGfsResourceOperations'

type Me = NonNullable<AuthContextValue['me']>

const userA: Me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member',
}
const userB: Me = { ...userA, teamId: 'team-b', teamName: 'Team B' }
const scopeA = ':user-a:team-a'
const scopeB = ':user-a:team-b'

// The operations hook and the controller read only these four session fields.
function sessionAuth(me: Me | null, sessionGeneration: number | null): AuthContextValue {
  return {
    isAuthenticated: Boolean(me),
    me,
    runtimeConfigState: null,
    sessionGeneration,
  } as unknown as AuthContextValue
}

let filesCtrl: ReturnType<typeof useGfsBrowserController>
function FilesProbe() {
  filesCtrl = useGfsBrowserController()
  return (
    <>
      <div data-testid="files-current">{filesCtrl.current?.resourceId ?? 'none'}</div>
      <div data-testid="files-access">{filesCtrl.accessState}</div>
      <div data-testid="files-name">{filesCtrl.current?.name ?? 'none'}</div>
    </>
  )
}

let hostOps: ReturnType<typeof useGfsResourceOperations>
function HostProbe() {
  hostOps = useGfsResourceOperations()
  return null
}

/** A cache observer of one folder listing, keyed the way the sidebar tree keys it. */
function TreeFolderProbe({
  folderId,
  scope,
  generation,
}: {
  folderId: string
  scope: string
  generation: number
}) {
  const listing = useInfiniteQuery({
    queryKey: desktopQueryKeys.gfsChildren(scope, folderId, 'main', generation),
    queryFn: ({ pageParam }) => window.clerum.gfs.listChildren(folderId, 'main', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const names = (listing.data?.pages ?? []).flatMap(page => page.items.map(item => item.name))
  return <div data-testid="tree-children">{names.join(',')}</div>
}

function installClerum(gfs: Record<string, unknown>, generation = 1) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs,
      auth: { getSessionGeneration: vi.fn(async () => generation) },
    },
  })
}

afterEach(() => {
  cleanup()
})

describe('useGfsResourceOperations', () => {
  it('keeps the replacement session and its open folder after a late 401 from the previous team', async () => {
    const failure = await gfsRouteFailureMessage(
      client =>
        client.renameResource(
          { resourceId: 'folder-a', drive: 'main', newName: 'Renamed', ifMatch: 1 },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'session expired' }
    )
    const folderA = await resolveResource(resolvedDirectory('folder-a', 'Folder A'))
    const folderB = await resolveResource(resolvedDirectory('folder-b', 'Folder B'))
    let rejectRename!: (error: Error) => void
    const renameResource = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectRename = reject
        })
    )
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([])),
      listChildren: vi.fn(async () => listChildrenPage([])),
      resolve: vi.fn(async (uri: string) => (uri.endsWith('folder-b') ? folderB : folderA)),
      affordances: vi.fn(async () => affordancesResult(heldAffordances(['read', 'write']))),
      renameResource,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (me: Me, generation: number) => (
      <AuthContext.Provider value={sessionAuth(me, generation)}>
        <QueryClientProvider client={client}>
          <FilesProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const rendered = render(view(userA, 1))
    await act(async () => {
      await filesCtrl.openUri('gfs://main/folder-a')
    })
    expect(screen.getByTestId('files-current').textContent).toBe('folder-a')

    const renameOutcome = filesCtrl.renameResource('folder-a', 'Renamed', 1).catch(error => error)
    await waitFor(() => expect(renameResource).toHaveBeenCalledTimes(1))

    rendered.rerender(view(userB, 2))
    await act(async () => {
      await filesCtrl.openUri('gfs://main/folder-b')
    })
    expect(screen.getByTestId('files-current').textContent).toBe('folder-b')

    await act(async () => {
      rejectRename(new Error(failure))
      await renameOutcome
    })

    expect(await renameOutcome).toBeInstanceOf(Error)
    expect(screen.getByTestId('files-access').textContent).toBe('active')
    expect(screen.getByTestId('files-current').textContent).toBe('folder-b')
    expect(client.getQueryData(desktopQueryKeys.gfsAccessState(scopeB, 2))).toBe('active')
    client.clear()
  })

  it('patches the open location before the shared refresh, and settles only after the refresh', async () => {
    const file = await resolveResource(resolvedFile('doc', 'Report.md'))
    const receipt = await renameResourceResult('doc', 'Renamed.md', 2)
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([])),
      resolve: vi.fn(async () => file),
      affordances: vi.fn(async () => affordancesResult(heldAffordances(['read', 'write']))),
      renameResource: vi.fn(async () => receipt),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={sessionAuth(userA, 1)}>
        <QueryClientProvider client={client}>
          <FilesProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    await act(async () => {
      await filesCtrl.openUri('gfs://main/doc')
    })
    expect(screen.getByTestId('files-name').textContent).toBe('Report.md')

    const events: string[] = []
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })
    const invalidate = client.invalidateQueries.bind(client)
    vi.spyOn(client, 'invalidateQueries').mockImplementation(async (filters, options) => {
      const sessionWideRefresh =
        filters?.exact !== true &&
        JSON.stringify(filters?.queryKey) === JSON.stringify(desktopQueryKeys.gfsRoot)
      if (sessionWideRefresh) {
        events.push('refresh-started')
        await refreshGate
        events.push('refresh-released')
      }
      return invalidate(filters, options)
    })

    let renamed!: Promise<unknown>
    await act(async () => {
      renamed = filesCtrl.renameResource('doc', 'Renamed.md', 1).then(() => {
        events.push('resolved')
      })
    })
    await waitFor(() => expect(events).toEqual(['refresh-started']))
    expect(screen.getByTestId('files-name').textContent).toBe('Renamed.md')

    await act(async () => {
      releaseRefresh()
      await renamed
    })
    expect(events).toEqual(['refresh-started', 'refresh-released', 'resolved'])
    client.clear()
  })

  it('refreshes the tree listing after a mutation from an instance with no controller', async () => {
    const created = childView('new-folder', 'New folder', 'directory', {
      parentResourceId: 'parent',
    })
    const before = await listChildrenPage([])
    const after = await listChildrenPage([created])
    const listChildren = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after)
    installClerum({
      listChildren,
      createFolder: vi.fn(async () => createFolderResult('parent', created)),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={sessionAuth(userA, 1)}>
        <QueryClientProvider client={client}>
          <TreeFolderProbe folderId="parent" scope={scopeA} generation={1} />
          <HostProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('tree-children').textContent).toBe('')

    await act(async () => {
      await hostOps.createFolder('parent', 'New folder')
    })

    await waitFor(() => expect(screen.getByTestId('tree-children').textContent).toBe('New folder'))
    client.clear()
  })

  it('relocates the shared open-location registry after a move from an instance with no controller', async () => {
    const receipt = await moveResourceReceipt('moved', 'new-parent', 5)
    installClerum({ moveResource: vi.fn(async () => receipt) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    publishGfsOpenLocation(client, scopeA, 'files-mount', {
      resourceId: 'moved',
      ancestorResourceIds: ['old-parent'],
    })
    render(
      <AuthContext.Provider value={sessionAuth(userA, 1)}>
        <QueryClientProvider client={client}>
          <HostProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )

    await act(async () => {
      await hostOps.moveResource('moved', 'new-parent', 4, undefined, 'old-parent')
    })

    expect(readGfsOpenLocations(client, scopeA)).toEqual([
      { resourceId: 'moved', ancestorResourceIds: ['new-parent'] },
    ])
    client.clear()
  })

  it('revokes the shared access flag from an instance with no controller, observed by a mounted controller', async () => {
    const failure = await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: 'parent', drive: 'main', name: 'New folder', kind: 'directory' },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'session expired' }
    )
    installClerum({
      listAccessible: vi.fn(async () => listAccessiblePage([])),
      createFolder: vi.fn(async () => {
        throw new Error(failure)
      }),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={sessionAuth(userA, 1)}>
        <QueryClientProvider client={client}>
          <FilesProbe />
          <HostProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    expect(screen.getByTestId('files-access').textContent).toBe('active')

    await act(async () => {
      await expect(hostOps.createFolder('parent', 'New folder')).rejects.toThrow('401')
    })

    expect(client.getQueryData(desktopQueryKeys.gfsAccessState(scopeA, 1))).toBe('revoked')
    await waitFor(() => expect(screen.getByTestId('files-access').textContent).toBe('revoked'))
    client.clear()
  })
})

describe('useGfsBrowserController readAccessState', () => {
  function mount(generation: number | null, me: Me | null = userA) {
    installClerum({ listAccessible: vi.fn(async () => listAccessiblePage([])) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AuthContext.Provider value={sessionAuth(me, generation)}>
        <QueryClientProvider client={client}>
          <FilesProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    return client
  }

  it('reads a missing access flag as revoked', () => {
    const client = mount(1)
    expect(filesCtrl.readAccessState()).toBe('active')
    client.removeQueries({ queryKey: desktopQueryKeys.gfsAccessState(scopeA, 1), exact: true })
    expect(filesCtrl.readAccessState()).toBe('revoked')
    client.clear()
  })

  it('reads a session with no scope as revoked, not the shared anonymous entry', () => {
    const client = mount(1, null)
    expect(client.getQueryData(desktopQueryKeys.gfsAccessState('anonymous', 1))).toBe('active')
    expect(filesCtrl.readAccessState()).toBe('revoked')
    client.clear()
  })

  it('reads an unknown session generation as revoked', () => {
    const client = mount(null)
    expect(client.getQueryData(desktopQueryKeys.gfsAccessState(scopeA, null))).toBe('active')
    expect(filesCtrl.readAccessState()).toBe('revoked')
    client.clear()
  })

  it('sees a revocation written to the cache before the controller re-renders', () => {
    const client = mount(1)
    const rendered = filesCtrl
    client.setQueryData(desktopQueryKeys.gfsAccessState(scopeA, 1), 'revoked')
    expect(rendered.accessState).toBe('active')
    expect(rendered.readAccessState()).toBe('revoked')
    client.clear()
  })
})
