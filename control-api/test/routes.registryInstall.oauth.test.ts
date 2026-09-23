import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  computeInstallOAuthScopes,
  createAdminRegistryRouter,
  deriveOAuthClientId,
} from '../src/routes/admin/registry.js'
import {
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
} from '../src/services/registryClient.js'
import { MockGateway } from './mockGateway.js'

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

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as import('../src/k8s.js').K8sGateway))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

function makeInstallApp() {
  const gw = new MockGateway('mcp-server')
  gw.createResource('contexts', {
    metadata: { name: 'default-context' },
    spec: { contextId: 'default-context', mcpServers: [] },
  })
  return { app: makeApp(gw), gw }
}

/** Build a baked-OAuth catalog entry. `oauth` lives under mcp_server_meta. */
function oauthEntry(oauth: Record<string, unknown>, imageRef = 'clerum/gmail-mcp:1.0.0') {
  return {
    id: '1',
    name: 'gmail-mcp',
    version: '1.0.0',
    entry_type: 'mcp-server',
    description: 'Gmail MCP server',
    author: 'clerum',
    origin: 'official',
    category: 'productivity',
    tags: ['gmail'],
    trust_level: 'high',
    quality_tier: 'verified',
    status: 'published',
    server_mode: 'local',
    transport: 'streamableHttp',
    recipe_type: null,
    mcp_server_meta: { imageRef, port: 3000, oauth },
    recipe_meta: null,
    artifact_refs: null,
    downloads: 0,
    installs: 0,
    created_at: '2026-03-01T00:00:00Z',
  }
}

async function readServerOAuth(gw: MockGateway, name: string) {
  const mcp = (await gw.getResource('mcpservers', name, 'mcp-server')) as {
    spec: { auth?: { type?: string }; oauth?: Record<string, unknown> }
  }
  return mcp.spec
}

describe('pure helpers', () => {
  it('deriveOAuthClientId normalises to the CRD id pattern and truncates to 63', () => {
    expect(deriveOAuthClientId('my-gmail')).toBe('my-gmail')
    expect(deriveOAuthClientId('mcp-Gmail.v1')).toBe('mcp-gmail-v1')
    expect(deriveOAuthClientId('a'.repeat(80))).toHaveLength(63)
    expect(/^[a-z0-9-]{1,63}$/.test(deriveOAuthClientId('mcp-gmail-v1-0-0-abcd1234'))).toBe(true)
  })

  it('computeInstallOAuthScopes: operator → catalog → defaultScopes precedence', () => {
    expect(
      computeInstallOAuthScopes({
        operatorScopes: ['a'],
        catalogScopes: ['b'],
        defaultScopes: ['c'],
      })
    ).toEqual(['a'])
    expect(
      computeInstallOAuthScopes({
        operatorScopes: undefined,
        catalogScopes: ['b'],
        defaultScopes: ['c'],
      })
    ).toEqual(['b'])
    expect(
      computeInstallOAuthScopes({ operatorScopes: [], catalogScopes: ['b'], defaultScopes: ['c'] })
    ).toEqual(['b'])
    expect(
      computeInstallOAuthScopes({
        operatorScopes: undefined,
        catalogScopes: [],
        defaultScopes: ['c'],
      })
    ).toEqual(['c'])
    expect(
      computeInstallOAuthScopes({ operatorScopes: undefined, catalogScopes: [], defaultScopes: [] })
    ).toEqual([])
  })
})

