// R52 pre-implementation scenario; execute from desktop-app/ui in an isolated checkout.
// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  getPermissionErrorsForOwner,
  isPermissionErrorAcknowledged,
  permissionErrorToken,
} from '@components/Common/permissionErrorAcknowledgement'
import { desktopQueryKeys, hasGfsSessionGeneration } from '@hooks/domain/queryKeys'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  affordancesFailureMessage,
  childView,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilesPage } from '../FilesPage'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const folderUri = 'gfs://main/r52-partial'
const me = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'User One',
  picture: null,
  teamId: 'team-1',
  teamName: 'Team One',
  role: 'member' as const,
}
const authValue = {
  isAuthenticated: true,
  sessionGeneration: 0,
  me,
  runtimeConfigState: { envKey: 'test-environment' },
} as unknown as AuthContextValue

function acknowledged(
  queryIdentity: import('@tanstack/react-query').Query,
  token?: symbol
): boolean {
  return isPermissionErrorAcknowledged({
    id: 'query-backed-permission-error',
    message: 'Permission check failed.',
    queryIdentity,
    token,
  })
}

function wrapper(client: QueryClient) {
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('R53 real permission presentation and Query ordering scenarios', () => {
  it('retains a first-observed partial-page Query through same-folder remount omission', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-r52', 'Reports', { gfsUri: folderUri })
    )
    const report = childView('child-r52', 'report.txt', 'file', {
      parentResourceId: 'folder-r52',
    })
    const firstPartial = await listChildrenPage([report], 'cursor-next')
    const omittedPartial = await listChildrenPage([], 'cursor-next')
    const laterPage = await listChildrenPage([report])
    const omittedFirst = await listChildrenPage([], 'cursor-next')
    const omittedTerminal = await listChildrenPage([])
    const returnedComplete = await listChildrenPage([report])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-r52'
    )
    let listingMode: 'initial' | 'remount' | 'later' | 'omit' | 'return' = 'initial'
    let rowReads = 0
    let recovered = false
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      if (listingMode === 'initial') return firstPartial
      if (listingMode === 'remount') return omittedPartial
      if (listingMode === 'later') return laterPage
      if (listingMode === 'omit') return cursor === 'cursor-next' ? omittedTerminal : omittedFirst
      return returnedComplete
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-r52')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      rowReads += 1
      return rowReads === 1 || recovered
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const rowKey = desktopQueryKeys.gfsAffordances(session, 'child-r52', 'main', 0)
    const folderKey = desktopQueryKeys.gfsChildren(session, 'folder-r52', 'main', 0)
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri={folderUri} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBe(1))
      const query = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      if (!query) throw new Error('Expected actual child permission Query')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      const originalToken = permissionErrorToken({
        id: 'row:child-r52',
        message: 'permission failure',
        queryIdentity: query,
      })
      expect(originalToken).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(acknowledged(query, originalToken)).toBe(true)

      // Q has never belonged to a complete child snapshot. The remount first page is
      // incomplete and omits Q; it cannot establish a folder-membership departure.
      listingMode = 'remount'
      view.unmount()
      await client.invalidateQueries({ exact: true, queryKey: folderKey })
      view = render(<FilesPage pendingGfsUri={folderUri} />, { wrapper: wrapper(client) })
      await waitFor(() => expect(listChildren.mock.calls.length).toBeGreaterThan(1))
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(query)
      await screen.findByRole('button', { name: 'Load more' })
      listingMode = 'later'
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBeGreaterThan(2))
      await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(query)
      expect(
        permissionErrorToken({
          id: 'row:child-r52',
          message: 'permission failure',
          queryIdentity: query,
        })
      ).toBe(originalToken)
      expect(acknowledged(query, originalToken)).toBe(true)

      // Desired R52 outcome. On the current candidate this fails because the stale
      // acknowledgement was expired during the partial first-page omission.
      expect(screen.queryByRole('alertdialog')).toBeNull()

      // A complete same-cycle omission removes Files membership, but not the shared
      // Query failure episode. Returning to the same Query keeps its acknowledgement.
      listingMode = 'omit'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )
      expect(
        permissionErrorToken({
          id: 'row:child-r52',
          message: 'permission failure',
          queryIdentity: query,
        })
      ).toBe(originalToken)
      listingMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(query)
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      recovered = true
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(client.getQueryState(rowKey)?.status).toBe('success')
      recovered = false
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('keeps cached child membership when Load more cancels a refetch over cached pages', async () => {
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const key = desktopQueryKeys.gfsChildren('test-session', 'folder-r53', 'main', 0)
    const oldFirst = {
      items: [{ resourceId: 'child-r53', name: 'report.txt' }],
      nextCursor: 'old-next',
    }
    const oldSecond = {
      items: [{ resourceId: 'other-r53', name: 'notes.txt' }],
      nextCursor: 'old-last',
    }
    let releaseRefetch!: (value: { items: []; nextCursor: string }) => void
    const blocked = new Promise<{ items: []; nextCursor: string }>(resolve => {
      releaseRefetch = resolve
    })
    const queryFn = vi.fn(({ pageParam }: { pageParam: string | undefined }) => {
      if (pageParam === undefined) return blocked
      return Promise.resolve({ items: [], nextCursor: null })
    })
    const options = {
      queryKey: key,
      queryFn,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: { nextCursor: string | null }) =>
        lastPage.nextCursor ?? undefined,
      staleTime: Infinity,
    }
    client.setQueryData(key, {
      pages: [oldFirst, oldSecond],
      pageParams: [undefined, 'old-next'],
    })
    const observer = new InfiniteQueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      const fullRefetch = observer.refetch()
      await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
      expect(client.getQueryState(key)?.fetchStatus).toBe('fetching')
      const append = observer.fetchNextPage()
      await act(async () => {
        await append
      })
      await fullRefetch.catch(() => undefined)
      const current = client.getQueryData<{
        pages: Array<{ items: Array<{ resourceId: string }>; nextCursor: string | null }>
        pageParams: unknown[]
      }>(key)
      expect(current?.pages.flatMap(page => page.items.map(item => item.resourceId))).toContain(
        'child-r53'
      )
      expect(current?.pages.at(-1)?.nextCursor).toBeNull()
      expect(current?.pages).toHaveLength(3)
      expect(client.getQueryState(key)?.fetchStatus).toBe('idle')
    } finally {
      releaseRefetch({ items: [], nextCursor: 'old-next' })
      unsubscribe()
      client.clear()
    }
  })

  it('coalesces repeated Retry fetches and focus refetch to one Query terminal event', async () => {
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    let rejectRequest!: (reason: Error) => void
    const request = new Promise<string>((_resolve, reject) => {
      rejectRequest = reject
    })
    const queryFn = vi.fn(() => request)
    const key = ['r53', 'single-flight'] as const
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 0,
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    let terminalEvents = 0
    const stop = client.getQueryCache().subscribe(event => {
      if (
        event.type === 'updated' &&
        event.action.type === 'error' &&
        event.query.queryKey === key
      ) {
        terminalEvents += 1
      }
    })
    try {
      const firstRetry = client.fetchQuery({ queryKey: key, queryFn, staleTime: 0, retry: false })
      const secondRetry = client.fetchQuery({ queryKey: key, queryFn, staleTime: 0, retry: false })
      const focus = observer.refetch({ cancelRefetch: false })
      expect(queryFn).toHaveBeenCalledTimes(1)
      rejectRequest(new Error('503|unavailable|permission service unavailable'))
      await Promise.allSettled([firstRetry, secondRetry, focus])
      const query = client.getQueryCache().find({ queryKey: key, exact: true })
      expect(query?.state.status).toBe('error')
      expect(query?.state.errorUpdateCount).toBe(1)
      expect(terminalEvents).toBe(1)
    } finally {
      stop()
      unsubscribe()
      client.clear()
    }
  })
})

