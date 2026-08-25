import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

function appFor(gateway: Record<string, unknown>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  return app
}

describe('Secret response boundary', () => {
  it('returns only identity and key names for admin create and replace', async () => {
    const gateway = {
      listSecrets: vi.fn(async () => []),
      getSecret: vi.fn(async () => ({ metadata: { labels: {} } })),
      createSecret: vi.fn(async (body: unknown) => body),
      updateSecret: vi.fn(async (body: unknown) => body),
      deleteSecret: vi.fn(async () => ({ deleted: true })),
    }

    const app = appFor(gateway)
    const created = await request(app)
      .post('/admin/secrets')
      .send({ name: 'response-check', data: { field: 'value' } })
      .expect(201)
    const updated = await request(app)
      .put('/admin/secrets')
      .send({ name: 'response-check', data: { field: 'replacement' } })
      .expect(200)

    for (const response of [created, updated]) {
      expect(response.body).toMatchObject({
        name: 'response-check',
        namespace: 'mcp-host',
        keys: ['field'],
      })
      expect(response.body.data).toBeUndefined()
      expect(response.body.stringData).toBeUndefined()
    }
  })

  it('returns only identity and key names for recipe replace', async () => {
    const gateway = {
      listSecrets: vi.fn(async () => []),
      getSecret: vi.fn(async () => ({
        metadata: {
          name: 'recipe-check',
          namespace: 'sandbox-recipes',
          uid: 'uid-recipe-check',
          resourceVersion: '1',
          labels: { 'clerum.io/recipe-secret': 'true' },
        },
        data: { field: 'dmFsdWU=' },
      })),
      createSecret: vi.fn(async (body: unknown) => body),
      updateSecret: vi.fn(async (body: unknown) => ({
        ...(body as object),
        data: { field: 'cmVwbGFjZW1lbnQ=' },
      })),
      deleteSecret: vi.fn(async () => ({ deleted: true })),
    }

    const response = await request(appFor(gateway))
      .put('/admin/recipe-secrets')
      .send({ name: 'recipe-check', data: { field: 'replacement' } })
      .expect(200)

    expect(response.body).toMatchObject({
      name: 'recipe-check',
      namespace: 'sandbox-recipes',
      keys: ['field'],
    })
    expect(response.body.data).toBeUndefined()
    expect(response.body.stringData).toBeUndefined()
  })
})
