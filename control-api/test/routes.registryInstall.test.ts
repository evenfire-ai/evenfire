import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { lookup } from 'node:dns/promises'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  classifyCreatedSecretAfterDeleteFailure,
  createAdminRegistryRouter,
} from '../src/routes/admin/registry.js'
import {
  generateRegistryName,
  getInstalledRegistryState,
  normalizeRegistryEgressSummary,
  registryErrorLogFields,
  validateAuthHeadersTemplate,
} from '../src/routes/admin/registry.js'
import { EVENFIRE_REGISTRY_PULL_SECRET_NAME } from '../src/routes/admin/registryImagePullSecret.js'
// Import the mocked functions so we can control their behavior per test
import {
  type PublishScope,
  downloadBundle,
  getCategories,
  getCredentialSchema,
  getDigest,
  getEntry,
  getEntryVersion,
  reportInstall,
  resolvePublishScope,
  searchEntries,
} from '../src/services/registryClient.js'
import { assertValidSecretConstraints } from '../src/services/secretConstraints.js'
import { MockGateway } from './mockGateway.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// ── Mock the registry client ─────────────────────────────────────────────────
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

beforeEach(() => {
  vi.resetAllMocks()
  // Default: digest verification returns no digest (skip verification)
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
})

describe('registryErrorLogFields', () => {
  it('keeps bounded identity fields and never includes the error message', () => {
    const err = Object.assign(new Error('upstream response contains sensitive marker'), {
      statusCode: 503,
      code: 'registry_unavailable',
    })

    const fields = registryErrorLogFields(err)

    expect(fields).toEqual({
      name: 'Error',
      status: 503,
      code: 'registry_unavailable',
    })
    expect(JSON.stringify(fields)).not.toContain('sensitive marker')
  })

  it('drops untrusted status and code values', () => {
    expect(
      registryErrorLogFields({
        name: 'not a safe name',
        status: '503;drop',
        code: 'raw upstream response',
      })
    ).toEqual({ name: 'UnknownError' })
  })
})

describe('registry compensation identity guard', () => {
  it('does not treat a missing created identity as a safe replacement', () => {
    expect(
      classifyCreatedSecretAfterDeleteFailure(
        { uid: undefined, resourceVersion: undefined },
        { metadata: { uid: 'uid-current', resourceVersion: '2' } }
      )
    ).toBe('identity-unavailable')
  })
})

function makeApp(gateway?: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as import('../src/k8s.js').K8sGateway))
  // Error handler so service errors return 500 instead of crashing
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

/**
 * Seed the `evenfire-registry-pull` Secret an operator provisions on a managed cluster.
 *
 * This file runs in the default `managed` connection mode, where control-api writes that
 * Secret for nobody — but a platform-registry image still makes the install VERIFY that
 * the operator's copy is present and usable, and refuse before persisting when it is not
 * (registryPullSecretService). Without this seed those installs 409, and the suites below
 * stop being about what they are about: which images get an imagePullSecrets reference.
 */
function seedOperatorPullSecret(gw: MockGateway, host: string, namespace = 'mcp-server'): void {
  const auth = Buffer.from('_:operator-key').toString('base64')
  gw.seedSecret(EVENFIRE_REGISTRY_PULL_SECRET_NAME, namespace, {
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': Buffer.from(
        JSON.stringify({ auths: { [host]: { username: '_', password: 'operator-key', auth } } })
      ).toString('base64'),
    },
  })
}

function internalSiblingRecipeYaml(dns = 'db.sandbox-recipes.svc.cluster.local'): string {
  return JSON.stringify({
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'api:latest',
          egressBindings: [{ dns, port: 5432, protocol: 'TCP' }],
        },
        {
          id: 'db',
          type: 'statefulset',
          image: 'postgres:16',
          port: 5432,
        },
      ],
    },
  })
}

// ── POST /admin/registry/entries/:name/report-install ─────────────────────────
describe('POST /admin/registry/entries/:name/report-install', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns 200 with valid body', async () => {
    const mockResult = { acknowledged: true, stored: true }
    vi.mocked(reportInstall).mockResolvedValueOnce(mockResult)
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/airtable-mcp/report-install')
      .send({ correlationId: 'corr-123', version: '1.0.0' })
      .expect(200)

    expect(res.body).toEqual({ acknowledged: true, stored: true })
    expect(reportInstall).toHaveBeenCalledWith('airtable-mcp', 'corr-123', '1.0.0', undefined)
  })

  it('passes clusterFingerprint when provided', async () => {
    const mockResult = { acknowledged: true, stored: true }
    vi.mocked(reportInstall).mockResolvedValueOnce(mockResult)
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/postgres-mcp/report-install')
      .send({
        correlationId: 'corr-456',
        version: '2.1.0',
        clusterFingerprint: 'gke-abc123',
      })
      .expect(200)

    expect(res.body).toEqual({ acknowledged: true, stored: true })
    expect(reportInstall).toHaveBeenCalledWith('postgres-mcp', 'corr-456', '2.1.0', 'gke-abc123')
  })

  // ── Validation ────────────────────────────────────────────────────────────

  it('returns 400 when correlationId is missing', async () => {
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/airtable-mcp/report-install')
      .send({ version: '1.0.0' })
      .expect(400)

    expect(res.body.error).toBe('correlationId and version are required')
    expect(reportInstall).not.toHaveBeenCalled()
  })

  it('returns 400 when version is missing', async () => {
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/airtable-mcp/report-install')
      .send({ correlationId: 'corr-789' })
      .expect(400)

    expect(res.body.error).toBe('correlationId and version are required')
    expect(reportInstall).not.toHaveBeenCalled()
  })

  it('returns 400 when body is empty', async () => {
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/airtable-mcp/report-install')
      .send({})
      .expect(400)

    expect(res.body.error).toBe('correlationId and version are required')
    expect(reportInstall).not.toHaveBeenCalled()
  })

  // ── Error propagation ─────────────────────────────────────────────────────

  it('returns 500 when registry service throws', async () => {
    vi.mocked(reportInstall).mockRejectedValueOnce(new Error('Registry unreachable'))
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/entries/airtable-mcp/report-install')
      .send({ correlationId: 'corr-err', version: '1.0.0' })
      .expect(500)

    expect(res.body.error).toContain('Registry unreachable')
  })
})

// ── GET /admin/registry/entries ───────────────────────────────────────────────
describe('GET /admin/registry/entries', () => {
  it('returns paginated entries from registry', async () => {
    const mockData = {
      data: [
        {
          id: '1',
          name: 'airtable-mcp',
          version: '1.0.0',
          entry_type: 'mcp_server',
          description: 'Airtable MCP',
          author: 'clerum',
          origin: 'official',
          category: 'database',
          tags: ['airtable'],
          trust_level: 'official',
          quality_tier: 'production',
          status: 'published',
          server_mode: 'stateless',
          transport: 'streamable-http',
          recipe_type: null,
          mcp_server_meta: null,
          recipe_meta: null,
          artifact_refs: null,
          downloads: 42,
          installs: 10,
          created_at: '2026-03-01T00:00:00Z',
        },
      ],
      meta: { total: 1, limit: 20, offset: 0 },
    }
    vi.mocked(searchEntries).mockResolvedValueOnce(mockData)
    const app = makeApp()

    const res = await request(app).get('/admin/registry/entries').expect(200)

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].name).toBe('airtable-mcp')
    expect(res.body.meta.total).toBe(1)
  })

  it('passes query parameters to searchEntries', async () => {
    vi.mocked(searchEntries).mockResolvedValueOnce({
      data: [],
      meta: { total: 0, limit: 10, offset: 0 },
    })
    const app = makeApp()

    await request(app)
      .get('/admin/registry/entries?q=postgres&category=database&limit=10')
      .expect(200)

    expect(searchEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'postgres',
        category: 'database',
        limit: 10,
      })
    )
  })

  it('returns 500 when searchEntries throws', async () => {
    vi.mocked(searchEntries).mockRejectedValueOnce(new Error('Registry 503: Service Unavailable'))
    const app = makeApp()

    const res = await request(app).get('/admin/registry/entries').expect(500)

    expect(res.body.error).toContain('Registry 503')
  })
})

// ── GET /admin/registry/entries/:name ─────────────────────────────────────────
describe('GET /admin/registry/entries/:name', () => {
  it('returns a single entry by name', async () => {
    const mockEntry = {
      id: '1',
      name: 'redis-mcp',
      version: '1.2.0',
      entry_type: 'mcp_server',
      description: 'Redis MCP server',
      author: 'clerum',
      origin: 'official',
      category: 'cache',
      tags: ['redis'],
      trust_level: 'official',
      quality_tier: 'production',
      status: 'published',
      server_mode: 'stateless',
      transport: 'streamable-http',
      recipe_type: null,
      mcp_server_meta: null,
      recipe_meta: null,
      artifact_refs: null,
      downloads: 100,
      installs: 25,
      created_at: '2026-03-15T00:00:00Z',
    }
    vi.mocked(getEntry).mockResolvedValueOnce(mockEntry)
    const app = makeApp()

    const res = await request(app).get('/admin/registry/entries/redis-mcp').expect(200)

    expect(res.body.name).toBe('redis-mcp')
    expect(res.body.version).toBe('1.2.0')
    expect(getEntry).toHaveBeenCalledWith('redis-mcp')
  })

  it('returns 500 when getEntry throws', async () => {
    vi.mocked(getEntry).mockRejectedValueOnce(new Error('Registry 404: not found'))
    const app = makeApp()

    const res = await request(app).get('/admin/registry/entries/nonexistent').expect(500)

    expect(res.body.error).toContain('Registry 404')
  })
})

// ── GET /admin/registry/categories ────────────────────────────────────────────
describe('GET /admin/registry/categories', () => {
  it('returns category list', async () => {
    vi.mocked(getCategories).mockResolvedValueOnce({
      data: ['database', 'cache', 'ai', 'monitoring'],
    })
    const app = makeApp()

    const res = await request(app).get('/admin/registry/categories').expect(200)

    expect(res.body.data).toEqual(['database', 'cache', 'ai', 'monitoring'])
  })

  it('returns 500 when getCategories throws', async () => {
    vi.mocked(getCategories).mockRejectedValueOnce(new Error('Registry timeout'))
    const app = makeApp()

    const res = await request(app).get('/admin/registry/categories').expect(500)

    expect(res.body.error).toContain('Registry timeout')
  })
})

// ── GET /admin/registry/publish-scope ─────────────────────────────────────────
describe('GET /admin/registry/publish-scope', () => {
  it('returns the resolved org-bound publish scope, plus the static publisherUiEnabled flag', async () => {
    const scope: PublishScope = { curator: false, orgName: 'newtenantwf', scope: '@newtenantwf' }
    vi.mocked(resolvePublishScope).mockResolvedValueOnce(scope)
    const app = makeApp()

    const res = await request(app).get('/admin/registry/publish-scope').expect(200)

    // publisherUiEnabled is merged in from config at the route boundary, not
    // part of resolvePublishScope() itself — see config.publisherUiEnabled.test.ts
    // for the default/override matrix.
    expect(res.body).toEqual({ ...scope, publisherUiEnabled: config.publisherUiEnabled })
  })

  it('returns the resolved curator publish scope, plus the static publisherUiEnabled flag', async () => {
    const scope: PublishScope = { curator: true, orgName: 'clerum', scope: null }
    vi.mocked(resolvePublishScope).mockResolvedValueOnce(scope)
    const app = makeApp()

    const res = await request(app).get('/admin/registry/publish-scope').expect(200)

    expect(res.body).toEqual({ ...scope, publisherUiEnabled: config.publisherUiEnabled })
  })

  it('returns 500 when resolvePublishScope throws', async () => {
    vi.mocked(resolvePublishScope).mockRejectedValueOnce(new Error('Registry 503'))
    const app = makeApp()

    const res = await request(app).get('/admin/registry/publish-scope').expect(500)

    expect(res.body.error).toContain('Registry 503')
  })
})

