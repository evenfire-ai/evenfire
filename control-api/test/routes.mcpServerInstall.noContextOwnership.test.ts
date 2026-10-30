import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import {
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
} from '../src/services/registryClient.js'
import {
  WORKIQ_GUID_SCOPE,
  discoverPilot,
  installRemoteServer,
} from './fixtures/perServerInstall.js'
import {
  ATLASSIAN_V2_PILOT,
  ENTRA_TENANT_AUTHORITY,
  ENTRA_WORKIQ_PILOT,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * No install flow owns a Context: whatever the body says about one, an install creates
 * the McpServer alone. It never requires a Context, never creates one, never writes
 * `spec.contextRef` and never edits any `Context.spec.mcpServers`. Enabling the server
 * for an agent is a separate, later Context write.
 *
 * Every CR checked here is the one the real route wrote to the gateway; every Context
 * check compares the whole Context set before and after the request.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/services/registryClient.js', () => ({
  searchEntries: vi.fn(),
  getEntry: vi.fn(),
  getEntryVersion: vi.fn(),
  getCredentialSchema: vi.fn(),
  getCategories: vi.fn(),
  reportInstall: vi.fn(),
  downloadBundle: vi.fn(),
  getDigest: vi.fn(),
  uploadArtifacts: vi.fn(),
  updateVersionMetadata: vi.fn(),
  deleteVersion: vi.fn(),
  publishEntry: vi.fn(),
  resolvePublishScope: vi.fn(),
  applyPublishScope: vi.fn((name: string | undefined) => name),
}))

// The generic resources router reaches Postgres only for Host advisory locks and the
// Context grant purge; neither runs for an McpServer write.
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js')
  return {
    ...actual,
    withTransaction: (work: (db: { query: (...a: unknown[]) => unknown }) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }),
    advisoryLockModelNames: async () => {},
    boundCarrierTransactionIdleTimeout: async () => {},
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  }
})

const NS = config.mcpServersNamespace
const CONTEXTS_NS = config.contextsNamespace
const EXISTING_CONTEXT = 'research'
const MISSING_CONTEXT = 'ghost'

/** Every write an install issues against a Context, whatever the verb. */
class ContextWriteRecordingGateway extends MockGateway {
  readonly contextWrites: string[] = []

  override async createResource(
    ...args: Parameters<MockGateway['createResource']>
  ): Promise<unknown> {
    if (args[0] === 'contexts') this.contextWrites.push(`create ${args[1].metadata.name}`)
    return super.createResource(...args)
  }

  override async updateResource(
    ...args: Parameters<MockGateway['updateResource']>
  ): Promise<unknown> {
    if (args[0] === 'contexts') this.contextWrites.push(`update ${args[1]}`)
    return super.updateResource(...args)
  }

  override async mutateResource(
    ...args: Parameters<MockGateway['mutateResource']>
  ): Promise<unknown> {
    if (args[0] === 'contexts') this.contextWrites.push(`mutate ${args[1]}`)
    return super.mutateResource(...args)
  }
}

async function gatewayWithContexts(): Promise<ContextWriteRecordingGateway> {
  const gw = new ContextWriteRecordingGateway(NS)
  await gw.createResource(
    'contexts',
    {
      metadata: { name: EXISTING_CONTEXT },
      spec: { contextId: EXISTING_CONTEXT, mcpServers: ['already-enabled'] },
    },
    CONTEXTS_NS
  )
  await gw.createResource(
    'contexts',
    { metadata: { name: 'other' }, spec: { contextId: 'other', mcpServers: [] } },
    CONTEXTS_NS
  )
  gw.contextWrites.length = 0
  return gw
}

