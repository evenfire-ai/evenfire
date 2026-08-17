import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import { lookup } from 'node:dns/promises'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { K8sConflictError, ResourceService } from '../src/services/resourceService.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

// R1-H3 fase 1: Host create/update now wrap validation + the K8s write in a
// carrier transaction that holds a per-model-name advisory lock. Keep the rest of
// db.js real; stub only the transaction runner + lock / idle-timeout guards so
// these route tests need no live Postgres (serialization is covered by the
// real-Postgres race test).
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    advisoryLockModelName: async () => {},
    advisoryLockModelNames: async () => {},
    boundCarrierTransactionIdleTimeout: async () => {},
  }
})

class PruningCommunicationChannelGateway extends MockGateway {
  override async createResource(
    plural: Parameters<MockGateway['createResource']>[0],
    body: Parameters<MockGateway['createResource']>[1],
    namespace?: string
  ): Promise<unknown> {
    if (plural !== 'communicationchannels') return super.createResource(plural, body, namespace)
    const { teamsSettings: _teamsSettings, ...spec } = body.spec
    return super.createResource(plural, { ...body, spec }, namespace)
  }
}

class PruningFirstUpdateCommunicationChannelGateway extends MockGateway {
  private prunedUpdates = 0
  private resourceVersion = 'rv-1'
  readonly updateBodies: Array<Parameters<MockGateway['updateResource']>[2]> = []

  override async getResource(
    plural: Parameters<MockGateway['getResource']>[0],
    name: Parameters<MockGateway['getResource']>[1],
    namespace?: string
  ): Promise<unknown> {
    const resource = (await super.getResource(plural, name, namespace)) as {
      metadata?: Record<string, unknown>
    }
    if (plural !== 'communicationchannels') return resource
    return {
      ...resource,
      metadata: {
        ...resource.metadata,
        resourceVersion: this.resourceVersion,
      },
    }
  }