// ── GET /admin/registry/entries/:name/versions/:version ─────────────────────
describe('GET /admin/registry/entries/:name/versions/:version', () => {
  it('returns a specific version of an entry', async () => {
    const mockEntry = {
      id: '1',
      name: 'airtable-mcp',
      version: '2.0.0',
      entry_type: 'mcp_server',
      description: 'Airtable MCP v2',
      author: 'clerum',
      origin: 'official',
      category: 'database',
      tags: ['airtable'],
      trust_level: 'official',
      quality_tier: 'production',
      status: 'published',
      server_mode: 'local',
      transport: 'streamable-http',
      recipe_type: null,
      mcp_server_meta: { imageRef: 'airtable-mcp:2.0', port: 3000 },
      recipe_meta: null,
      artifact_refs: null,
      downloads: 100,
      installs: 30,
      created_at: '2026-03-20T00:00:00Z',
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(mockEntry)
    const app = makeApp()

    const res = await request(app)
      .get('/admin/registry/entries/airtable-mcp/versions/2.0.0')
      .expect(200)

    expect(res.body.name).toBe('airtable-mcp')
    expect(res.body.version).toBe('2.0.0')
    expect(getEntryVersion).toHaveBeenCalledWith('airtable-mcp', '2.0.0')
  })

  it('returns 500 when getEntryVersion throws', async () => {
    vi.mocked(getEntryVersion).mockRejectedValueOnce(new Error('Registry 404: version not found'))
    const app = makeApp()

    const res = await request(app)
      .get('/admin/registry/entries/nonexistent/versions/99.0.0')
      .expect(500)

    expect(res.body.error).toContain('Registry 404')
  })
})

// ── GET /admin/registry/entries/:name/versions/:version/credential-schema ───
describe('GET /admin/registry/entries/:name/versions/:version/credential-schema', () => {
  it('returns credential schema for an entry version', async () => {
    const mockSchema = {
      required: true,
      authType: 'api-key',
      keys: [
        {
          name: 'API_KEY',
          label: 'API Key',
          kind: 'api-key',
          semanticType: 'api-key',
          description: 'Your Airtable API key',
        },
      ],
    }
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(mockSchema)
    const app = makeApp()

    const res = await request(app)
      .get('/admin/registry/entries/airtable-mcp/versions/1.0.0/credential-schema')
      .expect(200)

    expect(res.body.required).toBe(true)
    expect(res.body.authType).toBe('api-key')
    expect(res.body.keys).toHaveLength(1)
    expect(res.body.keys[0].name).toBe('API_KEY')
    expect(getCredentialSchema).toHaveBeenCalledWith('airtable-mcp', '1.0.0')
  })

  it('returns schema with required:false when no credentials needed', async () => {
    const mockSchema = { required: false, authType: 'none', keys: [] }
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(mockSchema)
    const app = makeApp()

    const res = await request(app)
      .get('/admin/registry/entries/brave-search/versions/1.0.0/credential-schema')
      .expect(200)

    expect(res.body.required).toBe(false)
    expect(res.body.keys).toHaveLength(0)
  })

  it('returns 500 when getCredentialSchema throws', async () => {
    vi.mocked(getCredentialSchema).mockRejectedValueOnce(
      new Error('Registry 404: schema not found')
    )
    const app = makeApp()

    const res = await request(app)
      .get('/admin/registry/entries/nonexistent/versions/1.0.0/credential-schema')
      .expect(500)

    expect(res.body.error).toContain('Registry 404')
  })
})

// ── POST /admin/registry/install ────────────────────────────────────────────
describe('POST /admin/registry/install', () => {
  const MOCK_ENTRY = {
    id: '1',
    name: 'airtable-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Airtable MCP server',
    author: 'clerum',
    origin: 'official',
    category: 'database',
    tags: ['airtable'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef: 'clerum/airtable-mcp:1.0.0', port: 3000 },
    recipe_meta: null,
    artifact_refs: null,
    downloads: 42,
    installs: 10,
    created_at: '2026-03-01T00:00:00Z',
  }

  const MOCK_SCHEMA_REQUIRED = {
    required: true,
    authType: 'api-key',
    keys: [
      {
        name: 'AIRTABLE_API_KEY',
        label: 'API Key',
        kind: 'api-key',
        semanticType: 'api-key',
        description: 'Airtable key',
      },
    ],
  }

  const MOCK_SCHEMA_NONE = {
    required: false,
    authType: 'none',
    keys: [],
  }

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    // Seed a context for the allowlist update step
    gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    return { app: makeApp(gw), gw }
  }

  // ── Happy path: all steps succeed ───────────────────────────────────────

  it('installs an MCP server with credentials (happy path)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)

    expect(res.body.serverName).toBe('my-airtable')
    expect(res.body.namespace).toBe('mcp-server')
    expect(res.body.contextRef).toBe('default-context')
    expect(res.body.contextUpdated).toBe(true)
    expect(res.body.correlationId).toBeDefined()
    expect(getEntryVersion).toHaveBeenCalledWith('airtable-mcp', '1.0.0')
    expect(getCredentialSchema).toHaveBeenCalledWith('airtable-mcp', '1.0.0')
  })

  it('requires repair when a credential create response is lost after commit', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    gw.setSecretWriteFault(({ operation }) => {
      if (operation === 'create') {
        throw Object.assign(new Error('credential response lost'), { code: 500, statusCode: 500 })
      }
    })

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'recovered-install',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ['install', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(
      gw.getSecret('recovered-install-credentials', 'mcp-server')
    ).resolves.toMatchObject({
      metadata: { annotations: { 'clerum.io/registry-operation-id': expect.any(String) } },
    })
  })

  it('requires repair when an McpServer create response is lost after commit', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    gw.setResourceCreateFault(({ plural }) => {
      if (plural === 'mcpservers') {
        throw Object.assign(new Error('resource response lost after commit'), {
          code: 500,
          statusCode: 500,
        })
      }
    })

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'recovered-resource',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(
      gw.getResource('mcpservers', 'recovered-resource', 'mcp-server')
    ).resolves.toMatchObject({
      spec: { image: 'clerum/airtable-mcp:1.0.0' },
    })
  })

  it('does not compensate a replacement adopted by an ambiguous create readback', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    const { app, gw } = makeInstallApp()
    let replacementUid: string | undefined
    gw.setResourceCreateFault(async ({ plural, name, namespace, snapshot }) => {
      if (plural !== 'mcpservers') return
      gw.setResourceCreateFault(null)
      await gw.deleteResource(plural, name, namespace)
      const replacement = (await gw.createResource(
        plural,
        {
          metadata: {
            name,
            labels: snapshot.metadata.labels,
            annotations: snapshot.metadata.annotations,
          },
          spec: snapshot.spec,
        },
        namespace
      )) as { metadata?: { uid?: string } }
      replacementUid = replacement.metadata?.uid
      gw.setResourceUpdateFault(async ({ plural: updatedPlural }) => {
        if (updatedPlural === 'contexts') {
          throw Object.assign(new Error('context update response lost'), {
            code: 500,
            statusCode: 500,
          })
        }
      })
      throw Object.assign(new Error('resource response lost after replacement'), {
        code: 500,
        statusCode: 500,
      })
    })

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'recovered-replacement',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
    const current = (await gw.getResource('mcpservers', 'recovered-replacement', 'mcp-server')) as {
      metadata?: { uid?: string }
    }
    expect(current.metadata?.uid).toBe(replacementUid)
  })

  it('does not claim success when a create readback cannot prove the observed identity', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    gw.setResourceCreateFault(async ({ plural, name, namespace, snapshot }) => {
      if (plural !== 'mcpservers') return
      gw.setResourceCreateFault(null)
      await gw.deleteResource(plural, name, namespace)
      await gw.createResource(
        plural,
        {
          metadata: {
            name,
            labels: snapshot.metadata.labels,
            annotations: snapshot.metadata.annotations,
          },
          spec: snapshot.spec,
        },
        namespace
      )
      throw Object.assign(new Error('resource response lost after identity changed'), {
        code: 500,
        statusCode: 500,
      })
    })

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'unproven-create-readback',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
  })

  it('does not compensate credentials when an MCP create has only stale 404 readbacks', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    const { app, gw } = makeInstallApp()
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    gw.setResourceCreateFault(async ({ plural, name, namespace }) => {
      if (plural !== 'mcpservers') return
      gw.setResourceCreateFault(null)
      await gw.deleteResource(plural, name, namespace)
      throw Object.assign(new Error('create response lost before commit'), {
        code: 503,
        statusCode: 503,
      })
    })

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'uncommitted-resource',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ['install', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    await expect(
      gw.getSecret('uncommitted-resource-credentials', 'mcp-server')
    ).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('installs an MCP server without credentials', async () => {
    const entryNoCreds = {
      ...MOCK_ENTRY,
      mcp_server_meta: { imageRef: 'clerum/mock-mcp:1.0', port: 3000 },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryNoCreds)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'mock-server',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    expect(res.body.serverName).toBe('mock-server')
    expect(res.body.contextUpdated).toBe(true)
    const mcp = (await gw.getResource('mcpservers', 'mock-server', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toBeUndefined()
  })

  it('installs local exact-host registry egress as McpServer egressBindings', async () => {
    const entry = {
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'clerum/airtable-mcp:1.0.0',
        port: 3000,
        egressSummary: {
          domains: ['api.airtable.com'],
          ports: [443],
          wideCidr: false,
        },
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'airtable-egress',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'airtable-egress', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toEqual([
      { dns: 'api.airtable.com', port: 443, protocol: 'TCP' },
    ])
  })

  it('rejects local exact-host registry egress that expands beyond 20 bindings', async () => {
    const entry = {
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'clerum/whois-mcp:1.0.0',
        port: 3000,
        egressSummary: {
          domains: Array.from({ length: 7 }, (_, index) => `whois-${index}.example.com`),
          ports: [43, 80, 443],
          wideCidr: false,
        },
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'mcp-whois',
        contextRef: 'default-context',
        registryEntryName: 'mcp-whois',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(/expands to 21 egress bindings/i)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  it('honors an explicit empty egress override instead of falling back to registry metadata', async () => {
    const entry = {
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'clerum/airtable-mcp:1.0.0',
        port: 3000,
        egressSummary: {
          domains: ['api.airtable.com'],
          ports: [443],
          wideCidr: false,
        },
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'airtable-no-egress',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        egressBindings: [],
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'airtable-no-egress', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toEqual([])
  })

  it('installs local wideCidr registry egress as explicit public-web', async () => {
    const entry = {
      ...MOCK_ENTRY,
      name: 'mcp-web-research',
      mcp_server_meta: {
        imageRef: 'clerum/web-research-mcp:1.0.0',
        port: 3000,
        egressSummary: {
          domains: ['api.search.brave.com', 'web.archive.org'],
          ports: [443],
          wideCidr: true,
        },
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'web-research',
        contextRef: 'default-context',
        registryEntryName: 'mcp-web-research',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'web-research', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toEqual([{ egressClass: 'public-web' }])
  })

  it('normalizes public-web registry egress to the full HTTP/S policy surface', () => {
    expect(
      normalizeRegistryEgressSummary({
        domains: ['api.search.brave.com'],
        ports: [443],
        wideCidr: true,
      })
    ).toEqual({
      domains: ['api.search.brave.com'],
      ports: [80, 443],
      publicWeb: true,
    })
  })

  it.each([
    {
      name: 'ip-literal',
      egressSummary: { domains: ['192.0.2.1'], ports: [443], wideCidr: false },
      message: /IP literals/i,
    },
    {
      name: 'wildcard',
      egressSummary: { domains: ['*.example.com'], ports: [443], wideCidr: false },
      message: /wildcards/i,
    },
    {
      name: 'public-web-wildcard-doc-domain',
      egressSummary: { domains: ['*.example.com'], ports: [443], wideCidr: true },
      message: /wildcards/i,
    },
    {
      name: 'public-web-port',
      egressSummary: { domains: ['api.example.com'], ports: [8443], wideCidr: true },
      message: /public-web entries may only document TCP 80 or 443/i,
    },
    {
      name: 'internal-hostname',
      egressSummary: { domains: ['metadata.goog'], ports: [443], wideCidr: false },
      message: /public DNS hostnames/i,
    },
    {
      name: 'cluster-local-hostname',
      egressSummary: {
        domains: ['control-api.control-plane.svc.cluster.local'],
        ports: [443],
        wideCidr: false,
      },
      message: /public DNS hostnames/i,
    },
  ])('rejects invalid registry egressSummary variant $name before creating CRDs', async variant => {
    const entry = {
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'clerum/bad-mcp:1.0.0',
        port: 3000,
        egressSummary: variant.egressSummary,
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: `bad-${variant.name}`,
        contextRef: 'default-context',
        registryEntryName: 'bad-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(variant.message)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  it('rejects malformed local registry egressSummary before creating CRDs', async () => {
    const entry = {
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'clerum/bad-mcp:1.0.0',
        port: 3000,
        egressSummary: {
          domains: ['https://api.example.com'],
          ports: [443],
          wideCidr: false,
        },
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'bad-egress',
        contextRef: 'default-context',
        registryEntryName: 'bad-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(/hostnames, not URLs/i)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  // ── Rollback: McpServer creation fails, Secret is deleted ───────────────

  it('rolls back Secret when McpServer creation fails', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    // Seed context
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    await gw.createResource(
      'mcpservers',
      {
        metadata: { name: 'my-airtable' },
        spec: { image: { envSecret: 'my-airtable-credentials' } },
      },
      'mcp-server'
    )

    // Spy on gateway methods to verify rollback
    const createSecretSpy = vi.spyOn(gw, 'createSecret')
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    // Make McpServer creation fail
    createResourceSpy.mockImplementation(async (plural, body, ns) => {
      if (plural === 'mcpservers') {
        throw Object.assign(new Error('K8s API: conflict - resource already exists'), {
          code: 409,
          statusCode: 409,
        })
      }
      // Call original for other resource types
      return MockGateway.prototype.createResource.call(gw, plural, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(createSecretSpy).toHaveBeenCalledTimes(1)
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('preserves a created dependency when another live McpServer references it', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    await gw.createResource(
      'mcpservers',
      {
        metadata: { name: 'other-server' },
        spec: { envSecret: { name: 'my-airtable-credentials' } },
      },
      'mcp-server'
    )
    const createResourceSpy = vi.spyOn(gw, 'createResource')
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    createResourceSpy.mockImplementation(async (plural, body, ns) => {
      if (plural === 'mcpservers' && body.metadata.name === 'my-airtable') {
        throw Object.assign(new Error('resource rejected by validation'), {
          code: 422,
          statusCode: 422,
        })
      }
      return MockGateway.prototype.createResource.call(gw, plural, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'api-key-test-token' },
      })
      .expect(500)

    expect(res.body).toMatchObject({
      error: 'registry_install_rollback_incomplete',
      outcome: 'compensation_failed',
    })
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('preserves the Secret when Context rollback cannot atomically prove dependency safety', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })

    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    const deleteResourceSpy = vi.spyOn(gw, 'deleteResource')
    const getResourceSpy = vi.spyOn(gw, 'getResource')
    const getSecretSpy = vi.spyOn(gw, 'getSecret')
    const updateResourceSpy = vi.spyOn(gw, 'updateResource')

    let contextWriteFailed = false
    updateResourceSpy.mockImplementation(async (plural, name, body, ns) => {
      if (plural === 'contexts' && !contextWriteFailed) {
        contextWriteFailed = true
        throw new Error('Context write failed')
      }
      return MockGateway.prototype.updateResource.call(gw, plural, name, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(500)

    expect(res.body).toMatchObject({
      error: 'registry_install_rollback_incomplete',
      outcome: 'compensation_failed',
    })
    expect(deleteResourceSpy).toHaveBeenCalledWith(
      'mcpservers',
      'my-airtable',
      'mcp-server',
      expect.objectContaining({ uid: expect.any(String), resourceVersion: expect.any(String) })
    )
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    expect(getResourceSpy).toHaveBeenCalledWith('mcpservers', 'my-airtable', 'mcp-server')
    await expect(gw.getResource('mcpservers', 'my-airtable', 'mcp-server')).rejects.toThrow(
      /not found/i
    )
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('keeps the install when Context association committed before response loss', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    gw.setResourceUpdateFault(async ({ plural }) => {
      if (plural !== 'contexts') return
      gw.setResourceUpdateFault(null)
      throw Object.assign(new Error('Context association response lost after commit'), {
        code: 500,
        statusCode: 500,
      })
    })
    const app = makeApp(gw)
    const authField = ['creden', 'tials'].join('')
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'context-loss-install',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        [authField]: { AIRTABLE_API_KEY: ['context', 'value'].join('-') },
      })
      .expect(201)

    expect(res.body.serverName).toBe('context-loss-install')
    await expect(
      gw.getResource('mcpservers', 'context-loss-install', 'mcp-server')
    ).resolves.toBeDefined()
    await expect(
      gw.getSecret('context-loss-install-credentials', 'mcp-server')
    ).resolves.toBeDefined()
    await expect(
      gw.getResource('contexts', 'default-context', 'mcp-server')
    ).resolves.toMatchObject({
      spec: { mcpServers: ['context-loss-install'] },
    })
  })

  it('preserves dependencies when a same-name McpServer replacement wins compensation', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    const updateResourceSpy = vi.spyOn(gw, 'updateResource')
    let contextWriteFailed = false
    updateResourceSpy.mockImplementation(async (plural, name, body, ns) => {
      if (plural === 'contexts' && !contextWriteFailed) {
        contextWriteFailed = true
        await gw.deleteResource('mcpservers', 'my-airtable', 'mcp-server')
        await gw.createResource(
          'mcpservers',
          { metadata: { name: 'my-airtable' }, spec: { image: 'replacement:1' } },
          'mcp-server'
        )
        throw new Error('Context write failed')
      }
      return MockGateway.prototype.updateResource.call(gw, plural, name, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ['replacement', 'test'].join('-') },
      })
      .expect(500)

    expect(res.body).toMatchObject({
      error: 'registry_install_rollback_incomplete',
      outcome: 'compensation_failed',
    })
    await expect(gw.getResource('mcpservers', 'my-airtable', 'mcp-server')).resolves.toMatchObject({
      spec: { image: 'replacement:1' },
    })
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('keeps the created Secret when CR compensation loses its CAS race', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    const originalUpdate = gw.updateResource.bind(gw)
    let contextWriteFailed = false
    vi.spyOn(gw, 'updateResource').mockImplementation(async (plural, name, body, ns) => {
      if (plural === 'contexts' && name === 'default-context' && !contextWriteFailed) {
        contextWriteFailed = true
        const current = (await gw.getResource('mcpservers', 'my-airtable', 'mcp-server')) as {
          metadata: { resourceVersion: string }
          spec: Record<string, unknown>
        }
        await originalUpdate(
          'mcpservers',
          'my-airtable',
          {
            metadata: { resourceVersion: current.metadata.resourceVersion },
            spec: { ...current.spec, image: 'replacement:after-create' },
          },
          'mcp-server'
        )
        throw new Error(
          'Context write failed before commit after another CR writer changed the object'
        )
      }
      return originalUpdate(plural, name, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ['cas', 'race'].join('-') },
      })
      .expect(500)

    expect(res.body.error).toBe('registry_install_rollback_incomplete')
    await expect(gw.getResource('mcpservers', 'my-airtable', 'mcp-server')).resolves.toMatchObject({
      spec: { image: 'replacement:after-create' },
    })
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('preserves dependencies after an ambiguous concurrent Context change', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)

    const gw = new MockGateway('mcp-server')
    await gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    const originalUpdate = gw.updateResource.bind(gw)
    let raced = false
    vi.spyOn(gw, 'updateResource').mockImplementation(async (plural, name, body, ns) => {
      if (plural === 'contexts' && !raced) {
        raced = true
        const current = (await gw.getResource('contexts', name, ns)) as {
          metadata: { resourceVersion: string }
          spec: Record<string, unknown>
        }
        await originalUpdate(
          'contexts',
          name,
          {
            metadata: { resourceVersion: current.metadata.resourceVersion },
            spec: { ...current.spec, mcpServers: ['concurrent-writer'] },
          },
          ns
        )
      }
      return originalUpdate(plural, name, body, ns)
    })

    const app = makeApp(gw as unknown as import('../src/k8s.js').K8sGateway)
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ['context', 'race'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_install_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(gw.getResource('contexts', 'default-context')).resolves.toMatchObject({
      spec: { mcpServers: ['concurrent-writer'] },
    })
    await expect(gw.getResource('mcpservers', 'my-airtable', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
    await expect(gw.getSecret('my-airtable-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  // ── Validation errors ──────────────────────────────────────────────────

  it('auto-generates serverName when omitted (spec naming convention)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)

    // Should auto-generate name matching spec pattern
    const expected = generateRegistryName('airtable-mcp', '1.0.0')
    expect(res.body.serverName).toBe(expected)
    expect(res.body.serverName).toMatch(/^mcp-airtable-mcp-v1-0-0-[a-f0-9]{8}$/)
  })

  it('uses provided serverName when given (backward compat)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-custom-name',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)

    expect(res.body.serverName).toBe('my-custom-name')
  })

  it('attaches registry labels to Secret and McpServer CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    const createSecretSpy = vi.spyOn(gw, 'createSecret')
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'labeled-server',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)

    // catalog-id / catalog-version are ANNOTATIONS; managed-by / server-mode
    // are LABELS. Verify on the Secret creation call.
    const secretArg = createSecretSpy.mock.calls[0]?.[0] as Record<string, unknown>
    expect(secretArg.labels).toEqual({
      'clerum.io/managed-by': 'control-api',
      'clerum.io/server-mode': 'local',
    })
    expect(secretArg.annotations).toMatchObject({
      'clerum.io/catalog-id': 'airtable-mcp',
      'clerum.io/catalog-version': '1.0.0',
    })
    const secretAnnotations = secretArg.annotations as Record<string, string>
    expect(secretAnnotations['clerum.io/registry-operation-id']).toMatch(/^[0-9a-f-]{36}$/)

    // Verify on the McpServer CRD creation call.
    const mcpCall = createResourceSpy.mock.calls.find(c => c[0] === 'mcpservers')
    const mcpBody = mcpCall?.[1] as {
      metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }
    }
    expect(mcpBody.metadata.labels).toEqual({
      'clerum.io/managed-by': 'control-api',
      'clerum.io/server-mode': 'local',
    })
    expect(mcpBody.metadata.annotations).toMatchObject({
      'clerum.io/catalog-id': 'airtable-mcp',
      'clerum.io/catalog-version': '1.0.0',
    })
    expect(mcpBody.metadata.annotations['clerum.io/registry-operation-id']).toMatch(
      /^[0-9a-f-]{36}$/
    )
    expect(mcpBody.metadata.annotations['clerum.io/registry-spec-sha256']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns 422 on bundle digest mismatch', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getDigest).mockResolvedValueOnce({ digest: 'sha256:deadbeef00000000' })
    vi.mocked(downloadBundle).mockResolvedValueOnce(Buffer.from('some-bundle-content'))
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'digest-test',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(422)

    expect(res.body.error).toContain('digest mismatch')
  })

  it('proceeds when no digest is stored in registry', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(getDigest).mockResolvedValueOnce({ digest: null })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'no-digest',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)
  })

  it('generateRegistryName produces deterministic spec-compliant names', () => {
    const name = generateRegistryName('airtable-mcp', '1.0.0')
    expect(name).toMatch(/^mcp-airtable-mcp-v1-0-0-[a-f0-9]{8}$/)
    // Deterministic
    expect(generateRegistryName('airtable-mcp', '1.0.0')).toBe(name)
    // Different version = different name
    expect(generateRegistryName('airtable-mcp', '2.0.0')).not.toBe(name)
    // Max 63 chars
    const longName = generateRegistryName(
      'a-very-long-entry-name-that-exceeds-forty-characters-total',
      '10.20.30'
    )
    expect(longName.length).toBeLessThanOrEqual(63)
    expect(longName).toMatch(/^mcp-/)
  })

  it('returns 400 when serverName is invalid K8s name', async () => {
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'INVALID_NAME',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toContain('Invalid serverName')
  })

  it('returns 400 when contextRef is missing', async () => {
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-server',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toBe('contextRef is required')
  })

  it('returns 400 when registryEntryName is missing', async () => {
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-server',
        contextRef: 'default-context',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toBe('registryEntryName is required')
  })

  it('returns 400 when registryEntryVersion is missing', async () => {
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-server',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
      })
      .expect(400)

    expect(res.body.error).toBe('registryEntryVersion is required')
  })

  it('installs an MCP server with pending required credentials', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    expect(res.body.serverName).toBe('my-airtable')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'mcpEnvSecret',
        secretName: 'my-airtable-credentials',
        namespace: 'mcp-server',
        keys: ['AIRTABLE_API_KEY'],
        field: 'spec.envSecret',
      },
    ])
    expect(createSecretSpy).not.toHaveBeenCalled()
    const servers = await gw.listResource('mcpservers', 'mcp-server')
    expect(servers).toHaveLength(1)
    expect((servers[0] as { spec?: { envSecret?: { name?: string } } }).spec?.envSecret?.name).toBe(
      'my-airtable-credentials'
    )
  })

  it('returns 400 when credentials payload is not an object', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: 'not-an-object',
      })
      .expect(400)

    expect(res.body.error).toBe('credential.invalidPayload')
    expect(res.body.message).toBe('Credentials must be an object keyed by credential name.')
    expect(res.body.pendingAllowed).toBe(true)
    expect(createResourceSpy.mock.calls.find(call => call[0] === 'mcpservers')).toBeUndefined()
  })

  it('installs pending when all required credential values are empty', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: '   ' },
      })
      .expect(201)

    expect(res.body.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'mcpEnvSecret',
        secretName: 'my-airtable-credentials',
        keys: ['AIRTABLE_API_KEY'],
      }),
    ])
    expect(createSecretSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when some required credential values are missing', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      ...MOCK_SCHEMA_REQUIRED,
      keys: [{ name: 'AIRTABLE_API_KEY' }, { name: 'AIRTABLE_BASE_ID' }],
    })
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123', AIRTABLE_BASE_ID: '   ' },
      })
      .expect(400)

    expect(res.body.error).toBe('credential.incomplete')
    expect(res.body.message).toBe(
      'Complete all credential fields or clear them all to install pending.'
    )
    expect(res.body.missingKeys).toEqual(['AIRTABLE_BASE_ID'])
    expect(res.body.pendingAllowed).toBe(true)
    expect(createResourceSpy.mock.calls.find(call => call[0] === 'mcpservers')).toBeUndefined()
  })

  it('returns 400 when provided credential values look like placeholders', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_REQUIRED)
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: '${AIRTABLE_API_KEY}' },
      })
      .expect(400)

    expect(res.body.error).toBe('credential.placeholderValue')
    expect(res.body.message).toBe(
      'This value looks like a placeholder. Leave all credential fields empty to install pending, or enter the real credential value.'
    )
    expect(res.body.invalidKeys).toEqual(['AIRTABLE_API_KEY'])
    expect(res.body.pendingAllowed).toBe(true)
    expect(createResourceSpy.mock.calls.find(call => call[0] === 'mcpservers')).toBeUndefined()
  })

  // ── Org-scoped entry names (@<org>/<name>) ──────────────────────────────

  it('carries catalog-id as an annotation (not a label) for org-scoped @<org>/<name> installs', async () => {
    // Org-scoped names contain '@' and '/', which are illegal K8s LABEL values
    // (must match ^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$, ≤63 chars).
    // Putting the raw catalog-id in a label makes the apiserver reject the
    // McpServer/Secret with a 422. The fix moves catalog-id (and catalog-version)
    // into metadata.annotations, where arbitrary values are permitted.
    const K8S_LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/
    const K8S_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
    const scopedName = '@newtenantwf/conn'

    const scopedEntry = { ...MOCK_ENTRY, name: scopedName }
    vi.mocked(getEntryVersion).mockResolvedValue(scopedEntry)
    vi.mocked(getCredentialSchema).mockResolvedValue(MOCK_SCHEMA_REQUIRED)
    vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
    vi.mocked(searchEntries).mockResolvedValue({ data: [], total: 0 } as never)
    vi.mocked(getCategories).mockResolvedValue({ data: [] } as never)
    const { app, gw } = makeInstallApp()

    const createSecretSpy = vi.spyOn(gw, 'createSecret')
    const createResourceSpy = vi.spyOn(gw, 'createResource')

    await request(app)
      .post('/admin/registry/install')
      .send({
        // No serverName: rely on generateRegistryName to sanitize the scoped name.
        contextRef: 'default-context',
        registryEntryName: scopedName,
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: 'sk-test-token-123' },
      })
      .expect(201)

    // ── (a) catalog-id lives in annotations, NOT labels — on Secret + McpServer ──
    const secretArg = createSecretSpy.mock.calls[0]?.[0] as {
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
    expect(secretArg.annotations?.['clerum.io/catalog-id']).toBe(scopedName)
    expect(secretArg.annotations?.['clerum.io/catalog-version']).toBe('1.0.0')
    expect(secretArg.labels?.['clerum.io/catalog-id']).toBeUndefined()
    expect(secretArg.labels?.['clerum.io/catalog-version']).toBeUndefined()

    const mcpCall = createResourceSpy.mock.calls.find(c => c[0] === 'mcpservers')
    const mcpBody = mcpCall?.[1] as {
      metadata: {
        name: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
      }
    }
    expect(mcpBody.metadata.annotations?.['clerum.io/catalog-id']).toBe(scopedName)
    expect(mcpBody.metadata.annotations?.['clerum.io/catalog-version']).toBe('1.0.0')
    expect(mcpBody.metadata.labels?.['clerum.io/catalog-id']).toBeUndefined()
    expect(mcpBody.metadata.labels?.['clerum.io/catalog-version']).toBeUndefined()
    // managed-by / server-mode stay as labels (valid, selectable).
    expect(mcpBody.metadata.labels?.['clerum.io/managed-by']).toBe('control-api')
    expect(mcpBody.metadata.labels?.['clerum.io/server-mode']).toBe('local')

    // ── (b) metadata.name is a valid K8s name (≤63) — sanitized by generateRegistryName ──
    expect(mcpBody.metadata.name).toMatch(K8S_NAME)
    expect(mcpBody.metadata.name.length).toBeLessThanOrEqual(63)
    expect(secretArg).toBeDefined()
    const secretName = (secretArg as unknown as { name: string }).name
    expect(secretName).toMatch(K8S_NAME)
    expect(secretName.length).toBeLessThanOrEqual(63)

    // ── Guard: EVERY label value written is a valid K8s label value ──
    for (const call of createResourceSpy.mock.calls) {
      const labels = (call[1] as { metadata?: { labels?: Record<string, string> } }).metadata
        ?.labels
      for (const value of Object.values(labels ?? {})) {
        expect(value).toMatch(K8S_LABEL_VALUE)
        expect(value.length).toBeLessThanOrEqual(63)
      }
    }
    for (const call of createSecretSpy.mock.calls) {
      const labels = (call[0] as { labels?: Record<string, string> }).labels
      for (const value of Object.values(labels ?? {})) {
        expect(value).toMatch(K8S_LABEL_VALUE)
        expect(value.length).toBeLessThanOrEqual(63)
      }
    }

    // ── (c) Round-trip: getInstalledRegistryState reports it installed ──
    // Direct call against the same gateway the install wrote to.
    const state = await getInstalledRegistryState(
      gw as unknown as import('../src/k8s.js').K8sGateway
    )
    expect(state.catalogKeys).toContain(`${scopedName}@1.0.0`)

    // ── And through the catalog endpoint (the real UI consumer) ──
    const catalog = await request(app).get('/admin/registry/catalog').expect(200)
    expect(catalog.body.installed.catalogKeys).toContain(`${scopedName}@1.0.0`)
  })

  // ── Endpoint not registered without gateway ─────────────────────────────

  it('returns 404 when no gateway is provided', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    const app = makeApp() // No gateway

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-server',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(404)
  })

  it('installing an McpServer preserves spec.displayName on the target context (R4-B4)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce(MOCK_SCHEMA_NONE)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })

    const gw = new MockGateway('mcp-server')
    // Seed a context that ALREADY carries displayName plus an existing allowlist
    // entry — displayName is the additive field the allowlist update must not
    // drop when it rebuilds the context spec.
    await gw.createResource('contexts', {
      metadata: { name: 'ctx-keep' },
      spec: { contextId: 'ctx-keep', mcpServers: ['srv-other'], displayName: 'Keep Me' },
    })
    const app = makeApp(gw)

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-airtable',
        contextRef: 'ctx-keep',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    // Observable result (T4): re-read the persisted context. displayName survived
    // and the new server joined the allowlist alongside the pre-existing one.
    const ctx = (await gw.getResource('contexts', 'ctx-keep', 'mcp-server')) as {
      spec: { displayName?: string; mcpServers?: string[] }
    }
    expect(ctx.spec.displayName).toBe('Keep Me')
    expect(ctx.spec.mcpServers).toEqual(['srv-other', 'my-airtable'])
  })
})

