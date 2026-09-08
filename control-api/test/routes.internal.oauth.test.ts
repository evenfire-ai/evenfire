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
import { canonicalResourceIdentity, hashActionTarget } from '@clerum/action-context-contracts'
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

function seedRecipeWithOAuth(
  gateway: MockGateway,
  opts: {
    recipeName: string
    oauthClients?: Array<{
      id: string
      provider: string
      clientIdRef: { name: string; key: string }
      clientSecretRef: { name: string; key: string }
      scopes: string[]
    }>
  }
): void {
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
        oauthClients: opts.oauthClients ?? [
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

function v2ContextHeader(input: { oauthClientId: string; userId?: string }): string {
  const resource = canonicalResourceIdentity({
    environmentId: 'test',
    type: 'sandbox_app',
    logicalId: 'sandbox-recipes/sales-crm',
    displayName: 'sales-crm',
  })
  const target = {
    recipeNamespace: config.sandboxNamespace,
    recipeName: 'sales-crm',
    oauthClientId: input.oauthClientId,
  }
  return Buffer.from(
    JSON.stringify({
      version: 2,
      userId: input.userId ?? 'u-1',
      operationId: 'sandbox.oauth.vend',
      resource,
      target,
      targetHash: hashActionTarget(target),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
  ).toString('base64url')
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

  it('rejects duplicate current client ids before reading secrets', async () => {
    const gateway = new MockGateway()
    const duplicate = {
      id: 'microsoft',
      provider: 'microsoft-graph',
      clientIdRef: { name: 'one', key: 'client_id' },
      clientSecretRef: { name: 'one', key: 'client_secret' },
      scopes: ['User.Read'],
    }
    seedRecipeWithOAuth(gateway, {
      recipeName: 'sales-crm',
      oauthClients: [duplicate, { ...duplicate, clientIdRef: { name: 'two', key: 'client_id' } }],
    })
    const getSecret = vi.spyOn(gateway, 'getSecret')

    const res = await request(createApp(gateway as never))
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'sales-crm',
        oauthClientId: 'microsoft',
        userId: 'u-1',
        redirectUri: 'http://localhost:8090/oauth-callback/microsoft',
      })
      .expect(400)

    expect(res.body).toEqual({ error: 'unknown_oauth_client' })
    expect(getSecret).not.toHaveBeenCalled()
  })

  it('allows same-provider clients with distinct ids and resolves only the selected id', async () => {
    const gateway = new MockGateway()
    const declaration = (id: string) => ({
      id,
      provider: 'microsoft-graph',
      clientIdRef: { name: `${id}-secret`, key: 'client_id' },
      clientSecretRef: { name: `${id}-secret`, key: 'client_secret' },
      scopes: ['User.Read'],
    })
    seedRecipeWithOAuth(gateway, {
      recipeName: 'sales-crm',
      oauthClients: [declaration('calendar'), declaration('mail')],
    })

    const res = await request(createApp(gateway as never))
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'sales-crm',
        oauthClientId: 'mail',
        userId: 'u-1',
        redirectUri: 'http://localhost:8090/oauth-callback/mail',
      })
      .expect(503)

    expect(res.body.hint).toContain('mail-secret')
    expect(res.body.hint).not.toContain('calendar-secret')
  })

  it('rejects a v2 target substitution before reading secrets', async () => {
    const gateway = new MockGateway()
    seedRecipeWithOAuth(gateway, { recipeName: 'sales-crm' })
    const getSecret = vi.spyOn(gateway, 'getSecret')

    const res = await request(createApp(gateway as never))
      .post('/api/v1/internal/sandbox-ui/oauth/authorize-url')
      .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
      .set('x-service-token', 'rpc-proxy')
      .set('x-clerum-edge-action-context', v2ContextHeader({ oauthClientId: 'other' }))
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'sales-crm',
        oauthClientId: 'microsoft',
        userId: 'u-1',
        redirectUri: 'http://localhost:8090/oauth-callback/microsoft',
      })
      .expect(400)

    expect(res.body).toEqual({ error: 'invalid_binding' })
    expect(getSecret).not.toHaveBeenCalled()
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