  override async updateResource(
    plural: Parameters<MockGateway['updateResource']>[0],
    name: Parameters<MockGateway['updateResource']>[1],
    body: Parameters<MockGateway['updateResource']>[2],
    namespace?: string
  ): Promise<unknown> {
    this.updateBodies.push(body)
    if (plural !== 'communicationchannels' || this.prunedUpdates > 0) {
      const updated = (await super.updateResource(plural, name, body, namespace)) as {
        metadata?: Record<string, unknown>
      }
      this.resourceVersion = 'rv-3'
      return {
        ...updated,
        metadata: {
          ...updated.metadata,
          resourceVersion: this.resourceVersion,
        },
      }
    }
    this.prunedUpdates += 1
    const { teamsSettings: _teamsSettings, ...spec } = body.spec
    const updated = (await super.updateResource(plural, name, { ...body, spec }, namespace)) as {
      metadata?: Record<string, unknown>
    }
    this.resourceVersion = 'rv-2'
    return {
      ...updated,
      metadata: {
        ...updated.metadata,
        resourceVersion: this.resourceVersion,
      },
    }
  }
}

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

  it('produces the Context list shape consumed by the control UI, including resourceVersion', async () => {
    const gateway = new MockGateway('mcp-server')
    const context = {
      metadata: {
        name: 'research',
        namespace: 'mcp-server',
        resourceVersion: 'rv-context-read',
      },
      spec: {
        contextId: 'research',
        description: 'Research tools',
        mcpServers: ['search'],
        sharedFileSystems: [{ name: 'docs', mountPath: '/docs' }],
      },
      status: { sharedFileSystems: [] },
    }
    vi.spyOn(gateway, 'listResource').mockResolvedValueOnce([context] as never)
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const response = await request(app).get('/admin/contexts').expect(200)

    expect(response.body).toEqual({ items: [context] })
  })

  it('rejects a stale Context membership replacement without changing the winning spec', async () => {
    const gateway = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    await gateway.createResource(
      'contexts',
      {
        metadata: { name: 'research' },
        spec: { contextId: 'research', mcpServers: ['winner-connector'] },
      },
      config.contextsNamespace
    )

    const realUpdate = gateway.updateResource.bind(gateway)
    vi.spyOn(gateway, 'updateResource').mockImplementation(
      async (plural, name, body, namespace) => {
        const resourceVersion = (body.metadata as { resourceVersion?: string } | undefined)
          ?.resourceVersion
        if (plural === 'contexts' && resourceVersion === 'rv-stale') {
          throw new K8sConflictError('contexts/research changed since it was read')
        }
        return realUpdate(plural, name, body, namespace)
      }
    )

    await request(app)
      .put('/admin/contexts/research')
      .send({
        metadata: { resourceVersion: 'rv-stale' },
        spec: { contextId: 'research', mcpServers: ['stale-connector'] },
      })
      .expect(409, { error: 'conflict', reason: 'resource_changed' })

    const stored = (await gateway.getResource(
      'contexts',
      'research',
      config.contextsNamespace
    )) as { spec: { mcpServers: string[] } }
    expect(stored.spec.mcpServers).toEqual(['winner-connector'])
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

  it('filters Teams communication channels by confirmed user id when requested', async () => {
    const gateway = new MockGateway('channels')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-teams' },
        spec: {
          hostRef: 'agent-a',
          teams: [{ channelId: '19:channel@thread.tacv2', confirmedByUserId: 'user-1' }],
        },
      },
      'channels'
    )
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-b-teams' },
        spec: {
          hostRef: 'agent-b',
          teams: [{ channelId: '19:other@thread.tacv2', confirmedByUserId: 'user-2' }],
        },
      },
      'channels'
    )

    const listRes = await request(app)
      .get('/admin/communication-channels?confirmedByUserId=user-1')
      .expect(200)

    expect(listRes.body.items).toHaveLength(1)
    expect(listRes.body.items[0].metadata.name).toBe('agent-a-teams')
  })

  it('persists Teams settings and credentials on communication channel create', async () => {
    const gateway = new MockGateway('channels')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/communication-channels')
      .send({
        metadata: { name: 'teams-channel' },
        spec: {
          hostRef: 'chatllm',
          access: { users: ['user-1'], teams: [] },
          teams: [],
          teamsSettings: {
            appName: 'evenfire',
            appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            replyOnlyWhenMentioned: true,
          },
        },
        credentials: {
          'teams-app-password': 'secret-value',
        },
      })
      .expect(201)

    expect(res.body.spec.teamsSettings).toEqual({
      appName: 'evenfire',
      appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
      tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
      replyOnlyWhenMentioned: true,
    })
    expect(res.body.spec.credentialsSecretRef).toEqual({
      name: 'cc-teams-channel-credentials',
    })
    const secret = (await gateway.getSecret('cc-teams-channel-credentials', 'channels')) as {
      stringData?: Record<string, string>
    }
    expect(secret.stringData?.['teams-app-password']).toBe('secret-value')
  })

  it('rejects and rolls back when the cluster prunes Teams settings', async () => {
    const gateway = new PruningCommunicationChannelGateway('channels')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    const res = await request(app)
      .post('/admin/communication-channels')
      .send({
        metadata: { name: 'teams-channel' },
        spec: {
          hostRef: 'chatllm',
          access: { users: ['user-1'], teams: [] },
          teams: [],
          teamsSettings: {
            appName: 'evenfire',
            appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
            tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
            replyOnlyWhenMentioned: true,
          },
        },
        credentials: {
          'teams-app-password': 'secret-value',
        },
      })
      .expect(409)

    expect(res.body.code).toBe('communication_channel_crd_outdated')
    expect(res.body.error).toContain('spec.teamsSettings.appName')
    await expect(
      gateway.getResource('communicationchannels', 'teams-channel', 'channels')
    ).rejects.toThrow('not found')
    await expect(gateway.getSecret('cc-teams-channel-credentials', 'channels')).rejects.toThrow(
      'not found'
    )
  })

  it('rejects and restores the prior communication channel spec when update prunes Teams settings', async () => {
    const gateway = new PruningFirstUpdateCommunicationChannelGateway('channels')
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    const previousSpec = {
      hostRef: 'chatllm',
      access: { users: ['user-1'], teams: [] },
      teams: [],
      teamsSettings: {
        appName: 'evenfire',
        appId: '7e9cdb6c-87e8-4b1e-b291-76f7b8bdbe82',
        tenantId: '21e08d37-8d53-4144-87cb-557b8298aed3',
        replyOnlyWhenMentioned: true,
      },
      credentialsSecretRef: { name: 'cc-teams-channel-credentials' },
    }

    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'teams-channel' },
        spec: previousSpec,
      },
      'channels'
    )

    const res = await request(app)
      .put('/admin/communication-channels/teams-channel')
      .send({
        spec: {
          ...previousSpec,
          access: { users: ['user-1', 'user-2'], teams: [] },
        },
      })
      .expect(409)

    expect(res.body.code).toBe('communication_channel_crd_outdated')
    expect(res.body.error).toContain('spec.teamsSettings.appName')
    expect(gateway.updateBodies).toHaveLength(2)
    expect(
      (gateway.updateBodies[0].metadata as { resourceVersion?: string } | undefined)
        ?.resourceVersion
    ).toBe('rv-1')
    expect(
      (gateway.updateBodies[1].metadata as { resourceVersion?: string } | undefined)
        ?.resourceVersion
    ).toBe('rv-2')
    const stored = (await gateway.getResource(
      'communicationchannels',
      'teams-channel',
      'channels'
    )) as { spec?: Record<string, unknown> }
    expect(stored.spec).toEqual(previousSpec)
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

  describe('Host spec.lifecycle round-trip and validation', () => {
    function makeApp() {
      const gateway = new MockGateway('mcp-server')
      const app = express()
      app.use(express.json())
      app.use(createAdminResourcesRouter(gateway as never))
      return { app, gateway }
    }

    it('persists lifecycle.stateless=true on create (object handed to the k8s client)', async () => {
      const { app, gateway } = makeApp()
      const res = await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-sl' },
          spec: { contextRef: 'c1', lifecycle: { stateless: true } },
        })
        .expect(201)
      expect(res.body.spec.lifecycle).toEqual({ stateless: true })

      const stored = (await gateway.getResource('hosts', 'host-sl', config.hostsNamespace)) as {
        spec: Record<string, unknown>
      }
      expect(stored.spec.lifecycle).toEqual({ stateless: true })
    })

    it('preserves lifecycle verbatim when the update payload echoes it', async () => {
      const { app, gateway } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-echo' },
          spec: { contextRef: 'c1', lifecycle: { stateless: true } },
        })
        .expect(201)

      const updated = await request(app)
        .put('/admin/hosts/host-echo')
        .send({ spec: { contextRef: 'c1', lifecycle: { stateless: true } } })
        .expect(200)
      expect(updated.body.spec.lifecycle).toEqual({ stateless: true })

      const stored = (await gateway.getResource('hosts', 'host-echo', config.hostsNamespace)) as {
        spec: Record<string, unknown>
      }
      expect(stored.spec.lifecycle).toEqual({ stateless: true })
    })

    it('forwards the AP-6 reader resourceVersion to the gateway on PUT', async () => {
      const { app, gateway } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-rv' }, spec: { contextRef: 'c1' } })
        .expect(201)

      let seenResourceVersion: string | undefined
      const gw = gateway as unknown as {
        updateResource: (
          plural: string,
          name: string,
          body: { metadata?: { resourceVersion?: string }; spec: Record<string, unknown> },
          namespace?: string
        ) => Promise<unknown>
      }
      const realUpdate = gw.updateResource.bind(gateway)
      gw.updateResource = async (plural, name, body, namespace) => {
        seenResourceVersion = body.metadata?.resourceVersion
        return realUpdate(plural, name, body, namespace)
      }

      await request(app)
        .put('/admin/hosts/host-rv')
        .send({ metadata: { resourceVersion: '42' }, spec: { contextRef: 'c1' } })
        .expect(200)
      expect(seenResourceVersion).toBe('42')
    })

    it('maps a stale reader resourceVersion (K8sConflictError) to 409 {error:conflict, reason:resource_changed}', async () => {
      const { app, gateway } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-stale' }, spec: { contextRef: 'c1' } })
        .expect(201)

      const gw = gateway as unknown as { updateResource: () => Promise<unknown> }
      gw.updateResource = async () => {
        throw new K8sConflictError('hosts/host-stale changed since it was read')
      }

      const res = await request(app)
        .put('/admin/hosts/host-stale')
        .send({ metadata: { resourceVersion: '1' }, spec: { contextRef: 'c2' } })
        .expect(409)
      expect(res.body).toEqual({ error: 'conflict', reason: 'resource_changed' })

      // The stale payload never reached the store — spec unchanged.
      const stored = (await gateway.getResource('hosts', 'host-stale', config.hostsNamespace)) as {
        spec: Record<string, unknown>
      }
      expect(stored.spec.contextRef).toBe('c1')
    })

    it('exposes spec.lifecycle and status.lifecycle + StatelessEnableRejected on get and list', async () => {
      const { app, gateway } = makeApp()
      await gateway.createResource(
        'hosts',
        {
          metadata: { name: 'host-status' },
          spec: { contextRef: 'c1', lifecycle: { stateless: true } },
          status: {
            lifecycle: {
              state: 'suspended',
              wakeHandledGeneration: 3,
              reason: 'SuspendBlocked: drain pending',
            },
            conditions: [
              {
                type: 'StatelessEnableRejected',
                status: 'True',
                reason: 'ActiveCommunicationChannels',
                message: 'stateless rejected: host has active CommunicationChannels',
              },
            ],
          },
        },
        config.hostsNamespace
      )

      const getRes = await request(app).get('/admin/hosts/host-status').expect(200)
      expect(getRes.body.spec.lifecycle).toEqual({ stateless: true })
      expect(getRes.body.status.lifecycle.state).toBe('suspended')
      expect(getRes.body.status.lifecycle.reason).toBe('SuspendBlocked: drain pending')
      const condition = getRes.body.status.conditions.find(
        (c: { type: string }) => c.type === 'StatelessEnableRejected'
      )
      expect(condition).toMatchObject({
        status: 'True',
        reason: 'ActiveCommunicationChannels',
        message: 'stateless rejected: host has active CommunicationChannels',
      })

      const listRes = await request(app).get('/admin/hosts').expect(200)
      const item = listRes.body.items.find(
        (h: { metadata: { name: string } }) => h.metadata.name === 'host-status'
      )
      expect(item.spec.lifecycle).toEqual({ stateless: true })
      expect(item.status.lifecycle.state).toBe('suspended')
      expect(
        item.status.conditions.some((c: { type: string }) => c.type === 'StatelessEnableRejected')
      ).toBe(true)
    })

    it('round-trip: get -> edit unrelated field -> update with echoed spec keeps lifecycle', async () => {
      const { app } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-rt' },
          spec: { contextRef: 'c1', lifecycle: { stateless: true } },
        })
        .expect(201)

      const fetched = await request(app).get('/admin/hosts/host-rt').expect(200)
      const echoedSpec = { ...fetched.body.spec, contextRef: 'c2' }
      await request(app).put('/admin/hosts/host-rt').send({ spec: echoedSpec }).expect(200)

      const after = await request(app).get('/admin/hosts/host-rt').expect(200)
      expect(after.body.spec.lifecycle).toEqual({ stateless: true })
      expect(after.body.spec.contextRef).toBe('c2')
    })

    it('mirrors the spec.desktop contract: an update WITHOUT lifecycle strips it (full spec replace)', async () => {
      const { app, gateway } = makeApp()
      await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-strip' },
          spec: { contextRef: 'c1', lifecycle: { stateless: true } },
        })
        .expect(201)

      await request(app)
        .put('/admin/hosts/host-strip')
        .send({ spec: { contextRef: 'c1' } })
        .expect(200)

      const stored = (await gateway.getResource('hosts', 'host-strip', config.hostsNamespace)) as {
        spec: Record<string, unknown>
      }
      expect(stored.spec.lifecycle).toBeUndefined()
    })

    it('rejects lifecycle that is not an object with 422 on create and update', async () => {
      const { app } = makeApp()
      const createRes = await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-bad' },
          spec: { contextRef: 'c1', lifecycle: 'stateless' },
        })
        .expect(422)
      expect(createRes.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'spec.lifecycle' })])
      )

      await request(app)
        .post('/admin/hosts')
        .send({ metadata: { name: 'host-bad' }, spec: { contextRef: 'c1' } })
        .expect(201)
      const updateRes = await request(app)
        .put('/admin/hosts/host-bad')
        .send({ spec: { contextRef: 'c1', lifecycle: [true] } })
        .expect(422)
      expect(updateRes.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'spec.lifecycle' })])
      )
    })

    it('rejects non-boolean and missing stateless with 422 and a spec.lifecycle.stateless field path', async () => {
      const { app } = makeApp()
      const nonBoolean = await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-badbool' },
          spec: { contextRef: 'c1', lifecycle: { stateless: 'yes' } },
        })
        .expect(422)
      expect(nonBoolean.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'spec.lifecycle.stateless' })])
      )

      const missing = await request(app)
        .post('/admin/hosts')
        .send({
          metadata: { name: 'host-missing' },
          spec: { contextRef: 'c1', lifecycle: {} },
        })
        .expect(422)
      expect(missing.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'spec.lifecycle.stateless' })])
      )
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

