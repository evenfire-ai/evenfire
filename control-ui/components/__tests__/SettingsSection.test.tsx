import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import SettingsLayout from '../../app/settings/layout'
import { ControlSettingsPanel } from '../ControlSettingsPanel'
import { MicrosoftTeamsIntegrationPanel } from '../MicrosoftTeamsIntegrationPanel'
import { SettingsDataProvider } from '../SettingsDataContext'
import { SETTINGS_INTEGRATION_TABS } from '../SettingsIntegrationsNav/constants'
import { SETTINGS_TABS } from '../SettingsShell/constants'

const navigationState = vi.hoisted(() => ({
  pathname: '/settings',
  segments: [] as string[],
  searchParams: new URLSearchParams(),
}))

const apiMocks = vi.hoisted(() => ({
  disconnectIdentityProviderConnection: vi.fn(),
  getControlUISettingsMe: vi.fn(),
  getIdentityProviderConnections: vi.fn(),
  requestControlUISettingsEmailChange: vi.fn(),
  updateControlUISettingsPassword: vi.fn(),
  updateControlUISettingsUsername: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => navigationState.searchParams,
  useSelectedLayoutSegments: () => navigationState.segments,
}))

vi.mock('../AdminBridgeAlerts', () => ({
  hasControlAdminBridgeAlertOverrides: () => false,
  resetControlAdminBridgeAlerts: vi.fn(),
}))

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    authState: { isLoggedIn: true, isLoading: false },
    checkAuth: vi.fn(),
    logout: vi.fn(),
  }),
}))

vi.mock('../Sidebar', () => ({
  Sidebar: () => <aside>Sidebar</aside>,
}))

vi.mock('../ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode: vi.fn(), toggleTheme: vi.fn() }),
}))

vi.mock('../Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('@lib/api', () => apiMocks)

function renderWithSettingsData(component: React.ReactNode) {
  return render(<SettingsDataProvider>{component}</SettingsDataProvider>)
}

beforeEach(() => {
  apiMocks.getControlUISettingsMe.mockResolvedValue({
    me: {
      id: 'admin-1',
      email: 'admin@example.com',
      username: 'Administrator',
      pendingEmailChange: null,
    },
  })
  apiMocks.getIdentityProviderConnections.mockResolvedValue({ callbackUrl: '', items: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  navigationState.pathname = '/settings'
  navigationState.segments = []
  navigationState.searchParams = new URLSearchParams()
})

describe('Settings primary tabs', () => {
  it('links UI, Account, and Integrations to canonical routes', () => {
    expect(SETTINGS_TABS.map(tab => [tab.value, tab.href, tab.label])).toEqual([
      ['ui', '/settings/ui', 'UI'],
      ['account', '/settings/account', 'Account'],
      ['integrations', '/settings/integrations/microsoft', 'Integrations'],
    ])
  })

  it.each([
    { segments: [], activeTab: 'UI' },
    { segments: ['account'], activeTab: 'Account' },
    { segments: ['integrations', 'microsoft'], activeTab: 'Integrations' },
  ])('selects $activeTab from the route segments', ({ activeTab, segments }) => {
    navigationState.segments = segments
    render(
      <SettingsLayout>
        <div>Settings content</div>
      </SettingsLayout>
    )

    expect(screen.getByRole('tab', { name: activeTab })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Settings content')).toBeInTheDocument()
  })

  it('leaves the Microsoft connect wizard outside the settings tab shell', () => {
    navigationState.segments = ['integrations', 'microsoft', 'connect']
    render(
      <SettingsLayout>
        <div>Connect wizard</div>
      </SettingsLayout>
    )

    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByText('Connect wizard')).toBeInTheDocument()
  })
})

describe('Settings UI tab', () => {
  it('shows only appearance controls and preloads all settings data', async () => {
    renderWithSettingsData(<ControlSettingsPanel section="ui" />)

    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Dark/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Light/ })).toBeInTheDocument()
    const version = screen.getByLabelText('Control UI version')
    const appearance = screen.getByText('Appearance')
    expect(version).toBeInTheDocument()
    expect(version.compareDocumentPosition(appearance) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(screen.queryByText('Account info')).toBeNull()
    await waitFor(() => {
      expect(apiMocks.getControlUISettingsMe).toHaveBeenCalledTimes(1)
      expect(apiMocks.getIdentityProviderConnections).toHaveBeenCalledTimes(1)
    })
  })
})

describe('Settings integration tabs', () => {
  it('provides Microsoft Teams and Google Workspace routes with icons', () => {
    expect(SETTINGS_INTEGRATION_TABS.map(tab => [tab.value, tab.href])).toEqual([
      ['microsoft', '/settings/integrations/microsoft'],
      ['google', '/settings/integrations/google'],
    ])

    render(
      <nav>
        {SETTINGS_INTEGRATION_TABS.map(tab => (
          <a key={tab.value} href={tab.href}>
            {tab.label}
          </a>
        ))}
      </nav>
    )

    expect(
      screen.getByRole('link', { name: 'Microsoft Teams' }).querySelector('img')
    ).toHaveAttribute('src', '/brand/microsoft-teams.svg')
    expect(
      screen.getByRole('link', { name: 'Google Workspace' }).querySelector('img')
    ).toHaveAttribute('src', '/brand/google.svg')
  })

  it('shows the integration action when no Microsoft organization is connected', async () => {
    apiMocks.getIdentityProviderConnections.mockResolvedValue({ callbackUrl: '', items: [] })

    renderWithSettingsData(<MicrosoftTeamsIntegrationPanel />)

    expect(
      await screen.findByRole('link', { name: 'Integrate with Microsoft Teams' })
    ).toHaveAttribute('href', '/settings/integrations/microsoft/connect?fresh=1')
    expect(screen.getByText('No Microsoft Teams organizations are connected.')).toBeInTheDocument()
  })

  it('shows connected organization details and confirms disconnect', async () => {
    const connected = {
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'microsoft' as const,
      displayName: 'Contoso',
      directoryTenantId: '22222222-2222-4222-8222-222222222222',
      clientId: '33333333-3333-4333-8333-333333333333',
      status: 'connected' as const,
      grantedScopes: ['User.Read'],
      connectedAt: '2026-07-15T12:00:00.000Z',
      disconnectedAt: null,
      lastError: null,
      createdAt: '2026-07-15T11:00:00.000Z',
    }
    apiMocks.getIdentityProviderConnections
      .mockResolvedValueOnce({ callbackUrl: '', items: [connected] })
      .mockResolvedValueOnce({ callbackUrl: '', items: [] })
    apiMocks.disconnectIdentityProviderConnection.mockResolvedValue({ disconnected: true })

    renderWithSettingsData(<MicrosoftTeamsIntegrationPanel />)

    expect(await screen.findByText('Teams connected')).toBeInTheDocument()
    expect(screen.getByText(`Tenant ID: ${connected.directoryTenantId}`)).toBeInTheDocument()
    expect(screen.getByText(`Client ID: ${connected.clientId}`)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add another' })).toHaveAttribute(
      'href',
      '/settings/integrations/microsoft/connect?fresh=1'
    )
    expect(screen.getByRole('link', { name: 'Import users' })).toHaveAttribute(
      'href',
      `/settings/integrations/microsoft/connect?connectionId=${connected.id}`
    )

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      expect(apiMocks.disconnectIdentityProviderConnection).toHaveBeenCalledWith(connected.id)
    })
    expect(
      await screen.findByRole('link', { name: 'Integrate with Microsoft Teams' })
    ).toBeInTheDocument()
  })
})
