import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { lookup } from 'node:dns/promises'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

describe('routes/resources', () => {
  it('creates and fetches resources (positive flow)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'mcp-a' },
        spec: { enabled: true },
      })
      .expect(201)

    await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'ctx-a' },
        spec: { contextId: 'ctx-a', mcpServers: ['mcp-a'] },
      })
      .expect(201)

    await request(app)
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a' },
      })
      .expect(201)

    // Hosts list returns hosts in `config.hostsNamespace` (mcp-host).
    const listRes = await request(app).get('/admin/hosts').expect(200)
    expect(listRes.body.items).toHaveLength(1)
    expect(listRes.body.items[0].spec.contextRef).toBe('ctx-a')
  })

  it('filters communication channels by confirmed user id when requested', async () => {
    const gateway = new MockGateway('channels')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-telegram' },
        spec: {
          hostRef: 'agent-a',
          telegram: [{ channelId: '777', confirmedByUserId: 'user-1' }],
        },
      },
      'channels'
    )
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-b-telegram' },
        spec: {
          hostRef: 'agent-b',
          telegram: [{ channelId: '888', confirmedByUserId: 'user-2' }],
        },
      },
      'channels'
    )

    const listRes = await request(app)
      .get('/admin/communication-channels?confirmedByUserId=user-1')
      .expect(200)

    expect(listRes.body.items).toHaveLength(1)
    expect(listRes.body.items[0].metadata.name).toBe('agent-a-telegram')
  })

  it('returns 500 on update for unknown resource and 404 for bad route', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await request(app)
      .put('/admin/contexts/not-found')
      .send({ spec: { contextId: 'x' } })
      .expect(500)

    await request(app).get('/invalid-resource').expect(404)
  })

  // ── Namespace audit: B5 enforcement ─────────────────────────────────────

  it('silently ignores ?namespace= query parameter on every CRUD verb (never 400)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Query-string namespace is silently stripped — requests succeed, not 400.
    // Body-level enforcement does not apply to query params.
    await request(app).get('/admin/hosts?namespace=evil').expect(200)
    await request(app)
      .post('/admin/hosts?namespace=evil')
      .send({ metadata: { name: 'h' }, spec: {} })
      .expect(201)
    await request(app).get('/admin/hosts/h?namespace=evil').expect(200)
    await request(app).put('/admin/hosts/h?namespace=evil').send({ spec: {} }).expect(200)
    await request(app).delete('/admin/hosts/h?namespace=evil').expect(200)

    // Security audit was logged for each request
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"alert":"SECURITY"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"vector":"query-param"'))

    warnSpy.mockRestore()
  })

  it('returns 400 when metadata.namespace in POST body mismatches config namespace', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Mismatching namespace → 400 with a clear message
    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'evil', namespace: 'control-plane' },
        spec: {},
      })
      .expect(400)

    expect(res.body.error).toMatch(/namespace is server-determined/)

    // Security audit was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"alert":"SECURITY"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"vector":"body-field"'))

    warnSpy.mockRestore()
  })

  it('returns 400 when metadata.namespace in PUT body mismatches config namespace', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // First create a context to update (no namespace in body → 201)
    await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'my-ctx' },
        spec: { contextId: 'my-ctx', mcpServers: [] },
      })
      .expect(201)

    // Mismatching namespace in PUT body → 400
    const res = await request(app)
      .put('/admin/contexts/my-ctx')
      .send({
        metadata: { namespace: 'control-plane' },
        spec: { contextId: 'x', mcpServers: [] },
      })
      .expect(400)

    expect(res.body.error).toMatch(/namespace is server-determined/)

    // Security audit was logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"alert":"SECURITY"'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"vector":"body-field"'))

    warnSpy.mockRestore()
  })

  it('allows POST body when metadata.namespace is absent', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    // No namespace in body → 201, resource created in config namespace
    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'ok-server' },
        spec: {},
      })
      .expect(201)

    expect(res.body.metadata.namespace).toBe('mcp-server')
  })

  it('allows POST body when metadata.namespace matches config namespace', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    // Matching namespace in body → 201, field stripped, resource in config namespace
    const res = await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'ctx-match', namespace: 'mcp-server' },
        spec: { contextId: 'ctx-match', mcpServers: [] },
      })
      .expect(201)

    // The resource ends up in the config namespace; metadata.namespace was stripped before create
    expect(res.body.metadata.namespace).toBe('mcp-server')
  })

  it('treats metadata.namespace="" (empty string) as absent — 201, not 400', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    // Empty-string namespace must NOT trigger the mismatch guard (pins the metaNs !== "" coercion).
    const res = await request(app)
      .post('/admin/contexts')
      .send({
        metadata: { name: 'ctx-empty-ns', namespace: '' },
        spec: { contextId: 'ctx-empty-ns', mcpServers: [] },
      })
      .expect(201)

    expect(res.body.metadata.namespace).toBe('mcp-server')

    // Same for PUT
    await request(app)
      .put('/admin/contexts/ctx-empty-ns')
      .send({
        metadata: { namespace: '' },
        spec: { contextId: 'ctx-empty-ns', mcpServers: [] },
      })
      .expect(200)
  })

  // ── McpServer spec validation (validateMcpServerSpec integration) ───────────

  it('rejects POST /admin/mcp-servers with imagePullPolicy (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'bad-mcp' },
        spec: { imagePullPolicy: 'Always', image: 'test:latest' },
      })
      .expect(422)

    expect(res.body.errors).toHaveLength(1)
    expect(res.body.errors[0].field).toBe('spec.imagePullPolicy')
    expect(res.body.errors[0].message).toContain('platform-controlled')
  })

  it('rejects POST /admin/mcp-servers with root UID (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'root-mcp' },
        spec: { security: { runAsUser: 0 } },
      })
      .expect(422)

    expect(res.body.errors).toHaveLength(1)
    expect(res.body.errors[0].field).toBe('spec.security.runAsUser')
  })

  it('rejects POST /admin/mcp-servers with dangerous capabilities (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'danger-mcp' },
        spec: { security: { addCapabilities: ['SYS_ADMIN', 'NET_ADMIN'] } },
      })
      .expect(422)

    expect(res.body.errors).toHaveLength(1)
    expect(res.body.errors[0].message).toContain('SYS_ADMIN')
  })

  it('rejects POST /admin/mcp-servers with dangerous env vars (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'env-mcp' },
        spec: { env: [{ name: 'KUBECONFIG', value: '/evil' }] },
      })
      .expect(422)

    expect(res.body.errors).toHaveLength(1)
    expect(res.body.errors[0].message).toContain('KUBECONFIG')
  })

  it('rejects PUT /admin/mcp-servers/:name with dangerous spec (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    // Create a valid MCP server first
    await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'my-mcp' },
        spec: { image: 'test:latest' },
      })
      .expect(201)

    // Try to update with dangerous spec
    const res = await request(app)
      .put('/admin/mcp-servers/my-mcp')
      .send({
        spec: { imagePullPolicy: 'Always', security: { runAsUser: 0 } },
      })
      .expect(422)

    expect(res.body.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects POST /admin/mcp-servers with private exact-host DNS before create', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])
    const gateway = new MockGateway('mcp-server')
    const createSpy = vi.spyOn(gateway, 'createResource')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'private-dns-mcp' },
        spec: {
          image: 'test:latest',
          transport: { type: 'streamableHttp' },
          egressBindings: [{ dns: 'api.example.com', port: 443 }],
        },
      })
      .expect(422)

    expect(res.body.errors[0].field).toBe('spec.egressBindings[0].dns')
    expect(res.body.errors[0].message).toContain('blocked')
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects PUT /admin/mcp-servers/:name with unresolved exact-host DNS before update', async () => {
    const gateway = new MockGateway('mcp-server')
    const updateSpy = vi.spyOn(gateway, 'updateResource')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'dns-mcp' },
        spec: { image: 'test:latest', transport: { type: 'streamableHttp' } },
      })
      .expect(201)

    vi.mocked(lookup).mockRejectedValueOnce(new Error('ENOTFOUND'))
    const res = await request(app)
      .put('/admin/mcp-servers/dns-mcp')
      .send({
        spec: {
          image: 'test:latest',
          transport: { type: 'streamableHttp' },
          egressBindings: [{ dns: 'missing.example.com', port: 443 }],
        },
      })
      .expect(422)

    expect(res.body.errors[0].field).toBe('spec.egressBindings[0].dns')
    expect(res.body.errors[0].message).toContain('could not be resolved')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('allows POST /admin/mcp-servers with valid spec (201)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'good-mcp' },
        spec: { image: 'test:latest', transport: { type: 'streamableHttp' } },
      })
      .expect(201)
  })

  it('does NOT validate non-mcp-server resources (hosts pass through)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    // Host with imagePullPolicy should NOT be rejected — validation only for mcpservers
    await request(app)
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-with-pull-policy' },
        spec: { contextRef: 'ctx-a', imagePullPolicy: 'Always' },
      })
      .expect(201)
  })

  // ── envSecret pending materialization ──────────────────────────────────────
  // McpServers may land before their Connector Secret values are added from the
  // Secrets UI. HCC/Kubernetes remain the fail-closed runtime backstop.

  it('allows POST /admin/mcp-servers with pending envSecret (201)', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const getSecretSpy = vi.spyOn(gateway, 'getSecret')

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'mcp-with-missing-secret' },
        spec: {
          image: 'test:latest',
          envSecret: {
            name: 'missing-secret',
            keys: [{ secretKey: 'API_KEY', envVar: 'API_KEY' }],
          },
        },
      })
      .expect(201)

    expect(res.body.metadata.name).toBe('mcp-with-missing-secret')
    expect(getSecretSpy).not.toHaveBeenCalled()
    const items = await gateway.listResource('mcpservers', 'mcp-server')
    expect(items).toHaveLength(1)
  }, 10_000)

  it('allows POST /admin/mcp-servers when envSecret exists (201)', async () => {
    const gateway = new MockGateway('mcp-server')
    gateway.seedSecret('existing-secret', 'mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const getSecretSpy = vi.spyOn(gateway, 'getSecret')

    const res = await request(app)
      .post('/admin/mcp-servers')
      .send({
        metadata: { name: 'mcp-with-valid-secret' },
        spec: {
          image: 'test:latest',
          envSecret: {
            name: 'existing-secret',
            keys: [{ secretKey: 'API_KEY', envVar: 'API_KEY' }],
          },
        },
      })
      .expect(201)

    expect(res.body.metadata.name).toBe('mcp-with-valid-secret')
    expect(getSecretSpy).not.toHaveBeenCalled()
    // CRD landed in the cluster.
    const items = await gateway.listResource('mcpservers', 'mcp-server')
    expect(items).toHaveLength(1)
  })

  // ── Host spec.approval.tools validation ──────────────────────────────────

  describe('Host spec.approval.tools validation', () => {
    function makeApp() {
      const gateway = new MockGateway('mcp-server')
      const app = express()
      app.use(express.json())
      app.use(createAdminResourcesRouter(gateway as never))
      return { app, gateway }
    }

    it('accepts a valid tools map on PUT', async () => {
      const { app } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-x' }, spec: { contextRef: 'c1' } })
        .expect(201)

      await request(app)
        .put('/admin/hosts/host-x')
        .send({
          spec: {
            contextRef: 'c1',
            approval: {
              defaultPolicy: 'channel_users',
              channels: { telegram: { enabled: true } },
              tools: { http_request: false, shell_exec: true },
            },
          },
        })
        .expect(200)
    })

    it('rejects non-boolean values in tools with 422', async () => {
      const { app } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-y' }, spec: { contextRef: 'c1' } })
        .expect(201)

      const res = await request(app)
        .put('/admin/hosts/host-y')
        .send({
          spec: {
            approval: {
              defaultPolicy: 'channel_users',
              channels: {},
              tools: { http_request: 'maybe' as unknown as boolean },
            },
          },
        })
        .expect(422)

      // Response shape mirrors validateMcpServerSpec for consistency:
      // { errors: [{ field, message }] }. Field path includes the offending tool name.
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'spec.approval.tools.http_request',
          }),
        ])
      )
    })

    it('passes through when spec.approval is absent (additive change)', async () => {
      const { app } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-z' }, spec: { contextRef: 'c1' } })
        .expect(201)

      await request(app)
        .put('/admin/hosts/host-z')
        .send({ spec: { contextRef: 'c2' } }) // no approval at all
        .expect(200)
    })

    it('passes through when tools is absent but approval is present', async () => {
      const { app } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-w' }, spec: { contextRef: 'c1' } })
        .expect(201)

      await request(app)
        .put('/admin/hosts/host-w')
        .send({
          spec: {
            approval: {
              defaultPolicy: 'channel_users',
              channels: { telegram: { enabled: true } },
            },
          },
        })
        .expect(200)
    })
  })

  it('cleans up Context allowlists in contextsNamespace when deleting an mcpserver', async () => {
    const prevContextsNs = config.contextsNamespace
    const prevMcpServersNs = config.mcpServersNamespace
    config.contextsNamespace = 'contexts-ns'
    config.mcpServersNamespace = 'mcpservers-ns'

    const gateway = {
      deleteResource: vi.fn().mockResolvedValue({ deleted: true }),
      deleteSecret: vi.fn().mockResolvedValue({ deleted: true }),
      listResource: vi.fn().mockResolvedValue([
        {
          metadata: { name: 'ctx-a' },
          spec: { contextId: 'ctx-a', description: 'desc', mcpServers: ['mcp-a', 'mcp-b'] },
        },
      ]),
      updateResource: vi.fn().mockResolvedValue({}),
    }

    try {
      const app = express()
      app.use(express.json())
      app.use(createAdminResourcesRouter(gateway as never))

      await request(app).delete('/admin/mcp-servers/mcp-a').expect(200)

      expect(gateway.deleteResource).toHaveBeenCalledWith('mcpservers', 'mcp-a', 'mcpservers-ns')
      expect(gateway.listResource).toHaveBeenCalledWith('contexts', 'contexts-ns')
      expect(gateway.updateResource).toHaveBeenCalledWith(
        'contexts',
        'ctx-a',
        {
          spec: {
            contextId: 'ctx-a',
            description: 'desc',
            mcpServers: ['mcp-b'],
          },
        },
        'contexts-ns'
      )
    } finally {
      config.contextsNamespace = prevContextsNs
      config.mcpServersNamespace = prevMcpServersNs
    }
  })
})
