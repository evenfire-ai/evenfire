import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockedConfig = vi.hoisted(() => ({
  internalServiceTokens: {} as Record<string, string>,
}))

vi.mock('../src/config.js', () => ({ config: mockedConfig }))

const { requireActionCheckpointCaller } =
  await import('../src/middleware/actionCheckpointCaller.js')

function app() {
  const value = express()
  value.post('/checkpoint', requireActionCheckpointCaller, (req, res) => {
    res.status(200).json(req.actionCheckpointCaller)
  })
  return value
}

describe('requireActionCheckpointCaller', () => {
  beforeEach(() => {
    mockedConfig.internalServiceTokens = {
      'rpc-proxy': 'rpc-proxy-token-1234567890',
      'external-rest-api': 'external-token-1234567890',
    }
  })

  it('composes the existing rpc-proxy service-token verifier', async () => {
    const response = await request(app())
      .post('/checkpoint')
      .set('authorization', 'Bearer rpc-proxy-token-1234567890')
      .set('x-service-token', 'rpc-proxy')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      service: 'rpc-proxy',
      trustPlane: 'internal_service_token',
    })
  })

  it.each([
    ['missing credentials', undefined, undefined],
    ['wrong rpc-proxy token', 'rpc-proxy', 'wrong-token-that-is-long-enough'],
    ['unregistered caller plane', 'external-rest-api', 'external-token-1234567890'],
  ])('rejects %s', async (_label, service, token) => {
    let pending = request(app()).post('/checkpoint')
    if (service) pending = pending.set('x-service-token', service)
    if (token) pending = pending.set('authorization', `Bearer ${token}`)
    await pending.expect(401, { error: 'Unauthorized' })
  })
})