// Topic 1b Task 3 — anti-spoofing guard on Host spec.secretRef. A Host may only
// point at an LLM host Secret (host-secret label OR a name in LLM_SECRET_NAMES),
// never an arbitrary in-namespace Secret. Soft/non-regressing: a not-yet-created
// secretRef is allowed (secretMode:'new' provisions it out of band).
describe('routes/resources — Host secretRef anti-spoofing', () => {
  function makeApp(gateway: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    return app
  }

  it('rejects a Host whose secretRef points at a non-LLM in-namespace Secret (422)', async () => {
    const gateway = new MockGateway('mcp-host')
    // e.g. an mcp-host runtime-auth Secret sharing the namespace — no host label.
    gateway.seedSecret('mcp-host-runtime-auth', config.secretsNamespace, { labels: {} })
    const res = await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a', secretRef: 'mcp-host-runtime-auth' },
      })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.secretRef')
    expect(res.body.errors[0].message).toMatch(/does not reference an LLM host Secret/)
  })

  it('accepts a Host whose secretRef points at a labeled per-host LLM Secret (201)', async () => {
    const gateway = new MockGateway('mcp-host')
    gateway.seedSecret('host-a-llm', config.secretsNamespace, {
      labels: { [config.hostSecretLabelKey]: config.hostSecretLabelValue },
    })
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a', secretRef: 'host-a-llm' },
      })
      .expect(201)
  })

  it("accepts secretMode:'existing' pointing at the shared chatllm-api-keys by name (201)", async () => {
    const gateway = new MockGateway('mcp-host')
    // The shared WRC Secret carries no host-secret label — matched by NAME.
    gateway.seedSecret('chatllm-api-keys', config.secretsNamespace, { labels: {} })
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a', secretRef: 'chatllm-api-keys' },
      })
      .expect(201)
  })

  it("accepts a Host whose secretRef does not exist yet (secretMode:'new', soft) (201)", async () => {
    const gateway = new MockGateway('mcp-host')
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a', secretRef: 'not-yet-provisioned' },
      })
      .expect(201)
  })

  it('rejects a non-LLM secretRef on Host UPDATE too (422)', async () => {
    const gateway = new MockGateway('mcp-host')
    gateway.seedSecret('coordinator-token', config.secretsNamespace, { labels: {} })
    const res = await request(makeApp(gateway))
      .put('/admin/hosts/host-a')
      .send({
        metadata: { name: 'host-a' },
        spec: { contextRef: 'ctx-a', secretRef: 'coordinator-token' },
      })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.secretRef')
  })
})

