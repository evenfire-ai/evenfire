import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { rootLogger } from '../src/observability/logger.js'
import { createAdminSecretsRouter } from '../src/routes/admin/secrets.js'

function writeSummary(body: unknown) {
  const write = body as {
    name: string
    namespace?: string
    data?: Record<string, string>
    stringData?: Record<string, string>
  }
  return {
    name: write.name,
    namespace: write.namespace || 'default',
    keys: [
      ...new Set([...Object.keys(write.data ?? {}), ...Object.keys(write.stringData ?? {})]),
    ].sort((a, b) => a.localeCompare(b)),
  }
}

function createGateway() {
  return {
    listSecrets: vi.fn(async () => [
      {
        metadata: { name: 's1', namespace: 'ns1', labels: { 'clerum.io/host-secret': 'true' } },
        keys: ['openai-api-key'],
      },
      { metadata: { name: 's2', namespace: 'ns1', labels: {} } },
      { metadata: { name: 's3', namespace: 'ns1', labels: { 'clerum.io/host-secret': 'false' } } },
    ]),
    getSecret: vi.fn(async (_name: string, _namespace?: string): Promise<unknown> => {
      throw new Error('not found')
    }),
    createSecret: vi.fn(async (body: unknown) => writeSummary(body)),
    updateSecret: vi.fn(async (body: unknown) => writeSummary(body)),
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
    // Producer-backed contract consumed by control-ui listLlmHostSecrets/SecretsTable.
    // Secret values and Kubernetes metadata must never cross this boundary.
    expect(filtered.body).toEqual({
      items: [{ name: 's1', keys: ['openai-api-key'] }],
    })
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
            metadata: {
              name,
              namespace: 'sandbox-recipes',
              uid: `uid-${name}`,
              resourceVersion: '1',
              labels: entry.labels,
            },
            data: entry.data,
          }
        }),
        createSecret: vi.fn(async (body: unknown) => {
          const summary = writeSummary(body)
          return { ...summary, uid: `uid-${summary.name}`, resourceVersion: '1' }
        }),
        updateSecret: vi.fn(async (body: unknown) => writeSummary(body)),
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
      const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => {})
      const app = express()
      app.use(express.json())
      app.use(createAdminSecretsRouter(gateway as never))

      const res = await request(app).get('/admin/recipe-secrets').expect(200)

      expect(res.body.items).toHaveLength(1)
      expect(res.body.items[0]).toMatchObject({ name: 'r1', namespace: 'sandbox-recipes' })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'recipe-secret-namespace-list-degraded',
          namespace: 'sandbox-ui',
        }),
        'Recipe Secret namespace listing degraded'
      )
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
              uid: `uid-${name}`,
              resourceVersion: '1',
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
        }),
        { uid: 'uid-ui-creds', resourceVersion: '1' }
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

      await request(app)
        .delete('/admin/recipe-secrets/r1')
        .send({ uid: 'uid-r1', resourceVersion: '1' })
        .expect(200)
      expect(gateway.deleteSecret).toHaveBeenCalledWith('r1', 'sandbox-recipes', {
        uid: 'uid-r1',
        resourceVersion: '1',
      })
    })

    it('deletes a recipe secret from an allowed runtime namespace', async () => {
      const gateway = createRecipeGateway()
      gateway.getSecret.mockImplementation(async (name: string, namespace?: string) => {
        if (name === 'ui-creds' && namespace === 'sandbox-ui') {
          return {
            metadata: {
              name,
              namespace,
              uid: `uid-${name}`,
              resourceVersion: '1',
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
        .send({ uid: 'uid-ui-creds', resourceVersion: '1' })
        .expect(200)
      expect(gateway.deleteSecret).toHaveBeenCalledWith('ui-creds', 'sandbox-ui', {
        uid: 'uid-ui-creds',
        resourceVersion: '1',
      })
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

// Slot-aware LLM credential validation (spec R4.5.3 / §6 control-api row).
describe('routes/secrets — LLM slot-aware validation', () => {
  function makeApp() {
    const gateway = createGateway()
    const app = express()
    app.use(express.json())
    app.use(createAdminSecretsRouter(gateway as never))
    return { app, gateway }
  }

  const validVertexJson = JSON.stringify({
    type: 'service_account',
    client_email: 'sa@project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  })

  it('rejects a partial Bedrock pair (only access-key-id) with 400', async () => {
    const { app, gateway } = makeApp()
    const res = await request(app)
      .post('/admin/secrets')
      .send({ name: 'chatllm-api-keys', stringData: { 'aws-access-key-id': 'AKIA...' } })
      .expect(400)
    expect(res.body.error).toMatch(/Bedrock/i)
    expect(res.body.error).toMatch(/aws-secret-access-key/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects a partial Bedrock pair on update (PUT) with 400', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'chatllm-api-keys', stringData: { 'aws-secret-access-key': 'secret' } })
      .expect(400)
    expect(gateway.updateSecret).not.toHaveBeenCalled()
  })

  it('accepts the complete Bedrock pair written together', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        stringData: { 'aws-access-key-id': 'AKIA...', 'aws-secret-access-key': 'secret' },
      })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  it('rejects a malformed Vertex service-account JSON with 400', async () => {
    const { app, gateway } = makeApp()
    const res = await request(app)
      .post('/admin/secrets')
      .send({ name: 'chatllm-api-keys', stringData: { 'vertex-service-account-json': 'not-json' } })
      .expect(400)
    expect(res.body.error).toMatch(/vertex-service-account-json/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('rejects a Vertex JSON missing client_email / private_key with 400', async () => {
    const { app, gateway } = makeApp()
    const res = await request(app)
      .post('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        stringData: { 'vertex-service-account-json': JSON.stringify({ type: 'service_account' }) },
      })
      .expect(400)
    expect(res.body.error).toMatch(/client_email/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('accepts a well-formed Vertex service-account JSON', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        stringData: { 'vertex-service-account-json': validVertexJson },
      })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  it('also validates base64 `data` payloads (Vertex JSON)', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        data: { 'vertex-service-account-json': Buffer.from('not-json').toString('base64') },
      })
      .expect(400)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('leaves the generic (non-LLM) secret contract untouched', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({ name: 'generic', stringData: { token: 'abc', 'some-key': 'v' } })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  it('accepts a single-key provider (openai) unchanged', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({ name: 'chatllm-api-keys', stringData: { 'openai-api-key': 'sk-...' } })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  // FIX 3: the slot-aware rule is scoped to the known LLM Secret name(s). A
  // generic Secret carrying a lone `aws-access-key-id` (e.g. a plain AWS
  // credential Secret) must NOT trip the bedrock paired-slot rule.
  it('does not apply the bedrock pair rule to a non-LLM secret with a lone aws-access-key-id', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({ name: 'my-aws-creds', stringData: { 'aws-access-key-id': 'AKIA...' } })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  // Topic 1b: the gate now also fires on the host-secret LABEL, so a per-host
  // NAMED Secret (not `chatllm-api-keys`) is validated too — it can no longer
  // bypass the bedrock/vertex contract just by having a different name.
  it('validates a per-host-NAMED labeled secret: half Bedrock pair → 400', async () => {
    const { app, gateway } = makeApp()
    const res = await request(app)
      .post('/admin/secrets')
      .send({
        name: 'host-abc-llm',
        labels: { 'clerum.io/host-secret': 'true' },
        stringData: { 'aws-access-key-id': 'AKIA...' },
      })
      .expect(400)
    expect(res.body.error).toMatch(/Bedrock/i)
    expect(res.body.error).toMatch(/aws-secret-access-key/)
    expect(gateway.createSecret).not.toHaveBeenCalled()
  })

  it('accepts a valid per-host labeled secret (complete Bedrock pair)', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({
        name: 'host-abc-llm',
        labels: { 'clerum.io/host-secret': 'true' },
        stringData: { 'aws-access-key-id': 'AKIA...', 'aws-secret-access-key': 'secret' },
      })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })

  // The label is what arms the gate — a per-host NAME without the label is still
  // a generic Secret (no slot contract), matching the FIX-3 scoping above.
  it('does NOT validate a per-host-named secret that lacks the host-secret label', async () => {
    const { app, gateway } = makeApp()
    await request(app)
      .post('/admin/secrets')
      .send({ name: 'host-abc-llm', stringData: { 'aws-access-key-id': 'AKIA...' } })
      .expect(201)
    expect(gateway.createSecret).toHaveBeenCalled()
  })
})

// FIX 2b: opt-in server-side merge (read-then-replace) for PUT /admin/secrets.
describe('routes/secrets — PUT merge semantics', () => {
  function makeMergeApp(
    existing: { data?: Record<string, string>; labels?: Record<string, string> } | null
  ) {
    const gateway = createGateway()
    gateway.getSecret.mockImplementation(async () => {
      if (existing === null) throw new Error('not found')
      return {
        metadata: {
          name: 'chatllm-api-keys',
          namespace: 'mcp-host',
          labels: existing.labels || {},
        },
        data: existing.data || {},
      }
    })
    const app = express()
    app.use(express.json())
    app.use(createAdminSecretsRouter(gateway as never))
    return { app, gateway }
  }

  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

  it('merge:true preserves keys the caller did not send (other providers survive)', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'openai-api-key': b64('sk-existing'), 'claude-api-key': b64('claude-existing') },
    })
    const res = await request(app)
      .put('/admin/secrets')
      .send({ name: 'chatllm-api-keys', merge: true, stringData: { 'openai-api-key': 'sk-new' } })
      .expect(200)

    const call = (gateway.updateSecret as any).mock.calls[0][0]
    // openai overwritten, claude preserved untouched.
    expect(call.data['openai-api-key']).toBe(b64('sk-new'))
    expect(call.data['claude-api-key']).toBe(b64('claude-existing'))
    expect(call.stringData).toBeUndefined()

    // The response must NEVER echo secret values (names-only R4 contract) —
    // especially not the preserved values of keys the caller did not send.
    expect(res.body).toEqual({
      name: 'chatllm-api-keys',
      namespace: 'mcp-host',
      keys: ['claude-api-key', 'openai-api-key'],
    })
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(b64('claude-existing'))
    expect(serialized).not.toContain(b64('sk-new'))
  })

  it('merge:true validates the EFFECTIVE merge (bedrock pair completed across existing+sent)', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'aws-access-key-id': b64('AKIA-existing') },
    })
    await request(app)
      .put('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        merge: true,
        stringData: { 'aws-secret-access-key': 'secret-new' },
      })
      .expect(200)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    expect(call.data['aws-access-key-id']).toBe(b64('AKIA-existing'))
    expect(call.data['aws-secret-access-key']).toBe(b64('secret-new'))
  })

  it('merge:true still 400s when the pair is incomplete AFTER the merge', async () => {
    const { app, gateway } = makeMergeApp({ data: { 'openai-api-key': b64('sk') } })
    const res = await request(app)
      .put('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        merge: true,
        stringData: { 'aws-access-key-id': 'AKIA...' },
      })
      .expect(400)
    expect(res.body.error).toMatch(/Bedrock/i)
    expect(gateway.updateSecret).not.toHaveBeenCalled()
  })

  it('merge:true skips empty values (blanking is not deletion)', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'openai-api-key': b64('sk-existing'), 'claude-api-key': b64('claude-existing') },
    })
    await request(app)
      .put('/admin/secrets')
      .send({
        name: 'chatllm-api-keys',
        merge: true,
        stringData: { 'openai-api-key': '', 'claude-api-key': 'claude-new' },
      })
      .expect(200)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    // The empty value did not wipe the stored openai key; claude was updated.
    expect(call.data['openai-api-key']).toBe(b64('sk-existing'))
    expect(call.data['claude-api-key']).toBe(b64('claude-new'))
  })

  it('merge:true on a missing secret returns 404', async () => {
    const { app, gateway } = makeMergeApp(null)
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'chatllm-api-keys', merge: true, stringData: { 'openai-api-key': 'sk' } })
      .expect(404)
    expect(gateway.updateSecret).not.toHaveBeenCalled()
  })

  it('without the flag the update stays full-replace (data passed through, not merged)', async () => {
    const { app, gateway } = makeMergeApp({ data: { 'openai-api-key': b64('sk-existing') } })
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'chatllm-api-keys', stringData: { 'claude-api-key': 'claude-new' } })
      .expect(200)
    // Full-replace passes the body through verbatim — it does NOT merge the
    // existing data. (It may do a validation-only label read to arm the slot
    // gate, but the write body carries only the caller's keys.)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    expect(call.stringData).toEqual({ 'claude-api-key': 'claude-new' })
    expect(call.data).toBeUndefined()
  })

  // Closes the full-replace bypass: a per-host labeled LLM Secret written via
  // full-replace WITHOUT echoing labels must still be slot-validated, because
  // updateSecret re-attaches the existing host-secret label. Identity is armed
  // from the EXISTING labels, not the (omitted) body labels.
  it('full-replace of a labeled per-host secret is slot-validated even when body omits labels', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'openai-api-key': b64('sk-existing') },
      labels: { 'clerum.io/host-secret': 'true' },
    })
    const res = await request(app)
      .put('/admin/secrets')
      // per-host NAME (not chatllm-api-keys), no labels in body, half Bedrock pair
      .send({ name: 'host-x-llm', stringData: { 'aws-access-key-id': 'AKIA...' } })
      .expect(400)
    expect(res.body.error).toMatch(/Bedrock/i)
    expect(gateway.updateSecret).not.toHaveBeenCalled()
  })

  // Topic 1b Task 2 — removeKeys: the delete-a-slot half of partial edit, so an
  // operator retiring a provider from the fallback chain can drop that slot.
  it('merge:true removeKeys retires a named slot, preserving the rest (label-armed host secret)', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'openai-api-key': b64('sk'), 'claude-api-key': b64('cl') },
      labels: { 'clerum.io/host-secret': 'true' },
    })
    const res = await request(app)
      .put('/admin/secrets')
      // A per-host NAME (not chatllm-api-keys): identity comes from the label.
      .send({ name: 'host-x-llm', merge: true, removeKeys: ['openai-api-key'] })
      .expect(200)

    const call = (gateway.updateSecret as any).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['claude-api-key'])
    expect(call.data['claude-api-key']).toBe(b64('cl'))
    // Names-only response — never echoes values.
    expect(res.body.keys).toEqual(['claude-api-key'])
    expect(JSON.stringify(res.body)).not.toContain(b64('cl'))
  })

  it('merge:true removeKeys touches only the named keys (does not wipe others)', async () => {
    const { app, gateway } = makeMergeApp({
      data: {
        'openai-api-key': b64('sk'),
        'claude-api-key': b64('cl'),
        'gemini-api-key': b64('g'),
      },
      labels: { 'clerum.io/host-secret': 'true' },
    })
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'host-x-llm', merge: true, removeKeys: ['gemini-api-key'] })
      .expect(200)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    expect(Object.keys(call.data).sort()).toEqual(['claude-api-key', 'openai-api-key'])
  })

  // Contract: the Bedrock pair is atomic on the way OUT too — removing one half
  // retires the whole pair so the Secret never lands in a half-pair state.
  it('merge:true removeKeys of one Bedrock key retires the whole pair', async () => {
    const { app, gateway } = makeMergeApp({
      data: {
        'aws-access-key-id': b64('AKIA'),
        'aws-secret-access-key': b64('sec'),
        'openai-api-key': b64('sk'),
      },
      labels: { 'clerum.io/host-secret': 'true' },
    })
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'host-x-llm', merge: true, removeKeys: ['aws-access-key-id'] })
      .expect(200)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    // Both Bedrock keys gone; openai untouched.
    expect(Object.keys(call.data)).toEqual(['openai-api-key'])
  })

  it('merge:true removeKeys that would empty the secret → 400 (must retain one key)', async () => {
    const { app, gateway } = makeMergeApp({
      data: { 'openai-api-key': b64('sk') },
      labels: { 'clerum.io/host-secret': 'true' },
    })
    const res = await request(app)
      .put('/admin/secrets')
      .send({ name: 'host-x-llm', merge: true, removeKeys: ['openai-api-key'] })
      .expect(400)
    expect(res.body.error).toMatch(/at least one key/)
    expect(gateway.updateSecret).not.toHaveBeenCalled()
  })

  it('merge:true removeKeys works on a generic (non-LLM) secret without slot logic', async () => {
    const { app, gateway } = makeMergeApp({ data: { a: b64('1'), b: b64('2') } })
    await request(app)
      .put('/admin/secrets')
      .send({ name: 'generic', merge: true, removeKeys: ['a'] })
      .expect(200)
    const call = (gateway.updateSecret as any).mock.calls[0][0]
    expect(Object.keys(call.data)).toEqual(['b'])
  })
})
