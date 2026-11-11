// @vitest-environment jsdom
import { useLayoutEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  affordancesFailureMessage,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilesPage } from '../FilesPage'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const FOLDER_URI = 'gfs://main/aaa'
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

function QueryLayoutCommitProbe({
  client,
  onCommit,
}: {
  client: QueryClient
  onCommit: () => void
}) {
  const querySnapshot = useSyncExternalStore(
    listener => client.getQueryCache().subscribe(listener),
    () =>
      client
        .getQueryCache()
        .getAll()
        .map(query => `${query.queryHash}:${query.state.status}:${query.state.errorUpdateCount}`)
        .join('|'),
    () => ''
  )
  useLayoutEffect(() => onCommit(), [onCommit, querySnapshot])
  return null
}

function wrapper(client: QueryClient, onLayoutCommit?: () => void) {
  const clerum = (window as unknown as { clerum?: Record<string, unknown> }).clerum
  if (clerum) {
    const auth = (clerum.auth ?? {}) as Record<string, unknown>
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        ...clerum,
        auth: {
          ...auth,
          getSessionGeneration:
            typeof auth.getSessionGeneration === 'function'
              ? auth.getSessionGeneration
              : vi.fn(async () => 0),
        },
      },
    })
  }
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={client}>
          {children}
          {onLayoutCommit ? (
            <QueryLayoutCommitProbe client={client} onCommit={onLayoutCommit} />
          ) : null}
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
}