describe('routes/resources — metadata.name validation (FIX-A1 / UT-1)', () => {
  function makeApp(gateway: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    return app
  }

  const PLURALS = ['hosts', 'contexts', 'communication-channels', 'mcp-servers'] as const

  it('accepts an RFC1123 metadata.name for all 4 plurals (201)', async () => {
    for (const plural of PLURALS) {
      const gateway = new MockGateway('mcp-host')
      await request(makeApp(gateway))
        .post(`/admin/${plural}`)
        .send({ metadata: { name: 'sales-agent' }, spec: {} })
        .expect(201)
    }
  })

  it('rejects a metadata.name with spaces+capitals with 422 invalid_name for all 4 plurals', async () => {
    for (const plural of PLURALS) {
      const gateway = new MockGateway('mcp-host')
      const res = await request(makeApp(gateway))
        .post(`/admin/${plural}`)
        .send({ metadata: { name: 'Sales Agent' }, spec: {} })
        .expect(422)
      expect(res.body.error).toBe('invalid_name')
      expect(res.body.field).toBe('metadata.name')
      expect(typeof res.body.message).toBe('string')
    }
  })

  it('rejects the full invalid-name table with 422 invalid_name (hosts)', async () => {
    const invalidNames = [
      '', // empty
      'a'.repeat(64), // 64+ chars (max label length is 63)
      '-x', // leading hyphen
      'x-', // trailing hyphen
      'UPPER', // uppercase
      'esp ace', // space
      'under_score', // underscore
      'dot.name', // dot
      '\u{1F680}', // emoji
    ]
    for (const name of invalidNames) {
      const gateway = new MockGateway('mcp-host')
      const res = await request(makeApp(gateway))
        .post('/admin/hosts')
        .send({ metadata: { name }, spec: {} })
        .expect(422)
      expect(res.body.error).toBe('invalid_name')
      expect(res.body.field).toBe('metadata.name')
    }
  })
})