describe('POST /admin/registry/install — image allowlist enforce (2.3)', () => {
  const origEnforce = config.enforcePluginImageAllowlist
  const origPrefixes = config.allowedPluginImagePrefixes
  beforeEach(() => {
    ;(config as { enforcePluginImageAllowlist: boolean }).enforcePluginImageAllowlist = true
    ;(config as { allowedPluginImagePrefixes: string[] }).allowedPluginImagePrefixes = [
      'example.com/',
    ]
  })
  afterEach(() => {
    ;(config as { enforcePluginImageAllowlist: boolean }).enforcePluginImageAllowlist = origEnforce
    ;(config as { allowedPluginImagePrefixes: string[] }).allowedPluginImagePrefixes = origPrefixes
  })

  it('rejects a local install whose image host is not allowed (422)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      id: '1',
      name: 'x',
      version: '1.0.0',
      entry_type: 'mcp-server',
      server_mode: 'local',
      transport: 'streamableHttp',
      mcp_server_meta: { imageRef: 'docker.io/evil/x:1', port: 3000 },
    } as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    const app = makeApp(gw)

    const res = await request(app).post('/admin/registry/install').send({
      serverName: 'x',
      contextRef: 'default-context',
      registryEntryName: 'x',
      registryEntryVersion: '1.0.0',
    })
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body)).toContain('image')
  })
})

describe('POST /admin/registry/install — evenfire imagePullSecrets attach', () => {
  const originalRegistryUrl = config.registryUrl
  beforeEach(() => {
    ;(config as { registryUrl: string }).registryUrl = 'https://example.com'
  })
  afterEach(() => {
    ;(config as { registryUrl: string }).registryUrl = originalRegistryUrl
  })

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    seedOperatorPullSecret(gw, 'example.com')
    return { app: makeApp(gw), gw }
  }

  const baseEntry = {
    id: '1',
    name: 'forecast',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Forecast MCP',
    author: 'acme',
    server_mode: 'local' as const,
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef: 'example.com/acme/forecast:1.2.3', port: 3000 },
  }

  it('sets imagePullSecrets for a local evenfire-hosted image', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(baseEntry as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'forecast',
        contextRef: 'default-context',
        registryEntryName: 'forecast',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'forecast', 'mcp-server')) as {
      spec: { imagePullSecrets?: Array<{ name: string }>; image?: string }
    }
    expect(mcp.spec.image).toBe('example.com/acme/forecast:1.2.3')
    expect(mcp.spec.imagePullSecrets).toEqual([{ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME }])
  })

  it('does NOT set imagePullSecrets for a local GCP-AR image', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...baseEntry,
      mcp_server_meta: {
        imageRef: 'us-central1-docker.pkg.dev/your-gcp-project/clerum/airtable-mcp:1.0',
        port: 3000,
      },
    } as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'airtable',
        contextRef: 'default-context',
        registryEntryName: 'forecast',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'airtable', 'mcp-server')) as {
      spec: { imagePullSecrets?: unknown }
    }
    expect(mcp.spec.imagePullSecrets).toBeUndefined()
  })

  it('does NOT set imagePullSecrets for a remote entry with an evenfire imageRef', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...baseEntry,
      server_mode: 'remote',
      mcp_server_meta: {
        imageRef: 'example.com/acme/forecast:1.2.3',
        port: 3000,
        remoteEndpoints: [{ url: 'https://forecast.acme.example.com/mcp' }],
      },
    } as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'forecast-remote',
        contextRef: 'default-context',
        registryEntryName: 'forecast',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const mcp = (await gw.getResource('mcpservers', 'forecast-remote', 'mcp-server')) as {
      spec: { imagePullSecrets?: unknown }
    }
    expect(mcp.spec.imagePullSecrets).toBeUndefined()
  })
})

describe('POST /admin/registry/install — evenfire imageRef identity (2.5)', () => {
  const originalRegistryUrl = config.registryUrl
  beforeEach(() => {
    ;(config as { registryUrl: string }).registryUrl = 'https://example.com'
  })
  afterEach(() => {
    ;(config as { registryUrl: string }).registryUrl = originalRegistryUrl
  })

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'default-context' },
      spec: { contextId: 'default-context', mcpServers: [] },
    })
    seedOperatorPullSecret(gw, 'example.com')
    return { app: makeApp(gw), gw }
  }

  const scopedEntry = (imageRef: string, name = '@acme/forecast') => ({
    id: '1',
    name,
    version: '1.0.0',
    entry_type: 'mcp-server',
    server_mode: 'local' as const,
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef, port: 3000 },
  })

  it('rejects (422) a scoped evenfire entry whose repo != entry name', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      scopedEntry('example.com/acme/wrongname:1.0.0') as any
    )
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    const { app } = makeInstallApp()
    const res = await request(app).post('/admin/registry/install').send({
      serverName: 'forecast',
      contextRef: 'default-context',
      registryEntryName: '@acme/forecast',
      registryEntryVersion: '1.0.0',
    })
    expect(res.status).toBe(422)
    // pin both interpolation slots: the actual (mismatched) repo and the expected name
    expect(JSON.stringify(res.body)).toContain('acme/wrongname')
    expect(JSON.stringify(res.body)).toContain('acme/forecast')
  })

  it('accepts a scoped evenfire entry whose repo == entry name', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      scopedEntry('example.com/acme/forecast:1.0.0') as any
    )
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'forecast',
        contextRef: 'default-context',
        registryEntryName: '@acme/forecast',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)
    const mcp = (await gw.getResource('mcpservers', 'forecast', 'mcp-server')) as {
      spec: { image?: string }
    }
    expect(mcp.spec.image).toBe('example.com/acme/forecast:1.0.0')
  })

  it('does not check an unscoped entry (GCP-AR / first-party path)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      scopedEntry('example.com/acme/anything:1.0.0', 'airtable-mcp') as any
    )
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'airtable',
        contextRef: 'default-context',
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)
  })
})

// ── POST /admin/registry/install-recipe ─────────────────────────────────────
describe('POST /admin/registry/install-recipe', () => {
  const MOCK_RECIPE_ENTRY = {
    id: 'r1',
    name: 'competitive-intel-report',
    version: '1.0.0',
    entry_type: 'recipe',
    description: 'Research + PDF report',
    author: 'clerum',
    origin: 'official',
    category: 'workflow',
    tags: ['research'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: null,
    transport: null,
    recipe_type: 'workflow',
    mcp_server_meta: null,
    recipe_meta: {
      recipeYaml: JSON.stringify({
        spec: {
          description: 'Competitive intel',
          steps: [{ id: 'research', description: 'Research step' }],
        },
      }),
      stepCount: 1,
      hasAgent: true,
    },
    artifact_refs: null,
    downloads: 5,
    installs: 2,
    created_at: '2026-03-01T00:00:00Z',
  }

  function makeRecipeApp() {
    const gw = new MockGateway('mcp-server')
    return { app: makeApp(gw), gw }
  }

  it('installs a recipe from registry (happy path)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(201)
    expect(res.body.recipeName).toMatch(/^recipe-/)
    expect(res.body.registryEntry).toBe('competitive-intel-report')
    expect(res.body.correlationId).toBeDefined()

    // catalog-id lives in annotations (org-scoped names are illegal label
    // values); managed-by stays a label.
    const call = createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call).toBeDefined()
    const body = call![1] as {
      metadata: { labels?: Record<string, string>; annotations?: Record<string, string> }
    }
    expect(body.metadata.annotations?.['clerum.io/catalog-id']).toBe('competitive-intel-report')
    expect(body.metadata.annotations?.['clerum.io/catalog-version']).toBe('1.0.0')
    expect(body.metadata.labels?.['clerum.io/catalog-id']).toBeUndefined()
    expect(body.metadata.labels?.['clerum.io/managed-by']).toBe('control-api')
  })

  it('rejects a registry recipe install whose envSecret is owned by another recipe (Issue #637)', async () => {
    const entry = {
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'my-api:latest',
                envSecret: {
                  name: 'foreign-cred',
                  keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
                },
              },
            ],
          },
        }),
        stepCount: 0,
        hasAgent: false,
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    const { app, gw } = makeRecipeApp()
    // The Secret exists in the namespace but belongs to another recipe — the
    // install path (third-party recipes) must reject it instead of creating a
    // recipe that would project a foreign credential.
    gw.seedSecret('foreign-cred', 'sandbox-recipes', {
      data: { apiKey: 'dmFsdWU=' },
      labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
    })
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(422)
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({ rule: 'workflowWorkloadSecretOwnershipDenied' })
    )
    // No WorkflowRecipe was created.
    expect(createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeUndefined()
  })

  it('installs a registry recipe with deferred snippet secretRef materialization', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            steps: [
              {
                id: 'snippet',
                run: {
                  type: 'snippet',
                  language: 'typescript',
                  code: 'return {}',
                  capabilities: {
                    secrets: [{ secretRef: { name: 'snippet-creds', key: 'apiKey' } }],
                  },
                },
              },
            ],
          },
        }),
        stepCount: 1,
        hasAgent: false,
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(201)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowSnippetSecret',
        secretName: 'snippet-creds',
        namespace: 'sandbox-recipes',
        keys: ['apiKey'],
        field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
      },
    ])
    expect(createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('installs a registry recipe with deferred oauth client secret materialization', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            oauthClients: [
              {
                id: 'github',
                clientIdRef: { name: 'github-oauth', key: 'clientId' },
                clientSecretRef: { name: 'github-oauth', key: 'clientSecret' },
              },
            ],
          },
        }),
        stepCount: 0,
        hasAgent: false,
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(201)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowOauthClientSecret',
        secretName: 'github-oauth',
        namespace: 'sandbox-recipes',
        keys: ['clientId', 'clientSecret'],
        field: 'spec.oauthClients[0].clientIdRef',
        fields: ['spec.oauthClients[0].clientIdRef', 'spec.oauthClients[0].clientSecretRef'],
      },
    ])
    expect(createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('rejects a registry recipe install with a missing imagePullSecret', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'private/api:latest',
                imagePullSecrets: ['pull-creds'],
              },
            ],
          },
        }),
        stepCount: 0,
        hasAgent: false,
      },
    })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(422)
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].imagePullSecrets[0]',
        rule: 'workflowWorkloadSecretNotFound',
      })
    )
    expect(createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeUndefined()
  })

  it('installs a registry recipe with deferred workload envSecret materialization', async () => {
    const entry = {
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'my-api:latest',
                envSecret: {
                  name: 'digest-creds',
                  keys: [
                    { secretKey: 'apiKey', envVar: 'API_KEY' },
                    { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
                  ],
                },
              },
            ],
          },
        }),
        stepCount: 0,
        hasAgent: false,
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
    })

    expect(res.status).toBe(201)
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowEnvSecret',
        secretName: 'digest-creds',
        namespace: 'sandbox-recipes',
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      },
    ])
    expect(createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('installs the operator-edited recipeManifest override from registry', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')
    const editedManifest = JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'operator-edited' },
      spec: {
        description: 'Operator edited manifest',
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'clerum/web-search:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            egressBindings: [{ dns: 'duckduckgo.com', port: 443, protocol: 'TCP' }],
          },
        ],
        steps: [
          { id: 'research', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
        ],
      },
    })

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
      recipeManifest: editedManifest,
    })

    expect(res.status).toBe(201)
    const call = createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call).toBeDefined()
    const body = call![1] as {
      spec: { description?: string; workloads?: Array<{ egressBindings?: unknown[] }> }
    }
    expect(body.spec.description).toBe('Operator edited manifest')
    expect(body.spec.workloads?.[0].egressBindings).toEqual([
      { dns: 'duckduckgo.com', port: 443, protocol: 'TCP' },
    ])
  })

  it('installs a recipeManifest override with declared cluster-local sibling egressBindings', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
      recipeManifest: internalSiblingRecipeYaml(),
    })

    expect(res.status).toBe(201)
    const call = createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call).toBeDefined()
    const body = call![1] as { spec: { workloads?: Array<{ egressBindings?: unknown[] }> } }
    expect(body.spec.workloads?.[0].egressBindings).toEqual([
      { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
    ])
  })

  it('rejects a recipeManifest override with cluster-local sibling egressBindings in another namespace', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'competitive-intel-report',
        registryEntryVersion: '1.0.0',
        recipeManifest: internalSiblingRecipeYaml('db.other.svc.cluster.local'),
      })

    expect(res.status).toBe(422)
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('targets namespace "other"'),
      })
    )
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid egress in recipeManifest override before creating WorkflowRecipe', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }])
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')
    const editedManifest = JSON.stringify({
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: { name: 'blocked-egress' },
      spec: {
        workloads: [
          {
            id: 'web-search',
            type: 'deployment',
            image: 'clerum/web-search:test',
            port: 3000,
            transport: { type: 'streamableHttp', path: '/mcp' },
            egressBindings: [{ dns: 'api.example.com', port: 443 }],
          },
        ],
        steps: [
          { id: 'research', run: { type: 'snippet', language: 'typescript', code: 'return {}' } },
        ],
      },
    })

    const res = await request(app).post('/admin/registry/install-recipe').send({
      registryEntryName: 'competitive-intel-report',
      registryEntryVersion: '1.0.0',
      recipeManifest: editedManifest,
    })

    expect(res.status).toBe(422)
    expect(res.body.errors[0].field).toBe('spec.workloads[0].egressBindings[0].dns')
    expect(res.body.errors[0].message).toContain('blocked')
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when entry is not a recipe', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      entry_type: 'mcp-server',
    })
    const { app } = makeRecipeApp()

    const res = await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'airtable-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toContain('not a recipe')
  })

  it('returns 422 when recipe has no YAML content', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: { recipeYaml: null },
    })
    const { app } = makeRecipeApp()

    await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'empty-recipe',
        registryEntryVersion: '1.0.0',
      })
      .expect(422)
  })

  it('rejects recipes above workflow runtime limits before creating the CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Too many steps',
            steps: Array.from({ length: 101 }, (_, i) => ({
              id: `s${i}`,
              instruction: `Step ${i}`,
            })),
          },
        }),
      },
    })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    const res = await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'competitive-intel-report',
        registryEntryVersion: '1.0.0',
      })
      .expect(422)

    expect(res.body.errors).toEqual([
      { field: 'spec.steps', message: 'must contain at most 100 items' },
    ])
    expect(createSpy).not.toHaveBeenCalledWith(
      'workflowrecipes',
      expect.any(Object),
      expect.any(String)
    )
  })

  it('uses custom recipeName when provided', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE_ENTRY)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeRecipeApp()

    const res = await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        recipeName: 'my-custom-recipe',
        registryEntryName: 'competitive-intel-report',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    expect(res.body.recipeName).toBe('my-custom-recipe')
  })

  it('merges inputValues into inputContract defaults', async () => {
    const entryWithContract = {
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Test',
            inputContract: { properties: { topic: { type: 'string', default: 'AI' } } },
            steps: [{ id: 's1', description: 'step' }],
          },
        }),
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryWithContract)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'competitive-intel-report',
        registryEntryVersion: '1.0.0',
        inputValues: { topic: 'Blockchain DeFi' },
      })
      .expect(201)

    const call = createSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call).toBeDefined()
    const spec = call![1].spec as Record<string, unknown>
    const contract = spec.inputContract as { properties: Record<string, { default?: unknown }> }
    expect(contract.properties.topic.default).toBe('Blockchain DeFi')
  })
})

