import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbClient, DbTransactionClient } from '../src/db.js'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import type { DiscoveryResult } from '../src/oauth/discovery.js'
import { PENDING_TTL_MS, getDynamicClient } from '../src/oauth/dynamicClientStore.js'
import { deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import {
  deriveCatalogRemoteServerName,
  resolveRemoteOAuthEntry,
} from '../src/routes/admin/catalogRemoteOAuth.js'
import { getInstalledRegistryState } from '../src/routes/admin/registry.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import {
  type RegistryEntry,
  RegistryUnavailableError,
  getEntryVersion,
} from '../src/services/registryClient.js'
import { exactRegistryFetch } from './fixtures/exactRegistry.js'
import { WORKIQ_GUID_SCOPE, discoverPilot, withRfc9207 } from './fixtures/perServerInstall.js'
import { malformedRow, registryEntryRow } from './fixtures/registryEntryRow.js'
import {
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  ENTRA_TENANT_AUTHORITY,
  ENTRA_WORKIQ_PILOT,
  PILOTS,
  dcrPilot,
  makeDcrTransport,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * Catalog mode of the remote MCP install (`catalogEntry` + `grantScope` instead of a
 * typed URL and name), through the real router and saga.
 *
 * Doubles only at the boundaries: the registry HTTP client, K8s (`MockGateway`), the
 * AS (`makeDcrTransport`) and the dynamic-client store (in-memory). Registry rows come
 * from `registryEntryRow` (what the registry stores for that publisher), discovery
 * results from the real discovery client over recorded probes, and the races are
 * driven by deferreds in the mocked gateway, never by timers.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

const reportInstallDouble = vi.hoisted(() => ({
  calls: vi.fn(),
  outcome: (): Promise<unknown> => Promise.resolve({ acknowledged: true, stored: true }),
}))

vi.mock('../src/services/registryClient.js', async importActual => {
  const actual = await importActual<typeof import('../src/services/registryClient.js')>()
  return {
    ...actual,
    getEntryVersion: vi.fn(),
    // A plain function, not a vi.fn: a vi.fn attaches its own handlers to the promise
    // it returns, which would hide a rejection the route forgot to handle.
    reportInstall: (...args: unknown[]) => {
      reportInstallDouble.calls(...args)
      return reportInstallDouble.outcome()
    },
  }
})

const NS = config.mcpServersNamespace
const ENC_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
const ROUTE = '/admin/mcp-servers/remote'
const DISCOVER_ROUTE = '/admin/mcp-servers/remote/discover'
const NOTION_URL = PILOTS.notion.mcpUrl // https://mcp.notion.com/mcp
const ENTRY = '@evenfire/notion-remote'
const VERSION = '1.0.0'
const PUBLIC_IP = async () => ['93.184.216.34']

// ── Registry rows ───────────────────────────────────────────────────────────

const CURATOR_GUIDE = {
  setupGuide: '1. Register an app\n2. Paste the redirect URI below',
  providerConsoleUrl: 'https://console.example.com/apps',
}

function remoteOAuthRow(
  opts: {
    name?: string
    version?: string
    url?: string
    allowedGrantScopes?: Array<'user' | 'context'>
    expectedRegistration?: 'cimd' | 'dcr' | 'pre-registered'
    extra?: Record<string, unknown>
  } = {}
) {
  const expectedRegistration = opts.expectedRegistration ?? 'cimd'
  return registryEntryRow(
    {
      name: opts.name ?? ENTRY,
      version: opts.version ?? VERSION,
      mcpServer: {
        serverMode: 'remote',
        transport: 'streamableHttp',
        remoteEndpoints: [{ url: opts.url ?? NOTION_URL }],
        oauth: {
          source: 'remote',
          allowedGrantScopes: opts.allowedGrantScopes ?? ['user', 'context'],
          expectedRegistration,
          ...(expectedRegistration === 'pre-registered' ? CURATOR_GUIDE : {}),
          ...opts.extra,
        },
      },
    },
    { kind: 'curator-machine' }
  )
}

function serveEntry(row: Record<string, unknown>): void {
  vi.mocked(getEntryVersion).mockResolvedValue(row as unknown as RegistryEntry)
}

// ── Discovery results (real producer over recorded probes) ──────────────────

let cimdResult: DiscoveryResult // Notion + RFC 9207 → cimd, shared callback
let dcrResult: DiscoveryResult // DCR-only AS + RFC 9207 → dcr, confidential
let entraResult: DiscoveryResult // Work IQ with the tenant authority → entra-v2

beforeAll(async () => {
  cimdResult = await discoverPilot(withRfc9207(PILOTS.notion))
  expect(cimdResult.registrationMode).toBe('cimd')
  dcrResult = await discoverPilot(withRfc9207(dcrPilot('confidential')))
  expect(dcrResult.registrationMode).toBe('dcr')
  entraResult = await discoverPilot(ENTRA_WORKIQ_PILOT, {
    hasPreRegisteredClient: true,
    authorizationServer: ENTRA_TENANT_AUTHORITY,
  })
  expect(entraResult.asProfile).toBe('entra-v2')
})

// ── Harness ─────────────────────────────────────────────────────────────────

const ALIVE: PinnedTransport = async ({ method }) =>
  method === 'POST'
    ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
    : { status: 404, headers: {}, bodyText: '' }

interface AppSpy {
  discoveredUrls: string[]
  probedUrls: string[]
}

function makeApp(
  gw: MockGateway,
  discovery: DiscoveryResult,
  deps: AdminRemoteMcpDeps & { beforeDiscover?: () => Promise<void> } = {},
  spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
) {
  const { beforeDiscover, ...routerDeps } = deps
  const app = express()
  app.use(express.json())
  app.use(
    createAdminRemoteMcpRouter(gw as unknown as K8sGateway, {
      db: makeInMemoryDynamicClientsDb().db,
      discover: async url => {
        spy.discoveredUrls.push(url)
        await beforeDiscover?.()
        return { ok: true, result: discovery }
      },
      probe: (url, probeDeps, opts) => {
        spy.probedUrls.push(url)
        return probeMcpTransport(
          url,
          { ...probeDeps, transport: ALIVE, resolveDns: PUBLIC_IP },
          opts
        )
      },
      ...routerDeps,
    })
  )
  // The production handler, so a thrown error reaches the client with the status and
  // body it would get in the real app.
  app.use(clerumErrorHandler)
  return app
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** Start a request now (supertest is lazy) and keep its response for later. */
function start(app: express.Express, body: Record<string, unknown>, route = ROUTE) {
  return request(app)
    .post(route)
    .send(body)
    .then(r => r)
}

/** Hold the first McpServer create until released; the CR does not exist meanwhile. */
function gateFirstServerCreate(gw: MockGateway) {
  const reached = deferred()
  const release = deferred()
  const original = gw.createResource.bind(gw)
  let gated = false
  vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, ns) => {
    if (plural === 'mcpservers' && !gated) {
      gated = true
      reached.resolve()
      await release.promise
    }
    return original(plural, body, ns)
  })
  return { reached: reached.promise, release: () => release.resolve() }
}