describe('R54 real FilesPage Manage and Retry caller ordering', () => {
  it('waits for a same-resource Retry before opening Manage', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-r54-same', 'Reports', { gfsUri: 'gfs://main/r54-same' })
    )
    const children = await listChildrenPage([])
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'folder-r54-same'
    )
    let folderReads = 0
    let releaseRetry!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    const retryPending = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      resolve => {
        releaseRetry = resolve
      }
    )
    const producer = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'folder-r54-same')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
      folderReads += 1
      if (folderReads === 2) return Promise.reject(rateLimited)
      if (folderReads === 3) return retryPending
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const folderKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'folder-r54-same',
      'main',
      0
    )
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r54-same" />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(folderReads).toBe(1))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      await screen.findByRole('alertdialog')
      expect(String(client.getQueryState(folderKey)?.error)).toContain('httpStatus=429')

      vi.setSystemTime(Date.now() + 7_000)
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(folderReads).toBe(3))
      expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching')
      expect(screen.queryByRole('dialog')).toBeNull()

      // The current-resource action reaches openManageCurrent. Its fresh
      // authority read joins the in-flight fetchQuery for this exact Query.
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(screen.getByRole('menuitem', { name: /^Share$/ }))
      const shareMenu = screen.getByRole('menu', { name: 'Share options for Reports' })
      fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
      await waitFor(() => expect(folderReads).toBe(3))
      expect(screen.queryByRole('dialog', { name: /^Share/ })).toBeNull()
      expect(
        client.getQueryCache().find({ exact: true, queryKey: folderKey })?.state.fetchStatus
      ).toBe('fetching')

      await act(async () => {
        releaseRetry(heldPermissionResponse(['read', 'write', 'manage_acl']))
      })
      await screen.findByRole('dialog', { name: /^Share/ })
      await waitFor(() => expect(folderReads).toBe(4))
      expect(client.getQueryState(folderKey)?.status).toBe('success')
    } finally {
      view?.unmount()
      releaseRetry?.(heldPermissionResponse(['read', 'write', 'manage_acl']))
      client.clear()
      vi.useRealTimers()
    }
  })

  it('child Manage invalidates the child Query after navigation while folder Retry continues', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-r54-child', 'Reports', { gfsUri: 'gfs://main/r54-child' })
    )
    const child = childView('child-r54', 'report.txt', 'file', {
      parentResourceId: 'folder-r54-child',
    })
    const children = await listChildrenPage([child])
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'folder-r54-child'
    )
    let folderReads = 0
    let childReads = 0
    let releaseRetry!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    const retryPending = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      resolve => {
        releaseRetry = resolve
      }
    )
    const producer = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'child-r54') {
        childReads += 1
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
      }
      folderReads += 1
      if (folderReads === 2) return Promise.reject(rateLimited)
      if (folderReads === 3) return retryPending
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances: vi.fn((resourceId: string) => producer(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const folderKey = desktopQueryKeys.gfsAffordances(session, 'folder-r54-child', 'main', 0)
    const childKey = desktopQueryKeys.gfsAffordances(session, 'child-r54', 'main', 0)
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r54-child" />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Share report.txt' })
      await waitFor(() => expect(childReads).toBe(1))
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: folderKey })
      })
      await screen.findByRole('alertdialog')
      expect(String(client.getQueryState(folderKey)?.error)).toContain('httpStatus=429')

      vi.setSystemTime(Date.now() + 7_000)
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(folderReads).toBe(3))
      expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching')

      // Begin current-resource Manage while the Retry is pending. This caller
      // joins the same Query; the row action then commits a different resource.
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(screen.getByRole('menuitem', { name: /^Share$/ }))
      const shareMenu = screen.getByRole('menu', { name: 'Share options for Reports' })
      fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
      await waitFor(() => expect(folderReads).toBe(3))
      expect(screen.queryByRole('dialog', { name: /^Share/ })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Share report.txt' }))
      await screen.findByRole('dialog', { name: /^Share/ })
      await waitFor(() => expect(childReads).toBe(2))
      expect(
        client.getQueryCache().find({ exact: true, queryKey: folderKey })?.state.fetchStatus
      ).toBe('fetching')
      expect(client.getQueryCache().find({ exact: true, queryKey: childKey })?.state.status).toBe(
        'success'
      )
      expect(client.getQueryCache().find({ exact: true, queryKey: childKey })).not.toBe(
        client.getQueryCache().find({ exact: true, queryKey: folderKey })
      )

      await act(async () => {
        releaseRetry(heldPermissionResponse(['read', 'write', 'manage_acl']))
      })
      await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('success'))
      expect(folderReads).toBe(3)
      expect(screen.getByRole('dialog', { name: /^Share/ })).toBeTruthy()
    } finally {
      view?.unmount()
      releaseRetry?.(heldPermissionResponse(['read', 'write', 'manage_acl']))
      client.clear()
      vi.useRealTimers()
    }
  })
})

