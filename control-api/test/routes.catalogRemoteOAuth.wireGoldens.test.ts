import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import request from 'supertest'
import { config } from '../src/config.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import { discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { PENDING_TTL_MS } from '../src/oauth/dynamicClientStore.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import {
  deriveCatalogRemoteServerName,
  normalizeRemoteBaseUrl,
} from '../src/routes/admin/catalogRemoteOAuth.js'
import { createAdminRegistryRouter } from '../src/routes/admin/registry.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import {
  type RegistryEntry,
  getCategories,
  getEntryVersion,
  searchEntries,
} from '../src/services/registryClient.js'
import { WORKIQ_GUID_SCOPE } from './fixtures/perServerInstall.js'
import { type PushRemoteMcpEntryBody, registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  ENTRA_WORKIQ_PILOT,
  PILOTS,
  type PilotFixture,
  VERCEL_PILOT,
  makeDiscoveryTransport,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { remoteOAuthMcpServer } from './fixtures/remoteOAuthMcpServer.js'
import { MockGateway } from './mockGateway.js'

/**
 * Golden wire bodies of the Marketplace remote-OAuth surface, consumed verbatim by
 * control-ui's install page and remote wizard tests (control-ui/test/fixtures/
 * catalogRemoteOAuthWire.ts). control-ui cannot import control-api, so instead of
 * retyping a catalog entry or a catalog-mode response there, every golden here is
 * what the real routers answer:
 *
 * - entry reads: `GET /admin/registry/entries/:name/versions/:version` through the
 *   registry router, over registry rows built by `registryEntryRow` (only rows the
 *   registry could have stored, owner stamped from the publisher);
 * - catalog mode of `/admin/mcp-servers/remote/discover` and `/admin/mcp-servers/remote`
 *   through the remote router: real discovery and transport probe over the recorded
 *   probe bytes, the real install saga over a MockGateway.
 *
 * A producer change fails the equality below and forces the golden to move. To
 * regenerate after an intended change:
 * `UPDATE_WIRE_GOLDENS=1 npx vitest run <this file>`, then review the JSON diff.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// Row ids, owner ids and the install nonce are the only random bytes in these bodies.
const FIXED_UUID = '5b0f3c2e-8d1a-4c6f-9e2b-7a4d1f0c9e31'
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => FIXED_UUID }
})

vi.mock('../src/services/registryClient.js', async importActual => {
  const actual = await importActual<typeof import('../src/services/registryClient.js')>()
  return {
    ...actual,
    getEntryVersion: vi.fn(),
    searchEntries: vi.fn(),
    getCategories: vi.fn(async () => ({ data: [] })),
    reportInstall: vi.fn(async () => ({ acknowledged: true, stored: true })),
  }
})

const NS = config.mcpServersNamespace
const ORIGIN = 'https://control.example.com'
const ENTRA_TENANT_AUTHORITY =
  'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0'
const PUBLIC_IP = async () => ['93.184.216.34']
const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = new URL('./fixtures/wire/', import.meta.url)
// Registry timestamps pass through control-api untouched; pinned so the golden is stable.
const PINNED_TIMESTAMP = '2026-10-28T00:00:00.000Z'

type WireCapture = { status: number; body: unknown }

function golden(name: string, actual: WireCapture): WireCapture {
  const file = new URL(`catalogRemoteOAuth.${name}.json`, WIRE_DIR)
  if (UPDATE) {
    mkdirSync(WIRE_DIR, { recursive: true })
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as WireCapture
}

// ── Registry rows ───────────────────────────────────────────────────────────

type Publisher = Parameters<typeof registryEntryRow>[1]
const CURATOR: Publisher = { kind: 'curator-machine' }
const ACME: Publisher = { kind: 'org-machine', org: 'acme' }

function row(
  name: string,
  url: string,
  oauth: Record<string, unknown> | undefined,
  publisher: Publisher,
  version = '1.0.0'
): Record<string, unknown> {
  const body: PushRemoteMcpEntryBody = {
    name,
    version,
    mcpServer: {
      serverMode: 'remote',
      transport: 'streamableHttp',
      remoteEndpoints: [{ url }],
      ...(oauth ? { oauth } : {}),
    },
  }
  return {
    ...registryEntryRow(body, publisher),
    created_at: PINNED_TIMESTAMP,
    updated_at: PINNED_TIMESTAMP,
  }
}

const WORKIQ_GUIDE = [
  '1. Open the Microsoft Entra admin center and register a new application.',
  '2. Under **Authentication**, add a Web platform with the redirect URI below.',
  '3. Create a client secret and paste the client ID and secret here.',
  '',
  'Use a separate app registration for each slot.',
].join('\n')

// Every unsafe construct the setup-guide renderer must neutralize, in one guide the
// registry accepts (it only bounds the length) and control-api serves as is.
const HOSTILE_GUIDE = [
  '## Register the app',
  '',
  '[Safe console](https://console.example.com/apps)',
  '',
  '<script>window.setupGuidePwned = true</script>',
  '',
  '<img src="https://tracker.example.com/raw.png" alt="raw image">',
  '',
  '![Markdown image](https://tracker.example.com/md.png)',
  '',
  '[Script link](javascript:alert(1))',
  '',
  '[Plain http link](http://insecure.example.com/)',
  '',
  '[Protocol-relative link](//evil.example.com/path)',
  '',
  '[Relative link](/connectors)',
  '',
  '[Mail link](mailto:ops@example.com)',
  '',
  '[Data link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '',
  'Autolinked www.autolink.example.com address',
  '',
  '<a href="javascript:alert(2)">Raw script anchor</a>',
  '',
  '<a href="http://raw-http.example.com/">Raw http anchor</a>',
  '',
  '<iframe src="https://evil.example.com/frame"></iframe>',
  '',
  '<div onclick="alert(3)">Inline handler text</div>',
].join('\n')

const ENTRIES = {
  // Curator, both slots, CIMD on Linear.
  curatorCimd: () =>
    row(
      '@evenfire/linear-remote',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user', 'context'],
        scopes: ['read'],
        expectedRegistration: 'cimd',
        verification: { status: 'verified', checkedAt: '2026-09-25' },
      },
      CURATOR
    ),
  // Curator, one slot, CIMD on Linear.
  curatorCimdUserOnly: () =>
    row(
      '@evenfire/linear-user',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user'],
        expectedRegistration: 'cimd',
        verification: { status: 'untested' },
      },
      CURATOR
    ),
  // Curator, pre-registered on Entra (Work IQ), with its guide and console.
  curatorWorkiq: () =>
    row(
      '@evenfire/workiq-remote',
      ENTRA_WORKIQ_PILOT.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user'],
        scopes: [WORKIQ_GUID_SCOPE],
        authorizationServerHint: 'entra-v2',
        expectedRegistration: 'pre-registered',
        providerConsoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps',
        setupGuide: WORKIQ_GUIDE,
        verification: { status: 'known-issue', note: 'Consent needs a tenant admin.' },
      },
      CURATOR
    ),
  // Curator entry whose guide carries every unsafe construct.
  curatorHostileGuide: () =>
    row(
      '@evenfire/hostile-guide',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user'],
        expectedRegistration: 'pre-registered',
        providerConsoleUrl: 'https://console.example.com/apps',
        setupGuide: HOSTILE_GUIDE,
      },
      CURATOR
    ),
  // Curator expects DCR on an AS that only takes a pre-registered client: drift.
  curatorDcrOnManualAs: () =>
    row(
      '@evenfire/linear-dcr',
      PILOTS.linear.mcpUrl,
      { source: 'remote', allowedGrantScopes: ['user'], expectedRegistration: 'dcr' },
      CURATOR
    ),
  // Curator DCR entry that also ships a guide, on an AS that turned pre-registered only.
  curatorDcrWithGuideOnManualAs: () =>
    row(
      '@evenfire/linear-dcr-guided',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user'],
        expectedRegistration: 'dcr',
        providerConsoleUrl: 'https://linear.app/settings/api/applications',
        setupGuide: '1. Create an OAuth application in Linear.\n2. Add the redirect URI below.',
      },
      CURATOR
    ),
  // Curator entry whose URL serves no MCP at that path (Vercel `/mcp`).
  curatorDeadUrl: () =>
    row(
      '@evenfire/vercel-remote',
      VERCEL_PILOT.mcpUrl,
      { source: 'remote', allowedGrantScopes: ['user'], expectedRegistration: 'dcr' },
      CURATOR
    ),
  // Curator `pre-registered` without guide or console: control-api marks it invalid.
  curatorInvalid: () =>
    row(
      '@evenfire/broken-remote',
      PILOTS.linear.mcpUrl,
      { source: 'remote', allowedGrantScopes: ['user'], expectedRegistration: 'pre-registered' },
      CURATOR
    ),
  // Org entry that claims a verified badge and ships a guide: both are stripped.
  orgDcr: () =>
    row(
      '@acme/notion-remote',
      PILOTS.notion.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user'],
        expectedRegistration: 'dcr',
        verification: { status: 'verified', checkedAt: '2026-09-25' },
        setupGuide: 'Visit [our site](https://acme.example.com) to register.',
        providerConsoleUrl: 'https://acme.example.com/console',
      },
      ACME
    ),
  // Org `pre-registered` on both slots: valid without a guide, which is never trusted.
  orgPreRegistered: () =>
    row(
      '@acme/linear-pre',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user', 'context'],
        expectedRegistration: 'pre-registered',
      },
      ACME
    ),
  // A remote server entry with no OAuth block at all: not a remote-OAuth entry.
  plainRemote: () => row('@evenfire/plain-remote', PILOTS.linear.mcpUrl, undefined, CURATOR),
} satisfies Record<string, () => Record<string, unknown>>

type EntryKey = keyof typeof ENTRIES

function serve(key: EntryKey): Record<string, unknown> {
  const entry = ENTRIES[key]()
  vi.mocked(getEntryVersion).mockResolvedValue(entry as unknown as RegistryEntry)
  return entry
}

// ── Pilots the catalog-mode discovery runs against ──────────────────────────

/** Documented subtraction on the recorded AS bytes: drop the named metadata fields. */
function withoutAsFields(pilot: PilotFixture, fields: string[]): PilotFixture {
  const as = JSON.parse(pilot.as.json) as Record<string, unknown>
  for (const field of fields) delete as[field]
  return { ...pilot, name: `${pilot.name}-minus`, as: { ...pilot.as, json: JSON.stringify(as) } }
}

// Linear without registration and RFC 9207: only a pre-registered client, per-server.
const PRE_REGISTERED_PER_SERVER_PILOT = withoutAsFields(PILOTS.linear, [
  'registration_endpoint',
  'authorization_response_iss_parameter_supported',
])

// ── Routers ─────────────────────────────────────────────────────────────────

function remoteApp(pilot: PilotFixture, gateway: MockGateway) {
  const transport: PinnedTransport = makeDiscoveryTransport(pilot)
  const deps: AdminRemoteMcpDeps = {
    db: makeInMemoryDynamicClientsDb().db,
    discover: (url, discoveryDeps, opts) =>
      discoverRemoteOAuth(url, { ...discoveryDeps, transport, resolveDns: PUBLIC_IP }, opts),
    probe: (baseUrl, probeDeps, opts) =>
      probeMcpTransport(baseUrl, { ...probeDeps, transport, resolveDns: PUBLIC_IP }, opts),
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminRemoteMcpRouter(gateway as unknown as K8sGateway, deps))
  return app
}

function registryApp() {
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(new MockGateway(NS) as unknown as K8sGateway))
  return app
}