function canonical(grantScope: 'user' | 'context', entry = ENTRY): string {
  return deriveCatalogRemoteServerName(entry, grantScope)
}

async function serversWithCatalogId(gw: MockGateway, id = ENTRY) {
  const all = (await gw.listResource('mcpservers', NS)) as Array<{
    metadata: { annotations?: Record<string, string> }
  }>
  return all.filter(cr => cr.metadata.annotations?.['clerum.io/catalog-id'] === id)
}

type StoredCr = {
  metadata: { name: string; uid: string; annotations?: Record<string, string> }
  spec: {
    remote: { baseUrl: string }
    transport: { url: string }
    egressBindings: Array<{ dns: string }>
    oauth: Record<string, unknown>
  }
}

const catalogBody = (extra: Record<string, unknown> = {}) => ({
  catalogEntry: { name: ENTRY, version: VERSION },
  grantScope: 'user',
  mode: 'cimd',
  ...extra,
})

let savedCallbackBaseUrl: string
beforeEach(() => {
  vi.mocked(getEntryVersion).mockReset()
  reportInstallDouble.calls.mockReset()
  reportInstallDouble.outcome = () => Promise.resolve({ acknowledged: true, stored: true })
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = 'https://control.example.com'
})
afterEach(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
  vi.restoreAllMocks()
})

// ── Where the install target comes from ──────────────────────────────────