/** The whole Context set: a created Context or any allowlist edit changes it. */
async function contextSet(gw: MockGateway): Promise<unknown[]> {
  const all = (await gw.listResource('contexts', '*')) as Array<{
    metadata: { name: string; namespace?: string; resourceVersion?: string }
    spec: Record<string, unknown>
  }>
  return all
    .map(c => ({
      key: `${c.metadata.namespace}/${c.metadata.name}`,
      resourceVersion: c.metadata.resourceVersion,
      spec: c.spec,
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

async function persistedSpec(gw: MockGateway, name: string): Promise<Record<string, unknown>> {
  const cr = (await gw.getResource('mcpservers', name, NS)) as { spec: Record<string, unknown> }
  return cr.spec
}

/**
 * What a body may say about a Context: nothing, an existing one, one that does not
 * exist, and a value no Context could be named.
 */
const CONTEXT_REF_VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['no contextRef', {}],
  ['contextRef of an existing Context', { contextRef: EXISTING_CONTEXT }],
  ['contextRef of a missing Context', { contextRef: MISSING_CONTEXT }],
  ['contextRef that is not a valid name', { contextRef: 'Not A Name!' }],
]

async function expectInstallOwnsNoContext(
  gw: ContextWriteRecordingGateway,
  before: unknown[],
  serverName: string,
  responseBody: Record<string, unknown>
): Promise<void> {
  expect(gw.contextWrites).toEqual([])
  expect(await contextSet(gw)).toEqual(before)
  expect(await persistedSpec(gw, serverName)).not.toHaveProperty('contextRef')
  expect(responseBody).not.toHaveProperty('contextRef')
  expect(responseBody).not.toHaveProperty('contextUpdated')
}

let savedCallbackBaseUrl: string
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
})
afterEach(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
})

// ── Remote install (POST /admin/mcp-servers/remote) ─────────────────────────

function workIqDiscovery(): Promise<DiscoveryResult> {
  return discoverPilot(ENTRA_WORKIQ_PILOT, {
    hasPreRegisteredClient: true,
    authorizationServer: ENTRA_TENANT_AUTHORITY,
  })
}

function workIqBody(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    serverName: 'workiq',
    baseUrl: ENTRA_WORKIQ_PILOT.mcpUrl,
    mode: 'pre-registered',
    clientId: '11111111-2222-3333-4444-555555555555',
    clientSecret: 'entra-client-secret',
    authorizationServer: ENTRA_TENANT_AUTHORITY,
    scopes: [WORKIQ_GUID_SCOPE],
    ...extra,
  }
}

describe('remote install owns no Context', () => {
  it.each(CONTEXT_REF_VARIANTS)(
    'pre-registered install with %s → 201, no Context touched',
    async (_label, extra) => {
      const gw = await gatewayWithContexts()
      const before = await contextSet(gw)
      const res = await installRemoteServer({
        gateway: gw,
        db: makeInMemoryDynamicClientsDb().db,
        discovery: await workIqDiscovery(),
        body: workIqBody(extra),
      })
      expect(res.status).toBe(201)
      await expectInstallOwnsNoContext(gw, before, 'workiq', res.body)
    }
  )

  // DCR used to read the Context before minting a client, so a missing one was a 404.
  it.each(CONTEXT_REF_VARIANTS)(
    'DCR install with %s → 201 and a bound client, no Context touched',
    async (_label, extra) => {
      const gw = await gatewayWithContexts()
      const before = await contextSet(gw)
      const { db, rows } = makeInMemoryDynamicClientsDb()
      const res = await installRemoteServer({
        gateway: gw,
        db,
        discovery: await discoverPilot(ATLASSIAN_V2_PILOT),
        body: {
          serverName: 'atlassian',
          baseUrl: ATLASSIAN_V2_PILOT.mcpUrl,
          mode: 'dcr',
          ...extra,
        },
      })
      expect(res.status).toBe(201)
      expect(res.dcrCalls).toHaveLength(1)
      await expectInstallOwnsNoContext(gw, before, 'atlassian', res.body)
      const cr = (await gw.getResource('mcpservers', 'atlassian', NS)) as {
        metadata: { uid: string }
      }
      expect([...rows.values()].map(r => r.cr_uid)).toEqual([cr.metadata.uid])
    }
  )
})

/** An apiserver whose McpServer CRD predates `spec.oauth.asProfile`: it prunes it. */
class AsProfilePruningGateway extends ContextWriteRecordingGateway {
  override async createResource(
    ...args: Parameters<MockGateway['createResource']>
  ): Promise<unknown> {
    const [plural, body, namespace] = args
    if (plural !== 'mcpservers') return super.createResource(...args)
    const pruned = structuredClone(body) as typeof body & {
      spec?: { oauth?: Record<string, unknown> }
    }
    delete pruned.spec?.oauth?.asProfile
    return super.createResource(plural, pruned, namespace)
  }
}

