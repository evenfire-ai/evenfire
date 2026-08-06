import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'

const mocks = vi.hoisted(() => ({
  updateConnection: vi.fn(),
  startMicrosoftOAuth: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  config: {
    controlUiAppName: 'Evenfire',
    controlUiBaseUrl: 'http://127.0.0.1:3000',
    desktopProfileUiBaseUrl: 'http://127.0.0.1:3001',
  },
}))

vi.mock('../src/services/directory/index.js', () => ({
  listAllTeams: vi.fn(),
  listTeamAgentsByTeam: vi.fn(),
  listTeamContextsByTeam: vi.fn(),
}))

vi.mock('../src/services/identityProviders/importExecution.js', () => ({
  executeMicrosoftImport: vi.fn(),
}))

vi.mock('../src/services/identityProviders/service.js', () => ({
  createPendingMicrosoftConnection: vi.fn(),
  defaultMicrosoftCallbackUrl: vi.fn(() => 'http://127.0.0.1:8096/api/v1/callback'),
  disconnectIdentityProviderConnection: vi.fn(),
  getIdentityProviderConnection: vi.fn(),
  listIdentityProviderConnections: vi.fn(),
  loadMicrosoftDirectory: vi.fn(),
  startMicrosoftOAuth: mocks.startMicrosoftOAuth,
  updateMicrosoftIdentityProviderConnection: mocks.updateConnection,
}))

vi.mock('../src/services/identityProviders/setup.js', () => ({
  attachConnectionToIdentityProviderSetup: vi.fn(),
  createIdentityProviderSetup: vi.fn(),
  getActiveIdentityProviderSetup: vi.fn(),
  getIdentityProviderSetupById: vi.fn(),
  loadIdentityProviderSetupSecret: vi.fn(),
  saveIdentityProviderSetupSecret: vi.fn(),
  updateIdentityProviderSetup: vi.fn(),
}))

vi.mock('../src/routes/admin/accessReconciliationResponse.js', () => ({
  loadAdminActiveAgentNames: vi.fn(),
  loadAdminActiveContextIds: vi.fn(),
}))

const { createAdminIdentityProvidersRouter } =
  await import('../src/routes/admin/identityProviders.js')

function app() {
  const testApp = express()
  testApp.use(express.json())
  testApp.use(createAdminIdentityProvidersRouter({} as K8sGateway))
  testApp.use(
    (
      error: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => res.status(error.status || 500).json({ error: error.message })
  )
  return testApp
}

describe('admin identity provider connection updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an invalid callback before mutating a connection', async () => {
    const response = await request(app())
      .patch('/admin/identity-provider-connections/connection-1')
      .send({
        displayName: 'Example',
        tenantId: '11111111-1111-4111-8111-111111111111',
        clientId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'replacement',
        allowMemberLogin: true,
        returnUrl: 'https://attacker.example/settings/integrations/microsoft/connect',
      })

    expect(response.status).toBe(400)
    expect(mocks.updateConnection).not.toHaveBeenCalled()
  })

  it('accepts the edit dialog callback and starts reauthorization', async () => {
    const connection = { id: 'connection-1', provider: 'microsoft' }
    mocks.updateConnection.mockResolvedValue({ connection, requiresAuthorization: true })
    mocks.startMicrosoftOAuth.mockResolvedValue({
      authorizeUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize',
    })

    const response = await request(app())
      .patch('/admin/identity-provider-connections/connection-1')
      .send({
        displayName: 'Example',
        tenantId: '11111111-1111-4111-8111-111111111111',
        clientId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'replacement',
        allowMemberLogin: true,
        returnUrl: 'http://localhost:3000/settings/integrations/microsoft/connect',
      })

    expect(response.status).toBe(200)
    expect(mocks.updateConnection).toHaveBeenCalledTimes(1)
    expect(mocks.startMicrosoftOAuth).toHaveBeenCalledWith({
      connectionId: 'connection-1',
      flow: 'admin_connect',
      returnUrl: 'http://localhost:3000/settings/integrations/microsoft/connect',
    })
    expect(response.body.authorizeUrl).toContain('https://login.microsoftonline.com/')
  })
})