describe('catalog mode: URL, name and provenance come from the entry', () => {
  it('an equivalent body URL is accepted, but only the entry URL is used and persisted', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(gw, cimdResult, {}, spy))
      .post(ROUTE)
      .send(catalogBody({ baseUrl: 'HTTPS://MCP.Notion.com:443/mcp/' }))

    expect(res.status).toBe(201)
    const name = canonical('user')
    expect(res.body.serverName).toBe(name)
    const cr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    expect(cr.spec.remote.baseUrl).toBe(NOTION_URL)
    expect(cr.spec.transport.url).toBe(`http://${name}.${NS}.svc.cluster.local:3000/mcp`)
    expect(cr.spec.egressBindings[0].dns).toBe('mcp.notion.com')
    expect(cr.spec.oauth.grantScope).toBe('user')
    expect(cr.metadata.annotations).toEqual({
      'clerum.io/catalog-id': ENTRY,
      'clerum.io/catalog-version': VERSION,
    })
    // Discovery, the endpoint URL check and the probe all ran on the literal entry URL.
    expect(spy.discoveredUrls).toEqual([NOTION_URL])
    expect(spy.probedUrls).toEqual([NOTION_URL])
  })

  it('the context slot gets its own canonical name', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(catalogBody({ grantScope: 'context' }))
    expect(res.status).toBe(201)
    expect(res.body.serverName).toBe(canonical('context'))
    expect(canonical('context')).not.toBe(canonical('user'))
  })

  it('a body URL that differs from the entry → 400 catalog_base_url_mismatch, nothing written', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(gw, cimdResult, {}, spy))
      .post(ROUTE)
      .send(catalogBody({ baseUrl: 'https://mcp.evil.example.com/mcp' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_base_url_mismatch')
    expect(spy.discoveredUrls).toEqual([])
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })

  it('a body with serverName → 400 catalog_server_name_not_allowed, before any registry read', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(catalogBody({ serverName: 'my-own-name' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_server_name_not_allowed')
    expect(getEntryVersion).not.toHaveBeenCalled()
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })

  it('registry answers a different entry than requested → 400 catalog_entry_name_mismatch, nothing written', async () => {
    // A registry breaking its exact lookup: asked for another entry, it answers ENTRY.
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(gw, cimdResult, {}, spy))
      .post(ROUTE)
      .send(catalogBody({ catalogEntry: { name: '@evenfire/other-remote', version: VERSION } }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_entry_name_mismatch')
    expect(res.body.entry).toEqual({ name: ENTRY, version: VERSION })
    expect(spy.discoveredUrls).toEqual([])
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
    expect(await gw.listSecrets(NS)).toEqual([])
    expect(reportInstallDouble.calls).not.toHaveBeenCalled()
  })

  it('a name the registry does not store → its 404, nothing written', async () => {
    // The real client over an exact registry that stores only ENTRY@VERSION; the
    // unscoped spelling of ENTRY is just another name to it.
    const realGetEntryVersion = (
      await vi.importActual<typeof import('../src/services/registryClient.js')>(
        '../src/services/registryClient.js'
      )
    ).getEntryVersion
    vi.stubGlobal('fetch', vi.fn(exactRegistryFetch([remoteOAuthRow()])))
    vi.mocked(getEntryVersion).mockImplementation(realGetEntryVersion)
    try {
      const gw = new MockGateway(NS)
      const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
      const res = await request(makeApp(gw, cimdResult, {}, spy))
        .post(ROUTE)
        .send(catalogBody({ catalogEntry: { name: 'notion-remote', version: VERSION } }))
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Registry 404', correlationId: expect.any(String) })
      expect(getEntryVersion).toHaveBeenCalledWith('notion-remote', VERSION)
      expect(spy.discoveredUrls).toEqual([])
      expect(await gw.listResource('mcpservers', NS)).toEqual([])
      expect(await gw.listSecrets(NS)).toEqual([])
      expect(reportInstallDouble.calls).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a manual install still carries no catalog annotations and is never reported', async () => {
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send({ serverName: 'notion-manual', baseUrl: NOTION_URL, mode: 'cimd' })
    expect(res.status).toBe(201)
    const cr = (await gw.getResource('mcpservers', 'notion-manual', NS)) as StoredCr
    expect(cr.metadata.annotations).toBeUndefined()
    expect(getEntryVersion).not.toHaveBeenCalled()
    expect(reportInstallDouble.calls).not.toHaveBeenCalled()
  })
})

// ── What the entry allows ────────────────────────────────────────────────

describe('catalog mode: the entry decides what can be installed', () => {
  it('a grant scope the entry does not allow → 400 catalog_grant_scope_not_allowed', async () => {
    serveEntry(remoteOAuthRow({ allowedGrantScopes: ['user'] }))
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(catalogBody({ grantScope: 'context' }))
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'catalog_grant_scope_not_allowed',
      allowedGrantScopes: ['user'],
    })
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })

  it('an entry that is not remote-OAuth → 400 catalog_entry_not_remote_oauth', async () => {
    serveEntry(
      registryEntryRow(
        {
          name: '@evenfire/static-remote',
          mcpServer: {
            serverMode: 'remote',
            transport: 'streamableHttp',
            remoteEndpoints: [{ url: NOTION_URL }],
          },
        },
        { kind: 'curator-machine' }
      )
    )
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(ROUTE)
      .send(catalogBody({ catalogEntry: { name: '@evenfire/static-remote', version: VERSION } }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_entry_not_remote_oauth')
  })

  it('a non-remote-OAuth entry carrying its own top-level remoteOAuth verdict → 400 not_remote_oauth', async () => {
    const row = registryEntryRow(
      {
        name: ENTRY,
        mcpServer: {
          serverMode: 'remote',
          transport: 'streamableHttp',
          remoteEndpoints: [{ url: NOTION_URL }],
        },
      },
      { kind: 'curator-machine' }
    )
    // The registry passes rows through untouched; a column or key named like our
    // verdict must not be mistaken for it.
    serveEntry({ ...row, remoteOAuth: { valid: true } })
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_entry_not_remote_oauth')
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })

  it('a `source: remote` block on a local server → 400 catalog_entry_not_remote_oauth', async () => {
    serveEntry(
      malformedRow(
        {
          name: ENTRY,
          mcpServer: {
            serverMode: 'local',
            remoteEndpoints: [{ url: NOTION_URL }],
            oauth: { source: 'remote', allowedGrantScopes: ['user'], expectedRegistration: 'cimd' },
          },
        },
        { kind: 'curator-machine' }
      )
    )
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(ROUTE)
      .send(catalogBody())
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_entry_not_remote_oauth')
  })

  const invalidRows = [
    [
      'a curator pre-registered entry without its setup guide',
      () =>
        registryEntryRow(
          {
            name: ENTRY,
            mcpServer: {
              serverMode: 'remote',
              remoteEndpoints: [{ url: NOTION_URL }],
              oauth: {
                source: 'remote',
                allowedGrantScopes: ['user'],
                expectedRegistration: 'pre-registered',
              },
            },
          },
          { kind: 'curator-machine' }
        ),
      'setup_guide_required',
    ],
    [
      'allowedGrantScopes given as a string',
      () =>
        malformedRow(
          {
            name: ENTRY,
            mcpServer: {
              serverMode: 'remote',
              remoteEndpoints: [{ url: NOTION_URL }],
              oauth: { source: 'remote', allowedGrantScopes: 'user', expectedRegistration: 'cimd' },
            },
          },
          { kind: 'curator-machine' }
        ),
      'allowed_grant_scopes_invalid',
    ],
  ] as const

  it.each(invalidRows)(
    'install: %s → 400 catalog_entry_invalid with its reason',
    async (_label, row, reason) => {
      serveEntry(row())
      const gw = new MockGateway(NS)
      const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'catalog_entry_invalid', reason })
      expect(await gw.listResource('mcpservers', NS)).toEqual([])
    }
  )

  it.each(invalidRows)(
    '/discover: %s → 400 catalog_entry_invalid with its reason, no discovery',
    async (_label, row, reason) => {
      serveEntry(row())
      const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
      const res = await request(makeApp(new MockGateway(NS), cimdResult, {}, spy))
        .post(DISCOVER_ROUTE)
        .send({ catalogEntry: { name: ENTRY, version: VERSION }, grantScope: 'user' })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'catalog_entry_invalid', reason })
      expect(spy.discoveredUrls).toEqual([])
    }
  )
})

// ── Registry read failures ──────────────────────────────────────────────────

describe('catalog mode: a failed registry read reaches the admin with its status, nothing written', () => {
  // The real registry client over a stubbed `fetch`: the error each case throws, and the
  // status the production handler gives it, come from the code that runs in the app.
  let realGetEntryVersion: typeof getEntryVersion
  beforeAll(async () => {
    realGetEntryVersion = (
      await vi.importActual<typeof import('../src/services/registryClient.js')>(
        '../src/services/registryClient.js'
      )
    ).getEntryVersion
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ENTRY_PATH = `/entries/${encodeURIComponent(ENTRY)}/versions/${VERSION}`
  const unavailable = {
    error: 'registry_unavailable',
    message: 'The registry is currently unavailable. Check the connection and try again.',
  }
  const timeoutError = () => Object.assign(new Error('aborted'), { name: 'TimeoutError' })

  interface RegistryFailure {
    label: string
    answer: () => Promise<Response>
    status: number
    body: Record<string, unknown>
  }
  const failures: RegistryFailure[] = [
    {
      label: 'the entry does not exist (404)',
      answer: async () => new Response('', { status: 404 }),
      status: 404,
      body: { error: 'Registry 404' },
    },
    {
      label: 'the registry answers 5xx',
      answer: async () => new Response('', { status: 503 }),
      status: 503,
      body: unavailable,
    },
    {
      label: 'the registry is unreachable',
      answer: async () => Promise.reject(new TypeError('fetch failed')),
      status: 503,
      body: unavailable,
    },
    {
      label: 'the registry read times out',
      answer: async () => Promise.reject(timeoutError()),
      status: 503,
      body: unavailable,
    },
    {
      label: 'the registry rejects our machine token (401)',
      answer: async () => new Response('', { status: 401 }),
      status: 502,
      body: { error: 'registry_integration_error', message: 'The registry could not be reached.' },
    },
  ]

  function registryFails(answer: () => Promise<Response>) {
    const fetchSpy = vi.fn(answer)
    vi.stubGlobal('fetch', fetchSpy)
    vi.mocked(getEntryVersion).mockImplementation(realGetEntryVersion)
    return fetchSpy
  }

  function registryUrls(fetchSpy: ReturnType<typeof vi.fn>): string[] {
    return fetchSpy.mock.calls.map(([url]) => String(url))
  }

  it.each(failures)('install: $label → $status', async ({ answer, status, body }) => {
    const fetchSpy = registryFails(answer)
    const gw = new MockGateway(NS)
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(gw, cimdResult, {}, spy))
      .post(ROUTE)
      .send(catalogBody())

    expect(res.status).toBe(status)
    expect(res.body).toEqual({ ...body, correlationId: expect.any(String) })
    expect(registryUrls(fetchSpy).length).toBeGreaterThan(0)
    expect(registryUrls(fetchSpy).every(url => url.endsWith(ENTRY_PATH))).toBe(true)
    expect(spy.discoveredUrls).toEqual([])
    expect(spy.probedUrls).toEqual([])
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
    expect(await gw.listSecrets(NS)).toEqual([])
    expect(reportInstallDouble.calls).not.toHaveBeenCalled()
  })

  it.each(failures)('/discover: $label → $status', async ({ answer, status, body }) => {
    const fetchSpy = registryFails(answer)
    const gw = new MockGateway(NS)
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(gw, cimdResult, {}, spy))
      .post(DISCOVER_ROUTE)
      .send({ catalogEntry: { name: ENTRY, version: VERSION }, grantScope: 'user' })

    expect(res.status).toBe(status)
    expect(res.body).toEqual({ ...body, correlationId: expect.any(String) })
    expect(registryUrls(fetchSpy).length).toBeGreaterThan(0)
    expect(registryUrls(fetchSpy).every(url => url.endsWith(ENTRY_PATH))).toBe(true)
    expect(spy.discoveredUrls).toEqual([])
    expect(spy.probedUrls).toEqual([])
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })
})

