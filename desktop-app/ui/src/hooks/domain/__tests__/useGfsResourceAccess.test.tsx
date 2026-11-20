// @vitest-environment jsdom
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  affordancesResult,
  gfsRouteFailureMessage,
  grantsListPage,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  listGrantsFailureMessage,
  listSharesFailureMessage,
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import type { GfsShareListItem } from '@/gfs/delegation.types'
import { refetchGfsAccess } from '@/lib/gfsWatchReaction'
import { desktopQueryKeys } from '../queryKeys'
import { useGfsBrowserController } from '../useGfsBrowserController'
import { useGfsResourceAccess } from '../useGfsResourceAccess'
import { useGfsWatchSubscription } from '../useGfsWatchSubscription'

// Fire-and-forget UI actions mirror the production callers, which await the
// same promises inside try/catch.
const swallow = (promise: Promise<unknown>): void => {
  void promise.catch(() => {})
}

const userA = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member' as const,
}

const userB = {
  ...userA,
  teamId: 'team-b',
  teamName: 'Team B',
}

let lastHarnessQueryClient: QueryClient | null = null

function authValue(me: AuthContextValue['me']): AuthContextValue {
  return {
    booting: false,
    busy: false,
    statusText: '',
    statusTone: 'info',
    isAuthenticated: Boolean(me),
    sessionGeneration: 1,
    me,
    email: me?.email ?? '',
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

function Harness({
  children,
  productionQueryDefaults = false,
}: {
  children: ReactNode
  productionQueryDefaults?: boolean
}) {
  const [me, setMe] = useState<AuthContextValue['me']>(userA)
  const [client] = useState(
    () =>
      new QueryClient(
        productionQueryDefaults
          ? { defaultOptions: desktopQueryDefaults }
          : { defaultOptions: { queries: { retry: false } } }
      )
  )
  lastHarnessQueryClient = client
  return (
    <AuthContext.Provider value={authValue(me)}>
      <QueryClientProvider client={client}>
        {children}
        <button type="button" onClick={() => setMe(userB)}>
          switch team
        </button>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

// The Share dialog is the only consumer of a resource's ACL, so its queries
// run only while a target is set. This probe opens the browser on a resource
// with the real controller and hands that resource to the access hook, wired
// the way Files wires it: the controller's fail-closed boundary and its
// authority gate. It reuses the real QueryClient from `Harness` so
// invalidation genuinely refetches.
function ManageProbe() {
  const [manageOpen, setManageOpen] = useState(false)
  const ctrl = useGfsBrowserController()
  const access = useGfsResourceAccess(
    manageOpen ? (ctrl.current ?? null) : null,
    ctrl.authorityPending || ctrl.accessState === 'revoked',
    { handleAuthorityFailure: ctrl.handleAuthorityFailure }
  )
  const target = () => ({ resourceId: ctrl.current?.resourceId ?? '' })
  return (
    <>
      <div data-testid="current">{ctrl.current?.resourceId ?? 'none'}</div>
      <div data-testid="grants-count">{access.grants.length}</div>
      <div data-testid="shares-count">{access.shares.length}</div>
      <div data-testid="inherited-error">{access.inheritedAccessError ?? 'none'}</div>
      <div data-testid="inherited-coverage">{access.inheritedCoverage ?? 'none'}</div>
      <div data-testid="access-state">{ctrl.accessState}</div>
      <div data-testid="crumbs">{ctrl.crumbs.map(crumb => crumb.name).join(' / ')}</div>
      <div data-testid="held-permissions">{ctrl.affordances?.held.join(',') ?? 'none'}</div>
      <button type="button" onClick={() => swallow(ctrl.openUri('gfs://main/root'))}>
        open root
      </button>
      <button type="button" onClick={() => setManageOpen(true)}>
        open manage
      </button>
      <button type="button" onClick={() => setManageOpen(false)}>
        close manage
      </button>
      <button type="button" onClick={() => swallow(access.refreshGrants())}>
        refresh grants
      </button>
      <button type="button" onClick={() => swallow(access.revokeGrant(target(), 'grant-42'))}>
        revoke grant
      </button>
      <button
        type="button"
        onClick={() => swallow(access.grant(target(), ['user:bob'], ['read'], true))}
      >
        grant inherit true
      </button>
      <button
        type="button"
        onClick={() => swallow(access.grant(target(), ['team:qa'], ['read'], false))}
      >
        grant inherit false
      </button>
      <button type="button" onClick={() => swallow(access.refreshShares())}>
        refresh shares
      </button>
      <button
        type="button"
        onClick={() =>
          swallow(
            ctrl.convergeCommittedMove(
              {
                resourceId: ctrl.crumbs[0]?.resourceId ?? '',
                destinationId: 'destination-1',
                oldParentId: null,
              },
              { version: 2 }
            )
          )
        }
      >
        move oldest ancestor
      </button>
      <button type="button" onClick={() => swallow(access.revokeShare(target(), 'share-42'))}>
        revoke share
      </button>
      {/* No desktop surface creates a share; another client does, and the list re-reads it. */}
      <button
        type="button"
        onClick={() =>
          swallow(
            window.clerum.gfs
              .createShare(target().resourceId, ['user:bob'], 'main')
              .then(() => access.refreshShares())
          )
        }
      >
        create share
      </button>
    </>
  )
}

describe('useGfsResourceAccess — grants list / revoke / inherit (#826)', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it('does not list grants while Manage is closed and lists them once it opens', async () => {
    const affordances = vi.fn(async () => ({
      held: ['read', 'manage_acl'],
      canDelegate: true,
      grantableBits: ['read'],
      canCreateShare: false,
    }))
    const listGrants = vi.fn(async () => [
      {
        id: 'grant-42',
        drive: 'main',
        resourceId: 'root',
        subject: { type: 'user', id: 'bob' },
        permissions: ['read'],
        inherit: false,
      },
    ])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
          listGrants,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    // The open cycle has run (affordances fetched), so any grants fetch would have
    // fired by now — but Manage is closed, so the grants list must stay dormant.
    await waitFor(() => expect(affordances).toHaveBeenCalled())
    expect(listGrants).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))
    expect(listGrants).toHaveBeenCalledWith('root', 'main')
    await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('1'))
    expect(
      lastHarnessQueryClient?.getQueryData(
        desktopQueryKeys.gfsGrants(':user-a:team-a', 'root', 'main', 1)
      )
    ).toEqual([expect.objectContaining({ id: 'grant-42' })])
    expect(lastHarnessQueryClient?.getQueryData(['gfs', 'main', 'root', 'grants'])).toBeUndefined()
  })

  it('refetches the grants list when refreshGrants runs', async () => {
    const listGrants = vi.fn(async () => [])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))

    await act(async () => {
      screen.getByRole('button', { name: 'refresh grants' }).click()
    })

    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(2))
  })

  it('revokes a grant by id and refetches the grants list on success', async () => {
    const revokeGrant = vi.fn(async () => undefined)
    const listGrants = vi.fn(async () => [
      {
        id: 'grant-42',
        drive: 'main',
        resourceId: 'root',
        subject: { type: 'user', id: 'bob' },
        permissions: ['read'],
        inherit: false,
      },
    ])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants,
          revokeGrant,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))

    await act(async () => {
      screen.getByRole('button', { name: 'revoke grant' }).click()
    })

    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith('grant-42'))
    // onSuccess: refreshGrants invalidates the exact grants key → active refetch.
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(2))
  })

  it('forwards the inherit flag (true and false) to window.clerum.gfs.grant', async () => {
    const grant = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          grant,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))

    await act(async () => {
      screen.getByRole('button', { name: 'grant inherit true' }).click()
    })
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('root', ['user:bob'], ['read'], 'main', true)
    )

    await act(async () => {
      screen.getByRole('button', { name: 'grant inherit false' }).click()
    })
    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('root', ['team:qa'], ['read'], 'main', false)
    )
  })

  it('lists direct shares when Manage opens and caches them session-scoped', async () => {
    const listGrants = vi.fn(async () => [])
    const listShares = vi.fn(async () => [
      {
        id: 'share-42',
        drive: 'main',
        resourceId: 'root',
        subject: { type: 'user', id: 'bob' },
        permissions: ['read'],
        includeDescendants: false,
      },
    ])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl', 'share'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: true,
          })),
          listGrants,
          listShares,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    expect(listShares).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(1))
    expect(listShares).toHaveBeenCalledWith('root', 'main')
    await waitFor(() => expect(screen.getByTestId('shares-count').textContent).toBe('1'))
    // Shares live under the session-scoped key (never a cross-session leak).
    expect(
      lastHarnessQueryClient?.getQueryData(
        desktopQueryKeys.gfsShares(':user-a:team-a', 'root', 'main', 1)
      )
    ).toEqual([expect.objectContaining({ id: 'share-42' })])
  })

  it('revokes a direct share by id and refetches the shares list on success', async () => {
    const share = {
      id: 'share-42',
      drive: 'main',
      resourceId: 'root',
      subject: { type: 'user', id: 'bob' },
      permissions: ['read'],
      includeDescendants: false,
    }
    const listShares = vi.fn(async () => [share])
    const revokeShare = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants: vi.fn(async () => []),
          listShares,
          revokeShare,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('shares-count').textContent).toBe('1'))

    await act(async () => {
      screen.getByRole('button', { name: 'revoke share' }).click()
    })

    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('share-42'))
    // onSuccess: refreshShares invalidates the exact shares key → active refetch.
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(2))
  })

  it('shows a share created elsewhere without remounting (create → refreshShares)', async () => {
    const created: unknown[] = []
    const listShares = vi.fn(async () =>
      created.length > 0
        ? [
            {
              id: 'share-42',
              drive: 'main',
              resourceId: 'root',
              subject: { type: 'user', id: 'bob' },
              permissions: ['read'],
              includeDescendants: false,
            },
          ]
        : []
    )
    const createShare = vi.fn(async () => {
      created.push(true)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl', 'share'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: true,
          })),
          listGrants: vi.fn(async () => []),
          listShares,
          createShare,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('shares-count').textContent).toBe('0')

    await act(async () => {
      screen.getByRole('button', { name: 'create share' }).click()
    })

    await waitFor(() => expect(createShare).toHaveBeenCalledWith('root', ['user:bob'], 'main'))
    await waitFor(() => expect(screen.getByTestId('shares-count').textContent).toBe('1'))
  })

  // R1-M3 — a total inherited-derivation failure (the file itself cannot be
  // re-resolved for the walk) must surface as controller error state instead
  // of silently collapsing to an empty list.
  // R1-H3: a classified mid-walk failure no longer throws — the coverage
  // state ('unavailable') tells the dialog which notice to show, and only a
  // raw session 401 still surfaces through inheritedAccessError.
  it('exposes inheritedCoverage unavailable when a mid-walk resolve fails', async () => {
    let resolveCalls = 0
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          // The navigation resolve succeeds; the derivation's own resolve of
          // the same file then fails outright.
          resolve: vi.fn(async () => {
            resolveCalls += 1
            if (resolveCalls > 1) throw new Error('Error: 500 resolve_failed')
            return {
              resourceId: 'file-1',
              parentResourceId: 'folder-1',
              gfsUri: 'gfs://main/file-1',
              name: 'report.txt',
              kind: 'file',
              version: 1,
            }
          }),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants: vi.fn(async () => []),
          listShares: vi.fn(async () => []),
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('file-1'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })

    await waitFor(() =>
      expect(screen.getByTestId('inherited-coverage').textContent).toBe('unavailable')
    )
    expect(screen.getByTestId('inherited-error').textContent).toBe('none')
  })

  // A move changes the ANCESTRY of the open resource, and the open
  // Share/Manage dialog shows rows derived from that ancestry. The dialog must
  // re-read them: keeping the pre-move observation would present inherited
  // access that no longer exists.
  it('re-reads the open inherited access when a move affects its ancestry', async () => {
    const listGrants = vi.fn(async () => [])
    const listShares = vi.fn(async () => [])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => {
            const id = uri.split('/').pop()!
            if (id === 'folder1') {
              return {
                resourceId: 'folder-1',
                parentResourceId: null,
                gfsUri: 'gfs://main/folder1',
                name: 'Team docs',
                kind: 'directory',
                version: 1,
              }
            }
            return {
              resourceId: 'file-1',
              parentResourceId: 'folder-1',
              gfsUri: 'gfs://main/file1',
              name: 'report.txt',
              kind: 'file',
              version: 1,
            }
          }),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants,
          listShares,
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('file-1'))
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalled())

    const client = lastHarnessQueryClient!
    const scope = ':user-a:team-a'
    const inheritedKey = desktopQueryKeys.gfsInheritedAccess(scope, 'file-1', 'main', 1)
    const inheritedQuery = client.getQueryCache().find({ queryKey: inheritedKey })!
    const before = inheritedQuery.state.dataUpdatedAt
    expect(before).toBeGreaterThan(0)

    // The oldest crumb is an ancestor of the open resource: moving it changes
    // what the open resource inherits.
    await act(async () => {
      screen.getByRole('button', { name: 'move oldest ancestor' }).click()
    })

    await waitFor(() => expect(inheritedQuery.state.dataUpdatedAt).not.toBe(before))
  })

  // Every response and rejection crosses the real client/HTTP fixture seam.
  // The observable contract is session state and protected metadata, not a
  // briefly presented error string before the authority boundary clears it.
  for (const route of ['resolve', 'grants', 'shares'] as const) {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'desktop_user_retired'],
      [403, 'gfs_operator_link_invalid'],
      [403, 'manage_acl_required'],
    ] as const) {
      it(`handles inherited ${route} ${code} through the correct authority boundary`, async () => {
        const targetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        const parentId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        const target = await resolveResource(
          resolvedFile(targetId, 'report.txt', {
            parentResourceId: parentId,
          })
        )
        const parent = await resolveResource(resolvedDirectory(parentId, 'team-docs'))
        const body = { code, message: code }
        const failure =
          route === 'resolve'
            ? await resolveDeniedMessage(target.gfsUri, body, status)
            : route === 'grants'
              ? await listGrantsFailureMessage(status, body)
              : await listSharesFailureMessage(status, body)
        expect(failure).toContain(`httpStatus=${status}`)
        expect(failure).toContain(code)
        const directGrants = await grantsListPage([
          {
            id: 'direct-grant',
            drive: 'main',
            resourceId: targetId,
            subject: { type: 'user', id: 'bob' },
            permissions: ['read'],
            inherit: false,
          },
        ])
        const directShares = await sharesListPage([
          {
            id: 'direct-share',
            drive: 'main',
            resourceId: targetId,
            subject: { type: 'user', id: 'carol' },
            permissions: ['read'],
            includeDescendants: false,
          },
        ])
        const emptyGrants = await grantsListPage([])
        const emptyShares = await sharesListPage([])
        const accessible = await listAccessiblePage([])
        const children = await listChildrenPage([])
        const affordances = await affordancesResult(heldAffordances(['read', 'manage_acl']))
        let manageReadStarted = false
        Object.defineProperty(window, 'clerum', {
          configurable: true,
          value: {
            gfs: {
              listAccessible: vi.fn(async () => accessible),
              resolve: vi.fn(async (uri: string) => {
                if (uri.endsWith(parentId.replace(/-/g, '')) || uri.endsWith(parentId))
                  return parent
                if (manageReadStarted && route === 'resolve') throw new Error(failure)
                return target
              }),
              listChildren: vi.fn(async () => children),
              affordances: vi.fn(async () => affordances),
              listGrants: vi.fn(async (resourceId: string) => {
                if (resourceId === targetId) return directGrants
                if (route === 'grants') throw new Error(failure)
                return emptyGrants
              }),
              listShares: vi.fn(async (resourceId: string) => {
                if (resourceId === targetId) return directShares
                if (route === 'shares') throw new Error(failure)
                return emptyShares
              }),
            },
          },
        })
        render(<ManageProbe />, { wrapper: Harness })
        await act(async () => screen.getByRole('button', { name: 'open root' }).click())
        await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(targetId))
        const client = lastHarnessQueryClient!
        const scope = ':user-a:team-a'
        const grantsKey = desktopQueryKeys.gfsGrants(scope, targetId, 'main', 1)
        const sharesKey = desktopQueryKeys.gfsShares(scope, targetId, 'main', 1)
        await act(async () => {
          client.setQueryData(grantsKey, directGrants)
          client.setQueryData(sharesKey, directShares)
        })
        expect(client.getQueryData(grantsKey)).toEqual(directGrants)
        expect(client.getQueryData(sharesKey)).toEqual(directShares)
        manageReadStarted = true
        await act(async () => screen.getByRole('button', { name: 'open manage' }).click())
        if (code === 'manage_acl_required') {
          await waitFor(() =>
            expect(screen.getByTestId('inherited-coverage').textContent).toBe(
              route === 'resolve' ? 'read-boundary' : 'acl-limited'
            )
          )
          expect(screen.getByTestId('access-state').textContent).toBe('active')
          expect(screen.getByTestId('current').textContent).toBe(targetId)
          expect(screen.getByTestId('grants-count').textContent).toBe('1')
          expect(screen.getByTestId('shares-count').textContent).toBe('1')
        } else {
          await waitFor(() =>
            expect(screen.getByTestId('access-state').textContent).toBe('revoked')
          )
          expect(screen.getByTestId('current').textContent).toBe('none')
          expect(screen.getByTestId('crumbs').textContent).toBe('')
          expect(screen.getByTestId('held-permissions').textContent).toBe('none')
          expect(screen.getByTestId('grants-count').textContent).toBe('0')
          expect(screen.getByTestId('shares-count').textContent).toBe('0')
          expect(client.getQueryData(grantsKey)).toBeUndefined()
          expect(client.getQueryData(sharesKey)).toBeUndefined()
        }
      })
    }
  }
})

