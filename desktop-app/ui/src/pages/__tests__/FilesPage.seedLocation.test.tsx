// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createEmptyWorkspaceTabsState, openFilesTab, setFilesTabPath } from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
import { FilesPage } from '../FilesPage'

// This suite mounts the REAL FilesPage on the REAL useGfsBrowserController (T1:
// the location the tab persists is produced by the actual seed → openUri →
// breadcrumb round-trip, never a hand-crafted controller fixture). Only the leaf
// IPC boundary (`window.clerum.gfs.resolve`) is stubbed, and it is a deferred so
// the async load window — where the mount reports its pre-seed location — is
// observable. The harness reproduces App's files render seam (mini-spec 06 §3):
// one keyed FilesPage seeded from the active tab's persisted path, whose
// onLocationChange writes back through `setFilesTabPath`.

const AUTHED_USER = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'User One',
  picture: null,
  teamId: 'team-1',
  teamName: 'Team One',
  role: 'member' as const,
}

function authValue(): AuthContextValue {
  return {
    booting: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: true,
    me: AUTHED_USER,
    email: AUTHED_USER.email,
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

const SEED_URI = 'gfs://main/aaa'

/** App's files render seam, reduced to the tab-persistence contract under test. */
function FilesTabHarness() {
  const [state, setState] = useState<WorkspaceTabsState>(() => {
    let next = createEmptyWorkspaceTabsState()
    // A non-root files tab, already persisted at a live gfsUri (as if reopened
    // from a prior session / focused by a deep-link).
    next = openFilesTab(next, { id: 'files-1', path: SEED_URI, title: 'Reports' })
    return next
  })

  const activeIdRef = useRef<string | null>('files-1')
  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  const activeFilesTab = activeTab?.kind === 'files' ? activeTab : undefined
  activeIdRef.current = activeFilesTab?.id ?? null

  // Seed captured once per active tab id (App uses a ref; here the id is stable).
  const seedPath = activeFilesTab?.files?.path ?? null

  const handleLocationChange = (gfsUri: string | null, name: string | null) => {
    const id = activeIdRef.current
    if (!id) return
    setState(prev => setFilesTabPath(prev, id, gfsUri, name ?? undefined))
  }

  return (
    <>
      {state.tabs.map(tab => (
        <div key={tab.id} data-testid={`tab-${tab.id}`}>
          {`${tab.files?.path ?? 'null'}|${tab.title}`}
        </div>
      ))}
      {activeFilesTab && (
        <FilesPage
          key={activeFilesTab.id}
          pendingGfsUri={seedPath}
          onLocationChange={handleLocationChange}
        />
      )}
    </>
  )
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider value={authValue()}>
      <QueryClientProvider client={client}>
        <FilesTabHarness />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

describe('FilesPage seed → onLocationChange round-trip (mini-spec 06 §3)', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('keeps the seeded path/title during the async load, then reflects the live location', async () => {
    // Deferred resolve: hold the seed's openUri open so the load window is observable.
    let resolveSeed!: (resource: unknown) => void
    const seedResolve = new Promise<unknown>(resolve => {
      resolveSeed = resolve
    })

    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(() => seedResolve),
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

    renderHarness()

    // Load window: the breadcrumb stack has NOT resolved yet, so FilesPage's
    // `current` is still the virtual root. The tab MUST retain its seeded path and
    // title — the pre-seed root must not be persisted over it (the bug: it was
    // clobbered to `null` / 'Files').
    const tab = () => screen.getByTestId('tab-files-1').textContent
    expect(tab()).toBe(`${SEED_URI}|Reports`)
    // Give React a couple of microtask/effect flushes to prove it stays put.
    await act(async () => {
      await Promise.resolve()
    })
    expect(tab()).toBe(`${SEED_URI}|Reports`)

    // Seed lands: the live location (folder name from the resolve) is now reported
    // and reflected on the tab.
    await act(async () => {
      resolveSeed({
        resourceId: 'rid-aaa',
        gfsUri: SEED_URI,
        name: 'Q4 Reports',
        kind: 'directory',
        version: 3,
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(tab()).toBe(`${SEED_URI}|Q4 Reports`))
  })
})