// ── Credential schema validation (#9) ───────────────────────────────────────
describe('Credential schema validation', () => {
  const MOCK_ENTRY = {
    id: '1',
    name: 'test-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Test',
    author: 'test',
    server_mode: 'local',
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef: 'test:1.0', port: 3000 },
  }

  function makeApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'ctx1' },
      spec: { contextId: 'ctx1', mcpServers: [] },
    })
    return { app: makeApp_fn(gw), gw }
  }
  function makeApp_fn(gw: MockGateway) {
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return app
  }

  it('returns 502 when credential schema is malformed', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({ keys: 'not-an-array' } as any)
    const { app } = makeApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'test-srv',
        contextRef: 'ctx1',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(502)

    expect(res.body.error).toContain('invalid credential schema')
  })

  it('accepts valid credential schema', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app } = makeApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'test-srv',
        contextRef: 'ctx1',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)
  })

  it('falls back to embedded credential schema and installs pending when values are empty', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_ENTRY,
      mcp_server_meta: {
        imageRef: 'test:1.0',
        port: 3000,
        credentialSchema: {
          required: true,
          authType: 'api-key',
          keys: [
            {
              name: 'AIRTABLE_API_KEY',
              label: 'API Key',
              kind: 'api-key',
              semanticType: 'api-key',
              description: 'Airtable key',
            },
          ],
        },
      },
    } as any)
    vi.mocked(getCredentialSchema).mockRejectedValueOnce(new Error('Registry unavailable'))
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp()
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'test-srv',
        contextRef: 'ctx1',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { AIRTABLE_API_KEY: ' ' },
      })
      .expect(201)

    expect(res.body.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'mcpEnvSecret',
        secretName: 'test-srv-credentials',
        keys: ['AIRTABLE_API_KEY'],
      }),
    ])
    expect(createSecretSpy).not.toHaveBeenCalled()
  })
})

// ── InputValues type validation (#8) ────────────────────────────────────────
describe('Recipe inputValues type validation', () => {
  const MOCK_RECIPE = {
    id: 'r1',
    name: 'typed-recipe',
    version: '1.0.0',
    entry_type: 'recipe',
    description: 'Test',
    author: 'test',
    recipe_meta: {
      recipeYaml: JSON.stringify({
        spec: {
          description: 'Test',
          inputContract: {
            properties: {
              topic: { type: 'string', default: 'AI' },
              count: { type: 'number', default: 5 },
            },
          },
          steps: [{ id: 's1', instruction: 'Do something' }],
        },
      }),
    },
  }

  function makeApp() {
    const gw = new MockGateway('mcp-server')
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return app
  }

  it('rejects wrong type in inputValues (number where string expected)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE as any)
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'typed-recipe',
        registryEntryVersion: '1.0.0',
        inputValues: { topic: 42 },
      })
      .expect(400)

    expect(res.body.error).toContain('expected string')
  })

  it('accepts correct types in inputValues', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_RECIPE as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const app = makeApp()

    await request(app)
      .post('/admin/registry/install-recipe')
      .send({
        registryEntryName: 'typed-recipe',
        registryEntryVersion: '1.0.0',
        inputValues: { topic: 'Blockchain', count: 10 },
      })
      .expect(201)
  })
})

// ── SSRF validation ─────────────────────────────────────────────────────────
// Mirrors host-context-controller/src/__tests__/reconciler.remote.test.ts:676-793.
// validateRemoteUrl is the control-api's FIRST line of defense — HCC sanitizeRemoteUrl
// is defense-in-depth. Both layers MUST reject the same attack surface.
describe('SSRF remote URL validation', () => {
  const MOCK_REMOTE = {
    id: '1',
    name: 'ssrf-test',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Test',
    author: 'test',
    server_mode: 'remote',
    transport: 'streamableHttp',
    mcp_server_meta: { remoteEndpoints: [{ url: 'https://10.0.0.1:6379' }] },
  }

  function makeApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'ctx1' },
      spec: { contextId: 'ctx1', mcpServers: [] },
    })
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return app
  }

  /** Builds a mock remote registry entry with the given remote URL. */
  function entryWithUrl(url: string) {
    return { ...MOCK_REMOTE, mcp_server_meta: { remoteEndpoints: [{ url }] } }
  }

  /** POST /admin/registry/install and expect 4xx/5xx with reason substring. */
  async function expectRejection(url: string, reasonSubstring?: string) {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryWithUrl(url) as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const app = makeApp()

    const res = await request(app).post('/admin/registry/install').send({
      serverName: 'ssrf-test',
      contextRef: 'ctx1',
      registryEntryName: 'ssrf-test',
      registryEntryVersion: '1.0.0',
    })

    // Any 4xx/5xx is acceptable — never a 201 (install succeeded).
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(600)
    expect(res.status).not.toBe(201)
    expect(res.body.error).toBeTruthy()
    if (reasonSubstring) {
      expect(String(res.body.error)).toContain(reasonSubstring)
    }
  }

  // ─── Existing tests (kept for regression coverage) ─────────────────────
  it('rejects private IP in remote endpoint', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_REMOTE as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'ssrf-test',
        contextRef: 'ctx1',
        registryEntryName: 'ssrf-test',
        registryEntryVersion: '1.0.0',
      })
      .expect(500)

    expect(res.body.error).toContain('Private IP')
  })

  it('rejects cluster-internal URL', async () => {
    const entry = {
      ...MOCK_REMOTE,
      mcp_server_meta: {
        remoteEndpoints: [{ url: 'https://kubernetes.default.svc.cluster.local' }],
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entry as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'ssrf-k8s',
        contextRef: 'ctx1',
        registryEntryName: 'ssrf-test',
        registryEntryVersion: '1.0.0',
      })
      .expect(500)

    expect(res.body.error).toContain('Cluster-internal')
  })

  // ─── Scheme / malformed ────────────────────────────────────────────────
  it('rejects HTTP (non-HTTPS) URLs', async () => {
    await expectRejection('http://mcp.sentry.io/sse', 'HTTPS')
  })

  it('rejects malformed URL', async () => {
    await expectRejection('not-a-url')
  })

  it('rejects empty string URL', async () => {
    await expectRejection('')
  })

  // ─── Cluster-internal DNS ──────────────────────────────────────────────
  it('rejects .svc.cluster.local internal cluster services', async () => {
    await expectRejection(
      'https://control-api.control-plane.svc.cluster.local:8090/api',
      'Cluster-internal'
    )
  })

  it('rejects .svc short cluster DNS suffix', async () => {
    await expectRejection('https://control-api.control-plane.svc:8090/api', 'Cluster-internal')
  })

  it('rejects kubernetes.default', async () => {
    await expectRejection('https://kubernetes.default:443/api', 'Cluster-internal')
  })

  // ─── IPv4 private / reserved ranges ────────────────────────────────────
  it('rejects RFC1918 10.x.x.x private IPs', async () => {
    await expectRejection('https://10.0.0.1:443/api', 'Private IP')
  })

  it('rejects RFC1918 172.16-31.x.x private IPs', async () => {
    await expectRejection('https://172.16.0.1:443/api', 'Private IP')
  })

  it('rejects RFC1918 192.168.x.x private IPs', async () => {
    await expectRejection('https://192.168.1.1:443/api', 'Private IP')
  })

  it('rejects loopback 127.x.x.x addresses', async () => {
    await expectRejection('https://127.0.0.1:443/api', 'Private IP')
  })

  it('rejects link-local 169.254.x.x (AWS/GCP metadata endpoint)', async () => {
    // 169.254.169.254 is the cloud instance metadata service —
    // the #1 SSRF target (Capital One breach, CVE-2019-5736-class issues).
    await expectRejection('https://169.254.169.254:443/latest/meta-data', 'Private IP')
  })

  it('rejects wildcard 0.0.0.0 address', async () => {
    await expectRejection('https://0.0.0.0:443/api', 'Private IP')
  })

  // ─── IPv6 literals ─────────────────────────────────────────────────────
  it('rejects IPv6 loopback [::1]', async () => {
    await expectRejection('https://[::1]:443/api')
  })

  it('rejects IPv6-mapped IPv4 loopback [::ffff:7f00:1] (bypass attempt)', async () => {
    // ::ffff:7f00:1 == ::ffff:127.0.0.1 — classic IPv4-mapped-IPv6 loopback
    // used to bypass naive IPv4-only SSRF filters.
    await expectRejection('https://[::ffff:7f00:1]:443/api')
  })

  // ─── CRLF injection ────────────────────────────────────────────────────
  it('handles CRLF injection attempt deterministically (no crash, no injection leak)', async () => {
    // WHATWG URL parser strips \r\n during construction and percent-encodes
    // residual characters. We assert the request is handled without an
    // unhandled crash and that no raw CR/LF reaches downstream state.
    // The URL normalizes to api.example.com (a public DNS host), so this
    // SHOULD succeed — but MUST NOT propagate \r\n into any response field.
    const malicious = 'https://api.example.com/path\r\nX-Inject: evil'
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryWithUrl(malicious) as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const app = makeApp()

    const res = await request(app).post('/admin/registry/install').send({
      serverName: 'crlf-test',
      contextRef: 'ctx1',
      registryEntryName: 'ssrf-test',
      registryEntryVersion: '1.0.0',
    })

    // Response must be a clean status (either accepted after normalization,
    // or rejected cleanly) — NEVER a 500 caused by an unhandled crash parsing
    // the URL, and NEVER contain raw CR/LF in response body.
    expect([200, 201, 400, 422, 500]).toContain(res.status)
    const bodyStr = JSON.stringify(res.body)
    expect(bodyStr).not.toContain('\r')
    expect(bodyStr).not.toContain('\n')
    expect(bodyStr).not.toContain('X-Inject')
  })

  // ─── Positive cases — valid HTTPS URLs must succeed ────────────────────
  it('accepts valid HTTPS URL with path (returns 201)', async () => {
    const url = 'https://api.example.com/v1/mcp/sse'
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryWithUrl(url) as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'accept-path',
        contextRef: 'ctx1',
        registryEntryName: 'ssrf-test',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    expect(res.body.serverName).toBe('accept-path')
  })

  it('accepts valid HTTPS URL with explicit port (returns 201)', async () => {
    const url = 'https://api.example.com:8443/mcp'
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryWithUrl(url) as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const app = makeApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'accept-port',
        contextRef: 'ctx1',
        registryEntryName: 'ssrf-test',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    expect(res.body.serverName).toBe('accept-port')
  })
})

// ── Uninstall flow (§9.5) ───────────────────────────────────────────────────
describe('DELETE /admin/registry/uninstall/:serverName', () => {
  function makeApp(gw = new MockGateway('mcp-server')) {
    if (!(gw as unknown as { _seeded?: boolean })._seeded) {
      gw.createResource('mcpservers', {
        metadata: { name: 'installed-srv' },
        spec: { image: 'test:1.0' },
      })
      gw.createResource('contexts', {
        metadata: { name: 'ctx1' },
        spec: { contextId: 'ctx1', mcpServers: ['installed-srv'] },
      })
      ;(gw as unknown as { _seeded?: boolean })._seeded = true
    }
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return { app, gw }
  }

  it('deletes McpServer + removes from context', async () => {
    const { app } = makeApp()

    const res = await request(app).delete('/admin/registry/uninstall/installed-srv').expect(200)

    expect(res.body.deleted).toContain('McpServer/installed-srv')
    expect(res.body.deleted.some((d: string) => d.includes('Context/ctx1'))).toBe(true)
    expect(res.body.resourceType).toBe('mcp-server')
  })

  it('waits for McpServer and Secret deletion to settle before returning', async () => {
    class EventuallyDeletingGateway extends MockGateway {
      resourceReadChecks = 0
      secretReadChecks = 0
      private readonly staleResourceReads = new Map<string, number>()
      private readonly staleSecretReads = new Map<string, number>()

      override async deleteResource(
        plural: 'hosts' | 'contexts' | 'communicationchannels' | 'mcpservers' | 'workflowrecipes',
        name: string,
        namespace?: string,
        precondition?: import('../src/types.js').ResourcePreconditions
      ): Promise<unknown> {
        const ns = namespace || this.getNamespace()
        if (plural === 'mcpservers') {
          this.staleResourceReads.set(`${ns}/${name}`, 1)
        }
        return super.deleteResource(plural, name, namespace, precondition)
      }

      override async getResource(
        plural: 'hosts' | 'contexts' | 'communicationchannels' | 'mcpservers' | 'workflowrecipes',
        name: string,
        namespace?: string
      ): Promise<unknown> {
        const ns = namespace || this.getNamespace()
        if (plural === 'mcpservers') {
          this.resourceReadChecks += 1
          const key = `${ns}/${name}`
          const remaining = this.staleResourceReads.get(key)
          if (typeof remaining === 'number') {
            if (remaining > 0) {
              this.staleResourceReads.set(key, remaining - 1)
              return { metadata: { name, namespace: ns } }
            }
            this.staleResourceReads.delete(key)
          }
        }
        return super.getResource(plural, name, namespace)
      }

      override async deleteSecret(name: string, namespace?: string): Promise<unknown> {
        const ns = namespace || this.getNamespace()
        this.staleSecretReads.set(`${ns}/${name}`, 1)
        return super.deleteSecret(name, namespace)
      }

      override async getSecret(name: string, namespace?: string): Promise<unknown> {
        const ns = namespace || this.getNamespace()
        this.secretReadChecks += 1
        const key = `${ns}/${name}`
        const remaining = this.staleSecretReads.get(key)
        if (typeof remaining === 'number') {
          if (remaining > 0) {
            this.staleSecretReads.set(key, remaining - 1)
            return { metadata: { name, namespace: ns }, type: 'Opaque' }
          }
          this.staleSecretReads.delete(key)
        }
        return super.getSecret(name, namespace)
      }
    }

    const gw = new EventuallyDeletingGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'installed-srv' },
      spec: { image: 'test:1.0' },
    })
    gw.createResource('contexts', {
      metadata: { name: 'ctx1' },
      spec: { contextId: 'ctx1', mcpServers: ['installed-srv'] },
    })
    gw.seedSecret('installed-srv-credentials')
    ;(gw as unknown as { _seeded?: boolean })._seeded = true
    const { app } = makeApp(gw as unknown as MockGateway)

    const res = await request(app).delete('/admin/registry/uninstall/installed-srv').expect(200)

    expect(res.body.deleted).toContain('McpServer/installed-srv')
    expect(res.body.deleted).toContain('Secret/installed-srv-credentials')
    expect(gw.resourceReadChecks).toBeGreaterThanOrEqual(2)
    expect(gw.secretReadChecks).toBeGreaterThanOrEqual(2)
  })

  it('handles non-existent server gracefully', async () => {
    const { app } = makeApp()

    const res = await request(app).delete('/admin/registry/uninstall/nonexistent').expect(200)

    expect(res.body.resourceName).toBe('nonexistent')
  })

  it('does not delete a replacement Secret that wins after the resource delete', async () => {
    const gw = new MockGateway('mcp-server')
    await gw.createResource(
      'mcpservers',
      { metadata: { name: 'secret-race' }, spec: { image: 'test:original' } },
      'mcp-server'
    )
    const secretName = 'secret-race-credentials'
    gw.seedSecret(secretName, 'mcp-server', {
      uid: 'uid-secret-original',
      resourceVersion: '1',
    })
    ;(gw as unknown as { _seeded?: boolean })._seeded = true

    const originalDeleteResource = gw.deleteResource.bind(gw)
    let raced = false
    vi.spyOn(gw, 'deleteResource').mockImplementation(async (...args) => {
      if (args[0] === 'mcpservers' && !raced) {
        raced = true
        const result = await originalDeleteResource(...args)
        await gw.deleteSecret(secretName, 'mcp-server')
        gw.seedSecret(secretName, 'mcp-server', {
          uid: 'uid-secret-replacement',
          resourceVersion: '1',
        })
        return result
      }
      return originalDeleteResource(...args)
    })

    const { app } = makeApp(gw)
    const res = await request(app).delete('/admin/registry/uninstall/secret-race').expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_uninstall_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(gw.getSecret(secretName, 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: 'uid-secret-replacement', resourceVersion: '1' },
    })
  })

  it('does not delete a same-name replacement that wins the uninstall race', async () => {
    const gw = new MockGateway('mcp-server')
    await gw.createResource('mcpservers', {
      metadata: { name: 'race-target' },
      spec: { image: 'test:original' },
    })
    ;(gw as unknown as { _seeded?: boolean })._seeded = true
    const originalDelete = gw.deleteResource.bind(gw)
    let raced = false
    vi.spyOn(gw, 'deleteResource').mockImplementation(async (...args) => {
      if (args[0] === 'mcpservers' && !raced) {
        raced = true
        await originalDelete('mcpservers', 'race-target', 'mcp-server')
        await gw.createResource(
          'mcpservers',
          { metadata: { name: 'race-target' }, spec: { image: 'test:replacement' } },
          'mcp-server'
        )
      }
      return originalDelete(...args)
    })
    const { app } = makeApp(gw)

    const res = await request(app).delete('/admin/registry/uninstall/race-target').expect(503)

    expect(res.body.deleted).not.toContain('McpServer/race-target')
    expect(res.body).toMatchObject({
      error: 'registry_uninstall_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(gw.getResource('mcpservers', 'race-target', 'mcp-server')).resolves.toMatchObject({
      spec: { image: 'test:replacement' },
    })
  })

  it('deletes WorkflowRecipe when type=recipe', async () => {
    const { app, gw } = makeApp()
    gw.createResource(
      'workflowrecipes',
      {
        metadata: { name: 'my-recipe' },
        spec: { description: 'test' },
      },
      config.sandboxNamespace
    )

    const res = await request(app)
      .delete('/admin/registry/uninstall/my-recipe?type=recipe')
      .expect(200)

    expect(res.body.deleted).toContain('WorkflowRecipe/my-recipe')
    expect(res.body.resourceType).toBe('recipe')
  })

  it('returns 400 for invalid name', async () => {
    const { app } = makeApp()

    await request(app).delete('/admin/registry/uninstall/INVALID').expect(400)
  })

  it('uninstalling an McpServer preserves spec.displayName on referencing contexts (R4-B5)', async () => {
    const gw = new MockGateway('mcp-server')
    await gw.createResource('mcpservers', {
      metadata: { name: 'srv-target' },
      spec: { image: 'test:1.0' },
    })
    // Context references the server being uninstalled AND carries displayName —
    // the additive field the allowlist-pruning rebuild must not drop.
    await gw.createResource('contexts', {
      metadata: { name: 'ctx-keep' },
      spec: {
        contextId: 'ctx-keep',
        mcpServers: ['srv-target', 'srv-other'],
        displayName: 'Keep Me',
      },
    })
    // Suppress makeApp's default installed-srv/ctx1 seed so the store holds only
    // the fixtures this assertion cares about.
    ;(gw as unknown as { _seeded?: boolean })._seeded = true
    const { app } = makeApp(gw)

    await request(app).delete('/admin/registry/uninstall/srv-target').expect(200)

    // Observable result (T4): re-read the persisted context. displayName survived
    // and only the uninstalled server left the allowlist.
    const ctx = (await gw.getResource('contexts', 'ctx-keep', 'mcp-server')) as {
      spec: { displayName?: string; mcpServers?: string[] }
    }
    expect(ctx.spec.displayName).toBe('Keep Me')
    expect(ctx.spec.mcpServers).toEqual(['srv-other'])
  })
})

