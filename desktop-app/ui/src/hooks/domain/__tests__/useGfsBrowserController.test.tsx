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
      <div data-testid="accessible-count">{ctrl.accessibleResources.length}</div>
      <div data-testid="accessible-error">{ctrl.accessibleError ?? 'none'}</div>
      <div data-testid="accessible-notice">{ctrl.accessibleNotice ?? 'none'}</div>
      {ctrl.accessibleResources.map(resource => (
        <button key={resource.resourceId} type="button" onClick={() => ctrl.openResource(resource)}>
          open {resource.name}
        </button>
      ))}
      <button type="button" onClick={() => void ctrl.openUri('gfs://main/root')}>
        open
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
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
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

describe('useGfsBrowserController', () => {
  afterEach(() => {
    cleanup()
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

    await act(async () => {
      screen.getByRole('button', { name: 'switch team' }).click()
    })

    await waitFor(() => expect(screen.getByTestId('current').textContent).toBe('none'))
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
})
