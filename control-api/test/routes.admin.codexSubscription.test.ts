import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { CodexSubscriptionOAuthError } from '../src/services/codexSubscriptionOAuth.js'
import { PUBLIC_CODEX_CLI_CLIENT_ID } from '../src/services/codexSubscriptionRedirectUri.js'

const oauth = vi.hoisted(() => ({
  getConnection: vi.fn(),
  startBrowser: vi.fn(),
  startDevice: vi.fn(),
  pollDevice: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionOAuth.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionOAuth.js')
  return {
    ...actual,
    getCodexSubscriptionConnection: oauth.getConnection,
    startCodexBrowserConnect: oauth.startBrowser,
    startCodexDeviceConnect: oauth.startDevice,
    pollCodexDevice: oauth.pollDevice,
    refreshCodexSubscriptionConnection: oauth.refresh,
    revokeCodexSubscription: oauth.revoke,
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { pool } = await import('../src/db.js')

const { config } = await import('../src/config.js')
const { createCodexCatalogTransportFromEnv } =
  await import('../src/services/codexSubscriptionCatalog.js')
const { createAdminCodexSubscriptionRouter } =
  await import('../src/routes/admin/codexSubscription.js')

function makeAuthedApp(gateway?: { listResource: ReturnType<typeof vi.fn> }) {
  const app = express()
  app.use(express.json())
  app.use((req: Request & { adminAuth?: { sub: string } }, _res: Response, next: NextFunction) => {
    req.adminAuth = { sub: 'admin-1' }
    next()
  })
  app.use(
    gateway
      ? createAdminCodexSubscriptionRouter(createCodexCatalogTransportFromEnv(), gateway as never)
      : createAdminCodexSubscriptionRouter()
  )
  return app
}

function safeCreatedRow(connectionKey: string, displayName: string) {
  return {
    id: `id-${connectionKey}`,
    connection_key: connectionKey,
    display_name: displayName,
    created_by: null,
    status: 'disconnected',
    credential_revision: 1,
    catalog_revision: 0,
    account_fingerprint: null,
    catalog_status: 'never_synced',
    catalog_synced_at: null,
    last_refresh_at: null,
    last_auth_at: null,
    refresh_lock_token: null,
    refresh_lock_expires_at: null,
    revoked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

function assertNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret/i)
  expect(serialized).not.toMatch(/cookie|set-cookie|authorization/i)
  expect(serialized).not.toContain('acct_raw_123')
}

describe('admin Codex subscription routes', () => {
  let app: ReturnType<typeof makeAuthedApp>
  const originalClientId = config.codexOAuthClientId
  const originalControlUiBaseUrl = config.controlUiBaseUrl

  beforeEach(() => {
    app = makeAuthedApp()
    config.codexSubscriptionEnabled = true
    config.codexOAuthClientId = originalClientId
    config.controlUiBaseUrl = originalControlUiBaseUrl
    for (const fn of Object.values(oauth)) fn.mockReset()
  })

  it('returns 404 while the feature flag is off', async () => {
    oauth.getConnection.mockRejectedValue(new CodexSubscriptionOAuthError('disabled', 'off'))
    const res = await request(app).get('/admin/llm/providers/codex-subscription/connection')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    assertNoLeak(res.body)
  })

  it('returns safe connection metadata', async () => {
    oauth.getConnection.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'connected',
      accountFingerprint: 'fp',
      credentialRevision: 2,
    })
    const res = await request(app).get('/admin/llm/providers/codex-subscription/connection')
    expect(res.status).toBe(200)
    expect(res.body.connectionKey).toBe('deployment-default')
    assertNoLeak(res.body)
  })

  it('blocks browser start for the public Codex CLI client', async () => {
    config.codexOAuthClientId = PUBLIC_CODEX_CLI_CLIENT_ID
    const res = await request(app)
      .post('/admin/llm/providers/codex-subscription/browser/start')
      .set('Origin', 'http://127.0.0.1:36148')
      .send({ intent: 'connect' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'browser_oauth_unregistered' })
    expect(oauth.startBrowser).not.toHaveBeenCalled()
    assertNoLeak(res.body)
  })

  it('starts browser OAuth with a control-ui derived redirect for custom clients', async () => {
    config.codexOAuthClientId = 'app_evenfire_custom'
    config.controlUiBaseUrl = 'http://127.0.0.1:3000'
    oauth.startBrowser.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=abc',
      state: 'abc',
      intent: 'connect',
      expiresAt: new Date().toISOString(),
    })
    const res = await request(app)
      .post('/admin/llm/providers/codex-subscription/browser/start')
      .set('Host', 'control-api.control-plane.svc.cluster.local:8090')
      .set('Origin', 'http://127.0.0.1:36148')
      .send({ intent: 'connect' })
    expect(res.status).toBe(200)
    expect(oauth.startBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'http://127.0.0.1:36148/control-api/api/v1/auth/codex-subscription/callback',
      }),
      'connect'
    )
    assertNoLeak(res.body)
  })

  it('starts device flow without tokens or cookies even with the public client', async () => {
    config.codexOAuthClientId = PUBLIC_CODEX_CLI_CLIENT_ID
    oauth.startDevice.mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      state: 'dev',
      intent: 'connect',
    })
    const device = await request(app)
      .post('/admin/llm/providers/codex-subscription/device/start')
      .send({ intent: 'replace' })
    expect(device.status).toBe(200)
    expect(device.body.userCode).toBe('ABCD-EFGH')
    expect(device.body).not.toHaveProperty('deviceCode')
    assertNoLeak(device.body)
  })

  it('maps replacement and refresh races to 409 without leaking tokens', async () => {
    config.codexOAuthClientId = 'app_evenfire_custom'
    oauth.startBrowser.mockRejectedValue(
      new CodexSubscriptionOAuthError('replacement_required', 'replace')
    )
    const replace = await request(app)
      .post('/admin/llm/providers/codex-subscription/browser/start')
      .send({ intent: 'connect' })
    expect(replace.status).toBe(409)
    expect(replace.body).toEqual({ error: 'replacement_required' })

    oauth.refresh.mockRejectedValue(new CodexSubscriptionOAuthError('refresh_in_flight', 'lock'))
    const refresh = await request(app).post('/admin/llm/providers/codex-subscription/refresh')
    expect(refresh.status).toBe(409)
    expect(refresh.body).toEqual({ error: 'refresh_in_flight' })
    assertNoLeak(refresh.body)
  })

  it('rejects a malformed nested connection key before starting OAuth', async () => {
    const res = await request(app)
      .post('/admin/llm/providers/codex-subscription/connections/Bad%20Key/device/start')
      .send({ intent: 'connect' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_connection_key' })
    expect(oauth.startDevice).not.toHaveBeenCalled()
  })

  it('maps a live fingerprint collision on a keyed device start to 409', async () => {
    oauth.startDevice.mockRejectedValue(
      new CodexSubscriptionOAuthError('fingerprint_in_use', 'account already connected')
    )
    const res = await request(app)
      .post('/admin/llm/providers/codex-subscription/connections/team-plus/device/start')
      .send({ intent: 'connect' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'fingerprint_in_use' })
    expect(oauth.startDevice).toHaveBeenCalledWith(
      expect.objectContaining({ connectionKey: 'team-plus' }),
      'connect'
    )
    assertNoLeak(res.body)
  })

  it('revokes without returning secrets', async () => {
    oauth.revoke.mockResolvedValue({
      connectionKey: 'deployment-default',
      status: 'revoked',
      credentialRevision: 9,
    })
    const res = await request(app).post('/admin/llm/providers/codex-subscription/revoke')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('revoked')
    assertNoLeak(res.body)
  })

  it('creates two connections with the same display name and distinct generated keys', async () => {
    vi.mocked(pool.query).mockImplementation(async (_sql: string, values?: unknown[]) => ({
      rows: [safeCreatedRow(String(values?.[0]), String(values?.[1]))],
      rowCount: 1,
    }))
    const first = await request(app)
      .post('/admin/llm/providers/codex-subscription/connections')
      .send({ displayName: 'Codex subscription' })
    const second = await request(app)
      .post('/admin/llm/providers/codex-subscription/connections')
      .send({ displayName: 'Codex subscription' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(first.body.connectionKey).toMatch(/^codex-[a-f0-9]{16}$/)
    expect(second.body.connectionKey).toMatch(/^codex-[a-f0-9]{16}$/)
    expect(first.body.connectionKey).not.toBe(second.body.connectionKey)
    expect(first.body.displayName).toBe('Codex subscription')
    expect(second.body.displayName).toBe('Codex subscription')
    expect(first.body.assignedHostsUnavailable).toBe(true)
    assertNoLeak(first.body)
    assertNoLeak(second.body)
  })

  it('marks assigned hosts unavailable when the Host list fails', async () => {
    oauth.getConnection.mockResolvedValue({
      connectionKey: 'team-plus',
      status: 'connected',
      credentialRevision: 2,
      catalogRevision: 1,
      accountFingerprint: 'fp',
    })
    const gateway = { listResource: vi.fn().mockRejectedValue(new Error('k8s down')) }
    const hosted = makeAuthedApp(gateway)
    const res = await request(hosted).get(
      '/admin/llm/providers/codex-subscription/connections/team-plus'
    )
    expect(res.status).toBe(200)
    expect(res.body.assignedHostsUnavailable).toBe(true)
    expect(res.body.assignedHosts).toBeUndefined()
    expect(gateway.listResource).toHaveBeenCalled()
    assertNoLeak(res.body)
  })

  it('maps a keyed poll connection mismatch to 409', async () => {
    oauth.pollDevice.mockRejectedValue(
      new CodexSubscriptionOAuthError('connection_mismatch', 'bound elsewhere')
    )
    const res = await request(app).get(
      '/admin/llm/providers/codex-subscription/connections/other-key/device/poll'
    )
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'connection_mismatch' })
    assertNoLeak(res.body)
  })
})
