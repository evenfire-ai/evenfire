// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
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

// Pass-through spy: lets a test prove a rejection reached the session
// judgement, which an outcome of "nothing changed" cannot show by itself.
const authorityJudgements = vi.hoisted(() => ({ outcomes: [] as unknown[] }))
vi.mock('@lib/gfsSessionAuthority', async importOriginal => {
  const actual = await importOriginal<typeof import('@lib/gfsSessionAuthority')>()
  return {
    ...actual,
    handleGfsAuthorityFailure: (...args: Parameters<typeof actual.handleGfsAuthorityFailure>) => {
      const outcome = actual.handleGfsAuthorityFailure(...args)
      authorityJudgements.outcomes.push({
        captured: { scope: args[1], generation: args[2] },
        live: args[5],
        outcome,
      })
      return outcome
    },
  }
})

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

    authorityJudgements.outcomes.length = 0
    await act(async () => {
      rejectRename(new Error(failure))
      await renameOutcome
    })

    expect(await renameOutcome).toBeInstanceOf(Error)
    // The 401 was judged against the session the rename was sent under.
    expect(authorityJudgements.outcomes).toEqual([
      {
        captured: { scope: scopeA, generation: 1 },
        live: { scope: scopeB, generation: 2 },
        outcome: 'stale',
      },
    ])
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

  it('sends no tree refresh for a session that was replaced while the commit reaction ran', async () => {
    const created = childView('new-folder', 'New folder', 'directory', {
      parentResourceId: 'parent',
    })
    const listChildren = vi.fn(async () => listChildrenPage([]))
    installClerum({
      listChildren,
      createFolder: vi.fn(async () => createFolderResult('parent', created)),
    })
    let releaseReaction!: () => void
    const onCommitted = vi.fn(
      () =>
        new Promise<void>(resolve => {
          releaseReaction = resolve
        })
    )
    let ops!: ReturnType<typeof useGfsResourceOperations>
    function CommitProbe() {
      ops = useGfsResourceOperations({ onCommitted })
      return null
    }
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    // The tree keeps observing the folder listing of the session the write ran in.
    const view = (me: Me, generation: number) => (
      <AuthContext.Provider value={sessionAuth(me, generation)}>
        <QueryClientProvider client={client}>
          <TreeFolderProbe folderId="parent" scope={scopeA} generation={1} />
          <CommitProbe />
        </QueryClientProvider>
      </AuthContext.Provider>
    )
    const rendered = render(view(userA, 1))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))

    let createdFolder!: Promise<unknown>
    await act(async () => {
      createdFolder = ops.createFolder('parent', 'New folder')
    })
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
    rendered.rerender(view(userB, 2))
    await act(async () => {
      releaseReaction()
      await createdFolder
    })

    // The commit settled through its reaction; only the refresh was withheld.
    expect(onCommitted).toHaveBeenCalledWith(expect.objectContaining({ op: 'createFolder' }))
    expect(listChildren).toHaveBeenCalledTimes(1)
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

// The writes both the controller and a surface without one expose.
type Operations = Pick<
  ReturnType<typeof useGfsResourceOperations>,
  | 'createFolder'
  | 'createFile'
  | 'createFileFromPath'
  | 'replaceFile'
  | 'replaceFileFromPath'
  | 'deleteResource'
  | 'moveResource'
>
type FailingRoute = Parameters<typeof gfsRouteFailureMessage>[0]
const TOKEN = 'fixture-session-token'
const createFileRoute: FailingRoute = client =>
  client.createResource(
    { parentResourceId: 'parent', drive: 'main', name: 'a.txt', kind: 'file', encodedData: 'aGk=' },
    TOKEN
  )
const replaceFileRoute: FailingRoute = client =>
  client.replaceFile({ resourceId: 'doc', drive: 'main', encodedData: 'aGk=', ifMatch: 1 }, TOKEN)

