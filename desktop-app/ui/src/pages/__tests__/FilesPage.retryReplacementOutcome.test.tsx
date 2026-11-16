// Producer-backed FilesPage replacement outcome control; the App integration test covers R73 D5(b).
// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { desktopQueryKeys, hasGfsSessionGeneration } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
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

function wrapper(client: QueryClient) {
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={authValue}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
  }
}

function ToastingFilesPage({ pendingGfsUri }: { pendingGfsUri: string }) {
  const toast = useToastController()
  return (
    <>
      <FilesPage pendingGfsUri={pendingGfsUri} pushToast={toast.pushToast} />
      <ToastStack items={toast.toasts} onDismiss={toast.dismissToast} />
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('R59 real QueryClient handoff and failure visibility', () => {
  it('maps replacement failure to the user-visible Retry outcome', async () => {
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
      if (folderReads === 1)
        return Promise.resolve(heldPermissionResponse(['read', 'write', 'manage_acl']))
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
      view = render(<ToastingFilesPage pendingGfsUri="gfs://main/r58" />, {
        wrapper: wrapper(client),
      })
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
      expect(document.querySelectorAll('.toast-body')).toHaveLength(0)

      rejectReplacement(replacementFailure)
      await invalidation
      await waitFor(() => expect(client.getQueryState(folderKey)?.status).toBe('error'))
      expect(await screen.findByRole('alertdialog')).toBeTruthy()
      expect(screen.getByText(/Could not verify permissions for Reports/i)).toBeTruthy()
      expect(
        [...document.querySelectorAll('.toast-body')]
          .map(node => node.textContent)
          .filter(text => text === describeGfsReadError(replacementFailure).message)
      ).toHaveLength(1)

      // Late output from the silently canceled producer cannot overwrite the replacement.
      releaseRetry(heldPermissionResponse(['read', 'write', 'manage_acl']))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(client.getQueryCache().find({ exact: true, queryKey: folderKey })).toBe(query)
      expect(client.getQueryState(folderKey)?.status).toBe('error')
      expect(screen.queryAllByRole('alertdialog')).toHaveLength(1)
    } finally {
      view?.unmount()
      releaseRetry?.(heldPermissionResponse(['read', 'write', 'manage_acl']))
      rejectReplacement?.(replacementFailure)
      client.clear()
      vi.useRealTimers()
    }
  })
})