describe('R57 TanStack Query page provenance', () => {
  it('keeps a changed epoch on the published envelope across structural sharing', async () => {
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const envelopeKey = ['r57-page-envelope'] as const
    const previousResult = { items: [], nextCursor: 'next' }
    const oldEnvelope = { producerAuthorityEpoch: 1, result: previousResult }
    client.setQueryData(envelopeKey, { pages: [oldEnvelope], pageParams: [undefined] })
    const equalFreshResult = { items: [], nextCursor: 'next' }
    const envelopeObserver = new InfiniteQueryObserver(client, {
      queryKey: envelopeKey,
      queryFn: async () => ({ producerAuthorityEpoch: 2, result: equalFreshResult }),
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
    })
    const stopEnvelopeObserver = envelopeObserver.subscribe(() => undefined)

    const weakTagKey = ['r57-weak-tag'] as const
    const oldResult = { items: [], nextCursor: 'next' }
    client.setQueryData(weakTagKey, { pages: [oldResult], pageParams: [undefined] })
    const weakTags = new WeakMap<object, number>()
    const equalNewResult = { items: [], nextCursor: 'next' }
    weakTags.set(equalNewResult, 2)
    const weakTagObserver = new InfiniteQueryObserver(client, {
      queryKey: weakTagKey,
      queryFn: async () => equalNewResult,
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
    })
    const stopWeakTagObserver = weakTagObserver.subscribe(() => undefined)

    try {
      await envelopeObserver.refetch()
      await weakTagObserver.refetch()
      const publishedEnvelope = client.getQueryData<{
        pages: Array<{ producerAuthorityEpoch: number; result: typeof previousResult }>
      }>(envelopeKey)?.pages[0]
      const publishedWeakResult = client.getQueryData<{
        pages: Array<typeof oldResult>
      }>(weakTagKey)?.pages[0]

      expect(publishedEnvelope?.producerAuthorityEpoch).toBe(2)
      expect(publishedEnvelope?.result).toBe(previousResult)
      expect(publishedEnvelope).not.toBe(oldEnvelope)
      expect(publishedWeakResult).toBe(oldResult)
      expect(weakTags.get(publishedWeakResult!)).toBeUndefined()
    } finally {
      stopEnvelopeObserver()
      stopWeakTagObserver()
      client.clear()
    }
  })
})

