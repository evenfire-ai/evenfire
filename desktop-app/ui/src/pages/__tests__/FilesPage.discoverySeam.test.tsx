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
  gfsRouteFailureMessage,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
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

// The controller reads exactly three fields off this context — isAuthenticated,
// me and runtimeConfigState — and FilesPage reads none. The cast keeps the
// double to those three rather than restating forty unrelated auth-screen
// fields that no code under test touches.
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
const ACCESSIBLE_KEY = desktopQueryKeys.gfsAccessible(':user-a:team-a', 'main')
const GFS_ACCESSIBLE = 'fixture-session-token'

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

function renderFilesPage() {
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  testQueryClients.push(queryClient)
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
})