describe('routes/resources — display & identifier spec validation (F0.3 / UT-6)', () => {
  function makeApp(gateway: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))
    return app
  }

  it('accepts a free-text display spec.host (spaces + capitals) on create (201)', async () => {
    const gateway = new MockGateway('mcp-host')
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'product-agent' },
        spec: { host: 'Product Agents', contextRef: 'c1' },
      })
      .expect(201)
  })

  it('rejects a spec.host longer than 120 chars (422)', async () => {
    const gateway = new MockGateway('mcp-host')
    const res = await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'product-agent' },
        spec: { host: 'x'.repeat(200), contextRef: 'c1' },
      })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.host')
  })

  it('rejects a spec.displayName with a control character on context create (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const res = await request(makeApp(gateway))
      .post('/admin/contexts')
      .send({
        metadata: { name: 'my-context' },
        spec: {
          contextId: 'my-context',
          mcpServers: [],
          displayName: `bad${String.fromCharCode(7)}name`,
        },
      })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.displayName')
  })

  it('accepts a free-text display spec.displayName (spaces + capitals) on context create (201)', async () => {
    const gateway = new MockGateway('mcp-server')
    await request(makeApp(gateway))
      .post('/admin/contexts')
      .send({
        metadata: { name: 'my-context' },
        spec: { contextId: 'my-context', mcpServers: [], displayName: 'My Context' },
      })
      .expect(201)
  })

  // L1 (security, visual spoofing): bidi override / isolate / line-separator
  // characters must be rejected in display free-text — an admin could otherwise
  // craft a spec.host / spec.displayName that visually impersonates another
  // resource in the UI/desktop. These are NOT in the C0/DEL range, so they must
  // be rejected explicitly.
  it.each([
    ['RLO (U+202E)', '‮'],
    ['LRE (U+202A)', '‪'],
    ['FSI (U+2068)', '⁨'],
    ['PDI (U+2069)', '⁩'],
    ['LRI (U+2066)', '⁦'],
    ['line separator (U+2028)', ' '],
    ['paragraph separator (U+2029)', ' '],
  ])(
    'rejects a spec.host with a bidi/override char %s on host create (422)',
    async (_label, ch) => {
      const gateway = new MockGateway('mcp-host')
      const res = await request(makeApp(gateway))
        .post('/admin/hosts')
        .send({
          metadata: { name: 'product-agent' },
          spec: { host: `pay${ch}pal`, contextRef: 'c1' },
        })
        .expect(422)
      expect(res.body.errors[0].field).toBe('spec.host')
    }
  )

  it.each([
    ['RLO (U+202E)', '‮'],
    ['bidi isolate (U+2066)', '⁦'],
    ['line separator (U+2028)', ' '],
  ])(
    'rejects a spec.displayName with a bidi/override char %s on context create (422)',
    async (_label, ch) => {
      const gateway = new MockGateway('mcp-server')
      const res = await request(makeApp(gateway))
        .post('/admin/contexts')
        .send({
          metadata: { name: 'my-context' },
          spec: { contextId: 'my-context', mcpServers: [], displayName: `bad${ch}name` },
        })
        .expect(422)
      expect(res.body.errors[0].field).toBe('spec.displayName')
    }
  )

  it('accepts a display field with accents, ampersand and spaces (no false positive) (201)', async () => {
    const gateway = new MockGateway('mcp-host')
    await request(makeApp(gateway))
      .post('/admin/hosts')
      .send({
        metadata: { name: 'product-agent' },
        spec: { host: 'Résumé & Café Agents', contextRef: 'c1' },
      })
      .expect(201)
  })

  it('rejects a non-RFC1123 spec.contextId on context create (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    const res = await request(makeApp(gateway))
      .post('/admin/contexts')
      .send({
        metadata: { name: 'my-context' },
        spec: { contextId: 'My Context', mcpServers: [] },
      })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.contextId')
  })

  it('accepts an RFC1123 spec.contextId on context create (201)', async () => {
    const gateway = new MockGateway('mcp-server')
    await request(makeApp(gateway))
      .post('/admin/contexts')
      .send({
        metadata: { name: 'my-context' },
        spec: { contextId: 'my-context', mcpServers: [] },
      })
      .expect(201)
  })

  it('ratchet: PUT of a legacy host with an out-of-norm spec.host, WITHOUT changing it, succeeds (200)', async () => {
    const gateway = new MockGateway('mcp-host')
    const legacyHost = 'x'.repeat(200)
    // Seed a legacy CR directly (bypassing router validation) to simulate pre-existing bad data.
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'legacy-host' }, spec: { host: legacyHost, contextRef: 'c1' } },
      config.hostsNamespace
    )
    // Edit an unrelated field; spec.host is echoed unchanged.
    await request(makeApp(gateway))
      .put('/admin/hosts/legacy-host')
      .send({ spec: { host: legacyHost, contextRef: 'c2' } })
      .expect(200)
  })

  it('ratchet: PUT that changes spec.host to an invalid value is rejected (422)', async () => {
    const gateway = new MockGateway('mcp-host')
    await gateway.createResource(
      'hosts',
      { metadata: { name: 'legacy-host' }, spec: { host: 'Fine Name', contextRef: 'c1' } },
      config.hostsNamespace
    )
    const res = await request(makeApp(gateway))
      .put('/admin/hosts/legacy-host')
      .send({ spec: { host: 'y'.repeat(200), contextRef: 'c1' } })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.host')
  })

  it('ratchet: PUT of a legacy context with an out-of-norm spec.contextId, WITHOUT changing it, succeeds (200)', async () => {
    const gateway = new MockGateway('mcp-server')
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'legacy-ctx' }, spec: { contextId: 'Legacy Ctx', mcpServers: [] } },
      config.contextsNamespace
    )
    await request(makeApp(gateway))
      .put('/admin/contexts/legacy-ctx')
      .send({ spec: { contextId: 'Legacy Ctx', mcpServers: ['a'] } })
      .expect(200)
  })

  it('ratchet: PUT that changes spec.contextId to an invalid value is rejected (422)', async () => {
    const gateway = new MockGateway('mcp-server')
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'legacy-ctx' }, spec: { contextId: 'legacy-ctx', mcpServers: [] } },
      config.contextsNamespace
    )
    const res = await request(makeApp(gateway))
      .put('/admin/contexts/legacy-ctx')
      .send({ spec: { contextId: 'New Bad Id', mcpServers: [] } })
      .expect(422)
    expect(res.body.errors[0].field).toBe('spec.contextId')
  })
})

