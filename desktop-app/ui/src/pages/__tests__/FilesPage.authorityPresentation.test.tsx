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
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  resolveResource,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { desktopQueryKeys } from '@/hooks/domain/queryKeys'
import { delegationAffordances } from '../../../../src/gfs/delegation'
import { FilesPage } from '../FilesPage'

const SESSION_SCOPE = ':user-a:team-a'
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
