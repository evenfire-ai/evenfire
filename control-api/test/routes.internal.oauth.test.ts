/**
 * Route-level coverage for the unified "Deferred Credentials" contract
 * (Phase 1). The helper functions still return `kind: 'secret_missing'`
 * — that internal contract is unchanged. These tests pin the HTTP shape
 * that embeds + recipe authors program against:
 *
 *   HTTP 503
 *   { error: "integration_not_configured", integration, hint }
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'

function seedRecipeWithOAuth(gateway: MockGateway, opts: { recipeName: string }): void {
  // Workflow recipe with one OAuth client whose Secret is intentionally not
  // seeded — `secretReader` will surface SecretNotFoundError → helper
  // returns secret_missing → route should turn that into 503.
  // createResource is sync-safe in the mock — no await needed in tests.
  void gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name: opts.recipeName },
      spec: {
        workloads: [{ id: 'api', type: 'deployment', image: 'nginx:alpine' }],
        ui: { workloadRef: 'api', port: 8080 },
        oauthClients: [
          {
            id: 'microsoft',
            provider: 'microsoft-graph',
            clientIdRef: { name: 'sales-crm-oauth-microsoft', key: 'client_id' },
            clientSecretRef: { name: 'sales-crm-oauth-microsoft', key: 'client_secret' },
            scopes: ['User.Read'],
          },
        ],
      },
    },
    config.sandboxNamespace
  )
}

describe('POST /api/v1/internal/sandbox-ui/oauth/authorize-url (deferred credentials)', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
  })

  it('returns 503 integration_not_configured when the OAuth Secret is absent', async () => {
    const gateway = new MockGateway()
    seedRecipeWithOAuth(gateway, { recipeName: 'sales-crm' })
    const app = createApp(gateway as never)

    const res = await request(app)
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'sales-crm',
        oauthClientId: 'microsoft',
        userId: 'u-1',
        redirectUri: 'http://localhost:8090/oauth-callback/x/y/z',
      })

    if (res.status !== 503) {
      throw new Error(`got ${res.status}: ${JSON.stringify(res.body)}\n${res.text}`)
    }

    expect(res.body).toEqual({
      error: 'integration_not_configured',
      integration: 'microsoft',
      hint: 'create Secret sales-crm-oauth-microsoft to activate this integration',
    })
  })

  it('returns 503 integration_not_configured when the Secret exists but the key is empty', async () => {
    const gateway = new MockGateway()
    seedRecipeWithOAuth(gateway, { recipeName: 'sales-crm' })
    // Secret exists but `client_id` key is missing — helper reports
    // "<name>/<key>".
    gateway.seedSecret('sales-crm-oauth-microsoft', config.sandboxNamespace, {
      data: { 'unrelated-key': Buffer.from('x').toString('base64') },
    })
    const app = createApp(gateway as never)

    const res = await request(app)
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'sales-crm',
        oauthClientId: 'microsoft',
        userId: 'u-1',
        redirectUri: 'http://localhost:8090/oauth-callback/x/y/z',
      })
      .expect(503)

    expect(res.body).toEqual({
      error: 'integration_not_configured',
      integration: 'microsoft',
      hint: 'create key client_id on Secret sales-crm-oauth-microsoft to activate this integration',
    })
  })
})

// The /oauth/token route uses the same response shape and the same
// secretReader wrapper as /oauth/authorize-url. Reaching its `secret_missing`
// arm requires either a stale-access-token + valid refresh-token fixture
// (which means a properly encrypted oauth_grants row keyed by the test's
// derived encryption key) or a no-grant short-circuit (which never reaches
// the Secret read). The authorize-url test above already covers the
// 500→503 + body-shape plumbing; the token handler points at the same
// `integrationNotConfigured(...)` helper for the same `kind: 'secret_missing'`
// branch, so re-asserting it here would be a duplicate at significant
// test-fixture cost. The helper-level test in oauth.helpers.test.ts already
// covers token's secret_missing decision path.