// A move committed by ONE surface must reach the Share/Manage dialog ANOTHER
// surface has open. The Files page opened a deep descendant by URI — its
// ancestry lives in ITS controller, and the children caches that could
// connect it to the moved ancestor were never loaded — while the sidebar, a
// SEPARATE controller with its own crumbs, moves that ancestor.
function TwoSurfaceAccessProbe() {
  const [manageOpen, setManageOpen] = useState(false)
  const files = useGfsBrowserController()
  useGfsResourceAccess(
    manageOpen ? (files.current ?? null) : null,
    files.authorityPending || files.accessState === 'revoked',
    { handleAuthorityFailure: files.handleAuthorityFailure }
  )
  const sidebar = useGfsBrowserController()
  return (
    <>
      <div data-testid="files-current">{files.current?.resourceId ?? 'none'}</div>
      <div data-testid="files-crumbs">
        {files.crumbs.map(crumb => crumb.resourceId).join(' / ')}
      </div>
      <button type="button" onClick={() => swallow(files.openUri('gfs://main/leaf1'))}>
        open leaf
      </button>
      <button type="button" onClick={() => setManageOpen(true)}>
        open manage
      </button>
      <button
        type="button"
        onClick={() =>
          swallow(
            sidebar.convergeCommittedMove(
              {
                resourceId: 'ancestor-1',
                destinationId: 'destination-1',
                oldParentId: null,
              },
              { version: 2 }
            )
          )
        }
      >
        move ancestor
      </button>
    </>
  )
}

