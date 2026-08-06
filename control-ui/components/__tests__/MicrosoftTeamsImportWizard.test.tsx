import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MicrosoftTeamsImportWizard } from '../MicrosoftTeamsImportWizard'

const apiMocks = vi.hoisted(() => ({
  authorizeMicrosoftIdentityProviderSetup: vi.fn(),
  createMicrosoftIdentityProviderSetup: vi.fn(),
  executeMicrosoftIdentityProviderSetup: vi.fn(),
  getActiveMicrosoftIdentityProviderSetup: vi.fn(),
  getMicrosoftIdentityProviderDirectory: vi.fn(),
  saveMicrosoftIdentityProviderSetupSecret: vi.fn(),
  updateMicrosoftIdentityProviderSetup: vi.fn(),
}))
const navigationMocks = vi.hoisted(() => ({ search: '' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigationMocks.search),
}))

vi.mock('../Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('@lib/api', () => apiMocks)

const setup = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'microsoft' as const,
  status: 'draft' as const,
  currentStep: 6,
  draft: {
    displayName: 'Evenfire Teams Integration',
    tenantId: '22222222-2222-4222-8222-222222222222',
    clientId: '33333333-3333-4333-8333-333333333333',
    appRegistrationCreated: true,
    permissionsGranted: true,
  },
  hasClientSecret: true,
  connectionId: null,
  execution: {},
  createdAt: '2026-07-16T12:00:00.000Z',
  updatedAt: '2026-07-16T12:00:00.000Z',
}

beforeEach(() => {
  navigationMocks.search = ''
  apiMocks.getActiveMicrosoftIdentityProviderSetup.mockResolvedValue({
    setup,
    callbackUrl: 'https://example.test/control-api/api/v1/identity-provider-callback/microsoft',
    appName: 'Evenfire',
  })
  apiMocks.updateMicrosoftIdentityProviderSetup.mockResolvedValue({ setup })
  apiMocks.authorizeMicrosoftIdentityProviderSetup.mockResolvedValue({
    connection: {},
    authorizeUrl: '',
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MicrosoftTeamsImportWizard', () => {
  it('starts Microsoft authorization from the authorization step', async () => {
    render(<MicrosoftTeamsImportWizard />)

    const authorizeButton = await screen.findByRole('button', { name: 'Authorize' })
    expect(authorizeButton).toBeEnabled()
    fireEvent.click(authorizeButton)

    await waitFor(() => {
      expect(apiMocks.authorizeMicrosoftIdentityProviderSetup).toHaveBeenCalledWith(
        setup.id,
        'http://localhost:3000/settings/integrations/microsoft/connect'
      )
    })
    expect(screen.getByRole('button', { name: 'Opening Microsoft...' })).toBeDisabled()
  })

  it('replaces a stale setup when importing a different connection', async () => {
    navigationMocks.search = 'connectionId=connection-2'
    const replacement = {
      ...setup,
      id: 'setup-2',
      status: 'authorizing' as const,
      connectionId: 'connection-2',
    }
    apiMocks.getActiveMicrosoftIdentityProviderSetup.mockResolvedValue({
      setup: { ...setup, status: 'configuring', connectionId: 'connection-1' },
      callbackUrl: 'https://example.test/api/v1/identity-provider-callback/microsoft',
      appName: 'Evenfire',
    })
    apiMocks.createMicrosoftIdentityProviderSetup.mockResolvedValue({
      setup: replacement,
      callbackUrl: 'https://example.test/api/v1/identity-provider-callback/microsoft',
      appName: 'Evenfire',
    })

    render(<MicrosoftTeamsImportWizard />)

    await waitFor(() => {
      expect(apiMocks.createMicrosoftIdentityProviderSetup).toHaveBeenCalledWith({
        connectionId: 'connection-2',
        replaceActive: true,
      })
    })
    expect(apiMocks.getMicrosoftIdentityProviderDirectory).not.toHaveBeenCalled()
  })
})