describe('R57 Files child membership page provenance', () => {
  it('expires a retained Query after a full current-epoch omission with an equal cached prefix', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-r57-equal', 'Reports', { gfsUri: 'gfs://main/r57-equal' })
    )
    const stable = childView('stable-r57', 'summary.txt', 'file', {
      parentResourceId: 'folder-r57-equal',
    })
    const target = childView('target-r57', 'report.txt', 'file', {
      parentResourceId: 'folder-r57-equal',
    })
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service unavailable' },
      'target-r57'
    )
    let pageMode: 'initial' | 'omit' | 'return' = 'initial'
    let targetReads = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      if (pageMode === 'initial') {
        return cursor === undefined
          ? await listChildrenPage([stable], 'equal-prefix-next')
          : await listChildrenPage([target])
      }
      if (pageMode === 'omit') {
        return cursor === undefined
          ? await listChildrenPage([stable], 'equal-prefix-next')
          : await listChildrenPage([])
      }
      return cursor === undefined
        ? await listChildrenPage([stable], 'equal-prefix-next')
        : await listChildrenPage([target])
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'target-r57')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      targetReads += 1
      return targetReads === 1
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const childrenKey = desktopQueryKeys.gfsChildren(session, 'folder-r57-equal', 'main', 0)
    const targetKey = desktopQueryKeys.gfsAffordances(session, 'target-r57', 'main', 0)
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r57-equal" />, {
        wrapper: wrapper(client),
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(targetReads).toBe(1))
      const targetQuery = client.getQueryCache().find({ exact: true, queryKey: targetKey })
      if (!targetQuery) throw new Error('Expected the real target permission Query')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: targetKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      const token = permissionErrorToken({
        id: 'row:target-r57',
        message: 'permission service unavailable',
        queryIdentity: targetQuery,
      })
      if (!token) throw new Error('Expected a real Query-backed error token')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      const before = client.getQueryData<{
        pages: Array<{
          items: Array<{ resourceId: string }>
          nextCursor: string | null
          __filesFullListing?: true
        }>
      }>(childrenKey)?.pages[0]
      if (!before) throw new Error('Expected the real initial Files listing page')
      expect(before?.items.map(item => item.resourceId)).toEqual(['stable-r57'])
      view.unmount()
      pageMode = 'omit'
      view = render(<FilesPage pendingGfsUri="gfs://main/r57-equal" />, {
        wrapper: wrapper(client),
      })
      await waitFor(() =>
        expect(
          client.getQueryCache().find({ exact: true, queryKey: childrenKey })?.getObserversCount()
        ).toBeGreaterThan(0)
      )
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      expect(listChildren.mock.calls.length).toBeGreaterThanOrEqual(4)
      await waitFor(() => expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('idle'))
      const after = client.getQueryData<{
        pages: Array<{
          items: Array<{ resourceId: string }>
          nextCursor: string | null
          __filesFullListing?: true
        }>
      }>(childrenKey)?.pages[0]
      if (!after) throw new Error('Expected the real remounted Files listing page')
      expect(after.items.map(item => item.resourceId)).toEqual(['stable-r57'])
      // Full-refetch pages carry owner provenance; visible page results stay stable.
      expect(after.items).toEqual(before.items)
      expect(after.nextCursor).toBe(before.nextCursor)
      expect(after.__filesFullListing).toBe(true)
      expect(client.getQueryCache().find({ exact: true, queryKey: targetKey })).toBe(targetQuery)
      expect(
        client
          .getQueryData<{ pages: Array<{ items: Array<{ resourceId: string }> }> }>(childrenKey)
          ?.pages.flatMap(page => page.items.map(item => item.resourceId))
      ).not.toContain('target-r57')
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )

      pageMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await waitFor(() => expect(targetReads).toBeGreaterThan(2))
      expect(client.getQueryCache().find({ exact: true, queryKey: targetKey })).toBe(targetQuery)
      const returnedToken = permissionErrorToken({
        id: 'row:target-r57',
        message: 'permission service unavailable',
        queryIdentity: targetQuery,
      })
      expect(returnedToken).toBe(token)
      expect(acknowledged(targetQuery, returnedToken)).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('keeps dismissal through stale-prefix append when remount wall-clock moves backwards', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const folder = await resolveResource(
      resolvedDirectory('folder-r57', 'Reports', { gfsUri: 'gfs://main/r57-provenance' })
    )
    const report = childView('child-r57', 'report.txt', 'file', {
      parentResourceId: 'folder-r57',
    })
    const initialFirst = await listChildrenPage([], 'initial-next')
    const initialSecond = await listChildrenPage([report])
    const restoredPartial = await listChildrenPage([], 'restore-next')
    const appendedTerminal = await listChildrenPage([])
    const returnedFirst = await listChildrenPage([], 'return-next')
    const returnedSecond = await listChildrenPage([report])
    const currentOmissionFirst = await listChildrenPage([], 'omit-next')
    const currentOmissionSecond = await listChildrenPage([])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service unavailable' },
      'child-r57'
    )
    let pageMode: 'initial' | 'restore' | 'pending' | 'append' | 'return' | 'omit' = 'initial'
    let rowReads = 0
    let releaseRefetch!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let pendingFullRefetch: Promise<void> | undefined
    let markRefetchStarted!: () => void
    const refetchStarted = new Promise<void>(resolve => {
      markRefetchStarted = resolve
    })
    const blockedRefetch = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      releaseRefetch = resolve
    })
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      if (pageMode === 'pending' && cursor === undefined) {
        markRefetchStarted()
        return blockedRefetch
      }
      if (pageMode === 'initial') return cursor === undefined ? initialFirst : initialSecond
      if (pageMode === 'restore') return restoredPartial
      if (pageMode === 'append') return appendedTerminal
      if (pageMode === 'return') return cursor === undefined ? returnedFirst : returnedSecond
      return cursor === undefined ? currentOmissionFirst : currentOmissionSecond
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-r57')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      rowReads += 1
      return rowReads === 1
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const childrenKey = desktopQueryKeys.gfsChildren(session, 'folder-r57', 'main', 0)
    const rowKey = desktopQueryKeys.gfsAffordances(session, 'child-r57', 'main', 0)
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r57-provenance" />, {
        wrapper: wrapper(client),
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBe(1))
      const rowQuery = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      if (!rowQuery) throw new Error('Expected the real child permission Query')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      await screen.findByRole('alertdialog')
      const token = permissionErrorToken({
        id: 'row:child-r57',
        message: 'permission service unavailable',
        queryIdentity: rowQuery,
      })
      if (!token) throw new Error('Expected a real Query-backed error token')
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(acknowledged(rowQuery, token)).toBe(true)

      view.unmount()
      view = undefined
      client.removeQueries({ exact: true, queryKey: childrenKey })
      pageMode = 'restore'
      dateNow.mockReturnValue(10_000)
      view = render(<FilesPage pendingGfsUri="gfs://main/r57-provenance" />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Load more' })
      view.unmount()
      view = undefined

      // A second mount advances controller provenance while the cached prefix remains.
      // Let its mount refetch settle so the real Load more control remains available.
      pageMode = 'restore'
      dateNow.mockReturnValue(9_000)
      view = render(<FilesPage pendingGfsUri="gfs://main/r57-provenance" />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Load more' })
      pageMode = 'pending'
      pendingFullRefetch = client.refetchQueries({ exact: true, queryKey: childrenKey })
      await refetchStarted
      expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('fetching')
      pageMode = 'append'
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
      await pendingFullRefetch?.catch(() => undefined)
      await waitFor(() => {
        const data = client.getQueryData<{
          pages: Array<{ items: Array<{ resourceId: string }>; nextCursor: string | null }>
        }>(childrenKey)
        expect(data?.pages).toHaveLength(2)
        expect(data?.pages[1]?.nextCursor).toBeNull()
        expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('idle')
      })
      expect(
        client
          .getQueryData<{
            pages: Array<{ items: Array<{ resourceId: string }>; nextCursor: string | null }>
          }>(childrenKey)
          ?.pages.flatMap(page => page.items.map(item => item.resourceId))
      ).not.toContain('child-r57')

      pageMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await waitFor(() => expect(rowReads).toBeGreaterThan(2))
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
      // R57 behavior: cached-prefix append did not prove current-epoch membership,
      // so returning with the same unresolved Query remains acknowledged.
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(
        permissionErrorToken({
          id: 'row:child-r57',
          message: 'permission service unavailable',
          queryIdentity: rowQuery,
        })
      ).toBe(token)

      // A full current-cycle chain proves omission from Files, without ending the
      // shared Query's acknowledged failure episode.
      pageMode = 'omit'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )
      pageMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      await waitFor(() => expect(rowReads).toBeGreaterThan(3))
      const newToken = permissionErrorToken({
        id: 'row:child-r57',
        message: 'permission service unavailable',
        queryIdentity: rowQuery,
      })
      expect(newToken).toBe(token)
      expect(acknowledged(rowQuery, newToken)).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()
    } finally {
      view?.unmount()
      releaseRefetch?.(appendedTerminal)
      client.clear()
    }
  })
})

