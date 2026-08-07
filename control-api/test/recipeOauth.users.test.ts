import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
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

describe('routes/recipe-oauth — GET /recipe-oauth/users (SEC-6)', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = createApp(gateway as never)
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('returns the consenting userIds for the client', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    // listBackgroundUserGrants queries the pool; seed two consenting users
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'user-1' }, { user_id: 'user-2' }],
      rowCount: 2,
    })

    const res = await request(app)
      .get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(200)
    expect(res.body.users).toEqual(['user-1', 'user-2'])

    // [SEC-6] verify the query was scoped to the calling recipe + client
    const listQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('background = true')
    )
    expect(listQuery?.[1]).toEqual([SANDBOX_NS, 'leadforge', 'google-gmail'])
  })

  it('returns empty array when no consenting users exist', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    // Default: mockPoolQuery returns [] rows

    const res = await request(app)
      .get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(200)
    expect(res.body.users).toEqual([])
  })

  it('400 when oauthClientId is not a declared backgroundAccess client', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    const res = await request(app)
      .get('/api/v1/recipe-oauth/users?oauthClientId=nope')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('400 when the client exists but lacks backgroundAccess', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: false })
    const res = await request(app)
      .get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown_oauth_client')
  })

  it('400 when oauthClientId query param is missing', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    const res = await request(app)
      .get('/api/v1/recipe-oauth/users')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('401 without a broker token', async () => {
    const res = await request(app).get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')

    expect(res.status).toBe(401)
  })

  it('[SEC-6] scopes results to the calling recipe, not any other', async () => {
    seedRecipe(gateway, { name: 'leadforge', backgroundAccess: true })
    seedRecipe(gateway, { name: 'other-recipe', backgroundAccess: true })
    // seed one user row that our mock returns
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'user-1' }],
      rowCount: 1,
    })

    const res = await request(app)
      .get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(200)
    // The pool query was called with leadforge, not other-recipe
    const listQuery = mockPoolQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('background = true')
    )
    expect(listQuery?.[1]).toEqual([SANDBOX_NS, 'leadforge', 'google-gmail'])
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
      .get('/api/v1/recipe-oauth/users?oauthClientId=google-gmail')
      .set('Authorization', `Bearer ${brokerToken('leadforge')}`)

    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })
})
