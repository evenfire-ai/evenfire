import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import request from 'supertest'
import { config } from '../src/config.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import { discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import {
  ATLASSIAN_V2_PILOT,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  DROPBOX_PILOT,
  PILOTS,
  type PilotFixture,
  dcrPilot,
  makeDcrTransport,
  makeDiscoveryTransport,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * Golden wire bodies of the remote MCP admin routes (`/admin/mcp-servers/remote`),
 * consumed verbatim by control-ui's wizard tests (control-ui/test/fixtures/
 * remoteMcpWire.ts). control-ui cannot import control-api, so instead of retyping the
 * response shape there, every golden here is the body the real router returns: real
 * discovery and transport probe over the recorded probe bytes, the real install saga
 * over a MockGateway and the in-memory dynamic_clients harness.
 *
 * A producer change fails the equality below and forces the golden to move. To
 * regenerate after an intended change: `UPDATE_WIRE_GOLDENS=1 npx vitest run <this file>`,
 * `npx prettier --write test/fixtures/wire/remoteMcp.*.json`, then review the JSON diff.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// The install nonce is the only non-deterministic byte in these bodies (it ends the
// per-server DCR redirect URI); pinning it keeps the golden byte-stable.
const FIXED_INSTALL_ID = '5b0f3c2e-8d1a-4c6f-9e2b-7a4d1f0c9e31'
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => FIXED_INSTALL_ID }
})

const ORIGIN = 'https://control.example.com'
const PUBLIC_IP = async () => ['93.184.216.34']
const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const WIRE_DIR = new URL('./fixtures/wire/', import.meta.url)

type WireCapture = { status: number; body: unknown }