describe('useGfsResourceAccess — cross-surface move convergence (RP-005)', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it("re-reads another surface's open inherited access when a move affects its ancestry", async () => {
    const listGrants = vi.fn(async () => [])
    const listShares = vi.fn(async () => [])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async (uri: string) => {
            const id = uri.split('/').pop()!
            if (id === 'leaf1') {
              return {
                resourceId: 'leaf-1',
                parentResourceId: 'parent-1',
                gfsUri: 'gfs://main/leaf1',
                name: 'leaf.txt',
                kind: 'file',
                version: 1,
              }
            }
            if (id === 'parent1') {
              return {
                resourceId: 'parent-1',
                parentResourceId: 'ancestor-1',
                gfsUri: 'gfs://main/parent1',
                name: 'Parent',
                kind: 'directory',
                version: 1,
              }
            }
            return {
              resourceId: 'ancestor-1',
              parentResourceId: null,
              gfsUri: 'gfs://main/ancestor1',
              name: 'Ancestor',
              kind: 'directory',
              version: 1,
            }
          }),
          // No children listing is ever loaded, so the shared cache holds no
          // child→parent link that could connect the open leaf to its
          // ancestor: the ancestry exists only in the Files controller.
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'manage_acl'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: false,
          })),
          listGrants,
          listShares,
        },
      },
    })

    render(<TwoSurfaceAccessProbe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open leaf' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('files-current').textContent).toBe('leaf-1'))
    expect(screen.getByTestId('files-crumbs').textContent).toBe('ancestor-1 / parent-1 / leaf-1')
    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalled())

    const client = lastHarnessQueryClient!
    const scope = ':user-a:team-a'
    const inheritedKey = desktopQueryKeys.gfsInheritedAccess(scope, 'leaf-1', 'main', 1)
    const inheritedQuery = client.getQueryCache().find({ queryKey: inheritedKey })!
    const before = inheritedQuery.state.dataUpdatedAt
    expect(before).toBeGreaterThan(0)

    // The OTHER surface moves the open leaf's ancestor.
    await act(async () => {
      screen.getByRole('button', { name: 'move ancestor' }).click()
    })

    await waitFor(() => expect(inheritedQuery.state.dataUpdatedAt).not.toBe(before))
  })
})

