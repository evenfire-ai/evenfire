// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppNotification } from '@/uiTypes'
import { AppHeader } from '../index'

const notificationMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  markRead: vi.fn(),
  notifications: [] as AppNotification[],
  open: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(async () => undefined),
}))

// Rename propagation tests swap this catalog in; default null keeps the
// identifier-fallback path (no catalog) that the legacy assertions rely on.
type AgentsCatalogStub = null | {
  agentNames: string[]
  userAgentNames: string[]
  teamAgentNames: string[]
  agentDisplayByName: Record<string, string>
}
const agentsCatalogMock = vi.hoisted(() => ({
  catalog: null as AgentsCatalogStub,
  loading: false,
}))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({
    accessCatalog: agentsCatalogMock.catalog,
    loading: agentsCatalogMock.loading,
  }),
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
  }),
}))

vi.mock('@contexts/NotificationsContext', () => ({
  useNotificationsContext: () => ({
    notifications: notificationMocks.notifications,
    unreadNotificationCount: 0,
    notificationActionById: {},
    pendingApprovals: [],
    pendingApprovalsLoading: false,
    pendingApprovalActionId: null,
    markNotificationsRead: notificationMocks.markRead,
    clearNotifications: notificationMocks.clear,
    removeNotification: notificationMocks.remove,
    handleOpenNotification: notificationMocks.open,
    handleApproveNotification: vi.fn(),
    handleDenyNotification: vi.fn(),
    handleRefreshPendingApprovals: notificationMocks.refresh,
    handleDecidePendingApproval: vi.fn(),
  }),
}))

vi.mock('@hooks/useClickOutside', () => ({ useClickOutside: vi.fn() }))

