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
  })

  it('rejects requests with no Authorization header', async () => {
    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('x-service-token', 'external-rest-api')
      .send({})
    expect(res.status).toBe(401)
  })

  it('rejects requests with no x-service-token header', async () => {
    mockedConfig.internalServiceTokens = { 'external-rest-api': 'some-token-1234567890' }

    const app = buildApp()
    const res = await request(app)
      .post('/test')
      .set('Authorization', 'Bearer some-token-1234567890')
      .send({})
    expect(res.status).toBe(401)
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
  })
})