const SCOPE_A = ':user-a:team-a'
const SCOPE_B = ':user-a:team-b'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function rootDirectory() {
  return resolveResource(resolvedDirectory('root', 'Root'))
}

async function directGrant() {
  return grantsListPage([
    {
      id: 'grant-42',
      drive: 'main',
      resourceId: 'root',
      subject: { type: 'user', id: 'bob' },
      permissions: ['read'],
      inherit: false,
    },
  ])
}

async function sessionRejection(invoke: Parameters<typeof gfsRouteFailureMessage>[0]) {
  return gfsRouteFailureMessage(invoke, 401, { code: 'unauthorized', message: 'Session expired' })
}

// Files' gate: cached rows stay hidden until discovery re-proves the session.
function GatedAccessProbe() {
  const ctrl = useGfsBrowserController()
  const access = useGfsResourceAccess(
    { resourceId: 'root' },
    ctrl.authorityPending || ctrl.accessState === 'revoked',
    { handleAuthorityFailure: ctrl.handleAuthorityFailure }
  )
  return (
    <>
      <div data-testid="authority-pending">{ctrl.authorityPending ? 'pending' : 'ready'}</div>
      <div data-testid="grants-count">{access.grants.length}</div>
    </>
  )
}

describe('useGfsResourceAccess — owner gate and fail-closed boundary', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it('withholds cached grants while the owner re-proves the session', async () => {
    const discovery = deferred<Awaited<ReturnType<typeof listAccessiblePage>>>()
    const grants = await directGrant()
    const listGrants = deferred<typeof grants>()
    const accessible = await listAccessiblePage([])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(() => discovery.promise),
          resolve: vi.fn(async () => rootDirectory()),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () => affordancesResult(heldAffordances(['read']))),
          listGrants: vi.fn(() => listGrants.promise),
          listShares: vi.fn(async () => sharesListPage([])),
        },
      },
    })

    render(<GatedAccessProbe />, { wrapper: Harness })
    expect(screen.getByTestId('authority-pending').textContent).toBe('pending')
    await act(async () => {
      lastHarnessQueryClient!.setQueryData(
        desktopQueryKeys.gfsGrants(SCOPE_A, 'root', 'main', 1),
        grants
      )
      // The cache notifies observers on the next macrotask.
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('authority-pending').textContent).toBe('pending')
    expect(screen.getByTestId('grants-count').textContent).toBe('0')

    await act(async () => discovery.resolve(accessible))
    await waitFor(() => expect(screen.getByTestId('authority-pending').textContent).toBe('ready'))
    expect(screen.getByTestId('grants-count').textContent).toBe('1')
  })

  it('revokes the session when the grants listing is rejected for authority', async () => {
    const failure = await listGrantsFailureMessage(401, {
      code: 'unauthorized',
      message: 'Session expired',
    })
    const listGrants = vi.fn(async () => {
      throw new Error(failure)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([])),
          resolve: vi.fn(async () => rootDirectory()),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () =>
            affordancesResult(heldAffordances(['read', 'manage_acl']))
          ),
          listGrants,
          listShares: vi.fn(async () => sharesListPage([])),
        },
      },
    })

    render(<ManageProbe />, { wrapper: Harness })
    await act(async () => screen.getByRole('button', { name: 'open root' }).click())
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await act(async () => screen.getByRole('button', { name: 'open manage' }).click())

    await waitFor(() => expect(listGrants).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('revoked'))
    expect(screen.getByTestId('current').textContent).toBe('none')
    expect(screen.getByTestId('crumbs').textContent).toBe('')
  })

  const lateRejectedWrites = [
    {
      write: 'grant',
      button: 'grant inherit true',
      ipc: 'grant',
      sentWith: ['root', ['user:bob'], ['read'], 'main', true],
      rejection: () =>
        sessionRejection(client =>
          client.grant(
            { resourceId: 'root', subjects: [{ type: 'user', id: 'bob' }], permissions: ['read'] },
            'fixture-session-token'
          )
        ),
    },
    {
      write: 'revokeGrant',
      button: 'revoke grant',
      ipc: 'revokeGrant',
      sentWith: ['grant-42'],
      rejection: () =>
        sessionRejection(client =>
          client.revokeGrant('42424242-4242-4242-4242-424242424242', 'fixture-session-token')
        ),
    },
    {
      write: 'revokeShare',
      button: 'revoke share',
      ipc: 'revokeShare',
      sentWith: ['share-42'],
      rejection: () =>
        sessionRejection(client =>
          client.revokeShare('43434343-4343-4343-4343-434343434343', 'fixture-session-token')
        ),
    },
  ] as const
  for (const lateWrite of lateRejectedWrites)
    for (const sameSession of [true, false]) {
      it(`judges a late ${lateWrite.write} rejection by the session it was sent under (${
        sameSession ? 'same session revokes' : 'replaced session keeps access'
      })`, async () => {
        const failure = await lateWrite.rejection()
        const write = deferred<void>()
        const writeIpc = vi.fn(() => write.promise)
        Object.defineProperty(window, 'clerum', {
          configurable: true,
          value: {
            gfs: {
              listAccessible: vi.fn(async () => listAccessiblePage([])),
              resolve: vi.fn(async () => rootDirectory()),
              listChildren: vi.fn(async () => listChildrenPage([])),
              affordances: vi.fn(async () =>
                affordancesResult(heldAffordances(['read', 'manage_acl']))
              ),
              listGrants: vi.fn(async () => directGrant()),
              listShares: vi.fn(async () => sharesListPage([])),
              [lateWrite.ipc]: writeIpc,
            },
          },
        })

        render(<ManageProbe />, { wrapper: Harness })
        await act(async () => screen.getByRole('button', { name: 'open root' }).click())
        await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
        await act(async () => screen.getByRole('button', { name: 'open manage' }).click())
        await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('1'))
        await act(async () => screen.getByRole('button', { name: lateWrite.button }).click())
        await waitFor(() => expect(writeIpc).toHaveBeenCalledWith(...lateWrite.sentWith))

        if (!sameSession) {
          await act(async () => screen.getByRole('button', { name: 'switch team' }).click())
        }
        await act(async () => write.reject(new Error(failure)))

        const client = lastHarnessQueryClient!
        if (sameSession) {
          await waitFor(() =>
            expect(screen.getByTestId('access-state').textContent).toBe('revoked')
          )
          expect(client.getQueryData(desktopQueryKeys.gfsAccessState(SCOPE_A, 1))).toBe('revoked')
        } else {
          expect(screen.getByTestId('access-state').textContent).toBe('active')
          expect(client.getQueryData(desktopQueryKeys.gfsAccessState(SCOPE_B, 1))).toBe('active')
        }
      })
    }
})