describe('AppHeader notification tray presentation', () => {
  afterEach(() => {
    cleanup()
    notificationMocks.notifications.length = 0
    agentsCatalogMock.catalog = null
    agentsCatalogMock.loading = false
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  // Rename propagation: the tray header shows the catalog display name
  // (spec.host); pseudo-agents absent from the catalog pass through as-is.
  it('shows the agent display name from the access catalog in the tray', () => {
    agentsCatalogMock.catalog = {
      agentNames: ['research-agent'],
      userAgentNames: ['research-agent'],
      teamAgentNames: [],
      agentDisplayByName: { 'research-agent': 'Research agent' },
    }
    notificationMocks.notifications.push(
      {
        id: 'notification-1',
        kind: 'assistant_reply' as const,
        agentName: 'research-agent',
        text: 'Your answer is ready.',
        timestamp: Date.now(),
        read: true,
      },
      {
        id: 'notification-2',
        kind: 'assistant_reply' as const,
        agentName: 'Workflows',
        text: 'Workflow finished.',
        timestamp: Date.now(),
        read: true,
      }
    )

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    expect(
      screen.getByText('Research agent', { selector: '.notification-menu-agent' })
    ).toBeTruthy()
    expect(screen.getByText('Workflows', { selector: '.notification-menu-agent' })).toBeTruthy()
    expect(
      screen.queryByText('research-agent', { selector: '.notification-menu-agent' })
    ).toBeNull()
  })

  // QA parity with the control-ui header fix: while the access catalog (the
  // display-name map) is still loading, the tray agent line is a skeleton —
  // never a flash of the raw slug.
  it('skeletonizes the tray agent line while the access catalog loads', () => {
    agentsCatalogMock.loading = true
    notificationMocks.notifications.push({
      id: 'notification-1',
      kind: 'assistant_reply' as const,
      agentName: 'research-agent',
      text: 'Your answer is ready.',
      timestamp: Date.now(),
      read: true,
    })

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    const agentLine = screen
      .getByTestId('notification-menu-item')
      .querySelector('.notification-menu-agent')
    expect(agentLine?.querySelector('.notification-menu-agent-skeleton')).not.toBeNull()
    expect(
      screen.queryByText('research-agent', { selector: '.notification-menu-agent' })
    ).toBeNull()
  })

  it('opens a notification when its card surface is clicked', () => {
    const notification = {
      id: 'notification-1',
      kind: 'assistant_reply' as const,
      agentName: 'Research agent',
      text: 'Your answer is ready.',
      timestamp: Date.now(),
      read: true,
    }
    notificationMocks.notifications.push(notification)

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))
    expect(screen.getByText('Inbox (1)')).toBeTruthy()
    expect(screen.queryByText('1 item')).toBeNull()
    fireEvent.click(screen.getByTestId('notification-menu-item'))

    expect(notificationMocks.open).toHaveBeenCalledWith(notification)
    expect(screen.queryByRole('dialog', { name: 'Notifications and approvals' })).toBeNull()
  })

  it('opens through the controlled command request and preserves tray lifecycle', async () => {
    const { rerender } = render(<AppHeader notificationOpenRequestId={0} />)

    rerender(<AppHeader notificationOpenRequestId={1} />)

    expect(screen.getByRole('dialog', { name: 'Notifications and approvals' })).toBeTruthy()
    await waitFor(() => expect(notificationMocks.refresh).toHaveBeenCalledOnce())
  })

  it('does not show the empty notification state before the open refresh settles', async () => {
    let resolveRefresh: (() => void) | undefined
    notificationMocks.refresh.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveRefresh = resolve
      })
    )

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    expect(screen.getByRole('dialog', { name: 'Notifications and approvals' })).toBeTruthy()
    expect(screen.queryByText('No notifications or pending approvals right now.')).toBeNull()

    resolveRefresh?.()

    await waitFor(() => {
      expect(screen.getByText('No notifications or pending approvals right now.')).toBeTruthy()
    })
  })

  it('opens a clickable notification card with the keyboard', () => {
    const notification = {
      id: 'notification-1',
      kind: 'assistant_reply' as const,
      agentName: 'Research agent',
      text: 'Your answer is ready.',
      timestamp: Date.now(),
      read: true,
    }
    notificationMocks.notifications.push(notification)

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))
    const card = screen.getByTestId('notification-menu-item')

    expect(card.getAttribute('role')).toBe('button')
    expect(card.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(card, { key: 'Enter' })

    expect(notificationMocks.open).toHaveBeenCalledWith(notification)
  })

  it('keeps approval-required notification cards non-clickable', () => {
    const notification = {
      id: 'approval-1',
      kind: 'approval_required' as const,
      agentName: 'Workflow agent',
      text: 'Deploy needs your approval.',
      timestamp: Date.now(),
      read: false,
      approval: {
        taskId: 'task-1',
        requestId: 'request-1',
        displayName: 'Deploy',
      },
    }
    notificationMocks.notifications.push(notification)

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))
    const card = screen.getByTestId('notification-menu-item')

    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
    fireEvent.click(card)

    expect(notificationMocks.open).not.toHaveBeenCalled()
  })

  it('does not open a notification when its delete button is clicked', () => {
    const notification = {
      id: 'notification-1',
      kind: 'assistant_reply' as const,
      agentName: 'Research agent',
      text: 'Your answer is ready.',
      timestamp: Date.now(),
      read: true,
    }
    notificationMocks.notifications.push(notification)

    render(<AppHeader />)
    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete notification' }))

    expect(notificationMocks.remove).toHaveBeenCalledWith(notification.id)
    expect(notificationMocks.open).not.toHaveBeenCalled()
  })

  it('waits for embedded app bounds before showing the drawer', async () => {
    const onShellOverlayOpenChange = vi.fn()
    const onNotificationTrayOpenChange = vi.fn()
    const { rerender } = render(
      <AppHeader
        notificationTrayMode="drawer"
        notificationTrayReady={false}
        onNotificationTrayOpenChange={onNotificationTrayOpenChange}
        onShellOverlayOpenChange={onShellOverlayOpenChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    await waitFor(() => {
      expect(onNotificationTrayOpenChange).toHaveBeenLastCalledWith(true)
      expect(onShellOverlayOpenChange).toHaveBeenLastCalledWith(false)
    })
    expect(screen.queryByRole('dialog', { name: 'Notifications and approvals' })).toBeNull()

    rerender(
      <AppHeader
        notificationTrayMode="drawer"
        notificationTrayReady
        onNotificationTrayOpenChange={onNotificationTrayOpenChange}
        onShellOverlayOpenChange={onShellOverlayOpenChange}
      />
    )

    expect(
      screen
        .getByRole('dialog', { name: 'Notifications and approvals' })
        .classList.contains('notification-menu--app-drawer')
    ).toBe(true)
  })

  it('aligns the embedded-app drawer to the measured embed slot edge', () => {
    render(
      <AppHeader notificationTrayMode="drawer" notificationTrayReady notificationTrayLeft={416} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    const tray = screen.getByRole('dialog', { name: 'Notifications and approvals' })
    expect(tray.classList.contains('notification-menu--embed-aligned')).toBe(true)
    expect(tray.style.getPropertyValue('--notification-drawer-left')).toBe('416px')
  })

  it('keeps the existing floating overlay outside embedded apps', async () => {
    const onShellOverlayOpenChange = vi.fn()
    render(<AppHeader onShellOverlayOpenChange={onShellOverlayOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Notifications and approvals' }))

    await waitFor(() => {
      expect(onShellOverlayOpenChange).toHaveBeenLastCalledWith(true)
    })
    expect(
      screen
        .getByRole('dialog', { name: 'Notifications and approvals' })
        .classList.contains('notification-menu--app-drawer')
    ).toBe(false)
  })

  it('uses the shared search label at constrained widths', () => {
    vi.stubGlobal('innerWidth', 1200)

    render(<AppHeader />)

    const search = screen.getByRole('textbox', { name: 'Search' })
    expect(search.getAttribute('placeholder')).toBe('Search')
    expect(search.getAttribute('title')).toBe('Search')
  })

  it('uses the shared search label above the constrained-width breakpoint', () => {
    vi.stubGlobal('innerWidth', 1400)

    render(<AppHeader />)

    const search = screen.getByRole('textbox', { name: 'Search' })
    expect(search.getAttribute('placeholder')).toBe('Search')
    expect(search.getAttribute('title')).toBe('Search')
  })

  it('opens and focuses the existing global search for a command request', () => {
    const { rerender } = render(<AppHeader searchFocusRequestId={0} />)
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()

    rerender(<AppHeader searchFocusRequestId={1} />)

    const search = screen.getByRole('textbox', { name: 'Search' })
    expect(document.activeElement).toBe(search)
    expect(search.getAttribute('aria-label')).toBe('Search')
    other.remove()
  })
})