async function readEntry(key: EntryKey): Promise<WireCapture> {
  const entry = serve(key)
  const res = await request(registryApp()).get(
    `/admin/registry/entries/${encodeURIComponent(entry.name as string)}/versions/1.0.0`
  )
  return { status: res.status, body: res.body }
}

async function discover(
  key: EntryKey,
  pilot: PilotFixture,
  extra: Record<string, unknown> = {}
): Promise<WireCapture> {
  const entry = serve(key)
  const res = await request(remoteApp(pilot, new MockGateway(NS)))
    .post('/admin/mcp-servers/remote/discover')
    .send({ catalogEntry: { name: entry.name, version: '1.0.0' }, grantScope: 'user', ...extra })
  return { status: res.status, body: res.body }
}

async function install(
  key: EntryKey,
  pilot: PilotFixture,
  body: Record<string, unknown>,
  gateway = new MockGateway(NS)
): Promise<WireCapture> {
  const entry = serve(key)
  const res = await request(remoteApp(pilot, gateway))
    .post('/admin/mcp-servers/remote')
    .send({ catalogEntry: { name: entry.name, version: '1.0.0' }, grantScope: 'user', ...body })
  return { status: res.status, body: res.body }
}

let savedCallbackBaseUrl: string
beforeAll(() => {
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = ORIGIN
})
afterAll(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
})
beforeEach(() => {
  vi.mocked(getEntryVersion).mockReset()
})