// ── Drift between the entry and discovery ────────────────────────────────

describe('catalog mode /discover: drift against expectedRegistration', () => {
  const discoverBody = { catalogEntry: { name: ENTRY, version: VERSION }, grantScope: 'user' }

  it('detected ≠ expected → catalogDrift; discovery ran on the entry URL', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(new MockGateway(NS), cimdResult, {}, spy))
      .post(DISCOVER_ROUTE)
      .send(discoverBody)
    expect(res.status).toBe(200)
    expect(res.body.catalogDrift).toEqual({ expected: 'dcr', detected: 'cimd' })
    expect(res.body.detected.registrationMode).toBe('cimd')
    expect(spy.discoveredUrls).toEqual([NOTION_URL])
  })

  it('detected = expected → no catalogDrift', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'cimd' }))
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(DISCOVER_ROUTE)
      .send(discoverBody)
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('catalogDrift')
  })

  it('returns the canonical server name the install will use, per slot', async () => {
    serveEntry(remoteOAuthRow())
    const app = makeApp(new MockGateway(NS), cimdResult)
    const user = await request(app).post(DISCOVER_ROUTE).send(discoverBody)
    expect(user.status).toBe(200)
    expect(user.body.serverName).toBe(canonical('user'))
    const context = await request(app)
      .post(DISCOVER_ROUTE)
      .send({ ...discoverBody, grantScope: 'context' })
    expect(context.body.serverName).toBe(canonical('context'))
  })

  it('manual /discover carries no serverName', async () => {
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(DISCOVER_ROUTE)
      .send({ baseUrl: NOTION_URL })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('serverName')
    expect(res.body).not.toHaveProperty('catalogDrift')
  })

  it('an AS without CIMD or DCR (`manual`) matches an entry expecting pre-registered', async () => {
    const manualResult = await discoverPilot(ENTRA_WORKIQ_PILOT, {
      authorizationServer: ENTRA_TENANT_AUTHORITY,
    })
    expect(manualResult.registrationMode).toBe('manual')
    serveEntry(
      remoteOAuthRow({ url: ENTRA_WORKIQ_PILOT.mcpUrl, expectedRegistration: 'pre-registered' })
    )
    const res = await request(makeApp(new MockGateway(NS), manualResult))
      .post(DISCOVER_ROUTE)
      .send(discoverBody)
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('catalogDrift')
  })

  it('an expected dcr that discovery resolves to `manual` is reported as drift', async () => {
    const manualResult = await discoverPilot(ENTRA_WORKIQ_PILOT, {
      authorizationServer: ENTRA_TENANT_AUTHORITY,
    })
    serveEntry(remoteOAuthRow({ url: ENTRA_WORKIQ_PILOT.mcpUrl, expectedRegistration: 'dcr' }))
    const res = await request(makeApp(new MockGateway(NS), manualResult))
      .post(DISCOVER_ROUTE)
      .send(discoverBody)
    expect(res.body.catalogDrift).toEqual({ expected: 'dcr', detected: 'manual' })
  })

  it('/discover accepts an equivalent body URL but discovers and probes the entry URL', async () => {
    serveEntry(remoteOAuthRow())
    const spy: AppSpy = { discoveredUrls: [], probedUrls: [] }
    const res = await request(makeApp(new MockGateway(NS), cimdResult, {}, spy))
      .post(DISCOVER_ROUTE)
      .send({ ...discoverBody, baseUrl: 'https://MCP.notion.com:443/mcp/' })
    expect(res.status).toBe(200)
    expect(spy.discoveredUrls).toEqual([NOTION_URL])
    expect(spy.probedUrls).toEqual([NOTION_URL])
  })

  it('/discover with serverName → 400 catalog_server_name_not_allowed', async () => {
    serveEntry(remoteOAuthRow())
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(DISCOVER_ROUTE)
      .send({ ...discoverBody, serverName: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_server_name_not_allowed')
  })

  it('/discover rejects a body URL that differs from the entry', async () => {
    serveEntry(remoteOAuthRow())
    const res = await request(makeApp(new MockGateway(NS), cimdResult))
      .post(DISCOVER_ROUTE)
      .send({ ...discoverBody, baseUrl: 'https://other.example.com/mcp' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('catalog_base_url_mismatch')
  })

  it('the install does not change behaviour under drift', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(201)
    expect(res.body.registrationMode).toBe('cimd')
  })
})

// ── Cost ─────────────────────────────────────────────────────────────────

describe('catalog mode cost: one registry read, one install report, no Context list', () => {
  it('CIMD: exactly one getEntryVersion and one reportInstall, with the entry identity', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const list = vi.spyOn(gw, 'listResource')
    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(201)
    expect(getEntryVersion).toHaveBeenCalledTimes(1)
    expect(getEntryVersion).toHaveBeenCalledWith(ENTRY, VERSION)
    expect(reportInstallDouble.calls).toHaveBeenCalledTimes(1)
    expect(reportInstallDouble.calls).toHaveBeenCalledWith(ENTRY, expect.any(String), VERSION)
    expect(list.mock.calls.filter(([plural]) => plural === 'contexts')).toEqual([])
  })

  it('DCR: the install is reported only after the dynamic client is bound to the CR', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    const { db } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const name = canonical('user')
    let boundAtReport: string | null | undefined
    reportInstallDouble.outcome = async () => {
      boundAtReport = (
        await getDynamicClient(db, ENC_KEY, { serverNamespace: NS, serverName: name })
      )?.crUid
      return { acknowledged: true, stored: true }
    }
    const list = vi.spyOn(gw, 'listResource')
    const res = await request(
      makeApp(gw, dcrResult, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post(ROUTE)
      .send(catalogBody({ mode: 'dcr' }))
    expect(res.status).toBe(201)
    const cr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    expect(boundAtReport).toBe(cr.metadata.uid)
    expect(getEntryVersion).toHaveBeenCalledTimes(1)
    expect(reportInstallDouble.calls).toHaveBeenCalledTimes(1)
    expect(list.mock.calls.filter(([plural]) => plural === 'contexts')).toEqual([])
  })

  it('a failing report never fails the install nor leaves an unhandled rejection', async () => {
    serveEntry(remoteOAuthRow())
    reportInstallDouble.outcome = () => Promise.reject(new Error('registry down'))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const res = await request(makeApp(new MockGateway(NS), cimdResult))
        .post(ROUTE)
        .send(catalogBody())
      expect(res.status).toBe(201)
      expect(reportInstallDouble.calls).toHaveBeenCalledTimes(1)
      // Node reports an unhandled rejection only after the microtask queue drains.
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('a failing report is logged as a warning on the request logger, and the install still answers 201', async () => {
    serveEntry(remoteOAuthRow())
    const failure = new RegistryUnavailableError()
    reportInstallDouble.outcome = () => Promise.reject(failure)
    const warn = vi.fn()
    const noop = () => {}
    const reqLog = { warn, info: noop, error: noop, debug: noop }
    const app = express()
    app.use((req, _res, next) => {
      req.log = reqLog as unknown as NonNullable<typeof req.log>
      next()
    })
    app.use(makeApp(new MockGateway(NS), cimdResult))

    const res = await request(app).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(201)
    expect(res.body.serverName).toBe(canonical('user'))
    await new Promise(resolve => setImmediate(resolve))

    const reported = warn.mock.calls.filter(
      ([obj]) => (obj as { event?: unknown })?.event === 'registry_report_install_failed'
    )
    expect(reported).toHaveLength(1)
    const [fields] = reported[0] as [Record<string, unknown>]
    expect(fields).toEqual({
      event: 'registry_report_install_failed',
      entryName: ENTRY,
      entryVersion: VERSION,
      errName: 'RegistryUnavailableError',
      errMessage: failure.message,
      errStatus: 503,
      errCode: 'registry_unavailable',
    })
  })

  it('a failed install is not reported', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    await gw.createResource('mcpservers', { metadata: { name: canonical('user') }, spec: {} }, NS)
    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(409)
    expect(reportInstallDouble.calls).not.toHaveBeenCalled()
  })
})

// ── Races on one slot ────────────────────────────────────────────────────

describe('two DCR installs of the same slot', () => {
  function dcrApp(gw: MockGateway, db: DbClient, transport: PinnedTransport) {
    return makeApp(gw, dcrResult, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
  }
  const dcrBody = catalogBody({ mode: 'dcr' })

  it('loser while the winner has no CR yet → 409 install_in_progress; the winner is untouched', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    const { db } = makeInMemoryDynamicClientsDb()
    const a = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const b = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const gate = gateFirstServerCreate(gw)
    const name = canonical('user')
    const key = { serverNamespace: NS, serverName: name }

    const pendingA = start(dcrApp(gw, db, a.transport), dcrBody)
    await gate.reached
    const rowA = await getDynamicClient(db, ENC_KEY, key)

    const resB = await request(dcrApp(gw, db, b.transport))
      .post(ROUTE)
      .send(dcrBody)
    expect(resB.status).toBe(409)
    expect(resB.body.error).toBe('install_in_progress')
    // The loser revoked only the client it minted itself.
    expect(b.calls.some(c => c.method === 'DELETE')).toBe(true)
    expect((await getDynamicClient(db, ENC_KEY, key))?.installId).toBe(rowA?.installId)

    gate.release()
    const resA = await pendingA
    expect(resA.status).toBe(201)
    expect(a.calls.some(c => c.method === 'DELETE')).toBe(false)
    const cr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    const bound = await getDynamicClient(db, ENC_KEY, key)
    expect(bound?.installId).toBe(rowA?.installId)
    expect(bound?.crUid).toBe(cr.metadata.uid)
    expect(await serversWithCatalogId(gw)).toHaveLength(1)
  })

  it('loser whose winner created its CR after the pre-check → 409 server_name_in_use', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    const { db } = makeInMemoryDynamicClientsDb()
    const a = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const b = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    // B passes its pre-check, then waits at its registration while A completes.
    const bReached = deferred()
    const bRelease = deferred()
    const bTransport: PinnedTransport = async req => {
      if (req.method === 'POST') {
        bReached.resolve()
        await bRelease.promise
      }
      return b.transport(req)
    }
    const pendingB = start(dcrApp(gw, db, bTransport), dcrBody)
    await bReached.promise

    const resA = await request(dcrApp(gw, db, a.transport))
      .post(ROUTE)
      .send(dcrBody)
    expect(resA.status).toBe(201)
    const name = canonical('user')
    const crA = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    const rowA = await getDynamicClient(db, ENC_KEY, { serverNamespace: NS, serverName: name })

    bRelease.resolve()
    const resB = await pendingB
    expect(resB.status).toBe(409)
    expect(resB.body.error).toBe('server_name_in_use')
    const crAfter = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    expect(crAfter.metadata.uid).toBe(crA.metadata.uid)
    // `ageMs` is wall-clock derived; everything that identifies the row must be unchanged.
    const { ageMs: _ageBefore, ...rowABefore } = rowA ?? {}
    const { ageMs: _ageAfter, ...rowAAfter } =
      (await getDynamicClient(db, ENC_KEY, { serverNamespace: NS, serverName: name })) ?? {}
    expect(rowAAfter).toEqual(rowABefore)
  })
})

describe('two CIMD installs of the same slot', () => {
  it('the loser of the CR create → 409 server_name_in_use; the winner CR is untouched', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const gate = gateFirstServerCreate(gw)
    const pendingA = start(makeApp(gw, cimdResult), catalogBody())
    await gate.reached

    const resB = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(resB.status).toBe(201)
    const name = canonical('user')
    const crB = (await gw.getResource('mcpservers', name, NS)) as StoredCr

    gate.release()
    const resA = await pendingA
    expect(resA.status).toBe(409)
    expect(resA.body).toEqual({ error: 'server_name_in_use' })
    const crAfter = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    expect(crAfter).toEqual(crB)
    expect(reportInstallDouble.calls).toHaveBeenCalledTimes(1)
  })

  it('manual mode keeps the raw apiserver message for the same conflict', async () => {
    const gw = new MockGateway(NS)
    const gate = gateFirstServerCreate(gw)
    const body = { serverName: 'notion-manual', baseUrl: NOTION_URL, mode: 'cimd' }
    const pendingA = start(makeApp(gw, cimdResult), body)
    await gate.reached
    expect((await request(makeApp(gw, cimdResult)).post(ROUTE).send(body)).status).toBe(201)
    gate.release()
    const resA = await pendingA
    expect(resA.status).toBe(409)
    expect(resA.body.error).toMatch(/already exists/)
  })
})