// What App does with a watch `accessChanged`: the open sharing dialogs re-read.
function WatchedAccessProbe() {
  const ctrl = useGfsBrowserController()
  const queryClient = lastHarnessQueryClient!
  useGfsWatchSubscription({
    keys: [],
    userId: null,
    sessionKey: 'session',
    onEvent: event => {
      if (event.type === 'accessChanged') {
        void refetchGfsAccess(queryClient, { scope: SCOPE_A, generation: 1 })
      }
    },
  })
  const access = useGfsResourceAccess(
    { resourceId: 'root' },
    ctrl.authorityPending || ctrl.accessState === 'revoked',
    { handleAuthorityFailure: ctrl.handleAuthorityFailure }
  )
  return <div data-testid="grants-count">{access.grants.length}</div>
}

describe('useGfsResourceAccess — watch access changes', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it('re-reads every ACL list of an open target when the watch reports an access change', async () => {
    const source = await new GfsWatchEventSource().start()
    try {
      const watch = source.connectRenderer()
      const listGrants = vi.fn(async () => directGrant())
      const listShares = vi.fn(async () => sharesListPage([]))
      const resolve = vi.fn(async () => rootDirectory())
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfsWatch: watch.bridge,
          gfs: {
            listAccessible: vi.fn(async () => listAccessiblePage([])),
            resolve,
            listChildren: vi.fn(async () => listChildrenPage([])),
            affordances: vi.fn(async () =>
              affordancesResult(heldAffordances(['read', 'manage_acl']))
            ),
            listGrants,
            listShares,
          },
        },
      })

      render(<WatchedAccessProbe />, { wrapper: Harness })
      await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('1'))
      await waitFor(() => expect(watch.opens).toBe(1))
      const grantsBefore = listGrants.mock.calls.length
      const sharesBefore = listShares.mock.calls.length

      let events: Awaited<ReturnType<typeof source.reauthorize>> = []
      await act(async () => {
        events = await source.reauthorize([mainDriveKey('dir', 'root')])
      })

      expect(events.some(event => event.type === 'accessChanged')).toBe(true)
      await waitFor(() => expect(listGrants.mock.calls.length).toBeGreaterThan(grantsBefore))
      await waitFor(() => expect(listShares.mock.calls.length).toBeGreaterThan(sharesBefore))
    } finally {
      await source.stop()
    }
  })
})