describe('catalog remote-OAuth wire goldens — entry reads', () => {
  const CASES: EntryKey[] = [
    'curatorCimd',
    'curatorCimdUserOnly',
    'curatorWorkiq',
    'curatorHostileGuide',
    'curatorDcrOnManualAs',
    'curatorDcrWithGuideOnManualAs',
    'curatorDeadUrl',
    'curatorInvalid',
    'orgDcr',
    'orgPreRegistered',
    'plainRemote',
  ]
  for (const key of CASES) {
    it(`entry.${key} equals the router's response`, async () => {
      const actual = await readEntry(key)
      expect(actual.status).toBe(200)
      expect(actual).toEqual(golden(`entry.${key}`, actual))
    })
  }

  it('the curator and org entries resolve as the goldens are named', async () => {
    const curator = (await readEntry('curatorWorkiq')).body as Record<string, unknown>
    expect(curator.remoteOAuth).toEqual({ valid: true })
    expect(curator.publisher).toBeUndefined()
    const org = (await readEntry('orgDcr')).body as {
      publisher: string
      mcp_server_meta: { oauth: Record<string, unknown> }
    }
    expect(org.publisher).toBe('@acme')
    expect(org.mcp_server_meta.oauth.verification).toBeUndefined()
    expect(org.mcp_server_meta.oauth.setupGuide).toBeUndefined()
    const invalid = (await readEntry('curatorInvalid')).body as Record<string, unknown>
    expect(invalid.remoteOAuth).toEqual({ valid: false, reason: 'setup_guide_required' })
    expect((await readEntry('plainRemote')).body).not.toHaveProperty('remoteOAuth')
  })
})

