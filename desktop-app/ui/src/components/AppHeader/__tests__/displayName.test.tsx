// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AccessCatalog } from '../../../../../src/types'
import { AppHeader } from '../index'

// UT-11 (spec §5, F3 desktop-app) — Agent WITHOUT fallback.
// The agents menu must render the visible name (spec.host, surfaced as the
// catalog's agentDisplayByName) and NOT the identifier (metadata.name). The
// fixture makes the display ("Product Agents") differ from the name
// ("product-agent") so rendering the name instead of the display fails.

const catalogMock = vi.hoisted(() => ({ current: null as AccessCatalog | null }))

vi.mock('@hooks/domain/useAgentsDataController', () => ({
  useAgentsDataController: () => ({ accessCatalog: catalogMock.current }),
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

function catalogWithAgentDisplay(): AccessCatalog {
  return {
    userId: 'user-1',
    teamId: null,
    userContextIds: [],
    userAgentNames: ['product-agent'],
    teamContextIds: [],
    teamAgentNames: [],
    contextIds: [],
    agentNames: ['product-agent'],
    mcpServersByAgent: {},
    agentContextByName: { 'product-agent': null },
    agentProviderByName: {},
    agentDisplayByName: { 'product-agent': 'Product Agents' },
  }
}

describe('AppHeader agents menu — visible name (UT-11)', () => {
  afterEach(() => {
    cleanup()
    catalogMock.current = null
    vi.clearAllMocks()
  })

  it('renders the agent display (spec.host) not the identifier', () => {
    catalogMock.current = catalogWithAgentDisplay()
    render(<AppHeader />)

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Product' } })

    // The search matched an agent (the "Agents" group heading is present).
    expect(screen.getByText('Agents')).toBeTruthy()
    // Reads the display directly — an implementation rendering the name would
    // show "product-agent" here and fail.
    expect(screen.getByText('Product Agents')).toBeTruthy()
    expect(screen.queryByText('product-agent')).toBeNull()
  })
})
