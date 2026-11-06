import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import {
  createAdminRegistryRouter,
  getInstalledRegistryState,
} from '../src/routes/admin/registry.js'
import {
  getCategories,
  getCredentialSchema,
  getDigest,
  getEntry,
  getEntryVersion,
  reportInstall,
  searchEntries,
  updateVersionMetadata,
} from '../src/services/registryClient.js'
import { malformedRow, registryEntryRow } from './fixtures/registryEntryRow.js'
import { remoteOAuthMcpServer } from './fixtures/remoteOAuthMcpServer.js'
import { MockGateway } from './mockGateway.js'

/**
 * Remote-OAuth catalog entries on the generic registry routes.
 *
 * Registry rows come from `registryEntryRow` (what the registry's `createEntry`
 * would store for that publisher), McpServer CRs from the real install producers
 * (the registry install route, or the remote saga's resource builder). Only the
 * registry HTTP client and K8s are doubles.
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

const NS = 'mcp-server'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getDigest).mockResolvedValue({ digest: null })
  vi.mocked(getCredentialSchema).mockRejectedValue(new Error('No credential schema endpoint'))
  vi.mocked(reportInstall).mockResolvedValue({ acknowledged: true, stored: true })
  vi.mocked(getCategories).mockResolvedValue({ data: [] })
})

function makeApp(gw?: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gw as unknown as K8sGateway))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

const PRESENTATION = {
  providerConsoleUrl: 'https://console.example.com/apps',
  setupGuide: '1. Create an app\n2. Paste the client id',
  verification: { status: 'verified', checkedAt: '2026-10-28' },
} as const

function remoteOAuthMeta(extra: Record<string, unknown> = {}) {
  return {
    serverMode: 'remote' as const,
    transport: 'streamableHttp',
    remoteEndpoints: [{ url: 'https://mcp.notion.com/mcp' }],
    oauth: {
      source: 'remote',
      allowedGrantScopes: ['user', 'context'],
      expectedRegistration: 'pre-registered',
      ...extra,
    },
  }
}

/** Curator entry with the full presentation block. */
const curatorRow = () =>
  registryEntryRow(
    { name: '@evenfire/notion', mcpServer: remoteOAuthMeta(PRESENTATION) },
    { kind: 'curator-machine' }
  )

/** The same block published by an org into its own scope. */
const orgRow = () =>
  registryEntryRow(
    { name: '@acme/notion', mcpServer: remoteOAuthMeta(PRESENTATION) },
    { kind: 'org-machine', org: 'acme' }
  )

/** A curator `pre-registered` entry missing the guide the wizard needs: invalid. */
const invalidCuratorRow = () =>
  registryEntryRow(
    {
      name: '@evenfire/broken',
      mcpServer: remoteOAuthMeta({ verification: PRESENTATION.verification }),
    },
    { kind: 'curator-machine' }
  )

/**
 * The same block published unscoped by a curator-class client. The registry
 * stores it in the reserved `@clerum` org, but without the scope in its name it
 * is not a curated publish.
 */
const unscopedCuratorRow = () =>
  registryEntryRow(
    { name: 'notion-remote', mcpServer: remoteOAuthMeta(PRESENTATION) },
    { kind: 'curator-machine' }
  )

/** A plain remote entry (static headers, no OAuth); `@acme/*` names are published by acme. */
const plainRemoteRow = (name: string, version = '1.0.0') =>
  registryEntryRow(
    {
      name,
      version,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: 'https://plain.example.com/mcp' }],
      },
    },
    name.startsWith('@acme/') ? { kind: 'org-machine', org: 'acme' } : { kind: 'curator-machine' }
  )

type Oauth = Record<string, unknown>
const oauthOf = (entry: { mcp_server_meta?: { oauth?: Oauth } }) => entry.mcp_server_meta?.oauth

function expectCuratorIntact(entry: Record<string, unknown>) {
  expect(entry.remoteOAuth).toEqual({ valid: true })
  expect(entry).not.toHaveProperty('publisher')
  expect(oauthOf(entry)).toMatchObject(PRESENTATION)
}

function expectOrgStripped(entry: Record<string, unknown>) {
  expect(entry.remoteOAuth).toEqual({ valid: true })
  expect(entry.publisher).toBe('@acme')
  const oauth = oauthOf(entry)!
  for (const key of ['verification', 'setupGuide', 'providerConsoleUrl']) {
    expect(oauth).not.toHaveProperty(key)
  }
  expect(oauth).toMatchObject({ source: 'remote', allowedGrantScopes: ['user', 'context'] })
}

