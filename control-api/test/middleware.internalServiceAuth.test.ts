import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mutable mock target — the suite reconfigures `mockedConfig` between tests so
// each scenario can install a different `internalServiceTokens` shape without
// unloading the module graph.
const mockedConfig: {
  internalServiceTokens: Record<string, string>
} = {
  internalServiceTokens: {},
}

vi.mock('../src/config.js', () => ({
  get config() {
    return mockedConfig
  },
}))

// Late import: must come AFTER vi.mock so the module reads the mocked config.
const { requireInternalToken } = await import('../src/middleware/internalServiceAuth.js')
const { requireInternalService } = await import('../src/middleware/internalServiceAuth.js')

// J1 (R1-L7): every gate refusal carries this header and value beside the
// unchanged 401 body; rpc-proxy reads them to tell a refused service credential
// from a refused caller token. Pinned as literals so a drift in control-api's
// constants fails here.
const REFUSAL_HEADER = 'x-internal-service-auth-refusal'
const REFUSAL_VALUE = 'service_credential_rejected'

function expectMarkedGateRefusal(res: request.Response): void {
  expect(res.status).toBe(401)
  expect(res.body).toEqual({ error: 'Unauthorized' })
  expect(res.text).toBe('{"error":"Unauthorized"}')
  expect(res.headers[REFUSAL_HEADER]).toBe(REFUSAL_VALUE)
}

function buildApp() {
  const app = express()
  app.use(express.json())
  app.post('/test', requireInternalToken, (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

describe('requireInternalToken — cluster-wide bootstrap', () => {
  beforeEach(() => {
    mockedConfig.internalServiceTokens = {}
  })

  it('allows a known service with a valid token', async () => {
    const token = 'valid-service-token-1234567890'
    mockedConfig.internalServiceTokens = { 'external-rest-api': token }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', `Bearer ${token}`)
      .set('x-service-token', 'external-rest-api')
      .send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers[REFUSAL_HEADER]).toBeUndefined()
  })

  it('rejects an unknown service', async () => {
    mockedConfig.internalServiceTokens = {}

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer any-token-1234567890')
      .set('x-service-token', 'external-rest-api')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })

  it('rejects a known service with the wrong token', async () => {
    mockedConfig.internalServiceTokens = { 'rpc-proxy': 'correct-token-1234567890' }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer wrong-token-1234567890')
      .set('x-service-token', 'rpc-proxy')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })

  it('rejects requests with no Authorization header', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('x-service-token', 'external-rest-api')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })

  it('rejects requests with no x-service-token header', async () => {
    mockedConfig.internalServiceTokens = { 'external-rest-api': 'some-token-1234567890' }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer some-token-1234567890')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })

  it('rejects tokens that are too short (< 16 chars)', async () => {
    mockedConfig.internalServiceTokens = { 'external-rest-api': 'short' }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer short')
      .set('x-service-token', 'external-rest-api')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })

  it('rejects workflow-approval-reader because Figure D does not use control-api service auth', async () => {
    const staleReaderToken = 'wrc-token-1234567890'
    mockedConfig.internalServiceTokens = { 'external-rest-api': 'external-token-1234567890' }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', `Bearer ${staleReaderToken}`)
      .set('x-service-token', 'workflow-approval-reader')
      .send({})
    expect(res.status).toBe(401)
    expectMarkedGateRefusal(res)
  })
})

// A service token built at run time, so no credential literal enters the diff.
function serviceTokenFixture(label: string): string {
  return `${label}-fixture-`.padEnd(32, 'x')
}

describe('requireInternalToken — refusal marking (J1)', () => {
  beforeEach(() => {
    mockedConfig.internalServiceTokens = {}
  })

  it('marks a bearer longer than 4096 characters', async () => {
    mockedConfig.internalServiceTokens = { 'rpc-proxy': serviceTokenFixture('rpc-proxy') }

    const res = await request(buildApp())
      .post('/test')
      .set('Authorization', `Bearer ${'a'.repeat(4097)}`)
      .set('x-service-token', 'rpc-proxy')
      .send({})
    expectMarkedGateRefusal(res)
  })

  it('answers a valid credential with no refusal header', async () => {
    const credential = serviceTokenFixture('rpc-proxy')
    mockedConfig.internalServiceTokens = { 'rpc-proxy': credential }

    const res = await request(buildApp())
      .post('/test')
      .set('Authorization', `Bearer ${credential}`)
      .set('x-service-token', 'rpc-proxy')
      .send({})
    // Witness: the handler ran.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers[REFUSAL_HEADER]).toBeUndefined()
  })
})

describe('requireInternalService — refusal marking (J1)', () => {
  function buildServiceApp() {
    const app = express()
    app.use(requireInternalToken)
    app.use('/rpc', requireInternalService('rpc-proxy'))
    app.get('/rpc/probe', (_req, res) => {
      res.status(200).json({ ok: true })
    })
    return app
  }

  beforeEach(() => {
    mockedConfig.internalServiceTokens = {
      'rpc-proxy': serviceTokenFixture('rpc-proxy'),
      'external-rest-api': serviceTokenFixture('external-rest-api'),
    }
  })

  it('marks a caller authenticated as another service', async () => {
    const res = await request(buildServiceApp())
      .get('/rpc/probe')
      .set('Authorization', `Bearer ${serviceTokenFixture('external-rest-api')}`)
      .set('x-service-token', 'external-rest-api')
    expectMarkedGateRefusal(res)
  })

  it('lets the expected service through with no refusal header', async () => {
    const res = await request(buildServiceApp())
      .get('/rpc/probe')
      .set('Authorization', `Bearer ${serviceTokenFixture('rpc-proxy')}`)
      .set('x-service-token', 'rpc-proxy')
    // Witness: the handler behind both gates ran.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(res.headers[REFUSAL_HEADER]).toBeUndefined()
  })
})
