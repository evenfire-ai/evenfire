// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import { listAccessiblePage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { ComposerGlobalFilesModal } from '../ComposerGlobalFilesModal'

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

const queryClients: QueryClient[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installGfsBridge(listAccessible: typeof window.clerum.gfs.listAccessible) {
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
}

function renderPicker(queryClient: QueryClient) {
  queryClients.push(queryClient)
  return render(
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={queryClient}>
        <ComposerGlobalFilesModal attachedIds={[]} onAdd={vi.fn()} onClose={vi.fn()} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  queryClients.forEach(queryClient => queryClient.clear())
  queryClients.length = 0
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('ComposerGlobalFilesModal controller revalidation', () => {
  it('keeps the rendered empty picker state during an authorized cached-empty refetch', async () => {
    const emptyPage = await listAccessiblePage([])
    const initialResponse = deferred<typeof emptyPage>()
    const refreshResponse = deferred<typeof emptyPage>()
    const listAccessible = vi
      .fn<typeof window.clerum.gfs.listAccessible>()
      .mockImplementationOnce(() => initialResponse.promise)
      .mockImplementationOnce(() => refreshResponse.promise)
    installGfsBridge(listAccessible)

    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    renderPicker(queryClient)

    await waitFor(() => {
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })
    expect(screen.getByRole('status').textContent).toContain('Loading files')
    expect(screen.queryByText('No shared files yet')).toBeNull()

    await act(async () => initialResponse.resolve(emptyPage))
    const emptyState = await screen.findByText('No shared files yet')
    const picker = screen.getByRole('dialog')
    const browser = picker.querySelector('.composer-global-files-browser')
    expect(browser).not.toBeNull()
    expect(queryClient.getQueryData(ACCESSIBLE_KEY)).toMatchObject({ pages: [{ items: [] }] })
    expect(screen.queryByRole('status')).toBeNull()

    await act(async () => {
      void queryClient.invalidateQueries({ exact: true, queryKey: ACCESSIBLE_KEY })
    })
    await waitFor(() => {
      expect(listAccessible).toHaveBeenCalledTimes(2)
      expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('fetching')
    })

    // This is a preservation test: the same behavior is correct at the prior
    // head. The connected-node assertion is the negative control for a return
    // to the initial spinner while this real query is unresolved.
    expect(emptyState.isConnected).toBe(true)
    expect(screen.getByText('No shared files yet')).toBe(emptyState)
    expect(screen.queryByRole('status')).toBeNull()
    expect(browser?.getAttribute('aria-busy')).not.toBe('true')

    await act(async () => refreshResponse.resolve(emptyPage))
    await waitFor(() => expect(queryClient.getQueryState(ACCESSIBLE_KEY)?.fetchStatus).toBe('idle'))
    expect(emptyState.isConnected).toBe(true)
    expect(screen.getByText('No shared files yet')).toBe(emptyState)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