function expectUnscopedStripped(entry: Record<string, unknown>) {
  expect(entry.remoteOAuth).toEqual({ valid: true })
  expect(entry.publisher).toBeNull()
  expect(oauthOf(entry)).toEqual({
    source: 'remote',
    allowedGrantScopes: ['user', 'context'],
    expectedRegistration: 'pre-registered',
  })
}

function expectInvalidStripped(entry: Record<string, unknown>) {
  expect(entry.remoteOAuth).toMatchObject({ valid: false })
  expect(oauthOf(entry)).toEqual({ source: 'remote' })
}

describe('catalog reads resolve remote-OAuth entries', () => {
  const page = () => {
    const rows = [
      curatorRow(),
      orgRow(),
      invalidCuratorRow(),
      plainRemoteRow('plain-mcp'),
      unscopedCuratorRow(),
    ]
    return { data: rows, meta: { total: rows.length, limit: 50, offset: 0 } }
  }

  it('GET /admin/registry/catalog', async () => {
    const source = page()
    vi.mocked(searchEntries).mockResolvedValue(source as never)
    const res = await request(makeApp(new MockGateway(NS))).get('/admin/registry/catalog')
    expect(res.status).toBe(200)
    const byName = new Map(
      (res.body.data as Array<Record<string, unknown>>).map(e => [e.name as string, e])
    )
    expectCuratorIntact(byName.get('@evenfire/notion')!)
    expectOrgStripped(byName.get('@acme/notion')!)
    expectInvalidStripped(byName.get('@evenfire/broken')!)
    expect(byName.get('plain-mcp')).toEqual(source.data[3])
    expectUnscopedStripped(byName.get('notion-remote')!)
  })

  it('GET /admin/registry/entries (search)', async () => {
    const source = page()
    vi.mocked(searchEntries).mockResolvedValue(source as never)
    const res = await request(makeApp()).get('/admin/registry/entries').query({ q: 'notion' })
    expect(res.status).toBe(200)
    expect(res.body.meta).toEqual(source.meta)
    const byName = new Map(
      (res.body.data as Array<Record<string, unknown>>).map(e => [e.name as string, e])
    )
    expectCuratorIntact(byName.get('@evenfire/notion')!)
    expectOrgStripped(byName.get('@acme/notion')!)
    expectInvalidStripped(byName.get('@evenfire/broken')!)
    expect(byName.get('plain-mcp')).toEqual(source.data[3])
    expectUnscopedStripped(byName.get('notion-remote')!)
  })

  it.each([
    ['curator', curatorRow, expectCuratorIntact],
    ['org', orgRow, expectOrgStripped],
    ['invalid curator', invalidCuratorRow, expectInvalidStripped],
    ['unscoped curator-class', unscopedCuratorRow, expectUnscopedStripped],
  ] as const)('GET /admin/registry/entries/:name — %s', async (_label, row, expectation) => {
    const entry = row()
    vi.mocked(getEntry).mockResolvedValue(entry as never)
    const res = await request(makeApp()).get(
      `/admin/registry/entries/${encodeURIComponent(entry.name)}`
    )
    expect(res.status).toBe(200)
    expectation(res.body)
  })

  it.each([
    ['curator', curatorRow, expectCuratorIntact],
    ['org', orgRow, expectOrgStripped],
    ['invalid curator', invalidCuratorRow, expectInvalidStripped],
    ['unscoped curator-class', unscopedCuratorRow, expectUnscopedStripped],
  ] as const)(
    'GET /admin/registry/entries/:name/versions/:version — %s',
    async (_label, row, expectation) => {
      const entry = row()
      vi.mocked(getEntryVersion).mockResolvedValue(entry as never)
      const res = await request(makeApp()).get(
        `/admin/registry/entries/${encodeURIComponent(entry.name)}/versions/1.0.0`
      )
      expect(res.status).toBe(200)
      expectation(res.body)
    }
  )
})

/** Every K8s write the gateway exposes, so a refusal can be shown to write nothing. */
function spyWrites(gw: MockGateway) {
  return [
    vi.spyOn(gw, 'createResource'),
    vi.spyOn(gw, 'updateResource'),
    vi.spyOn(gw, 'mutateResource'),
    vi.spyOn(gw, 'deleteResource'),
    vi.spyOn(gw, 'createSecret'),
    vi.spyOn(gw, 'updateSecret'),
    vi.spyOn(gw, 'mergeSecret'),
    vi.spyOn(gw, 'deleteSecret'),
  ]
}