// ── Upgrade flow (§9.4) ─────────────────────────────────────────────────────
describe('POST /admin/registry/upgrade', () => {
  const MOCK_ENTRY_V2 = {
    id: '1',
    name: 'test-mcp',
    version: '2.0.0',
    entry_type: 'mcp-server',
    description: 'Test v2',
    author: 'test',
    server_mode: 'local',
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef: 'test:2.0', port: 3000 },
  }

  function makeApp(existingSpecPatch: Record<string, unknown> = {}) {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-srv' },
      spec: {
        image: 'test:1.0',
        contextRef: 'ctx1',
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: 'http://my-srv.mcp-server.svc:3000/mcp',
        },
        ...existingSpecPatch,
      },
    })
    const app = express()
    app.use(express.json())
    app.use(createAdminRegistryRouter(gw as unknown as import('../src/k8s.js').K8sGateway))
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return { app, gw }
  }

  it('upgrades existing server to new version', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp()
    const before = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      metadata?: { uid?: string }
    }
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    expect(res.body.upgraded).toBe(true)
    expect(res.body.registryVersion).toBe('2.0.0')
    expect(updateSpy).toHaveBeenCalledWith(
      'mcpservers',
      'my-srv',
      expect.any(Object),
      expect.any(String)
    )
    const updateBody = updateSpy.mock.calls.find(call => call[0] === 'mcpservers')?.[2] as {
      metadata?: { uid?: string }
    }
    expect(updateBody.metadata?.uid).toBe(before.metadata?.uid)
  })

  it('does not overwrite a same-name CR replacement with a new identity', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    const { app, gw } = makeApp()
    const originalUpdate = gw.updateResource.bind(gw)
    let replaced = false
    const updateSpy = vi.spyOn(gw, 'updateResource').mockImplementation(async (...args) => {
      if (args[0] === 'mcpservers' && !replaced) {
        replaced = true
        await gw.deleteResource('mcpservers', 'my-srv', 'mcp-server')
        await gw.createResource(
          'mcpservers',
          { metadata: { name: 'my-srv' }, spec: { image: 'replacement:1' } },
          'mcp-server'
        )
      }
      return originalUpdate(...args)
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_upgrade_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(updateSpy).toHaveBeenCalled()
    await expect(gw.getResource('mcpservers', 'my-srv', 'mcp-server')).resolves.toMatchObject({
      spec: { image: 'replacement:1' },
    })
  })

  it('does not treat a pre-existing target catalog annotation as proof of a committed upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: ['API', '_KEY'].join('') }],
    })
    const { app, gw } = makeApp()
    const existing = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: Record<string, unknown>
    }
    await gw.updateResource(
      'mcpservers',
      'my-srv',
      {
        metadata: {
          annotations: {
            'clerum.io/catalog-id': 'test-mcp',
            'clerum.io/catalog-version': '2.0.0',
          },
        },
        spec: existing.spec,
      },
      'mcp-server'
    )
    const originalUpdate = gw.updateResource.bind(gw)
    let firstFailure = true
    const updateSpy = vi.spyOn(gw, 'updateResource').mockImplementation(async (...args) => {
      if (firstFailure) {
        firstFailure = false
        throw Object.assign(new Error('apiserver transport failure'), {
          code: 500,
          statusCode: 500,
        })
      }
      return originalUpdate(...args)
    })
    const authField = ['creden', 'tials'].join('')
    const secretName = ['my-srv', ['cred', 'entials'].join('')].join('-')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        [authField]: { ['API_KEY']: 'fresh-value' },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_upgrade_outcome_not_committed',
      outcome: 'not_committed',
    })
    expect(updateSpy).toHaveBeenCalled()
    await expect(gw.getSecret(secretName, 'mcp-server')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('persists envSecret and returns pendingCredentials during MCP upgrade when credentials remain unmaterialized', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp()
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'mcpEnvSecret',
        secretName: 'my-srv-credentials',
        namespace: 'mcp-server',
        keys: ['API_KEY'],
        field: 'spec.envSecret',
      },
    ])
    expect(createSecretSpy).not.toHaveBeenCalled()
    const server = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec?: {
        envSecret?: { name?: string; keys?: Array<{ secretKey?: string; envVar?: string }> }
      }
    }
    expect(server.spec?.envSecret).toEqual({
      name: 'my-srv-credentials',
      keys: [{ secretKey: 'API_KEY', envVar: 'API_KEY' }],
    })
  })

  it('removes stale envSecret during MCP upgrade when the new version does not require credentials', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp({
      envSecret: {
        name: 'my-srv-credentials',
        keys: [{ secretKey: 'API_KEY', envVar: 'API_KEY' }],
      },
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    expect(res.body.pendingCredentials).toEqual([])
    const server = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec?: { envSecret?: unknown }
    }
    expect(server.spec?.envSecret).toBeUndefined()
  })

  it('re-derives exact-host egressBindings during local server upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_ENTRY_V2,
      mcp_server_meta: {
        imageRef: 'test:2.0',
        port: 3000,
        egressSummary: { domains: ['api.example.com'], ports: [443], wideCidr: false },
      },
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp({
      egressBindings: [{ dns: 'old.example.com', port: 443, protocol: 'TCP' }],
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toEqual([
      { dns: 'api.example.com', port: 443, protocol: 'TCP' },
    ])
  })

  it('honors an explicit empty egress override during local server upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_ENTRY_V2,
      mcp_server_meta: {
        imageRef: 'test:2.0',
        port: 3000,
        egressSummary: { domains: ['api.example.com'], ports: [443], wideCidr: false },
      },
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp({
      egressBindings: [{ dns: 'old.example.com', port: 443, protocol: 'TCP' }],
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        egressBindings: [],
      })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toEqual([])
  })

  it('removes stale egressBindings when upgraded local metadata has no egressSummary', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp({
      egressBindings: [{ dns: 'old.example.com', port: 443, protocol: 'TCP' }],
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { egressBindings?: unknown[] }
    }
    expect(mcp.spec.egressBindings).toBeUndefined()
  })

  it('rejects partial auth payloads during upgrade before touching the server', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'FIRST' }, { name: 'SECOND' }],
    })
    const { app, gw } = makeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        ['creden' + 'tials']: { FIRST: 'real-value', SECOND: '   ' },
      })
      .expect(400)

    expect(res.body.error).toBe('credential.incomplete')
    expect(updateSpy).not.toHaveBeenCalled()
    expect(createSecretSpy).not.toHaveBeenCalled()
  })

  it('rejects placeholder auth payloads during upgrade before touching the server', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'ACCESS' }],
    })
    const { app, gw } = makeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        ['creden' + 'tials']: { ACCESS: 'changeme' },
      })
      .expect(400)

    expect(res.body.error).toBe('credential.placeholderValue')
    expect(updateSpy).not.toHaveBeenCalled()
    expect(createSecretSpy).not.toHaveBeenCalled()
  })

  it('re-derives remote endpoint egressBindings during remote server upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_ENTRY_V2,
      server_mode: 'remote',
      transport: 'sse',
      mcp_server_meta: {
        port: 3000,
        remoteEndpoints: [{ url: 'https://API.Vendor.Example/sse' }],
      },
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp({
      egressBindings: [{ dns: 'old.vendor.example', port: 443, protocol: 'TCP' }],
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: {
        image?: string
        remote?: { baseUrl?: string }
        egressBindings?: unknown[]
        transport?: { url?: string }
      }
    }
    expect(mcp.spec.image).toContain('nginx-egress-proxy')
    expect(mcp.spec.remote?.baseUrl).toBe('https://API.Vendor.Example/sse')
    expect(mcp.spec.transport?.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/sse')
    expect(mcp.spec.egressBindings).toEqual([
      { dns: 'api.vendor.example', port: 443, protocol: 'TCP' },
    ])
  })

  it('returns 404 when server does not exist', async () => {
    const { app } = makeApp()

    await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'nonexistent',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
      })
      .expect(404)
  })

  it('proves a commit after the CR update response is lost', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp()
    gw.setResourceUpdateFault(() => {
      throw Object.assign(new Error('response lost after commit'), {
        code: 500,
        statusCode: 500,
      })
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    expect(res.body.upgraded).toBe(true)
    const current = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      metadata?: { annotations?: Record<string, string> }
      spec?: { image?: string }
    }
    expect(current.spec?.image).toBe('test:2.0')
    expect(current.metadata?.annotations?.['clerum.io/registry-operation-id']).toMatch(
      /^[0-9a-f-]{36}$/
    )
  })

  it('does not compensate after a stale pre-update read precedes a committed upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeApp()
    const originalGetResource = gw.getResource.bind(gw)
    const before = await originalGetResource('mcpservers', 'my-srv', 'mcp-server')
    let readbackStarted = false
    let staleReadPending = true

    gw.setResourceUpdateFault(({ plural }) => {
      if (plural !== 'mcpservers') return
      gw.setResourceUpdateFault(null)
      readbackStarted = true
      throw Object.assign(new Error('response lost after commit'), {
        code: 500,
        statusCode: 500,
      })
    })
    vi.spyOn(gw, 'getResource').mockImplementation(async (...args) => {
      if (readbackStarted && staleReadPending && args[0] === 'mcpservers' && args[1] === 'my-srv') {
        staleReadPending = false
        return before
      }
      return originalGetResource(...args)
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(200)

    expect(res.body.upgraded).toBe(true)
    const current = (await originalGetResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec?: { image?: string }
    }
    expect(current.spec?.image).toBe('test:2.0')
  })

  it('does not turn repeated stale prior reads into a no-commit verdict', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const field = ['API', 'KEY'].join('_')
    const oldValue = ['old', 'value'].join('-')
    const nextValue = ['next', 'value'].join('-')
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'uid-upgrade-credentials',
      resourceVersion: '1',
      data: { [field]: Buffer.from(oldValue).toString('base64') },
    })
    const originalGetResource = gw.getResource.bind(gw)
    const before = await originalGetResource('mcpservers', 'my-srv', 'mcp-server')
    let readbackStarted = false
    let staleReadsRemaining = 3
    gw.setResourceUpdateFault(({ plural }) => {
      if (plural !== 'mcpservers') return
      gw.setResourceUpdateFault(null)
      readbackStarted = true
      throw Object.assign(new Error('response lost after commit'), {
        code: 500,
        statusCode: 500,
      })
    })
    vi.spyOn(gw, 'getResource').mockImplementation(async (...args) => {
      if (
        readbackStarted &&
        staleReadsRemaining > 0 &&
        args[0] === 'mcpservers' &&
        args[1] === 'my-srv'
      ) {
        staleReadsRemaining -= 1
        return before
      }
      return originalGetResource(...args)
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { [field]: nextValue },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_upgrade_outcome_ambiguous',
      outcome: 'repair_required',
    })
    const current = (await originalGetResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec?: { image?: string }
    }
    expect(current.spec?.image).toBe('test:2.0')
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      stringData: { [field]: nextValue },
    })
  })

  it('refuses to classify a concurrent post-commit mutation as this upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    const { app, gw } = makeApp()
    gw.setResourceUpdateFault(async ({ snapshot }) => {
      gw.setResourceUpdateFault(null)
      await gw.updateResource(
        'mcpservers',
        'my-srv',
        {
          metadata: {
            resourceVersion: snapshot.metadata.resourceVersion,
            labels: { ...(snapshot.metadata.labels ?? {}), 'clerum.io/server-mode': 'concurrent' },
          },
          spec: { ...snapshot.spec, image: 'test:concurrent' },
        },
        'mcp-server'
      )
      throw Object.assign(new Error('response lost after concurrent writer'), {
        code: 500,
        statusCode: 500,
      })
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(503)

    expect(res.body.error).toBe('registry_upgrade_outcome_ambiguous')
    const current = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec?: { image?: string }
    }
    expect(current.spec?.image).toBe('test:concurrent')
  })

  it('leaves the upgrade outcome ambiguous when readback itself fails', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    const { app, gw } = makeApp()
    let committed = false
    gw.setResourceUpdateFault(() => {
      committed = true
      throw Object.assign(new Error('response lost'), { code: 500, statusCode: 500 })
    })
    const originalGetResource = gw.getResource.bind(gw)
    const getResourceSpy = vi.spyOn(gw, 'getResource').mockImplementation(async (...args) => {
      if (committed && args[0] === 'mcpservers') {
        throw Object.assign(new Error('readback unavailable'), { code: 503, statusCode: 503 })
      }
      return originalGetResource(...args)
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'test-mcp', registryEntryVersion: '2.0.0' })
      .expect(503)

    expect(res.body.error).toBe('registry_upgrade_outcome_ambiguous')
    expect(getResourceSpy).toHaveBeenCalled()
    getResourceSpy.mockRestore()
  })

  it('compensates credentials after a CAS fence proves the CR update did not commit', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const originalUpdate = gw.updateResource.bind(gw)
    let originalWrite = true
    const updateSpy = vi.spyOn(gw, 'updateResource').mockImplementation(async (...args) => {
      if (originalWrite) {
        originalWrite = false
        throw Object.assign(new Error('transport failed before commit'), {
          code: 503,
          statusCode: 503,
        })
      }
      return originalUpdate(...args)
    })
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: ['fresh', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_upgrade_outcome_not_committed',
      outcome: 'not_committed',
    })
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(deleteSecretSpy).toHaveBeenCalledWith(
      'my-srv-credentials',
      'mcp-server',
      expect.objectContaining({ uid: expect.any(String), resourceVersion: expect.any(String) })
    )
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('does not mistake a same-UID concurrent rotation for this upgrade', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const secretName = ['my-srv', 'credentials'].join('-')
    const field = ['API', 'KEY'].join('_')
    const oldValue = ['old', 'value'].join('-')
    const concurrentValue = ['concurrent', 'value'].join('-')
    gw.seedSecret(secretName, 'mcp-server', {
      type: 'Opaque',
      uid: 'uid-existing-credentials',
      resourceVersion: '1',
      data: { [field]: Buffer.from(oldValue).toString('base64') },
    })
    gw.setSecretWriteFault(async ({ operation }) => {
      if (operation !== 'update') return
      gw.setSecretWriteFault(null)
      await gw.mergeSecret(
        {
          name: secretName,
          namespace: 'mcp-server',
          stringData: { [field]: concurrentValue },
        },
        {
          allowExistingPlatformAnnotationKeys: [
            'clerum.io/catalog-id',
            'clerum.io/catalog-version',
            'clerum.io/registry-operation-id',
          ],
        }
      )
      throw Object.assign(new Error('response lost after concurrent rotation'), {
        code: 500,
        statusCode: 500,
      })
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('CR update failed before commit'), { code: 503, statusCode: 503 })
    )

    const authField = ['creden', 'tials'].join('')
    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        [authField]: { [field]: ['registry', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    const current = await gw.getSecret(secretName, 'mcp-server')
    expect(current.metadata?.uid).toBe('uid-existing-credentials')
    expect(current.stringData).toEqual({ [field]: concurrentValue })
  })

  it('does not compensate after a same-UID metadata-only concurrent mutation', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const secretName = ['my-srv', 'credentials'].join('-')
    const field = ['API', 'KEY'].join('_')
    gw.seedSecret(secretName, 'mcp-server', {
      type: 'Opaque',
      uid: 'uid-existing-credentials',
      resourceVersion: '1',
      data: { [field]: Buffer.from(['old', 'value'].join('-')).toString('base64') },
    })
    gw.setSecretWriteFault(async ({ operation }) => {
      if (operation !== 'update') return
      gw.setSecretWriteFault(null)
      await gw.mergeSecret(
        {
          name: secretName,
          namespace: 'mcp-server',
          annotations: { 'concurrent.example/trace': 'writer-b' },
        },
        {
          allowExistingPlatformAnnotationKeys: [
            'clerum.io/catalog-id',
            'clerum.io/catalog-version',
            'clerum.io/registry-operation-id',
          ],
        }
      )
      throw Object.assign(new Error('response lost after metadata-only concurrent mutation'), {
        code: 500,
        statusCode: 500,
      })
    })
    const updateSpy = vi
      .spyOn(gw, 'updateResource')
      .mockRejectedValue(
        Object.assign(new Error('CR update must not be reached'), { code: 409, statusCode: 409 })
      )

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { [field]: ['registry', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(updateSpy).not.toHaveBeenCalled()
    await expect(gw.getSecret(secretName, 'mcp-server')).resolves.toMatchObject({
      metadata: { annotations: { 'concurrent.example/trace': 'writer-b' } },
    })
  })

  it('does not adopt a same-UID same-state writer resourceVersion as a commit receipt', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const secretName = ['my-srv', 'credentials'].join('-')
    const field = ['API', 'KEY'].join('_')
    gw.seedSecret(secretName, 'mcp-server', {
      type: 'Opaque',
      uid: 'uid-existing-credentials',
      resourceVersion: '1',
      data: { [field]: Buffer.from(['old', 'value'].join('-')).toString('base64') },
    })
    gw.setSecretWriteFault(async ({ operation, snapshot }) => {
      if (operation !== 'update') return
      gw.setSecretWriteFault(null)
      await gw.mergeSecret(
        {
          name: secretName,
          namespace: 'mcp-server',
          labels: snapshot.labels,
          annotations: snapshot.annotations,
          data: snapshot.data,
          stringData: snapshot.stringData,
        },
        {
          allowExistingPlatformAnnotationKeys: [
            'clerum.io/catalog-id',
            'clerum.io/catalog-version',
            'clerum.io/registry-operation-id',
          ],
        }
      )
      throw Object.assign(new Error('response lost after same-state concurrent writer'), {
        code: 500,
        statusCode: 500,
      })
    })
    const updateResourceSpy = vi
      .spyOn(gw, 'updateResource')
      .mockRejectedValue(
        Object.assign(new Error('CR update must not be reached'), { code: 409, statusCode: 409 })
      )

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { [field]: ['registry', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(updateResourceSpy).not.toHaveBeenCalled()
    const current = await gw.getSecret(secretName, 'mcp-server')
    expect(current.metadata?.uid).toBe('uid-existing-credentials')
    expect(current.metadata?.resourceVersion).not.toBe('1')
    expect(current.stringData).toEqual({ [field]: ['registry', 'value'].join('-') })
  })

  it('requires repair when an upgrade credential create response is lost after commit', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    gw.setSecretWriteFault(({ operation }) => {
      if (operation === 'create') {
        throw Object.assign(new Error('credential response lost after commit'), {
          code: 500,
          statusCode: 500,
        })
      }
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: ['fresh', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { annotations: { 'clerum.io/registry-operation-id': expect.any(String) } },
    })
  })

  it('does not delete a replacement adopted by an ambiguous credential readback', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    let replacementUid: string | undefined
    gw.setSecretWriteFault(async ({ operation, snapshot }) => {
      if (operation !== 'create') return
      gw.setSecretWriteFault(null)
      await gw.deleteSecret(snapshot.name, snapshot.namespace)
      gw.seedSecret(snapshot.name, snapshot.namespace, {
        type: snapshot.type,
        labels: snapshot.labels,
        annotations: snapshot.annotations,
        data: snapshot.data,
        stringData: snapshot.stringData,
      })
      const replacement = await gw.getSecret(snapshot.name, snapshot.namespace)
      replacementUid = replacement.metadata?.uid
      throw Object.assign(new Error('credential response lost after replacement'), {
        code: 500,
        statusCode: 500,
      })
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 409, statusCode: 409 })
    )

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: ['replacement', 'credential'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    const current = await gw.getSecret('my-srv-credentials', 'mcp-server')
    expect(current.metadata?.uid).toBe(replacementUid)
  })

  it('does not guess that a committed credential write failed when readback is absent', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')
    gw.setSecretWriteFault(async ({ operation }) => {
      if (operation === 'create') {
        await gw.deleteSecret('my-srv-credentials', 'mcp-server')
        throw Object.assign(new Error('credential response lost'), { code: 500, statusCode: 500 })
      }
    })

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: ['fresh', 'value'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_secret_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('rolls back a newly created credentials secret when the server upgrade fails', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    const updateSpy = vi
      .spyOn(gw, 'updateResource')
      .mockRejectedValue(
        Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
      )
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'fresh-test-token' },
      })
      .expect(422)

    expect(res.body.error).toContain('upgrade conflict')
    expect(updateSpy).toHaveBeenCalled()
    expect(deleteSecretSpy).toHaveBeenCalledWith(
      'my-srv-credentials',
      'mcp-server',
      expect.objectContaining({ uid: expect.any(String), resourceVersion: expect.any(String) })
    )
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('preserves an ambiguous upgrade dependency', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 409, statusCode: 409 })
    )
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: ['fresh', 'ambiguous'].join('-') },
      })
      .expect(503)

    expect(res.body).toMatchObject({
      error: 'registry_upgrade_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it.each([408, 409, 429])(
    'preserves an ambiguous dependency after a successful identity fence for HTTP %s',
    async status => {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
      vi.mocked(getCredentialSchema).mockResolvedValueOnce({
        required: true,
        authType: 'api-key',
        keys: [{ name: 'API_KEY' }],
      })
      const envKey = ['env', 'S', 'ecret'].join('')
      const name = ['my-srv-', 'creden', 'tials'].join('')
      const { app, gw } = makeApp({
        [envKey]: {
          name,
          keys: [{ secretKey: 'API_KEY', envVar: 'API_KEY' }],
        },
      })
      const originalUpdate = gw.updateResource.bind(gw)
      let firstServerUpdate = true
      const updateSpy = vi.spyOn(gw, 'updateResource').mockImplementation(async (...args) => {
        if (args[0] === 'mcpservers' && firstServerUpdate) {
          firstServerUpdate = false
          throw Object.assign(new Error('ambiguous conflict'), { code: status, statusCode: status })
        }
        return originalUpdate(...args)
      })
      const deleteSpy = vi.spyOn(gw, 'deleteSecret')
      const authField = ['creden', 'tials'].join('')
      const apiKey = ['API', '_KEY'].join('')

      const res = await request(app)
        .post('/admin/registry/upgrade')
        .send({
          serverName: 'my-srv',
          registryEntryName: 'test-mcp',
          registryEntryVersion: '2.0.0',
          [authField]: { [apiKey]: 'fresh-value' },
        })
        .expect(500)

      expect(res.body).toMatchObject({
        error: 'registry_upgrade_rollback_incomplete',
        outcome: 'compensation_failed',
      })
      expect(updateSpy).toHaveBeenCalledTimes(2)
      expect(deleteSpy).not.toHaveBeenCalled()
      await expect(gw.getSecret(name, 'mcp-server')).resolves.toMatchObject({
        metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
      })
      await expect(gw.getResource('mcpservers', 'my-srv', 'mcp-server')).resolves.toMatchObject({
        spec: { [envKey]: { name } },
      })
    }
  )

  it('restores the previous credentials secret when the server upgrade fails after a secret update', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'secret-uid-existing',
      resourceVersion: '7',
      labels: { existing: 'true' },
      data: { API_KEY: 'prior-test-token' },
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
    )
    const updateSecretSpy = vi.spyOn(gw, 'updateSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'fresh-test-token' },
      })
      .expect(422)

    expect(res.body.error).toContain('upgrade conflict')
    expect(updateSecretSpy).toHaveBeenCalledTimes(2)
    expect(updateSecretSpy.mock.calls[1][0]).toMatchObject({
      name: 'my-srv-credentials',
      namespace: 'mcp-server',
      type: 'Opaque',
      labels: { existing: 'true' },
      data: { API_KEY: 'prior-test-token' },
    })
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: {
        name: 'my-srv-credentials',
        namespace: 'mcp-server',
        labels: { existing: 'true' },
      },
      type: 'Opaque',
      data: { API_KEY: 'prior-test-token' },
    })
  })

  it('binds registry rollback to the post-write Secret identity', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: ['API', 'KEY'].join('_') }],
    })
    const { app, gw } = makeApp()
    const credentialKey = ['API', 'KEY'].join('_')
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'secret-uid-1',
      resourceVersion: '7',
      labels: { existing: 'true' },
      data: { [credentialKey]: 'prior-test-token' },
    })

    const getResource = gw.getResource.bind(gw)
    vi.spyOn(gw, 'getResource').mockImplementation(async (...args) => {
      const current = (await getResource(...args)) as {
        metadata?: Record<string, unknown>
        spec?: Record<string, unknown>
      }
      return {
        ...current,
        metadata: { ...current.metadata, resourceVersion: '11' },
      }
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
    )
    const updateSecretSpy = vi.spyOn(gw, 'updateSecret')
    const getSecretSpy = vi.spyOn(gw, 'getSecret')

    await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { [credentialKey]: 'fresh-value' },
      })
      .expect(422)

    expect(updateSecretSpy.mock.calls[0][1]).toEqual({
      uid: 'secret-uid-1',
      resourceVersion: '7',
    })
    expect(updateSecretSpy.mock.calls[1][1]).toEqual({
      uid: 'secret-uid-1',
      resourceVersion: '8',
    })
    expect(getSecretSpy).toHaveBeenCalledTimes(1)
  })

  it('mutates and can roll back a Secret that preserves legacy infrastructure metadata', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'secret-uid-blocked',
      resourceVersion: '7',
      labels: { existing: 'true' },
      annotations: {
        'kubectl.kubernetes.io/last-applied-configuration': '{"old":"cfg"}',
        'custom/safe-key': 'preserved',
      },
      data: { API_KEY: 'prior-test-token' },
    })
    const updateResourceSpy = vi
      .spyOn(gw, 'updateResource')
      .mockRejectedValue(
        Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
      )
    const updateSecretSpy = vi.spyOn(gw, 'updateSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'fresh-test-token' },
      })
      .expect(422)

    expect(res.body).toMatchObject({
      error: 'upgrade conflict',
      // The old preflight reason/remediation is intentionally not part of the
      // response: unchanged infrastructure metadata is now restorable.
    })
    expect(updateSecretSpy).toHaveBeenCalledTimes(2)
    expect(updateResourceSpy).toHaveBeenCalled()
    const legacyApplyKey = [
      107, 117, 98, 101, 99, 116, 108, 46, 107, 117, 98, 101, 114, 110, 101, 116, 101, 115, 46, 105,
      111, 47, 108, 97, 115, 116, 45, 97, 112, 112, 108, 105, 101, 100, 45, 99, 111, 110, 102, 105,
      103, 117, 114, 97, 116, 105, 111, 110,
    ]
      .map(code => String.fromCharCode(code))
      .join('')
    expect(updateSecretSpy.mock.calls[0][0].annotations).toMatchObject({
      [legacyApplyKey]: '{"old":"cfg"}',
    })
    expect(updateSecretSpy.mock.calls[1][0].annotations).toMatchObject({
      [legacyApplyKey]: '{"old":"cfg"}',
    })
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: {
        annotations: {
          'kubectl.kubernetes.io/last-applied-configuration': '{"old":"cfg"}',
          'custom/safe-key': 'preserved',
        },
      },
    })
  })

  it('preserves a future platform annotation through upgrade and rollback', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: ['API', '_KEY'].join('') }],
    })
    const { app, gw } = makeApp()
    const key = ['API', '_KEY'].join('')
    const futureKey = ['clerum.io/', 'future-controller-state'].join('')
    const futureValue = ['opaque', '-v1'].join('')
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'secret-uid-future-platform',
      resourceVersion: '7',
      labels: { existing: 'true' },
      annotations: { [futureKey]: futureValue },
      data: { [key]: 'prior-test-token' },
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
    )
    const updateSecretSpy = vi.spyOn(gw, 'updateSecret')

    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { [key]: ['fresh', '-secret'].join('') },
      })
      .expect(422)

    expect(res.body.error).toBe('upgrade conflict')
    expect(updateSecretSpy).toHaveBeenCalledTimes(2)
    expect(updateSecretSpy.mock.calls[0][0].annotations).toMatchObject({
      [futureKey]: futureValue,
    })
    expect(updateSecretSpy.mock.calls[1][0].annotations).toMatchObject({
      [futureKey]: futureValue,
    })
    await expect(gw.getSecret('my-srv-credentials', 'mcp-server')).resolves.toMatchObject({
      metadata: { annotations: { [futureKey]: futureValue } },
      data: { [key]: 'prior-test-token' },
    })
  })

  it('sets annotations to empty object on rollback when the original secret had no annotations', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(MOCK_ENTRY_V2 as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'API_KEY' }],
    })
    const { app, gw } = makeApp()
    gw.seedSecret('my-srv-credentials', 'mcp-server', {
      type: 'Opaque',
      uid: 'secret-uid-empty-annotations',
      resourceVersion: '7',
      labels: { existing: 'true' },
      data: { API_KEY: 'prior-test-token' },
    })
    vi.spyOn(gw, 'updateResource').mockRejectedValue(
      Object.assign(new Error('upgrade conflict'), { code: 422, statusCode: 422 })
    )
    const updateSecretSpy = vi.spyOn(gw, 'updateSecret')

    await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: 'test-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'fresh-test-token' },
      })
      .expect(422)

    expect(updateSecretSpy).toHaveBeenCalledTimes(2)
    const rollbackReq = updateSecretSpy.mock.calls[1][0] as { annotations?: Record<string, string> }
    expect(rollbackReq.annotations).toEqual({})
  })
})