/** A pre-registered catalog install with its own client credentials. */
const preRegisteredBody = (clientId: string) =>
  catalogBody({ mode: 'pre-registered', clientId, clientSecret: `${clientId}-secret` })

function decodedSecret(secret: { data?: Record<string, string> }): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secret.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()])
  )
}

describe('two pre-registered installs of the same slot', () => {
  it('the loser of the Secret create → 409 install_in_progress; the winner Secret is intact', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const gate = gateFirstServerCreate(gw)
    const name = canonical('user')
    const pendingA = start(makeApp(gw, cimdResult), preRegisteredBody('client-a'))
    await gate.reached
    const secretA = (await gw.getSecret(`${name}-oauth-client`, NS)) as {
      metadata: { uid: string }
    }

    const resB = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(resB.status).toBe(409)
    expect(resB.body).toEqual({ error: 'install_in_progress' })
    const secretNow = await gw.getSecret(`${name}-oauth-client`, NS)
    expect(secretNow.metadata?.uid).toBe(secretA.metadata.uid)
    expect(decodedSecret(secretNow).client_id).toBe('client-a')

    gate.release()
    expect((await pendingA).status).toBe(201)
    const cr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    expect(cr.spec.oauth.id).toBe('client-a')
  })

  it('manual mode keeps the generic Secret-creation message', async () => {
    const gw = new MockGateway(NS)
    gw.seedSecret('slack-remote-oauth-client', NS)
    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send({
      serverName: 'slack-remote',
      baseUrl: NOTION_URL,
      mode: 'pre-registered',
      clientId: 'client-x',
      clientSecret: 'secret-x',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Secret creation failed: /)
  })
})