describe('POST /admin/registry/install refuses remote-OAuth entries', () => {
  it.each([
    ['a remote-OAuth entry', () => orgRow()],
    [
      'a remote entry that also carries `provider`',
      () =>
        malformedRow(
          { name: '@acme/notion', mcpServer: remoteOAuthMeta({ provider: 'google' }) },
          { kind: 'org-machine', org: 'acme' }
        ),
    ],
  ])('%s ⇒ 400 remote_oauth_entry_requires_remote_install, nothing written', async (_l, row) => {
    const entry = row()
    vi.mocked(getEntryVersion).mockResolvedValue(entry as never)
    const gw = new MockGateway(NS)
    const writes = spyWrites(gw)

    const res = await request(makeApp(gw))
      .post('/admin/registry/install')
      .send({
        registryEntryName: entry.name,
        registryEntryVersion: '1.0.0',
        oauth: { secret: { mode: 'managed', clientId: 'cid', clientSecret: 'csec' } },
      })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('remote_oauth_entry_requires_remote_install')
    expect(res.body.reason).toMatch(/Marketplace/)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })
})

describe('POST /admin/registry/upgrade refuses remote-OAuth connectors', () => {
  it('a remote-OAuth CR ⇒ 409 before reading the target entry, nothing written', async () => {
    const gw = new MockGateway(NS)
    await gw.createResource(
      'mcpservers',
      await remoteOAuthMcpServer({
        serverName: 'notion-u',
        namespace: NS,
        grantScope: 'user',
        catalog: { id: '@evenfire/notion', version: '1.0.0' },
      }),
      NS
    )
    const before = await gw.getResource('mcpservers', 'notion-u', NS)
    const writes = spyWrites(gw)

    const res = await request(makeApp(gw)).post('/admin/registry/upgrade').send({
      serverName: 'notion-u',
      registryEntryName: '@evenfire/notion',
      registryEntryVersion: '2.0.0',
    })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('remote_oauth_upgrade_unsupported')
    expect(getEntryVersion).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(await gw.getResource('mcpservers', 'notion-u', NS)).toEqual(before)
  })

  it('a plain remote CR pointed at a remote-OAuth version ⇒ 409, nothing written', async () => {
    const gw = new MockGateway(NS)
    const app = makeApp(gw)
    // The CR comes from the real registry install of the plain v1.
    vi.mocked(getEntryVersion).mockResolvedValueOnce(plainRemoteRow('@evenfire/notion') as never)
    const install = await request(app).post('/admin/registry/install').send({
      serverName: 'notion-plain',
      registryEntryName: '@evenfire/notion',
      registryEntryVersion: '1.0.0',
    })
    expect(install.status).toBe(201)
    const before = await gw.getResource('mcpservers', 'notion-plain', NS)

    const v2 = registryEntryRow(
      { name: '@evenfire/notion', version: '2.0.0', mcpServer: remoteOAuthMeta(PRESENTATION) },
      { kind: 'curator-machine' }
    )
    vi.mocked(getEntryVersion).mockResolvedValueOnce(v2 as never)
    const writes = spyWrites(gw)

    const res = await request(app).post('/admin/registry/upgrade').send({
      serverName: 'notion-plain',
      registryEntryName: '@evenfire/notion',
      registryEntryVersion: '2.0.0',
    })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('remote_oauth_upgrade_unsupported')
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    expect(await gw.getResource('mcpservers', 'notion-plain', NS)).toEqual(before)
  })
})

describe('PUT /admin/registry/entries/:name/versions/:version only edits egressSummary', () => {
  it.each([
    ['remoteEndpoints', { remoteEndpoints: [{ url: 'https://evil.example.com/mcp' }] }],
    ['oauth', { oauth: { source: 'remote', allowedGrantScopes: ['context'] } }],
    ['egressSummary plus oauth', { egressSummary: null, oauth: { source: 'remote' } }],
    ['a non-object', 'egressSummary'],
  ])('mcpServer with %s ⇒ 400, nothing forwarded', async (_label, mcpServer) => {
    const res = await request(makeApp())
      .put('/admin/registry/entries/%40acme%2Fnotion/versions/1.0.0')
      .send({ mcpServer })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('registry_version_mcp_server_field_not_editable')
    expect(updateVersionMetadata).not.toHaveBeenCalled()
  })

  it('mcpServer with only egressSummary is forwarded', async () => {
    vi.mocked(updateVersionMetadata).mockResolvedValue(orgRow() as never)
    const egressSummary = { domains: ['api.example.com'], ports: [443] }
    const res = await request(makeApp())
      .put('/admin/registry/entries/%40acme%2Fnotion/versions/1.0.0')
      .send({ description: 'd', mcpServer: { egressSummary } })
    expect(res.status).toBe(200)
    expect(updateVersionMetadata).toHaveBeenCalledWith('@acme/notion', '1.0.0', {
      description: 'd',
      tags: undefined,
      visibility: undefined,
      mcpServer: { egressSummary },
    })
  })
})

