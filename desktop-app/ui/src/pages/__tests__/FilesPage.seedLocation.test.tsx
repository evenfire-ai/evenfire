// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import type { GfsPreviewResource } from '@lib/gfsPreview'
import {
  createEmptyWorkspaceTabsState,
  openFilesTab,
  selectWorkspaceTab,
  setFilesTabPath,
} from '@lib/workspaceTabs'
import type { WorkspaceTabsState } from '@lib/workspaceTabs.types'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
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
const DEEP_LINK_URI = 'gfs://main/0123456789abcdef0123456789abcdef'
const INACTIVE_URI = 'gfs://main/inactive-files-tab'

/** App's files render seam, reduced to the tab-persistence contract under test. */
function FilesTabHarness({
  remoteGfsChangeEpoch = 0,
  pendingGfsDeepLink,
  pendingGfsUri,
  isPendingGfsDeepLinkCurrent,
  onExplicitNavigationIntent,
  onPendingGfsDeepLinkOutcome,
  onOpenPreview,
  onOpenPendingGfsPreview,
  includeInactiveTab = false,
}: {
  remoteGfsChangeEpoch?: number
  pendingGfsDeepLink?: { id: number; uri: string } | null
  pendingGfsUri?: string | null
  isPendingGfsDeepLinkCurrent?: () => boolean
  onExplicitNavigationIntent?: () => void
  onPendingGfsDeepLinkOutcome?: (
    id: number,
    outcome: 'opened' | 'terminal' | 'retryable' | 'superseded'
  ) => void
  onOpenPreview?: (preview: GfsPreviewResource) => void
  onOpenPendingGfsPreview?: (
    id: number,
    preview: GfsPreviewResource,
    returnLocation: { gfsUri: string | null; name: string | null }
  ) => boolean
  includeInactiveTab?: boolean
}) {
  useWindowFocusBridge()
  const queryClient = useQueryClient()
  const [state, setState] = useState<WorkspaceTabsState>(() => {
    let next = createEmptyWorkspaceTabsState()
    // A non-root files tab, already persisted at a live gfsUri (as if reopened
    // from a prior session / focused by a deep-link).
    next = openFilesTab(next, { id: 'files-1', path: SEED_URI, title: 'Reports' })
    if (includeInactiveTab) {
      next = openFilesTab(next, { id: 'files-inactive', path: INACTIVE_URI, title: 'Inactive' })
      next = selectWorkspaceTab(next, 'files-1')
    }
    return next
  })

  const activeIdRef = useRef<string | null>('files-1')
  const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
  const activeFilesTab = activeTab?.kind === 'files' ? activeTab : undefined
  activeIdRef.current = activeFilesTab?.id ?? null

  // Seed captured once per active tab id (App uses a ref; here the id is stable).
  const seedPath = activeFilesTab?.files?.path ?? null

  useEffect(() => {
    if (remoteGfsChangeEpoch === 0) return
    void queryClient.invalidateQueries({
      queryKey: desktopQueryKeys.gfsRoot,
      refetchType: 'active',
    })
  }, [queryClient, remoteGfsChangeEpoch])

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
          workspaceTabId={activeFilesTab.id}
          pendingGfsUri={pendingGfsUri !== undefined ? pendingGfsUri : seedPath}
          pendingGfsDeepLink={pendingGfsDeepLink}
          pendingGfsDeepLinkOwnerTabId={pendingGfsDeepLink ? activeFilesTab.id : undefined}
          isPendingGfsDeepLinkCurrent={isPendingGfsDeepLinkCurrent}
          onExplicitNavigationIntent={onExplicitNavigationIntent}
          onPendingGfsDeepLinkOutcome={onPendingGfsDeepLinkOutcome}
          onOpenPreview={onOpenPreview}
          onOpenPendingGfsPreview={onOpenPendingGfsPreview}
          onLocationChange={handleLocationChange}
          {...({ remoteGfsChangeEpoch } as Record<string, number>)}
        />
      )}
    </>
  )
}