// N1: the admin PUT for hosts/contexts must read the CR from the apiserver
// EXACTLY ONCE. Before the fix the router read `current` for the ratchet AND
// updateResource read it again internally — two GETs per PUT.
//
// This spies the read at the apiserver boundary (customApi.getNamespacedCustomObject)
// through the REAL ResourceService, because MockGateway.updateResource does a
// direct store lookup (it does NOT model the service's internal read), so a spy
// on MockGateway.getResource would show only 1 read at HEAD and could not go RED.
describe('routes/resources — N1 single CR read per hosts/contexts PUT', () => {
  function realServiceGateway() {
    const ns = config.contextsNamespace
    let rv = 0
    const store = new Map<string, Record<string, unknown>>()
    const getNamespacedCustomObject = vi.fn(async ({ name }: { name: string }) => {
      const obj = store.get(name)
      if (!obj) {
        const err = new Error(`contexts/${name} not found`) as Error & { code: number }
        err.code = 404
        throw err
      }
      return obj
    })
    const replaceNamespacedCustomObject = vi.fn(
      async ({ name, body }: { name: string; body: Record<string, unknown> }) => {
        const stored = {
          ...body,
          metadata: {
            ...(body.metadata as Record<string, unknown>),
            resourceVersion: String(++rv),
          },
        }
        store.set(name, stored)
        return stored
      }
    )
    const createNamespacedCustomObject = vi.fn(
      async ({ body }: { body: { metadata: { name: string } } }) => {
        const stored = {
          ...(body as Record<string, unknown>),
          metadata: { ...body.metadata, resourceVersion: String(++rv) },
        }
        store.set(body.metadata.name, stored)
        return stored
      }
    )
    const customApi = {
      getNamespacedCustomObject,
      replaceNamespacedCustomObject,
      createNamespacedCustomObject,
    } as unknown as ConstructorParameters<typeof ResourceService>[0]
    const svc = new ResourceService(customApi, ns, { contexts: ns })
    const gateway = {
      getResource: svc.getResource.bind(svc),
      updateResource: svc.updateResource.bind(svc),
      createResource: svc.createResource.bind(svc),
    }
    return { gateway, getNamespacedCustomObject }
  }

  it('reads the CR exactly once per context PUT (N1)', async () => {
    const { gateway, getNamespacedCustomObject } = realServiceGateway()
    await gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-n1' }, spec: { contextId: 'ctx-n1', mcpServers: [] } },
      config.contextsNamespace
    )
    const app = express()
    app.use(express.json())
    app.use(createAdminResourcesRouter(gateway as never))

    getNamespacedCustomObject.mockClear()
    await request(app)
      .put('/admin/contexts/ctx-n1')
      .send({ spec: { contextId: 'ctx-n1', mcpServers: ['a'] } })
      .expect(200)

    // RED at parent sha: HEAD reads twice (ratchet read + updateResource's own read).
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(1)
  })
})
