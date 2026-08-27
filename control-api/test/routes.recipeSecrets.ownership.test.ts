import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

interface MockSecret {
  metadata?: { name?: string; labels?: Record<string, string> }
  keys?: string[]
  data?: Record<string, string>
}

type MockWrite = {
  name: string
  namespace?: string
  labels?: Record<string, string>
  data?: Record<string, string>
  stringData?: Record<string, string>
}

function writeSummary(body: MockWrite) {
  return {
    name: body.name,
    namespace: body.namespace || 'default',
    keys: [
      ...new Set([...Object.keys(body.data ?? {}), ...Object.keys(body.stringData ?? {})]),
    ].sort((a, b) => a.localeCompare(b)),
  }
}

function createGateway(opts: { recipes?: string[]; secrets?: MockSecret[] } = {}) {
  const recipes = opts.recipes ?? []
  const secrets = new Map<string, MockSecret>(
    (opts.secrets ?? []).map(s => [String(s.metadata?.name ?? ''), s])
  )
  return {
    listResource: vi.fn(async () => recipes.map(name => ({ metadata: { name } }))),
    listSecrets: vi.fn(async () => [...secrets.values()]),
    getSecret: vi.fn(async (name: string) => secrets.get(name) ?? null),
    createSecret: vi.fn(async (body: MockWrite) => {
      secrets.set(body.name, { metadata: { name: body.name, labels: body.labels ?? {} } })
      return writeSummary(body)
    }),
    updateSecret: vi.fn(async (body: MockWrite) => {
      const existing = secrets.get(body.name)
      secrets.set(body.name, {
        ...(existing ?? {}),
        metadata: { name: body.name, labels: body.labels ?? existing?.metadata?.labels ?? {} },
      })
      return writeSummary(body)
    }),
    deleteSecret: vi.fn(async (name: string, namespace?: string) => {
      secrets.delete(name)
      return { name, namespace: namespace || 'default', deleted: true as const }
    }),
  }
}

