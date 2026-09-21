// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppHeader } from '../index'

// Mini-spec 04a §C/R3: the chat-drawer toggle lives in the app header, between
// the search and the notification bell. It renders only when `drawerAvailable`
// (never on a chat tab) and drives `onToggleChatDrawer`.

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ accessCatalog: null }),
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
  useNavigationContext: () => ({ navItem: 'apps', handleNavSelect: vi.fn() }),
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
vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))

describe('AppHeader chat-drawer toggle', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('is hidden when the drawer is unavailable (chat tab)', () => {
    render(<AppHeader placement="titlebar" drawerAvailable={false} onToggleChatDrawer={vi.fn()} />)
    expect(screen.queryByTestId('chat-drawer-toggle')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open chat drawer' })).toBeNull()
  })

  it('is hidden when no toggle handler is wired', () => {
    render(<AppHeader placement="titlebar" drawerAvailable={true} />)
    expect(screen.queryByTestId('chat-drawer-toggle')).toBeNull()
  })

  it('renders between search and bell on a non-chat tab, reflecting the closed state', () => {
    const { container } = render(
      <AppHeader
        placement="titlebar"
        drawerAvailable={true}
        chatDrawerOpen={false}
        onToggleChatDrawer={vi.fn()}
      />
    )
    const toggle = screen.getByTestId('chat-drawer-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Open chat drawer')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    // Positioned in the DOM between the search (.header-left) and the bell
    // (.header-utilities), as R3 requires.
    const left = container.querySelector('.header-left')
    const utilities = container.querySelector('.header-utilities')
    expect(left).not.toBeNull()
    expect(utilities).not.toBeNull()
    expect(left!.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      toggle.compareDocumentPosition(utilities!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('reflects the open state and fires the toggle on click', () => {
    const onToggleChatDrawer = vi.fn()
    render(
      <AppHeader
        placement="titlebar"
        drawerAvailable={true}
        chatDrawerOpen={true}
        onToggleChatDrawer={onToggleChatDrawer}
      />
    )
    const toggle = screen.getByRole('button', { name: 'Close chat drawer' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onToggleChatDrawer).toHaveBeenCalledTimes(1)
  })
})
