import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { CodexSubscriptionOAuthError } from '../src/services/codexSubscriptionOAuth.js'

const oauth = vi.hoisted(() => ({
  callback: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionOAuth.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionOAuth.js')
  return {
    ...actual,
    handleCodexBrowserCallback: oauth.callback,
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

const { createAuthCodexSubscriptionRouter } =
  await import('../src/routes/auth/codexSubscription.js')

function makeApp() {
  const app = express()
  app.use(createAuthCodexSubscriptionRouter())
  return app
}

function assertNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body)
  expect(serialized).not.toMatch(/sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret/i)
  expect(serialized).not.toMatch(/cookie|set-cookie|authorization/i)
  expect(serialized).not.toContain('acct_raw_123')
}

describe('GET /auth/codex-subscription/callback', () => {
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    app = makeApp()
    oauth.callback.mockReset()
  })

  it('rejects a missing code or state', async () => {
    oauth.callback.mockRejectedValue(new CodexSubscriptionOAuthError('invalid_callback', 'missing'))
    const res = await request(app).get('/auth/codex-subscription/callback')
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_callback' })
    assertNoLeak(res.body)
  })

  it('rejects callback replay', async () => {
    oauth.callback.mockRejectedValue(new CodexSubscriptionOAuthError('state_replayed', 'replay'))
    const res = await request(app)
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'state_replayed' })
    assertNoLeak(res.body)
  })

  it('returns only safe connection fields on success', async () => {
    oauth.callback.mockResolvedValue({
      status: 'connected',
      accountFingerprint: 'fp',
      credentialRevision: 1,
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
    })
    const res = await request(app)
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'connected',
      accountFingerprint: 'fp',
      credentialRevision: 1,
    })
    expect(res.headers['set-cookie']).toBeUndefined()
    assertNoLeak(res.body)
  })
})