describe('R59 real QueryClient handoff and failure visibility', () => {
  it.each(['failure', 'success'] as const)(
    'maps replacement %s to the user-visible Retry outcome and ignores late canceled output',
    async replacementOutcome => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const folder = await resolveResource(
        resolvedDirectory('folder-r58', 'Reports', { gfsUri: 'gfs://main/r58' })
      )
      const children = await listChildrenPage([])
      const firstRateLimit = await affordancesApiError(
        429,
        { code: 'rate_limited', message: 'Too Many Requests' },
        'folder-r58'
      )
      const replacementFailure = await affordancesApiError(
        503,
        { code: 'unavailable', message: 'permission service unavailable' },
        'folder-r58'
      )
      let folderReads = 0
      let releaseRetry!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      let resolveReplacement!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      let rejectReplacement!: (error: Error) => void
      const retryPending = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        resolve => {
          releaseRetry = resolve
        }
      )
      const replacementPending = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        (resolve, reject) => {
          resolveReplacement = resolve
          rejectReplacement = reject
        }
      )
      void replacementPending.catch(() => undefined)
      const producer = appServiceAffordanceProducer(resourceId => {
        if (resourceId !== 'folder-r58')
          return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
        folderReads += 1
        if (folderReads === 2) return Promise.reject(firstRateLimit)
        if (folderReads === 3) return retryPending
        if (folderReads === 4) return replacementPending
        return Promise.reject(firstRateLimit)
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances: vi.fn((resourceId: string) => producer(resourceId)),
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      let folderKey: readonly unknown[] = []
      let query:
        | {
            queryKey: readonly unknown[]
            getObserversCount: () => number
            isDisabled: () => boolean
          }
        | undefined
      let queryFilter: {
        queryKey: readonly unknown[]
        predicate: (query: { queryKey: readonly unknown[] }) => boolean
      }
      let view: { unmount: () => void } | undefined
      try {
        view = render(<FilesPage pendingGfsUri="gfs://main/r58" />, { wrapper: wrapper(client) })
        await screen.findByRole('button', { name: 'Options for Reports' })
        await waitFor(() => expect(folderReads).toBe(1))
        query = client
          .getQueryCache()
          .findAll({ queryKey: desktopQueryKeys.gfsRoot })
          .find(
            candidate =>
              candidate.queryKey[3] === 'affordances' && candidate.queryKey[5] === 'folder-r58'
          )
        expect(query).toBeTruthy()
        folderKey = query!.queryKey
        const querySession = folderKey[2] as string
        const queryGeneration = (folderKey[folderKey.length - 1] as { sessionGeneration: number })
          .sessionGeneration
        queryFilter = {
          queryKey: desktopQueryKeys.gfsRoot,
          predicate: candidate =>
            candidate.queryKey[2] === querySession &&
            hasGfsSessionGeneration(candidate.queryKey, queryGeneration),
        }
        const cachedAuthority = await appServiceAffordanceProducer(() =>
          Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
        )('folder-r58')
        client.setQueryData(folderKey, cachedAuthority)
        expect(client.getQueryCache().findAll(queryFilter)).toContain(query)
        expect(query!.getObserversCount()).toBeGreaterThan(0)
        expect(client.getQueryState(folderKey)?.data).toBeDefined()
        await act(async () => {
          await client.refetchQueries({ exact: true, queryKey: folderKey })
        })
        const dialog = await screen.findByRole('alertdialog')
        expect(within(dialog).getByText(/Too many file requests/i)).toBeTruthy()

        vi.setSystemTime(Date.now() + 7_000)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
        await waitFor(() => expect(folderReads).toBe(3))
        expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(query)
        expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching')
        expect(query!.isDisabled()).toBe(false)
        expect(client.getQueryState(folderKey)?.data).toBeDefined()
        expect(screen.queryByRole('alertdialog')).toBeNull()

        // This is App.tsx's same-session active GFS invalidation from the Preview
        // 403/404 path; it retains the production default cancelRefetch behavior.
        const invalidation = client.invalidateQueries({ ...queryFilter, refetchType: 'active' })
        await waitFor(() => expect(folderReads).toBe(4))
        expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(query)
        expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching')

        if (replacementOutcome === 'failure') rejectReplacement(replacementFailure)
        else resolveReplacement(heldPermissionResponse(['read', 'write', 'manage_acl']))
        await invalidation
        if (replacementOutcome === 'failure') {
          await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('error'))
          expect(await screen.findByRole('alertdialog')).toBeTruthy()
          expect(screen.getByText(/Could not verify permissions for Reports/i)).toBeTruthy()
        } else {
          await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('success'))
          expect(screen.queryByRole('alertdialog')).toBeNull()
        }

        // Late output from the silently canceled producer cannot overwrite the replacement.
        releaseRetry(heldPermissionResponse(['read', 'write', 'manage_acl']))
        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
        expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(query)
        expect(client.getQueryState(folderKey)?.status).toBe(
          replacementOutcome === 'failure' ? 'error' : 'success'
        )
        expect(screen.queryAllByRole('alertdialog')).toHaveLength(
          replacementOutcome === 'failure' ? 1 : 0
        )
      } finally {
        view?.unmount()
        releaseRetry?.(heldPermissionResponse(['read', 'write', 'manage_acl']))
        rejectReplacement?.(replacementFailure)
        client.clear()
        vi.useRealTimers()
      }
    }
  )
})