// Share revalidates its target's affordances on open; the browser showing the
// same resource reads the same cached result.
function RevalidateProbe() {
  const ctrl = useGfsBrowserController()
  const access = useGfsResourceAccess(
    ctrl.current ? { resourceId: ctrl.current.resourceId } : null,
    ctrl.authorityPending || ctrl.accessState === 'revoked',
    { handleAuthorityFailure: ctrl.handleAuthorityFailure }
  )
  return (
    <>
      <div data-testid="held-permissions">{ctrl.affordances?.held.join(',') ?? 'none'}</div>
      <button type="button" onClick={() => swallow(ctrl.openUri('gfs://main/root'))}>
        open root
      </button>
      <button type="button" onClick={() => swallow(access.revalidateAffordances())}>
        refresh permissions
      </button>
    </>
  )
}

// Files mounts the Share dialog only while Share is open, so every open is a
// fresh mount of the access hook under the app's query defaults.
function ProductionHarness({ children }: { children: ReactNode }) {
  return <Harness productionQueryDefaults>{children}</Harness>
}

function ShareAccessPanel({ ctrl }: { ctrl: ReturnType<typeof useGfsBrowserController> }) {
  const access = useGfsResourceAccess(
    { resourceId: 'root' },
    ctrl.authorityPending || ctrl.accessState === 'revoked',
    { handleAuthorityFailure: ctrl.handleAuthorityFailure }
  )
  return (
    <>
      <div data-testid="grants-count">{access.grants.length}</div>
      <div data-testid="shares-count">{access.shares.length}</div>
      <div data-testid="inherited-coverage">{access.inheritedCoverage ?? 'none'}</div>
    </>
  )
}