describe('catalog remote-OAuth wire goldens — POST /discover (catalog mode)', () => {
  it('discover.catalogCimd: curator CIMD entry → 200 with the slot name, no drift', async () => {
    const actual = await discover('curatorCimd', PILOTS.linear)
    expect(actual.status).toBe(200)
    expect(actual.body).toMatchObject({
      serverName: deriveCatalogRemoteServerName('@evenfire/linear-remote', 'user'),
    })
    expect(actual.body).not.toHaveProperty('catalogDrift')
    expect(actual).toEqual(golden('discover.catalogCimd', actual))
  })

  it('discover.catalogDriftDcrToManual: DCR expected, only a pre-registered client → drift', async () => {
    const actual = await discover('curatorDcrOnManualAs', PRE_REGISTERED_PER_SERVER_PILOT)
    expect(actual.status).toBe(200)
    expect(actual.body).toMatchObject({ catalogDrift: { expected: 'dcr', detected: 'manual' } })
    expect(actual).toEqual(golden('discover.catalogDriftDcrToManual', actual))
  })

  it('discover.catalogDriftWithGuide: a guided DCR entry drifting to manual keeps its guide', async () => {
    const actual = await discover('curatorDcrWithGuideOnManualAs', PRE_REGISTERED_PER_SERVER_PILOT)
    expect(actual.status).toBe(200)
    expect(actual.body).toMatchObject({ catalogDrift: { expected: 'dcr', detected: 'manual' } })
    expect(actual).toEqual(golden('discover.catalogDriftWithGuide', actual))
  })

  it('discover.catalogOrgPreRegistered: org pre-registered entry on a per-server callback', async () => {
    const actual = await discover('orgPreRegistered', PRE_REGISTERED_PER_SERVER_PILOT)
    expect(actual.status).toBe(200)
    expect(actual.body).not.toHaveProperty('catalogDrift')
    expect(actual).toEqual(golden('discover.catalogOrgPreRegistered', actual))
  })

  it('discover.catalogDeadUrl: the entry URL serves no MCP → 200 with a dead probe', async () => {
    const actual = await discover('curatorDeadUrl', VERCEL_PILOT)
    expect(actual.status).toBe(200)
    expect(actual.body).toMatchObject({ transport: { status: 'dead' } })
    expect(actual).toEqual(golden('discover.catalogDeadUrl', actual))
  })

  it('discover.catalogWorkiqTenantRequired: Entra entry without a tenant → 400', async () => {
    const actual = await discover('curatorWorkiq', ENTRA_WORKIQ_PILOT)
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('discover.catalogWorkiqTenantRequired', actual))
  })

  it('discover.catalogWorkiq: Entra entry with the tenant authority → 200', async () => {
    const actual = await discover('curatorWorkiq', ENTRA_WORKIQ_PILOT, {
      authorizationServer: ENTRA_TENANT_AUTHORITY,
    })
    expect(actual.status).toBe(200)
    expect(actual).toEqual(golden('discover.catalogWorkiq', actual))
  })

  it('discover.catalogInvalid: an invalid entry → 400 catalog_entry_invalid', async () => {
    const actual = await discover('curatorInvalid', PILOTS.linear)
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('discover.catalogInvalid', actual))
  })
})