describe('R61 real FilesPage same-controller listing-cycle schedule', () => {
  it('does not treat a terminal fetchMore page as proof of same-cycle departure', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-r61-e44', 'Reports', { gfsUri: 'gfs://main/r61-e44' })
    )
    const report = childView('child-r61-e44', 'report.txt', 'file', {
      parentResourceId: 'folder-r61-e44',
    })
    const other = childView('other-r61-e44', 'notes.txt', 'file', {
      parentResourceId: 'folder-r61-e44',
    })
    const tail = childView('tail-r61-e44', 'tail.txt', 'file', {
      parentResourceId: 'folder-r61-e44',
    })
    const initialFirst = await listChildrenPage([report], 'old-next')
    const initialSecond = await listChildrenPage([other])
    const c2First = await listChildrenPage([other], 'c2-next')
    const c2Second = await listChildrenPage([tail], 'c2-next-2')
    const appendedTerminal = await listChildrenPage([])
    const returnedFirst = await listChildrenPage([report], 'return-next')
    const returnedTerminal = await listChildrenPage([other])
    const omittedFirst = await listChildrenPage([other], 'omit-next')
    const omittedTerminal = await listChildrenPage([])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service unavailable' },
      'child-r61-e44'
    )
    let pageMode: 'initial' | 'c2' | 'c3' | 'return' | 'omit' = 'initial'
    let permissionRecovered = false
    let releaseC3!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let markC3Started!: () => void
    const c3Started = new Promise<void>(resolve => {
      markC3Started = resolve
    })
    const c3Pending = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      releaseC3 = resolve
    })
    let childReads = 0
    const listChildren = vi.fn(async (_id: string, _drive: string, cursor?: string) => {
      if (pageMode === 'initial') return cursor === undefined ? initialFirst : initialSecond
      if (pageMode === 'c2') return cursor === undefined ? c2First : c2Second
      if (pageMode === 'c3' && cursor === undefined) {
        markC3Started()
        return c3Pending
      }
      if (pageMode === 'c3') return appendedTerminal
      if (pageMode === 'return') return cursor === undefined ? returnedFirst : returnedTerminal
      return cursor === undefined ? omittedFirst : omittedTerminal
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-r61-e44')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      childReads += 1
      return childReads === 1 || permissionRecovered
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const childrenKey = desktopQueryKeys.gfsChildren(session, 'folder-r61-e44', 'main', 0)
    const rowKey = desktopQueryKeys.gfsAffordances(session, 'child-r61-e44', 'main', 0)
    let view: { unmount: () => void } | undefined
    let pendingC3: Promise<unknown> | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r61-e44" />, { wrapper: wrapper(client) })
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(childReads).toBe(1))
      const initialListing = client.getQueryData<{
        pages: Array<Record<string, unknown>>
      }>(childrenKey)
      expect(initialListing?.pages[0]).toEqual(
        expect.objectContaining({
          __filesFullListing: true,
        })
      )
      expect(initialListing?.pages[1]).not.toHaveProperty('__filesFullListing')
      const query = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      if (!query) throw new Error('Expected actual child permission Query')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      const token = permissionErrorToken({
        id: 'row:child-r61-e44',
        message: 'permission failure',
        queryIdentity: query,
      })
      if (!token) throw new Error('Expected Query-backed error token')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(acknowledged(query, token)).toBe(true)

      // C2 completes only a two-page prefix whose last cursor is still nonterminal.
      pageMode = 'c2'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      const c2 = client.getQueryData<{
        pages: Array<{
          nextCursor: string | null
          items: Array<unknown>
          __filesFullListing?: true
        }>
      }>(childrenKey)
      expect(c2?.pages).toHaveLength(2)
      expect(c2?.pages.at(-1)?.nextCursor).toBe('c2-next-2')
      expect(c2?.pages[0]).toEqual(
        expect.objectContaining({
          __filesFullListing: true,
        })
      )
      expect(c2?.pages.every(page => page.__filesFullListing === true)).toBe(true)
      expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('idle')

      // C3 starts a distinct full listing cycle. The production fetchNextPage call
      // cancels it and appends a terminal producer page to C2's prefix.
      pageMode = 'c3'
      pendingC3 = client.refetchQueries({ exact: true, queryKey: childrenKey })
      await c3Started
      expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('fetching')
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
      await pendingC3?.catch(() => undefined)
      await waitFor(() => {
        const data = client.getQueryData<{ pages: Array<{ nextCursor: string | null }> }>(
          childrenKey
        )
        expect(data?.pages).toHaveLength(3)
        expect(data?.pages.at(-1)?.nextCursor).toBeNull()
        expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('idle')
      })
      const appended = client
        .getQueryData<{
          pages: Array<{ nextCursor: string | null; items: Array<unknown> }>
        }>(childrenKey)
        ?.pages.at(-1)
      expect(Object.keys(appended ?? {}).sort()).toEqual(['items', 'nextCursor'])

      // Reappearance and same-Query producer failure must remain acknowledged because
      // the terminal page was from fetchMore, not one complete C3 snapshot.
      pageMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(query)
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(acknowledged(query, token)).toBe(true)

      // A complete listing omission removes Files membership, but leaves the shared
      // permission Query's unresolved failure episode and its acknowledgement intact.
      pageMode = 'omit'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      const omitted = client.getQueryData<{
        pages: Array<{
          nextCursor: string | null
          items: Array<{ resourceId: string }>
        }>
      }>(childrenKey)
      expect(omitted?.pages).toHaveLength(2)
      expect(omitted?.pages.flatMap(page => page.items.map(item => item.resourceId))).not.toContain(
        'child-r61-e44'
      )
      expect(omitted?.pages[1]?.nextCursor).toBeNull()
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Options for report.txt' })).toBeNull()
      )
      pageMode = 'return'
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: childrenKey })
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(acknowledged(query, token)).toBe(true)
      expect(
        permissionErrorToken({
          id: 'row:child-r61-e44',
          message: 'permission failure',
          queryIdentity: query,
        })
      ).toBe(token)

      // A true recovery followed by a new producer failure creates a reportable token.
      permissionRecovered = true
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(client.getQueryState(rowKey)?.status).toBe('success')
      permissionRecovered = false
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      const freshToken = permissionErrorToken({
        id: 'row:child-r61-e44',
        message: 'permission failure',
        queryIdentity: query,
      })
      expect(freshToken).not.toBe(token)
    } finally {
      view?.unmount()
      releaseC3?.(appendedTerminal)
      client.clear()
    }
  })
})