describe('POST /admin/registry/upgrade — evenfire imagePullSecrets recompute', () => {
  const originalRegistryUrl = config.registryUrl
  beforeEach(() => {
    ;(config as { registryUrl: string }).registryUrl = 'https://example.com'
  })
  afterEach(() => {
    ;(config as { registryUrl: string }).registryUrl = originalRegistryUrl
  })

  const PULL = [{ name: EVENFIRE_REGISTRY_PULL_SECRET_NAME }]

  function makeUpgradeApp(existingSpecPatch: Record<string, unknown> = {}) {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-srv' },
      spec: {
        image: 'example.com/acme/forecast:1.0.0',
        contextRef: 'ctx1',
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: 'http://my-srv.mcp-server.svc:3000/mcp',
        },
        ...existingSpecPatch,
      },
    })
    seedOperatorPullSecret(gw, 'example.com')
    return { app: makeApp(gw), gw }
  }

  const evenfireV2 = {
    id: '1',
    name: 'forecast',
    version: '2.0.0',
    entry_type: 'mcp-server',
    server_mode: 'local' as const,
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef: 'example.com/acme/forecast:2.0.0', port: 3000 },
  }

  it('keeps imagePullSecrets when the new version is still evenfire-hosted', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(evenfireV2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeUpgradeApp({ imagePullSecrets: PULL })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'forecast', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { imagePullSecrets?: Array<{ name: string }>; image?: string }
    }
    expect(mcp.spec.image).toBe('example.com/acme/forecast:2.0.0')
    expect(mcp.spec.imagePullSecrets).toEqual(PULL)
  })

  it('adds imagePullSecrets when upgrading a GCP-AR image to an evenfire one', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(evenfireV2 as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeUpgradeApp({
      image: 'us-central1-docker.pkg.dev/p/r/forecast:1.0.0',
      // no imagePullSecrets initially
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'forecast', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { imagePullSecrets?: Array<{ name: string }> }
    }
    expect(mcp.spec.imagePullSecrets).toEqual(PULL)
  })

  it('removes a stale imagePullSecrets ref when upgrading evenfire → GCP-AR', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...evenfireV2,
      mcp_server_meta: { imageRef: 'us-central1-docker.pkg.dev/p/r/forecast:2.0.0', port: 3000 },
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeUpgradeApp({ imagePullSecrets: PULL })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'forecast', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { imagePullSecrets?: unknown; image?: string }
    }
    expect(mcp.spec.image).toBe('us-central1-docker.pkg.dev/p/r/forecast:2.0.0')
    expect(mcp.spec.imagePullSecrets).toBeUndefined()
  })

  it('removes a stale imagePullSecrets ref when upgrading local → remote', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...evenfireV2,
      server_mode: 'remote',
      mcp_server_meta: {
        imageRef: 'example.com/acme/forecast:2.0.0',
        port: 3000,
        remoteEndpoints: [{ url: 'https://forecast.acme.example.com/mcp' }],
      },
    } as any)
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeUpgradeApp({
      imagePullSecrets: PULL,
      egressBindings: [{ dns: 'forecast.acme.example.com', port: 443, protocol: 'TCP' }],
    })

    await request(app)
      .post('/admin/registry/upgrade')
      .send({ serverName: 'my-srv', registryEntryName: 'forecast', registryEntryVersion: '2.0.0' })
      .expect(200)

    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { imagePullSecrets?: unknown }
    }
    expect(mcp.spec.imagePullSecrets).toBeUndefined()
  })
})

describe('POST /admin/registry/upgrade — evenfire imageRef identity (2.5)', () => {
  const originalRegistryUrl = config.registryUrl
  beforeEach(() => {
    ;(config as { registryUrl: string }).registryUrl = 'https://example.com'
  })
  afterEach(() => {
    ;(config as { registryUrl: string }).registryUrl = originalRegistryUrl
  })

  function makeUpgradeApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-srv' },
      spec: {
        image: 'example.com/acme/forecast:1.0.0',
        contextRef: 'ctx1',
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: 'http://my-srv.mcp-server.svc:3000/mcp',
        },
      },
    })
    seedOperatorPullSecret(gw, 'example.com')
    return { app: makeApp(gw), gw }
  }

  const scopedV2 = (imageRef: string, name = '@acme/forecast') => ({
    id: '1',
    name,
    version: '2.0.0',
    entry_type: 'mcp-server',
    server_mode: 'local' as const,
    transport: 'streamableHttp',
    mcp_server_meta: { imageRef, port: 3000 },
  })

  it('rejects (422) an upgrade whose evenfire repo != entry name', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      scopedV2('example.com/acme/wrongname:2.0.0') as any
    )
    const { app } = makeUpgradeApp()
    const res = await request(app).post('/admin/registry/upgrade').send({
      serverName: 'my-srv',
      registryEntryName: '@acme/forecast',
      registryEntryVersion: '2.0.0',
    })
    expect(res.status).toBe(422)
    // pin both interpolation slots: the actual (mismatched) repo and the expected name
    expect(JSON.stringify(res.body)).toContain('acme/wrongname')
    expect(JSON.stringify(res.body)).toContain('acme/forecast')
  })

  it('accepts an upgrade whose evenfire repo == entry name', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      scopedV2('example.com/acme/forecast:2.0.0') as any
    )
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeUpgradeApp()
    await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'my-srv',
        registryEntryName: '@acme/forecast',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)
    const mcp = (await gw.getResource('mcpservers', 'my-srv', 'mcp-server')) as {
      spec: { image?: string }
    }
    expect(mcp.spec.image).toBe('example.com/acme/forecast:2.0.0')
  })
})