describe('catalog remote-OAuth wire goldens — POST / (catalog-mode install)', () => {
  it('install.catalogCimd: curator CIMD entry → 201', async () => {
    const actual = await install('curatorCimd', PILOTS.linear, { mode: 'cimd' })
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.catalogCimd', actual))
  })

  it('install.catalogPreRegistered: org pre-registered, per-server → 201 with its redirect URI', async () => {
    const actual = await install('orgPreRegistered', PRE_REGISTERED_PER_SERVER_PILOT, {
      mode: 'pre-registered',
      clientId: 'acme-user-app',
      clientSecret: 'acme-user-secret',
    })
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.catalogPreRegistered', actual))
  })

  it('install.catalogServerNameInUse: the slot is already installed → 409', async () => {
    const gateway = new MockGateway(NS)
    expect((await install('curatorCimd', PILOTS.linear, { mode: 'cimd' }, gateway)).status).toBe(
      201
    )
    const actual = await install('curatorCimd', PILOTS.linear, { mode: 'cimd' }, gateway)
    expect(actual.status).toBe(409)
    expect(actual).toEqual(golden('install.catalogServerNameInUse', actual))
  })

  it('install.catalogClientIdInUse: the context slot reuses the user slot app → 409', async () => {
    const gateway = new MockGateway(NS)
    const body = {
      mode: 'pre-registered',
      clientId: 'acme-shared-app',
      clientSecret: 'acme-shared-secret',
    }
    const first = await install('orgPreRegistered', PRE_REGISTERED_PER_SERVER_PILOT, body, gateway)
    expect(first.status).toBe(201)
    const actual = await install(
      'orgPreRegistered',
      PRE_REGISTERED_PER_SERVER_PILOT,
      { ...body, grantScope: 'context' },
      gateway
    )
    expect(actual.status).toBe(409)
    expect(actual).toEqual(golden('install.catalogClientIdInUse', actual))
  })

  it('install.catalogInstallInProgress: a young client Secret without a CR → 409', async () => {
    const gateway = new MockGateway(NS)
    const secretName = `${deriveCatalogRemoteServerName('@acme/linear-pre', 'user')}-oauth-client`
    // Another install of the slot created its Secret and has not created its CR yet.
    gateway.seedSecret(secretName, NS, {
      creationTimestamp: new Date(Date.now() - 1_000),
      stringData: { client_id: 'in-flight', client_secret: 'in-flight-secret' },
    })
    const actual = await install(
      'orgPreRegistered',
      PRE_REGISTERED_PER_SERVER_PILOT,
      { mode: 'pre-registered', clientId: 'acme-user-app', clientSecret: 'acme-user-secret' },
      gateway
    )
    expect(actual.status).toBe(409)
    expect(actual).toEqual(golden('install.catalogInstallInProgress', actual))
  })

  it('install.catalogTransportUnreachable: the entry URL serves no MCP → 400 before any write', async () => {
    const gateway = new MockGateway(NS)
    const actual = await install('curatorDeadUrl', VERCEL_PILOT, { mode: 'dcr' }, gateway)
    expect(actual.status).toBe(400)
    expect(actual.body).toMatchObject({ error: 'transport_unreachable' })
    expect(await gateway.listResource('mcpservers', NS)).toEqual([])
    expect(actual).toEqual(golden('install.catalogTransportUnreachable', actual))
  })

  it('install.catalogSlotResidue: an old client Secret without a CR → 409 naming it', async () => {
    const gateway = new MockGateway(NS)
    const secretName = `${deriveCatalogRemoteServerName('@acme/linear-pre', 'user')}-oauth-client`
    gateway.seedSecret(secretName, NS, {
      creationTimestamp: new Date(Date.now() - PENDING_TTL_MS - 60_000),
      stringData: { client_id: 'orphan', client_secret: 'orphan-secret' },
    })
    const actual = await install(
      'orgPreRegistered',
      PRE_REGISTERED_PER_SERVER_PILOT,
      { mode: 'pre-registered', clientId: 'acme-user-app', clientSecret: 'acme-user-secret' },
      gateway
    )
    expect(actual.status).toBe(409)
    expect(actual).toEqual(golden('install.catalogSlotResidue', actual))
  })
})

