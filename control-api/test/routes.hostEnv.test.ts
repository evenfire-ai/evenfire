import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createAdminHostEnvRouter } from '../src/routes/admin/hostEnv.js'
import { HostEnvService, HostEnvServiceError } from '../src/services/hostEnvService.js'

/**
 * In-memory CoreV1Api fake. Reproduces just enough of @kubernetes/client-node
 * to drive HostEnvService without spinning up a real cluster.
 */
function createFakeCoreApi() {
  const cms: Record<string, { metadata: { name: string; resourceVersion: string }; data?: Record<string, string> }> = {}
  const secrets: Record<string, { metadata: { name: string; resourceVersion: string }; data?: Record<string, string> }> = {}

  return {
    state: { cms, secrets },
    readNamespacedConfigMap: vi.fn(async (req: { name: string }) => {
      const cm = cms[req.name]
      if (!cm) throw { code: 404 }
      return cm
    }),
    createNamespacedConfigMap: vi.fn(
      async (req: { body: { metadata: { name: string }; data?: Record<string, string> } }) => {
        const name = req.body.metadata.name
        if (cms[name]) throw { code: 409 }
        cms[name] = { metadata: { name, resourceVersion: '1' }, data: req.body.data }
        return cms[name]
      }
    ),
    replaceNamespacedConfigMap: vi.fn(
      async (req: {
        name: string
        body: { metadata: { name: string }; data?: Record<string, string> }
      }) => {
        const cur = cms[req.name]
        if (!cur) throw { code: 404 }
        cms[req.name] = {
          metadata: { name: req.name, resourceVersion: String(Number(cur.metadata.resourceVersion) + 1) },
          data: req.body.data,
        }
        return cms[req.name]
      }
    ),
    readNamespacedSecret: vi.fn(async (req: { name: string }) => {
      const sec = secrets[req.name]
      if (!sec) throw { code: 404 }
      return sec
    }),
    createNamespacedSecret: vi.fn(
      async (req: {
        body: { metadata: { name: string }; stringData?: Record<string, string>; data?: Record<string, string> }
      }) => {
        const name = req.body.metadata.name
        if (secrets[name]) throw { code: 409 }
        // Server-side base64 encoding mirror — store base64 under .data, like real K8s.
        const encoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.body.stringData ?? {})) {
          encoded[k] = Buffer.from(v, 'utf-8').toString('base64')
        }
        for (const [k, v] of Object.entries(req.body.data ?? {})) encoded[k] = v
        secrets[name] = { metadata: { name, resourceVersion: '1' }, data: encoded }
        return secrets[name]
      }
    ),
    replaceNamespacedSecret: vi.fn(
      async (req: {
        name: string
        body: { metadata: { name: string }; stringData?: Record<string, string>; data?: Record<string, string> }
      }) => {
        const cur = secrets[req.name]
        if (!cur) throw { code: 404 }
        const encoded: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.body.stringData ?? {})) {
          encoded[k] = Buffer.from(v, 'utf-8').toString('base64')
        }
        for (const [k, v] of Object.entries(req.body.data ?? {})) encoded[k] = v
        secrets[req.name] = {
          metadata: { name: req.name, resourceVersion: String(Number(cur.metadata.resourceVersion) + 1) },
          data: encoded,
        }
        return secrets[req.name]
      }
    ),
  }
}

function buildApp() {
  const fake = createFakeCoreApi()
  const service = new HostEnvService(fake as unknown as Parameters<typeof HostEnvService>[0], 'mcp-host')
  const gateway = { hostEnv: () => service } as never
  const app = express()
  app.use(express.json())
  app.use(createAdminHostEnvRouter(gateway))
  return { app, fake, service }
}

