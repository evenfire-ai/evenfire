// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render as renderTestingLibrary,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TitlebarActionsPortal, WindowTitleBar } from '@components/WindowTitleBar'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { revokeGfsSessionAccess } from '@hooks/domain/useGfsBrowserController'
import {
  resolveDeniedMessage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { AppHeader } from '../index'

// The titlebar search opens its reusable results surface on focus, even before
// the user types. The input keeps the short titlebar label while the results
// panel carries the longer searchable-scope prompt.

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ accessCatalog: null }),
}))

vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ contextIds: [] }),
}))

vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({ globalMcpServers: [], mcpServersByAgent: {} }),
}))

vi.mock('@hooks/domain/useSearchPluginsAppsController', () => ({
  useSearchPluginsAppsController: () => ({
    plugins: [],
    apps: [],
    loading: false,
    error: null,
    ensureLoaded: vi.fn(async () => undefined),
  }),
}))

vi.mock('@hooks/domain/useTeamsDataController', () => ({
  useTeamsDataController: () => ({
    teams: [],
    teamMembers: [],
    teamDirectory: {},
    loading: false,
    teamDirectoryHydrated: true,
    currentTeamId: '',
    ensureHydrated: vi.fn(async () => undefined),
  }),
}))

vi.mock('@contexts/NavigationContext', () => ({
  useNavigationContext: () => ({
    navItem: 'apps',
    handleNavSelect: vi.fn(),
    handleOpenContextDetails: vi.fn(),
    handleOpenTeamDetails: vi.fn(),
  }),
}))

vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => ({
    notifications: [],
    unreadNotificationCount: 0,
    notificationActionById: {},
    pendingApprovals: [],
    pendingApprovalsLoading: false,
    pendingApprovalActionId: null,
    markNotificationsRead: vi.fn(),
    clearNotifications: vi.fn(),
    removeNotification: vi.fn(),
    handleOpenNotification: vi.fn(),
    handleApproveNotification: vi.fn(),
    handleDenyNotification: vi.fn(),
    handleRefreshPendingApprovals: vi.fn(async () => undefined),
    handleDecidePendingApproval: vi.fn(),
  }),
}))

// Mock click-outside so the collapse can only come from the query-state model,
// not from a synthetic mousedown — a keyboard user never fires that path.
vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))

function render(ui: React.ReactNode, options?: Parameters<typeof renderTestingLibrary>[1]) {
  const client = new QueryClient()
  const ExistingWrapper = options?.wrapper
  function TestProviders({ children }: { children: React.ReactNode }) {
    const wrapped = ExistingWrapper ? <ExistingWrapper>{children}</ExistingWrapper> : children
    return (
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={{ me: null } as never}>{wrapped}</AuthContext.Provider>
      </QueryClientProvider>
    )
  }
  return renderTestingLibrary(ui, { ...options, wrapper: TestProviders })
}