// Every write is judged against the session it was issued under; rename has
// its own late-401 test above.
const capturedAuthorityWrites: Array<{
  ipc: string
  run: (ops: Operations) => Promise<unknown>
  route: FailingRoute
}> = [
  {
    ipc: 'createFolder',
    run: ops => ops.createFolder('parent', 'New folder'),
    route: client =>
      client.createResource(
        { parentResourceId: 'parent', drive: 'main', name: 'New folder', kind: 'directory' },
        TOKEN
      ),
  },
  {
    ipc: 'createFile',
    run: ops => ops.createFile('parent', 'a.txt', 'aGk='),
    route: createFileRoute,
  },
  {
    ipc: 'createFileFromPath',
    run: ops => ops.createFileFromPath('parent', 'a.txt', '/fixture/a.txt'),
    route: createFileRoute,
  },
  { ipc: 'replaceFile', run: ops => ops.replaceFile('doc', 'aGk=', 1), route: replaceFileRoute },
  {
    ipc: 'replaceFileFromPath',
    run: ops => ops.replaceFileFromPath('doc', '/fixture/a.txt', 1),
    route: replaceFileRoute,
  },
  {
    ipc: 'deleteResource',
    run: ops => ops.deleteResource('doc', 1),
    route: client => client.deleteResource({ resourceId: 'doc', drive: 'main', ifMatch: 1 }, TOKEN),
  },
  {
    ipc: 'moveResource',
    run: ops => ops.moveResource('doc', 'destination', 1),
    route: client =>
      client.moveResource(
        { resourceId: 'doc', drive: 'main', destinationId: 'destination', ifMatch: 1 },
        TOKEN
      ),
  },
]

describe('useGfsResourceOperations — a late 401 is judged by the session it was sent under', () => {
  for (const write of capturedAuthorityWrites)
    for (const handler of ['controller', 'no controller'] as const)
      for (const sameSession of [true, false]) {
        it(`${write.ipc} through the ${handler} handler ${
          sameSession ? 'revokes its own session' : 'keeps the session that replaced it'
        }`, async () => {
          const failure = await gfsRouteFailureMessage(write.route, 401, {
            code: 'unauthorized',
            message: 'session expired',
          })
          let mainGeneration = 1
          let rejectWrite!: (error: Error) => void
          const sent = vi.fn(
            () =>
              new Promise((_resolve, reject) => {
                rejectWrite = reject
              })
          )
          Object.defineProperty(window, 'clerum', {
            configurable: true,
            value: {
              gfs: {
                listAccessible: vi.fn(async () => listAccessiblePage([])),
                listChildren: vi.fn(async () => listChildrenPage([])),
                [write.ipc]: sent,
              },
              auth: { getSessionGeneration: vi.fn(async () => mainGeneration) },
            },
          })
          const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
          const view = (me: Me, generation: number) => (
            <AuthContext.Provider value={sessionAuth(me, generation)}>
              <QueryClientProvider client={client}>
                <FilesProbe />
                <HostProbe />
              </QueryClientProvider>
            </AuthContext.Provider>
          )
          const rendered = render(view(userA, 1))
          const ops = () => (handler === 'controller' ? filesCtrl : hostOps)

          const outcome = write.run(ops()).catch(error => error)
          await waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
          if (!sameSession) {
            mainGeneration = 2
            rendered.rerender(view(userB, 2))
          }
          await act(async () => {
            rejectWrite(new Error(failure))
            await outcome
          })

          expect(await outcome).toBeInstanceOf(Error)
          if (sameSession) {
            await waitFor(() =>
              expect(screen.getByTestId('files-access').textContent).toBe('revoked')
            )
            expect(client.getQueryData(desktopQueryKeys.gfsAccessState(scopeA, 1))).toBe('revoked')
          } else {
            // A mutation records its error only after every onError/onSettled
            // handler has resolved, however many awaits they hold, so the
            // checks below cannot run before the late 401 was judged.
            await waitFor(() =>
              expect(
                client
                  .getMutationCache()
                  .getAll()
                  .map(m => m.state.status)
              ).toEqual(['error'])
            )
            expect(client.getQueryData(desktopQueryKeys.gfsAccessState(scopeB, 2))).toBe('active')
            expect(screen.getByTestId('files-access').textContent).toBe('active')
          }
          client.clear()
        })
      }
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