describe('routes/hostEnv', () => {
  it('GET returns 200 with empty list when no resources exist', async () => {
    const { app } = buildApp()
    const res = await request(app).get('/admin/hosts/trader/env').expect(200)
    expect(res.body).toEqual({ items: [] })
  })

  it('PUT creates non-secret env var via ConfigMap', async () => {
    const { app, fake } = buildApp()
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'FEATURE_FLAG', value: 'on', secret: false }])
      .expect(200)
    expect(res.body.keys).toEqual([
      expect.objectContaining({ key: 'FEATURE_FLAG', secret: false }),
    ])
    expect(res.body.showOnce).toEqual({})
    expect(fake.state.cms['host-trader-env']).toBeDefined()
    expect(fake.state.secrets['host-trader-env-secret']).toBeDefined() // upsert creates both even if empty
  })

  it('PUT creates secret env var via Secret with show-once response', async () => {
    const { app, fake } = buildApp()
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'GITHUB_TOKEN', value: 'ghp_secret_value_xyz', secret: true }])
      .expect(200)
    expect(res.body.keys.find((k: { key: string }) => k.key === 'GITHUB_TOKEN').secret).toBe(true)
    expect(res.body.showOnce.GITHUB_TOKEN).toBe('ghp_secret_value_xyz')
    // Stored as base64
    const stored = fake.state.secrets['host-trader-env-secret'].data!.GITHUB_TOKEN
    expect(Buffer.from(stored, 'base64').toString('utf-8')).toBe('ghp_secret_value_xyz')
  })

  it('GET never returns secret values', async () => {
    const { app } = buildApp()
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'GITHUB_TOKEN', value: 'ghp_xyz', secret: true }])
    const res = await request(app).get('/admin/hosts/trader/env').expect(200)
    const txt = JSON.stringify(res.body)
    expect(txt).not.toContain('ghp_xyz')
    expect(res.body.items[0]).toMatchObject({ key: 'GITHUB_TOKEN', secret: true })
    expect(res.body.items[0]).not.toHaveProperty('value')
  })

  it('rejects reserved provider-key names with helpful 400', async () => {
    const { app } = buildApp()
    for (const key of ['OPENAI_API_KEY', 'ZAI_API_KEY', 'CLAUDE_API_KEY', 'BAILIAN_API_KEY']) {
      const res = await request(app)
        .put('/admin/hosts/trader/env')
        .send([{ key, value: 'sk-anything', secret: true }])
        .expect(400)
      expect(res.body.error).toContain('reserved LLM provider-key name')
      expect(res.body.hint).toContain('LLM Secrets')
    }
  })

  it('rejects CLERUM_-prefixed keys with helpful 400', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'CLERUM_FOO', value: 'x', secret: false }])
      .expect(400)
    expect(res.body.error).toContain('reserved CLERUM_* prefix')
    expect(res.body.hint).toContain('infrastructure')
  })

  it('rejects keys that do not match [A-Z][A-Z0-9_]*', async () => {
    const { app } = buildApp()
    for (const key of ['lower_case', '1STARTS_DIGIT', 'HAS-DASH', 'has space']) {
      await request(app)
        .put('/admin/hosts/trader/env')
        .send([{ key, value: 'v', secret: false }])
        .expect(400)
    }
  })

  it('rejects oversized values', async () => {
    const { app } = buildApp()
    const big = 'x'.repeat(9 * 1024)
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'BIG', value: big, secret: false }])
      .expect(400)
    expect(res.body.error).toContain('exceeds')
  })

  it('rejects same key as both secret and non-secret across calls', async () => {
    const { app } = buildApp()
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'KEY1', value: 'v1', secret: false }])
      .expect(200)
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'KEY1', value: 'v2', secret: true }])
      .expect(400)
    expect(res.body.error).toContain('already exists as a non-secret')
  })

  it('upsert preserves untouched keys', async () => {
    const { app } = buildApp()
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([
        { key: 'A', value: '1', secret: false },
        { key: 'B', value: '2', secret: false },
      ])
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'A', value: '11', secret: false }]) // only update A
    const res = await request(app).get('/admin/hosts/trader/env').expect(200)
    const keys = res.body.items.map((i: { key: string }) => i.key).sort()
    expect(keys).toEqual(['A', 'B'])
  })

  it('DELETE removes a key from CM or Secret', async () => {
    const { app } = buildApp()
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([
        { key: 'NON_SECRET', value: 'v', secret: false },
        { key: 'SECRET_KEY', value: 'sek', secret: true },
      ])
    await request(app).delete('/admin/hosts/trader/env/NON_SECRET').expect(204)
    await request(app).delete('/admin/hosts/trader/env/SECRET_KEY').expect(204)
    const res = await request(app).get('/admin/hosts/trader/env').expect(200)
    expect(res.body.items).toEqual([])
  })

  it('DELETE returns 404 when key absent', async () => {
    const { app } = buildApp()
    await request(app).delete('/admin/hosts/trader/env/MISSING').expect(404)
  })

  it('rejects invalid hostRef', async () => {
    const { app } = buildApp()
    await request(app).get('/admin/hosts/INVALID_HOST/env').expect(400)
    await request(app).put('/admin/hosts/UPPER/env').send([]).expect(400)
  })

  it('show-once is populated only for newly-set secrets, not existing ones', async () => {
    const { app } = buildApp()
    await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'TOK', value: 'v1', secret: true }])
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([{ key: 'OTHER_TOK', value: 'v2', secret: true }])
    expect(res.body.showOnce).toEqual({ OTHER_TOK: 'v2' })
    expect(res.body.showOnce.TOK).toBeUndefined()
  })

  it('rejects duplicate keys within the body', async () => {
    const { app } = buildApp()
    const res = await request(app)
      .put('/admin/hosts/trader/env')
      .send([
        { key: 'X', value: '1', secret: false },
        { key: 'X', value: '2', secret: false },
      ])
      .expect(400)
    expect(res.body.error).toContain('Duplicate key')
  })

  it('HostEnvServiceError surfaces 400/404 cleanly through router', async () => {
    expect(new HostEnvServiceError(400, 'bad').status).toBe(400)
    expect(new HostEnvServiceError(404, 'not found').status).toBe(404)
  })
})