function golden(name: string, actual: WireCapture): WireCapture {
  const file = new URL(`remoteMcp.${name}.json`, WIRE_DIR)
  if (UPDATE) {
    mkdirSync(WIRE_DIR, { recursive: true })
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as WireCapture
}

/** Documented subtraction on the recorded AS bytes: drop the named metadata fields. */
function withoutAsFields(pilot: PilotFixture, fields: string[]): PilotFixture {
  const as = JSON.parse(pilot.as.json) as Record<string, unknown>
  for (const field of fields) delete as[field]
  return { ...pilot, name: `${pilot.name}-minus`, as: { ...pilot.as, json: JSON.stringify(as) } }
}

function appFor(
  pilot: PilotFixture,
  gateway: MockGateway,
  extra: Omit<AdminRemoteMcpDeps, 'discover' | 'probe'> = {}
) {
  const transport: PinnedTransport = makeDiscoveryTransport(pilot)
  const deps: AdminRemoteMcpDeps = {
    discover: (url, discoveryDeps, opts) =>
      discoverRemoteOAuth(url, { ...discoveryDeps, transport, resolveDns: PUBLIC_IP }, opts),
    probe: (baseUrl, probeDeps, opts) =>
      probeMcpTransport(baseUrl, { ...probeDeps, transport, resolveDns: PUBLIC_IP }, opts),
    ...extra,
  }
  const app = express()
  app.use(express.json())
  app.use(createAdminRemoteMcpRouter(gateway as unknown as K8sGateway, deps))
  return app
}

function gatewayWithContext(): MockGateway {
  const gw = new MockGateway(config.mcpServersNamespace)
  void gw.createResource(
    'contexts',
    { metadata: { name: 'research' }, spec: { contextId: 'research' } },
    config.mcpServersNamespace
  )
  return gw
}

async function discover(pilot: PilotFixture): Promise<WireCapture> {
  const res = await request(appFor(pilot, gatewayWithContext()))
    .post('/admin/mcp-servers/remote/discover')
    .send({ baseUrl: pilot.mcpUrl })
  return { status: res.status, body: res.body }
}

async function install(
  pilot: PilotFixture,
  body: Record<string, unknown>,
  opts: { gateway?: MockGateway; deps?: Omit<AdminRemoteMcpDeps, 'discover' | 'probe'> } = {}
): Promise<WireCapture> {
  const res = await request(appFor(pilot, opts.gateway ?? gatewayWithContext(), opts.deps))
    .post('/admin/mcp-servers/remote')
    .send({ contextRef: 'research', baseUrl: pilot.mcpUrl, ...body })
  return { status: res.status, body: res.body }
}

// CIMD-only AS without RFC 9207 and without DCR: the operator must pre-register a client,
// on a per-server redirect URI. Real Linear bytes minus the two fields.
const PRE_REGISTERED_PER_SERVER_PILOT = withoutAsFields(PILOTS.linear, [
  'registration_endpoint',
  'authorization_response_iss_parameter_supported',
])
// The same AS with RFC 9207 but neither CIMD nor DCR: pre-registered on the shared
// callback. Paired with the case above it is what the wizard sees when the AS starts
// returning `iss` between discover and install.
const PRE_REGISTERED_SHARED_PILOT = withoutAsFields(PILOTS.linear, [
  'registration_endpoint',
  'client_id_metadata_document_supported',
])
// An AS whose issuer is itself a public suffix (a shared-hosting apex, here the PSL
// private entry `github.io`), so it has no registrable domain to anchor the same-site
// rule. Real Notion bytes (no RFC 9207) with the AS moved to that host: the PRM points
// its authorization server there and every AS metadata URL follows; the resource stays.
const ISSUER_ON_PUBLIC_SUFFIX_PILOT = ((): PilotFixture => {
  const moved = (json: string) => json.split('https://mcp.notion.com').join('https://github.io')
  return {
    ...PILOTS.notion,
    name: 'issuer-public-suffix',
    prm: {
      ...PILOTS.notion.prm,
      json: PILOTS.notion.prm.json.replace(
        '"authorization_servers":["https://mcp.notion.com"]',
        '"authorization_servers":["https://github.io"]'
      ),
    },
    as: {
      url: 'https://github.io/.well-known/oauth-authorization-server',
      json: moved(PILOTS.notion.as.json),
    },
  }
})()

const ATLASSIAN_REGISTRATION = JSON.parse(ATLASSIAN_V2_PILOT.as.json)
  .registration_endpoint as string

let savedCallbackBaseUrl: string
beforeAll(() => {
  savedCallbackBaseUrl = config.oauthCallbackBaseUrl
  config.oauthCallbackBaseUrl = ORIGIN
})
afterAll(() => {
  config.oauthCallbackBaseUrl = savedCallbackBaseUrl
})

describe('remote MCP wire goldens — POST /discover', () => {
  const CASES: Array<{ name: string; pilot: () => PilotFixture; status: number }> = [
    { name: 'discover.linear', pilot: () => PILOTS.linear, status: 200 },
    { name: 'discover.notion', pilot: () => PILOTS.notion, status: 200 },
    { name: 'discover.atlassian', pilot: () => ATLASSIAN_V2_PILOT, status: 200 },
    { name: 'discover.dcrConfidential', pilot: () => dcrPilot('confidential'), status: 200 },
    {
      name: 'discover.preRegisteredPerServer',
      pilot: () => PRE_REGISTERED_PER_SERVER_PILOT,
      status: 200,
    },
    { name: 'discover.dropbox', pilot: () => DROPBOX_PILOT, status: 400 },
  ]
  for (const c of CASES) {
    it(`${c.name} equals the router's response`, async () => {
      const actual = await discover(c.pilot())
      expect(actual.status).toBe(c.status)
      expect(actual).toEqual(golden(c.name, actual))
    })
  }

  const UNCONFIGURED_CASES: Array<{ name: string; pilot: () => PilotFixture }> = [
    { name: 'discover.atlassianUnconfigured', pilot: () => ATLASSIAN_V2_PILOT },
    { name: 'discover.linearUnconfigured', pilot: () => PILOTS.linear },
  ]
  for (const c of UNCONFIGURED_CASES) {
    it(`${c.name}: no callback base URL configured`, async () => {
      config.oauthCallbackBaseUrl = ''
      try {
        const actual = await discover(c.pilot())
        expect(actual.status).toBe(200)
        expect(actual).toEqual(golden(c.name, actual))
      } finally {
        config.oauthCallbackBaseUrl = ORIGIN
      }
    })
  }

  it('discover.issuerPublicSuffix: issuer on a public suffix, no RFC 9207 → 400', async () => {
    const actual = await discover(ISSUER_ON_PUBLIC_SUFFIX_PILOT)
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('discover.issuerPublicSuffix', actual))
  })
})

