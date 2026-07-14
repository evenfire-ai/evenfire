import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { verifyOAuthBrokerJwt } from '../src/utils/auth/oauthBrokerJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const SANDBOX_NS = 'sandbox-recipes'

function signInternalControlJwt(iss: string): string {
  const secret =
    iss === 'hcc' ? config.internalControlJwtHccHmacSecret : config.internalControlJwtWrcHmacSecret
  return jwt.sign({ iss, aud: 'control-api', sub: `${iss}-provisioner` }, secret, {
    algorithm: 'HS256',
    expiresIn: 60,
    jwtid: `${iss}-test-jti-${Date.now()}`,
  })
}

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

const BASE = '/api/v1/auth/recipe-oauth'

describe('routes/auth/recipe-oauth issue', () => {
  let gateway: MockGateway
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    gateway = new MockGateway(SANDBOX_NS)
    app = createApp(gateway as never)
  })

  it('mints a broker token for a recipe with a backgroundAccess client', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })

    const res = await request(app)
      .post(`${BASE}/${SANDBOX_NS}/crm/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({})

    expect(res.status).toBe(200)
    expect(typeof res.body.brokerToken).toBe('string')
    expect(res.body.expiresInSeconds).toBe(config.oauthBrokerJwtTtlSec)

    const claims = verifyOAuthBrokerJwt(res.body.brokerToken)
    expect(claims).not.toBeNull()
    expect(claims?.sub).toBe(`${SANDBOX_NS}/crm`)
    expect(claims?.recipeName).toBe('crm')
    expect(claims?.scope).toBe('oauth:service-token')
  })

  it('[SEC-4] rejects a recipe with no backgroundAccess client', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: false })

    const res = await request(app)
      .post(`${BASE}/${SANDBOX_NS}/crm/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('background_access_not_enabled')
  })

  it('[SEC-4] returns 404 when the recipe does not exist', async () => {
    const res = await request(app)
      .post(`${BASE}/${SANDBOX_NS}/missing/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('recipe_not_found')
  })

  it('rejects the HCC provisioner — broker tokens are recipe-only', async () => {
    seedRecipe(gateway, { name: 'crm', backgroundAccess: true })

    const res = await request(app)
      .post(`${BASE}/${SANDBOX_NS}/crm/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('invalid_provisioner_for_route')
  })

  it('rejects a recipe namespace outside the sandbox namespace', async () => {
    const res = await request(app)
      .post(`${BASE}/mcp-host/crm/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('rejects an unknown InternalControl issuer', async () => {
    const res = await request(app)
      .post(`${BASE}/${SANDBOX_NS}/crm/broker-token`)
      .set('Authorization', `Bearer ${signInternalControlJwt('other')}`)
      .send({})

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })
})