function renderHarness(
  props: {
    includeInactiveTab?: boolean
    pendingGfsDeepLink?: { id: number; uri: string } | null
    pendingGfsUri?: string | null
    isPendingGfsDeepLinkCurrent?: () => boolean
    onExplicitNavigationIntent?: () => void
    onPendingGfsDeepLinkOutcome?: (
      id: number,
      outcome: 'opened' | 'terminal' | 'retryable' | 'superseded'
    ) => void
    onOpenPreview?: (preview: GfsPreviewResource) => void
    onOpenPendingGfsPreview?: (
      id: number,
      preview: GfsPreviewResource,
      returnLocation: { gfsUri: string | null; name: string | null }
    ) => boolean
  } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    client,
    ...render(
      <AuthContext.Provider value={authValue()}>
        <QueryClientProvider client={client}>
          <FilesTabHarness {...props} />
        </QueryClientProvider>
      </AuthContext.Provider>
    ),
  }
}

describe('FilesPage seed → onLocationChange round-trip (mini-spec 06 §3)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('uses the shared permission freshness window only for the active Files tab', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: SEED_URI })
    )
    const resolve = vi.fn(async (uri: string) => {
      if (uri === SEED_URI) return folder
      if (uri === INACTIVE_URI) {
        return resolveResource(
          resolvedDirectory('folder-inactive', 'Inactive', { gfsUri: INACTIVE_URI })
        )
      }
      throw new Error(`unexpected test resource URI: ${uri}`)
    })
    const affordances = vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
        },
      },
    })

    const { client, unmount } = renderHarness({ includeInactiveTab: true })
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('folder-active', 'main'))
    const activeReads = () => affordances.mock.calls.length
    expect(activeReads()).toBe(1)
    expect(resolve).not.toHaveBeenCalledWith(INACTIVE_URI)

    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(activeReads()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_001)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(activeReads()).toBe(2)
    expect(resolve).not.toHaveBeenCalledWith(INACTIVE_URI)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(activeReads()).toBe(2)
    client.clear()
  })

  it('keeps Files Move open while checking both parents and denies a revoked source', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: SEED_URI })
    )
    const children = await listChildrenPage([
      childView('notes-file', 'notes.txt', 'file', {
        parentResourceId: 'folder-active',
      }),
    ])
    const destinations = await listAccessiblePage([
      accessibleResource('archive-folder', 'Archive', 'directory'),
    ])
    let sourceCalls = 0
    let finishSourceRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    const moveResource = vi.fn(async () => undefined)
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'folder-active') {
        sourceCalls += 1
        if (sourceCalls === 2) {
          return new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
            finishSourceRefresh = resolve
          })
        }
      }
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => destinations),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'folder-active' ? children : listChildrenPage([])
          ),
          affordances,
          moveResource,
        },
      },
    })

    renderHarness()
    await waitFor(() => expect(sourceCalls).toBe(1))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.txt' }))
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file notes.txt' })
    await act(async () => {
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    })

    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()
    await waitFor(() => expect(sourceCalls).toBe(2))
    expect(moveResource).not.toHaveBeenCalled()

    await act(async () => {
      finishSourceRefresh(delegationAffordances(new Set(['read', 'delete']), false))
    })
    expect(
      await within(dialog).findByText(
        'You do not have write and delete access to the source folder.'
      )
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('hides current-folder mutations while real permission refresh is pending or rate limited', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-active', 'Reports', { gfsUri: SEED_URI })
    )
    let permissionCalls = 0
    let rejectRefresh!: (error: Error) => void
    const pendingRefresh = new Promise<ReturnType<typeof delegationAffordances>>((_, reject) => {
      rejectRefresh = reject
    })
    const affordances = vi.fn(() => {
      permissionCalls += 1
      if (permissionCalls === 1) {
        return Promise.resolve(
          delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
        )
      }
      return pendingRefresh
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => folder),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
          listGrants: vi.fn(async () => []),
          listShares: vi.fn(async () => []),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        agents: { listMine: vi.fn(async () => []) },
      },
    })

    const { client } = renderHarness()
    await waitFor(() => expect(permissionCalls).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId('tab-files-1').textContent).toBe(`${SEED_URI}|Reports`)
    )
    const sessionScope = ':user-1:team-1'
    await waitFor(() =>
      expect(
        client.getQueryData(desktopQueryKeys.gfsAccessible(sessionScope, 'main'))
      ).toBeDefined()
    )
    await waitFor(() =>
      expect(
        client.getQueryData(desktopQueryKeys.gfsAffordances(sessionScope, 'folder-active', 'main'))
      ).toBeDefined()
    )

    const key = desktopQueryKeys.gfsAffordances(sessionScope, 'folder-active', 'main')
    await act(async () => {
      void client.invalidateQueries({ exact: true, queryKey: key, refetchType: 'active' })
    })
    await waitFor(() => expect(permissionCalls).toBe(2))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for Reports' }))
    })
    const folderActions = within(screen.getByRole('menu', { name: 'Actions for Reports' }))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'New folder' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Upload file' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    fireEvent.click(folderActions.getByRole('menuitem', { name: 'Share' }))
    const folderShareOptions = within(
      screen.getByRole('menu', { name: 'Share options for Reports' })
    )
    expect(folderShareOptions.queryByRole('menuitem', { name: 'Share' })).toBeNull()
    expect(screen.getByText('Checking permissions for Reports…')).toBeTruthy()

    await act(async () => {
      rejectRefresh(new Error('429 Too Many Requests'))
      await Promise.resolve()
    })
    expect(
      await screen.findByText(/Could not verify permissions for Reports.*Too many file requests/i)
    ).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'New folder' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Upload file' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    expect(folderShareOptions.queryByRole('menuitem', { name: 'Share' })).toBeNull()
    client.clear()
  })

  it('fails closed for a shared file opened in Manage while current permissions are pending or failed', async () => {
    const resourceId = '0123456789abcdef0123456789abcdef'
    const parentResourceId = 'abcdef0123456789abcdef0123456789'
    const fileUri = `gfs://main/${resourceId}`
    const row = accessibleResource(resourceId, 'notes.bin', 'file', {
      gfsUri: fileUri,
      parentResourceId,
      permissions: ['read', 'write', 'delete', 'manage_acl', 'share'],
    })
    const file = await resolveResource(
      resolvedFile(resourceId, 'notes.bin', { gfsUri: fileUri, parentResourceId })
    )
    const parent = await resolveResource(
      resolvedDirectory(parentResourceId, 'Shared folder', {
        gfsUri: `gfs://main/${parentResourceId}`,
      })
    )
    let permissionCalls = 0
    let rejectRefresh!: (error: Error) => void
    const pendingRefresh = new Promise<ReturnType<typeof delegationAffordances>>((_, reject) => {
      rejectRefresh = reject
    })
    const affordances = vi.fn(() => {
      permissionCalls += 1
      if (permissionCalls === 1) {
        return Promise.resolve(
          delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
        )
      }
      return pendingRefresh
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([row])),
          resolve: vi.fn(async (uri: string) =>
            uri.endsWith(resourceId) ? file : uri.endsWith(parentResourceId) ? parent : file
          ),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
          listGrants: vi.fn(async () => []),
          listShares: vi.fn(async () => []),
        },
        team: { directory: vi.fn(async () => ({ currentTeamId: 'team-1', items: [] })) },
        agents: { listMine: vi.fn(async () => []) },
      },
    })

    const { client } = renderHarness({ pendingGfsUri: null })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Share notes.bin' })).toBeTruthy()
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share notes.bin' }))
    })
    expect(await screen.findByRole('dialog', { name: 'Share file notes.bin' })).toBeTruthy()
    const sessionScope = ':user-1:team-1'
    const key = desktopQueryKeys.gfsAffordances(sessionScope, resourceId, 'main')
    await waitFor(() => expect(client.getQueryData(key)).toBeDefined())
    await act(async () => {
      void client.invalidateQueries({ exact: true, queryKey: key, refetchType: 'active' })
    })
    await waitFor(() => expect(permissionCalls).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('fetching'))
    const manageInput = screen.getByRole('combobox', { name: 'Add people, teams, or agents' })
    expect(manageInput).toBeTruthy()
    expect(screen.getByText('Checking permissions…')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Options for notes.bin' }))
    })
    const fileActions = within(screen.getByRole('menu', { name: 'Actions for notes.bin' }))
    expect(screen.queryByRole('menuitem', { name: 'Replace file' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    fireEvent.click(fileActions.getByRole('menuitem', { name: 'Share' }))
    const fileShareOptions = within(
      screen.getByRole('menu', { name: 'Share options for notes.bin' })
    )
    expect(fileShareOptions.queryByRole('menuitem', { name: 'Share' })).toBeNull()
    expect(screen.getByText('Checking permissions for notes.bin…')).toBeTruthy()

    await act(async () => {
      rejectRefresh(new Error('429 Too Many Requests'))
      await Promise.resolve()
    })
    expect(await screen.findByText(/Could not verify sharing permissions/i)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Add people, teams, or agents' })).toBe(manageInput)
    expect(await screen.findByText(/Could not verify permissions for notes.bin/i)).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Replace file' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    expect(fileShareOptions.queryByRole('menuitem', { name: 'Share' })).toBeNull()
    client.clear()
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

  it('reports a producer-resolved deep link opened after previewing its exact resource', async () => {
    const seedFolder = await resolveResource(
      resolvedDirectory('folder-0123', 'Reports', { gfsUri: SEED_URI })
    )
    const producerResource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'linked-note.md')
    )
    let resolveRequest!: (resource: unknown) => void
    const pendingResolve = new Promise<unknown>(resolve => {
      resolveRequest = resolve
    })
    const resolve = vi.fn((uri: string) =>
      uri === SEED_URI ? Promise.resolve(seedFolder) : pendingResolve
    )
    const outcomeOrder: string[] = []
    let previewHandoffCompleted = false
    const reportOutcome = vi.fn((_id: number, outcome: string) => outcomeOrder.push(outcome))
    const onOpenPendingGfsPreview = vi.fn(
      (
        id: number,
        preview: GfsPreviewResource,
        returnLocation: { gfsUri: string | null; name: string | null }
      ) => {
        outcomeOrder.push(`preview:${preview.gfsUri}`)
        previewHandoffCompleted = true
        expect(returnLocation).toEqual({ gfsUri: SEED_URI, name: 'Reports' })
        return id === 1084
      }
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
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

    const { client, rerender } = renderHarness({
      pendingGfsDeepLink: null,
      onPendingGfsDeepLinkOutcome: reportOutcome,
      onOpenPendingGfsPreview,
    })
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(SEED_URI))
    await waitFor(() =>
      expect(screen.getByTestId('tab-files-1').textContent).toBe(`${SEED_URI}|Reports`)
    )

    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness
              pendingGfsDeepLink={{ id: 1084, uri: DEEP_LINK_URI }}
              isPendingGfsDeepLinkCurrent={() => !previewHandoffCompleted}
              onPendingGfsDeepLinkOutcome={reportOutcome}
              onOpenPendingGfsPreview={onOpenPendingGfsPreview}
            />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(DEEP_LINK_URI))
    expect(reportOutcome).not.toHaveBeenCalled()
    await act(async () => {
      resolveRequest(producerResource)
      await Promise.resolve()
    })

    await waitFor(() => expect(reportOutcome).toHaveBeenCalledWith(1084, 'opened'))
    expect(onOpenPendingGfsPreview).toHaveBeenCalledTimes(1)
    expect(onOpenPendingGfsPreview).toHaveBeenCalledWith(
      1084,
      expect.objectContaining({ kind: 'markdown', gfsUri: DEEP_LINK_URI }),
      { gfsUri: SEED_URI, name: 'Reports' }
    )
    expect(outcomeOrder).toEqual([`preview:${DEEP_LINK_URI}`, 'opened'])
  })

  it('keeps an explicit root navigation after it supersedes a pending resource link', async () => {
    const seedFolder = await resolveResource(
      resolvedDirectory('folder-0123', 'Reports', { gfsUri: SEED_URI })
    )
    const pendingFile = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'linked-note.md')
    )
    let resolvePending!: (resource: unknown) => void
    const pendingResolve = new Promise<unknown>(resolve => {
      resolvePending = resolve
    })
    const resolve = vi.fn((uri: string) =>
      uri === SEED_URI ? Promise.resolve(seedFolder) : pendingResolve
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
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
    const reportOutcome = vi.fn()
    let navigationCurrent = true
    const reportExplicitIntent = vi.fn(() => {
      navigationCurrent = false
      reportOutcome(1090, 'superseded')
    })
    const { client, rerender } = renderHarness({
      pendingGfsDeepLink: null,
      onExplicitNavigationIntent: reportExplicitIntent,
      onPendingGfsDeepLinkOutcome: reportOutcome,
    })
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(SEED_URI))
    const tab = () => screen.getByTestId('tab-files-1').textContent
    await waitFor(() => expect(tab()).toBe(`${SEED_URI}|Reports`))

    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness
              pendingGfsDeepLink={{ id: 1090, uri: DEEP_LINK_URI }}
              pendingGfsUri={SEED_URI}
              isPendingGfsDeepLinkCurrent={() => navigationCurrent}
              onExplicitNavigationIntent={reportExplicitIntent}
              onPendingGfsDeepLinkOutcome={reportOutcome}
            />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(DEEP_LINK_URI))

    await act(async () => {
      screen.getByRole('button', { name: 'Shared with me' }).click()
    })
    expect(await screen.findByText('No shared files yet')).toBeTruthy()
    expect(tab()).toBe('null|Files')
    await waitFor(() => expect(reportOutcome).toHaveBeenCalledWith(1090, 'superseded'))

    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness
              pendingGfsDeepLink={null}
              pendingGfsUri={SEED_URI}
              onExplicitNavigationIntent={reportExplicitIntent}
              onPendingGfsDeepLinkOutcome={reportOutcome}
            />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenNthCalledWith(1, SEED_URI)
    expect(resolve).toHaveBeenNthCalledWith(2, DEEP_LINK_URI)

    await act(async () => {
      resolvePending(pendingFile)
      await Promise.resolve()
    })
    expect(tab()).toBe('null|Files')
    expect(reportExplicitIntent).toHaveBeenCalledOnce()
    expect(reportOutcome).toHaveBeenCalledTimes(1)
    expect(reportOutcome).toHaveBeenCalledWith(1090, 'superseded')
    expect(screen.queryByText('This resource was deleted.')).toBeNull()
  })

  it('does not open a late resolve after its pending deep link is cleared', async () => {
    const producerResource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'linked-note.md')
    )
    const resolveRequests: Array<(resource: unknown) => void> = []
    const resolve = vi.fn(
      () =>
        new Promise<unknown>(resolveResource => {
          resolveRequests.push(resolveResource)
        })
    )
    const reportOutcome = vi.fn()
    const onOpenPreview = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
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

    const { client, rerender } = renderHarness({
      pendingGfsDeepLink: { id: 1087, uri: DEEP_LINK_URI },
      onPendingGfsDeepLinkOutcome: reportOutcome,
      onOpenPreview,
    })
    const tab = () => screen.getByTestId('tab-files-1').textContent
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness
              pendingGfsDeepLink={null}
              pendingGfsUri={null}
              onPendingGfsDeepLinkOutcome={reportOutcome}
              onOpenPreview={onOpenPreview}
            />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })
    expect(resolve).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveRequests[0]?.(producerResource)
      await Promise.resolve()
    })
    expect(onOpenPreview).not.toHaveBeenCalled()
    expect(reportOutcome).not.toHaveBeenCalled()
    expect(tab()).toBe(`${SEED_URI}|Reports`)
  })

  it.each([
    [403, 'You do not have permission to open this resource.'],
    [404, 'This resource could not be found.'],
    [410, 'This resource was deleted.'],
  ])(
    'shows an accurate terminal deep-link outcome for HTTP %i',
    async (status, expectedMessage) => {
      const errorMessage = await resolveDeniedMessage(
        DEEP_LINK_URI,
        { code: 'resource_unavailable', message: 'resource is unavailable' },
        status
      )
      expect(errorMessage).toContain(`httpStatus=${status}`)
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
            resolve: vi.fn(async () => {
              throw new Error(errorMessage)
            }),
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
      const reportOutcome = vi.fn()

      renderHarness({
        pendingGfsDeepLink: { id: 1084, uri: DEEP_LINK_URI },
        onPendingGfsDeepLinkOutcome: reportOutcome,
      })

      expect(await screen.findByText(expectedMessage)).toBeTruthy()
      expect(screen.queryByText('No shared files yet')).toBeNull()
      expect(reportOutcome).toHaveBeenCalledWith(1084, 'terminal')
    }
  )

  it('keeps a transient deep-link failure pending and retries only after an explicit action', async () => {
    const errorMessage = await resolveDeniedMessage(
      DEEP_LINK_URI,
      { code: 'upstream_unavailable', message: 'try again later' },
      503
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => {
            throw new Error(errorMessage)
          }),
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
    const resolve = window.clerum.gfs.resolve as ReturnType<typeof vi.fn>
    const reportOutcome = vi.fn()

    renderHarness({
      pendingGfsDeepLink: { id: 1085, uri: DEEP_LINK_URI },
      onPendingGfsDeepLinkOutcome: reportOutcome,
    })

    const retry = await screen.findByRole('button', { name: 'Retry opening link' })
    expect(reportOutcome).toHaveBeenCalledWith(1085, 'retryable')
    expect(resolve).toHaveBeenCalledTimes(1)
    await act(async () => {
      retry.click()
    })
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
  })

  it('terminally reports a malformed deep-link URI without calling the resolver', async () => {
    const resolve = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
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
    const reportOutcome = vi.fn()

    renderHarness({
      pendingGfsDeepLink: { id: 1086, uri: 'https://files.example.test/resource' },
      onPendingGfsDeepLinkOutcome: reportOutcome,
    })

    expect(
      await screen.findByText('This EvenDrive link is invalid or cannot be resolved.')
    ).toBeTruthy()
    expect(resolve).not.toHaveBeenCalled()
    expect(reportOutcome).toHaveBeenCalledWith(1086, 'terminal')
    expect(screen.queryByText('No shared files yet')).toBeNull()
  })

  it('refreshes an open folder path and its child list after a remote move and create', async () => {
    let moved = false
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => {
            if (uri === SEED_URI) {
              return {
                resourceId: 'folder-current',
                gfsUri: SEED_URI,
                drive: 'main',
                name: 'Reports',
                kind: 'directory',
                parentResourceId: moved ? 'parent-new' : 'parent-old',
                version: moved ? 2 : 1,
              }
            }
            if (uri === 'gfs://main/parentold') {
              return {
                resourceId: 'parent-old',
                gfsUri: uri,
                name: 'Old location',
                kind: 'directory',
                parentResourceId: null,
                version: 1,
              }
            }
            if (uri === 'gfs://main/parentnew') {
              return {
                resourceId: 'parent-new',
                gfsUri: uri,
                name: 'New location',
                kind: 'directory',
                parentResourceId: null,
                version: 1,
              }
            }
            throw new Error(`Unexpected GFS resolve URI: ${uri}`)
          }),
          listChildren: vi.fn(async (resourceId: string) => ({
            items:
              moved && resourceId === 'folder-current'
                ? [
                    {
                      resourceId: 'new-file',
                      rid: 'new-file',
                      gfsUri: 'gfs://main/new-file',
                      drive: 'main',
                      parentResourceId: 'folder-current',
                      name: 'new-note.md',
                      kind: 'file',
                      path: '/new-location/Reports/new-note.md',
                      version: 1,
                      bytes: 12,
                    },
                  ]
                : [],
            nextCursor: null,
          })),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { client, rerender } = renderHarness()
    const location = () => screen.getByRole('navigation', { name: 'File location' }).textContent
    await waitFor(() => expect(location()).toContain('Old location'))
    expect(location()).toContain('Reports')
    expect(await screen.findByText('This folder is empty')).toBeTruthy()

    moved = true
    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness remoteGfsChangeEpoch={1} />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })

    expect(await screen.findByText('new-note.md')).toBeTruthy()
    await waitFor(() => expect(location()).toContain('New location'))
    expect(location()).toContain('Reports')
    expect(location()).not.toContain('Old location')
  })

  it('clears an open folder and cached rows when remote authorization is revoked', async () => {
    const denial = await resolveDeniedMessage(SEED_URI)
    let revoked = false
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => {
            if (revoked) throw new Error(denial)
            if (uri !== SEED_URI) throw new Error(`Unexpected GFS resolve URI: ${uri}`)
            return {
              resourceId: 'folder-current',
              gfsUri: SEED_URI,
              drive: 'main',
              name: 'Private folder',
              kind: 'directory',
              parentResourceId: null,
              version: 1,
            }
          }),
          listChildren: vi.fn(async () => {
            if (revoked) throw new Error(denial)
            return {
              items: [
                {
                  resourceId: 'private-file',
                  rid: 'private-file',
                  gfsUri: 'gfs://main/private-file',
                  drive: 'main',
                  parentResourceId: 'folder-current',
                  name: 'private-notes.md',
                  kind: 'file',
                  path: '/Private folder/private-notes.md',
                  version: 1,
                  bytes: 30,
                },
              ],
              nextCursor: null,
            }
          }),
          affordances: vi.fn(async () => ({
            held: [],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    const { client, rerender } = renderHarness()
    await screen.findByText('private-notes.md')
    expect(screen.getByRole('navigation', { name: 'File location' }).textContent).toContain(
      'Private folder'
    )

    revoked = true
    await act(async () => {
      rerender(
        <AuthContext.Provider value={authValue()}>
          <QueryClientProvider client={client}>
            <FilesTabHarness remoteGfsChangeEpoch={1} />
          </QueryClientProvider>
        </AuthContext.Provider>
      )
    })

    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'File location' }).textContent).toBe(
        'Shared with me'
      )
      expect(screen.queryByText('private-notes.md')).toBeNull()
    })
  })

  it('keeps typed Manage fields during a background permission revalidation', async () => {
    const folder = await resolveResource(
      resolvedDirectory('folder-1', 'Reports', { gfsUri: SEED_URI })
    )
    const report = childView('file-1', 'report.txt', 'file', {
      parentResourceId: 'folder-1',
      gfsUri: 'gfs://main/file-1',
    })
    const children = await listChildrenPage([report])
    const accessible = await listAccessiblePage([])
    const fullAccess = delegationAffordances(
      new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
      false
    )
    let deferNextFileCheck = false
    let finishFileCheck: ((value: ReturnType<typeof delegationAffordances>) => void) | undefined
    const affordances = vi.fn(async (resourceId: string) => {
      if (resourceId === 'file-1' && deferNextFileCheck) {
        deferNextFileCheck = false
        return new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
          finishFileCheck = resolve
        })
      }
      return fullAccess
    })
    const resolve = vi.fn(async (uri: string) => {
      if (uri === SEED_URI) return folder
      if (uri.endsWith('/file1')) {
        return resolvedFile('file-1', 'report.txt', {
          gfsUri: 'gfs://main/file-1',
          parentResourceId: 'folder-1',
        })
      }
      if (uri.endsWith('/folder1')) return folder
      throw new Error(`unexpected test resource URI: ${uri}`)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => accessible),
          resolve,
          listChildren: vi.fn(async (resourceId: string) =>
            resourceId === 'folder-1' ? children : { items: [], nextCursor: null }
          ),
          affordances,
          listGrants: vi.fn(async () => []),
          listShares: vi.fn(async () => []),
        },
        team: {
          directory: vi.fn(async () => ({
            currentTeamId: 'team-1',
            items: [
              {
                team: { id: 'team-2', name: 'Team Two', role: 'member' as const },
                members: [],
                contextIds: [],
                agentNames: [],
              },
            ],
          })),
        },
        agents: { listMine: vi.fn(async () => []) },
      },
    })

    const { client } = renderHarness()
    await screen.findByText('report.txt')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('file-1', 'main'))
    fireEvent.click(screen.getByRole('button', { name: 'Share report.txt' }))
    const dialog = await screen.findByRole('dialog', { name: 'Share file report.txt' })
    const picker = within(dialog).getByRole('combobox', {
      name: 'Add people, teams, or agents',
    })
    fireEvent.focus(picker)
    fireEvent.click(within(dialog).getByRole('option', { name: /Team Two/ }))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Access role for selected recipients' })
    )
    fireEvent.click(within(dialog).getByRole('option', { name: 'Editor' }))

    deferNextFileCheck = true
    void client.invalidateQueries({
      predicate: query =>
        query.queryKey.includes('file-1') && query.queryKey.includes('affordances'),
      refetchType: 'active',
    })
    await waitFor(() => expect(finishFileCheck).toBeTypeOf('function'))
    const recipientRetained = Boolean(within(dialog).queryByText('Team Two'))
    const roleRetained =
      within(dialog)
        .queryByRole('button', { name: 'Access role for selected recipients' })
        ?.textContent?.includes('Editor') ?? false
    const checkingVisible = Boolean(within(dialog).queryByRole('status'))
    const shareDisabled = within(dialog)
      .queryByRole('button', { name: 'Share' })
      ?.hasAttribute('disabled')

    await act(async () => finishFileCheck?.(fullAccess))
    expect(recipientRetained).toBe(true)
    expect(roleRetained).toBe(true)
    expect(checkingVisible).toBe(true)
    expect(shareDisabled).toBe(true)
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Share' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(within(dialog).getByText('Team Two')).toBeTruthy()
    expect(
      within(dialog)
        .getByRole('button', { name: 'Access role for selected recipients' })
        .textContent?.includes('Editor')
    ).toBe(true)

    const readOnly = delegationAffordances(new Set(['read']), false)
    finishFileCheck = undefined
    deferNextFileCheck = true
    void client.invalidateQueries({
      predicate: query =>
        query.queryKey.includes('file-1') && query.queryKey.includes('affordances'),
      refetchType: 'active',
    })
    await waitFor(() => expect(finishFileCheck).toBeTypeOf('function'))
    await act(async () => finishFileCheck?.(readOnly))
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Share' }).hasAttribute('disabled')).toBe(
        true
      )
    )
    expect(within(dialog).getByText('Team Two')).toBeTruthy()
    expect(
      within(dialog)
        .getByRole('button', { name: 'Access role for selected recipients' })
        .textContent?.includes('Editor')
    ).toBe(true)
    expect(within(dialog).getByText(/Your sharing permission changed/)).toBeTruthy()
  })
})