describe('FilesPage stale permission action oracle', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    focusManager.setFocused(undefined)
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('routes a settled child-row 401 to session revocation without a local permission dialog', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const authorityError = await affordancesFailureMessage(
      401,
      { code: 'unauthorized', message: 'The session is not authorized.' },
      'child-report'
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') throw new Error(authorityError)
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const localDialogAtAuthorityErrorCommit: boolean[] = []
    const observeQueryCommit = vi.fn(() => {
      const query = client.getQueryCache().find({
        exact: true,
        queryKey: desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'child-report',
          'main',
          0
        ),
      })
      if (query?.state.status === 'error') {
        localDialogAtAuthorityErrorCommit.push(
          document.querySelector('[role="alertdialog"]') !== null
        )
      }
    })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
        wrapper: wrapper(client, observeQueryCommit),
      })
      await screen.findByText('File access is not authorized')
      expect(localDialogAtAuthorityErrorCommit.length).toBeGreaterThan(0)
      expect(localDialogAtAuthorityErrorCommit.every(present => !present)).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Retry file access' })).toBeTruthy()
      expect(affordances).toHaveBeenCalledWith('child-report', 'main')
    } finally {
      client.clear()
    }
  })

  it.each(['success', 'failure'] as const)(
    'keeps a retained row error ineligible until authority revalidation reenables its query (%s)',
    async outcome => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const report = childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      })
      const children = await listChildrenPage([report])
      let releaseDiscovery!: (value: Awaited<ReturnType<typeof listAccessiblePage>>) => void
      let rejectRow!: (reason: Error) => void
      const discovery = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
        releaseDiscovery = resolve
      })
      let releaseRow!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      const rowRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        (resolve, reject) => {
          releaseRow = resolve
          rejectRow = reject
        }
      )
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'child-report') return rowRefresh
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(() => discovery),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const rowKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'child-report',
        'main',
        0
      )
      try {
        await expect(
          client.fetchQuery({
            queryKey: rowKey,
            queryFn: async () => {
              throw new Error('403 Forbidden: resource_access_denied httpStatus=403')
            },
            retry: false,
            staleTime: 0,
          })
        ).rejects.toThrow('resource_access_denied')
        const retainedQuery = client.getQueryCache().find({ queryKey: rowKey, exact: true })
        expect(retainedQuery?.state.status).toBe('error')
        const rowQueryIdentity = retainedQuery

        render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
        await screen.findByRole('status', { name: 'Loading files' })
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(
          rowQueryIdentity
        )
        expect(affordances).not.toHaveBeenCalledWith('child-report', 'main')

        await act(async () => {
          releaseDiscovery(await listAccessiblePage([]))
          await discovery
        })
        await screen.findByText('report.txt')
        await waitFor(() => expect(affordances).toHaveBeenCalledWith('child-report', 'main'))
        expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(
          rowQueryIdentity
        )
        expect(screen.queryByRole('alertdialog')).toBeNull()
        expect(
          screen.queryByRole('status', { name: /Checking permissions for report.txt/ })
        ).toBeTruthy()

        if (outcome === 'success') {
          await act(async () => {
            releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
            await rowRefresh
          })
          await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('success'))
          expect(screen.queryByRole('alertdialog')).toBeNull()
        } else {
          await act(async () => {
            rejectRow(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
            await rowRefresh.catch(() => undefined)
          })
          await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
          expect(await screen.findByRole('alertdialog')).toBeTruthy()
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBeGreaterThan(1)
        }
        expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)
      } finally {
        releaseDiscovery(await listAccessiblePage([]))
        releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
        client.clear()
      }
    }
  )

  it('keeps cached permission data plus its error ineligible while the row observer is disabled', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let releaseDiscovery!: (value: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const discovery = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      releaseDiscovery = resolve
    })
    let releaseRow!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    let rejectRow!: (error: Error) => void
    const rowRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (resolve, reject) => {
        releaseRow = resolve
        rejectRow = reject
      }
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') return rowRefresh
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(() => discovery),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    try {
      await client.fetchQuery({
        queryKey: rowKey,
        queryFn: async () => heldPermissionResponse(['read', 'write', 'delete']),
        retry: false,
        staleTime: 0,
      })
      await expect(
        client.fetchQuery({
          queryKey: rowKey,
          queryFn: async () => {
            throw new Error('403 Forbidden: resource_access_denied httpStatus=403')
          },
          retry: false,
          staleTime: 0,
        })
      ).rejects.toThrow('resource_access_denied')
      const retained = client.getQueryCache().find({ exact: true, queryKey: rowKey })
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()

      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('status', { name: 'Loading files' })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(retained)
      expect(affordances).not.toHaveBeenCalledWith('child-report', 'main')

      await act(async () => {
        releaseDiscovery(await listAccessiblePage([]))
        await discovery
      })
      await screen.findByText('report.txt')
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('child-report', 'main'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(
        screen.getByRole('status', { name: /Checking permissions for report.txt/ })
      ).toBeTruthy()
      expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(retained)
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')

      await act(async () => {
        rejectRow(new Error('403 Forbidden: resource_access_denied httpStatus=403'))
        await rowRefresh.catch(() => undefined)
      })
      await screen.findByRole('alertdialog')
      expect(client.getQueryState(rowKey)?.status).toBe('error')
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)
    } finally {
      releaseDiscovery(await listAccessiblePage([]))
      releaseRow(heldPermissionResponse(['read', 'write', 'delete']))
      rejectRow(new Error('cleanup'))
      client.clear()
    }
  })

  it('reports a second row refetch inside the open permission dialog', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-a', 'a.txt', 'file', { parentResourceId: 'folder-active' })
    const reportB = childView('child-b', 'b.txt', 'file', { parentResourceId: 'folder-active' })
    const children = await listChildrenPage([reportA, reportB])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-a'
    )
    const deniedB = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-b'
    )
    let reportBReads = 0
    let releaseRefresh!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    const refresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(resolve => {
      releaseRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'child-a') return Promise.reject(new Error(denied))
      if (resourceId === 'child-b') {
        reportBReads += 1
        return reportBReads === 1 ? Promise.reject(new Error(deniedB)) : refresh
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const errorKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-a',
      'main',
      0
    )
    const refetchKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-b',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for b.txt' })
      const dialog = await screen.findByRole('alertdialog')
      await waitFor(() => expect(client.getQueryState(errorKey)?.status).toBe('error'))
      await waitFor(() => expect(client.getQueryState(refetchKey)?.status).toBe('error'))
      await waitFor(() => expect(reportBReads).toBe(1))
      const errorQuery = client.getQueryCache().find({ queryKey: errorKey, exact: true })
      const errorGeneration = client.getQueryState(errorKey)?.errorUpdateCount
      const refetchQuery = client.getQueryCache().find({ queryKey: refetchKey, exact: true })
      const refetchErrorGeneration = client.getQueryState(refetchKey)?.errorUpdateCount
      expect(within(dialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(dialog).getByText(/Could not verify permissions for b.txt/)).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({ exact: true, queryKey: refetchKey })
      })
      await waitFor(() => expect(reportBReads).toBe(2))

      const pendingDialog = screen.getByRole('alertdialog')
      expect(pendingDialog).toBe(dialog)
      expect(within(pendingDialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(pendingDialog).queryByText(/Could not verify permissions for b.txt/)).toBeNull()
      expect(
        within(pendingDialog).getByRole('status', { name: 'Checking permissions for b.txt' })
      ).toBeTruthy()
      expect(screen.getAllByRole('status')).toHaveLength(1)
      expect(client.getQueryCache().find({ queryKey: errorKey, exact: true })).toBe(errorQuery)
      expect(client.getQueryState(errorKey)?.errorUpdateCount).toBe(errorGeneration)
      expect(client.getQueryCache().find({ queryKey: refetchKey, exact: true })).toBe(refetchQuery)
      expect(client.getQueryState(refetchKey)?.errorUpdateCount).toBe(refetchErrorGeneration)
      expect(client.getQueryState(refetchKey)?.fetchStatus).toBe('fetching')

      await act(async () => {
        releaseRefresh(heldPermissionResponse(['read', 'write', 'delete']))
        await refresh
      })
      await waitFor(() => expect(client.getQueryState(refetchKey)?.status).toBe('success'))
      expect(screen.getByRole('alertdialog')).toBe(dialog)
      expect(within(dialog).getByText(/Could not verify permissions for a.txt/)).toBeTruthy()
      expect(within(dialog).queryByRole('status')).toBeNull()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-b')).toHaveLength(2)
    } finally {
      releaseRefresh(heldPermissionResponse(['read', 'write', 'delete']))
      client.clear()
    }
  })

  it.each(['success', 'failure'] as const)(
    'projects a current-folder refetch inside the Files permission dialog (%s)',
    async outcome => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const report = childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      })
      const children = await listChildrenPage([report])
      let folderReads = 0
      let releaseFolder!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
      let rejectFolder!: (error: Error) => void
      const pendingFolder = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
        (resolve, reject) => {
          releaseFolder = resolve
          rejectFolder = reject
        }
      )
      const folderError = await affordancesFailureMessage(
        429,
        { code: 'rate_limited', message: 'Too Many Requests' },
        'folder-active'
      )
      const rowError = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-report'
      )
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'folder-active') {
          folderReads += 1
          if (folderReads === 1 || outcome === 'failure') throw new Error(folderError)
          return pendingFolder
        }
        if (resourceId === 'child-report') throw new Error(rowError)
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      const folderKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      const rowKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'child-report',
        'main',
        0
      )
      try {
        render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
        const dialog = await screen.findByRole('alertdialog')
        await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('error'))
        await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
        expect(
          within(dialog).getByText(/Too many file requests\. Wait before retrying permissions/)
        ).toBeTruthy()
        expect(
          within(dialog).getByText(/Could not verify permissions for report\.txt/)
        ).toBeTruthy()
        const folderQuery = client.getQueryCache().find({ exact: true, queryKey: folderKey })
        const rowQuery = client.getQueryCache().find({ exact: true, queryKey: rowKey })
        const folderGeneration = client.getQueryState(folderKey)?.errorUpdateCount
        const rowGeneration = client.getQueryState(rowKey)?.errorUpdateCount

        await act(async () => {
          void client.refetchQueries({ exact: true, queryKey: folderKey })
        })
        await waitFor(() => expect(folderReads).toBe(2))
        if (outcome === 'success') {
          await waitFor(() => expect(client.getQueryState(folderKey)?.fetchStatus).toBe('fetching'))
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(
            within(dialog).getByRole('status', { name: 'Checking permissions for Reports' })
          ).toBeTruthy()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
          expect(client.getQueryState(folderKey)?.errorUpdateCount).toBe(folderGeneration)
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(rowGeneration)
          expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(
            folderQuery
          )
          expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
          expect(affordances.mock.calls.filter(([id]) => id === 'folder-active')).toHaveLength(2)
          expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(1)

          await act(async () => {
            releaseFolder(heldPermissionResponse(['read', 'write', 'delete']))
            await pendingFolder
          })
          await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('success'))
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(within(dialog).queryByRole('status')).toBeNull()
          expect(
            within(dialog).queryByText(/Too many file requests\. Wait before retrying permissions/)
          ).toBeNull()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
        } else {
          await waitFor(() => expect(client.getQueryState(folderKey)?.fetchStatus).toBe('idle'))
          await waitFor(() =>
            expect(client.getQueryState(folderKey)?.errorUpdateCount).toBeGreaterThan(
              folderGeneration ?? 0
            )
          )
          expect(screen.getByRole('alertdialog')).toBe(dialog)
          expect(within(dialog).queryByRole('status')).toBeNull()
          expect(
            within(dialog).getByText(/Too many file requests\. Wait before retrying permissions/)
          ).toBeTruthy()
          expect(
            within(dialog).getByText(/Could not verify permissions for report\.txt/)
          ).toBeTruthy()
          expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(
            folderQuery
          )
          expect(client.getQueryCache().find({ exact: true, queryKey: rowKey })).toBe(rowQuery)
          expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(rowGeneration)
        }
      } finally {
        releaseFolder(heldPermissionResponse(['read', 'write', 'delete']))
        client.clear()
      }
    }
  )

  it.each(['same-commit', 'staggered'] as const)(
    'aggregates distinct child-row permission failures without row Retry controls (%s)',
    async completionOrder => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const reportA = childView('child-a', 'a.txt', 'file', { parentResourceId: 'folder-active' })
      const reportB = childView('child-b', 'b.txt', 'file', { parentResourceId: 'folder-active' })
      const children = await listChildrenPage([reportA, reportB])
      let rejectSecond: (error: Error) => void = () => undefined
      const deniedA = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-a'
      )
      const deniedB = await affordancesFailureMessage(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'child-b'
      )
      const secondPermissionCheck =
        completionOrder === 'staggered'
          ? new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>((_resolve, reject) => {
              rejectSecond = reject
            })
          : null
      const affordances = vi.fn(async (resourceId: string) => {
        if (resourceId === 'child-a') throw new Error(deniedA)
        if (resourceId === 'child-b') {
          if (completionOrder === 'same-commit') throw new Error(deniedB)
          return secondPermissionCheck as Promise<
            Awaited<ReturnType<typeof heldPermissionResponse>>
          >
        }
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      try {
        render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
        await screen.findByRole('button', { name: 'Options for b.txt' })
        const dialog = await screen.findByRole('alertdialog')
        await waitFor(() =>
          expect(
            client.getQueryState(
              desktopQueryKeys.gfsAffordances(
                'test-environment:user-1:team-1',
                'child-a',
                'main',
                0
              )
            )?.status
          ).toBe('error')
        )
        expect(within(dialog).getByText(/Could not verify permissions for a\.txt/)).toBeTruthy()
        if (completionOrder === 'staggered') {
          expect(within(dialog).queryByText(/Could not verify permissions for b\.txt/)).toBeNull()
          await act(async () => {
            rejectSecond(new Error(deniedB))
            await secondPermissionCheck?.catch(() => undefined)
          })
        } else {
          await waitFor(() =>
            expect(
              client.getQueryState(
                desktopQueryKeys.gfsAffordances(
                  'test-environment:user-1:team-1',
                  'child-b',
                  'main',
                  0
                )
              )?.status
            ).toBe('error')
          )
        }
        const aggregate = await screen.findByRole('alertdialog')
        expect(aggregate).toBe(dialog)
        expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
        expect(within(aggregate).getByText(/Could not verify permissions for a\.txt/)).toBeTruthy()
        expect(within(aggregate).getByText(/Could not verify permissions for b\.txt/)).toBeTruthy()
        expect(
          within(aggregate).queryByRole('button', { name: 'Retry permission check' })
        ).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
        expect(affordances.mock.calls.filter(([id]) => id === 'child-a')).toHaveLength(1)
        expect(affordances.mock.calls.filter(([id]) => id === 'child-b')).toHaveLength(1)
      } finally {
        if (completionOrder === 'staggered') rejectSecond(new Error(deniedB))
        client.clear()
      }
    }
  )

  it('shows a new Files row error generation after a same-Query remount', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let reportReads = 0
    let rejectRemount!: (error: Error) => void
    const remountRefresh = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (_resolve, reject) => {
        rejectRemount = reject
      }
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      }
      reportReads += 1
      if (reportReads === 1)
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      if (reportReads === 2) return Promise.reject(new Error(denied))
      if (reportReads === 3) return remountRefresh
      return Promise.reject(new Error(denied))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    let view: { unmount: () => void } | undefined
    try {
      view = render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(reportReads).toBe(1))
      const queryIdentity = client.getQueryCache().find({ queryKey: rowKey, exact: true })
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      const dialog = await screen.findByRole('alertdialog')
      const errorGeneration = client.getQueryState(rowKey)?.errorUpdateCount
      expect(client.getQueryState(rowKey)?.data).toBeTruthy()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      view.unmount()
      view = render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(reportReads).toBe(3))
      expect(client.getQueryState(rowKey)?.fetchStatus).toBe('fetching')
      expect(client.getQueryState(rowKey)?.errorUpdateCount).toBe(errorGeneration)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)
      await act(async () => {
        rejectRemount(new Error(denied))
        await remountRefresh.catch(() => undefined)
      })
      await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
      await screen.findByRole('alertdialog')
      expect(client.getQueryCache().find({ queryKey: rowKey, exact: true })).toBe(queryIdentity)
      expect(client.getQueryState(rowKey)?.errorUpdateCount).toBeGreaterThan(errorGeneration ?? 0)
      expect(reportReads).toBe(3)
    } finally {
      rejectRemount(new Error('cleanup'))
      view?.unmount()
      client.clear()
    }
  })

  it('defers and restores a Files permission alert around the existing Rename form', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-rename', 'rename.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const reportB = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([reportA, reportB])
    const denied = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    let reportReads = 0
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
      }
      reportReads += 1
      return reportReads === 1
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.reject(new Error(denied))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const renameResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const rowKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'child-report',
      'main',
      0
    )
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for rename.txt' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for rename.txt' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
      const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
      expect(renameResource).not.toHaveBeenCalled()

      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: rowKey })
      })
      await waitFor(() => expect(client.getQueryState(rowKey)?.status).toBe('error'))
      expect(renameForm.isConnected).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()

      fireEvent.click(within(renameForm).getByRole('button', { name: 'Cancel rename' }))
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      expect(screen.getByText(/Could not verify permissions for report.txt/)).toBeTruthy()
      expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
      expect(renameResource).not.toHaveBeenCalled()
      expect(affordances.mock.calls.filter(([id]) => id === 'child-report')).toHaveLength(2)
    } finally {
      client.clear()
    }
  })

  it('suspends an already visible Files permission alert while Rename takes focus', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const reportA = childView('child-rename', 'rename.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const reportB = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([reportA, reportB])
    const deniedB = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'child-report'
    )
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') throw new Error(deniedB)
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const renameResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for rename.txt' })
      const permissionDialog = await screen.findByRole('alertdialog')
      expect(
        within(permissionDialog).getByText(/Could not verify permissions for report\.txt/)
      ).toBeTruthy()

      // Model the existing action continuation winning after the permission dialog has committed.
      fireEvent.click(screen.getByRole('button', { name: 'Options for rename.txt' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for rename.txt' })).getByRole('menuitem', {
          name: 'Rename',
        })
      )
      const renameForm = await screen.findByRole('form', { name: 'Rename resource' })
      await waitFor(() => expect(document.activeElement?.closest('form')).toBe(renameForm))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('dialog', { name: 'Rename rename.txt' })).toBeNull()
      expect(renameResource).not.toHaveBeenCalled()

      fireEvent.click(within(renameForm).getByRole('button', { name: 'Cancel rename' }))
      const restoredDialog = await screen.findByRole('alertdialog')
      expect(restoredDialog).toBeTruthy()
      expect(
        within(restoredDialog).getByText(/Could not verify permissions for report\.txt/)
      ).toBeTruthy()
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
      expect(renameResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })

  it('revalidates an expired row permission through the rendered action menu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') reportPermissionReads += 1
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()

    // Expiry alone is not a fetch trigger. Opening the real menu mounts the
    // selected-row observer, which must refresh this exact resource first.
    vi.setSystemTime(Date.now() + 16_000)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))

    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
    })
    await waitFor(() => expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy())
    expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'New name' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('keeps a stale row action visible while its exact permission is rechecked on use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const denied = delegationAffordances(new Set(['read']), false)
    let denyPermissionCheck!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const deniedPermission = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(
      resolve => {
        denyPermissionCheck = resolve
      }
    )
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(delegationAffordances(new Set(['read']), false))
      }
      reportPermissionReads += 1
      return reportPermissionReads === 2
        ? deniedPermission
        : Promise.resolve(delegationAffordances(new Set(['read', 'write']), false))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))

    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(reportPermissionReads).toBe(1)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    expect(screen.queryByText('Permissions will be checked when you use an action.')).toBeNull()
    expect(screen.queryByText('Checking permissions for report.txt…')).toBeNull()
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect(reportPermissionReads).toBe(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
    const renameAction = within(menu).getByRole('menuitem', { name: 'Rename' })
    fireEvent.click(renameAction)
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await act(async () => {
      denyPermissionCheck(denied)
      await deniedPermission
    })

    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(renameResource).not.toHaveBeenCalled()
    expect(reportPermissionReads).toBe(2)
    client.clear()
  })

  it('waits for exact fresh row authority before opening a stale permission editor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let resolveRevalidation!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const revalidation = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(resolve => {
      resolveRevalidation = resolve
    })
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn((resourceId: string) => {
      if (resourceId !== 'child-report') {
        return Promise.resolve(delegationAffordances(new Set(['read']), false))
      }
      reportPermissionReads += 1
      return reportPermissionReads === 2
        ? revalidation
        : Promise.resolve(delegationAffordances(new Set(['read', 'write']), false))
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))

    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    expect(reportPermissionReads).toBe(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rename report.txt' }))
    })
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Checking permissions for report.txt' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()

    await act(async () => {
      resolveRevalidation(delegationAffordances(new Set(['read', 'write']), false))
      await revalidation
    })
    expect(screen.getByRole('form', { name: 'Rename resource' })).toBeTruthy()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('removes stale row actions after the exact resource is no longer found', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId !== 'child-report') {
        return delegationAffordances(new Set(['read']), false)
      }
      reportPermissionReads += 1
      if (reportPermissionReads > 1) {
        throw new Error('404 Not Found: resource unavailable httpStatus=404')
      }
      return delegationAffordances(new Set(['read', 'write']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const { rerender } = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    vi.setSystemTime(Date.now() + 16_000)
    rerender(<FilesPage pendingGfsUri={FOLDER_URI} />)
    expect(reportPermissionReads).toBe(1)
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Rename report.txt' }))
    await waitFor(() => expect(reportPermissionReads).toBe(2))
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('refreshes invalidated row authority when FilesPage remounts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    let reportPermissionReads = 0
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'child-report') {
        reportPermissionReads += 1
        return reportPermissionReads === 1
          ? delegationAffordances(new Set(['read', 'write', 'delete']), false)
          : delegationAffordances(new Set(['read']), false)
      }
      return delegationAffordances(new Set(['read']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          renameResource: vi.fn(async () => undefined),
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const firstMount = render(<FilesPage pendingGfsUri={FOLDER_URI} />, {
      wrapper: wrapper(client),
    })
    await screen.findByText('report.txt')
    await waitFor(() => expect(reportPermissionReads).toBe(1))
    expect(screen.getByRole('button', { name: 'Rename report.txt' })).toBeTruthy()

    firstMount.unmount()
    await act(async () => {
      // Match the preview mutation's prefix invalidation while the row query is inactive.
      await client.invalidateQueries({ queryKey: desktopQueryKeys.gfsRoot })
    })
    vi.setSystemTime(Date.now() + 1_000)

    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByText('report.txt')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rename report.txt' })).toBeNull()
    )
    expect(reportPermissionReads).toBe(2)
    client.clear()
  })

  it('reuses twenty row presentations on folder re-entry and rechecks one stale row on use', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const nestedFolder = childView('nested-folder', 'Subfolder', 'directory', {
      parentResourceId: 'folder-active',
    })
    const reportsChildren = await listChildrenPage([nestedFolder])
    const rows = Array.from({ length: 20 }, (_, index) =>
      childView(`child-${index}`, `report-${index}.txt`, 'file', {
        parentResourceId: 'nested-folder',
      })
    )
    const nestedChildren = await listChildrenPage(rows)
    const rowReads = new Map<string, number>()
    const staleRowAnnouncementCount = () =>
      screen
        .getAllByRole('button', { name: /^Open report-\d+\.txt$/ })
        .filter(row =>
          within(row).queryByText('Permissions will be checked when you use an action.')
        ).length
    const renameResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId.startsWith('child-')) {
        const reads = (rowReads.get(resourceId) ?? 0) + 1
        rowReads.set(resourceId, reads)
        if (resourceId === 'child-0' && reads > 1) {
          return delegationAffordances(new Set(['read']), false)
        }
      }
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    const listChildren = vi.fn(async (resourceId: string) =>
      resourceId === 'folder-active' ? reportsChildren : nestedChildren
    )
    const rootFolder = accessibleResource('folder-active', 'Reports', 'directory', {
      gfsUri: FOLDER_URI,
      permissions: ['read'],
      coversDescendants: true,
    })
    const accessible = await listAccessiblePage([rootFolder])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => accessible),
          resolve: vi.fn(async () => folder),
          listChildren,
          affordances,
          renameResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Reports' })
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }))
    await screen.findByRole('button', { name: 'Subfolder' })
    fireEvent.click(screen.getByRole('button', { name: 'Subfolder' }))
    await screen.findByText('report-0.txt')
    await waitFor(() => {
      expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    })
    expect(rowReads.size).toBe(20)
    expect([...rowReads.values()].every(reads => reads === 1)).toBe(true)

    vi.setSystemTime(Date.now() + 16_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    expect(staleRowAnnouncementCount()).toBe(0)

    vi.setSystemTime(Date.now() + 20_000)
    const breadcrumbs = within(screen.getByRole('navigation', { name: 'File location' }))
    fireEvent.click(breadcrumbs.getByRole('button', { name: 'Reports' }))
    await screen.findByRole('button', { name: 'Subfolder' })
    fireEvent.click(screen.getByRole('button', { name: 'Subfolder' }))
    await screen.findByText('report-0.txt')
    expect(
      listChildren.mock.calls.filter(([resourceId]) => resourceId === 'nested-folder').length
    ).toBeGreaterThanOrEqual(2)
    expect(rowReads.size).toBe(20)
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(20)
    expect([...rowReads.values()].every(reads => reads === 1)).toBe(true)
    expect(staleRowAnnouncementCount()).toBe(0)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for report-0.txt' }))
    })
    const menu = screen.getByRole('menu', { name: 'Actions for report-0.txt' })
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
    })
    await waitFor(() => expect(rowReads.get('child-0')).toBe(2))
    expect([...rowReads.values()].reduce((sum, reads) => sum + reads, 0)).toBe(21)
    expect(screen.queryByRole('form', { name: 'Rename resource' })).toBeNull()
    expect(renameResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('keeps current-folder actions presented during a background permission refetch', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([])
    let permissionReads = 0
    let releaseRefresh!: (value: Awaited<ReturnType<typeof delegationAffordances>>) => void
    const refreshResult = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(
      resolve => {
        releaseRefresh = resolve
      }
    )
    const permissions = delegationAffordances(
      new Set(['read', 'write', 'delete', 'manage_acl']),
      false
    )
    const affordances = vi.fn(() => {
      permissionReads += 1
      return permissionReads === 1 ? Promise.resolve(permissions) : refreshResult
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(permissionReads).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))

    await act(async () => {
      void client.refetchQueries({
        exact: true,
        queryKey: desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'folder-active',
          'main',
          0
        ),
      })
    })
    await waitFor(() => expect(permissionReads).toBe(2))

    const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'New folder' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()

    await act(async () => {
      releaseRefresh(permissions)
      await refreshResult
    })
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Rename',
      })
    ).toBeTruthy()
    client.clear()
  })

  it('keeps child-row Move presented while its current-folder authority refresh is pending', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const report = childView('child-report', 'report.txt', 'file', {
      parentResourceId: 'folder-active',
    })
    const children = await listChildrenPage([report])
    const permissionResponse = heldPermissionResponse(['read', 'write', 'delete'])
    let folderReads = 0
    let releaseFolderRefresh!: (value: typeof permissionResponse) => void
    const folderRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseFolderRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'folder-active') return Promise.resolve(permissionResponse)
      folderReads += 1
      return folderReads === 1 ? Promise.resolve(permissionResponse) : folderRefresh
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByText('report.txt')
      await waitFor(() => expect(folderReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({
          exact: true,
          queryKey: desktopQueryKeys.gfsAffordances(
            'test-environment:user-1:team-1',
            'folder-active',
            'main',
            0
          ),
        })
      })
      await waitFor(() => expect(folderReads).toBe(2))

      const pendingMenu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(pendingMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
      fireEvent.click(within(pendingMenu).getByRole('menuitem', { name: 'Move to' }))
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()

      await act(async () => {
        releaseFolderRefresh(permissionResponse)
        await folderRefresh
      })
      expect(await screen.findByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()
    } finally {
      await act(async () => {
        releaseFolderRefresh(permissionResponse)
        await Promise.resolve()
      })
      client.clear()
    }
  })

  it('keeps current-folder Move presented while its source-parent authority refresh is pending', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const sourceParent = await resolveResource(resolvedDirectory('source-parent', 'Shared folder'))
    const children = await listChildrenPage([])
    const permissionResponse = heldPermissionResponse(['read', 'write', 'delete'])
    let sourceParentReads = 0
    let releaseSourceParentRefresh!: (value: typeof permissionResponse) => void
    const sourceParentRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseSourceParentRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'source-parent') return Promise.resolve(permissionResponse)
      sourceParentReads += 1
      return sourceParentReads === 1 ? Promise.resolve(permissionResponse) : sourceParentRefresh
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(sourceParentReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
      expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()

      await act(async () => {
        void client.refetchQueries({
          exact: true,
          queryKey: desktopQueryKeys.gfsAffordances(
            'test-environment:user-1:team-1',
            'source-parent',
            'main',
            0
          ),
        })
      })
      await waitFor(() => expect(sourceParentReads).toBe(2))

      const pendingMenu = screen.getByRole('menu', { name: 'Actions for Reports' })
      expect(within(pendingMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
      fireEvent.click(within(pendingMenu).getByRole('menuitem', { name: 'Move to' }))
      expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()

      await act(async () => {
        releaseSourceParentRefresh(permissionResponse)
        await sourceParentRefresh
      })
      expect(await screen.findByRole('dialog', { name: 'Move folder Reports' })).toBeTruthy()
    } finally {
      await act(async () => {
        releaseSourceParentRefresh(permissionResponse)
        await Promise.resolve()
      })
      client.clear()
    }
  })

  it.each([
    { missing: 'write', held: ['read', 'delete'] },
    { missing: 'delete', held: ['read', 'write'] },
  ])(
    'does not open Move when fresh source-parent authority lacks $missing',
    async ({ missing, held }) => {
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', {
          gfsUri: FOLDER_URI,
          parentResourceId: 'source-parent',
        })
      )
      const sourceParent = await resolveResource(
        resolvedDirectory('source-parent', 'Shared folder')
      )
      const children = await listChildrenPage([])
      const destinations = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', { permissions: ['read'] }),
      ])
      let currentSourceBits = ['read', 'write', 'delete']
      const produceAffordances = appServiceAffordanceProducer(resourceId =>
        Promise.resolve(
          heldPermissionResponse(
            resourceId === 'source-parent' ? currentSourceBits : ['read', 'write', 'delete']
          )
        )
      )
      const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
      const moveResource = vi.fn(async () => undefined)
      const pushToast = vi.fn()
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => destinations),
            resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
            listChildren: vi.fn(async () => children),
            affordances,
            moveResource,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      try {
        render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
          wrapper: wrapper(client),
        })
        await screen.findByRole('button', { name: 'Options for Reports' })
        const sourceParentKey = desktopQueryKeys.gfsAffordances(
          'test-environment:user-1:team-1',
          'source-parent',
          'main',
          0
        )
        await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
        fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
        expect(await screen.findByRole('menuitem', { name: 'Move to' })).toBeTruthy()

        await act(async () => {
          await client.invalidateQueries({
            exact: true,
            queryKey: sourceParentKey,
            refetchType: 'none',
          })
        })
        currentSourceBits = held
        fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))

        await waitFor(() =>
          expect(pushToast).toHaveBeenCalledWith(
            `You do not have ${missing} access to the source folder.`,
            'error'
          )
        )
        expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
        expect(moveResource).not.toHaveBeenCalled()
      } finally {
        client.clear()
      }
    }
  )

  it('does not grant a role bit removed from fresh authority at submit time', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([])
    let currentHeldBits = ['read', 'write', 'manage_acl']
    const produceAffordances = appServiceAffordanceProducer(() =>
      Promise.resolve(heldPermissionResponse(currentHeldBits))
    )
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const grant = vi.fn(async () => undefined)
    const listGrants = vi.fn(async () => [])
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        agents: {
          listMine: vi.fn(async () => [
            {
              name: 'chatllm',
              contextRef: 'ctx-1',
              mcpServers: [],
              gfsSubject: { type: 'host', id: '1st:mcp-host/chatllm' },
            },
          ]),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          listGrants,
          listShares: vi.fn(async () => []),
          listInheritedAccess: vi.fn(async () => ({ items: [], nextCursor: null })),
          grant,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Options for Reports' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Share$/ }))
      const shareMenu = await screen.findByRole('menu', { name: 'Share options for Reports' })
      fireEvent.click(within(shareMenu).getByRole('menuitem', { name: 'Share' }))
      await screen.findByRole('dialog', { name: 'Share folder Reports' })

      const picker = await screen.findByRole('combobox', {
        name: 'Add people, teams, or agents',
      })
      fireEvent.focus(picker)
      fireEvent.click(await screen.findByRole('option', { name: /chatllm/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Access role for selected recipients' }))
      fireEvent.click(screen.getByRole('option', { name: 'Editor' }))
      await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))

      const permissionKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await act(async () => {
        await client.invalidateQueries({
          exact: true,
          queryKey: permissionKey,
          refetchType: 'none',
        })
      })
      currentHeldBits = ['read', 'manage_acl']
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Share folder Reports' })).getByRole('button', {
          name: 'Share',
        })
      )

      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith('You can no longer grant write on Reports.', 'error')
      )
      expect(grant).not.toHaveBeenCalled()
      expect(listGrants).toHaveBeenCalledTimes(1)
      expect(pushToast).not.toHaveBeenCalledWith('Access granted to 1 subject', 'success')
    } finally {
      client.clear()
    }
  })

  it('denies Files Move without destination write even when the source parent permits it', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const sourceParent = await resolveResource(resolvedDirectory('source-parent', 'Shared folder'))
    const destinations = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', { permissions: ['read'] }),
    ])
    const children = await listChildrenPage([])
    const produceAffordances = appServiceAffordanceProducer(resourceId =>
      resourceId === 'source-parent'
        ? Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
        : Promise.resolve(heldPermissionResponse(['read']))
    )
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => destinations),
          resolve: vi.fn(async (uri: string) => (uri === FOLDER_URI ? folder : sourceParent)),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move folder Reports' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('uses the current folder parent for Move and does not show an idle denial', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([])
    const permissions = vi.fn(async (resourceId: string) =>
      resourceId === 'source-parent'
        ? delegationAffordances(new Set(['read', 'write', 'delete']), false)
        : delegationAffordances(new Set(['read']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances: permissions,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(permissions).toHaveBeenCalledWith('source-parent', 'main'))

    expect(
      screen.queryByText(/Move is unavailable because you need write and delete access/)
    ).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    })
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Move to',
      })
    ).toBeTruthy()
    client.clear()
  })

  it('keeps the source-parent Move candidate and reports bounded 429 retry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([])
    let sourceParentReads = 0
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'source-parent'
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'source-parent') {
        sourceParentReads += 1
        if (sourceParentReads === 2) return Promise.reject(rateLimited)
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
      wrapper: wrapper(client),
    })
    await screen.findByRole('button', { name: 'Options for Reports' })
    await waitFor(() => expect(sourceParentReads).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    expect(
      within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
        name: 'Move to',
      })
    ).toBeTruthy()

    const sourceKey = desktopQueryKeys.gfsAffordances(
      'test-environment:user-1:team-1',
      'source-parent',
      'main',
      0
    )
    await act(async () => {
      await client.refetchQueries({ exact: true, queryKey: sourceKey })
    })
    await waitFor(() => expect(sourceParentReads).toBe(2))

    const sourceError = String(client.getQueryState(sourceKey)?.error)
    expect(sourceError).toContain('httpStatus=429')
    expect(sourceError).toContain('retryAfterSeconds=7')
    expect(screen.getAllByText(/Could not verify Move permissions:/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    const menuAfterError = screen.queryByRole('menu', { name: 'Actions for Reports' })
    const moveItem = menuAfterError
      ? within(menuAfterError).queryByRole('menuitem', { name: 'Move to' })
      : null
    expect(moveItem).toBeTruthy()
    if (moveItem) fireEvent.click(moveItem)
    expect
      .soft(pushToast)
      .toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
    expect(moveResource).not.toHaveBeenCalled()
    expect(sourceParentReads).toBe(2)

    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    await waitFor(() =>
      expect(pushToast).toHaveBeenLastCalledWith(
        'Too many file requests — try again in 7s.',
        'error'
      )
    )
    expect(sourceParentReads).toBe(2)
    expect(moveResource).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 7_000)
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
    await waitFor(() => expect(sourceParentReads).toBe(3))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()
    client.clear()
  })

  it('keeps a child Move candidate visible after the current-folder check returns 429', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const rateLimited = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'folder-active'
    )
    let rejectCurrentCheck = false
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'folder-active' && rejectCurrentCheck) {
        rejectCurrentCheck = false
        return Promise.reject(rateLimited)
      }
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} pushToast={pushToast} />, {
        wrapper: wrapper(client),
      })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('folder-active', 'main'))

      const currentFolderKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      rejectCurrentCheck = true
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: currentFolderKey })
      })
      await waitFor(() => expect(client.getQueryState(currentFolderKey)?.status).toBe('error'))
      expect(String(client.getQueryState(currentFolderKey)?.error)).toContain('httpStatus=429')

      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const moveItem = within(
        screen.getByRole('menu', { name: 'Actions for report.txt' })
      ).getByRole('menuitem', { name: 'Move to' })
      expect(moveItem).toBeTruthy()
      fireEvent.click(moveItem)
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
      )
      expect(screen.queryByRole('dialog', { name: 'Move file report.txt' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })

  it('keeps the latest Move target when source checks finish out of order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', {
        gfsUri: FOLDER_URI,
        parentResourceId: 'source-parent',
      })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const accessible = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        path: '/Archive',
        permissions: ['read', 'write'],
      }),
    ])
    let deferSourceParentCheck = false
    const sourceParentCheckRelease: { current: (() => void) | null } = { current: null }
    let markSourceParentCheckStarted!: () => void
    let markSourceParentCheckFinished!: () => void
    const sourceParentCheckStarted = new Promise<void>(resolve => {
      markSourceParentCheckStarted = resolve
    })
    const sourceParentCheckFinished = new Promise<void>(resolve => {
      markSourceParentCheckFinished = resolve
    })
    const sourceParentCheckGate = new Promise<void>(resolve => {
      sourceParentCheckRelease.current = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === 'source-parent' && deferSourceParentCheck) {
        deferSourceParentCheck = false
        markSourceParentCheckStarted()
        await sourceParentCheckGate
        markSourceParentCheckFinished()
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => accessible),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async resourceId =>
            resourceId === 'folder-active' ? children : listChildrenPage([])
          ),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))

      vi.setSystemTime(Date.now() + 16_000)
      deferSourceParentCheck = true
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for Reports' })).getByRole('menuitem', {
          name: 'Move to',
        })
      )
      await sourceParentCheckStarted

      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      fireEvent.click(
        within(screen.getByRole('menu', { name: 'Actions for report.txt' })).getByRole('menuitem', {
          name: 'Move to',
        })
      )
      expect(await screen.findByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()

      await act(async () => {
        sourceParentCheckRelease.current?.()
        await sourceParentCheckFinished
      })

      expect(screen.getByRole('dialog', { name: 'Move file report.txt' })).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: 'Move folder Reports' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      sourceParentCheckRelease.current?.()
      client.clear()
    }
  })

  it('keeps an idle current-folder 503 out of the page alert surface (R8-L5)', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
    )
    const children = await listChildrenPage([
      childView('child-report', 'report.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const serviceFailure = await affordancesFailureMessage(
      503,
      { code: 'upstream_unavailable', message: 'private permission upstream detail' },
      'folder-active'
    )
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId === 'folder-active') return Promise.reject(new Error(serviceFailure))
      return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => children),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for report.txt' })
      const currentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await waitFor(() => expect(client.getQueryState(currentKey)?.status).toBe('error'))

      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.queryByText(/private permission upstream detail/)).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Options for report.txt' }))
      const menu = screen.getByRole('menu', { name: 'Actions for report.txt' })
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    } finally {
      client.clear()
    }
  })

  it.each([403, 404])(
    'withholds current-folder permission actions after HTTP %i and preserves identity actions',
    async status => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const folder = await resolveResource(
        resolvedDirectory('folder-active', 'Reports', { gfsUri: FOLDER_URI })
      )
      const children = await listChildrenPage([])
      let currentPermissionReads = 0
      const denied = Object.assign(
        new Error(
          status === 403
            ? '403 Forbidden: resource_access_denied'
            : '404 Not Found: resource_not_found'
        ),
        { status }
      )
      const produceAffordances = appServiceAffordanceProducer(resourceId => {
        if (resourceId === 'folder-active') {
          currentPermissionReads += 1
          if (currentPermissionReads > 1) return Promise.reject(denied)
        }
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'delete', 'manage_acl']))
      })
      const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => folder),
            listChildren: vi.fn(async () => children),
            affordances,
          },
        },
      })

      const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
      render(<FilesPage pendingGfsUri={FOLDER_URI} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Reports' })
      await waitFor(() => expect(currentPermissionReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))

      const menu = screen.getByRole('menu', { name: 'Actions for Reports' })
      const identityActions = () =>
        within(screen.getByRole('menu', { name: 'Share options for Reports' }))
          .getAllByRole('menuitem')
          .map(item => item.textContent?.trim())
          .filter(label => label === 'Copy link' || label === 'Copy folder ID')
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
      const identityActionsBefore = identityActions()
      expect(identityActionsBefore).toEqual(['Copy link', 'Copy folder ID'])
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share' }))
      expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()

      vi.setSystemTime(Date.now() + 16_000)
      const currentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'folder-active',
        'main',
        0
      )
      await act(async () => {
        await client.refetchQueries({ exact: true, queryKey: currentKey })
      })
      await waitFor(() => expect(currentPermissionReads).toBe(2))
      expect(String(client.getQueryState(currentKey)?.error)).toContain(`httpStatus=${status}`)
      expect(screen.getByText(/Could not verify permissions for Reports:/)).toBeTruthy()
      expect(screen.queryByText(/resource_access_denied|resource_not_found/)).toBeNull()

      const currentMenu = screen.getByRole('menu', { name: 'Actions for Reports' })
      const actionsAfterDenial = within(currentMenu)
        .getAllByRole('menuitem')
        .map(item => item.textContent?.trim())
      expect(actionsAfterDenial).not.toContain('Rename')
      expect(actionsAfterDenial).not.toContain('New folder')
      expect(actionsAfterDenial).not.toContain('Upload file')
      expect(actionsAfterDenial).not.toContain('Delete')
      fireEvent.click(within(currentMenu).getByRole('menuitem', { name: 'Share' }))
      const shareMenu = screen.getByRole('menu', { name: 'Share options for Reports' })
      expect(within(shareMenu).queryByRole('menuitem', { name: 'Share' })).toBeNull()
      expect(identityActions()).toEqual(identityActionsBefore)
      client.clear()
    }
  )

  it('keeps a shared-with-me row actionable after its list permission goes stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const sharedFolder = accessibleResource('shared-folder', 'Shared folder', 'directory', {
      gfsUri: 'gfs://main/0123456789abcdef0123456789abcdef',
      path: '/Shared folder',
      permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
    })
    const accessiblePage = await listAccessiblePage([sharedFolder])
    const listAccessible = vi.fn(async () => accessiblePage)
    const affordances = vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    render(<FilesPage pendingGfsUri={null} />, { wrapper: wrapper(client) })
    await screen.findByRole('button', { name: 'Options for Shared folder' })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Rename Shared folder' })).toBeTruthy()

    vi.setSystemTime(Date.now() + 16_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Shared folder' }))
    })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('shared-folder', 'main'))

    const menu = screen.getByRole('menu', { name: 'Actions for Shared folder' })
    expect.soft(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    client.clear()
  })

  it('shows one retryable source-parent error for shared rows and retries permission only', async () => {
    const sharedFiles = await listAccessiblePage([
      accessibleResource('shared-file-a', 'Shared A.txt', 'file', {
        parentResourceId: 'shared-source-parent',
        permissions: ['read'],
      }),
      accessibleResource('shared-file-b', 'Shared B.txt', 'file', {
        parentResourceId: 'shared-source-parent',
        permissions: ['read'],
      }),
    ])
    const sourceParentError = await affordancesFailureMessage(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'shared-source-parent'
    )
    let sourceParentReads = 0
    const produceAffordances = appServiceAffordanceProducer(resourceId => {
      if (resourceId !== 'shared-source-parent') {
        return Promise.resolve(heldPermissionResponse(['read']))
      }
      sourceParentReads += 1
      return sourceParentReads === 1
        ? Promise.reject(new Error(sourceParentError))
        : Promise.resolve(heldPermissionResponse(['read', 'write', 'delete']))
    })
    const affordances = vi.fn((resourceId: string) => produceAffordances(resourceId))
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => sharedFiles),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
          moveResource,
        },
      },
    })

    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    try {
      render(<FilesPage pendingGfsUri={null} />, { wrapper: wrapper(client) })
      await screen.findByRole('button', { name: 'Options for Shared A.txt' })
      await screen.findByRole('button', { name: 'Options for Shared B.txt' })
      fireEvent.click(screen.getByRole('button', { name: 'Options for Shared A.txt' }))

      const sourceParentKey = desktopQueryKeys.gfsAffordances(
        'test-environment:user-1:team-1',
        'shared-source-parent',
        'main',
        0
      )
      await waitFor(() => expect(sourceParentReads).toBe(1))
      await waitFor(() => expect(client.getQueryState(sourceParentKey)?.status).toBe('error'))
      const sourceParentCalls = () =>
        affordances.mock.calls.filter(([resourceId]) => resourceId === 'shared-source-parent')

      const permissionDialog = screen.getByRole('alertdialog', {
        name: 'Could not verify EvenDrive permissions',
      })
      expect(within(permissionDialog).getByText(/Could not verify Move permissions:/)).toBeTruthy()
      expect(screen.getByText(/Could not verify Move permissions:/)).toBeTruthy()
      expect(screen.getAllByRole('button', { name: 'Retry permission check' })).toHaveLength(1)
      const menu = screen.getByRole('menu', { name: 'Actions for Shared A.txt' })
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
      expect(moveResource).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(sourceParentReads).toBe(2))
      await waitFor(() => expect(client.getQueryState(sourceParentKey)?.status).toBe('success'))

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(sourceParentCalls()).toHaveLength(2)
      expect(sourceParentCalls()).toEqual([
        ['shared-source-parent', 'main'],
        ['shared-source-parent', 'main'],
      ])
      expect(
        within(screen.getByRole('menu', { name: 'Actions for Shared A.txt' })).getByRole(
          'menuitem',
          { name: 'Move to' }
        )
      ).toBeTruthy()
      expect(moveResource).not.toHaveBeenCalled()
    } finally {
      client.clear()
    }
  })
})