// ── GET /admin/registry/catalog: install slots ─────────────────────────────

async function readCatalog(
  gateway: MockGateway,
  rows: Array<Record<string, unknown>>
): Promise<WireCapture> {
  // Row ids are random bytes pinned to FIXED_UUID above; a listing needs them distinct,
  // as the registry's are, so each row gets its own pinned id.
  const listed = rows.map((listedRow, index) => ({
    ...listedRow,
    id: `${FIXED_UUID.slice(0, -4)}${String(index).padStart(4, '0')}`,
  }))
  vi.mocked(searchEntries).mockResolvedValue({
    data: listed,
    meta: { total: listed.length, limit: 200, offset: 0 },
  } as never)
  const app = express()
  app.use(express.json())
  app.use(createAdminRegistryRouter(gateway as unknown as K8sGateway))
  const res = await request(app).get('/admin/registry/catalog?limit=200')
  return { status: res.status, body: res.body }
}

/** A CR exactly as the remote install saga writes it, catalog-stamped when `catalog` is set. */
async function seedRemoteOAuthCr(
  gateway: MockGateway,
  input: Omit<Parameters<typeof remoteOAuthMcpServer>[0], 'namespace'>
) {
  await gateway.createResource(
    'mcpservers',
    await remoteOAuthMcpServer({ ...input, namespace: NS }),
    NS
  )
}