function ReopenedShareProbe() {
  const ctrl = useGfsBrowserController()
  const queryClient = lastHarnessQueryClient!
  const [shareOpen, setShareOpen] = useState(true)
  useGfsWatchSubscription({
    keys: [],
    userId: null,
    sessionKey: 'session',
    onEvent: event => {
      if (event.type === 'accessChanged') {
        void refetchGfsAccess(queryClient, { scope: SCOPE_A, generation: 1 })
      }
    },
  })
  return (
    <>
      {shareOpen ? <ShareAccessPanel ctrl={ctrl} /> : <div data-testid="share-closed" />}
      <button type="button" onClick={() => setShareOpen(true)}>
        open share
      </button>
      <button type="button" onClick={() => setShareOpen(false)}>
        close share
      </button>
    </>
  )
}

function bobShare(): GfsShareListItem {
  return {
    id: 'share-42',
    drive: 'main',
    resourceId: 'root',
    subject: { type: 'user', id: 'bob' },
    permissions: ['read'],
    includeDescendants: false,
  }
}

describe('useGfsResourceAccess — reopening Share', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  async function reopenShare() {
    await act(async () => {
      screen.getByRole('button', { name: 'close share' }).click()
    })
    expect(screen.getByTestId('share-closed')).toBeTruthy()
    await act(async () => {
      screen.getByRole('button', { name: 'open share' }).click()
    })
  }

  it('re-reads the grants and shares an access change invalidated while Share was closed', async () => {
    const source = await new GfsWatchEventSource().start()
    try {
      const watch = source.connectRenderer()
      let grantRows = (await directGrant()).slice()
      let shareRows = await sharesListPage([])
      const listGrants = vi.fn(async () => grantRows)
      const listShares = vi.fn(async () => shareRows)
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfsWatch: watch.bridge,
          gfs: {
            listAccessible: vi.fn(async () => listAccessiblePage([])),
            resolve: vi.fn(async () => rootDirectory()),
            listChildren: vi.fn(async () => listChildrenPage([])),
            affordances: vi.fn(async () =>
              affordancesResult(heldAffordances(['read', 'manage_acl']))
            ),
            listGrants,
            listShares,
          },
        },
      })

      render(<ReopenedShareProbe />, { wrapper: ProductionHarness })
      await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('1'))
      expect(screen.getByTestId('shares-count').textContent).toBe('0')
      await waitFor(() => expect(watch.opens).toBe(1))

      await act(async () => {
        screen.getByRole('button', { name: 'close share' }).click()
      })
      // Another client changes the sharing of the target while Share is closed.
      grantRows = await grantsListPage([
        ...grantRows,
        {
          id: 'grant-43',
          drive: 'main',
          resourceId: 'root',
          subject: { type: 'team', id: 'qa' },
          permissions: ['read'],
          inherit: true,
        },
      ])
      shareRows = await sharesListPage([bobShare()])
      let events: Awaited<ReturnType<typeof source.reauthorize>> = []
      await act(async () => {
        events = await source.reauthorize([mainDriveKey('dir', 'root')])
      })
      expect(events.some(event => event.type === 'accessChanged')).toBe(true)

      await act(async () => {
        screen.getByRole('button', { name: 'open share' }).click()
      })

      await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('2'))
      await waitFor(() => expect(screen.getByTestId('shares-count').textContent).toBe('1'))
    } finally {
      await source.stop()
    }
  })

  // An 'unavailable' coverage is a FAILED walk, not an observation: reopening
  // Share must retry it instead of keeping the failure on screen.
  it('retries an unavailable inherited derivation when Share is reopened', async () => {
    const walkFailure = await gfsRouteFailureMessage(
      client => client.resolveUri('gfs://main/root', 'fixture-session-token'),
      500,
      { code: 'internal', message: 'resolve failed' }
    )
    let walkFails = true
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([])),
          resolve: vi.fn(async () => {
            if (walkFails) throw new Error(walkFailure)
            return rootDirectory()
          }),
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () =>
            affordancesResult(heldAffordances(['read', 'manage_acl']))
          ),
          listGrants: vi.fn(async () => grantsListPage([])),
          listShares: vi.fn(async () => sharesListPage([])),
        },
      },
    })

    render(<ReopenedShareProbe />, { wrapper: ProductionHarness })
    await waitFor(() =>
      expect(screen.getByTestId('inherited-coverage').textContent).toBe('unavailable')
    )

    walkFails = false
    await reopenShare()

    await waitFor(() =>
      expect(screen.getByTestId('inherited-coverage').textContent).toBe('complete')
    )
  })

  // Re-reading on every open would multiply the ancestor walk; a list nothing
  // invalidated is served from cache.
  it('serves ACL lists nothing invalidated from cache when Share is reopened', async () => {
    const listGrants = vi.fn(async () => directGrant())
    const listShares = vi.fn(async () => sharesListPage([]))
    const resolve = vi.fn(async () => rootDirectory())
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => listAccessiblePage([])),
          resolve,
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances: vi.fn(async () =>
            affordancesResult(heldAffordances(['read', 'manage_acl']))
          ),
          listGrants,
          listShares,
        },
      },
    })

    render(<ReopenedShareProbe />, { wrapper: ProductionHarness })
    await waitFor(() =>
      expect(screen.getByTestId('inherited-coverage').textContent).toBe('complete')
    )
    expect(screen.getByTestId('grants-count').textContent).toBe('1')
    const reads = [listGrants, listShares, resolve].map(fn => fn.mock.calls.length)

    await reopenShare()

    expect(screen.getByTestId('grants-count').textContent).toBe('1')
    expect(screen.getByTestId('inherited-coverage').textContent).toBe('complete')
    expect([listGrants, listShares, resolve].map(fn => fn.mock.calls.length)).toEqual(reads)
  })
})

describe('useGfsResourceAccess — target authority', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it('re-reads cached affordances of the target when Share opens after permissions changed outside Desktop', async () => {
    let held = ['read']
    const affordances = vi.fn(async () => ({
      held,
      canDelegate: held.includes('manage_acl'),
      grantableBits: held,
      canCreateShare: false,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances,
        },
      },
    })

    render(<RevalidateProbe />, { wrapper: Harness })
    await act(async () => {
      screen.getByRole('button', { name: 'open root' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('held-permissions').textContent).toBe('read'))

    held = ['read', 'write', 'delete', 'manage_acl', 'share']
    await act(async () => {
      screen.getByRole('button', { name: 'refresh permissions' }).click()
    })

    await waitFor(() =>
      expect(screen.getByTestId('held-permissions').textContent).toBe(
        'read,write,delete,manage_acl,share'
      )
    )
    expect(affordances).toHaveBeenCalledTimes(2)
  })
})
