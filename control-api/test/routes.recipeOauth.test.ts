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
            id: 'salesforce',
            provider: 'salesforce',
            clientIdRef: { name: 'sf-creds', key: 'client-id' },
            clientSecretRef: { name: 'sf-creds', key: 'client-secret' },
            scopes: ['api', 'refresh_token'],
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

describe('routes/recipe-oauth — POST /recipe-oauth/token', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('returns a fresh access token for a connected service grant', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
    const future = new Date(Date.now() + 3600_000)
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          recipe_namespace: SANDBOX_NS,
          recipe_name: 'crm',
          user_id: null,
          oauth_client_id: 'salesforce',
          grant_kind: 'service',
          provider: 'salesforce',
          access_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'ACCESS-TOKEN'),
          refresh_token_encrypted: encryptOAuthSecret(ENCRYPTION_KEY, 'REFRESH-TOKEN'),
          access_token_expires_at: future,
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    })

    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBe('ACCESS-TOKEN')
    expect(res.body.expiresAt).toBe(future.toISOString())
  })

  it('returns 404 no_grant when no service grant row exists', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
  })

  it('[SEC-3] rejects an oauthClient not declared with backgroundAccess', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: false })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('rejects an oauthClientId not declared on the recipe at all', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'slack' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('returns 404 recipe_not_found when the recipe is gone', async () => {
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('missing')}`)
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('recipe_not_found')
  })

  it('returns 400 invalid_request when oauthClientId is missing', async () => {
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('returns 401 without a broker token', async () => {
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(401)
  })

  it('returns 401 for a malformed bearer token', async () => {
    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', 'Bearer not-a-jwt')
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(401)
  })

  it('[SEC-3] derives recipe identity from the token, not the body', async () => {
    // The broker token is for "crm" but the body claims "victim". The handler
    // must look up "crm" (the token's sub) — "victim" in the body is ignored.
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
    seedRecipe(gateway, { name: 'victim', backgroundAccess: true })

    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'salesforce', recipeName: 'victim', recipeNamespace: SANDBOX_NS })

    // Resolves against "crm" — no grant seeded → no_grant (not victim's data).
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('no_grant')
    // The grant lookup query was scoped to "crm".
    const grantQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('oauth_grants')
    )
    expect(grantQuery?.[1]).toEqual(['recipe', SANDBOX_NS, 'crm', 'salesforce'])
  })

  it('returns 429 when the per-recipe rate limit is exceeded', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })
    vi.mocked(checkAndIncrement).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetMs: Date.now() + 30_000,
      windowStartMs: Date.now(),
      count: 61,
    })

    const res = await request(app)
      .post('/api/v1/recipe-oauth/token')
      .set('Authorization', `Bearer ${brokerToken('crm')}`)
      .send({ oauthClientId: 'salesforce' })

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
