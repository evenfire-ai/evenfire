// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppHeader } from '../index'

const notificationMocks = vi.hoisted(() => ({
  clear: vi.fn(),
  markRead: vi.fn(),
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
    notifications: [],
    unreadNotificationCount: 0,
    notificationActionById: {},
    pendingApprovals: [],
    pendingApprovalsLoading: false,
    pendingApprovalActionId: null,
    markNotificationsRead: notificationMocks.markRead,
    clearNotifications: notificationMocks.clear,
    removeNotification: vi.fn(),
    handleOpenNotification: vi.fn(),
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
    vi.clearAllMocks()
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
})
