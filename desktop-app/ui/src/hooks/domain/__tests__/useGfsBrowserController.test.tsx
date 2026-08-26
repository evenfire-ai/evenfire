// @vitest-environment jsdom
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryDefaults } from '@lib/queryClient'
import { desktopQueryKeys } from '../queryKeys'
import { useGfsBrowserController } from '../useGfsBrowserController'

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
    me,
    email: me?.email ?? '',
    password: '',
    desktopSetupAuthorizationToken: '',
    desktopSetupStarted: false,
    runtimeConfigSetupName: '',
    runtimeConfigSetupExternalRestApiBaseUrl: '',
    runtimeConfigSetupRpcProxyBaseUrl: '',
    authTransitioning: false,
    runtimeConfigState: null,
    runtimeConfigMissing: false,
    showRuntimeConfigSelector: false,
    dependencyHealth: null,
    hasDependencyOutage: false,
    setBooting: vi.fn(),
    setEmail: vi.fn(),
    setPassword: vi.fn(),
    setDesktopSetupAuthorizationToken: vi.fn(),
    setRuntimeConfigSetupName: vi.fn(),
    setRuntimeConfigSetupExternalRestApiBaseUrl: vi.fn(),
    setRuntimeConfigSetupRpcProxyBaseUrl: vi.fn(),
    setStatus: vi.fn(),
    loadSession: vi.fn(),
    handlePasswordLogin: vi.fn(),
    handleStartDesktopSetup: vi.fn(),
    handleCompleteDesktopSetup: vi.fn(),
    handleSaveRuntimeConfig: vi.fn(),
    handleDeleteRuntimeConfig: vi.fn(),
    handleSelectRuntimeConfig: vi.fn(),
    handleLogout: vi.fn(),
  }
}

function Probe() {
  const ctrl = useGfsBrowserController()
  return (
    <>
      <div data-testid="current">{ctrl.current?.resourceId ?? 'none'}</div>
      <div data-testid="current-name">{ctrl.current?.name ?? 'none'}</div>
      <div data-testid="current-version">{ctrl.current?.version ?? 'none'}</div>
      <div data-testid="crumbs">{ctrl.crumbs.map(crumb => crumb.name).join(' / ')}</div>
      <div data-testid="access-state">{ctrl.accessState}</div>
      <div data-testid="authority-pending">{ctrl.authorityPending ? 'pending' : 'ready'}</div>
      <div data-testid="accessible-count">{ctrl.accessibleResources.length}</div>
      <div data-testid="items-count">{ctrl.items.length}</div>
      <div data-testid="accessible-error">{ctrl.accessibleError ?? 'none'}</div>
      <div data-testid="accessible-notice">{ctrl.accessibleNotice ?? 'none'}</div>
      <div data-testid="held-permissions">{ctrl.affordances?.held.join(',') ?? 'none'}</div>
      {ctrl.accessibleResources.map(resource => (
        <button key={resource.resourceId} type="button" onClick={() => ctrl.openResource(resource)}>
          open {resource.name}
        </button>
      ))}
      {ctrl.crumbs.map((crumb, index) => (
        <button key={crumb.resourceId} type="button" onClick={() => ctrl.goToCrumb(index)}>
          crumb {crumb.name}
        </button>
      ))}
      <button type="button" onClick={() => void ctrl.openUri('gfs://main/root')}>
        open
      </button>
      <button type="button" onClick={() => void ctrl.refreshAffordances()}>
        refresh permissions
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl
                .createFile(ctrl.current.resourceId, 'notes.md', 'IyBOb3Rlcw==')
                .catch(() => {})
            : undefined
        }
      >
        upload current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl
                .renameResource(ctrl.current.resourceId, 'Renamed report.md', ctrl.current.version)
                .catch(() => {})
            : undefined
        }
      >
        rename current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl
                .replaceFile(ctrl.current.resourceId, 'aGVsbG8=', ctrl.current.version)
                .catch(() => {})
            : undefined
        }
      >
        replace current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl
                .moveResource(ctrl.current.resourceId, 'destination-1', ctrl.current.version)
                .catch(() => {})
            : undefined
        }
      >
        move current
      </button>
      <button type="button" onClick={() => ctrl.retryAccess()}>
        retry access
      </button>
    </>
  )
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