describe('the winner of a slot is in flight without a CR', () => {
  it('held between createSecret and createResource for 9 minutes → still install_in_progress', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const gate = gateFirstServerCreate(gw)
    const name = canonical('user')
    const pendingA = start(makeApp(gw, cimdResult), preRegisteredBody('client-a'))
    await gate.reached
    const secretUid = (await gw.getSecret(`${name}-oauth-client`, NS)).metadata?.uid

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + PENDING_TTL_MS - 60_000)
    const resB = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(resB.status).toBe(409)
    expect(resB.body).toEqual({ error: 'install_in_progress' })
    expect((await gw.getSecret(`${name}-oauth-client`, NS)).metadata?.uid).toBe(secretUid)
    vi.mocked(Date.now).mockRestore()

    gate.release()
    expect((await pendingA).status).toBe(201)
  })

  it('held inside its rollback (CR deleted, Secret alive) → install_in_progress, never residue', async () => {
    const workIqRow = remoteOAuthRow({
      url: ENTRA_WORKIQ_PILOT.mcpUrl,
      allowedGrantScopes: ['user'],
      expectedRegistration: 'pre-registered',
      extra: { authorizationServerHint: 'entra-v2' },
    })
    serveEntry(workIqRow)
    // An apiserver whose CRD predates asProfile prunes it, so the winner rolls back.
    const gw = new MockGateway(NS)
    const createResource = gw.createResource.bind(gw)
    vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, ns) => {
      if (plural !== 'mcpservers') return createResource(plural, body, ns)
      const pruned = structuredClone(body) as typeof body & {
        spec?: { oauth?: Record<string, unknown> }
      }
      delete pruned.spec?.oauth?.asProfile
      return createResource(plural, pruned, ns)
    })
    const inRollback = deferred()
    const finishRollback = deferred()
    const deleteSecret = gw.deleteSecret.bind(gw)
    vi.spyOn(gw, 'deleteSecret').mockImplementation(async (...args) => {
      inRollback.resolve()
      await finishRollback.promise
      return deleteSecret(...args)
    })
    const name = canonical('user')
    const entraBody = (clientId: string) => ({
      ...preRegisteredBody(clientId),
      authorizationServer: ENTRA_TENANT_AUTHORITY,
      scopes: [WORKIQ_GUID_SCOPE],
    })

    const pendingA = start(
      makeApp(gw, entraResult),
      entraBody('11111111-aaaa-4aaa-8aaa-111111111111')
    )
    await inRollback.promise
    await expect(gw.getResource('mcpservers', name, NS)).rejects.toThrow()
    const secretUid = (await gw.getSecret(`${name}-oauth-client`, NS)).metadata?.uid

    const resB = await request(makeApp(gw, entraResult))
      .post(ROUTE)
      .send(entraBody('22222222-bbbb-4bbb-8bbb-222222222222'))
    expect(resB.status).toBe(409)
    expect(resB.body).toEqual({ error: 'install_in_progress' })
    expect((await gw.getSecret(`${name}-oauth-client`, NS)).metadata?.uid).toBe(secretUid)

    finishRollback.resolve()
    const resA = await pendingA
    expect(resA.status).toBe(409)
    expect(resA.body.error).toBe('mcpserver_crd_outdated')
  })
})

