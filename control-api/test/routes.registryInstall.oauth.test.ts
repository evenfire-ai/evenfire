import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import { resolveServerOAuthSubject } from '../src/oauth/mcpServerOAuthSpec.js'
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

  // S-4: a MALFORMED catalog genericConfig is never read, so it must NEVER block the
  // install — the baked path installs exactly as it did before genericConfig was typed.
  it('installs a baked provider even when the catalog genericConfig is malformed', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({
        provider: 'google',
        scopes: ['gmail.readonly'],
        // Wrong-typed value + unknown key: a strict parse would reject the whole
        // catalog-oauth block; the non-fatal `.catch` drops the suggestion instead.
        genericConfig: { usePkce: 'yes', bogusKnob: 123 },
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
    expect(spec.oauth?.provider).toBe('google')
    expect(spec.oauth).not.toHaveProperty('genericConfig')
  })

  // S3-B4: 'generic' now opens the generic branch. A body WITHOUT the generic knob
  // block fails closed (inv.1) — it never reaches the baked provider gate.
  it("fails closed when 'generic' is declared but body.oauth.generic is absent", async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({ provider: 'generic', scopes: ['x'] })
    )
    const { app, gw } = makeInstallApp()
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
    expect(res.body.error).toMatch(/invalid generic oauth input/)
    await expect(gw.getResource('mcpservers', 'my-generic', 'mcp-server')).rejects.toThrow()
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

// ─── S3-B4: generic self-hosted carril install saga ─────────────────────────
describe('generic carril install (S3-B4)', () => {
  const VALID_KNOBS = {
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    tokenRequestFormat: 'form',
    tokenAuthMethod: 'body',
    scopeSeparator: 'space',
    sendScope: true,
    usePkce: true,
    includeResponseType: true,
    supportsRefresh: true,
  }

  async function readFullServer(gw: MockGateway, name: string) {
    return (await gw.getResource('mcpservers', name, 'mcp-server')) as {
      spec: { oauth?: Record<string, unknown>; auth?: { type?: string } }
    }
  }

  // T3: was 400 at b9a846a98 (registry.ts generic gate). Now 201 with source:generic.
  it('installs a PUBLIC generic client (no secret): CR carries source:generic + no refs', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { scopes: ['read', 'write'], generic: VALID_KNOBS },
      })
      .expect(201)

    const server = await readFullServer(gw, 'my-idp')
    expect(server.spec.auth?.type).toBe('oauth')
    expect(server.spec.oauth?.source).toBe('generic')
    expect(server.spec.oauth?.id).toBe('my-idp')
    expect(server.spec.oauth).not.toHaveProperty('provider')
    expect(server.spec.oauth).not.toHaveProperty('clientIdRef')
    expect(server.spec.oauth).not.toHaveProperty('clientSecretRef')
    expect(server.spec.oauth?.authorizationEndpoint).toBe('https://idp.example.com/authorize')
    expect(server.spec.oauth?.scopes).toEqual(['read', 'write'])
    // No managed Secret created for a public client.
    await expect(gw.getSecret('my-idp-oauth-client', 'mcp-server')).rejects.toThrow()

    // inv.3: the resolver (real producer→consumer) reads the CR back as public generic.
    const subject = resolveServerOAuthSubject({ spec: server.spec })
    expect(subject?.decl.provider).toBe('generic')
    expect(subject?.decl.secretSource).toEqual({ kind: 'public' })
  })

  // T3: 201 confidential — refs + managed Secret; resolver → k8s-secret.
  it('installs a CONFIDENTIAL generic client (managed secret): refs + Secret created', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['read'],
          secret: { mode: 'managed', clientId: 'cid', clientSecret: 'csec' },
          generic: { ...VALID_KNOBS, tokenAuthMethod: 'basic' },
        },
      })
      .expect(201)

    const server = await readFullServer(gw, 'my-idp')
    expect(server.spec.oauth?.clientIdRef).toEqual({
      name: 'my-idp-oauth-client',
      key: 'client_id',
    })
    expect(server.spec.oauth?.clientSecretRef).toEqual({
      name: 'my-idp-oauth-client',
      key: 'client_secret',
    })
    const secret = (await gw.getSecret('my-idp-oauth-client', 'mcp-server')) as {
      stringData?: Record<string, string>
    }
    expect(Object.keys(secret.stringData ?? {}).sort()).toEqual(['client_id', 'client_secret'])

    const subject = resolveServerOAuthSubject({ spec: server.spec })
    expect(subject?.decl.secretSource).toEqual({
      kind: 'k8s-secret',
      clientIdRef: { name: 'my-idp-oauth-client', key: 'client_id' },
      clientSecretRef: { name: 'my-idp-oauth-client', key: 'client_secret' },
    })
  })

  // inv.2: kernel §4 rejects an internal endpoint BEFORE any Secret/CR (422).
  it('422 oauth_endpoint_rejected for an internal token endpoint (0 Secrets, 0 CR)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app, gw } = makeInstallApp()
    const createSecretSpy = vi.spyOn(gw, 'createSecret')
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: {
          scopes: ['read'],
          generic: { ...VALID_KNOBS, tokenEndpoint: 'https://token.svc.cluster.local/token' },
        },
      })
      .expect(422)
    expect(res.body.error).toBe('oauth_endpoint_rejected')
    expect(
      res.body.errors.some((e: { field: string }) => e.field === 'oauth.generic.tokenEndpoint')
    ).toBe(true)
    expect(createSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getResource('mcpservers', 'my-idp', 'mcp-server')).rejects.toThrow()
  })

  // inv.1: tokenAuthMethod=basic without a secret is a public+basic client → reject.
  it('400 when tokenAuthMethod=basic but no secret is supplied', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { scopes: ['read'], generic: { ...VALID_KNOBS, tokenAuthMethod: 'basic' } },
      })
      .expect(400)
    expect(res.body.error).toMatch(/basic requires a client secret/)
  })

  // DA-4 / GAP-6: sendScope:true with no scopes ⇒ 400 oauth_scopes_required.
  it('400 oauth_scopes_required when sendScope:true and no scopes supplied', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app } = makeInstallApp()
    const res = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { generic: { ...VALID_KNOBS, sendScope: true } },
      })
      .expect(400)
    expect(res.body.error).toBe('oauth_scopes_required')
  })

  // DA-4: sendScope:false legalises an empty scope set.
  it('allows an empty scope set when sendScope:false', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(oauthEntry({ provider: 'generic' }))
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { generic: { ...VALID_KNOBS, sendScope: false } },
      })
      .expect(201)
    const server = await readFullServer(gw, 'my-idp')
    expect(server.spec.oauth?.scopes).toEqual([])
  })

  // inv.5: catalog genericConfig NEVER reaches the CR; the wizard-confirmed body wins.
  it('body.oauth.generic wins over a divergent catalog genericConfig (S-4)', async () => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      oauthEntry({
        provider: 'generic',
        genericConfig: {
          authorizationEndpoint: 'https://evil.example.com/authorize',
          tokenEndpoint: 'https://evil.example.com/token',
        },
      })
    )
    const { app, gw } = makeInstallApp()
    await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'my-idp',
        contextRef: 'default-context',
        registryEntryName: 'gmail-mcp',
        registryEntryVersion: '1.0.0',
        oauth: { scopes: ['read'], generic: VALID_KNOBS },
      })
      .expect(201)
    const server = await readFullServer(gw, 'my-idp')
    const raw = JSON.stringify(server.spec.oauth)
    expect(raw).not.toContain('evil.example.com')
    expect(server.spec.oauth?.authorizationEndpoint).toBe('https://idp.example.com/authorize')
  })

  // inv.10: uninstall reclaims a generic-confidential managed oauth-client Secret
  // (same derived name as baked), and a public generic server has nothing to delete.
  it('deletes the generic-confidential oauth-client Secret on uninstall', async () => {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-idp' },
      spec: {
        image: 'clerum/generic-mcp:1.0.0',
        auth: { type: 'oauth' },
        oauth: {
          source: 'generic',
          id: 'my-idp',
          ...VALID_KNOBS,
          clientIdRef: { name: 'my-idp-oauth-client', key: 'client_id' },
          clientSecretRef: { name: 'my-idp-oauth-client', key: 'client_secret' },
        },
      },
    })
    gw.seedSecret('my-idp-oauth-client', 'mcp-server', {
      stringData: { client_id: 'id', client_secret: 'sec' },
    })
    const res = await request(makeApp(gw)).delete('/admin/registry/uninstall/my-idp').expect(200)
    expect(res.body.deleted).toContain('Secret/my-idp-oauth-client')
    await expect(gw.getSecret('my-idp-oauth-client', 'mcp-server')).rejects.toThrow()
  })

  it('uninstall of a PUBLIC generic server (no oauth-client Secret) does not fail', async () => {
    const gw = new MockGateway('mcp-server')
    gw.createResource('mcpservers', {
      metadata: { name: 'my-idp' },
      spec: {
        image: 'clerum/generic-mcp:1.0.0',
        auth: { type: 'oauth' },
        oauth: { source: 'generic', id: 'my-idp', ...VALID_KNOBS },
      },
    })
    // The observable invariant is that uninstall of a public generic server (which
    // never created an oauth-client Secret) returns 200 and removes the server — the
    // best-effort by-name delete tolerates the absent Secret rather than failing.
    await request(makeApp(gw)).delete('/admin/registry/uninstall/my-idp').expect(200)
    await expect(gw.getResource('mcpservers', 'my-idp', 'mcp-server')).rejects.toThrow()
  })
})