describe('AppHeader global search idle collapse', () => {
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'clerum')
    vi.clearAllMocks()
  })

  it('opens the results surface with the scope prompt when an empty field is focused', async () => {
    const user = userEvent.setup()
    const { container } = render(<AppHeader />)
    const search = container.querySelector('.global-search')
    const input = screen.getByRole('textbox', { name: 'Search' })
    expect(search).not.toBeNull()
    expect(input.getAttribute('placeholder')).toBe('Search')

    await user.click(input)
    expect(search?.classList.contains('is-open')).toBe(true)
    expect(
      screen.getByText(
        'Paste an exact EvenDrive link or search agents, connectors, plugins or apps...'
      )
    ).toBeTruthy()

    await user.tab()
    expect(document.activeElement).not.toBe(input)
    expect(search?.classList.contains('is-open')).toBe(true)
  })

  it('keeps the results surface open when the typed query is cleared', async () => {
    const user = userEvent.setup()
    const { container } = render(<AppHeader />)
    const search = container.querySelector('.global-search')
    const input = screen.getByRole('textbox', { name: 'Search' })

    await user.type(input, 'agent')
    expect(search?.classList.contains('is-open')).toBe(true)

    await user.clear(input)
    expect(search?.classList.contains('is-open')).toBe(true)
    expect(
      screen.getByText(
        'Paste an exact EvenDrive link or search agents, connectors, plugins or apps...'
      )
    ).toBeTruthy()
  })

  it('renders explicit titlebar search chrome for contrast', () => {
    const { container } = render(<AppHeader placement="titlebar" />)

    expect(container.querySelector('.global-search--titlebar')).toBeTruthy()
    expect(container.querySelector('.search-input--titlebar')).toBeTruthy()
    const icon = container.querySelector<HTMLElement>('.global-search__titlebar-icon')
    const placeholder = container.querySelector<HTMLElement>('.search-input__titlebar-placeholder')
    const bell = container.querySelector<HTMLElement>('.notification-bell--titlebar')

    expect(icon?.textContent).toBe('⌕')
    expect(placeholder?.textContent).toBe('Search')
    expect(bell).toBeTruthy()
  })

  it('opens titlebar search results for a command focus request', () => {
    const { rerender } = render(<AppHeader placement="titlebar" searchFocusRequestId={0} />)

    rerender(<AppHeader placement="titlebar" searchFocusRequestId={1} />)

    expect(screen.getByRole('textbox', { name: 'Search' })).toBe(document.activeElement)
    expect(
      screen.getByText(
        'Paste an exact EvenDrive link or search agents, connectors, plugins or apps...'
      )
    ).toBeTruthy()
  })

  it('keeps titlebar actions out of a second banner while preserving the default banner', async () => {
    function TitlebarHarness() {
      const [actionsRoot, setActionsRoot] = React.useState<HTMLDivElement | null>(null)

      return (
        <div className="app-frame">
          <WindowTitleBar actionsRef={setActionsRoot} />
          <div className="app-root">
            <section className="content-panel">
              <TitlebarActionsPortal container={actionsRoot}>
                <AppHeader placement="titlebar" />
              </TitlebarActionsPortal>
            </section>
          </div>
        </div>
      )
    }

    const titlebar = render(<TitlebarHarness />)
    await screen.findByRole('textbox', { name: 'Search' })
    expect(screen.getAllByRole('banner')).toHaveLength(1)
    titlebar.unmount()

    render(<AppHeader />)
    expect(screen.getAllByRole('banner')).toHaveLength(1)
  })

  it('resolves only an exact canonical link and opens the authorized result on keyboard activation', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'Q3 plan.md')
    )
    const resolveGfs = vi.fn(async (requestedUri: string) => {
      expect(requestedUri).toBe(uri)
      return resource
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const openResource = vi.fn()
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-1', teamId: 'team-1' },
      runtimeConfigState: {
        envKey: 'fixture-env',
        currentConfig: { externalRestApiBaseUrl: 'https://api.example.test/v1' },
      },
    }
    render(
      <AuthContext.Provider value={authValue as never}>
        <AppHeader onOpenGfsResource={openResource} />
      </AuthContext.Provider>
    )

    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: uri } })
    const result = await screen.findByRole('button', { name: /Q3 plan/ })
    expect(resolveGfs).toHaveBeenCalledTimes(1)
    result.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(openResource).toHaveBeenCalledWith(uri)

    fireEvent.change(search, { target: { value: 'Q3 plan' } })
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /Q3 plan/ })).toBeNull()
  })

  it('revokes shared GFS access when exact-link search reports session authority failure', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    const resolveGfs = vi.fn(async () => {
      throw new Error(message)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-authority-failure', teamId: 'team-1' },
      runtimeConfigState: { envKey: 'fixture-env' },
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue as never}>
          <AppHeader />
        </AuthContext.Provider>
      </QueryClientProvider>
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: uri },
    })

    expect(
      await screen.findByText('No accessible EvenDrive resource was found for this link.')
    ).toBeTruthy()
    expect(resolveGfs).toHaveBeenCalledWith(uri)
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          desktopQueryKeys.gfsAccessState('fixture-env:user-authority-failure:team-1', 2)
        )
      ).toBe('revoked')
    )
  })

  it('hides a resolved search label when another surface revokes GFS access', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'Search result name.md')
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: vi.fn(async () => resource),
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-search-revoked', teamId: 'team-1' },
      runtimeConfigState: { envKey: 'fixture-env' },
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue as never}>
          <AppHeader />
        </AuthContext.Provider>
      </QueryClientProvider>
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: uri },
    })
    expect(await screen.findByRole('button', { name: /Search result name/ })).toBeTruthy()

    expect(
      queryClient.getQueryData(
        desktopQueryKeys.gfsAccessState('fixture-env:user-search-revoked:team-1', 2)
      )
    ).toBe('active')
    act(() => revokeGfsSessionAccess(queryClient, 'fixture-env:user-search-revoked:team-1', 2))

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          desktopQueryKeys.gfsAccessState('fixture-env:user-search-revoked:team-1', 2)
        )
      ).toBe('revoked')
    )
    expect(screen.queryByRole('button', { name: /Search result name/ })).toBeNull()
  })

  it('does not revoke access for a search failure from an older main session generation', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const message = await resolveDeniedMessage(
      uri,
      { code: 'unauthorized', message: 'session is not authenticated' },
      401
    )
    let currentGeneration = 1
    const getSessionGeneration = vi.fn(async () => currentGeneration)
    let rejectResolve: ((error: Error) => void) | undefined
    const resolveGfs = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectResolve = reject
        })
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 1,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const sessionScope = 'fixture-env:user-old-search-session:team-1'
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={
            {
              isAuthenticated: true,
              sessionGeneration: 1,
              me: { id: 'user-old-search-session', teamId: 'team-1' },
              runtimeConfigState: { envKey: 'fixture-env' },
            } as never
          }
        >
          <AppHeader />
        </AuthContext.Provider>
      </QueryClientProvider>
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: uri },
    })
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledOnce())
    currentGeneration = 2
    await act(async () => {
      rejectResolve?.(new Error(message))
      await new Promise(resolveTurn => setTimeout(resolveTurn, 0))
    })

    expect(queryClient.getQueryData(desktopQueryKeys.gfsAccessState(sessionScope))).not.toBe(
      'revoked'
    )
  })

  it('sanitizes bidi controls from resolved resource names in global search', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'invoice.pdf\u202Eexe')
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: vi.fn(async () => resource),
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-1', teamId: 'team-1' },
      runtimeConfigState: { envKey: 'fixture-env' },
    }
    const openResource = vi.fn()
    render(
      <AuthContext.Provider value={authValue as never}>
        <AppHeader onOpenGfsResource={openResource} />
      </AuthContext.Provider>
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: uri },
    })

    const result = await screen.findByRole('button', { name: /invoice\.pdfexe/ })
    expect(result.textContent).toContain('invoice.pdfexe')
    expect(screen.queryByText(/\u202E/)).toBeNull()
    result.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(openResource).toHaveBeenCalledWith(uri)
  })

  it('rejects stale resolver completions after the exact link query changes', async () => {
    const firstUri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const secondUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    let resolveFirst!: (value: Awaited<ReturnType<typeof resolveResource>>) => void
    let resolveSecond!: (value: Awaited<ReturnType<typeof resolveResource>>) => void
    const resolveGfs = vi.fn((uri: string) => {
      return new Promise<Awaited<ReturnType<typeof resolveResource>>>(resolve => {
        if (uri === firstUri) resolveFirst = resolve
        else resolveSecond = resolve
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-1', teamId: 'team-1' },
      runtimeConfigState: {
        envKey: 'fixture-env',
        currentConfig: { externalRestApiBaseUrl: 'https://api.example.test/v1' },
      },
    }
    render(
      <AuthContext.Provider value={authValue as never}>
        <AppHeader />
      </AuthContext.Provider>
    )
    const search = screen.getByRole('textbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: firstUri } })
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(1))
    fireEvent.change(search, { target: { value: secondUri } })
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveSecond(
        await resolveResource(resolvedDirectory('abcdefabcdefabcdefabcdefabcdefab', 'Roadmap'))
      )
    })
    expect(await screen.findByRole('button', { name: /Roadmap/ })).toBeTruthy()
    await act(async () => {
      resolveFirst(
        await resolveResource(resolvedFile('0123456789abcdef0123456789abcdef', 'Secret old name'))
      )
    })
    expect(screen.queryByText('Secret old name')).toBeNull()
    expect(screen.getByRole('button', { name: /Roadmap/ })).toBeTruthy()
  })

  it('hides a resolved resource name immediately after authorization changes', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'Previously authorized name')
    )
    const resolveGfs = vi
      .fn()
      .mockResolvedValueOnce(resource)
      .mockRejectedValueOnce(new Error('access revoked'))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://profile.example.test',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-1', teamId: 'team-1' },
      runtimeConfigState: {
        envKey: 'fixture-env',
        currentConfig: { externalRestApiBaseUrl: 'https://api.example.test/v1' },
      },
    }
    const renderHeader = (epoch: number) => (
      <AuthContext.Provider value={authValue as never}>
        <AppHeader gfsAuthorizationChangeEpoch={epoch} />
      </AuthContext.Provider>
    )
    const view = render(renderHeader(1))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: uri },
    })
    expect(await screen.findByRole('button', { name: /Previously authorized name/ })).toBeTruthy()
    expect(resolveGfs).toHaveBeenCalledTimes(1)

    view.rerender(renderHeader(2))
    expect(screen.queryByRole('button', { name: /Previously authorized name/ })).toBeNull()
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: /Previously authorized name/ })).toBeNull()
  })

  it('accepts exact Desktop and configured Profile links but ignores names and hostile variants', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const resource = await resolveResource(
      resolvedFile('0123456789abcdef0123456789abcdef', 'Q3 plan.md')
    )
    const resolveGfs = vi.fn(async (requestedUri: string) => {
      expect(requestedUri).toBe(uri)
      return resource
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 2) },
        gfs: {
          resolve: resolveGfs,
          getResourceProfileOrigin: vi.fn(async () => ({
            origin: 'https://invitation-profile.tenant.example',
            sessionGeneration: 2,
            envKey: 'fixture-env',
          })),
        },
      },
    })
    const authValue = {
      isAuthenticated: true,
      sessionGeneration: 2,
      me: { id: 'user-1', teamId: 'team-1' },
      runtimeConfigState: {
        envKey: 'fixture-env',
        currentConfig: { externalRestApiBaseUrl: 'https://api.example.test/v1' },
      },
    }
    render(
      <AuthContext.Provider value={authValue as never}>
        <AppHeader />
      </AuthContext.Provider>
    )
    const search = screen.getByRole('textbox', { name: 'Search' })
    const desktopLink = `evenfire://files?uri=${encodeURIComponent(uri)}`
    const profileLink = `https://invitation-profile.tenant.example/open/files?uri=${encodeURIComponent(uri)}`

    fireEvent.change(search, { target: { value: desktopLink } })
    expect(await screen.findByRole('button', { name: /Q3 plan/ })).toBeTruthy()
    expect(resolveGfs).toHaveBeenLastCalledWith(uri)

    fireEvent.change(search, { target: { value: profileLink } })
    expect(await screen.findByRole('button', { name: /Q3 plan/ })).toBeTruthy()
    await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(2))

    for (const unsupported of [
      'Q3 plan.md',
      'gfs://main/../../private',
      `https://attacker.example/open/files?uri=${encodeURIComponent(uri)}`,
      `https://profile.example.test/open/files?uri=${encodeURIComponent(uri)}`,
      `https://profile.example.test/open/files?uri=${encodeURIComponent(uri)}&next=https://evil.test`,
    ]) {
      fireEvent.change(search, { target: { value: unsupported } })
      await waitFor(() => expect(resolveGfs).toHaveBeenCalledTimes(2))
      expect(screen.queryByRole('button', { name: /Q3 plan/ })).toBeNull()
    }
  })
})
