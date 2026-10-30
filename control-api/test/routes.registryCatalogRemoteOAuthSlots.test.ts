import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { K8sGateway } from '../src/k8s.js'
import {
  classifyRemoteOAuthSlots,
  deriveCatalogRemoteServerName,
  resolveRemoteOAuthEntry,
} from '../src/routes/admin/catalogRemoteOAuth.js'
import {
  createAdminRegistryRouter,
  getInstalledRegistryState,
} from '../src/routes/admin/registry.js'
import {
  getCategories,
  getCredentialSchema,
  getDigest,
  getEntryVersion,
  reportInstall,
  searchEntries,
} from '../src/services/registryClient.js'
import { registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  REMOTE_OAUTH_FIXTURE_BASE_URL,
  remoteOAuthMcpServer,
} from './fixtures/remoteOAuthMcpServer.js'
import { MockGateway } from './mockGateway.js'

/**
 * Install state of remote-OAuth connectors as `GET /admin/registry/catalog` reports
 * it. CRs come from the real producers: the remote saga's resource builder (with the
 * catalog annotations every catalog install stamps) and the registry install route.
 * Registry rows come from `registryEntryRow`.
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

function makeApp(gw: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gw as unknown as K8sGateway))
  return app
}

function remoteOAuthRow(
  name: string,
  allowedGrantScopes: Array<'user' | 'context'>,
  extra: Record<string, unknown> = {}
) {
  const org = /^@([^/]+)\//.exec(name)?.[1]
  return registryEntryRow(
    {
      name,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: REMOTE_OAUTH_FIXTURE_BASE_URL }],
        oauth: { source: 'remote', allowedGrantScopes, expectedRegistration: 'cimd', ...extra },
      },
    },
    org === 'evenfire' || org === 'clerum'
      ? { kind: 'curator-machine' }
      : { kind: 'org-machine', org: org! }
  )
}

const plainRemoteRow = (name: string) =>
  registryEntryRow(
    {
      name,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: 'https://plain.example.com/mcp' }],
      },
    },
    { kind: 'curator-machine' }
  )

const NOTION = '@evenfire/notion'
const LINEAR = '@acme/linear'
const canonical = deriveCatalogRemoteServerName

async function seedCr(gw: MockGateway, input: Parameters<typeof remoteOAuthMcpServer>[0]) {
  await gw.createResource('mcpservers', await remoteOAuthMcpServer(input), NS)
}

/** The registry install of a plain remote entry, under the given server name. */
async function registryInstall(gw: MockGateway, serverName: string, entryName: string) {
  vi.mocked(getEntryVersion).mockResolvedValueOnce(plainRemoteRow(entryName) as never)
  const res = await request(makeApp(gw)).post('/admin/registry/install').send({
    serverName,
    registryEntryName: entryName,
    registryEntryVersion: '1.0.0',
  })
  expect(res.status).toBe(201)
}

async function catalog(gw: MockGateway, rows: Array<Record<string, unknown>>) {
  vi.mocked(searchEntries).mockResolvedValue({
    data: rows,
    meta: { total: rows.length, limit: 200, offset: 0 },
  } as never)
  const res = await request(makeApp(gw)).get('/admin/registry/catalog')
  expect(res.status).toBe(200)
  return res.body.installed as {
    catalogKeys: string[]
    serverNames: string[]
    remoteOAuthSlots: Record<string, Record<string, unknown>>
    manualRemoteOAuth: Array<Record<string, unknown>>
  }
}