/** Same harness, but with the REAL production query cache policy. */
function ProductionHarness({ children }: { children: ReactNode }) {
  return <Harness productionQueryDefaults>{children}</Harness>
}

describe('useGfsBrowserController', () => {
  afterEach(() => {
    cleanup()
    lastHarnessQueryClient = null
    vi.restoreAllMocks()
  })

  it('resets visible GFS state when the authenticated session scope changes', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [],
            nextCursor: null,
          })),
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
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

    render(<Probe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))

    const grantsKey = desktopQueryKeys.gfsGrants(':user-a:team-a', 'root', 'main')
    lastHarnessQueryClient?.setQueryData(grantsKey, ['session-a-grant'])
    expect(lastHarnessQueryClient?.getQueryData(grantsKey)).toEqual(['session-a-grant'])

    await act(async () => {
      screen.getByRole('button', { name: 'switch team' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('none'))
    expect(lastHarnessQueryClient?.getQueryData(grantsKey)).toBeUndefined()
  })

  it('refreshes cached affordances after permissions change outside Desktop', async () => {
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

    render(<Probe />, { wrapper: Harness })
    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
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

  it('refreshes folder content after upload without invalidating permission affordances', async () => {
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    const affordances = vi.fn(async () => ({
      held: ['read', 'write'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }))
    const createFile = vi.fn(async () => undefined)
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
          listChildren,
          affordances,
          createFile,
        },
      },
    })

    render(<Probe />, { wrapper: Harness })
    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() => expect(affordances).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))

    await act(async () => {
      screen.getByRole('button', { name: 'upload current' }).click()
    })

    await waitFor(() =>
      expect(createFile).toHaveBeenCalledWith('root', 'notes.md', 'IyBOb3Rlcw==', 'main')
    )
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2))
    expect(affordances).toHaveBeenCalledTimes(1)
  })

  it('loads accessible GFS resources and opens one without a pasted link', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [
              {
                resourceId: 'team-folder',
                rid: 'teamfolder',
                gfsUri: 'gfs://main/teamfolder',
                drive: 'main',
                parentResourceId: null,
                name: 'Team folder tree',
                kind: 'directory',
                path: '/org/team-folder-tree',
                version: 1,
                bytes: 0,
                sources: ['grant'],
                permissions: ['read'],
                coversDescendants: true,
              },
              {
                resourceId: 'external-file',
                rid: 'externalfile',
                gfsUri: 'gfs://main/externalfile',
                drive: 'main',
                parentResourceId: 'other-tree',
                name: 'External report.pdf',
                kind: 'file',
                path: '/other-org/reports/External report.pdf',
                version: 1,
                bytes: 42,
                sources: ['share'],
                permissions: ['read'],
                coversDescendants: false,
              },
            ],
            nextCursor: null,
          })),
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

    render(<Probe />, { wrapper: Harness })

    await waitFor(() => expect(screen.getByTestId('accessible-count').textContent).toBe('2'))

    await act(async () => {
      screen.getByRole('button', { name: 'open Team folder tree' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('team-folder'))
  })

  it('hydrates readable parent folders for a directly opened file', async () => {
    const rootId = '00000000-0000-0000-0000-000000000001'
    const projectsId = '00000000-0000-0000-0000-000000000002'
    const assetsId = '00000000-0000-0000-0000-000000000003'
    const fileId = '00000000-0000-0000-0000-000000000004'
    const byUri = new Map([
      [
        'gfs://main/root',
        {
          resourceId: fileId,
          parentResourceId: assetsId,
          gfsUri: `gfs://main/${fileId.replace(/-/g, '')}`,
          drive: 'main',
          name: 'avatar.png',
          kind: 'file',
          version: 4,
        },
      ],
      [
        `gfs://main/${assetsId.replace(/-/g, '')}`,
        {
          resourceId: assetsId,
          parentResourceId: projectsId,
          gfsUri: `gfs://main/${assetsId.replace(/-/g, '')}`,
          drive: 'main',
          name: 'Assets',
          kind: 'directory',
          version: 3,
        },
      ],
      [
        `gfs://main/${projectsId.replace(/-/g, '')}`,
        {
          resourceId: projectsId,
          parentResourceId: rootId,
          gfsUri: `gfs://main/${projectsId.replace(/-/g, '')}`,
          drive: 'main',
          name: 'Projects',
          kind: 'directory',
          version: 2,
        },
      ],
      [
        `gfs://main/${rootId.replace(/-/g, '')}`,
        {
          resourceId: rootId,
          parentResourceId: null,
          gfsUri: `gfs://main/${rootId.replace(/-/g, '')}`,
          drive: 'main',
          name: '',
          kind: 'directory',
          version: 1,
        },
      ],
    ])
    const resolve = vi.fn(async (uri: string) => {
      const resource = byUri.get(uri)
      if (!resource) throw new Error(`Unexpected URI: ${uri}`)
      return resource
    })
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [], nextCursor: null })),
          resolve,
          listChildren,
          affordances: vi.fn(async () => ({
            held: ['read'],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('crumbs').textContent).toBe('Projects / Assets / avatar.png')
    )

    await act(async () => {
      screen.getByRole('button', { name: 'crumb Assets' }).click()
    })
    expect(screen.getByTestId('current-name').textContent).toBe('Assets')
    await waitFor(() => expect(listChildren).toHaveBeenCalledWith(assetsId, 'main', undefined))
  })

  it('keeps the visible current resource in sync after rename and replace mutations', async () => {
    const fileResource = {
      resourceId: 'file-1',
      rid: 'file1',
      gfsUri: 'gfs://main/file1',
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'Draft report.md',
      kind: 'file' as const,
      path: '/Draft report.md',
      version: 1,
      bytes: 12,
      sources: ['grant'],
      permissions: ['read', 'write'],
      coversDescendants: false,
    }
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({ items: [fileResource], nextCursor: null })),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'write'],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
          renameResource: vi.fn(async () => ({ resourceId: 'file-1', version: 2 })),
          replaceFile: vi.fn(async () => ({
            ...fileResource,
            name: 'Renamed report.md',
            version: 3,
            bytes: 5,
          })),
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await waitFor(() => expect(screen.getByTestId('accessible-count').textContent).toBe('1'))

    await act(async () => {
      screen.getByRole('button', { name: 'open Draft report.md' }).click()
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-name').textContent).toBe('Draft report.md')
    )

    await act(async () => {
      screen.getByRole('button', { name: 'rename current' }).click()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId('current-name').textContent).toBe('Renamed report.md')
    )
    expect(screen.getByTestId('current-version').textContent).toBe('2')

    await act(async () => {
      screen.getByRole('button', { name: 'replace current' }).click()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByTestId('current-version').textContent).toBe('3'))
    expect(screen.getByTestId('current-name').textContent).toBe('Renamed report.md')
  })

  it('treats a runtime without automatic resource discovery as a non-error state', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => ({
            resourceId: 'root',
            gfsUri: 'gfs://main/root',
            name: 'Root',
            kind: 'directory',
          })),
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

    render(<Probe />, { wrapper: Harness })

    await waitFor(() => expect(screen.getByTestId('accessible-count').textContent).toBe('0'))
    expect(screen.getByTestId('accessible-error').textContent).toBe('none')
    expect(screen.getByTestId('accessible-notice').textContent).toContain(
      'Automatic GFS discovery is not available'
    )

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
  })

  it('maps an older server discovery 404 to a notice instead of a red error', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => {
            throw new Error('404 Not Found: Not Found')
          }),
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

    render(<Probe />, { wrapper: Harness })

    await waitFor(() =>
      expect(screen.getByTestId('accessible-notice').textContent).toContain(
        'Automatic GFS discovery is not available'
      )
    )
    expect(screen.getByTestId('accessible-error').textContent).toBe('none')
    expect(screen.getByTestId('accessible-count').textContent).toBe('0')
  })

  it('reconciles the open folder after a move and feeds the returned version into follow-up actions', async () => {
    const docsId = '11111111-1111-1111-1111-111111111111'
    const rootId = '00000000-0000-0000-0000-00000000000a'
    const projectsId = '00000000-0000-0000-0000-00000000000b'
    const archiveId = '00000000-0000-0000-0000-00000000000c'
    const rid = (id: string) => id.replace(/-/g, '')
    interface ResolvedResource {
      resourceId: string
      parentResourceId: string | null
      gfsUri: string
      drive: string
      name: string
      kind: 'directory' | 'file'
      version: number
    }
    // The server state flips together with the move: Docs starts under
    // Projects and ends under Archive, with version 9 (the move receipt).
    const docsBefore: ResolvedResource = {
      resourceId: docsId,
      parentResourceId: projectsId,
      gfsUri: `gfs://main/${rid(docsId)}`,
      drive: 'main',
      name: 'Docs',
      kind: 'directory',
      version: 3,
    }
    const state = new Map<string, ResolvedResource>([
      [`gfs://main/${rid(docsId)}`, docsBefore],
      [
        `gfs://main/${rid(projectsId)}`,
        {
          resourceId: projectsId,
          parentResourceId: rootId,
          gfsUri: `gfs://main/${rid(projectsId)}`,
          drive: 'main',
          name: 'Projects',
          kind: 'directory',
          version: 1,
        },
      ],
      [
        `gfs://main/${rid(archiveId)}`,
        {
          resourceId: archiveId,
          parentResourceId: rootId,
          gfsUri: `gfs://main/${rid(archiveId)}`,
          drive: 'main',
          name: 'Archive',
          kind: 'directory',
          version: 1,
        },
      ],
      [
        `gfs://main/${rid(rootId)}`,
        {
          resourceId: rootId,
          parentResourceId: null,
          gfsUri: `gfs://main/${rid(rootId)}`,
          drive: 'main',
          name: 'Root',
          kind: 'directory',
          version: 1,
        },
      ],
    ])
    const resolve = vi.fn(async (uri: string) => {
      const resource = state.get(uri)
      if (!resource) throw new Error(`Unexpected URI: ${uri}`)
      return resource
    })
    const moveResource = vi.fn(async () => ({ resourceId: docsId, version: 9 }))
    const renameResource = vi.fn(async () => ({ resourceId: docsId, version: 10 }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [
              {
                resourceId: docsId,
                rid: rid(docsId),
                gfsUri: `gfs://main/${rid(docsId)}`,
                drive: 'main',
                parentResourceId: projectsId,
                name: 'Docs',
                kind: 'directory',
                path: null,
                version: 3,
                bytes: 0,
                sources: ['grant'],
                permissions: ['read', 'write', 'delete'],
                coversDescendants: true,
              },
            ],
            nextCursor: null,
          })),
          resolve,
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'write', 'delete'],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
          moveResource,
          renameResource,
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await waitFor(() => expect(screen.getByTestId('accessible-count').textContent).toBe('1'))
    await act(async () => {
      screen.getByRole('button', { name: 'open Docs' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(docsId))
    expect(screen.getByTestId('current-version').textContent).toBe('3')

    // The server applies the move: Docs now lives under Archive with v9.
    state.set(`gfs://main/${rid(docsId)}`, {
      ...docsBefore,
      parentResourceId: archiveId,
      version: 9,
    })

    await act(async () => {
      screen.getByRole('button', { name: 'move current' }).click()
    })
    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith(docsId, 'destination-1', 'main', 3)
    )
    // Navigation reconciles to the new location and consumes the new version.
    await waitFor(() =>
      expect(screen.getByTestId('crumbs').textContent).toBe('Root / Archive / Docs')
    )
    expect(screen.getByTestId('current-version').textContent).toBe('9')

    // A versioned action right after the move uses the post-move version.
    await act(async () => {
      screen.getByRole('button', { name: 'rename current' }).click()
    })
    await waitFor(() =>
      expect(renameResource).toHaveBeenCalledWith(docsId, 'Renamed report.md', 'main', 9)
    )
  })

  it('fails closed on an authorization failure and drops cached gfs state under production query defaults', async () => {
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    const affordances = vi.fn(async () => ({
      held: ['read', 'write'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }))
    const renameResource = vi.fn(async () => ({ resourceId: 'root', version: 2 }))
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
          listChildren,
          affordances,
          renameResource,
        },
      },
    })

    render(<Probe />, { wrapper: ProductionHarness })

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await waitFor(() => expect(listChildren).toHaveBeenCalledTimes(1))

    const childrenKey = desktopQueryKeys.gfsChildren(':user-a:team-a', 'root', 'main')
    expect(lastHarnessQueryClient?.getQueryData(childrenKey)).toBeTruthy()

    // Access is revoked server-side; the next refetch observes the 401.
    listChildren.mockRejectedValue(new Error('401 Unauthorized: session rejected'))
    affordances.mockRejectedValue(new Error('401 Unauthorized: session rejected'))

    await act(async () => {
      screen.getByRole('button', { name: 'rename current' }).click()
    })
    await waitFor(() => expect(renameResource).toHaveBeenCalled())

    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('revoked'))
    expect(screen.getByTestId('current').textContent).toBe('none')
    expect(screen.getByTestId('crumbs').textContent).toBe('')
    // The cached listing must not outlive the access that produced it.
    expect(lastHarnessQueryClient?.getQueryData(childrenKey)).toBeUndefined()
  })

  it('revalidates accessible resources on remount even under production cache defaults', async () => {
    const listAccessible = vi.fn(async () => ({ items: [], nextCursor: null }))
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

    // One shared client with the REAL production defaults (Infinity staleTime,
    // refetchOnMount disabled): the second mount must still hit the server.
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={authValue(userA)}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )

    const first = render(<Probe />, { wrapper })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    first.unmount()

    render(<Probe />, { wrapper })
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(2))
  })

  // R4 spec §1 — the authority revocation scenario: caches are fully
  // populated (roots, children, grants, shares), then the session's authority
  // is revoked server-side. The remounted browser must not render ANY of it —
  // not before the (deferred) discovery response lands, and not after it
  // fails with 401 — and the failure must purge every session-scoped cache.
  it('withholds cached gfs state while authority revalidates and purges it when discovery fails 401', async () => {
    const scope = ':user-a:team-a'
    const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const accessiblePage = {
      pages: [
        {
          items: [
            {
              resourceId: 'folder-x',
              rid: 'folderx',
              gfsUri: 'gfs://main/folderx',
              drive: 'main',
              parentResourceId: null,
              name: 'Folder X',
              kind: 'directory',
              path: '/folder-x',
              version: 1,
              bytes: 0,
              sources: ['grant'],
              permissions: ['read'],
              coversDescendants: true,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    }
    client.setQueryData(desktopQueryKeys.gfsAccessible(scope, 'main'), accessiblePage)
    client.setQueryData(desktopQueryKeys.gfsChildren(scope, 'folder-x', 'main'), accessiblePage)
    client.setQueryData(desktopQueryKeys.gfsGrants(scope, 'folder-x', 'main'), [
      {
        id: 'grant-1',
        drive: 'main',
        resourceId: 'folder-x',
        subject: { type: 'user', id: 'u' },
        permissions: ['read'],
        inherit: false,
      },
    ])
    client.setQueryData(desktopQueryKeys.gfsShares(scope, 'folder-x', 'main'), [
      {
        id: 'share-1',
        drive: 'main',
        resourceId: 'folder-x',
        subject: { type: 'user', id: 'u' },
        permissions: ['read'],
        includeDescendants: false,
      },
    ])
    expect(
      client.getQueryData(desktopQueryKeys.gfsChildren(scope, 'folder-x', 'main'))
    ).toBeTruthy()

    // Deferred discovery: authority is being rechecked but the server has
    // not answered yet.
    let failDiscovery: ((error: Error) => void) | undefined
    const listAccessible = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          failDiscovery = reject
        })
    )
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    const affordances = vi.fn(async () => ({
      held: ['read'],
      canDelegate: false,
      grantableBits: [],
      canCreateShare: false,
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(async () => ({
            resourceId: 'folder-x',
            gfsUri: 'gfs://main/folderx',
            name: 'Folder X',
            kind: 'directory',
            version: 1,
          })),
          listChildren,
          affordances,
        },
      },
    })

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthContext.Provider value={authValue(userA)}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </AuthContext.Provider>
    )
    render(<Probe />, { wrapper })

    // BEFORE the failure: cached roots/children must be withheld from render.
    await waitFor(() => expect(listAccessible).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('authority-pending').textContent).toBe('pending')
    expect(screen.getByTestId('accessible-count').textContent).toBe('0')

    // Entering the prefetched child cannot bypass revalidation either: the
    // children cache is populated, but its rows stay withheld.
    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('folder-x'))
    expect(screen.getByTestId('authority-pending').textContent).toBe('pending')
    expect(screen.getByTestId('items-count').textContent).toBe('0')

    // AFTER the failure: the 401 fails the session closed — every cached
    // surface is purged and navigation state is gone.
    await act(async () => {
      failDiscovery?.(new Error('401 Unauthorized: session rejected'))
    })
    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('revoked'))
    expect(screen.getByTestId('current').textContent).toBe('none')
    expect(screen.getByTestId('crumbs').textContent).toBe('')
    expect(client.getQueryData(desktopQueryKeys.gfsAccessible(scope, 'main'))).toBeUndefined()
    expect(
      client.getQueryData(desktopQueryKeys.gfsChildren(scope, 'folder-x', 'main'))
    ).toBeUndefined()
    expect(
      client.getQueryData(desktopQueryKeys.gfsGrants(scope, 'folder-x', 'main'))
    ).toBeUndefined()
    expect(
      client.getQueryData(desktopQueryKeys.gfsShares(scope, 'folder-x', 'main'))
    ).toBeUndefined()
  })

  it('fails a mutation-carrying session closed when an imperative operation reports 401', async () => {
    const renameResource = vi.fn(async () => {
      throw new Error('401 Unauthorized: session rejected')
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
            held: ['read'],
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })),
          renameResource,
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await act(async () => {
      screen.getByRole('button', { name: 'open' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('root'))
    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('active'))

    // The mutation's rejection propagates to the caller AND the shared
    // mutation onError boundary fails the session closed.
    await act(async () => {
      screen.getByRole('button', { name: 'rename current' }).click()
    })
    await waitFor(() => expect(renameResource).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('revoked'))
    expect(screen.getByTestId('crumbs').textContent).toBe('')
  })
})

