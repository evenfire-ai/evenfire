import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'

const gateway = {
  createResource: vi.fn(),
  deleteResource: vi.fn(),
  getResource: vi.fn(),
  updateResource: vi.fn(),
  createSecret: vi.fn(),
  mergeSecret: vi.fn(),
  removeSecretKey: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
}

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gateway as unknown as K8sGateway))
  return app
}

describe('admin channel write response', () => {
  beforeEach(() => {
    Object.values(gateway).forEach(fn => fn.mockReset())
  })

  it('preserves the result envelope while returning only the names-only summary', async () => {
    const fixtureValue = 'unit-fixture-value'
    const encodedFixtureValue = Buffer.from(fixtureValue).toString('base64')

    gateway.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gateway.mergeSecret.mockResolvedValue({
      name: 'cc-foo-credentials',
      namespace: 'channels',
      keys: ['telegram-bot-token'],
      data: { 'telegram-bot-token': encodedFixtureValue },
      stringData: { 'telegram-bot-token': fixtureValue },
      metadata: {
        annotations: { 'example.invalid/value': fixtureValue },
      },
    })

    const response = await request(makeApp())
      .put('/admin/communication-channels/foo/credentials')
      .send({ 'telegram-bot-token': fixtureValue })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      name: 'foo',
      secretName: 'cc-foo-credentials',
      namespace: 'channels',
      rotated: true,
      result: {
        name: 'cc-foo-credentials',
        namespace: 'channels',
        keys: ['telegram-bot-token'],
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(fixtureValue)
    expect(JSON.stringify(response.body)).not.toContain(encodedFixtureValue)
  })
})
