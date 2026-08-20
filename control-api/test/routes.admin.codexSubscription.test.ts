import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { CodexSubscriptionOAuthError } from '../src/services/codexSubscriptionOAuth.js'

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

const { config } = await import('../src/config.js')
const { createAdminCodexSubscriptionRouter } =
  await import('../src/routes/admin/codexSubscription.js')

function makeAuthedApp() {
  const app = express()
  app.use(express.json())
  app.use((req: Request & { adminAuth?: { sub: string } }, _res: Response, next: NextFunction) => {
    req.adminAuth = { sub: 'admin-1' }
    next()
  })
  app.use(createAdminCodexSubscriptionRouter())
  return app
}

function assertNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret/i)
  expect(serialized).not.toMatch(/cookie|set-cookie|authorization/i)
  expect(serialized).not.toContain('acct_raw_123')
}

describe('admin Codex subscription routes', () => {
  let app: ReturnType<typeof makeAuthedApp>

  beforeEach(() => {
    app = makeAuthedApp()
    config.codexSubscriptionEnabled = true
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

  it('starts browser and device flows without tokens or cookies', async () => {
    oauth.startBrowser.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=abc',
      state: 'abc',
      intent: 'connect',
      expiresAt: new Date().toISOString(),
    })
    oauth.startDevice.mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 5,
      state: 'dev',
      intent: 'connect',
    })
    const browser = await request(app)
      .post('/admin/llm/providers/codex-subscription/browser/start')
      .send({ intent: 'connect' })
    expect(browser.status).toBe(200)
    expect(browser.body.authorizeUrl).toContain('https://auth.openai.com/oauth/authorize')
    expect(browser.headers['set-cookie']).toBeUndefined()
    assertNoLeak(browser.body)

    const device = await request(app)
      .post('/admin/llm/providers/codex-subscription/device/start')
      .send({ intent: 'replace' })
    expect(device.status).toBe(200)
    expect(device.body.userCode).toBe('ABCD-EFGH')
    expect(device.body).not.toHaveProperty('deviceCode')
    assertNoLeak(device.body)
  })

  it('maps replacement and refresh races to 409 without leaking tokens', async () => {
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
})
