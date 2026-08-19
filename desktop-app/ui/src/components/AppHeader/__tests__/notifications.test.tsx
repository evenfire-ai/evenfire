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

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ accessCatalog: null }),
}))

vi.mock('@hooks/domain/useContextsDataController', () => ({
  useContextsDataController: () => ({ contextIds: [] }),
}))

vi.mock('@hooks/domain/useMcpServersDataController', () => ({
  useMcpServersDataController: () => ({ globalMcpServers: [], mcpServersByAgent: {} }),
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
    vi.clearAllMocks()
    vi.unstubAllGlobals()
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

  it('uses a compact search label at constrained widths while retaining the full hover text', () => {
    vi.stubGlobal('innerWidth', 1200)

    render(<AppHeader />)

    const search = screen.getByRole('textbox', { name: 'Search' })
    expect(search.getAttribute('placeholder')).toBe('Search workspace...')
    expect(search.getAttribute('title')).toBe(
      'Search teams, contexts, members, agents or connectors...'
    )
  })

  it('uses the full search label above the constrained-width breakpoint', () => {
    vi.stubGlobal('innerWidth', 1400)

    render(<AppHeader />)

    const search = screen.getByRole('textbox', { name: 'Search' })
    expect(search.getAttribute('placeholder')).toBe(
      'Search teams, contexts, members, agents or connectors...'
    )
    expect(search.getAttribute('title')).toBe(
      'Search teams, contexts, members, agents or connectors...'
    )
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
