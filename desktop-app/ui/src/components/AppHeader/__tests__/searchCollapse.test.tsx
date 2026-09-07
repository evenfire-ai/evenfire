// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('AppHeader global search idle collapse', () => {
  afterEach(() => {
    cleanup()
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
      screen.getByText('Search teams, contexts, members, agents or connectors...')
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
      screen.getByText('Search teams, contexts, members, agents or connectors...')
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
      screen.getByText('Search teams, contexts, members, agents or connectors...')
    ).toBeTruthy()
  })
})
