import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

function createGateway() {
  return {
    listSecrets: vi.fn(async () => [
      { metadata: { name: 's1', namespace: 'ns1', labels: { 'clerum.io/host-secret': 'true' } } },
      { metadata: { name: 's2', namespace: 'ns1', labels: {} } },
      { metadata: { name: 's3', namespace: 'ns1', labels: { 'clerum.io/host-secret': 'false' } } },
    ]),
    createSecret: vi.fn(async (body: unknown) => body),
    updateSecret: vi.fn(async (body: unknown) => body),
    deleteSecret: vi.fn(async (name: string, namespace?: string) => ({
      deleted: true,
      name,
      namespace: namespace || 'default',
    })),
  }
}

describe('routes/secrets', () => {
  it('supports list/create/update/delete (positive flow)', async () => {
    const gateway = createGateway()
    const app = express()
    app.use(express.json())
    app.use(createAdminSecretsRouter(gateway as never))

    const filtered = await request(app).get('/admin/secrets').expect(200)
    expect(filtered.body.items).toHaveLength(1)
    expect(filtered.body.items[0].name).toBe('s1')
    const filteredNames = (filtered.body.items || []).map((item: { name?: string }) => item.name)
    expect(filteredNames).not.toContain('s2')
    expect(filteredNames).not.toContain('s3')
    expect(
      (filtered.body.items || []).every(
        (item: { name?: string }) => typeof item.name === 'string' && item.name.length > 0
      )
    ).toBe(true)
    await request(app)
      .post('/admin/secrets')
      .send({ name: 'new-secret', namespace: 'ns1', stringData: { token: 'abc' } })
      .expect(201)
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'new-secret', namespace: 'ns1', stringData: { token: 'def' } })
      .expect(200)
    await request(app).delete('/admin/secrets/new-secret').expect(200)

    expect(gateway.createSecret).toHaveBeenCalled()
    expect(gateway.updateSecret).toHaveBeenCalled()
    expect(gateway.deleteSecret).toHaveBeenCalledWith('new-secret', 'mcp-host')
  })

  it('returns 500 when gateway fails (edge case)', async () => {
    const gateway = createGateway()
    gateway.createSecret.mockImplementation(async () => {
      throw new Error('invalid secret payload')
    })

    const app = express()
    app.use(express.json())
    app.use(createAdminSecretsRouter(gateway as never))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )

    const res = await request(app).post('/admin/secrets').send({}).expect(500)
    expect(res.body.error).toContain('invalid secret payload')
  })

  describe('recipe-secrets', () => {
    const labelledSecrets: Record<
      string,
      { labels: Record<string, string>; data: Record<string, string> }
    > = {
      r1: {
        labels: { 'clerum.io/recipe-secret': 'true' },
        // base64 of "old-api" and "postgres://old"
        data: { API_KEY: 'b2xkLWFwaQ==', DB_URL: 'cG9zdGdyZXM6Ly9vbGQ=' },
      },
      'coord-token': { labels: {}, data: {} },
      other: { labels: { 'clerum.io/recipe-secret': 'false' }, data: {} },
    }

    function createRecipeGateway() {
      return {
        listSecrets: vi.fn(async (namespace?: string) =>
          namespace === 'sandbox-recipes'
            ? [
                {
                  metadata: {
                    name: 'r1',
                    namespace: 'sandbox-recipes',
                    labels: { 'clerum.io/recipe-secret': 'true' },
                  },
                  keys: ['API_KEY', 'DB_URL'],
                },
                {
                  metadata: { name: 'coord-token', namespace: 'sandbox-recipes', labels: {} },
                  keys: [],
                },
                {
                  metadata: {
                    name: 'other',
                    namespace: 'sandbox-recipes',
                    labels: { 'clerum.io/recipe-secret': 'false' },
                  },
                  keys: [],
                },
              ]
            : []
        ),
        getSecret: vi.fn(async (name: string) => {
          if (!(name in labelledSecrets)) throw new Error('not found')
          const entry = labelledSecrets[name]
          return {
            metadata: { name, namespace: 'sandbox-recipes', labels: entry.labels },
            data: entry.data,
          }
        }),
        createSecret: vi.fn(async (body: unknown) => body),
        updateSecret: vi.fn(async (body: unknown) => body),
        deleteSecret: vi.fn(async (name: string, namespace?: string) => ({
          deleted: true,
          name,
          namespace: namespace || 'default',
        })),
      }
    }

    it('lists only label-tagged recipe secrets with keys', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app).get('/admin/recipe-secrets').expect(200)
      expect(res.body.items).toHaveLength(1)
      // r1's fixture has the recipe-secret label but no ownership label — the
      // route classifies that as `unlabeled` (the degenerate case WRC refuses
      // to project until an operator adds shared/owner-recipe).
      expect(res.body.items[0]).toEqual({
        name: 'r1',
        namespace: 'sandbox-recipes',
        keys: ['API_KEY', 'DB_URL'],
        ownership: { kind: 'unlabeled' },
      })
    })

    it('keeps recipe secret listing available when an auxiliary runtime namespace is unavailable', async () => {
      const gateway = createRecipeGateway()
      gateway.listSecrets.mockImplementation(async (namespace?: string) => {
        if (namespace === 'sandbox-ui') {
          const err = new Error('forbidden') as Error & { statusCode?: number }
          err.statusCode = 403
          throw err
        }
        return namespace === 'sandbox-recipes'
          ? [
              {
                metadata: {
                  name: 'r1',
                  namespace: 'sandbox-recipes',
                  labels: { 'clerum.io/recipe-secret': 'true' },
                },
                keys: ['API_KEY', 'DB_URL'],
              },
            ]
          : []
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app).get('/admin/recipe-secrets').expect(200)

      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0]).toMatchObject({ name: 'r1', namespace: 'sandbox-recipes' })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"recipe-secret-namespace-list-degraded"')
      )
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"namespace":"sandbox-ui"'))
      warnSpy.mockRestore()
    })

    it('fails fast when sandbox-recipes recipe secret listing is unavailable', async () => {
      const gateway = createRecipeGateway()
      gateway.listSecrets.mockImplementation(async (namespace?: string) => {
        if (namespace === 'sandbox-recipes') {
          const err = new Error('sandbox-recipes unavailable') as Error & { statusCode?: number }
          err.statusCode = 500
          throw err
        }
        return []
      })
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))
      app.use(
        (
          err: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction
        ) => {
          res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
        }
      )

      const res = await request(app).get('/admin/recipe-secrets').expect(500)

      expect(res.body.error).toContain('sandbox-recipes unavailable')
    })

    it('creates a recipe secret in sandbox-recipes with the recipe-secret label', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .post('/admin/recipe-secrets')
        .send({
          name: 'my-recipe',
          data: { TOKEN: 'abc' },
          ownership: { kind: 'shared' },
        })
        .expect(201)
      expect(res.body).toMatchObject({
        name: 'my-recipe',
        namespace: 'sandbox-recipes',
        ownership: { kind: 'shared' },
        created: true,
      })
      expect(gateway.createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-recipe',
          namespace: 'sandbox-recipes',
          type: 'Opaque',
          labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
          stringData: { TOKEN: 'abc' },
        })
      )
    })

    it('creates a recipe secret in an allowed runtime namespace', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .post('/admin/recipe-secrets')
        .send({
          name: 'transport-creds',
          targetNamespace: 'mcp-server',
          data: { TOKEN: 'abc' },
          ownership: { kind: 'shared' },
        })
        .expect(201)

      expect(res.body.namespace).toBe('mcp-server')
      expect(gateway.createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'transport-creds',
          namespace: 'mcp-server',
          labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
        })
      )
    })

    it('rejects recipe secret creation outside the workflow secret namespace allowlist', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .post('/admin/recipe-secrets')
        .send({
          name: 'bad-target',
          targetNamespace: 'kube-system',
          data: { TOKEN: 'abc' },
          ownership: { kind: 'shared' },
        })
        .expect(400)

      expect(res.body.error).toContain('targetNamespace must be one of')
      expect(gateway.createSecret).not.toHaveBeenCalled()
    })

    it('rejects invalid recipe secret name', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .post('/admin/recipe-secrets')
        .send({ name: 'BadName!', data: { K: 'v' } })
        .expect(400)
      expect(res.body.error).toContain('Invalid secret name')
      expect(gateway.createSecret).not.toHaveBeenCalled()
    })

    it('rejects recipe secret with empty data', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .post('/admin/recipe-secrets')
        .send({ name: 'ok-name', data: {} })
        .expect(400)
      expect(res.body.error).toContain('data is required')
      expect(gateway.createSecret).not.toHaveBeenCalled()
    })

    it('PUT merges new values with existing keys (single-key update preserves untouched keys)', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'r1', data: { API_KEY: 'new-api' } })
        .expect(200)

      const call = (gateway.updateSecret as any).mock.calls[0][0]
      expect(call).toMatchObject({
        name: 'r1',
        namespace: 'sandbox-recipes',
        labels: { 'clerum.io/recipe-secret': 'true' },
      })
      // API_KEY overwritten with base64("new-api"); DB_URL preserved unchanged.
      expect(call.data.API_KEY).toBe(Buffer.from('new-api', 'utf8').toString('base64'))
      expect(call.data.DB_URL).toBe('cG9zdGdyZXM6Ly9vbGQ=')
      expect(call.stringData).toBeUndefined()
    })

    it('PUT updates a recipe secret in an allowed runtime namespace', async () => {
      const gateway = createRecipeGateway()
      gateway.getSecret.mockImplementation(async (name: string, namespace?: string) => {
        if (name === 'ui-creds' && namespace === 'sandbox-ui') {
          return {
            metadata: {
              name,
              namespace,
              labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
            },
            data: {},
          }
        }
        throw new Error('not found')
      })
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'ui-creds', targetNamespace: 'sandbox-ui', data: { K: 'new-api' } })
        .expect(200)

      expect(gateway.updateSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ui-creds',
          namespace: 'sandbox-ui',
          labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
        })
      )
    })

    it('rejects recipe secret update outside the workflow secret namespace allowlist', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'r1', targetNamespace: 'kube-system', data: { K: 'new-api' } })
        .expect(400)

      expect(res.body.error).toContain('targetNamespace must be one of')
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it('PUT drops keys listed in removeKeys', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'r1', removeKeys: ['DB_URL'] })
        .expect(200)

      const call = (gateway.updateSecret as any).mock.calls[0][0]
      expect(Object.keys(call.data)).toEqual(['API_KEY'])
      expect(call.data.API_KEY).toBe('b2xkLWFwaQ==')
    })

    it('PUT rejects an update that would leave the secret with zero keys', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'r1', removeKeys: ['API_KEY', 'DB_URL'] })
        .expect(400)
      expect(res.body.error).toContain('at least one key')
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it('PUT rejects an empty payload (no data, no removeKeys)', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app).put('/admin/recipe-secrets').send({ name: 'r1' }).expect(400)
      expect(res.body.error).toContain('data or removeKeys')
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it('deletes a recipe secret from sandbox-recipes', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app).delete('/admin/recipe-secrets/r1').expect(200)
      expect(gateway.deleteSecret).toHaveBeenCalledWith('r1', 'sandbox-recipes')
    })

    it('deletes a recipe secret from an allowed runtime namespace', async () => {
      const gateway = createRecipeGateway()
      gateway.getSecret.mockImplementation(async (name: string, namespace?: string) => {
        if (name === 'ui-creds' && namespace === 'sandbox-ui') {
          return {
            metadata: {
              name,
              namespace,
              labels: { 'clerum.io/recipe-secret': 'true', 'clerum.io/shared': 'true' },
            },
            data: {},
          }
        }
        throw new Error('not found')
      })
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .delete('/admin/recipe-secrets/ui-creds?targetNamespace=sandbox-ui')
        .expect(200)
      expect(gateway.deleteSecret).toHaveBeenCalledWith('ui-creds', 'sandbox-ui')
    })

    it('rejects recipe secret delete outside the workflow secret namespace allowlist', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .delete('/admin/recipe-secrets/r1?targetNamespace=kube-system')
        .expect(400)

      expect(res.body.error).toContain('targetNamespace must be one of')
      expect(gateway.deleteSecret).not.toHaveBeenCalled()
    })

    it('refuses to PUT a sandbox-recipes Secret that lacks the recipe-secret label', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'coord-token', data: { TOKEN: 'stolen' } })
        .expect(404)
      expect(res.body.error).toContain('Recipe secret not found')
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it('refuses to PUT a secret with the wrong label value', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'other', data: { TOKEN: 'x' } })
        .expect(404)
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it("refuses to PUT a secret that doesn't exist", async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app)
        .put('/admin/recipe-secrets')
        .send({ name: 'ghost', data: { TOKEN: 'x' } })
        .expect(404)
      expect(gateway.updateSecret).not.toHaveBeenCalled()
    })

    it('refuses to DELETE a sandbox-recipes Secret that lacks the recipe-secret label', async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app).delete('/admin/recipe-secrets/coord-token').expect(404)
      expect(res.body.error).toContain('Recipe secret not found')
      expect(gateway.deleteSecret).not.toHaveBeenCalled()
    })

    it("refuses to DELETE a secret that doesn't exist", async () => {
      const gateway = createRecipeGateway()
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      await request(app).delete('/admin/recipe-secrets/ghost').expect(404)
      expect(gateway.deleteSecret).not.toHaveBeenCalled()
    })
  })

  it('silently ignores ?namespace= query parameter and uses config namespace', async () => {
    const gateway = createGateway()
    const app = express()
    app.use(express.json())
    app.use(createAdminSecretsRouter(gateway as never))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Namespace in query string is silently ignored — requests succeed (200, not 400)
    await request(app).get('/admin/secrets?namespace=evil').expect(200)
    await request(app).delete('/admin/secrets/s1?namespace=evil').expect(200)

    // Gateway WAS called despite namespace in query (it's silently ignored)
    expect(gateway.listSecrets).toHaveBeenCalled()
    expect(gateway.deleteSecret).toHaveBeenCalled()

    // Security audit was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"alert":"SECURITY"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"vector":"query-param"'))

    warnSpy.mockRestore()
  })
})