// The grants listing is gated by the `grantsListEnabled` hook option (the Manage
// dialog is the only consumer, so the query runs only while it is open). This
// probe drives that option through local state so a test can flip Manage
// open/closed, and it reuses the real QueryClient from `Harness` so invalidation
// genuinely refetches — mocking the client would hide the load-after-write wiring
// this block exists to protect.
function ManageProbe() {
  const [manageOpen, setManageOpen] = useState(false)
  const ctrl = useGfsBrowserController({ grantsListEnabled: manageOpen })
  return (
    <>
      <div data-testid="current">{ctrl.current?.resourceId ?? 'none'}</div>
      <div data-testid="grants-count">{ctrl.grants.length}</div>
      <div data-testid="shares-count">{ctrl.shares.length}</div>
      <button type="button" onClick={() => void ctrl.openUri('gfs://main/root')}>
        open root
      </button>
      <button type="button" onClick={() => setManageOpen(true)}>
        open manage
      </button>
      <button type="button" onClick={() => setManageOpen(false)}>
        close manage
      </button>
      <button type="button" onClick={() => void ctrl.refreshGrants()}>
        refresh grants
      </button>
      <button type="button" onClick={() => void ctrl.revokeGrant('grant-42')}>
        revoke grant
      </button>
      <button type="button" onClick={() => void ctrl.grant(['user:bob'], ['read'], true)}>
        grant inherit true
      </button>
      <button type="button" onClick={() => void ctrl.grant(['team:qa'], ['read'], false)}>
        grant inherit false
      </button>
      <button type="button" onClick={() => void ctrl.refreshShares()}>
        refresh shares
      </button>
      <button type="button" onClick={() => void ctrl.revokeShare('share-42')}>
        revoke share
      </button>
      <button
        type="button"
        onClick={() => void ctrl.createShare(['user:bob']).then(() => ctrl.refreshShares())}
      >
        create share
      </button>
    </>
  )
}

describe('useGfsBrowserController — grants list / revoke / inherit (#826)', () => {
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
        desktopQueryKeys.gfsGrants(':user-a:team-a', 'root', 'main')
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
        desktopQueryKeys.gfsShares(':user-a:team-a', 'root', 'main')
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

  it('shows a newly created share without remounting (create → refreshShares)', async () => {
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
})
