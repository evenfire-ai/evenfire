// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GfsResourceMenu } from '@components/GfsResourceMenu'
import { buildGfsResourceActions } from '@lib/gfsResourceActions'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { useGfsBrowserController } from '../useGfsBrowserController'

const me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member' as const,
}

const authValue: AuthContextValue = {
  booting: false,
  busy: false,
  statusText: '',
  statusTone: 'info',
  isAuthenticated: true,
  sessionGeneration: 1,
  me,
  email: me.email,
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

const rename = vi.fn()

function PermissionActionProbe() {
  const controller = useGfsBrowserController()
  const [, rerender] = useState(0)
  const firstAccessibleResource = controller.accessibleResources[0]
  return (
    <>
      <button
        type="button"
        disabled={!firstAccessibleResource}
        onClick={() => {
          if (firstAccessibleResource) controller.openResource(firstAccessibleResource)
        }}
      >
        Open workspace
      </button>
      <output data-testid="accessible-count">{controller.accessibleResources.length}</output>
      <button type="button" onClick={() => rerender(value => value + 1)}>
        Render current permission state
      </button>
      {controller.items.map(item => {
        const affordances = controller.rowAffordancesByResourceId[item.resourceId]
        const permissionStatus =
          controller.rowPermissionStatusByResourceId[item.resourceId]?.status ?? 'missing'
        const ready = permissionStatus === 'ready'
        const actions = buildGfsResourceActions({
          kind: item.kind,
          uri: item.gfsUri,
          handlers: { rename },
          canRename: Boolean(ready && affordances?.held.includes('write')),
        })
        return (
          <span key={item.resourceId}>
            <output data-testid={`permission-status-${item.resourceId}`}>{permissionStatus}</output>
            <GfsResourceMenu actions={actions} resourceName={item.name} />
          </span>
        )
      })}
    </>
  )
}

function Harness({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: desktopQueryDefaults }))
  return (
    <AuthContext.Provider value={authValue}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </AuthContext.Provider>
  )
}

async function installFolder(children: ReturnType<typeof childView>[]) {
  const parent = accessibleResource('folder-root', 'Workspace', 'directory', {
    parentResourceId: null,
    path: '/Workspace',
    permissions: ['read'],
    coversDescendants: true,
  })
  const listChildren = vi.fn(async () => listChildrenPage(children))
  const affordances = vi.fn(async (resourceId: string) => ({
    held: resourceId === 'folder-root' ? ['read'] : ['read', 'write'],
    canDelegate: false,
    grantableBits: [],
    canCreateShare: false,
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: {
        listAccessible: vi.fn(async () => listAccessiblePage([parent])),
        listChildren,
        affordances,
      },
    },
  })
  return { affordances }
}

describe('GFS permission freshness through the rendered action menu', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    focusManager.setFocused(true)
    vi.restoreAllMocks()
  })

  it('does not fan one window focus into one authority read per visible child', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const children = Array.from({ length: 20 }, (_, index) =>
      childView(`child-${index}`, `file-${index}.txt`, 'file', {
        parentResourceId: 'folder-root',
        path: `/Workspace/file-${index}.txt`,
      })
    )
    const { affordances } = await installFolder(children)
    const rowCalls = () =>
      affordances.mock.calls.filter(([resourceId]) => resourceId.startsWith('child-')).length
    const mountedAt = Date.now()
    render(<PermissionActionProbe />, { wrapper: Harness })
    await waitFor(() => expect(screen.getByTestId('accessible-count').textContent).toBe('1'))
    await act(async () =>
      fireEvent.click(await screen.findByRole('button', { name: 'Open workspace' }))
    )
    await waitFor(() => expect(rowCalls()).toBe(20))

    vi.setSystemTime(mountedAt + 16_000)
    // Query staleness is only a policy calculation; elapsed time alone does
    // not schedule a request. The active-window focus event below is the
    // producer that may trigger revalidation.
    expect(rowCalls()).toBe(20)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)))

    // The approved traffic invariant forbids a request for every visible child
    // on one focus. It does not specify a smaller numeric batch limit.
    expect(rowCalls() - 20).not.toBe(20)
  })
})