/** An apiserver response that carries no `metadata.uid` for the created McpServer. */
class UidlessCreateGateway extends ContextWriteRecordingGateway {
  override async createResource(
    ...args: Parameters<MockGateway['createResource']>
  ): Promise<unknown> {
    const created = (await super.createResource(...args)) as { metadata: { uid?: string } }
    if (args[0] !== 'mcpservers') return created
    const { uid: _uid, ...metadata } = created.metadata
    return { ...created, metadata }
  }
}

async function seedInto<T extends ContextWriteRecordingGateway>(gw: T): Promise<T> {
  const seeded = await gatewayWithContexts()
  for (const ctx of (await seeded.listResource('contexts', '*')) as Array<{
    metadata: { name: string }
    spec: Record<string, unknown>
  }>) {
    await gw.createResource(
      'contexts',
      { metadata: { name: ctx.metadata.name }, spec: ctx.spec },
      CONTEXTS_NS
    )
  }
  gw.contextWrites.length = 0
  return gw
}

describe('remote install saga still compensates its last steps', () => {
  it.each(CONTEXT_REF_VARIANTS)(
    'a pruned asProfile (%s) → 409, the CR and the client Secret are removed, no Context touched',
    async (_label, extra) => {
      const gw = await seedInto(new AsProfilePruningGateway(NS))
      const before = await contextSet(gw)
      const res = await installRemoteServer({
        gateway: gw,
        db: makeInMemoryDynamicClientsDb().db,
        discovery: await workIqDiscovery(),
        body: workIqBody(extra),
      })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('mcpserver_crd_outdated')
      await expect(gw.getResource('mcpservers', 'workiq', NS)).rejects.toThrow()
      await expect(gw.getSecret('workiq-oauth-client', NS)).rejects.toThrow()
      expect(gw.contextWrites).toEqual([])
      expect(await contextSet(gw)).toEqual(before)
    }
  )

  it.each(CONTEXT_REF_VARIANTS)(
    'a DCR bind that cannot happen (%s) → 503, the CR and the client row are removed, no Context touched',
    async (_label, extra) => {
      const gw = await seedInto(new UidlessCreateGateway(NS))
      const before = await contextSet(gw)
      const { db, rows } = makeInMemoryDynamicClientsDb()
      const res = await installRemoteServer({
        gateway: gw,
        db,
        discovery: await discoverPilot(ATLASSIAN_V2_PILOT),
        body: {
          serverName: 'atlassian',
          baseUrl: ATLASSIAN_V2_PILOT.mcpUrl,
          mode: 'dcr',
          ...extra,
        },
      })
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('dcr_bind_failed')
      await expect(gw.getResource('mcpservers', 'atlassian', NS)).rejects.toThrow()
      expect(rows.size).toBe(0)
      expect(gw.contextWrites).toEqual([])
      expect(await contextSet(gw)).toEqual(before)
    }
  )
})

// ── Registry install (POST /admin/registry/install) ─────────────────────────

const emptyUninstallDb = { query: async () => ({ rows: [], rowCount: 0 }) }

function registryApp(gw: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gw as unknown as K8sGateway, { uninstallDb: emptyUninstallDb }))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

function catalogEntry(name: string, meta: Record<string, unknown>) {
  return {
    id: '1',
    name,
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: `${name} server`,
    author: 'clerum',
    origin: 'official',
    category: 'productivity',
    tags: [],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef: `clerum/${name}:1.0.0`, port: 3000, ...meta },
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-01T00:00:00Z',
  }
}