describe('R61 actual Query identity and fetch metadata', () => {
  it('keeps full-refetch and fetchMore metadata attached to exact folder Queries', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const keyA = desktopQueryKeys.gfsChildren('r61-session', 'folder-A', 'main', 1)
    const keyD = desktopQueryKeys.gfsChildren('r61-session', 'folder-D', 'main', 1)
    const observations: Array<{ queryKey: readonly unknown[]; meta: unknown; pageParam: unknown }> =
      []
    const makeObserver = (queryKey: readonly unknown[], cursor: string | null) =>
      new InfiniteQueryObserver(client, {
        queryKey,
        initialPageParam: undefined as string | undefined,
        queryFn: async context => {
          const query = context.client.getQueryCache().find({ exact: true, queryKey })
          observations.push({
            queryKey: context.queryKey,
            meta: query?.state.fetchMeta,
            pageParam: context.pageParam,
          })
          return { items: [], nextCursor: context.pageParam === undefined ? cursor : null }
        },
        getNextPageParam: page => page.nextCursor ?? undefined,
      })
    const observerA = makeObserver(keyA, 'a-next')
    const observerD = makeObserver(keyD, null)
    const stopA = observerA.subscribe(() => undefined)
    const stopD = observerD.subscribe(() => undefined)
    try {
      await Promise.all([observerA.refetch(), observerD.refetch()])
      expect(client.getQueryCache().find({ exact: true, queryKey: keyA })).not.toBe(
        client.getQueryCache().find({ exact: true, queryKey: keyD })
      )
      observations.length = 0
      await observerA.fetchNextPage()
      expect(observations).toHaveLength(1)
      expect(observations[0]?.queryKey).toEqual(keyA)
      expect(observations[0]?.pageParam).toBe('a-next')
      expect(observations[0]?.meta).toMatchObject({ fetchMore: { direction: 'forward' } })
      const queryA = client.getQueryCache().find({ exact: true, queryKey: keyA })
      const queryD = client.getQueryCache().find({ exact: true, queryKey: keyD })
      expect(queryA?.state.data).toMatchObject({ pages: [{ items: [] }, { items: [] }] })
      expect(queryD?.state.data).toMatchObject({ pages: [{ items: [] }] })
    } finally {
      stopA()
      stopD()
      client.clear()
    }
  })

  it('keeps interleaved folder refetch page cycles attached to their exact Query', async () => {
    const folderA = await resolveResource(
      resolvedDirectory('folder-r61-a', 'Folder A', { gfsUri: 'gfs://main/r61-a' })
    )
    const folderD = await resolveResource(
      resolvedDirectory('folder-r61-d', 'Folder D', { gfsUri: 'gfs://main/r61-d' })
    )
    const firstA = childView('first-r61-a', 'first-a.txt', 'file', {
      parentResourceId: 'folder-r61-a',
    })
    const laterA = childView('later-r61-a', 'later-a.txt', 'file', {
      parentResourceId: 'folder-r61-a',
    })
    const childD = childView('child-r61-d', 'child-d.txt', 'file', {
      parentResourceId: 'folder-r61-d',
    })
    let holdAFirstPage = false
    let releaseAFirstPage!: () => void
    let markARefetchStarted!: () => void
    const aFirstPageGate = new Promise<void>(resolve => {
      releaseAFirstPage = resolve
    })
    const aRefetchStarted = new Promise<void>(resolve => {
      markARefetchStarted = resolve
    })
    const listChildren = vi.fn(async (resourceId: string, _drive: string, cursor?: string) => {
      if (resourceId === 'folder-r61-a') {
        if (cursor === undefined && holdAFirstPage) {
          markARefetchStarted()
          await aFirstPageGate
        }
        return cursor === undefined
          ? await listChildrenPage([firstA], 'a-next')
          : await listChildrenPage([laterA])
      }
      return await listChildrenPage([childD])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === 'gfs://main/r61-a' ? folderA : folderD)),
          listChildren,
          affordances: vi.fn(async () => heldPermissionResponse(['read'])),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const keyA = desktopQueryKeys.gfsChildren(session, 'folder-r61-a', 'main', 0)
    const keyD = desktopQueryKeys.gfsChildren(session, 'folder-r61-d', 'main', 0)
    let view: { rerender: (ui: ReactNode) => unknown; unmount: () => void } | undefined
    let pendingA: Promise<unknown> | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r61-a" />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for first-a.txt' })
      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
      await screen.findByRole('button', { name: 'Options for later-a.txt' })
      holdAFirstPage = true
      pendingA = client.refetchQueries({ exact: true, queryKey: keyA, type: 'all' })
      await aRefetchStarted

      view!.rerender(<FilesPage pendingGfsUri="gfs://main/r61-d" />)
      await screen.findByRole('button', { name: 'Options for child-d.txt' })
      const queryD = client.getQueryCache().find({ exact: true, queryKey: keyD })
      await waitFor(() => expect(queryD?.state.status).toBe('success'))

      releaseAFirstPage()
      await act(async () => {
        await pendingA
      })
      const dataA = client.getQueryData<{
        pages: Array<Record<string, unknown>>
      }>(keyA)
      const dataD = client.getQueryData<{
        pages: Array<Record<string, unknown>>
      }>(keyD)
      expect(dataA?.pages).toHaveLength(2)
      expect(dataA?.pages[0]).toEqual(
        expect.objectContaining({
          __filesFullListing: true,
        })
      )
      expect(dataA?.pages[1]).toEqual(
        expect.objectContaining({
          __filesFullListing: true,
        })
      )
      expect(dataD?.pages[0]).toEqual(
        expect.objectContaining({
          __filesFullListing: true,
        })
      )
      expect(listChildren).toHaveBeenCalledWith('folder-r61-a', 'main', 'a-next')
    } finally {
      releaseAFirstPage()
      view?.unmount()
      await pendingA?.catch(() => undefined)
      client.clear()
    }
  })
})

