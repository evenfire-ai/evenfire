import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../src/config.js', () => ({
  config: {
    oauthEncryptionKey: '00'.repeat(32),
    controlUiBaseUrl: 'http://127.0.0.1:3000',
    desktopProfileUiBaseUrl: 'http://127.0.0.1:3001',
  },
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => ({
  TeamNameConflictError: class TeamNameConflictError extends Error {},
  createTeamWithDb: vi.fn(),
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  setTeamAgents: vi.fn(),
  setUserAgents: vi.fn(),
}))

vi.mock('../src/services/directory/login.js', () => ({
  identityProviderLoginData: vi.fn(),
}))

vi.mock('../src/services/directory/membership.js', () => ({
  createInvitationForTeams: vi.fn(),
}))

vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  validateInvitationFlowToken: vi.fn(),
}))

vi.mock('../src/services/identityProviders/setup.js', () => ({
  markIdentityProviderSetupAuthorized: vi.fn(),
}))

vi.mock('../src/utils/auth/externalSessionAuthToken.js', () => ({
  signExternalSessionToken: vi.fn(),
}))

const { pool, withTransaction } = await import('../src/db.js')
const { validateInvitationFlowToken } =
  await import('../src/services/invitationFlowRegistrationService.js')
const {
  completeMicrosoftOAuthErrorCallback,
  disconnectIdentityProviderConnection,
  exchangeIdentityProviderLoginCode,
  startMicrosoftOAuth,
} = await import('../src/services/identityProviders/service.js')

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const INVITATION_ID = '22222222-2222-4222-8222-222222222222'
const INVITATION_UUID = '33333333-3333-4333-8333-333333333333'

const connectionRow = {
  id: CONNECTION_ID,
  provider: 'microsoft',
  display_name: 'Example Microsoft',
  directory_tenant_id: '44444444-4444-4444-8444-444444444444',
  client_id: '55555555-5555-4555-8555-555555555555',
  oauth_callback_url: 'https://api.example.test/api/v1/identity-provider-callback/microsoft',
  client_secret_encrypted: 'encrypted-secret',
  refresh_token_encrypted: 'encrypted-refresh-token',
  granted_scopes: ['openid'],
  status: 'connected',
  allow_member_login: true,
  allowed_email_domains: ['example.test'],
  client_secret_expires_at: null,
  connected_at: new Date('2026-07-16T00:00:00.000Z'),
  disconnected_at: null,
  last_error: null,
  created_at: new Date('2026-07-16T00:00:00.000Z'),
}

describe('startMicrosoftOAuth invitation flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates the signed invitation token before querying the internal invitation UUID', async () => {
    vi.mocked(validateInvitationFlowToken).mockResolvedValue({
      email: 'member@example.test',
      invitationUuid: INVITATION_UUID,
    })
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [connectionRow] } as never)
      .mockResolvedValueOnce({ rows: [{ id: INVITATION_ID }] } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const result = await startMicrosoftOAuth({
      connectionId: CONNECTION_ID,
      flow: 'invitation_link',
      invitationToken: 'signed-member-registration-token',
      returnUrl: 'http://localhost:3001/auth/provider-callback',
      flowBinding: 'a'.repeat(43),
    })

    expect(validateInvitationFlowToken).toHaveBeenCalledWith('signed-member-registration-token')
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LOWER(email) = LOWER($3)'),
      [INVITATION_UUID, CONNECTION_ID, 'member@example.test']
    )
    expect(result.authorizeUrl).toContain('https://login.microsoftonline.com/')
  })

  it('rejects return URLs outside the configured Profile UI origin', async () => {
    vi.mocked(validateInvitationFlowToken).mockResolvedValue({
      email: 'member@example.test',
      invitationUuid: INVITATION_UUID,
    })
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [connectionRow] } as never)
      .mockResolvedValueOnce({ rows: [{ id: INVITATION_ID }] } as never)

    await expect(
      startMicrosoftOAuth({
        connectionId: CONNECTION_ID,
        flow: 'invitation_link',
        invitationToken: 'signed-member-registration-token',
        returnUrl: 'https://attacker.example/auth/provider-callback',
        flowBinding: 'b'.repeat(43),
      })
    ).rejects.toMatchObject({ status: 400 })
  })

  it('requires a client flow binding for member login flows', async () => {
    vi.mocked(validateInvitationFlowToken).mockResolvedValue({
      email: 'member@example.test',
      invitationUuid: INVITATION_UUID,
    })
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [connectionRow] } as never)
      .mockResolvedValueOnce({ rows: [{ id: INVITATION_ID }] } as never)

    await expect(
      startMicrosoftOAuth({
        connectionId: CONNECTION_ID,
        flow: 'invitation_link',
        invitationToken: 'signed-member-registration-token',
        returnUrl: 'http://localhost:3001/auth/provider-callback',
      })
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects an invalid signed invitation without querying invitation records', async () => {
    vi.mocked(validateInvitationFlowToken).mockRejectedValue(new Error('invalid invitation'))
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [connectionRow] } as never)

    await expect(
      startMicrosoftOAuth({
        connectionId: CONNECTION_ID,
        flow: 'invitation_link',
        invitationToken: 'invalid-signed-token',
        returnUrl: 'http://localhost:3001/auth/provider-callback',
      })
    ).rejects.toMatchObject({
      message: 'Microsoft invitation is not ready to connect',
      status: 409,
    })

    expect(pool.query).toHaveBeenCalledTimes(1)
  })
})

describe('exchangeIdentityProviderLoginCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches both the login code and the initiating client binding', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    vi.mocked(withTransaction).mockImplementation(async work =>
      work({ query } as Parameters<typeof work>[0])
    )
    const code = 'login-code'
    const flowBinding = 'c'.repeat(43)

    await expect(exchangeIdentityProviderLoginCode(code, flowBinding)).resolves.toBeNull()
    expect(query).toHaveBeenCalledWith(expect.stringContaining('flow_binding_hash = $2'), [
      createHash('sha256').update(code).digest('hex'),
      createHash('sha256').update(flowBinding).digest('hex'),
    ])
  })

  it('rejects exchange attempts without the initiating client binding', async () => {
    await expect(exchangeIdentityProviderLoginCode('login-code', '')).rejects.toMatchObject({
      status: 400,
    })
    expect(withTransaction).not.toHaveBeenCalled()
  })
})

describe('completeMicrosoftOAuthErrorCallback', () => {
  it('consumes state and returns profile errors to the allowlisted UI callback', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          connection_id: CONNECTION_ID,
          flow: 'profile_login',
          invitation_id: null,
          return_url: 'http://127.0.0.1:3001/auth/provider-callback',
          code_verifier_encrypted: 'unused',
          flow_binding_hash: 'binding-hash',
        },
      ],
    })
    vi.mocked(withTransaction).mockImplementation(async work =>
      work({ query } as Parameters<typeof work>[0])
    )

    const result = await completeMicrosoftOAuthErrorCallback({ state: 'denied-state' })

    const redirect = new URL(result.redirectUrl)
    expect(redirect.origin).toBe('http://127.0.0.1:3001')
    expect(redirect.pathname).toBe('/auth/provider-callback')
    expect(redirect.searchParams.get('error')).toBe('microsoft_sign_in_failed')
    expect(query).toHaveBeenCalledWith(expect.stringContaining('consumed_at = NOW()'), [
      createHash('sha256').update('denied-state').digest('hex'),
    ])
  })
})

describe('disconnectIdentityProviderConnection', () => {
  it('cancels an attached active setup so a later import can recover', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: CONNECTION_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(withTransaction).mockImplementation(async work =>
      work({ query } as Parameters<typeof work>[0])
    )

    await expect(disconnectIdentityProviderConnection(CONNECTION_ID)).resolves.toBe(true)
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("SET status = 'cancelled'"), [
      CONNECTION_ID,
    ])
  })

  it('refuses to disconnect a connection while its import lease is active', async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          import_lock_token: 'active-lock',
          import_lock_expires_at: new Date(Date.now() + 60_000),
        },
      ],
      rowCount: 1,
    })
    vi.mocked(withTransaction).mockImplementation(async work =>
      work({ query } as Parameters<typeof work>[0])
    )

    await expect(disconnectIdentityProviderConnection(CONNECTION_ID)).rejects.toMatchObject({
      status: 409,
      message: 'Microsoft import is currently running',
    })
    expect(query).toHaveBeenCalledTimes(1)
  })
})
