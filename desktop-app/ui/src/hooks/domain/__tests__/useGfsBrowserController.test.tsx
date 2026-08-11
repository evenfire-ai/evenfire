// @vitest-environment jsdom
import { type ReactNode, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

const userC = {
  ...userA,
  id: 'user-c',
  email: 'c@example.test',
  name: 'User C',
}

function authValue(me: AuthContextValue['me'], envKey = 'env-a'): AuthContextValue {
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
    runtimeConfigState: {
      configured: true,
      isLocalhost: false,
      selectorVisible: false,
      activeOptionId: envKey,
      envKey,
      storagePath: `/tmp/${envKey}`,
      options: [],
    },
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
      <div data-testid="view">{ctrl.view}</div>
      <div data-testid="access-state">{ctrl.accessState}</div>
      <div data-testid="operator-root">{ctrl.isOperatorRoot ? 'yes' : 'no'}</div>
      <div data-testid="accessible-count">{ctrl.accessibleResources.length}</div>
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
      <button type="button" onClick={() => ctrl.reset()}>
        reset browser
      </button>
      <button type="button" onClick={() => ctrl.retryAccess()}>
        retry access
      </button>
      <button type="button" onClick={() => void ctrl.createFolder('Root docs')}>
        create folder current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl.createFile(ctrl.current.resourceId, 'notes.md', 'IyBOb3Rlcw==')
            : undefined
        }
      >
        upload current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl.renameResource(
                ctrl.current.resourceId,
                'Renamed report.md',
                ctrl.current.version
              )
            : undefined
        }
      >
        rename current
      </button>
      <button
        type="button"
        onClick={() =>
          ctrl.current
            ? void ctrl.replaceFile(ctrl.current.resourceId, 'aGVsbG8=', ctrl.current.version)
            : undefined
        }
      >
        replace current
      </button>
    </>
  )
}