describe('GET /admin/registry/catalog — remote-OAuth install slots', () => {
  it('reports catalog instances per slot, with canonical and terminating', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, {
      serverName: canonical(NOTION, 'user'),
      namespace: NS,
      grantScope: 'user',
      catalog: { id: NOTION, version: '1.0.0' },
    })
    await seedCr(gw, {
      serverName: 'hand-named-notion',
      namespace: NS,
      grantScope: 'context',
      catalog: { id: NOTION, version: '1.1.0' },
    })
    gw.markDeleting('mcpservers', 'hand-named-notion', NS)

    const installed = await catalog(gw, [remoteOAuthRow(NOTION, ['user', 'context'])])

    expect(installed.remoteOAuthSlots).toEqual({
      [NOTION]: {
        user: {
          kind: 'instance',
          serverName: canonical(NOTION, 'user'),
          version: '1.0.0',
          canonical: true,
          terminating: false,
        },
        context: {
          kind: 'instance',
          serverName: 'hand-named-notion',
          version: '1.1.0',
          canonical: false,
          terminating: true,
        },
      },
    })
    expect(installed.manualRemoteOAuth).toEqual([])
  })

  it('keeps remote-OAuth CRs out of catalogKeys but in serverNames', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, {
      serverName: canonical(NOTION, 'user'),
      namespace: NS,
      grantScope: 'user',
      catalog: { id: NOTION, version: '1.0.0' },
    })
    await seedCr(gw, { serverName: 'manual-notion', namespace: NS, grantScope: 'user' })
    await registryInstall(gw, 'plain-srv', '@evenfire/plain')

    const installed = await catalog(gw, [])

    expect(installed.catalogKeys).toEqual(['@evenfire/plain@1.0.0'])
    expect(installed.serverNames).toEqual(
      [canonical(NOTION, 'user'), 'manual-notion', 'plain-srv'].sort((a, b) => a.localeCompare(b))
    )
  })

  it('lists remote-OAuth servers without a catalog id as manual', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, { serverName: 'manual-u', namespace: NS, grantScope: 'user' })
    await seedCr(gw, { serverName: 'manual-c', namespace: NS, grantScope: 'context' })
    await registryInstall(gw, 'plain-srv', '@evenfire/plain')

    const installed = await catalog(gw, [])

    expect(installed.manualRemoteOAuth).toEqual([
      { serverName: 'manual-c', baseUrl: REMOTE_OAUTH_FIXTURE_BASE_URL, grantScope: 'context' },
      { serverName: 'manual-u', baseUrl: REMOTE_OAUTH_FIXTURE_BASE_URL, grantScope: 'user' },
    ])
    expect(installed.remoteOAuthSlots).toEqual({})
  })

  it('marks a slot foreign when another McpServer holds its canonical name', async () => {
    const gw = new MockGateway(NS)
    // A manual remote-OAuth install that picked the user slot's name.
    await seedCr(gw, { serverName: canonical(LINEAR, 'user'), namespace: NS, grantScope: 'user' })
    // A generic registry install of another entry on the context slot's name.
    await registryInstall(gw, canonical(LINEAR, 'context'), '@evenfire/plain')

    const installed = await catalog(gw, [remoteOAuthRow(LINEAR, ['user', 'context'])])

    expect(installed.remoteOAuthSlots).toEqual({
      [LINEAR]: {
        user: { kind: 'foreign', serverName: canonical(LINEAR, 'user') },
        context: { kind: 'foreign', serverName: canonical(LINEAR, 'context') },
      },
    })
  })

  it('a CR of the entry with the other grant scope makes the slot it squats foreign', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, {
      serverName: canonical(LINEAR, 'user'),
      namespace: NS,
      grantScope: 'context',
      catalog: { id: LINEAR, version: '1.0.0' },
    })

    const installed = await catalog(gw, [remoteOAuthRow(LINEAR, ['user', 'context'])])

    expect(installed.remoteOAuthSlots[LINEAR]).toEqual({
      user: { kind: 'foreign', serverName: canonical(LINEAR, 'user') },
      context: {
        kind: 'instance',
        serverName: canonical(LINEAR, 'user'),
        version: '1.0.0',
        canonical: false,
        terminating: false,
      },
    })
  })

  it('evaluates foreign only for slots a valid entry allows', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, {
      serverName: canonical(LINEAR, 'context'),
      namespace: NS,
      grantScope: 'user',
    })
    await seedCr(gw, { serverName: canonical(NOTION, 'user'), namespace: NS, grantScope: 'user' })

    const installed = await catalog(gw, [
      // Only the user slot exists for this entry.
      remoteOAuthRow(LINEAR, ['user']),
      // Invalid: a curator pre-registered entry without its guide.
      remoteOAuthRow(NOTION, ['user'], { expectedRegistration: 'pre-registered' }),
    ])

    expect(installed.remoteOAuthSlots).toEqual({})
  })

  it('an entry that was not resolved carries no verdict and opens no slot', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, { serverName: canonical(LINEAR, 'user'), namespace: NS, grantScope: 'user' })

    // A raw registry row: same block, but no `remoteOAuth` verdict attached.
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway, [
      remoteOAuthRow(LINEAR, ['user']),
    ])

    expect(installed.remoteOAuthSlots).toEqual({})
  })

  it('a verdict on an entry that is not remote-OAuth opens no slot', async () => {
    const gw = new MockGateway(NS)
    await seedCr(gw, { serverName: canonical(LINEAR, 'user'), namespace: NS, grantScope: 'user' })

    // Defence in depth: the registry never emits a top-level `remoteOAuth`, and
    // resolution leaves non-remote-OAuth entries untouched, so a verdict found
    // there must not be trusted.
    const row = remoteOAuthRow(LINEAR, ['user'])
    const meta = row.mcp_server_meta as { oauth: Record<string, unknown> }
    const notRemote = {
      ...row,
      mcp_server_meta: { ...meta, oauth: { ...meta.oauth, source: 'generic' } },
      remoteOAuth: { valid: true },
    }
    const installed = await getInstalledRegistryState(gw as unknown as K8sGateway, [notRemote])

    expect(installed.remoteOAuthSlots).toEqual({})
  })

  it.each([
    ['canonical sorts last', ['aaa-first-by-name']],
    ['canonical sorts first', ['zzz-later']],
  ])('two CRs on one slot: the canonical one is reported (%s)', async (_label, others) => {
    const gw = new MockGateway(NS)
    for (const serverName of [...others, canonical(NOTION, 'user')]) {
      await seedCr(gw, {
        serverName,
        namespace: NS,
        grantScope: 'user',
        catalog: { id: NOTION, version: '1.0.0' },
      })
    }

    const installed = await catalog(gw, [remoteOAuthRow(NOTION, ['user'])])

    expect(installed.remoteOAuthSlots[NOTION]?.user).toMatchObject({
      kind: 'instance',
      serverName: canonical(NOTION, 'user'),
      canonical: true,
    })
  })

  it('two non-canonical CRs on one slot: the first by name is reported', async () => {
    const gw = new MockGateway(NS)
    // Seeded in reverse so creation order cannot stand in for name order.
    for (const serverName of ['zzz-later', 'aaa-first-by-name']) {
      await seedCr(gw, {
        serverName,
        namespace: NS,
        grantScope: 'user',
        catalog: { id: NOTION, version: '1.0.0' },
      })
    }

    const installed = await catalog(gw, [remoteOAuthRow(NOTION, ['user'])])

    expect(installed.remoteOAuthSlots[NOTION]?.user).toMatchObject({
      kind: 'instance',
      serverName: 'aaa-first-by-name',
      canonical: false,
    })
  })
})