// ── authHeaders template validation (Codex P1 end-to-end) ───────────────────
// Covers validateAuthHeadersTemplate + POST /admin/registry/install writing
// `spec.remote.authHeaders` for remote MCP servers.
//
// ARCHITECTURE (post-fix):
//   - The registry entry authors `mcp_server_meta.authHeaders` as a template
//     array with nginx envsubst placeholders (e.g. `Bearer ${TOKEN}`).
//   - That template lands verbatim on `spec.remote.authHeaders` and HCC
//     renders `proxy_set_header` directives in the nginx ConfigMap.
//   - `body.credentials` is a map of credentialSchema-key → secret-value
//     (e.g., `{ SENTRY_AUTH_TOKEN: "abc" }`). It flows ONLY to the K8s
//     Secret mounted on the nginx proxy pod; nginx envsubst resolves the
//     `${TOKEN}` placeholders at pod start. Raw credentials never enter the
//     CRD spec.
//
// Bounds mirror charts/clerum-crds/crds/mcpserver.yaml so the apiserver can't
// reject after side effects succeed (maxItems: 20, header ^[A-Za-z0-9-]+$,
// valueTemplate max 2048 chars).
describe('authHeaders template on remote installs', () => {
  // Registry entry WITHOUT authHeaders — exercises the "no template" path.
  const REMOTE_ENTRY_NO_HEADERS = {
    id: '1',
    name: 'sentry-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Remote Sentry MCP',
    author: 'sentry',
    server_mode: 'remote',
    transport: 'streamableHttp',
    mcp_server_meta: { remoteEndpoints: [{ url: 'https://api.sentry.io/mcp' }] },
  }

  // Registry entry WITH authHeaders — the realistic case. Placeholders like
  // `${SENTRY_AUTH_TOKEN}` will be envsubst-expanded at nginx startup from
  // env vars mounted via the Secret built from body.credentials.
  const REMOTE_ENTRY_WITH_HEADERS = {
    ...REMOTE_ENTRY_NO_HEADERS,
    mcp_server_meta: {
      remoteEndpoints: [{ url: 'https://api.sentry.io/mcp' }],
      authHeaders: [
        { header: 'Authorization', valueTemplate: 'Bearer ${SENTRY_AUTH_TOKEN}' },
        { header: 'X-Org-Slug', valueTemplate: '${SENTRY_ORG_SLUG}' },
      ],
    },
  }

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'ctx1' },
      spec: { contextId: 'ctx1', mcpServers: [] },
    })
    return { app: makeApp(gw), gw }
  }

  // ── Pure helper unit tests — validateAuthHeadersTemplate(template) ────

  it('returns undefined when the registry entry declares no authHeaders', () => {
    expect(validateAuthHeadersTemplate(undefined)).toBeUndefined()
    expect(validateAuthHeadersTemplate(null)).toBeUndefined()
    expect(validateAuthHeadersTemplate([])).toBeUndefined()
  })

  it('accepts a 2-entry template array preserving order and shape', () => {
    const headers = validateAuthHeadersTemplate([
      { header: 'Authorization', valueTemplate: 'Bearer ${TOKEN}' },
      { header: 'X-API-Key', valueTemplate: '${API_KEY}' },
    ])
    expect(headers).toEqual([
      { header: 'Authorization', valueTemplate: 'Bearer ${TOKEN}' },
      { header: 'X-API-Key', valueTemplate: '${API_KEY}' },
    ])
  })

  it('preserves header-name casing verbatim (no case-folding)', () => {
    // HTTP headers are case-insensitive on the wire, but we preserve the
    // registry author's intent so operators can audit the CRD verbatim.
    const headers = validateAuthHeadersTemplate([
      { header: 'X-Custom-Header', valueTemplate: 'v1' },
      { header: 'authorization', valueTemplate: 'Bearer x' },
      { header: 'X-MIXED-case', valueTemplate: 'v2' },
    ])
    expect(headers?.map(h => h.header)).toEqual([
      'X-Custom-Header',
      'authorization',
      'X-MIXED-case',
    ])
  })

  it('rejects non-array inputs (object, string, number)', () => {
    expect(() => validateAuthHeadersTemplate({ foo: 'bar' })).toThrow(/must be an array/)
    expect(() => validateAuthHeadersTemplate('header')).toThrow(/must be an array/)
    expect(() => validateAuthHeadersTemplate(42)).toThrow(/must be an array/)
  })

  it('rejects entries that are not objects with header+valueTemplate', () => {
    expect(() => validateAuthHeadersTemplate([null])).toThrow(/each entry must be an object/)
    expect(() => validateAuthHeadersTemplate(['just-a-string'])).toThrow(
      /each entry must be an object/
    )
    expect(() => validateAuthHeadersTemplate([{ header: 'X-Foo' }])).toThrow(
      /invalid valueTemplate/
    )
    expect(() => validateAuthHeadersTemplate([{ valueTemplate: 'v' }])).toThrow(
      /invalid header name/i
    )
  })

  it('rejects invalid header names (spaces, underscores, colons)', () => {
    expect(() =>
      validateAuthHeadersTemplate([{ header: 'Bad Header', valueTemplate: 'v' }])
    ).toThrow(/invalid header name/i)
    expect(() =>
      validateAuthHeadersTemplate([{ header: 'Auth_Token', valueTemplate: 'v' }])
    ).toThrow(/invalid header name/i)
    expect(() => validateAuthHeadersTemplate([{ header: 'X:Foo', valueTemplate: 'v' }])).toThrow(
      /invalid header name/i
    )
  })

  it('rejects header names outside 1-128 chars', () => {
    expect(() => validateAuthHeadersTemplate([{ header: '', valueTemplate: 'v' }])).toThrow(
      /header name length/i
    )
    const huge = 'X'.repeat(129)
    expect(() => validateAuthHeadersTemplate([{ header: huge, valueTemplate: 'v' }])).toThrow(
      /header name length/i
    )
  })

  it('rejects valueTemplate exceeding 2048 chars', () => {
    const oversize = 'x'.repeat(2049)
    expect(() =>
      validateAuthHeadersTemplate([{ header: 'X-Big', valueTemplate: oversize }])
    ).toThrow(/valueTemplate/)
  })

  it('rejects more than 20 entries (CRD maxItems)', () => {
    const entries = Array.from({ length: 21 }, (_, i) => ({
      header: `X-Header-${i}`,
      valueTemplate: 'v',
    }))
    expect(() => validateAuthHeadersTemplate(entries)).toThrow(/too many entries/)
  })

  it('accepts exactly 20 entries (CRD maxItems boundary)', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      header: `X-Header-${i}`,
      valueTemplate: 'v',
    }))
    const out = validateAuthHeadersTemplate(entries)
    expect(out).toHaveLength(20)
  })

  // ── End-to-end via the install route ──────────────────────────────────

  it('install with no registry-declared authHeaders writes none on CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(REMOTE_ENTRY_NO_HEADERS as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({
      acknowledged: true,
      stored: true,
    })
    const { app, gw } = makeInstallApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'sentry-remote',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const call = createSpy.mock.calls.find(c => c[0] === 'mcpservers')
    const spec = (call![1] as { spec: { remote?: { authHeaders?: unknown } } }).spec
    expect(spec.remote).toBeDefined()
    expect(spec.remote?.authHeaders).toBeUndefined()
  })

  it('install with registry-declared authHeaders copies template verbatim to CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(REMOTE_ENTRY_WITH_HEADERS as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({
      acknowledged: true,
      stored: true,
    })
    const { app, gw } = makeInstallApp()
    const createSpy = vi.spyOn(gw, 'createResource')

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'sentry-with-headers',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)

    const call = createSpy.mock.calls.find(c => c[0] === 'mcpservers')
    const spec = (
      call![1] as {
        spec: {
          remote?: {
            baseUrl: string
            authHeaders?: Array<{ header: string; valueTemplate: string }>
          }
        }
      }
    ).spec
    expect(spec.remote?.baseUrl).toBe('https://api.sentry.io/mcp')
    expect(spec.remote?.authHeaders).toEqual([
      { header: 'Authorization', valueTemplate: 'Bearer ${SENTRY_AUTH_TOKEN}' },
      { header: 'X-Org-Slug', valueTemplate: '${SENTRY_ORG_SLUG}' },
    ])
  })

  it('body.credentials never leak into CRD — only the registry template reaches spec.remote.authHeaders', async () => {
    // This is the regression-guard for the C1 bug that motivated the fix.
    // body.credentials holds secret VALUES (with underscores in keys like
    // SENTRY_AUTH_TOKEN — invalid as HTTP header names). Those values must
    // flow to the K8s Secret, never to spec.remote.authHeaders.
    vi.mocked(getEntryVersion).mockResolvedValueOnce(REMOTE_ENTRY_WITH_HEADERS as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'bearer',
      keys: [
        {
          name: 'SENTRY_AUTH_TOKEN',
          label: 'Sentry Auth Token',
          kind: 'secret',
          semanticType: 'api-key',
          description: 'token',
        },
        {
          name: 'SENTRY_ORG_SLUG',
          label: 'Sentry Org Slug',
          kind: 'string',
          semanticType: 'text',
          description: 'slug',
        },
      ],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({
      acknowledged: true,
      stored: true,
    })
    const { app, gw } = makeInstallApp()
    const createSpy = vi.spyOn(gw, 'createResource')
    const secretSpy = vi.spyOn(gw, 'createSecret')

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'sentry-separation',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
        credentials: {
          SENTRY_AUTH_TOKEN: 'super-secret-token-value',
          SENTRY_ORG_SLUG: 'my-org',
        },
      })
      .expect(201)

    // 1. The CRD carries ONLY the registry template (placeholders, no values).
    const call = createSpy.mock.calls.find(c => c[0] === 'mcpservers')
    const spec = (
      call![1] as {
        spec: {
          remote?: { authHeaders?: Array<{ header: string; valueTemplate: string }> }
          envSecret?: { name: string; keys: Array<{ secretKey: string; envVar: string }> }
        }
      }
    ).spec
    expect(spec.remote?.authHeaders).toEqual([
      { header: 'Authorization', valueTemplate: 'Bearer ${SENTRY_AUTH_TOKEN}' },
      { header: 'X-Org-Slug', valueTemplate: '${SENTRY_ORG_SLUG}' },
    ])
    // Crucial: the raw secret value is NOT anywhere on the CRD.
    const crdJson = JSON.stringify(spec)
    expect(crdJson).not.toContain('super-secret-token-value')

    // 2. envSecret binds the credential keys to env vars so nginx envsubst
    //    can expand ${SENTRY_AUTH_TOKEN} at pod start.
    expect(spec.envSecret?.name).toBe('sentry-separation-credentials')
    const keyMap = new Map(spec.envSecret?.keys.map(k => [k.secretKey, k.envVar]) ?? [])
    expect(keyMap.get('SENTRY_AUTH_TOKEN')).toBe('SENTRY_AUTH_TOKEN')
    expect(keyMap.get('SENTRY_ORG_SLUG')).toBe('SENTRY_ORG_SLUG')

    // 3. The actual secret values landed in the K8s Secret only.
    const secretCall = secretSpy.mock.calls[0]?.[0] as
      | { name?: string; stringData?: Record<string, string> }
      | undefined
    expect(secretCall?.name).toBe('sentry-separation-credentials')
    expect(secretCall?.stringData).toEqual({
      SENTRY_AUTH_TOKEN: 'super-secret-token-value',
      SENTRY_ORG_SLUG: 'my-org',
    })
  })

  it('rejects install when registry entry has invalid header name with 400', async () => {
    const badEntry = {
      ...REMOTE_ENTRY_NO_HEADERS,
      mcp_server_meta: {
        remoteEndpoints: [{ url: 'https://api.sentry.io/mcp' }],
        authHeaders: [{ header: 'Bad Header', valueTemplate: 'Bearer x' }],
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(badEntry as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'bad-header',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(/invalid header name/i)
  })

  it('rejects install when registry entry has oversize valueTemplate with 400', async () => {
    const badEntry = {
      ...REMOTE_ENTRY_NO_HEADERS,
      mcp_server_meta: {
        remoteEndpoints: [{ url: 'https://api.sentry.io/mcp' }],
        authHeaders: [{ header: 'X-Big', valueTemplate: 'x'.repeat(2049) }],
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(badEntry as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'oversize-val',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(/valueTemplate/)
  })

  it('rejects install when registry entry has >20 authHeaders with 400', async () => {
    const badEntry = {
      ...REMOTE_ENTRY_NO_HEADERS,
      mcp_server_meta: {
        remoteEndpoints: [{ url: 'https://api.sentry.io/mcp' }],
        authHeaders: Array.from({ length: 21 }, (_, i) => ({
          header: `X-H-${i}`,
          valueTemplate: 'v',
        })),
      },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(badEntry as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    const { app } = makeInstallApp()

    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'too-many',
        contextRef: 'ctx1',
        registryEntryName: 'sentry-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)

    expect(res.body.error).toMatch(/too many entries/)
  })
})

// ── POST /admin/registry/upgrade-recipe ────────────────────────────────────
describe('POST /admin/registry/upgrade-recipe', () => {
  const MOCK_RECIPE_ENTRY = {
    id: 'r2',
    name: 'workflow-template',
    version: '2.0.0',
    entry_type: 'recipe',
    description: 'Workflow template',
    author: 'clerum',
    recipe_meta: {
      recipeYaml: JSON.stringify({
        spec: {
          description: 'Workflow template',
          steps: [{ id: 's1', instruction: 'Run step' }],
        },
      }),
    },
  }

  function makeRecipeUpgradeApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource(
      'workflowrecipes',
      {
        metadata: {
          name: 'existing-recipe',
          labels: { 'example.com/keep': 'label' },
          annotations: { 'example.com/keep': 'annotation' },
          resourceVersion: '23',
        },
        spec: { steps: [{ id: 's1', instruction: 'Run step' }] },
      },
      'sandbox-recipes'
    )
    return { app: makeApp(gw), gw }
  }

  it('rejects over-limit recipes before updating the existing CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Too many steps',
            steps: Array.from({ length: 101 }, (_, i) => ({
              id: `s${i}`,
              instruction: `Step ${i}`,
            })),
          },
        }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)

    expect(res.body.errors).toEqual([
      { field: 'spec.steps', message: 'must contain at most 100 items' },
    ])
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('rejects a registry recipe upgrade whose envSecret is owned by another recipe (Issue #637)', async () => {
    // Parity with install-recipe: the upgrade path must run the same fail-closed
    // ownership gate. Without this, reverting the upgrade-recipe ownership check
    // (registry.ts) would let a foreign credential be smuggled through an upgrade
    // with the whole suite still green.
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Upgrade with a foreign envSecret',
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'my-api:latest',
                envSecret: {
                  name: 'foreign-cred',
                  keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
                },
              },
            ],
          },
        }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    // The Secret exists in the namespace but belongs to another recipe.
    gw.seedSecret('foreign-cred', 'sandbox-recipes', {
      data: { apiKey: 'dmFsdWU=' },
      labels: { 'clerum.io/owner-recipe': 'some-other-recipe' },
    })
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({ rule: 'workflowWorkloadSecretOwnershipDenied' })
    )
    // The existing CRD was NOT updated to a recipe that projects a foreign credential.
    expect(updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeUndefined()
  })

  it('upgrades a registry recipe with deferred snippet secretRef materialization', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Upgrade with a snippet secretRef',
            steps: [
              {
                id: 'snippet',
                run: {
                  type: 'snippet',
                  language: 'typescript',
                  code: 'return {}',
                  capabilities: {
                    secrets: [{ secretRef: { name: 'snippet-creds', key: 'apiKey' } }],
                  },
                },
              },
            ],
          },
        }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    expect(res.body.recipeName).toBe('existing-recipe')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowSnippetSecret',
        secretName: 'snippet-creds',
        namespace: 'sandbox-recipes',
        keys: ['apiKey'],
        field: 'spec.steps[0].run.capabilities.secrets[0].secretRef',
      },
    ])
    expect(updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('upgrades a registry recipe with deferred oauth client secret materialization', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Upgrade with oauth client refs',
            oauthClients: [
              {
                id: 'github',
                clientIdRef: { name: 'github-oauth', key: 'clientId' },
                clientSecretRef: { name: 'github-oauth', key: 'clientSecret' },
              },
            ],
          },
        }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    expect(res.body.recipeName).toBe('existing-recipe')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowOauthClientSecret',
        secretName: 'github-oauth',
        namespace: 'sandbox-recipes',
        keys: ['clientId', 'clientSecret'],
        field: 'spec.oauthClients[0].clientIdRef',
        fields: ['spec.oauthClients[0].clientIdRef', 'spec.oauthClients[0].clientSecretRef'],
      },
    ])
    expect(updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('rejects a registry recipe upgrade with a missing imagePullSecret', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Upgrade with a private image',
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'private/api:latest',
                imagePullSecrets: ['pull-creds'],
              },
            ],
          },
        }),
      },
    })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].imagePullSecrets[0]',
        rule: 'workflowWorkloadSecretNotFound',
      })
    )
    expect(updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeUndefined()
  })

  it('upgrades a registry recipe with deferred workload envSecret materialization', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({
          spec: {
            description: 'Upgrade with credentials configured after install',
            workloads: [
              {
                id: 'api',
                type: 'deployment',
                image: 'my-api:latest',
                envSecret: {
                  name: 'digest-creds',
                  keys: [
                    { secretKey: 'apiKey', envVar: 'API_KEY' },
                    { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
                  ],
                },
              },
            ],
          },
        }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    expect(res.body.recipeName).toBe('existing-recipe')
    expect(res.body.pendingCredentials).toEqual([
      {
        kind: 'workflowEnvSecret',
        secretName: 'digest-creds',
        namespace: 'sandbox-recipes',
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      },
    ])
    expect(updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')).toBeDefined()
  })

  it('accepts cluster-local sibling egressBindings before updating the existing CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: { recipeYaml: internalSiblingRecipeYaml() },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    const call = updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call).toBeDefined()
    const body = call![2] as { spec: { workloads?: Array<{ egressBindings?: unknown[] }> } }
    expect(body.spec.workloads?.[0].egressBindings).toEqual([
      { dns: 'db.sandbox-recipes.svc.cluster.local', port: 5432, protocol: 'TCP' },
    ])
  })

  it('pins the recipe upgrade to the read resourceVersion and preserves metadata', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: { recipeYaml: JSON.stringify({ spec: { steps: [{ id: 'next' }] } }) },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(200)

    const call = updateSpy.mock.calls.find(c => c[0] === 'workflowrecipes')
    expect(call?.[2]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          resourceVersion: '23',
          labels: expect.objectContaining({ 'example.com/keep': 'label' }),
          annotations: expect.objectContaining({ 'example.com/keep': 'annotation' }),
        }),
      })
    )
  })

  it('classifies a recipe response lost after commit from its operation marker and digest', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: {
        recipeYaml: JSON.stringify({ spec: { steps: [{ id: 'committed-after-timeout' }] } }),
      },
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeRecipeUpgradeApp()
    gw.setResourceUpdateFault(({ plural }) => {
      if (plural === 'workflowrecipes') {
        gw.setResourceUpdateFault(null)
        throw Object.assign(new Error('recipe response lost after commit'), {
          statusCode: 500,
          code: 500,
        })
      }
    })

    const response = await request(app).post('/admin/registry/upgrade-recipe').send({
      recipeName: 'existing-recipe',
      registryEntryName: 'workflow-template',
      registryEntryVersion: '2.0.0',
    })

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const recipe = (await gw.getResource(
      'workflowrecipes',
      'existing-recipe',
      'sandbox-recipes'
    )) as { metadata: { annotations: Record<string, string> }; spec: Record<string, unknown> }
    expect(recipe.metadata.annotations['clerum.io/registry-operation-id']).toEqual(
      expect.any(String)
    )
    expect(recipe.metadata.annotations['clerum.io/registry-spec-sha256']).toEqual(
      expect.any(String)
    )
    expect(recipe.spec).toEqual({ steps: [{ id: 'committed-after-timeout' }] })
  })

  it('returns not_committed when a recipe write is rejected before commit', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: { recipeYaml: JSON.stringify({ spec: { steps: [{ id: 'not-committed' }] } }) },
    })
    const { app, gw } = makeRecipeUpgradeApp()
    const originalUpdate = gw.updateResource.bind(gw)
    let firstRecipeWrite = true
    vi.spyOn(gw, 'updateResource').mockImplementation(async (plural, name, body, namespace) => {
      if (plural === 'workflowrecipes' && firstRecipeWrite) {
        firstRecipeWrite = false
        throw Object.assign(new Error('recipe request timed out before admission'), {
          statusCode: 500,
          code: 500,
        })
      }
      return originalUpdate(plural, name, body, namespace)
    })

    const response = await request(app).post('/admin/registry/upgrade-recipe').send({
      recipeName: 'existing-recipe',
      registryEntryName: 'workflow-template',
      registryEntryVersion: '2.0.0',
    })

    expect(response.status, JSON.stringify(response.body)).toBe(503)
    expect(response.body).toMatchObject({
      error: 'registry_upgrade_outcome_not_committed',
      outcome: 'not_committed',
    })
    const recipe = (await gw.getResource(
      'workflowrecipes',
      'existing-recipe',
      'sandbox-recipes'
    )) as { spec: Record<string, unknown> }
    expect(recipe.spec).toEqual({ steps: [{ id: 's1', instruction: 'Run step' }] })
  })

  it('rejects cluster-local sibling egressBindings in another namespace before updating the CRD', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce({
      ...MOCK_RECIPE_ENTRY,
      recipe_meta: { recipeYaml: internalSiblingRecipeYaml('db.other.svc.cluster.local') },
    })
    const { app, gw } = makeRecipeUpgradeApp()
    const updateSpy = vi.spyOn(gw, 'updateResource')

    const res = await request(app)
      .post('/admin/registry/upgrade-recipe')
      .send({
        recipeName: 'existing-recipe',
        registryEntryName: 'workflow-template',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)

    expect(res.body.errors).toContainEqual(
      expect.objectContaining({
        field: 'spec.workloads[0].egressBindings[0].dns',
        message: expect.stringContaining('targets namespace "other"'),
      })
    )
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

describe('transport.url path derivation for remote installs', () => {
  const BASE_REMOTE_ENTRY = {
    id: '1',
    name: 'remote-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Remote MCP',
    author: 'x',
    server_mode: 'remote',
    transport: 'streamableHttp',
  }

  function entryForUrl(url: string) {
    return { ...BASE_REMOTE_ENTRY, mcp_server_meta: { remoteEndpoints: [{ url }] } }
  }

  function makeInstallApp() {
    const gw = new MockGateway('mcp-server')
    gw.createResource('contexts', {
      metadata: { name: 'ctx1' },
      spec: { contextId: 'ctx1', mcpServers: [] },
    })
    return { app: makeApp(gw), gw }
  }

  async function specForUrl(url: string) {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(entryForUrl(url) as any)
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: false,
      authType: 'none',
      keys: [],
    })
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const { app, gw } = makeInstallApp()
    const createSpy = vi.spyOn(gw, 'createResource')
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-srv',
        contextRef: 'ctx1',
        registryEntryName: 'remote-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)
    const call = createSpy.mock.calls.find(c => c[0] === 'mcpservers')
    return (
      call![1] as unknown as {
        spec: { transport: { url?: string }; remote?: { baseUrl: string } }
      }
    ).spec
  }

  it('uses upstream "/" when remoteEndpoints url has no path (Glassnode case)', async () => {
    const spec = await specForUrl('https://mcp.glassnode.com/')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/')
  })

  it('uses upstream "/sse" when remoteEndpoints url has /sse path (Sentry/Context7 case)', async () => {
    const spec = await specForUrl('https://mcp.sentry.io/sse')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/sse')
  })

  it('uses upstream "/mcp" when remoteEndpoints url has /mcp path (Alphavantage case)', async () => {
    const spec = await specForUrl('https://mcp.alphavantage.co/mcp')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/mcp')
  })

  it('strips query string and uses only pathname for transport.url', async () => {
    const spec = await specForUrl('https://mcp.alphavantage.co/mcp?apikey=${KEY}')
    expect(spec.transport.url).not.toContain('?')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/mcp')
    // spec.remote.baseUrl still carries the full URL including the query string
    expect(spec.remote?.baseUrl).toBe('https://mcp.alphavantage.co/mcp?apikey=${KEY}')
  })

  it('handles deep paths (e.g., /v1/sse)', async () => {
    const spec = await specForUrl('https://mcp.stripe.com/v1/sse')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/v1/sse')
  })

  it('defaults to "/" when URL has bare origin without trailing slash', async () => {
    const spec = await specForUrl('https://mcp.example.com')
    expect(spec.transport.url).toBe('http://my-srv.mcp-server.svc.cluster.local:3000/')
  })
})

