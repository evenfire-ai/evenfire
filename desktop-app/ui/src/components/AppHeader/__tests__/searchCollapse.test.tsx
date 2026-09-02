// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppHeader } from '../index'

// The collapsed idle contract: `.global-search` may only carry `is-open` while
// there is query/result state. Focusing an empty field or typing-then-clearing
// must leave the container without `is-open` once idle — the CSS `:focus-within`
// rule handles the transient expansion during focus, `is-open` does not.

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

  it('does not keep is-open after focusing an empty field and tabbing out', async () => {
    const user = userEvent.setup()
    const { container } = render(<AppHeader />)
    const search = container.querySelector('.global-search')
    expect(search).not.toBeNull()

    await user.click(screen.getByRole('textbox', { name: 'Search' }))
    expect(search?.classList.contains('is-open')).toBe(false)

    await user.tab()
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search' }))
    expect(search?.classList.contains('is-open')).toBe(false)
  })

  it('drops is-open once the typed query is cleared', async () => {
    const user = userEvent.setup()
    const { container } = render(<AppHeader />)
    const search = container.querySelector('.global-search')
    const input = screen.getByRole('textbox', { name: 'Search' })

    await user.type(input, 'agent')
    expect(search?.classList.contains('is-open')).toBe(true)

    await user.clear(input)
    expect(search?.classList.contains('is-open')).toBe(false)
  })
})
