// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesResult,
  childView,
  gfsRouteFailureMessage,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { delegationAffordances } from '../../../../src/gfs/delegation'
import { FilesPage } from '../FilesPage'

const SESSION_SCOPE = ':user-a:team-a'
const SESSION_TOKEN = 'fixture-session-token'
const ACCESSIBLE_KEY = desktopQueryKeys.gfsAccessible(SESSION_SCOPE, 'main')
const authValue = {
  isAuthenticated: true,
  me: {
    id: 'user-a',
    email: 'a@example.test',
    name: 'User A',
    picture: null,
    teamId: 'team-a',
    teamName: 'Team A',
    role: 'member' as const,
  },
  runtimeConfigState: null,
} as unknown as AuthContextValue

const testQueryClients: QueryClient[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function installGfsBridge(gfs: Partial<typeof window.clerum.gfs>) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve: vi.fn(),
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        affordances: vi.fn(async () => ({
          held: [],
          canDelegate: false,
          grantableBits: [],
          canCreateShare: false,
        })),
        ...gfs,
      },
    },
  })
}

function renderFilesPage(queryClient: QueryClient, pendingGfsUri?: string) {
  if (!testQueryClients.includes(queryClient)) testQueryClients.push(queryClient)
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <FilesPage pendingGfsUri={pendingGfsUri} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  testQueryClients.forEach(queryClient => queryClient.clear())
  testQueryClients.length = 0
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('FilesPage authority-gated loading presentation', () => {
  it('shows loading while a pre-epoch cached empty folder is refetched after authority failure', async () => {
    const rootPage = await listAccessiblePage([
      accessibleResource('folder-a', 'Folder A', 'directory', {
        sources: ['grant'],
        permissions: ['read'],
        coversDescendants: true,
      }),
    ])
    const ancestorPage = await listChildrenPage([
      childView('folder-b', 'Folder B', 'directory', { readable: true }),
    ])
    const emptyChildrenPage = await listChildrenPage([])
    const discoveryRequest = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
    const childrenRefresh = deferred<typeof emptyChildrenPage>()
    const discoveryFailure = await gfsRouteFailureMessage(
      client => client.listAccessible(SESSION_TOKEN, { drive: 'main' }),
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      { 'retry-after': '7' }
    )
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(rootPage)
      .mockImplementationOnce(() => discoveryRequest.promise)
    let holdFolderBRefresh = false
    const listChildren = vi.fn((resourceId: string) => {
      if (resourceId === 'folder-a') return Promise.resolve(ancestorPage)
      return holdFolderBRefresh ? childrenRefresh.promise : Promise.resolve(emptyChildrenPage)
    })
    const resolvedFolderA = {
      ...(await resolveResource(resolvedDirectory('folder-a', 'Folder A'))),
      pathCache: null,
    }
    const resolvedFolderB = {
      ...(await resolveResource(
        resolvedDirectory('folder-b', 'Folder B', { parentResourceId: 'folder-a' })
      )),
      pathCache: null,
    }
    const resolve = vi.fn(async (uri: string) =>
      uri.endsWith('/folder-b') ? resolvedFolderB : resolvedFolderA
    )
    installGfsBridge({ listAccessible, listChildren, resolve })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = renderFilesPage(queryClient)
    await screen.findByRole('button', { name: 'Open Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))
    await screen.findByText('This folder is empty')

    const folderBKey = desktopQueryKeys.gfsChildren(SESSION_SCOPE, 'folder-b', 'main')
    await waitFor(() => {
      expect(queryClient.getQueryState(folderBKey)?.status).toBe('success')
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('idle')
      expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })
    })
    const cachedChildrenUpdatedAt = queryClient.getQueryState(folderBKey)?.dataUpdatedAt
    expect(cachedChildrenUpdatedAt).toBeGreaterThan(0)

    // Retire the child observer while retaining its cache, then start a new
    // authority epoch at the ancestor so the target folder stays pre-epoch.
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    firstMount.unmount()
    await waitFor(() => expect(Date.now()).toBeGreaterThan(cachedChildrenUpdatedAt ?? 0))

    renderFilesPage(queryClient, 'gfs://main/folder-b')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => discoveryRequest.reject(new Error(discoveryFailure)))
    await waitFor(() => expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.status).toBe('error'))
    expect(screen.getByText('This folder is empty')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    // Returning through the ancestor breadcrumb rebinds the cached child query.
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    holdFolderBRefresh = true
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))

    await waitFor(() => {
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('fetching')
      expect(queryClient.getQueryState(folderBKey)?.dataUpdatedAt).toBe(cachedChildrenUpdatedAt)
      expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })
    })

    // The old empty result is defined but withheld by this authority epoch; its
    // active replacement must not be presented as an authorized empty listing.
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => childrenRefresh.resolve(emptyChildrenPage))

    expect(await screen.findByText('This folder is empty')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('preserves a cached-empty folder when root authority settles before its refetch', async () => {
    const rootPage = await listAccessiblePage([
      accessibleResource('folder-a', 'Folder A', 'directory', {
        sources: ['grant'],
        permissions: ['read'],
        coversDescendants: true,
      }),
    ])
    const ancestorPage = await listChildrenPage([
      childView('folder-b', 'Folder B', 'directory', { readable: true }),
    ])
    const emptyChildrenPage = await listChildrenPage([])
    const discoveryRequest = deferred<typeof rootPage>()
    const childrenRefresh = deferred<typeof emptyChildrenPage>()
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(rootPage)
      .mockImplementationOnce(() => discoveryRequest.promise)
    let holdFolderBRefresh = false
    const listChildren = vi.fn((resourceId: string) => {
      if (resourceId === 'folder-a') return Promise.resolve(ancestorPage)
      return holdFolderBRefresh ? childrenRefresh.promise : Promise.resolve(emptyChildrenPage)
    })
    const resolvedFolderA = {
      ...(await resolveResource(resolvedDirectory('folder-a', 'Folder A'))),
      pathCache: null,
    }
    const resolvedFolderB = {
      ...(await resolveResource(
        resolvedDirectory('folder-b', 'Folder B', { parentResourceId: 'folder-a' })
      )),
      pathCache: null,
    }
    const resolve = vi.fn(async (uri: string) =>
      uri.endsWith('/folder-b') ? resolvedFolderB : resolvedFolderA
    )
    installGfsBridge({ listAccessible, listChildren, resolve })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = renderFilesPage(queryClient)
    await screen.findByRole('button', { name: 'Open Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))
    await screen.findByText('This folder is empty')

    const folderBKey = desktopQueryKeys.gfsChildren(SESSION_SCOPE, 'folder-b', 'main')
    await waitFor(() => {
      expect(queryClient.getQueryState(folderBKey)?.status).toBe('success')
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('idle')
      expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })
    })
    const cachedChildrenUpdatedAt = queryClient.getQueryState(folderBKey)?.dataUpdatedAt
    expect(cachedChildrenUpdatedAt).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    firstMount.unmount()
    await waitFor(() => expect(Date.now()).toBeGreaterThan(cachedChildrenUpdatedAt ?? 0))
    const view = renderFilesPage(queryClient, 'gfs://main/folder-b')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => discoveryRequest.resolve(rootPage))

    expect(await screen.findByText('This folder is empty')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    // Authority is now current. Revisiting Folder B starts the cached child
    // refresh, but that reusable result must continue to render as empty.
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    holdFolderBRefresh = true
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))

    await waitFor(() => {
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('fetching')
      expect(queryClient.getQueryState(folderBKey)?.dataUpdatedAt).toBe(cachedChildrenUpdatedAt)
      expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })
    })

    const emptyState = screen.getByText('This folder is empty')
    expect(view.container.contains(emptyState)).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => childrenRefresh.resolve(emptyChildrenPage))

    expect(screen.getByText('This folder is empty')).toBe(emptyState)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps a selected file busy while the real controller revalidates authority', async () => {
    const accessiblePage = await listAccessiblePage([
      accessibleResource('report', 'Report.pdf', 'file', {
        sources: ['grant'],
        permissions: ['read', 'manage_acl'],
      }),
    ])
    const nextAccessiblePage = await listAccessiblePage([
      accessibleResource('report', 'Report.pdf', 'file', {
        sources: ['grant'],
        permissions: ['read', 'manage_acl'],
      }),
    ])
    const discoveryRequest = deferred<typeof nextAccessiblePage>()
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(accessiblePage)
      .mockImplementationOnce(() => discoveryRequest.promise)
    const held = await affordancesResult(heldAffordances(['read', 'manage_acl']))
    const positiveAffordances = delegationAffordances(new Set(held.held), held.isOperator)
    installGfsBridge({
      listAccessible,
      resolve: vi.fn(async () => ({
        ...(await resolveResource(resolvedFile('report', 'Report.pdf'))),
        pathCache: null,
      })),
      listChildren: vi.fn(async () => listChildrenPage([])),
      affordances: vi.fn(async () => positiveAffordances),
      listGrants: vi.fn(async () => grantsListPage([])),
      listShares: vi.fn(async () => sharesListPage([])),
    })
    Object.assign(window.clerum, {
      agents: { listMine: vi.fn(async () => []) },
      team: { directory: vi.fn(async () => ({ currentTeamId: 'team-a', items: [] })) },
    })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    renderFilesPage(queryClient)
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await screen.findByRole('button', { name: 'Share Report.pdf' })
    fireEvent.click(screen.getByRole('button', { name: 'Share Report.pdf' }))
    await screen.findByRole('dialog', { name: 'Share file Report.pdf' })
    expect(screen.getByRole('heading', { name: 'Report.pdf' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      void queryClient.resetQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Report.pdf' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => discoveryRequest.resolve(nextAccessiblePage))

    expect(await screen.findByRole('heading', { name: 'Report.pdf' })).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })
})