describe('catalog remote-OAuth wire goldens — GET /admin/registry/catalog', () => {
  beforeEach(() => {
    vi.mocked(searchEntries).mockReset()
    vi.mocked(getCategories).mockResolvedValue({ data: [] } as never)
  })

  it('catalog.slots: instance, non-canonical, terminating, foreign and a manual install', async () => {
    const gateway = new MockGateway(NS)
    // `@evenfire/linear-remote`, user slot: the catalog instance under its canonical name.
    await seedRemoteOAuthCr(gateway, {
      serverName: deriveCatalogRemoteServerName('@evenfire/linear-remote', 'user'),
      grantScope: 'user',
      catalog: { id: '@evenfire/linear-remote', version: '1.0.0' },
    })
    // `@evenfire/linear-user`, user slot: carries the catalog id under a hand-picked name.
    await seedRemoteOAuthCr(gateway, {
      serverName: 'hand-named-linear',
      grantScope: 'user',
      catalog: { id: '@evenfire/linear-user', version: '1.0.0' },
    })
    // `@acme/linear-pre`, user slot: being deleted.
    const terminating = deriveCatalogRemoteServerName('@acme/linear-pre', 'user')
    await seedRemoteOAuthCr(gateway, {
      serverName: terminating,
      grantScope: 'user',
      catalog: { id: '@acme/linear-pre', version: '1.0.0' },
    })
    gateway.markDeleting('mcpservers', terminating, NS)
    // `@acme/linear-pre`, context slot: its canonical name taken by a manual install.
    await seedRemoteOAuthCr(gateway, {
      serverName: deriveCatalogRemoteServerName('@acme/linear-pre', 'context'),
      grantScope: 'context',
    })
    // A manual per-user install of the URL `@acme/notion-remote` serves.
    await seedRemoteOAuthCr(gateway, { serverName: 'manual-notion', grantScope: 'user' })

    const actual = await readCatalog(gateway, [
      ENTRIES.curatorCimd(),
      ENTRIES.curatorCimdUserOnly(),
      ENTRIES.curatorDcrOnManualAs(),
      ENTRIES.curatorWorkiq(),
      ENTRIES.curatorInvalid(),
      ENTRIES.orgDcr(),
      ENTRIES.orgPreRegistered(),
      ENTRIES.plainRemote(),
    ])
    expect(actual.status).toBe(200)
    const installed = (actual.body as { installed: Record<string, unknown> }).installed
    expect(installed.catalogKeys).toEqual([])
    expect(installed.remoteOAuthSlots).toMatchObject({
      '@evenfire/linear-remote': {
        user: { kind: 'instance', canonical: true, terminating: false },
      },
      '@evenfire/linear-user': { user: { kind: 'instance', canonical: false } },
      '@acme/linear-pre': {
        user: { kind: 'instance', terminating: true },
        context: { kind: 'foreign' },
      },
    })
    expect(installed.manualRemoteOAuth).toContainEqual({
      serverName: 'manual-notion',
      baseUrl: PILOTS.notion.mcpUrl,
      grantScope: 'user',
    })
    expect(actual).toEqual(golden('catalog.slots', actual))
  })

  it('catalog.bumpedVersion: an instance of v1.0.0 while the catalog serves v1.0.1', async () => {
    const gateway = new MockGateway(NS)
    await seedRemoteOAuthCr(gateway, {
      serverName: deriveCatalogRemoteServerName('@evenfire/linear-remote', 'user'),
      grantScope: 'user',
      catalog: { id: '@evenfire/linear-remote', version: '1.0.0' },
    })
    const bumped = row(
      '@evenfire/linear-remote',
      PILOTS.linear.mcpUrl,
      {
        source: 'remote',
        allowedGrantScopes: ['user', 'context'],
        scopes: ['read'],
        expectedRegistration: 'cimd',
        verification: { status: 'verified', checkedAt: '2026-10-20' },
      },
      CURATOR,
      '1.0.1'
    )
    const actual = await readCatalog(gateway, [bumped])
    expect(actual.status).toBe(200)
    const body = actual.body as {
      data: Array<{ version: string }>
      installed: { catalogKeys: string[]; remoteOAuthSlots: Record<string, unknown> }
    }
    expect(body.data.map(entry => entry.version)).toEqual(['1.0.1'])
    expect(body.installed.catalogKeys).toEqual([])
    expect(body.installed.remoteOAuthSlots).toMatchObject({
      '@evenfire/linear-remote': { user: { kind: 'instance', version: '1.0.0' } },
    })
    expect(actual).toEqual(golden('catalog.bumpedVersion', actual))
  })
})

// ── normalizeRemoteBaseUrl: the comparison form the UI's manual-instance notice mirrors ──

describe('catalog remote-OAuth wire goldens — base URL normalization', () => {
  // The cases of normalizeRemoteBaseUrl's own unit test, plus the manual-install URLs
  // an operator types. control-ui replicates the function and checks it against this file.
  const INPUTS = [
    'https://MCP.Example.com/mcp/',
    'HTTPS://mcp.example.com:443/mcp',
    'https://mcp.example.com:8443/mcp//',
    'https://mcp.example.com/',
    'https://mcp.example.com',
    'https://mcp.example.com/Mcp',
    'http://mcp.example.com:80/mcp',
    'http://mcp.example.com:443/mcp',
    'https://mcp.example.com/mcp?x=1',
    'https://mcp.example.com/mcp/?x=1',
    'https://mcp.example.com/mcp#frag',
    'https://mcp.example.com/a%20b/',
    'https://xn--bcher-kva.example/mcp',
    'https://bücher.example/mcp',
    'https://[::1]:443/mcp/',
    'https://user@mcp.example.com/mcp',
    'https://user:pw@mcp.example.com/mcp',
    'https://:pw@mcp.example.com/',
    'not a url',
    PILOTS.notion.mcpUrl,
    PILOTS.linear.mcpUrl,
  ]

  it('normalizeBaseUrl: every case maps as the server compares it', () => {
    const actual: WireCapture = {
      status: 200,
      body: INPUTS.map(input => ({ input, normalized: normalizeRemoteBaseUrl(input) })),
    }
    expect(actual).toEqual(golden('normalizeBaseUrl', actual))
  })
})