describe('slot classification never writes through a catalog id onto shared prototypes', () => {
  const pollutedKeys = ['user', 'context'] as const
  afterEach(() => {
    // Undo a pollution so one red case cannot cascade into unrelated tests.
    for (const target of [Object.prototype, Object, Object.prototype.toString]) {
      for (const key of pollutedKeys) delete (target as unknown as Record<string, unknown>)[key]
    }
  })

  async function seedSquatters(catalogId: string) {
    const gw = new MockGateway(NS)
    await seedCr(gw, {
      serverName: 'squatter',
      namespace: NS,
      grantScope: 'user',
      catalog: { id: catalogId, version: '1.0.0' },
    })
    await seedCr(gw, {
      serverName: 'squatter-ctx',
      namespace: NS,
      grantScope: 'context',
      catalog: { id: catalogId, version: '1.0.0' },
    })
    return getInstalledRegistryState(gw as unknown as K8sGateway)
  }

  function expectNoPollution(catalogId: string) {
    // Whatever a plain object inherits under that key must come out untouched.
    const inherited = ({} as Record<string, unknown>)[catalogId] as Record<string, unknown>
    for (const key of pollutedKeys) {
      expect(({} as Record<string, unknown>)[key]).toBeUndefined()
      expect(inherited[key]).toBeUndefined()
    }
  }

  it.each(['__proto__', 'toString'])(
    'a CR annotated with catalog id %j (not a registry name) is ignored and pollutes nothing',
    async catalogId => {
      const installed = await seedSquatters(catalogId)

      expectNoPollution(catalogId)
      expect(Object.keys(installed.remoteOAuthSlots)).toEqual([])
      expect(installed.manualRemoteOAuth).toEqual([])
      expect(installed.serverNames).toEqual(['squatter', 'squatter-ctx'])
    }
  )

  it('catalog id "constructor" is a valid registry name: classified as an own key only', async () => {
    const installed = await seedSquatters('constructor')

    expectNoPollution('constructor')
    expect(Object.keys(installed.remoteOAuthSlots)).toEqual(['constructor'])
    expect(JSON.parse(JSON.stringify(installed.remoteOAuthSlots))).toEqual({
      constructor: {
        user: expect.objectContaining({ kind: 'instance', serverName: 'squatter' }),
        context: expect.objectContaining({ kind: 'instance', serverName: 'squatter-ctx' }),
      },
    })
  })

  it('an entry name the registry would never accept opens no foreign slot', async () => {
    // Defense in depth: the registry's name grammar rejects `__proto__`, so this
    // entry is the real row with only its name overridden.
    const hostile = resolveRemoteOAuthEntry({
      ...remoteOAuthRow(LINEAR, ['user']),
      name: '__proto__',
    })
    const squatter = await remoteOAuthMcpServer({
      serverName: canonical('__proto__', 'user'),
      namespace: NS,
      grantScope: 'user',
    })

    const { remoteOAuthSlots } = classifyRemoteOAuthSlots([squatter], [hostile])

    expect(({} as Record<string, unknown>).user).toBeUndefined()
    expect(Object.keys(remoteOAuthSlots)).toEqual([])
  })
})
