// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  accessibleResource,
  homeView,
  listAccessiblePage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { useGfsBrowserController } from '../useGfsBrowserController'

/**
 * The recent-files query on the browser controller (D2, D20). It is opt-in, so
 * the composer modal and the sidebar tree never spend a request on it, and the
 * whole server list is kept — the card pages it, the controller never re-sorts.
 */

const user = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member' as const,
}

function authValue(): AuthContextValue {
  return {
    booting: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    me: user,
    email: user.email,
    password: '',
    desktopSetupAuthorizationToken: '',
    desktopSetupStarted: false,
    desktopEnvironmentSetupComplete: true,
    runtimeConfigSetupName: '',
    runtimeConfigSetupExternalRestApiBaseUrl: '',
    runtimeConfigSetupRpcProxyBaseUrl: '',
    authTransitioning: false,
    runtimeConfigState: null,
    desktopReleaseStatus: null,
    pendingDesktopEnvironmentSetup: null,
    backendSwitchHint: null,
    runtimeConfigMissing: false,
    showRuntimeConfigSelector: false,
    dependencyHealth: null,
    hasDependencyOutage: false,
    setBooting: vi.fn(),
    setEmail: vi.fn(),
    setPassword: vi.fn(),
    setDesktopSetupAuthorizationToken: vi.fn(),
    setDesktopEnvironmentSetupComplete: vi.fn(),
    setPendingDesktopEnvironmentSetup: vi.fn(),
    setRuntimeConfigSetupName: vi.fn(),
    setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
    setRuntimeConfigSetupRpcProxyBaseUrl: vi.fn(),
    setStatus: vi.fn(),
    loadSession: vi.fn(),
    handlePasswordLogin: vi.fn(),
    handleSwitchLoginBackend: vi.fn(),
    handleStartDesktopSetup: vi.fn(),
    handleCompleteDesktopSetup: vi.fn(),
    handleSaveRuntimeConfig: vi.fn(),
    handleDeleteRuntimeConfig: vi.fn(),
    handleSelectRuntimeConfig: vi.fn(),
    handleClearRuntimeConfigSelection: vi.fn(),
    handleCancelDesktopEnvironmentSetup: vi.fn(),
    handleConfirmDesktopEnvironmentSetup: vi.fn(),
    handleOpenDesktopRelease: vi.fn(),
    handleLogout: vi.fn(),
  }
}

function recentFile(index: number) {
  return {
    resourceId: `recent-${index}`,
    gfsUri: `gfs://main/recent-${index}`,
    drive: 'main',
    name: `recent-${index}.txt`,
    version: 1,
    bytes: 4,
    lastActivityAt: new Date(Date.UTC(2026, 9, 30, 10, 0, index)).toISOString(),
  }
}

function Probe({ enabled }: { enabled: boolean }) {
  const ctrl = useGfsBrowserController({ recentFilesEnabled: enabled })
  return (
    <>
      <div data-testid="count">{ctrl.recentFiles.length}</div>
      <div data-testid="names">{ctrl.recentFiles.map(file => file.name).join(',')}</div>
      <div data-testid="loading">{ctrl.loadingRecentFiles ? 'loading' : 'idle'}</div>
      <div data-testid="fetching">{ctrl.fetchingRecentFiles ? 'fetching' : 'idle'}</div>
      <div data-testid="failure">{ctrl.recentFilesFailure?.kind ?? 'none'}</div>
      <button type="button" onClick={() => ctrl.refreshRecentFiles()}>
        refresh recent
      </button>
      <button type="button" onClick={() => ctrl.retryRecentFiles()}>
        retry recent
      </button>
    </>
  )
}

function install(gfs: Record<string, unknown>) {
  Object.defineProperty(window, 'clerum', { configurable: true, value: { gfs } })
}

function renderProbe(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={authValue()}>
      <QueryClientProvider client={client}>
        <Probe enabled={enabled} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

function bridge(over: Record<string, unknown> = {}) {
  return {
    getHome: vi.fn(async () => homeView()),
    listAccessible: vi.fn(async () => listAccessiblePage([])),
    listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
    resolve: vi.fn(),
    affordances: vi.fn(async () => ({
      held: [],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    })),
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useGfsBrowserController recent files', () => {
  it('asks for nothing unless the caller opts in', async () => {
    const listRecent = vi.fn(async () => ({ items: [recentFile(0)] }))
    install(bridge({ listRecent }))

    renderProbe(false)

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('idle'))
    expect(listRecent).not.toHaveBeenCalled()
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('keeps the server order and the whole list, and pages nothing itself', async () => {
    const files = Array.from({ length: 100 }, (_, index) => recentFile(index))
    const listRecent = vi.fn(async () => ({ items: files }))
    install(bridge({ listRecent }))

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('100'))
    expect(screen.getByTestId('names').textContent?.startsWith('recent-0.txt,recent-1.txt')).toBe(
      true
    )
    expect(listRecent).toHaveBeenCalledWith('main')
  })

  it('tracks the refetch flag and refetches on refreshRecentFiles', async () => {
    const listRecent = vi.fn(async () => ({ items: [recentFile(0)] }))
    install(bridge({ listRecent }))
    renderProbe()

    await waitFor(() => expect(listRecent).toHaveBeenCalledTimes(1))
    // The flag is only meaningful once the first request settled.
    await waitFor(() => expect(screen.getByTestId('fetching').textContent).toBe('idle'))

    act(() => {
      screen.getByRole('button', { name: 'refresh recent' }).click()
    })

    // Witness: the refresh really re-requested, and the flag followed it.
    await waitFor(() => expect(listRecent).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('fetching').textContent).toBe('idle'))
  })

  it('classifies a 404 as unsupported rather than failed', async () => {
    const listRecent = vi.fn(async () => {
      throw new Error("Error invoking remote method 'gfs:listRecent': Error: 404 Not Found")
    })
    install(bridge({ listRecent }))

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('failure').textContent).toBe('unsupported'))
  })

  it('surfaces a missing bridge method as a failure instead of an empty list', async () => {
    install(bridge())

    renderProbe()

    await waitFor(() => expect(screen.getByTestId('failure').textContent).toBe('failed'))
    expect(screen.getByTestId('count').textContent).toBe('0')
  })

  it('withholds the rows while authority is being re-proved', async () => {
    const listRecent = vi.fn(async () => ({ items: [recentFile(0)] }))
    let resolveAccessible!: (page: Awaited<ReturnType<typeof listAccessiblePage>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof listAccessiblePage>>>(resolve => {
      resolveAccessible = resolve
    })
    install(
      bridge({
        listRecent,
        listAccessible: vi.fn(() => pending),
      })
    )

    renderProbe()

    await waitFor(() => expect(listRecent).toHaveBeenCalled())
    // The list is loaded, but the session has not re-proved itself yet.
    expect(screen.getByTestId('count').textContent).toBe('0')

    await act(async () => {
      resolveAccessible(
        await listAccessiblePage([
          accessibleResource('folder-a', 'Folder A', 'directory', {
            sources: ['grant'],
            permissions: ['read'],
            coversDescendants: true,
          }),
        ])
      )
    })

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'))
  })
})