describe('a leftover client Secret blocks the slot', () => {
  const oldTimestamp = () => new Date(Date.now() - PENDING_TTL_MS - 60_000)

  it('an old Secret without a CR → 409 catalog_slot_residue naming it; the Secret is intact', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const secretName = `${canonical('user')}-oauth-client`
    gw.seedSecret(secretName, NS, {
      creationTimestamp: oldTimestamp(),
      stringData: { client_id: 'orphan', client_secret: 'orphan-secret' },
    })
    const before = await gw.getSecret(secretName, NS)

    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'catalog_slot_residue', secretName })
    expect(await gw.getSecret(secretName, NS)).toEqual(before)
    expect(await gw.listResource('mcpservers', NS)).toEqual([])
  })

  it('the CR deleted outside control-api leaves a Secret that later blocks the slot', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const name = canonical('user')
    const first = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-a'))
    expect(first.status).toBe(201)
    await gw.deleteResource('mcpservers', name, NS) // kubectl delete: no uninstall teardown
    const before = await gw.getSecret(`${name}-oauth-client`, NS)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PENDING_TTL_MS + 60_000)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: 'catalog_slot_residue',
      secretName: `${name}-oauth-client`,
    })
    expect(await gw.getSecret(`${name}-oauth-client`, NS)).toEqual(before)
  })

  it('an old Secret whose CR is live (created after the pre-check) → install_in_progress', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const bAtDiscovery = deferred()
    const bResume = deferred()
    const pendingB = start(
      makeApp(gw, cimdResult, {
        beforeDiscover: async () => {
          bAtDiscovery.resolve()
          await bResume.promise
        },
      }),
      preRegisteredBody('client-b')
    )
    await bAtDiscovery.promise // B already passed its name pre-check
    const resA = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-a'))
    expect(resA.status).toBe(201)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PENDING_TTL_MS + 60_000)
    bResume.resolve()
    const resB = await pendingB
    expect(resB.status).toBe(409)
    expect(resB.body).toEqual({ error: 'install_in_progress' })
  })

  it('the Secret vanished between the conflict and the read → install_in_progress', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const conflict = Object.assign(new Error('secrets "x" already exists'), {
      statusCode: 409,
      code: 409,
    })
    vi.spyOn(gw, 'createSecret').mockRejectedValueOnce(conflict)
    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'install_in_progress' })
  })

  /** Serves the seeded Secret as its JSON copy, where `creationTimestamp` is a string. */
  async function serveSecretAsJson(
    gw: MockGateway,
    secretName: string,
    mutate?: (s: { metadata: { creationTimestamp?: unknown } }) => void
  ) {
    const json = JSON.parse(JSON.stringify(await gw.getSecret(secretName, NS)))
    mutate?.(json)
    vi.spyOn(gw, 'getSecret').mockResolvedValue(json)
  }

  it('an old Secret read as JSON (string creationTimestamp) → 409 catalog_slot_residue', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const secretName = `${canonical('user')}-oauth-client`
    gw.seedSecret(secretName, NS, {
      creationTimestamp: oldTimestamp(),
      stringData: { client_id: 'orphan', client_secret: 'orphan-secret' },
    })
    await serveSecretAsJson(gw, secretName)

    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'catalog_slot_residue', secretName })
  })

  it('an unparseable creationTimestamp → install_in_progress, never residue', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'pre-registered' }))
    const gw = new MockGateway(NS)
    const secretName = `${canonical('user')}-oauth-client`
    gw.seedSecret(secretName, NS, {
      creationTimestamp: oldTimestamp(),
      stringData: { client_id: 'orphan', client_secret: 'orphan-secret' },
    })
    await serveSecretAsJson(gw, secretName, s => {
      s.metadata.creationTimestamp = 'not-a-timestamp'
    })

    const res = await request(makeApp(gw, cimdResult))
      .post(ROUTE)
      .send(preRegisteredBody('client-b'))
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'install_in_progress' })
  })
})

describe('installing from a stale catalog snapshot', () => {
  it('a slot shown free that was installed meanwhile → 409 server_name_in_use, never a duplicate', async () => {
    const row = remoteOAuthRow()
    serveEntry(row)
    const gw = new MockGateway(NS)
    const snapshot = await getInstalledRegistryState(gw as unknown as K8sGateway, [
      resolveRemoteOAuthEntry(row) as never,
    ])
    expect(snapshot.remoteOAuthSlots[ENTRY]?.user).toBeUndefined()

    expect((await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())).status).toBe(
      201
    )
    // The card still renders the old snapshot and offers Install again.
    const stale = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('server_name_in_use')
    expect(await serversWithCatalogId(gw)).toHaveLength(1)
  })

  it('a slot being uninstalled (terminating CR) → 409 server_name_in_use', async () => {
    const row = remoteOAuthRow()
    serveEntry(row)
    const gw = new MockGateway(NS)
    expect((await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())).status).toBe(
      201
    )
    gw.markDeleting('mcpservers', canonical('user'), NS)
    const state = await getInstalledRegistryState(gw as unknown as K8sGateway, [
      resolveRemoteOAuthEntry(row) as never,
    ])
    expect(state.remoteOAuthSlots[ENTRY]?.user).toMatchObject({ terminating: true })

    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('server_name_in_use')
    expect(await serversWithCatalogId(gw)).toHaveLength(1)
  })
})

// ── Leftovers of out-of-band writers and earlier installs ────────────────

describe('the canonical name left in an allowlist by an out-of-band writer', () => {
  it('the install creates the CR and leaves the allowlist exactly as it was', async () => {
    serveEntry(remoteOAuthRow())
    const gw = new MockGateway(NS)
    const name = canonical('user')
    await gw.createResource(
      'contexts',
      { metadata: { name: 'ctx-a' }, spec: { contextId: 'ctx-a', mcpServers: [name, 'other'] } },
      config.contextsNamespace
    )
    const before = await gw.getResource('contexts', 'ctx-a', config.contextsNamespace)

    const res = await request(makeApp(gw, cimdResult)).post(ROUTE).send(catalogBody())
    expect(res.status).toBe(201)
    await expect(gw.getResource('mcpservers', name, NS)).resolves.toBeTruthy()
    expect(await gw.getResource('contexts', 'ctx-a', config.contextsNamespace)).toEqual(before)
  })
})

