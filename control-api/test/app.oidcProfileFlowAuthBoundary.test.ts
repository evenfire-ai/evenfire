import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { MockGateway } from './mockGateway.js'

const EXTERNAL_REST_TOKEN = 'dev-external-rest-api-token'
const CONFIGURATION_PATH = '/api/v1/external/oidc/profile-flow/configuration'
const OIDC_ENV = {
  CONTROL_API_OIDC_REGISTRATION_ID: 'company-login',
  CONTROL_API_OIDC_DISPLAY_LABEL: 'Company login',
  CONTROL_API_OIDC_ISSUER: 'https://issuer.example.test/tenant/v2.0',
  CONTROL_API_OIDC_CLIENT_ID: 'test-client-id',
  CONTROL_API_OIDC_CLIENT_SECRET: 'a-test-only-oidc-provider-fixture-secret-that-must-never-escape',
  CONTROL_API_OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic',
  CONTROL_API_OIDC_REDIRECT_URI: 'https://profile.example.test/api/oidc/callback',
  CONTROL_API_OIDC_RESPONSE_MODE: 'query',
  CONTROL_API_OIDC_TRUST_GENERATION: 'config-2026-10-27-1',
} as const

function externalRest(app: ReturnType<typeof createApp>) {
  return request(app)
    .get(CONFIGURATION_PATH)
    .set('Authorization', `Bearer ${EXTERNAL_REST_TOKEN}`)
    .set('x-service-token', 'external-rest-api')
}

describe('OIDC Profile UI foundation service boundary', () => {
  const previousEnv = new Map<string, string | undefined>()

  afterEach(() => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    previousEnv.clear()
  })

  it('does not expose the protocol bridge as a public Control API route', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await request(app).get(CONFIGURATION_PATH)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })

  it('rejects an internal service other than external-rest-api', async () => {
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await request(app)
      .get(CONFIGURATION_PATH)
      .set('Authorization', 'Bearer dev-rpc-proxy-token')
      .set('x-service-token', 'rpc-proxy')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })

  it('serves the inactive configuration to external-rest-api on the external path', async () => {
    for (const [name, value] of Object.entries(OIDC_ENV)) {
      previousEnv.set(name, process.env[name])
      process.env[name] = value
    }
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await externalRest(app)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      redirectUri: OIDC_ENV.CONTROL_API_OIDC_REDIRECT_URI,
      memberAuthenticationActivated: false,
      displayLabel: OIDC_ENV.CONTROL_API_OIDC_DISPLAY_LABEL,
    })
    expect(JSON.stringify(response.body)).not.toContain(OIDC_ENV.CONTROL_API_OIDC_CLIENT_SECRET)
  })

  it('does not serve the bridge without the external prefix', async () => {
    for (const [name, value] of Object.entries(OIDC_ENV)) {
      previousEnv.set(name, process.env[name])
      process.env[name] = value
    }
    const app = createApp(new MockGateway('mcp-server') as never)

    const response = await request(app)
      .get('/api/v1/oidc/profile-flow/configuration')
      .set('Authorization', `Bearer ${EXTERNAL_REST_TOKEN}`)
      .set('x-service-token', 'external-rest-api')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Not Found' })
  })
})
