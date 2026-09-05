import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { deriveOAuthEncryptionKey, encryptOAuthSecret } from '../src/oauth/encryption.js'
import { checkAndIncrement } from '../src/services/rateLimiterService.js'
import { issueOAuthBrokerJwt } from '../src/utils/auth/oauthBrokerJwtToken.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()

vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

// The broker route is rate-limited via a PG-backed token bucket; stub it to
// always-allow so the route logic is what's under test here.
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: 1,
  }),
}))

const SANDBOX_NS = 'sandbox-recipes'
const ENCRYPTION_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)

function seedRecipe(
  gateway: MockGateway,
  opts: { name: string; backgroundAccess?: boolean }
): void {
  void gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name: opts.name },
      spec: {
        oauthClients: [
          {
            id: 'google-gmail',
            provider: 'google',
            clientIdRef: { name: 'google-creds', key: 'client-id' },
            clientSecretRef: { name: 'google-creds', key: 'client-secret' },
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            ...(opts.backgroundAccess ? { backgroundAccess: true } : {}),
          },
        ],
      },
    },
    SANDBOX_NS
  )
}

function brokerToken(recipeName: string, recipeNamespace = SANDBOX_NS): string {
  return issueOAuthBrokerJwt(recipeNamespace, recipeName).token
}

describe('routes/recipe-oauth — POST /recipe-oauth/user-token (SEC-5)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('200 with accessToken for a background-consented user', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    const future = new Date(Date.now() + 3600_000)
    // The grant lookup (getOAuthGrant with requireBackground:true) returns a row
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          recipe_namespace: SANDBOX_NS,
          recipe_name: 'leadforge',
          user_id: 'user-1',
          oauth_client_id: 'google-gmail',
          grant_kind: 'user',
          provider: 'google',
          access_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'USER-ACCESS-TOKEN'),
          refresh_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'USER-REFRESH-TOKEN'),
          access_token_expires_at: future,
          updated_at: new Date(),
          background: true,
        },
      ],
      rowCount: 1,
    })

    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ oauthClientId: 'google-gmail', userId: 'user-1' })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('USER-ACCESS-TOKEN')
    expect(res.body.expiresAt).toBe(future.toISOString())

    // [SEC-5] verify the grant lookup was scoped to the correct recipe and userId
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('oauth_grants') && sql.includes('background = true')
    )
    expect(grantQuery?.[1]).toEqual(['recipe', SANDBOX_NS, 'leadforge', 'user-1', 'google-gmail'])
  })

  it('404 no_grant for a non-consented (background=false) user', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    // mockPoolQuery returns empty rows → no_grant
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ oauthClientId: 'google-gmail', userId: 'user-2' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
  })

  it('400 invalid_request when userId is missing', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ oauthClientId: 'google-gmail' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('400 invalid_request when oauthClientId is missing', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ userId: 'user-1' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('400 unknown_oauth_client when client lacks backgroundAccess', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: false })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ oauthClientId: 'google-gmail', userId: 'user-1' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('401 without a broker token', async () => {
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .send({ oauthClientId: 'google-gmail', userId: 'user-1' })

    expect(res.status).toBe(401)
  })

  it('[SEC-5] derives recipe identity from the token, not the body', async () => {
    // Broker token is for "leadforge" but body carries victim namespace/name (ignored).
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    // Empty rows → no_grant (verifies scope, not victim data)
    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({
        oauthClientId: 'google-gmail',
        userId: 'user-1',
        recipeName: 'victim',
        recipeNamespace: SANDBOX_NS,
      })

    // Grant lookup was scoped to "leadforge" — no grant seeded → no_grant
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
    )
    expect(grantQuery?.[1]).toEqual(['recipe', SANDBOX_NS, 'leadforge', 'user-1', 'google-gmail'])
  })

  it('returns 429 when the per-recipe rate limit is exceeded', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 30_000,
      windowStartMs: Date.now(),
      count: 61,
    })

    const res = await request(app)
      .post('/api/v1/recipe-oauth/user-token')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)
      .send({ oauthClientId: 'google-gmail', userId: 'user-1' })

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