describe('registry install/upgrade stamp the catalog identity the registry returned', () => {
  const annotationsOf = async (gw: MockGateway, name: string) =>
    ((await gw.getResource('mcpservers', name, NS)) as { metadata: { annotations?: object } })
      .metadata.annotations
  const secretAnnotationsOf = async (gw: MockGateway, name: string) =>
    (await gw.getSecret(name, NS)).metadata?.annotations
  const CREDENTIAL_SCHEMA = {
    required: true,
    authType: 'api-key',
    keys: [{ name: 'API_KEY' }],
  }

  it('install: alias `x-mcp` resolved to `@clerum/x-mcp` ⇒ annotation and catalogKeys use it', async () => {
    const gw = new MockGateway(NS)
    vi.mocked(getEntryVersion).mockResolvedValue(plainRemoteRow('@clerum/x-mcp') as never)
    vi.mocked(getCredentialSchema).mockResolvedValue(CREDENTIAL_SCHEMA as never)

    const res = await request(makeApp(gw))
      .post('/admin/registry/install')
      .send({
        serverName: 'x-srv',
        registryEntryName: 'x-mcp',
        registryEntryVersion: '1.0.0',
        credentials: { API_KEY: 'k1' },
      })

    expect(res.status).toBe(201)
    expect(await annotationsOf(gw, 'x-srv')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '1.0.0',
    })
    expect(await secretAnnotationsOf(gw, 'x-srv-credentials')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '1.0.0',
    })
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway)
    expect(installed.catalogKeys).toContain('@clerum/x-mcp@1.0.0')
    expect(installed.catalogKeys).not.toContain('x-mcp@1.0.0')
  })

  it('upgrade: alias `x-mcp` resolved to `@clerum/x-mcp` ⇒ annotation and catalogKeys use it', async () => {
    const gw = new MockGateway(NS)
    const app = makeApp(gw)
    // v1 installed while the registry still answered under the unscoped name.
    vi.mocked(getEntryVersion).mockResolvedValueOnce(plainRemoteRow('x-mcp') as never)
    expect(
      (
        await request(app).post('/admin/registry/install').send({
          serverName: 'x-srv',
          registryEntryName: 'x-mcp',
          registryEntryVersion: '1.0.0',
        })
      ).status
    ).toBe(201)

    vi.mocked(getEntryVersion).mockResolvedValueOnce(
      plainRemoteRow('@clerum/x-mcp', '2.0.0') as never
    )
    vi.mocked(getCredentialSchema).mockResolvedValue(CREDENTIAL_SCHEMA as never)
    const res = await request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'x-srv',
        registryEntryName: 'x-mcp',
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'k2' },
      })

    expect(res.status).toBe(200)
    expect(await annotationsOf(gw, 'x-srv')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '2.0.0',
    })
    expect(await secretAnnotationsOf(gw, 'x-srv-credentials')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '2.0.0',
    })
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway)
    expect(installed.catalogKeys).toEqual(['@clerum/x-mcp@2.0.0'])
  })

  /** Installs `x-srv` through the real install route, the registry answering with `v1Row`. */
  async function installVia(app: express.Express, registryEntryName: string, v1Row: unknown) {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(v1Row as never)
    vi.mocked(getCredentialSchema).mockResolvedValue(CREDENTIAL_SCHEMA as never)
    const install = await request(app)
      .post('/admin/registry/install')
      .send({
        serverName: 'x-srv',
        registryEntryName,
        registryEntryVersion: '1.0.0',
        credentials: { API_KEY: 'k1' },
      })
    expect(install.status).toBe(201)
  }

  const upgradeVia = (app: express.Express, registryEntryName: string, v2Row: unknown) => {
    vi.mocked(getEntryVersion).mockResolvedValueOnce(v2Row as never)
    return request(app)
      .post('/admin/registry/upgrade')
      .send({
        serverName: 'x-srv',
        registryEntryName,
        registryEntryVersion: '2.0.0',
        credentials: { API_KEY: 'k2' },
      })
  }

  it('install by alias then upgrade by the same alias ⇒ 200, identity follows the resolved entry', async () => {
    const gw = new MockGateway(NS)
    const app = makeApp(gw)
    await installVia(app, 'x-mcp', plainRemoteRow('@clerum/x-mcp'))

    const res = await upgradeVia(app, 'x-mcp', plainRemoteRow('@clerum/x-mcp', '2.0.0'))

    expect(res.status).toBe(200)
    expect(await annotationsOf(gw, 'x-srv')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '2.0.0',
    })
    expect(await secretAnnotationsOf(gw, 'x-srv-credentials')).toMatchObject({
      'clerum.io/catalog-id': '@clerum/x-mcp',
      'clerum.io/catalog-version': '2.0.0',
    })
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway)
    expect(installed.catalogKeys).toEqual(['@clerum/x-mcp@2.0.0'])
  })

  it('install by alias then upgrade by the scoped name ⇒ 200', async () => {
    const gw = new MockGateway(NS)
    const app = makeApp(gw)
    await installVia(app, 'x-mcp', plainRemoteRow('@clerum/x-mcp'))

    const res = await upgradeVia(app, '@clerum/x-mcp', plainRemoteRow('@clerum/x-mcp', '2.0.0'))

    expect(res.status).toBe(200)
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway)
    expect(installed.catalogKeys).toEqual(['@clerum/x-mcp@2.0.0'])
  })

  it.each([
    // [installed via, v1 resolved as, upgrade requested, v2 resolved as]
    ['alias install, other alias', 'x-mcp', '@clerum/x-mcp', 'y-mcp', '@clerum/y-mcp'],
    ['alias install, other scoped entry', 'x-mcp', '@clerum/x-mcp', '@acme/y-mcp', '@acme/y-mcp'],
    ['legacy alias annotation, other entry', 'x-mcp', 'x-mcp', '@acme/y-mcp', '@acme/y-mcp'],
    ['scoped install, other entry', '@clerum/x-mcp', '@clerum/x-mcp', 'y-mcp', '@clerum/y-mcp'],
  ])(
    '%s ⇒ 409 mcp_server_entry_identity_mismatch, nothing written',
    async (_label, installName, v1Name, upgradeName, v2Name) => {
      const gw = new MockGateway(NS)
      const app = makeApp(gw)
      await installVia(app, installName, plainRemoteRow(v1Name))
      const before = await gw.getResource('mcpservers', 'x-srv', NS)
      const beforeSecret = await gw.getSecret('x-srv-credentials', NS)
      const writes = spyWrites(gw)

      const res = await upgradeVia(app, upgradeName, plainRemoteRow(v2Name, '2.0.0'))

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('mcp_server_entry_identity_mismatch')
      for (const write of writes) expect(write).not.toHaveBeenCalled()
      expect(await gw.getResource('mcpservers', 'x-srv', NS)).toEqual(before)
      expect(await gw.getSecret('x-srv-credentials', NS)).toEqual(beforeSecret)
    }
  )

  it.each([
    // [installed via, v1 resolved as, upgrade requested]
    ['scoped install, other scoped entry', '@clerum/x-mcp', '@clerum/x-mcp', '@acme/gone-mcp'],
    [
      'scoped install, same name under another scope',
      '@clerum/x-mcp',
      '@clerum/x-mcp',
      '@acme/x-mcp',
    ],
    ['alias install, other alias', 'x-mcp', '@clerum/x-mcp', 'gone-mcp'],
    ['legacy alias annotation, its scoped form', 'x-mcp', 'x-mcp', '@clerum/x-mcp'],
  ])(
    '%s that the registry does not have ⇒ 409 mcp_server_entry_identity_mismatch, not the registry 404',
    async (_label, installName, v1Name, upgradeName) => {
      const gw = new MockGateway(NS)
      const app = makeApp(gw)
      await installVia(app, installName, plainRemoteRow(v1Name))
      const writes = spyWrites(gw)
      vi.mocked(getEntryVersion).mockRejectedValueOnce(
        Object.assign(new Error('Registry 404'), { status: 404 })
      )

      const res = await request(app)
        .post('/admin/registry/upgrade')
        .send({
          serverName: 'x-srv',
          registryEntryName: upgradeName,
          registryEntryVersion: '2.0.0',
          credentials: { API_KEY: 'k2' },
        })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({
        error: 'mcp_server_entry_identity_mismatch',
        reason: `McpServer "x-srv" was installed from "${v1Name}", not "${upgradeName}" — uninstall and install to change entry`,
      })
      for (const write of writes) expect(write).not.toHaveBeenCalled()
    }
  )
})