describe('remote MCP wire goldens — POST / (install)', () => {
  it('install.atlassian: per-server DCR 201', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      registrationEndpoint: ATLASSIAN_REGISTRATION,
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
      redirectUris: 'requested',
    })
    const actual = await install(
      ATLASSIAN_V2_PILOT,
      { serverName: 'atlassian', mode: 'dcr' },
      { deps: { db, dcr: { transport, resolveDns: PUBLIC_IP } } }
    )
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.atlassian', actual))
  })

  it('install.linear: shared CIMD 201', async () => {
    const actual = await install(PILOTS.linear, { serverName: 'linear', mode: 'cimd' })
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.linear', actual))
  })

  it('install.preRegisteredPerServer: per-server pre-registered 201', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    const actual = await install(
      PRE_REGISTERED_PER_SERVER_PILOT,
      {
        serverName: 'linear-pre',
        mode: 'pre-registered',
        clientId: 'pre-registered-client',
        clientSecret: 'pre-registered-secret',
      },
      { deps: { db } }
    )
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.preRegisteredPerServer', actual))
  })

  it('install.preRegisteredShared: shared pre-registered 201', async () => {
    const actual = await install(PRE_REGISTERED_SHARED_PILOT, {
      serverName: 'linear-pre',
      mode: 'pre-registered',
      clientId: 'pre-registered-client',
      clientSecret: 'pre-registered-secret',
    })
    expect(actual.status).toBe(201)
    expect(actual).toEqual(golden('install.preRegisteredShared', actual))
  })

  it('install.clientIdInUse: a second per-server server on the same client_id → 409', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    const gateway = gatewayWithContext()
    const body = {
      mode: 'pre-registered',
      clientId: 'shared-client',
      clientSecret: 'pre-registered-secret',
    }
    const first = await install(
      PRE_REGISTERED_PER_SERVER_PILOT,
      { ...body, serverName: 'first' },
      { gateway, deps: { db } }
    )
    expect(first.status).toBe(201)
    const actual = await install(
      PRE_REGISTERED_PER_SERVER_PILOT,
      { ...body, serverName: 'second' },
      { gateway, deps: { db } }
    )
    expect(actual.status).toBe(409)
    expect(actual).toEqual(golden('install.clientIdInUse', actual))
  })

  it('install.dcrRedirectMismatch: the AS registered another redirect URI → 400', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      registrationEndpoint: ATLASSIAN_REGISTRATION,
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
      redirectUris: [`${ORIGIN}/api/v1/oauth-callback/remote`],
    })
    const actual = await install(
      ATLASSIAN_V2_PILOT,
      { serverName: 'atlassian', mode: 'dcr' },
      { deps: { db, dcr: { transport, resolveDns: PUBLIC_IP } } }
    )
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('install.dcrRedirectMismatch', actual))
  })

  it('install.dcrRegistrationRejected: the AS refused the registration (HTTP 400) → 400', async () => {
    const { db } = makeInMemoryDynamicClientsDb()
    // The rejection body Vercel (https://api.vercel.com/login/oauth/register) returns,
    // since it only accepts allow-listed redirect URIs for DCR, replayed against the
    // Atlassian pilot's registration endpoint.
    const { transport } = makeDcrTransport({
      registrationEndpoint: ATLASSIAN_REGISTRATION,
      responseJson: JSON.stringify({
        error: 'invalid_redirect_uri',
        error_description:
          'The provided redirect URIs are not approved for use by this authorization server.',
      }),
      status: 400,
    })
    const actual = await install(
      ATLASSIAN_V2_PILOT,
      { serverName: 'atlassian', mode: 'dcr' },
      { deps: { db, dcr: { transport, resolveDns: PUBLIC_IP } } }
    )
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('install.dcrRegistrationRejected', actual))
  })

  it('install.cimdWithoutIssBinding: CIMD requested on an AS without RFC 9207 → 400', async () => {
    const actual = await install(PILOTS.notion, { serverName: 'notion', mode: 'cimd' })
    expect(actual.status).toBe(400)
    expect(actual).toEqual(golden('install.cimdWithoutIssBinding', actual))
  })

  it('install.callbackUnconfigured: per-server without a callback base URL → 503', async () => {
    config.oauthCallbackBaseUrl = ''
    try {
      const { db } = makeInMemoryDynamicClientsDb()
      const actual = await install(
        ATLASSIAN_V2_PILOT,
        { serverName: 'atlassian', mode: 'dcr' },
        { deps: { db } }
      )
      expect(actual.status).toBe(503)
      expect(actual).toEqual(golden('install.callbackUnconfigured', actual))
    } finally {
      config.oauthCallbackBaseUrl = ORIGIN
    }
  })
})