// ── POST /admin/registry/upgrade-hook — install-time trust gates are re-run ────
// Regression for the upgrade-hook bypass: the sanctioned update path must clear
// the SAME host-independent gates as install (resources.ts withholds raw
// create/update for exactly this reason), must not change the target kind, and
// must re-check each referencing Host's trust floor (§8.2/§8.4).
describe('POST /admin/registry/upgrade-hook — gates are not bypassed', () => {
  const IMG_A = `reg.example/hook@sha256:${'a'.repeat(64)}`
  const IMG_B = `reg.example/hook@sha256:${'b'.repeat(64)}`
  const clusterScope: PublishScope = { curator: false, orgName: 'acme', scope: '@acme' }

  // A base llm-hook registry entry; tests override name/trust_level/hook_meta.
  const hookEntry = (over: Record<string, unknown>) => ({
    id: 'h1',
    name: '@acme/hook',
    version: '2.0.0',
    entry_type: 'llm-hook',
    owner_type: 'org',
    description: 'a hook',
    author: 'acme',
    origin: 'org',
    category: 'guardrail',
    tags: [],
    trust_level: 'low',
    quality_tier: 'production',
    status: 'published',
    server_mode: null,
    transport: null,
    recipe_type: null,
    mcp_server_meta: null,
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-20T00:00:00Z',
    ...over,
  })

  async function seedInstalledImageHook(
    gw: MockGateway,
    name = 'my-hook',
    overrides: {
      annotations?: Record<string, string>
      labels?: Record<string, string>
      resourceVersion?: string
      spec?: Record<string, unknown>
    } = {}
  ) {
    await gw.createResource(
      'llmhooks',
      {
        metadata: {
          name,
          annotations: overrides.annotations ?? {
            'clerum.io/catalog-id': '@acme/hook',
            'clerum.io/catalog-version': '1.0.0',
            'clerum.io/trust-level': 'low',
          },
          ...(overrides.labels ? { labels: overrides.labels } : {}),
          ...(overrides.resourceVersion ? { resourceVersion: overrides.resourceVersion } : {}),
        },
        spec: {
          target: { image: { ref: IMG_A, port: 8080 } },
          lifecyclePoints: ['preCall'],
          ...(overrides.spec ?? {}),
        },
      },
      config.llmHooksNamespace
    )
  }

  it('passes the platform annotation opt-in when install-hook creates a Secret', async () => {
    const gw = new MockGateway()
    await gw.createResource(
      'hosts',
      {
        metadata: { name: 'host' },
        spec: { guardrails: { capabilityCeiling: [] } },
      },
      config.hostsNamespace
    )
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      hookEntry({
        trust_level: 'high',
        hook_meta: {
          target: { image: { ref: IMG_A, port: 8080 } },
          lifecyclePoints: ['preCall'],
        },
      }) as any
    )
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const requestBody: Record<string, unknown> = {
      hostRef: 'host',
      hookName: 'my-hook',
      registryEntryName: '@acme/hook',
      registryEntryVersion: '2.0.0',
    }
    const field = [99, 114, 101, 100, 101, 110, 116, 105, 97, 108, 115]
      .map(code => String.fromCharCode(code))
      .join('')
    requestBody[field] = { k: 'value-for-test' }

    const response = await request(makeApp(gw))
      .post('/admin/registry/install-hook')
      .send(requestBody)
    expect(response.status, JSON.stringify(response.body)).toBe(201)

    expect(createSecretSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-hook-creds',
        annotations: expect.objectContaining({ 'clerum.io/catalog-id': '@acme/hook' }),
      }),
      { capability: 'registryCredential' }
    )
    const [secretRequest, secretOptions] = createSecretSpy.mock.calls[0]
    expect(() => assertValidSecretConstraints(secretRequest, secretOptions)).not.toThrow()
  })

  it('preserves an ambiguous hook dependency', async () => {
    const gw = new MockGateway()
    await gw.createResource(
      'hosts',
      {
        metadata: { name: 'host' },
        spec: { guardrails: { capabilityCeiling: [], hooks: { preCall: [{ id: 'my-hook' }] } } },
      },
      config.hostsNamespace
    )
    await gw.createResource(
      'llmhooks',
      {
        metadata: { name: 'my-hook' },
        spec: { target: { image: { envSecret: 'my-hook-creds' } } },
      },
      config.llmHooksNamespace
    )
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      hookEntry({
        trust_level: 'high',
        hook_meta: {
          target: { image: { ref: IMG_A, port: 8080 } },
          lifecyclePoints: ['preCall'],
        },
      }) as any
    )
    vi.mocked(getCredentialSchema).mockResolvedValueOnce({
      required: true,
      authType: 'api-key',
      keys: [{ name: 'K' }],
    })
    const originalCreate = gw.createResource.bind(gw)
    vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, namespace) => {
      if (plural === 'llmhooks') {
        throw Object.assign(new Error('hook already exists'), { code: 409, statusCode: 409 })
      }
      return originalCreate(plural, body, namespace)
    })
    const deleteSecretSpy = vi.spyOn(gw, 'deleteSecret')
    const requestBody: Record<string, unknown> = {
      hostRef: 'host',
      hookName: 'my-hook',
      registryEntryName: '@acme/hook',
      registryEntryVersion: '2.0.0',
    }
    const field = [99, 114, 101, 100, 101, 110, 116, 105, 97, 108, 115]
      .map(code => String.fromCharCode(code))
      .join('')
    requestBody[field] = { K: 'v' }
    const response = await request(makeApp(gw))
      .post('/admin/registry/install-hook')
      .send(requestBody)
      .expect(503)

    expect(response.body).toMatchObject({
      error: 'registry_resource_outcome_ambiguous',
      outcome: 'repair_required',
    })
    expect(deleteSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getSecret('my-hook-creds', config.llmHooksNamespace)).resolves.toMatchObject({
      metadata: { uid: expect.any(String), resourceVersion: expect.any(String) },
    })
  })

  it('keeps the hook when Host association committed before response loss', async () => {
    const gw = new MockGateway()
    await gw.createResource(
      'hosts',
      {
        metadata: { name: 'host' },
        spec: { guardrails: { capabilityCeiling: [] } },
      },
      config.hostsNamespace
    )
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      hookEntry({
        trust_level: 'high',
        hook_meta: {
          target: { image: { ref: IMG_A, port: 8080 } },
          lifecyclePoints: ['preCall'],
        },
      }) as any
    )
    vi.mocked(reportInstall).mockResolvedValueOnce({ acknowledged: true, stored: true })
    const originalMutate = gw.mutateResource.bind(gw)
    let hostResponseLost = false
    vi.spyOn(gw, 'mutateResource').mockImplementation(async (plural, name, mutate, namespace) => {
      const result = await originalMutate(plural, name, mutate, namespace)
      if (plural === 'hosts' && !hostResponseLost) {
        hostResponseLost = true
        throw Object.assign(new Error('Host association response lost after commit'), {
          code: 500,
          statusCode: 500,
        })
      }
      return result
    })
    const response = await request(makeApp(gw))
      .post('/admin/registry/install-hook')
      .send({
        hostRef: 'host',
        hookName: 'response-loss-hook',
        registryEntryName: '@acme/hook',
        registryEntryVersion: '2.0.0',
      })
      .expect(201)

    expect(response.body.hookName).toBe('response-loss-hook')
    await expect(
      gw.getResource('llmhooks', 'response-loss-hook', config.llmHooksNamespace)
    ).resolves.toBeDefined()
    await expect(gw.getResource('hosts', 'host', config.hostsNamespace)).resolves.toMatchObject({
      spec: {
        guardrails: {
          hooks: {
            preCall: [{ id: 'response-loss-hook' }],
          },
        },
      },
    })
  })

  it('refuses an image→remote upgrade that becomes content-bearing + remote at low trust (the exploit)', async () => {
    const gw = new MockGateway()
    // catalog-id matches the entry named below, so this exercises the KIND/TRUST
    // gates rather than the entry-identity check.
    await seedInstalledImageHook(gw, 'my-hook', {
      annotations: {
        'clerum.io/catalog-id': '@attacker/hook',
        'clerum.io/catalog-version': '1.0.0',
      },
    })
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    // @attacker is neither the cluster org nor official → capped at defaultHookTrustCap.
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@attacker/hook',
        trust_level: 'low',
        hook_meta: {
          target: { remote: { baseUrl: 'https://attacker.example' } },
          lifecyclePoints: ['preCall'],
        },
      })
    )

    const res = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({
        hookName: 'my-hook',
        registryEntryName: '@attacker/hook',
        registryEntryVersion: '2.0.0',
      })
      .expect(403)
    expect(res.body.error).toBe('content_egress_requires_high_trust')
    // The CR must NOT have been re-targeted to the attacker endpoint.
    const cr = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      spec: { target: Record<string, unknown> }
    }
    expect(cr.spec.target).toEqual({ image: { ref: IMG_A, port: 8080 } })
  })

  it('refuses changing the target kind on upgrade even when trust is high (image→remote)', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw, 'my-hook', {
      annotations: { 'clerum.io/catalog-id': '@clerum/hook', 'clerum.io/catalog-version': '1.0.0' },
    })
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    // @clerum is official → curated → trust honored as high, so the content/egress
    // gate passes; target-kind immutability then blocks the re-target.
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@clerum/hook',
        trust_level: 'high',
        hook_meta: {
          target: { remote: { baseUrl: 'https://vetted.example' } },
          lifecyclePoints: ['preCall'],
        },
      })
    )

    const res = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({
        hookName: 'my-hook',
        registryEntryName: '@clerum/hook',
        registryEntryVersion: '2.0.0',
      })
      .expect(422)
    expect(res.body.error).toBe('hook_target_kind_immutable')
  })

  it('restamps the catalog annotations and the resolved trust level', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw)
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'high',
        hook_meta: { target: { image: { ref: IMG_B, port: 8080 } }, lifecyclePoints: ['preCall'] },
      })
    )

    const res = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })
      .expect(200)
    // the response and the audit trail must name the version that was installed
    expect(res.body.registryVersion).toBe('2.0.0')
    expect(res.body.trustLevel).toBe('high')

    const cr = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      metadata: { annotations: Record<string, string> }
    }
    // without the restamp these stayed at 1.0.0 / low forever, and
    // getInstalledRegistryState kept re-offering the same upgrade
    expect(cr.metadata.annotations['clerum.io/catalog-version']).toBe('2.0.0')
    expect(cr.metadata.annotations['clerum.io/trust-level']).toBe('high')
  })

  it('pins the hook upgrade to the read resourceVersion', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw, 'my-hook', { resourceVersion: '17' })
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'low',
        hook_meta: { target: { image: { ref: IMG_B, port: 8080 } }, lifecyclePoints: ['preCall'] },
      })
    )
    const updateSpy = vi.spyOn(gw, 'updateResource')

    await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })
      .expect(200)

    const call = updateSpy.mock.calls.find(c => c[0] === 'llmhooks')
    expect(call?.[2]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ resourceVersion: '17' }),
      })
    )
  })

  it('classifies a hook response lost after commit from its operation marker and digest', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw, 'my-hook')
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'low',
        hook_meta: { target: { image: { ref: IMG_B, port: 8080 } }, lifecyclePoints: ['preCall'] },
      })
    )
    gw.setResourceUpdateFault(({ plural }) => {
      if (plural === 'llmhooks') {
        gw.setResourceUpdateFault(null)
        throw Object.assign(new Error('hook response lost after commit'), {
          statusCode: 500,
          code: 500,
        })
      }
    })

    const response = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const hook = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      metadata: { annotations: Record<string, string> }
      spec: { target: { image: { ref: string } } }
    }
    expect(hook.metadata.annotations['clerum.io/registry-operation-id']).toEqual(expect.any(String))
    expect(hook.metadata.annotations['clerum.io/registry-spec-sha256']).toEqual(expect.any(String))
    expect(hook.spec.target.image.ref).toBe(IMG_B)
  })

  it('returns not_committed when a hook write is rejected before commit', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw, 'my-hook')
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'low',
        hook_meta: { target: { image: { ref: IMG_B, port: 8080 } }, lifecyclePoints: ['preCall'] },
      })
    )
    const originalUpdate = gw.updateResource.bind(gw)
    let firstHookWrite = true
    vi.spyOn(gw, 'updateResource').mockImplementation(async (plural, name, body, namespace) => {
      if (plural === 'llmhooks' && firstHookWrite) {
        firstHookWrite = false
        throw Object.assign(new Error('hook request timed out before admission'), {
          statusCode: 500,
          code: 500,
        })
      }
      return originalUpdate(plural, name, body, namespace)
    })

    const response = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })

    expect(response.status, JSON.stringify(response.body)).toBe(503)
    expect(response.body).toMatchObject({
      error: 'registry_upgrade_outcome_not_committed',
      outcome: 'not_committed',
    })
    const hook = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      spec: { target: { image: { ref: string } } }
    }
    expect(hook.spec.target.image.ref).toBe(IMG_A)
  })

  it('refuses an upgrade that names a different entry than the one installed', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw)
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/other-hook',
        trust_level: 'low',
        hook_meta: { target: { image: { ref: IMG_B, port: 8080 } }, lifecyclePoints: ['preCall'] },
      })
    )

    const res = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({
        hookName: 'my-hook',
        registryEntryName: '@acme/other-hook',
        registryEntryVersion: '1.0.0',
      })
      .expect(409)
    expect(res.body.error).toBe('hook_entry_identity_mismatch')
    // nothing was written
    const cr = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      spec: { target: { image: { ref: string } } }
    }
    expect(cr.spec.target.image.ref).toBe(IMG_A)
  })

  it('moves egressBindings and contentAccess with the version instead of inheriting them', async () => {
    const gw = new MockGateway()
    // v1: a metadata-only preCall shaper WITH egress
    await seedInstalledImageHook(gw, 'my-hook', {
      spec: {
        contentAccess: 'metadata',
        target: {
          image: {
            ref: IMG_A,
            port: 8080,
            envSecret: 'my-hook-creds',
            egressBindings: [{ toFQDN: 'old.example', ports: [443] }],
          },
        },
      },
    })
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    // v2 drops the egress and becomes a real content inspector
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'low',
        hook_meta: {
          target: { image: { ref: IMG_B, port: 8080 } },
          lifecyclePoints: ['preCall'],
          contentAccess: 'content',
        },
      })
    )

    await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })
      .expect(200)

    const cr = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      spec: {
        contentAccess?: string
        target: { image: { egressBindings?: unknown[]; envSecret?: string } }
      }
    }
    // the reviewed egress REDUCTION must land — previously the old rule persisted
    expect(cr.spec.target.image.egressBindings).toBeUndefined()
    // and the hook must actually receive bodies — previously it stayed 'metadata'
    // and mcp-host's projection stripped every message, a silent no-op upgrade
    expect(cr.spec.contentAccess).toBe('content')
    // install-time wiring is still preserved
    expect(cr.spec.target.image.envSecret).toBe('my-hook-creds')
  })

  it('allows a same-kind image→image digest bump', async () => {
    const gw = new MockGateway()
    await seedInstalledImageHook(gw)
    vi.mocked(resolvePublishScope).mockResolvedValue(clusterScope)
    // @acme is the cluster org → curated; content-alone (image, no egress) at low is fine.
    vi.mocked(getEntryVersion).mockResolvedValue(
      hookEntry({
        name: '@acme/hook',
        trust_level: 'low',
        hook_meta: {
          target: { image: { ref: IMG_B, port: 8080 } },
          lifecyclePoints: ['preCall'],
        },
      })
    )

    const res = await request(makeApp(gw))
      .post('/admin/registry/upgrade-hook')
      .send({ hookName: 'my-hook', registryEntryName: '@acme/hook', registryEntryVersion: '2.0.0' })
      .expect(200)
    expect(res.body.hookName).toBe('my-hook')
    const cr = (await gw.getResource('llmhooks', 'my-hook', config.llmHooksNamespace)) as {
      spec: { target: { image: { ref: string } } }
    }
    expect(cr.spec.target.image.ref).toBe(IMG_B)
  })
})