function Harness({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthContextValue['me']>(userA)
  const [envKey, setEnvKey] = useState('env-a')
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  return (
    <AuthContext.Provider value={authValue(me, envKey)}>
      <QueryClientProvider client={client}>
        {children}
        <button type="button" onClick={() => setMe(userB)}>
          switch team
        </button>
        <button type="button" onClick={() => setMe(userC)}>
          switch user
        </button>
        <button type="button" onClick={() => setEnvKey('env-b')}>
          switch environment
        </button>
        <button type="button" onClick={() => setMe(null)}>
          sign out
        </button>
      </QueryClientProvider>
    </AuthContext.Provider>
  )
}

describe('useGfsBrowserController', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it.each(['switch team', 'switch user', 'sign out'])(
    'resets visible GFS state after %s changes the authenticated scope',
    async action => {
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

      await act(async () => {
        screen.getByRole('button', { name: action }).click()
      })

      await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('none'))
    }
  )

  it('initializes the linked operator at the real root and uses it for root mutations', async () => {
    const rootResourceId = '11111111-1111-1111-1111-111111111111'
    const child = {
      resourceId: '22222222-2222-2222-2222-222222222222',
      rid: '22222222222222222222222222222222',
      gfsUri: 'gfs://main/22222222222222222222222222222222',
      drive: 'main',
      parentResourceId: rootResourceId,
      name: 'Projects',
      kind: 'directory' as const,
      path: '/Projects',
      version: 1,
      bytes: 0,
      sources: [],
      permissions: ['read', 'write'],
      coversDescendants: false,
    }
    const listChildren = vi.fn(async () => ({ items: [], nextCursor: null }))
    const createFolder = vi.fn(async () => child)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [child],
            nextCursor: null,
            rootResourceId,
            view: 'operator' as const,
          })),
          resolve: vi.fn(),
          listChildren,
          affordances: vi.fn(async () => ({
            held: ['read', 'write', 'delete', 'manage_acl', 'share'],
            canDelegate: true,
            grantableBits: ['read', 'write', 'delete', 'manage_acl', 'share'],
            canCreateShare: true,
          })),
          createFolder,
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(rootResourceId))
    expect(screen.getByTestId('view').textContent).toBe('operator')
    expect(screen.getByTestId('operator-root').textContent).toBe('yes')
    expect(screen.getByTestId('crumbs').textContent).toBe('Global File System')
    expect(screen.getByTestId('accessible-count').textContent).toBe('1')
    expect(listChildren).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'create folder current' }).click()
    })
    await waitFor(() =>
      expect(createFolder).toHaveBeenCalledWith(rootResourceId, 'Root docs', 'main')
    )

    await act(async () => {
      screen.getByRole('button', { name: 'open Projects' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(child.resourceId))
    expect(screen.getByTestId('crumbs').textContent).toBe('Global File System / Projects')
    await waitFor(() =>
      expect(listChildren).toHaveBeenCalledWith(child.resourceId, 'main', undefined)
    )

    await act(async () => {
      screen.getByRole('button', { name: 'create folder current' }).click()
    })
    await waitFor(() =>
      expect(createFolder).toHaveBeenLastCalledWith(child.resourceId, 'Root docs', 'main')
    )

    await act(async () => {
      screen.getByRole('button', { name: 'reset browser' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(rootResourceId))
  })

  it('replaces cached operator-root state when the environment changes', async () => {
    const roots = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    let call = 0
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [],
            nextCursor: null,
            rootResourceId: roots[Math.min(call++, roots.length - 1)],
            view: 'operator' as const,
          })),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
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
    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(roots[0]))

    await act(async () => {
      screen.getByRole('button', { name: 'switch environment' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe(roots[1]))
    expect(screen.getByTestId('crumbs').textContent).toBe('Global File System')
  })

  it('clears operator-root state when the next authenticated scope is an ordinary user', async () => {
    const rootResourceId = '11111111-1111-1111-1111-111111111111'
    const ordinaryResource = {
      resourceId: '33333333-3333-4333-8333-333333333333',
      rid: '33333333333343338333333333333333',
      gfsUri: 'gfs://main/33333333333343338333333333333333',
      drive: 'main',
      parentResourceId: null,
      name: 'Shared report.md',
      kind: 'file' as const,
      path: '/Shared report.md',
      version: 1,
      bytes: 12,
      sources: ['share'],
      permissions: ['read'],
      coversDescendants: false,
    }
    let call = 0
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () =>
            call++ === 0
              ? { items: [], nextCursor: null, rootResourceId, view: 'operator' as const }
              : { items: [ordinaryResource], nextCursor: null }
          ),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
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
    await waitFor(() => expect(screen.getByTestId('operator-root').textContent).toBe('yes'))

    await act(async () => {
      screen.getByRole('button', { name: 'switch team' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('view').textContent).toBe('shared'))
    expect(screen.getByTestId('operator-root').textContent).toBe('no')
    expect(screen.getByTestId('current').textContent).toBe('none')
    expect(screen.getByTestId('crumbs').textContent).toBe('')
    expect(screen.getByTestId('accessible-count').textContent).toBe('1')
  })

  it('fails closed when operator mode omits a valid rootResourceId', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => ({
            items: [],
            nextCursor: null,
            view: 'operator' as const,
          })),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(),
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await waitFor(() =>
      expect(screen.getByTestId('accessible-error').textContent).toContain('operator_root_missing')
    )
    expect(screen.getByTestId('current').textContent).toBe('none')
  })

  it('clears cached operator state after a 403 and retries only through fresh server discovery', async () => {
    const rootResourceId = '11111111-1111-1111-1111-111111111111'
    let active = true
    const listAccessible = vi.fn(async () => {
      if (!active) throw new Error('403 operator_link_inactive')
      return { items: [], nextCursor: null, rootResourceId, view: 'operator' as const }
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible,
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(async () => ({
            held: ['read', 'write'],
            canDelegate: true,
            grantableBits: ['read', 'write'],
            canCreateShare: true,
          })),
        },
      },
    })

    render(<Probe />, { wrapper: Harness })
    await waitFor(() => expect(screen.getByTestId('operator-root').textContent).toBe('yes'))

    active = false
    await act(async () => {
      screen.getByRole('button', { name: 'reset browser' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('access-state').textContent).toBe('revoked'))
    expect(screen.getByTestId('current').textContent).toBe('none')
    expect(screen.getByTestId('accessible-count').textContent).toBe('0')

    active = true
    await act(async () => {
      screen.getByRole('button', { name: 'retry access' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('operator-root').textContent).toBe('yes'))
    expect(listAccessible).toHaveBeenCalledTimes(3)
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

  it('keeps an unseeded drive distinct from the older-server 404 notice', async () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          listAccessible: vi.fn(async () => {
            throw new Error('404 Not Found: drive_not_seeded')
          }),
          resolve: vi.fn(),
          listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
          affordances: vi.fn(),
        },
      },
    })

    render(<Probe />, { wrapper: Harness })

    await waitFor(() =>
      expect(screen.getByTestId('accessible-error').textContent).toContain('drive_not_seeded')
    )
    expect(screen.getByTestId('accessible-notice').textContent).toBe('none')
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
      <button type="button" onClick={() => void ctrl.revokeShare('share-42')}>
        revoke share
      </button>
      <button type="button" onClick={() => void ctrl.grant(['user:bob'], ['read'], true)}>
        grant inherit true
      </button>
      <button type="button" onClick={() => void ctrl.grant(['team:qa'], ['read'], false)}>
        grant inherit false
      </button>
    </>
  )
}

describe('useGfsBrowserController — grants list / revoke / inherit (#826)', () => {
  afterEach(() => {
    cleanup()
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
    const listShares = vi.fn(async () => [])
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
          listShares,
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
    expect(listShares).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'open manage' }).click()
    })
    await waitFor(() => expect(listGrants).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(1))
    expect(listGrants).toHaveBeenCalledWith('root', 'main')
    await waitFor(() => expect(screen.getByTestId('grants-count').textContent).toBe('1'))
  })

  it('refetches the grants list when refreshGrants runs', async () => {
    const listGrants = vi.fn(async () => [])
    const listShares = vi.fn(async () => [])
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
          listShares,
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
    const listShares = vi.fn(async () => [])
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
          listShares,
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

  it('lists and revokes a share by id, then refetches only the share list', async () => {
    const listGrants = vi.fn(async () => [])
    const listShares = vi.fn(async () => [
      {
        id: 'share-42',
        drive: 'main',
        resourceId: 'root',
        subject: { type: 'team', id: 'qa' },
        permissions: ['read'],
        includeDescendants: true,
      },
    ])
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
            held: ['read', 'manage_acl', 'share'],
            canDelegate: true,
            grantableBits: ['read'],
            canCreateShare: true,
          })),
          listGrants,
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
    await waitFor(() => expect(screen.getByTestId('shares-count').textContent).toBe('1'))

    await act(async () => {
      screen.getByRole('button', { name: 'revoke share' }).click()
    })

    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith('share-42'))
    await waitFor(() => expect(listShares).toHaveBeenCalledTimes(2))
    expect(listGrants).toHaveBeenCalledTimes(1)
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
})
