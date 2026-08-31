import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { CodexSubscriptionOAuthError } from '../src/services/codexSubscriptionOAuth.js'

const oauth = vi.hoisted(() => ({
  callback: vi.fn(),
  runCatalogSync: vi.fn(),
}))

vi.mock('../src/services/codexSubscriptionOAuth.js', async () => {
  const actual = await vi.importActual('../src/services/codexSubscriptionOAuth.js')
  return {
    ...actual,
    handleCodexBrowserCallback: oauth.callback,
    runCodexCatalogSync: oauth.runCatalogSync,
  }
})

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}))

vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

vi.mock('../src/observability/metrics.js', () => ({
  rateLimitHitsTotal: { inc: vi.fn() },
  llmAllowlistConfigMapWriteFailuresTotal: { inc: vi.fn() },
}))

const { config } = await import('../src/config.js')
const { createAuthCodexSubscriptionRouter } =
  await import('../src/routes/auth/codexSubscription.js')

function makeApp(gateway?: {
  llmAllowedModelsConfigMap: () => { materialize: () => Promise<void> }
}) {
  const app = express()
  app.use(createAuthCodexSubscriptionRouter(gateway as never))
  return app
}

function assertNoLeak(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  expect(serialized).not.toMatch(/sk-|Bearer |eyJ[A-Za-z0-9_-]+\.|refresh-secret|access-secret/i)
  expect(serialized).not.toMatch(/cookie|set-cookie|authorization/i)
  expect(serialized).not.toContain('acct_raw_123')
}

describe('GET /auth/codex-subscription/callback', () => {
  let app: ReturnType<typeof makeApp>

  beforeEach(() => {
    app = makeApp()
    oauth.callback.mockReset()
    oauth.runCatalogSync.mockReset()
    oauth.runCatalogSync.mockResolvedValue({
      ok: true,
      catalogStatus: 'ready',
      added: 1,
      refreshed: 0,
      staled: 0,
      connection: { connectionKey: 'codex-aaa', status: 'connected', catalogStatus: 'ready' },
    })
    config.controlUiBaseUrl = 'http://127.0.0.1:3000'
  })

  it('redirects back to the Codex surface on success without tokens', async () => {
    oauth.callback.mockResolvedValue({
      status: 'connected',
      connectionKey: 'codex-aaa',
      accountFingerprint: 'fp',
      credentialRevision: 1,
      refreshToken: 'refresh-secret',
      accessToken: 'access-secret',
    })
    const res = await request(app)
      .get('/auth/codex-subscription/callback')
      .set('x-forwarded-host', '127.0.0.1:36148')
      .set('x-forwarded-proto', 'http')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=connected'
    )
    expect(oauth.callback).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: 'http://127.0.0.1:36148/control-api/api/v1/auth/codex-subscription/callback',
      }),
      { code: 'code-1', state: 'state-1' }
    )
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(oauth.runCatalogSync).toHaveBeenCalledTimes(1)
    assertNoLeak(res.text)
  })

  it('publishes the runtime ConfigMap after a successful callback', async () => {
    const materialize = vi.fn(async () => {})
    oauth.callback.mockResolvedValue({
      status: 'connected',
      connectionKey: 'codex-aaa',
      accountFingerprint: 'fp',
      credentialRevision: 1,
    })
    const res = await request(makeApp({ llmAllowedModelsConfigMap: () => ({ materialize }) }))
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=connected'
    )
    expect(oauth.runCatalogSync).toHaveBeenCalledTimes(1)
    expect(materialize).toHaveBeenCalledTimes(1)
    assertNoLeak(res.headers.location)
  })

  it('still redirects when ConfigMap publish fails after a successful callback', async () => {
    const materialize = vi.fn(async () => {
      throw new Error('apiserver down')
    })
    oauth.callback.mockResolvedValue({
      status: 'connected',
      connectionKey: 'codex-aaa',
      accountFingerprint: 'fp',
      credentialRevision: 1,
    })
    const res = await request(makeApp({ llmAllowedModelsConfigMap: () => ({ materialize }) }))
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=connected'
    )
    expect(materialize).toHaveBeenCalledTimes(1)
    assertNoLeak(res.headers.location)
  })

  it('still redirects when automatic catalog sync fails after a successful callback', async () => {
    oauth.callback.mockResolvedValue({
      status: 'connected',
      connectionKey: 'codex-aaa',
      accountFingerprint: 'fp',
      credentialRevision: 1,
    })
    oauth.runCatalogSync.mockResolvedValue({
      ok: false,
      catalogStatus: 'unavailable',
      reason: 'catalog_sync_failed',
    })
    const res = await request(app)
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=connected'
    )
    expect(oauth.runCatalogSync).toHaveBeenCalledTimes(1)
    assertNoLeak(res.headers.location)
  })

  it('redirects callback replay errors back to the Codex surface', async () => {
    oauth.callback.mockRejectedValue(new CodexSubscriptionOAuthError('state_replayed', 'replay'))
    const res = await request(app)
      .get('/auth/codex-subscription/callback')
      .query({ code: 'code-1', state: 'state-1' })
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=state_replayed'
    )
    assertNoLeak(res.headers.location)
  })

  it('returns 404 JSON when the feature is disabled', async () => {
    oauth.callback.mockRejectedValue(new CodexSubscriptionOAuthError('disabled', 'off'))
    const res = await request(app).get('/auth/codex-subscription/callback')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'disabled' })
    assertNoLeak(res.body)
  })
})