describe('registry install owns no Context', () => {
  it.each(CONTEXT_REF_VARIANTS)(
    'install without OAuth with %s → 201, no Context touched',
    async (_label, extra) => {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(catalogEntry('airtable-mcp', {}))
      const gw = await gatewayWithContexts()
      const before = await contextSet(gw)
      const res = await request(registryApp(gw))
        .post('/admin/registry/install')
        .send({
          serverName: 'my-airtable',
          registryEntryName: 'airtable-mcp',
          registryEntryVersion: '1.0.0',
          ...extra,
        })
      expect(res.status).toBe(201)
      await expectInstallOwnsNoContext(gw, before, 'my-airtable', res.body)
    }
  )

  it.each(CONTEXT_REF_VARIANTS)(
    'install with OAuth (managed client) with %s → 201, no Context touched',
    async (_label, extra) => {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(
        catalogEntry('gmail-mcp', { oauth: { provider: 'google', scopes: [] } })
      )
      const gw = await gatewayWithContexts()
      const before = await contextSet(gw)
      const res = await request(registryApp(gw))
        .post('/admin/registry/install')
        .send({
          serverName: 'my-gmail',
          registryEntryName: 'gmail-mcp',
          registryEntryVersion: '1.0.0',
          oauth: {
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            grantScope: 'context',
            secret: { mode: 'managed', clientId: 'cid-value', clientSecret: 'csec-value' },
          },
          ...extra,
        })
      expect(res.status).toBe(201)
      await expectInstallOwnsNoContext(gw, before, 'my-gmail', res.body)
      expect(await persistedSpec(gw, 'my-gmail')).toMatchObject({
        auth: { type: 'oauth' },
        oauth: { grantScope: 'context' },
      })
    }
  )

  it('an upgrade of a server that still carries contextRef persists it without the field', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...catalogEntry('test-mcp', {}),
      version: '2.0.0',
      mcp_server_meta: { imageRef: 'test:2.0', port: 3000 },
    })
    const gw = await gatewayWithContexts()
    // A CR written before installs stopped writing the field; nothing migrates it.
    await gw.createResource(
      'mcpservers',
      {
        metadata: { name: 'my-srv' },
        spec: {
          image: 'test:1.0',
          contextRef: EXISTING_CONTEXT,
          transport: {
            type: 'streamableHttp',
            port: 3000,
            url: 'http://my-srv.mcp-server.svc:3000/mcp',
          },
        },
      },
      NS
    )
    const before = await contextSet(gw)
    const res = await request(registryApp(gw))
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
    expect(res.status).toBe(200)
    const spec = await persistedSpec(gw, 'my-srv')
    expect(spec).not.toHaveProperty('contextRef')
    expect(spec.image).toBe('test:2.0')
    expect(gw.contextWrites).toEqual([])
    expect(await contextSet(gw)).toEqual(before)
  })
})

// ── Generic McpServer routes (POST/PUT /admin/mcp-servers) ──────────────────

function resourcesApp(gw: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gw as unknown as K8sGateway))
  return app
}

const GENERIC_SPEC = { image: 'test:latest', transport: { type: 'streamableHttp' } }

describe('generic McpServer create owns no Context', () => {
  it.each(CONTEXT_REF_VARIANTS)('POST with %s → 201, no Context touched', async (_label, extra) => {
    const gw = await gatewayWithContexts()
    const before = await contextSet(gw)
    const res = await request(resourcesApp(gw))
      .post('/admin/mcp-servers')
      .send({ metadata: { name: 'generic-mcp' }, spec: { ...GENERIC_SPEC, ...extra } })
    expect(res.status).toBe(201)
    expect(gw.contextWrites).toEqual([])
    expect(await contextSet(gw)).toEqual(before)
    expect(await persistedSpec(gw, 'generic-mcp')).toEqual(GENERIC_SPEC)
    expect(res.body.spec).not.toHaveProperty('contextRef')
  })

  it('PUT that resends contextRef of a server that still carries it → 200, persisted without it', async () => {
    const gw = await gatewayWithContexts()
    // A CR written before installs stopped writing the field; nothing migrates it.
    await gw.createResource(
      'mcpservers',
      { metadata: { name: 'legacy-mcp' }, spec: { ...GENERIC_SPEC, contextRef: EXISTING_CONTEXT } },
      NS
    )
    const before = await contextSet(gw)
    const res = await request(resourcesApp(gw))
      .put('/admin/mcp-servers/legacy-mcp')
      .send({ spec: { ...GENERIC_SPEC, enabled: false, contextRef: EXISTING_CONTEXT } })
    expect(res.status).toBe(200)
    expect(await persistedSpec(gw, 'legacy-mcp')).toEqual({ ...GENERIC_SPEC, enabled: false })
    expect(res.body.spec).not.toHaveProperty('contextRef')
    expect(gw.contextWrites).toEqual([])
    expect(await contextSet(gw)).toEqual(before)
  })
})