function makeApp(gateway: ReturnType<typeof createGateway>) {
  const app = express()
  app.use(express.json())
  app.use(createAdminSecretsRouter(gateway as never))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

describe('POST /admin/recipe-secrets — ownership', () => {
  it('rejects 400 when ownership is missing', async () => {
    const app = makeApp(createGateway())
    const res = await request(app)
      .post('/admin/recipe-secrets')
      .send({ name: 'k', data: { a: 'b' } })
      .expect(400)
    expect(res.body.error).toMatch(/ownership is required/)
  })

  it('rejects 400 when ownership.kind is unknown', async () => {
    const app = makeApp(createGateway())
    const res = await request(app)
      .post('/admin/recipe-secrets')
      .send({ name: 'k', data: { a: 'b' }, ownership: { kind: 'world-readable' } })
      .expect(400)
    expect(res.body.error).toMatch(/ownership.kind must be/)
  })

  it('rejects 400 when ownership.recipeName is missing for owner-recipe', async () => {
    const app = makeApp(createGateway({ recipes: ['recipe-a'] }))
    const res = await request(app)
      .post('/admin/recipe-secrets')
      .send({ name: 'k', data: { a: 'b' }, ownership: { kind: 'owner-recipe' } })
      .expect(400)
    expect(res.body.error).toMatch(/ownership.recipeName is required/)
  })

  it('rejects 400 when owner-recipe references a recipe that does not exist', async () => {
    const app = makeApp(createGateway({ recipes: ['recipe-a'] }))
    const res = await request(app)
      .post('/admin/recipe-secrets')
      .send({
        name: 'k',
        data: { a: 'b' },
        ownership: { kind: 'owner-recipe', recipeName: 'recipe-ghost' },
      })
      .expect(400)
    expect(res.body.error).toMatch(/does not match any WorkflowRecipe/)
  })

  it('stores shared=true label when kind=shared', async () => {
    const gateway = createGateway()
    const res = await request(app(gateway))
      .post('/admin/recipe-secrets')
      .send({
        name: 'shared-anthropic',
        data: { 'api-key': 'sk-...' },
        ownership: { kind: 'shared' },
      })
      .expect(201)
    expect(res.body.ownership).toEqual({ kind: 'shared' })
    const arg = gateway.createSecret.mock.calls[0][0] as { labels: Record<string, string> }
    expect(arg.labels['clerum.io/shared']).toBe('true')
    expect(arg.labels['clerum.io/owner-recipe']).toBeUndefined()
    expect(arg.labels['clerum.io/recipe-secret']).toBe('true')
  })

  it('stores owner-recipe=<name> label when kind=owner-recipe and recipe exists', async () => {
    const gateway = createGateway({ recipes: ['recipe-a', 'recipe-b'] })
    const res = await request(app(gateway))
      .post('/admin/recipe-secrets')
      .send({
        name: 'sales-crm-app',
        data: { 'pg-password': 'pw' },
        ownership: { kind: 'owner-recipe', recipeName: 'recipe-a' },
      })
      .expect(201)
    expect(res.body.ownership).toEqual({ kind: 'owner-recipe', recipeName: 'recipe-a' })
    const arg = gateway.createSecret.mock.calls[0][0] as { labels: Record<string, string> }
    expect(arg.labels['clerum.io/owner-recipe']).toBe('recipe-a')
    expect(arg.labels['clerum.io/shared']).toBeUndefined()
  })
})

describe('GET /admin/recipe-secrets — surfaces ownership', () => {
  it('classifies each secret as shared, owner-recipe, or unlabeled', async () => {
    const gateway = createGateway({
      secrets: [
        {
          metadata: {
            name: 'sh',
            labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
          },
          keys: ['x'],
        },
        {
          metadata: {
            name: 'ow',
            labels: {
              'clerum.io/recipe-secret': 'true',
              'clerum.io/owner-recipe': 'recipe-a',
            },
          },
          keys: ['y'],
        },
        {
          metadata: { name: 'legacy', labels: { 'clerum.io/recipe-secret': 'true' } },
          keys: ['z'],
        },
      ],
    })
    const res = await request(app(gateway)).get('/admin/recipe-secrets').expect(200)
    const byName = Object.fromEntries(
      (res.body.items as Array<{ name: string; ownership: unknown }>).map(i => [
        i.name,
        i.ownership,
      ])
    )
    expect(byName.sh).toEqual({ kind: 'shared' })
    expect(byName.ow).toEqual({ kind: 'owner-recipe', recipeName: 'recipe-a' })
    expect(byName.legacy).toEqual({ kind: 'unlabeled' })
  })

  it('treats conflicting labels (both shared and owner) as unlabeled', async () => {
    const gateway = createGateway({
      secrets: [
        {
          metadata: {
            name: 'conflict',
            labels: {
              'clerum.io/recipe-secret': 'true',
              'clerum.io/shared': 'true',
              'clerum.io/owner-recipe': 'recipe-a',
            },
          },
          keys: ['x'],
        },
      ],
    })
    const res = await request(app(gateway)).get('/admin/recipe-secrets').expect(200)
    expect(res.body.items[0].ownership).toEqual({ kind: 'unlabeled' })
  })
})

describe('PUT /admin/recipe-secrets — preserves ownership', () => {
  it('keeps existing owner-recipe label after a data update', async () => {
    const gateway = createGateway({
      secrets: [
        {
          metadata: {
            name: 'sales-crm-app',
            labels: {
              'clerum.io/recipe-secret': 'true',
              'clerum.io/owner-recipe': 'recipe-a',
            },
          },
          data: { 'pg-password': Buffer.from('old', 'utf8').toString('base64') },
        },
      ],
    })
    await request(app(gateway))
      .put('/admin/recipe-secrets')
      .send({ name: 'sales-crm-app', data: { 'pg-password': 'new' } })
      .expect(200)
    const arg = gateway.updateSecret.mock.calls[0][0] as { labels: Record<string, string> }
    expect(arg.labels['clerum.io/owner-recipe']).toBe('recipe-a')
    expect(arg.labels['clerum.io/shared']).toBeUndefined()
  })

  it('keeps existing shared label after a data update', async () => {
    const gateway = createGateway({
      secrets: [
        {
          metadata: {
            name: 'shared-anthropic',
            labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
          },
          data: { 'api-key': Buffer.from('old', 'utf8').toString('base64') },
        },
      ],
    })
    await request(app(gateway))
      .put('/admin/recipe-secrets')
      .send({ name: 'shared-anthropic', data: { 'api-key': 'new' } })
      .expect(200)
    const arg = gateway.updateSecret.mock.calls[0][0] as { labels: Record<string, string> }
    expect(arg.labels['clerum.io/shared']).toBe('true')
    expect(arg.labels['clerum.io/owner-recipe']).toBeUndefined()
  })
})

// Small helper since makeApp is invoked many times.
function app(gateway: ReturnType<typeof createGateway>) {
  return makeApp(gateway)
}