describe('R79 committed Files listing provenance', () => {
  it('keeps the committed membership while a full omission refetch is pending', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-r72-cycle', 'Reports', { gfsUri: 'gfs://main/r72-cycle' })
    )
    const target = childView('child-r72-cycle', 'report.txt', 'file', {
      parentResourceId: 'folder-r72-cycle',
    })
    const initialPage = await listChildrenPage([target])
    const newOmissionPage = await listChildrenPage([])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service unavailable' },
      'child-r72-cycle'
    )
    let listMode: 'initial' | 'pending-refetch' | 'omission' = 'initial'
    let releaseCurrentCycle!: (page: Awaited<ReturnType<typeof listChildrenPage>>) => void
    let releaseRowRead!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    let markCurrentCycleStarted!: () => void
    const currentCycleStarted = new Promise<void>(resolve => {
      markCurrentCycleStarted = resolve
    })
    const currentCyclePage = new Promise<Awaited<ReturnType<typeof listChildrenPage>>>(resolve => {
      releaseCurrentCycle = resolve
    })
    const pendingRowRead = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      resolve => {
        releaseRowRead = resolve
      }
    )
    let rowReads = 0
    const listChildren = vi.fn(async () => {
      if (listMode === 'pending-refetch') {
        markCurrentCycleStarted()
        return currentCyclePage
      }
      return listMode === 'initial' ? initialPage : newOmissionPage
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-r72-cycle')
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      rowReads += 1
      if (rowReads === 1)
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      if (rowReads === 3) return pendingRowRead
      return Promise.reject(new Error(denied))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances: vi.fn((resourceId: string) => produceAffordances(resourceId)),
        },
      },
    })
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const session = 'test-environment:user-1:team-1'
    const childrenKey = desktopQueryKeys.gfsChildren(session, 'folder-r72-cycle', 'main', 0)
    const rowKey = desktopQueryKeys.gfsAffordances(session, 'child-r72-cycle', 'main', 0)
    let view: { unmount: () => void } | undefined
    let pendingCurrentCycle: Promise<unknown> | undefined
    let pendingRowRefetch: Promise<unknown> | undefined
    try {
      view = render(<FilesPage pendingGfsUri="gfs://main/r72-cycle" />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(rowReads).toBe(1))
      const rowQuery = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      if (!rowQuery) throw new Error('Expected the real permission Query for the Files row')
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      const originalToken = permissionErrorToken({
        id: 'row:child-r72-cycle',
        message: 'permission service unavailable',
        queryIdentity: rowQuery,
      })
      expect(originalToken).toBeTruthy()
      const acknowledgedProjection = () =>
        getPermissionErrorsForOwner('files').acknowledged.find(
          error => error.queryIdentity === rowQuery && error.token === originalToken
        )
      expect(acknowledgedProjection()).toBeTruthy()

      // The real infinite Query retains its last complete page array until this
      // producer-backed refetch settles. React does not observe partial pages.
      listMode = 'pending-refetch'
      act(() => {
        pendingCurrentCycle = client.refetchQueries({ exact: true, queryKey: childrenKey })
        pendingRowRefetch = client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      await currentCycleStarted
      await waitFor(() => expect(rowReads).toBe(3))
      await waitFor(() => expect(client.getQueryState(childrenKey)?.fetchStatus).toBe('fetching'))
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')
      expect(
        client
          .getQueryData<{ pages: Array<{ items: Array<{ resourceId: string }> }> }>(childrenKey)
          ?.pages.flatMap(page => page.items.map(item => item.resourceId))
      ).toContain('child-r72-cycle')
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
      expect(acknowledgedProjection()).toBeTruthy()

      // A successful complete omission replaces the committed membership and
      // retires its status-slot recovery cue.
      listMode = 'omission'
      releaseCurrentCycle(newOmissionPage)
      await act(async () => {
        await pendingCurrentCycle
      })
      await waitFor(() => expect(acknowledgedProjection()).toBeUndefined())
      releaseRowRead(heldPermissionResponse(['read', 'write', 'delete']))
      await pendingRowRefetch
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
    } finally {
      releaseCurrentCycle(newOmissionPage)
      releaseRowRead(heldPermissionResponse(['read', 'write', 'delete']))
      view?.unmount()
      await pendingCurrentCycle?.catch(() => undefined)
      await pendingRowRefetch?.catch(() => undefined)
      client.clear()
    }
  })
})