describe('a dynamic client of an earlier installation of the slot', () => {
  it('after an out-of-band CR delete, the reinstall takes the row over under its own identity', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    const { db } = makeInMemoryDynamicClientsDb()
    const name = canonical('user')
    const key = { serverNamespace: NS, serverName: name }
    const install = (response: object) => {
      const { transport } = makeDcrTransport({ responseJson: JSON.stringify(response) })
      return request(
        makeApp(gw, dcrResult, {
          db,
          dcr: { transport, resolveDns: PUBLIC_IP },
          // The reclaim runs its compare-and-swap in a transaction on the same store.
          runInTransaction: work => work(db as unknown as DbTransactionClient),
        })
      )
        .post(ROUTE)
        .send(catalogBody({ mode: 'dcr' }))
    }

    expect((await install(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE)).status).toBe(201)
    const oldCr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    const oldRow = await getDynamicClient(db, ENC_KEY, key)
    expect(oldRow?.crUid).toBe(oldCr.metadata.uid)
    await gw.deleteResource('mcpservers', name, NS) // deleted outside control-api: the row stays bound to a dead uid

    // The AS assigns the reinstall a client of its own.
    const second = {
      ...DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
      client_id: 'dyn-conf-second',
      registration_client_uri: 'https://mcp.notion.com/register/dyn-conf-second',
    }
    expect((await install(second)).status).toBe(201)
    const newCr = (await gw.getResource('mcpservers', name, NS)) as StoredCr
    const newRow = await getDynamicClient(db, ENC_KEY, key)
    expect(newCr.metadata.uid).not.toBe(oldCr.metadata.uid)
    expect(newRow?.crUid).toBe(newCr.metadata.uid)
    expect(newRow?.installId).not.toBe(oldRow?.installId)
    expect(newRow?.clientId).toBe('dyn-conf-second')
    expect(newCr.spec.oauth.id).toBe('dyn-conf-second')
  })
})

// ── Rollback fencing ─────────────────────────────────────────────────────

describe('rollback of the created CR is fenced by uid only', () => {
  /** Stands in for HCC writing the CR status right after the create: the RV moves on. */
  function bumpResourceVersionOnCreate(gw: MockGateway) {
    gw.setResourceCreateFault(async ({ plural, name, namespace }) => {
      if (plural !== 'mcpservers') return
      await gw.mutateResource(plural, name, current => ({ spec: current.spec }), namespace)
    })
  }

  function pruneAsProfile(gw: MockGateway) {
    const createResource = gw.createResource.bind(gw)
    vi.spyOn(gw, 'createResource').mockImplementation(async (plural, body, ns) => {
      if (plural !== 'mcpservers') return createResource(plural, body, ns)
      const pruned = structuredClone(body) as typeof body & {
        spec?: { oauth?: Record<string, unknown> }
      }
      delete pruned.spec?.oauth?.asProfile
      return createResource(plural, pruned, ns)
    })
  }

  const workIqBody = {
    serverName: 'workiq',
    baseUrl: ENTRA_WORKIQ_PILOT.mcpUrl,
    mode: 'pre-registered',
    clientId: '11111111-2222-3333-4444-555555555555',
    clientSecret: 'entra-client-secret',
    authorizationServer: ENTRA_TENANT_AUTHORITY,
    scopes: [WORKIQ_GUID_SCOPE],
  }

  function withRequestLog(app: express.Express, reqLog: unknown): express.Express {
    const outer = express()
    outer.use((req, _res, next) => {
      ;(req as { log?: unknown }).log = reqLog
      next()
    })
    outer.use(app)
    return outer
  }

  it('a pruned field: a status write between create and rollback still lets the rollback delete the CR', async () => {
    const gw = new MockGateway(NS)
    pruneAsProfile(gw)
    bumpResourceVersionOnCreate(gw)
    const reqLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const res = await request(withRequestLog(makeApp(gw, entraResult), reqLog))
      .post(ROUTE)
      .send(workIqBody)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('mcpserver_crd_outdated')
    await expect(gw.getResource('mcpservers', 'workiq', NS)).rejects.toThrow()
    expect(reqLog.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'remote_install_crd_outdated_rollback_failed' }),
      expect.any(String)
    )
  })

  it('a pruned field: a homonym recreated with another uid before the rollback is left alone', async () => {
    const gw = new MockGateway(NS)
    pruneAsProfile(gw)
    let homonymUid: string | undefined
    gw.setResourceCreateFault(async ({ plural, name, namespace }) => {
      if (plural !== 'mcpservers' || homonymUid) return
      gw.setResourceCreateFault(null)
      await gw.deleteResource(plural, name, namespace)
      const homonym = (await gw.createResource(
        plural,
        { metadata: { name }, spec: { image: 'other' } },
        namespace
      )) as { metadata: { uid: string } }
      homonymUid = homonym.metadata.uid
    })
    const res = await request(makeApp(gw, entraResult)).post(ROUTE).send(workIqBody)
    expect(res.status).toBe(409)
    const survivor = (await gw.getResource('mcpservers', 'workiq', NS)) as StoredCr
    expect(survivor.metadata.uid).toBe(homonymUid)
  })

  it('a failed bind: a status write before it still lets the rollback delete the CR', async () => {
    serveEntry(remoteOAuthRow({ expectedRegistration: 'dcr' }))
    const gw = new MockGateway(NS)
    bumpResourceVersionOnCreate(gw)
    const store = makeInMemoryDynamicClientsDb()
    const db: DbClient = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('UPDATE dynamic_clients') && text.includes('cr_uid = $5')) {
          throw new Error('bind boom')
        }
        return store.db.query(text, values)
      },
    } as DbClient
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeApp(gw, dcrResult, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post(ROUTE)
      .send(catalogBody({ mode: 'dcr' }))
    expect(res.status).toBe(500)
    await expect(gw.getResource('mcpservers', canonical('user'), NS)).rejects.toThrow()
    expect(store.rows.size).toBe(0)
    expect(reportInstallDouble.calls).not.toHaveBeenCalled()
  })
})
