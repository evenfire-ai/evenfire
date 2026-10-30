// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesFailureMessage,
  affordancesResult,
  childView,
  gfsRouteFailureMessage,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { delegationAffordances } from '../../../../src/gfs/delegation'
import { FilesPage } from '../FilesPage'

/**
 * The controller/page seam, which nothing else covers.
 *
 * `FilesPage.test.tsx` mocks `useGfsBrowserController` at module level, so
 * every test in it renders the page against a hand-written controller object.
 * That proves the page renders a `discoveryFailure` it was handed, and the
 * controller suite proves the controller emits one — but nothing proves the
 * two are the same field with the same shape. Rename it on one side and both
 * suites stay green while the user still waits on "Loading files…" forever,
 * which is the exact bug this PR exists to fix.
 *
 * This file therefore renders `FilesPage` against the REAL controller and
 * fakes only `window.clerum.gfs`, the process boundary.
 */

const RATE_LIMITED_IPC_MESSAGE =
  "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
  'Too Many Requests retryAfterSeconds=7'

// The controller reads these four authority fields — isAuthenticated, me,
// runtimeConfigState and sessionGeneration — and FilesPage reads none. The cast
// keeps the double narrow rather than restating forty unrelated auth-screen
// fields that no code under test touches.
const authValue = {
  isAuthenticated: true,
  sessionGeneration: 1,
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
const ACCESSIBLE_KEY = desktopQueryKeys.gfsAccessible(':user-a:team-a', 'main')
const GFS_ACCESSIBLE = 'fixture-session-token'

function installGfsBridge(
  gfs: Partial<typeof window.clerum.gfs>,
  extras: Record<string, unknown> = {}
) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      ...extras,
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

function renderFilesPage(queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })) {
  if (!testQueryClients.includes(queryClient)) testQueryClients.push(queryClient)
  return {
    ...render(
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={queryClient}>
          <FilesPage />
        </QueryClientProvider>
      </AuthContext.Provider>
    ),
    queryClient,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('FilesPage against the real GFS browser controller', () => {
  afterEach(() => {
    cleanup()
    testQueryClients.forEach(queryClient => queryClient.clear())
    testQueryClients.length = 0
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.restoreAllMocks()
  })

  it('turns a rate-limited discovery rejection into a retryable card, not an endless loader', async () => {
    const listAccessible = vi.fn(async () => {
      throw new Error(RATE_LIMITED_IPC_MESSAGE)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    renderFilesPage()

    await waitFor(() => {
      // The reported symptom, asserted first so it is the failure reported
      // when the seam is broken.
      expect(screen.queryByText('Loading files…')).toBeNull()
      // The raw IPC string must never reach the user.
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
      // The route assertion: the controller's verdict reached the card with
      // its retry hint intact, across every hop this PR touches.
      expect(screen.getByTestId('gfs-discovery-retry-seconds').textContent).toBe('7')
    })

    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()

    // Liveness witness: discovery really ran through the real controller, so
    // the absence assertions above describe a rendered failure rather than a
    // page that never got started.
    expect(listAccessible).toHaveBeenCalledTimes(1)
  })

  it('spends a second request only when the user presses the card’s own retry', async () => {
    // The test above asserts the button EXISTS. That leaves the other half of
    // the seam uncovered: rename `retryDiscovery` and both this file and the
    // module-mocked suite stay green while the button does nothing at all —
    // the same leak the file was written to close for `discoveryFailure`.
    //
    // The fixture names no window on purpose. A 429 that carries
    // `retryAfterSeconds` disables the button for exactly that long, and the
    // point here is the wiring, not the countdown the sibling test pins.
    const listAccessible = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'gfs:listAccessible': Error: 429 Too Many Requests: " +
          'Too Many Requests'
      )
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    renderFilesPage()

    const retry = await screen.findByRole('button', { name: /retry file listing/i })
    // Witness that this is the settled-failure card and not some other button:
    // an unparseable window leaves no countdown to show, so the control is
    // live immediately.
    expect((retry as HTMLButtonElement).disabled).toBe(false)
    expect(listAccessible).toHaveBeenCalledTimes(1)

    fireEvent.click(retry)

    // The route assertion: the click reached the real controller's refetch.
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
  })

  it('keeps the original root empty-state node during an empty-result background refetch', async () => {
    const emptyPage = await listAccessiblePage([])
    let resolveInitial!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const initialPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveInitial = resolve
    })
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockImplementationOnce(() => initialPage)
      .mockImplementationOnce(() => refetchPage)

    installGfsBridge({ listAccessible })

    const { queryClient } = renderFilesPage()
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(1)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveInitial(emptyPage)
    })

    const emptyState = await screen.findByText('No shared files yet')

    expect(browser.getAttribute('aria-busy')).toBe('false')

    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })

    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    // This is the primary regression assertion and intentionally precedes the
    // spinner and busy checks so T3 identifies the lost original node.
    expect(emptyState.isConnected).toBe(true)
    expect(screen.getByText('No shared files yet')).toBe(emptyState)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      resolveRefetch(emptyPage)
    })

    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps the root empty-state node during the production focus refetch bridge', async () => {
    const emptyPage = await listAccessiblePage([])
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => refetchPage)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { queryClient } = renderFilesPage()
    const emptyState = await screen.findByText('No shared files yet')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })

    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })

    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    expect(emptyState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      resolveRefetch(emptyPage)
    })

    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps root rows mounted during a cached non-empty background refetch', async () => {
    const initialPage = await listAccessiblePage([
      accessibleResource('brief', 'Brief.md', 'file', {
        sources: ['grant'],
        permissions: ['read'],
      }),
    ])
    const refreshedPage = await listAccessiblePage([
      accessibleResource('brief', 'Brief.md', 'file', {
        sources: ['grant'],
        permissions: ['read'],
        version: 2,
      }),
    ])
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(initialPage)
      .mockImplementationOnce(() => refetchPage)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { queryClient } = renderFilesPage()
    const row = await screen.findByRole('button', { name: 'Open Brief.md' })
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    expect(browser.getAttribute('aria-busy')).toBe('false')

    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    expect(row.isConnected).toBe(true)
    expect(screen.getByRole('button', { name: 'Open Brief.md' })).toBe(row)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      resolveRefetch(refreshedPage)
    })

    expect(screen.getByRole('button', { name: 'Open Brief.md' })).toBe(row)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps paginated root rows stable and exposes only the Load more progress during fetch', async () => {
    const initialPage = await listAccessiblePage(
      [
        accessibleResource('brief', 'Brief.md', 'file', {
          sources: ['grant'],
          permissions: ['read'],
        }),
      ],
      'cursor-page-2'
    )
    const failureMessage = await gfsRouteFailureMessage(
      client => client.listAccessible(GFS_ACCESSIBLE, { drive: 'main', cursor: 'cursor-page-2' }),
      503,
      { code: 'upstream_unavailable', message: 'Next file page is temporarily unavailable' }
    )
    let rejectNextPage!: (error: Error) => void
    const nextPage = new Promise<never>((_resolve, reject) => {
      rejectNextPage = reject
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(initialPage)
      .mockImplementationOnce(() => nextPage)
    installGfsBridge({ listAccessible })

    const { queryClient } = renderFilesPage()

    const row = await screen.findByRole('button', { name: 'Open Brief.md' })
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const loadMore = screen.getByRole('button', { name: 'Load more' }) as HTMLButtonElement
    expect(browser.getAttribute('aria-busy')).toBe('false')
    expect(loadMore.getAttribute('aria-busy')).toBeNull()

    fireEvent.click(loadMore)
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
      expect(loadMore.getAttribute('aria-busy')).toBe('true')
    })

    expect(row.isConnected).toBe(true)
    expect(screen.getByRole('button', { name: 'Open Brief.md' })).toBe(row)
    expect(screen.getByRole('button', { name: 'Load more' })).toBe(loadMore)
    expect(loadMore.disabled).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      rejectNextPage(new Error(failureMessage))
    })

    expect(await screen.findByText(/Next file page is temporarily unavailable/)).toBeTruthy()
    expect(row.isConnected).toBe(true)
    expect(screen.getByRole('button', { name: 'Open Brief.md' })).toBe(row)
    expect(screen.getByRole('button', { name: 'Load more' })).toBe(loadMore)
    expect(loadMore.getAttribute('aria-busy')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('replaces the root empty state with authorized rows only after a refetch succeeds', async () => {
    const emptyPage = await listAccessiblePage([])
    const populatedPage = await listAccessiblePage([
      accessibleResource('brief', 'Brief.md', 'file', {
        sources: ['grant'],
        permissions: ['read'],
      }),
    ])
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => refetchPage)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { queryClient } = renderFilesPage()
    const emptyState = await screen.findByText('No shared files yet')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))

    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      resolveRefetch(populatedPage)
    })

    expect(await screen.findByRole('button', { name: 'Open Brief.md' })).toBeTruthy()
    expect(emptyState.isConnected).toBe(false)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps cached-empty folder children during refetch and loads an uncached folder initially', async () => {
    const foldersPage = await listAccessiblePage([
      accessibleResource('folder-a', 'Folder A', 'directory', {
        sources: ['grant'],
        permissions: ['read'],
        coversDescendants: true,
      }),
      accessibleResource('folder-b', 'Folder B', 'directory', {
        sources: ['grant'],
        permissions: ['read'],
        coversDescendants: true,
      }),
    ])
    const emptyChildrenPage = await listChildrenPage([])
    let resolveInitialChildren!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let resolveRefreshChildren!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let resolveFocusChildren!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let resolveFolderBChildren!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    const initialChildren = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      resolveInitialChildren = resolve
    })
    const refreshedChildren = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      resolveRefreshChildren = resolve
    })
    const focusedChildren = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      resolveFocusChildren = resolve
    })
    const newFolderChildren = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      resolveFolderBChildren = resolve
    })
    const childCalls = new Map<string, number>()
    const listChildren = vi.fn((resourceId: string) => {
      const count = (childCalls.get(resourceId) ?? 0) + 1
      childCalls.set(resourceId, count)
      if (resourceId === 'folder-a' && count === 1) return initialChildren
      if (resourceId === 'folder-a' && count === 2) return refreshedChildren
      if (resourceId === 'folder-a' && count === 3) return focusedChildren
      if (resourceId === 'folder-b') return newFolderChildren
      return Promise.resolve(emptyChildrenPage)
    })
    const listAccessible = vi.fn(async () => foldersPage)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          listChildren,
          resolve: vi.fn(),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { queryClient } = renderFilesPage()
    await screen.findByRole('button', { name: 'Open Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const folderAKey = desktopQueryKeys.gfsChildren(':user-a:team-a', 'folder-a', 'main')

    await waitFor(() => {
      expect(listChildren).toHaveBeenCalledTimes(1)
      expect(queryClient.getQueryState(folderAKey)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveInitialChildren(emptyChildrenPage)
    })
    const emptyFolderState = await screen.findByText('This folder is empty')
    expect(browser.getAttribute('aria-busy')).toBe('false')

    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: folderAKey })
    })
    await waitFor(() => {
      expect(listChildren).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(folderAKey)?.fetchStatus).toBe('fetching')
    })

    expect(emptyFolderState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      resolveRefreshChildren(emptyChildrenPage)
    })
    expect(emptyFolderState.isConnected).toBe(true)

    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => {
      expect(listChildren).toHaveBeenCalledTimes(3)
      expect(queryClient.getQueryState(folderAKey)?.fetchStatus).toBe('fetching')
    })
    expect(emptyFolderState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')
    await act(async () => resolveFocusChildren(emptyChildrenPage))
    expect(emptyFolderState.isConnected).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Shared with me' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))
    const folderBKey = desktopQueryKeys.gfsChildren(':user-a:team-a', 'folder-b', 'main')
    await waitFor(() => {
      expect(listChildren).toHaveBeenCalledTimes(4)
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByText('This folder is empty')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveFolderBChildren(emptyChildrenPage)
    })
    expect(await screen.findByText('This folder is empty')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('gives a settled producer-backed refetch error precedence, then recovers through Retry', async () => {
    const emptyPage = await listAccessiblePage([])
    const failureMessage = await gfsRouteFailureMessage(
      client => client.listAccessible(GFS_ACCESSIBLE, { drive: 'main' }),
      503,
      { code: 'upstream_unavailable', message: 'File listing is temporarily unavailable' }
    )
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockRejectedValueOnce(new Error(failureMessage))
      .mockResolvedValueOnce(emptyPage)
    installGfsBridge({ listAccessible })

    const { queryClient } = renderFilesPage()
    const emptyState = await screen.findByText('No shared files yet')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })

    const retry = await screen.findByRole('button', { name: /retry file listing/i })
    expect(emptyState.isConnected).toBe(false)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    fireEvent.click(retry)
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('shows initial loading after the active query cache is reset', async () => {
    const emptyPage = await listAccessiblePage([])
    let resolveReset!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const resetPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveReset = resolve
    })
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => resetPage)
    installGfsBridge({ listAccessible })

    const { queryClient } = renderFilesPage()
    const originalEmptyState = await screen.findByText('No shared files yet')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    expect(browser.getAttribute('aria-busy')).toBe('false')

    act(() => {
      void queryClient.resetQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    expect(originalEmptyState.isConnected).toBe(false)
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveReset(emptyPage)
    })
    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps initial loading while offline and cached-empty content during a paused refetch', async () => {
    const emptyPage = await listAccessiblePage([])
    let resolveInitial!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    let resolveRefetch!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const initialPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveInitial = resolve
    })
    const refetchPage = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveRefetch = resolve
    })
    const listAccessible = vi
      .fn()
      .mockImplementationOnce(() => initialPage)
      .mockImplementationOnce(() => refetchPage)
    installGfsBridge({ listAccessible })
    onlineManager.setOnline(false)

    const { queryClient } = renderFilesPage()
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('paused')
    })
    expect(listAccessible).not.toHaveBeenCalled()
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      onlineManager.setOnline(true)
    })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    await act(async () => resolveInitial(emptyPage))
    const emptyState = await screen.findByText('No shared files yet')
    expect(browser.getAttribute('aria-busy')).toBe('false')

    onlineManager.setOnline(false)
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('paused')
    })
    expect(listAccessible).toHaveBeenCalledTimes(1)
    expect(emptyState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => {
      onlineManager.setOnline(true)
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(emptyState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => resolveRefetch(emptyPage))
    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('withholds a cached empty root until remount authority validation succeeds', async () => {
    const emptyPage = await listAccessiblePage([])
    const discovery = deferred<typeof emptyPage>()
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => discovery.promise)
    installGfsBridge({ listAccessible })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = renderFilesPage(queryClient)
    const firstEmptyState = await screen.findByText('No shared files yet')
    const dataUpdatedAt = queryClient.getQueryState(ACCESSIBLE_KEY)?.dataUpdatedAt ?? 0
    firstMount.unmount()
    expect(firstEmptyState.isConnected).toBe(false)

    await waitFor(() => expect(Date.now()).toBeGreaterThan(dataUpdatedAt))
    renderFilesPage(queryClient)

    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.data).toMatchObject({
      pages: [{ items: [] }],
    })
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => discovery.resolve(emptyPage))

    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps a cached empty child state connected while revisiting through its ancestor', async () => {
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
    const folderBRefresh = deferred<typeof emptyChildrenPage>()
    let holdNextFolderBRequest = false
    let heldFolderBRequestStarted = false
    const listChildren = vi.fn((resourceId: string) => {
      if (resourceId === 'folder-a') return Promise.resolve(ancestorPage)
      if (resourceId === 'folder-b' && holdNextFolderBRequest) {
        holdNextFolderBRequest = false
        heldFolderBRequestStarted = true
        return folderBRefresh.promise
      }
      return Promise.resolve(emptyChildrenPage)
    })
    installGfsBridge({ listAccessible: vi.fn(async () => rootPage), listChildren })

    const { queryClient } = renderFilesPage()
    await screen.findByRole('button', { name: 'Open Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))
    await screen.findByText('This folder is empty')

    const folderBKey = desktopQueryKeys.gfsChildren(':user-a:team-a', 'folder-b', 'main')
    await waitFor(() => {
      expect(queryClient.getQueryState(folderBKey)?.status).toBe('success')
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('idle')
    })
    expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })

    const breadcrumbs = screen.getByRole('navigation', { name: 'File location' })
    fireEvent.click(within(breadcrumbs).getByRole('button', { name: 'Folder A' }))
    await screen.findByRole('button', { name: 'Open Folder B' })
    await waitFor(() => {
      expect(
        queryClient.getQueryCache().find({ exact: true, queryKey: folderBKey })?.getObserversCount()
      ).toBe(0)
    })
    expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })

    holdNextFolderBRequest = true
    fireEvent.click(screen.getByRole('button', { name: 'Folder B' }))
    await waitFor(() => {
      expect(heldFolderBRequestStarted).toBe(true)
      expect(queryClient.getQueryState(folderBKey)?.fetchStatus).toBe('fetching')
      expect(queryClient.getQueryData(folderBKey)).toMatchObject({ pages: [{ items: [] }] })
    })

    const emptyState = screen.getByText('This folder is empty')
    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    expect(emptyState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => folderBRefresh.resolve(emptyChildrenPage))

    expect(emptyState.isConnected).toBe(true)
    expect(screen.getByText('This folder is empty')).toBe(emptyState)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('shows initial loading after removal and a real accessible-query observer rebind', async () => {
    const emptyPage = await listAccessiblePage([])
    const discovery = deferred<typeof emptyPage>()
    const listAccessible = vi
      .fn()
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => discovery.promise)
    installGfsBridge({ listAccessible })

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = renderFilesPage(queryClient)
    const firstEmptyState = await screen.findByText('No shared files yet')
    firstMount.unmount()

    act(() => {
      queryClient.removeQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    expect(queryClient.getQueryState(ACCESSIBLE_KEY)).toBeUndefined()
    expect(listAccessible).toHaveBeenCalledTimes(1)

    renderFilesPage(queryClient)

    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.data).toBeUndefined()
    })
    expect(firstEmptyState.isConnected).toBe(false)
    expect(screen.queryByText('No shared files yet')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('true')

    await act(async () => discovery.resolve(emptyPage))

    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps the typed delegation form visible and blocks Share during exact permission refresh', async () => {
    const rootPage = await listAccessiblePage([
      accessibleResource('folder-a', 'Folder A', 'directory', {
        sources: ['grant'],
        permissions: ['read', 'manage_acl'],
        coversDescendants: true,
      }),
    ])
    const emptyChildrenPage = await listChildrenPage([])
    const resolvedFolder = {
      ...(await resolveResource(resolvedDirectory('folder-a', 'Folder A'))),
      pathCache: null,
    }
    const currentGrantable = await affordancesResult(
      heldAffordances(['read', 'write', 'manage_acl', 'share'])
    )
    const freshPositive = delegationAffordances(
      new Set(currentGrantable.held),
      currentGrantable.isOperator
    )
    const permissionRefresh = deferred<typeof freshPositive>()
    let nextPermissionRefresh: Promise<typeof freshPositive> | null = null
    const listAccessible = vi.fn(async () => rootPage)
    const listChildren = vi.fn(async () => emptyChildrenPage)
    const affordances = vi.fn(() => {
      const nextRefresh = nextPermissionRefresh
      nextPermissionRefresh = null
      return nextRefresh ?? Promise.resolve(freshPositive)
    })
    const grant = vi.fn(async () => undefined)
    installGfsBridge(
      {
        listAccessible,
        listChildren,
        affordances,
        grant,
        resolve: vi.fn(async () => resolvedFolder),
        listGrants: vi.fn(async () => grantsListPage([])),
        listShares: vi.fn(async () => sharesListPage([])),
      },
      {
        agents: {
          listMine: vi.fn(async () => [
            {
              name: 'chatllm',
              contextRef: 'ctx-1',
              mcpServers: [],
              gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
            },
          ]),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-a', items: [] })) },
      }
    )

    const { queryClient } = renderFilesPage()
    await screen.findByRole('button', { name: 'Share Folder A' })
    fireEvent.click(screen.getByRole('button', { name: 'Share Folder A' }))
    const dialog = await screen.findByRole('dialog', { name: 'Share folder Folder A' })
    const affordancesKey = desktopQueryKeys.gfsAffordances(':user-a:team-a', 'folder-a', 'main')
    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.status).toBe('success')
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('idle')
      expect(queryClient.getQueryState(affordancesKey)?.isInvalidated).toBe(false)
    })
    const subjectInput = await within(dialog).findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(subjectInput)
    fireEvent.change(subjectInput, { target: { value: 'chatllm' } })
    fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))
    const selectedSubject = within(dialog).getByText('chatllm')
    expect(subjectInput.isConnected).toBe(true)

    nextPermissionRefresh = permissionRefresh.promise
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: affordancesKey })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('fetching')
    })

    const browser = screen.getByRole('region', { name: 'EvenDrive browser' })
    const emptyState = screen.getByText('This folder is empty')
    expect(subjectInput.isConnected).toBe(true)
    expect(selectedSubject.isConnected).toBe(true)
    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()
    const shareButton = within(dialog).getByRole('button', { name: 'Share' }) as HTMLButtonElement
    expect(shareButton.disabled).toBe(true)
    fireEvent.click(shareButton)
    expect(grant).not.toHaveBeenCalled()
    expect(emptyState.isConnected).toBe(true)
    expect(screen.queryByRole('status', { name: 'Loading files' })).toBeNull()
    expect(browser.getAttribute('aria-busy')).toBe('false')

    await act(async () => permissionRefresh.resolve(freshPositive))

    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('idle')
    })
    expect(subjectInput.isConnected).toBe(true)
    expect(selectedSubject.isConnected).toBe(true)
    expect(within(dialog).queryByText('Checking permissions…')).toBeNull()
    expect(shareButton.disabled).toBe(false)
    fireEvent.click(shareButton)
    await waitFor(() => {
      expect(grant).toHaveBeenCalledOnce()
      expect(grant).toHaveBeenCalledWith(
        'folder-a',
        ['host:1st:mcp-host/chatllm'],
        ['read'],
        'main',
        true
      )
    })
    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')

    const selectAgent = async (input = subjectInput) => {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'chatllm' } })
      fireEvent.click(await within(dialog).findByRole('option', { name: /chatllm/ }))
      return within(dialog).getByText('chatllm')
    }

    const selectedAgain = await selectAgent()
    const roleSelect = within(dialog).getByRole('button', {
      name: 'Access role for selected recipients',
    })
    fireEvent.click(roleSelect)
    fireEvent.click(await within(dialog).findByRole('option', { name: 'Editor' }))
    expect(roleSelect.textContent).toContain('Editor')
    const inheritanceCheckbox = within(dialog).getByRole('checkbox', {
      name: 'Include contents of this folder',
    }) as HTMLInputElement
    fireEvent.click(inheritanceCheckbox)
    expect(inheritanceCheckbox.checked).toBe(false)
    const grantFailureMessage = await gfsRouteFailureMessage(
      client =>
        client.grant(
          {
            resourceId: 'folder-a',
            drive: 'main',
            subjects: [{ type: 'host', id: '1st:mcp-host/chatllm' }],
            permissions: ['read', 'write'],
            inherit: false,
          },
          'fixture-session-token'
        ),
      503,
      { code: 'internal', message: 'share attempt failed' }
    )
    grant.mockRejectedValueOnce(new Error(grantFailureMessage))
    const shareButtonAgain = within(dialog).getByRole('button', {
      name: 'Share',
    }) as HTMLButtonElement
    fireEvent.click(shareButtonAgain)
    expect(await within(dialog).findByText(/share attempt failed/)).toBeTruthy()
    expect(grant).toHaveBeenCalledTimes(2)
    expect(grant).toHaveBeenLastCalledWith(
      'folder-a',
      ['host:1st:mcp-host/chatllm'],
      ['read', 'write'],
      'main',
      false
    )

    const producerErrorMessage = await affordancesFailureMessage(
      503,
      { code: 'internal', message: 'gfs controller failed' },
      'folder-a'
    )
    const failedRefresh = deferred<typeof freshPositive>()
    nextPermissionRefresh = failedRefresh.promise
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: affordancesKey })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('fetching')
    })
    expect(subjectInput.isConnected).toBe(true)
    expect(selectedAgain.isConnected).toBe(true)
    expect(roleSelect.textContent).toContain('Editor')
    expect(inheritanceCheckbox.checked).toBe(false)
    expect(within(dialog).getByText(/share attempt failed/)).toBeTruthy()
    expect(shareButtonAgain.disabled).toBe(true)
    fireEvent.click(shareButtonAgain)
    expect(grant).toHaveBeenCalledTimes(2)

    await act(async () => failedRefresh.reject(new Error(producerErrorMessage)))
    expect(await screen.findByText(/gfs controller failed/)).toBeTruthy()
    expect(subjectInput.isConnected).toBe(true)
    expect(selectedAgain.isConnected).toBe(true)
    expect(roleSelect.textContent).toContain('Editor')
    expect(inheritanceCheckbox.checked).toBe(false)
    expect(within(dialog).getByText(/share attempt failed/)).toBeTruthy()
    expect(shareButtonAgain.disabled).toBe(true)
    fireEvent.click(shareButtonAgain)
    expect(grant).toHaveBeenCalledTimes(2)

    const freshDenied = delegationAffordances(new Set(['read']), false)
    const denialRefresh = deferred<typeof freshPositive>()
    nextPermissionRefresh = denialRefresh.promise
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: affordancesKey })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('fetching')
    })
    expect(subjectInput.isConnected).toBe(true)
    expect(selectedAgain.isConnected).toBe(true)
    expect(roleSelect.textContent).toContain('Editor')
    expect(inheritanceCheckbox.checked).toBe(false)
    expect(within(dialog).getByText(/share attempt failed/)).toBeTruthy()
    expect(shareButtonAgain.disabled).toBe(true)

    await act(async () => denialRefresh.resolve(freshDenied))

    expect(await within(dialog).findByText('Read-only access')).toBeTruthy()
    expect(await within(dialog).findByText('People with access')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Share' })).toBeNull()
    expect(subjectInput.isConnected).toBe(false)
    expect(selectedAgain.isConnected).toBe(false)
    expect(grant).toHaveBeenCalledTimes(2)
    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')

    const restoredPermission = deferred<typeof freshPositive>()
    nextPermissionRefresh = restoredPermission.promise
    act(() => {
      void queryClient.invalidateQueries({ exact: true, queryKey: affordancesKey })
    })
    await waitFor(() => {
      expect(queryClient.getQueryState(affordancesKey)?.fetchStatus).toBe('fetching')
    })

    await act(async () => restoredPermission.resolve(freshPositive))

    const restoredInput = await within(dialog).findByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    expect(restoredInput.isConnected).toBe(true)
    expect(within(dialog).queryByText('chatllm')).toBeNull()
    expect(within(dialog).queryByText(/share attempt failed/)).toBeNull()
    expect(await within(dialog).findByText('People with access')).toBeTruthy()
    await selectAgent(restoredInput)
    const restoredRole = within(dialog).getByRole('button', {
      name: 'Access role for selected recipients',
    })
    expect(restoredRole.textContent).toContain('Read')
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: 'Include contents of this folder',
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect(within(dialog).queryByText(/share attempt failed/)).toBeNull()
    expect(emptyState.isConnected).toBe(true)
    expect(browser.getAttribute('aria-busy')).toBe('false')
  })
})