describe('POST /admin/registry/install — OAuth (S1-U2/U3)', () => {
  // Fam. A(3) / E-19.3 + managed Secret happy path
  it('generates spec.oauth from catalog + operator input and creates the managed client Secret', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()

    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          grantScope: 'user',
          secret: { mode: 'managed', clientId: 'cid-value', clientSecret: 'csec-value' },
        },
      })
      .expect(201)

    const spec = await readServerOAuth(gw, 'my-gmail')
    expect(spec.auth?.type).toBe('oauth')
    expect(spec.oauth?.id).toBe('my-gmail')
    expect(spec.oauth?.provider).toBe('google')
    expect(spec.oauth?.grantScope).toBe('user')
    // E-19.3: the wizard scopes reach spec.oauth
    expect(spec.oauth?.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly'])
    expect(spec.oauth?.clientIdRef).toEqual({ name: 'my-gmail-oauth-client', key: 'client_id' })
    expect(spec.oauth?.clientSecretRef).toEqual({
      name: 'my-gmail-oauth-client',
      key: 'client_secret',
    })

    // Managed Secret created with canonical keys.
    const secret = (await gw.getSecret('my-gmail-oauth-client', 'mcp-server')) as {
      stringData?: Record<string, string>
    }
    expect(Object.keys(secret.stringData ?? {}).sort()).toEqual(['client_id', 'client_secret'])
  })

  it('never echoes client_id/client_secret values in the response body', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: {
            mode: 'managed',
            clientId: 'super-secret-id',
            clientSecret: 'super-secret-value',
          },
        },
      })
      .expect(201)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('super-secret-value')
    expect(raw).not.toContain('super-secret-id')
  })

  // Fam. B(2) / GAP-6: three google servers, distinct per-server scopes
  it('carries distinct per-server scopes for three google installs', async () => {
    const scopeSets = [['gmail.readonly'], ['drive.readonly'], ['calendar.readonly']]
    const names = ['gmail-a', 'drive-b', 'cal-c']
    const { app, gw } = makeInstallApp()
    for (let i = 0; i < names.length; i++) {
      vi.mocked(getEntryVersion).mockResolvedValueOnce(
        oauthEntry({ provider: 'google', scopes: [] })
      )
      await request(app)
        .post('/admin/registry/install')
        .send({
          serverName: names[i],
          contextRef: 'default-context',
          registryEntryName: 'gmail-mcp',
          registryEntryVersion: '1.0.0',
          oauth: {
            scopes: scopeSets[i],
            secret: { mode: 'managed', clientId: `id-${i}`, clientSecret: `sec-${i}` },
          },
        })
        .expect(201)
    }
    for (let i = 0; i < names.length; i++) {
      const spec = await readServerOAuth(gw, names[i])
      expect(spec.oauth?.scopes).toEqual(scopeSets[i])
    }
  })

  // GAP-6: prefill empty + defaultScopes empty ⇒ scopes required
  it('rejects a google install when no scopes are supplied and defaultScopes is empty', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' } },
      })
      .expect(400)
    expect(res.body.error).toMatch(/requires explicit scopes/)
    await expect(gw.getResource('mcpservers', 'my-gmail', 'mcp-server')).rejects.toThrow()
  })

  it('falls back to the adapter defaultScopes for a provider that has them (microsoft-graph)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({ provider: 'microsoft-graph', scopes: [] }, 'clerum/ms-mcp:1.0.0')
    )
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'ms-server',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' } },
      })
      .expect(201)
    const spec = await readServerOAuth(gw, 'ms-server')
    expect(spec.oauth?.scopes).toContain('offline_access')
  })

  // Fam. B(1): reference to a missing Secret/key ⇒ reject BEFORE writing the CR
  it('rejects reference mode when the referenced Secret does not exist (before writing the CR)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: {
            mode: 'reference',
            secretName: 'ghost-secret',
            clientIdKey: 'CID',
            clientSecretKey: 'CSEC',
          },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/not found/)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  it('rejects reference mode when a named key is missing on the Secret', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    gw.seedSecret('existing-oauth', 'mcp-server', { data: { CID: 'eA==' } }) // only CID, no CSEC
    const createResourceSpy = vi.spyOn(gw, 'createResource')
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: {
            mode: 'reference',
            secretName: 'existing-oauth',
            clientIdKey: 'CID',
            clientSecretKey: 'CSEC',
          },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/missing key/)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  it('accepts reference mode when the Secret + both keys exist and creates NO managed Secret', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    gw.seedSecret('existing-oauth', 'mcp-server', { data: { CID: 'eA==', CSEC: 'eQ==' } })
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: {
            mode: 'reference',
            secretName: 'existing-oauth',
            clientIdKey: 'CID',
            clientSecretKey: 'CSEC',
          },
        },
      })
      .expect(201)
    const spec = await readServerOAuth(gw, 'my-gmail')
    expect(spec.oauth?.clientIdRef).toEqual({ name: 'existing-oauth', key: 'CID' })
    expect(spec.oauth?.clientSecretRef).toEqual({ name: 'existing-oauth', key: 'CSEC' })
    // No managed Secret was created under the derived name.
    await expect(gw.getSecret('my-gmail-oauth-client', 'mcp-server')).rejects.toThrow()
  })

  // D-B5: id collision rejected by the uniqueness pre-check
  it('rejects an install whose derived oauth.id collides with an existing server', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    await gw.createResource(
      'mcpservers',
      { metadata: { name: 'other-server' }, spec: { oauth: { id: 'my-gmail' } } },
      'mcp-server'
    )
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' },
        },
      })
      .expect(409)
    expect(res.body.error).toMatch(/already in use/)
  })

  // D-B4: missing callback base URL ⇒ reject
  it('rejects an OAuth install when CONTROL_API_OAUTH_CALLBACK_BASE_URL is empty', async () => {
    config.oauthCallbackBaseUrl = ''
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app, gw } = makeInstallApp()
    const createResourceSpy = vi.spyOn(gw, 'createResource')
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/CALLBACK_BASE_URL/)
    expect(createResourceSpy.mock.calls.some(call => call[0] === 'mcpservers')).toBe(false)
  })

  // S-4: genericConfig in the catalog is IGNORED in Slice 1 (never auto-applied)
  it('ignores a genericConfig block on a baked provider (no endpoints reach spec.oauth)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({
        provider: 'google',
        scopes: ['gmail.readonly'],
        genericConfig: {
          authorizationEndpoint: 'https://evil.example.com/auth',
          tokenEndpoint: 'https://evil.example.com/token',
        },
      })
    )
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' } },
      })
      .expect(201)
    const spec = await readServerOAuth(gw, 'my-gmail')
    const raw = JSON.stringify(spec.oauth)
    expect(raw).not.toContain('evil.example.com')
    expect(spec.oauth).not.toHaveProperty('authorizationEndpoint')
    expect(spec.oauth).not.toHaveProperty('genericConfig')
  })

  it("rejects the 'generic' sentinel provider in Slice 1", async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({ provider: 'generic', scopes: ['x'] })
    )
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-generic',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' } },
      })
      .expect(400)
    expect(res.body.error).toMatch(/not a supported baked provider/)
  })

  it('requires operator oauth credentials when the catalog declares OAuth', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({ provider: 'google', scopes: ['gmail.readonly'] })
    )
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(400)
    expect(res.body.error).toMatch(/client credentials are required/)
  })

  // FIX 1 (T3): uninstall must reclaim the managed OAuth client Secret, else a
  // reinstall re-enters Step 3b and 409s on createSecret.
  it('deletes the managed oauth-client Secret on uninstall', async () => {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-gmail' },
      spec: {
        image: 'clerum/gmail-mcp:1.0.0',
        auth: { type: 'oauth' },
        oauth: {
          id: 'my-gmail',
          provider: 'google',
          clientIdRef: { name: 'my-gmail-oauth-client', key: 'client_id' },
          clientSecretRef: { name: 'my-gmail-oauth-client', key: 'client_secret' },
        },
      },
    })
    gw.seedSecret('my-gmail-oauth-client', 'mcp-server', {
      stringData: { client_id: 'id', client_secret: 'sec' },
    })
    const app = makeApp(gw)

    const res = await request(app).delete('/admin/registry/uninstall/my-gmail').expect(200)

    expect(res.body.deleted).toContain('Secret/my-gmail-oauth-client')
    await expect(gw.getSecret('my-gmail-oauth-client', 'mcp-server')).rejects.toThrow()
  })

  // FIX 2: a present-but-invalid body.oauth must report the real validation
  // failure, not the "credentials required" message — and must not leak values.
  it('400s with a descriptive message when body.oauth.grantScope is invalid', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['gmail.readonly'],
          grantScope: 'nonsense',
          secret: { mode: 'managed', clientId: 'id', clientSecret: 'leaky-secret-value' },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/invalid oauth input/)
    expect(res.body.error).toMatch(/grantScope/)
    expect(res.body.error).not.toMatch(/credentials are required/)
    expect(res.body.error).not.toContain('leaky-secret-value')
  })

  it('400s with a descriptive message when body.oauth.scopes is not an array', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'google', scopes: [] }))
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-gmail',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: 'gmail.readonly',
          secret: { mode: 'managed', clientId: 'id', clientSecret: 'sec' },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/invalid oauth input/)
    expect(res.body.error).toMatch(/scopes/)
  })

  it('leaves a non-OAuth install unchanged (no spec.oauth, no auth block)', async () => {
    const entry = oauthEntry({ provider: 'google', scopes: [] })
    const noOauth = {
      ...entry,
      mcp_server_meta: { imageRef: 'clerum/plain-mcp:1.0.0', port: 3000 },
    }
    vi.mocked(getEntryVersion).mockResolvedValueOnce(noOauth)
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'plain-server',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
      })
      .expect(201)
    const spec = await readServerOAuth(gw, 'plain-server')
    expect(spec.oauth).toBeUndefined()
    expect(spec.auth).toBeUndefined()
  })
})
