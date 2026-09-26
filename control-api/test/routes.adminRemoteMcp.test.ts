import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { config } from '../src/config.js'
import type { DbTransactionClient } from '../src/db.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type DiscoveryOutcome,
  type DiscoveryResult,
  discoverRemoteOAuth,
} from '../src/oauth/discovery.js'
import {
  bindDynamicClientToResource,
  getDynamicClient,
  insertDynamicClientPending,
} from '../src/oauth/dynamicClientStore.js'
import { decryptOAuthSecret, deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import { K8sNotFoundError } from '../src/services/resourceService.js'
import {
  DCR_BASIC_REGISTRATION_RESPONSE,
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_JSON,
  DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_RESPONSE,
  DCR_VERCEL_DOWNGRADE_REGISTRATION_JSON,
  DCR_VERCEL_DOWNGRADE_REGISTRATION_RESPONSE,
  NOTION_PRM_JSON,
  PILOTS,
  VERCEL_PILOT,
  dcrPilot,
  makeDcrTransport,
  makeDiscoveryTransport,
  makeInMemoryDynamicClientsDb,
} from './fixtures/remoteOAuthDiscovery.js'
import { MockGateway } from './mockGateway.js'

/**
 * C1.5 "C-install" admin routes (spec 02, DEC-12). The saga is tested against a
 * MOCKED K8sGateway — the `remote`×`oauth` CR shape is not admissible until C3 lands
 * the CRD (batch model, §8), so live admission is out of scope here.
 *
 * Discovery is module-mocked, but the DiscoveryResult it returns is DERIVED FROM THE
 * REAL PRODUCER (T1): the actual `discoverRemoteOAuth` is run once against the real
 * 2026-09-20 probe fixtures to produce it — never hand-authored.
 */

// The kernel resolves the admin-typed baseUrl via node:dns; keep it public + offline.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

vi.mock('../src/oauth/discovery.js', async importActual => {
  const actual = await importActual<typeof import('../src/oauth/discovery.js')>()
  return { ...actual, discoverRemoteOAuth: vi.fn() }
})

const NS = config.mcpServersNamespace // 'mcp-server'

// F1 collateral: the router now probes the MCP transport in BOTH discover and install.
// Every app injects a `probe` derived from the REAL producer (`probeMcpTransport` bound
// to a fixture transport) — never a hand-stubbed outcome — so no test escapes to the
// network. `GENERIC_ALIVE_TRANSPORT` mirrors the real pilots: a tokenless POST
// `initialize` answers 401 with a Bearer challenge (transport alive, token required).
const PROBE_DNS = async () => ['93.184.216.34']
const GENERIC_ALIVE_TRANSPORT: PinnedTransport = async ({ method }) =>
  method === 'POST'
    ? { status: 401, headers: { 'www-authenticate': 'Bearer realm="OAuth"' }, bodyText: '' }
    : { status: 404, headers: {}, bodyText: '' }

/** Bind the real `probeMcpTransport` to a fixture transport + offline DNS (T1). */
function boundProbe(transport: PinnedTransport): typeof probeMcpTransport {
  return (baseUrl, deps, opts) =>
    probeMcpTransport(baseUrl, { ...deps, transport, resolveDns: PROBE_DNS }, opts)
}
const genericProbe = boundProbe(GENERIC_ALIVE_TRANSPORT)
/** Vercel: POST `/mcp` → 404 (dead), POST `/` → 200, root PRM → suggested `/`. */
const vercelProbe = boundProbe(makeDiscoveryTransport(VERCEL_PILOT))
/** A 5xx POST → inconclusive/unexpected_status (must NOT block install). */
const inconclusiveProbe = boundProbe(async () => ({ status: 503, headers: {}, bodyText: '' }))

// Real Vercel DiscoveryResult, derived from the real producer (T1): the actual
// discovery client run against the 2026-09-25 Vercel probe fixtures.
let vercelResult: DiscoveryResult

function makeApp(gateway: MockGateway, probe: typeof probeMcpTransport = genericProbe) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRemoteMcpRouter(gateway as unknown as K8sGateway, { probe }))
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
    }
  )
  return app
}

/** Seed a Context in the gateway's default namespace (where the route reads it). */
function gatewayWithContext(contextName = 'ctx-a'): MockGateway {
  const gw = new MockGateway(NS)
  void gw.createResource(
    'contexts',
    { metadata: { name: contextName }, spec: { contextId: contextName } },
    NS
  )
  return gw
}

// Real DiscoveryResult, derived from the real Notion probe fixtures (T1). Notion's
// real AS metadata does NOT advertise RFC 9207 (see oauth.discovery.test.ts), so this
// carries NO `issForCallback` — the fixture the install must now REJECT (R3F-H1).
let notionResult: DiscoveryResult
// A DiscoveryResult that DOES advertise RFC 9207, derived from the real producer (T1)
// by documented substitution (like `bodyBearerResult`): the real Notion pilot with
// `authorization_response_iss_parameter_supported:true` added to the AS metadata, then
// run through the real discovery client so `issForCallback` is producer-derived, not
// hand-authored. Every remote install SUCCESS path needs an RFC-9207 AS now that the
// install guard is fail-closed; all other endpoints stay Notion's, so success-path
// assertions are unchanged except for the added `issForCallback`.
let rfc9207Result: DiscoveryResult
// A DiscoveryResult whose resource requires the token in the BODY, derived from the
// real producer (T1) by documented substitution of the Notion PRM's
// `bearer_methods_supported` to `["body"]` — the only field changed.
let bodyBearerResult: DiscoveryResult

/**
 * Documented T1 substitution: add `authorization_response_iss_parameter_supported`
 * to a pilot's AS metadata (parsed-object level, key-order agnostic) so the real
 * discovery producer derives `issForCallback`. Never hand-authors the DiscoveryResult.
 */
function withRfc9207<T extends { as: { json: string } }>(pilot: T): T {
  const as = JSON.parse(pilot.as.json)
  as.authorization_response_iss_parameter_supported = true
  return { ...pilot, as: { ...pilot.as, json: JSON.stringify(as) } }
}

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../src/oauth/discovery.js')>(
    '../src/oauth/discovery.js'
  )
  const outcome = await actual.discoverRemoteOAuth(PILOTS.notion.mcpUrl, {
    transport: makeDiscoveryTransport(PILOTS.notion),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!outcome.ok) throw new Error(`fixture discovery failed: ${outcome.error.kind}`)
  notionResult = outcome.result

  const rfc9207Outcome = await actual.discoverRemoteOAuth(PILOTS.notion.mcpUrl, {
    transport: makeDiscoveryTransport(withRfc9207(PILOTS.notion)),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!rfc9207Outcome.ok)
    throw new Error(`rfc9207 fixture discovery failed: ${rfc9207Outcome.error.kind}`)
  rfc9207Result = rfc9207Outcome.result

  const vercelOutcome = await actual.discoverRemoteOAuth(VERCEL_PILOT.mcpUrl, {
    transport: makeDiscoveryTransport(VERCEL_PILOT),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!vercelOutcome.ok)
    throw new Error(`vercel fixture discovery failed: ${vercelOutcome.error.kind}`)
  vercelResult = vercelOutcome.result

  // Documented substitution (like the DCR fixtures): the real Notion pilot with the
  // PRM's `bearer_methods_supported` set to body-only. The real producer then derives
  // `quirks.bearerInBody === true` — no hand-authored DiscoveryResult (T1).
  const bodyBearerPilot = {
    ...PILOTS.notion,
    prm: {
      ...PILOTS.notion.prm,
      json: NOTION_PRM_JSON.replace(
        '"bearer_methods_supported":["header"]',
        '"bearer_methods_supported":["body"]'
      ),
    },
  }
  const bodyBearerOutcome = await actual.discoverRemoteOAuth(bodyBearerPilot.mcpUrl, {
    transport: makeDiscoveryTransport(bodyBearerPilot),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!bodyBearerOutcome.ok)
    throw new Error(`body-bearer fixture discovery failed: ${bodyBearerOutcome.error.kind}`)
  bodyBearerResult = bodyBearerOutcome.result
})

beforeEach(() => {
  vi.mocked(discoverRemoteOAuth).mockReset()
})

function mockDiscovery(result: DiscoveryResult): void {
  vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result } as DiscoveryOutcome)
}

describe('POST /admin/mcp-servers/remote/discover (dry-run)', () => {
  it('kernel-rejects a non-https baseUrl → 400, no discovery', async () => {
    const gw = gatewayWithContext()
    const res = await request(makeApp(gw))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'http://mcp.notion.com/mcp' })
    expect(res.status).toBe(400)
    expect(discoverRemoteOAuth).not.toHaveBeenCalled()
  })

  it('returns the "Detected" prefill for a CIMD server → 200', async () => {
    mockDiscovery(notionResult)
    const res = await request(makeApp(gatewayWithContext()))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.notion.com/mcp' })
    expect(res.status).toBe(200)
    expect(res.body.detected.registrationMode).toBe('cimd')
    expect(res.body.detected.endpoints.token).toBe('https://mcp.notion.com/token')
    expect(res.body.detected.resource).toBe('https://mcp.notion.com')
    expect(res.body.detected.quirks).toEqual({ bearerInBody: false, supportsRefresh: true })
    // No DCR marker for a CIMD server.
    expect(res.body.detected.dcr).toBeUndefined()
  })

  it('marks DCR mode available (C2) with resolved clientMode + supportsRefresh → 200', async () => {
    mockDiscovery({ ...notionResult, registrationMode: 'dcr' })
    const res = await request(makeApp(gatewayWithContext()))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.example.com/mcp' })
    expect(res.status).toBe(200)
    expect(res.body.detected.registrationMode).toBe('dcr')
    // Notion's AS lists `none` in its auth methods → public DCR client.
    expect(res.body.detected.dcr).toEqual({
      available: true,
      clientMode: 'public',
      supportsRefresh: true,
    })
  })

  it('maps a discovery failure → 400', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({
      ok: false,
      error: { kind: 'no_s256', detail: 'no S256' },
    } as DiscoveryOutcome)
    const res = await request(makeApp(gatewayWithContext()))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.example.com/mcp' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('discovery_failed')
  })

  // Repro (issue 26-09-25): OAuth discovery resolves on Vercel's `/mcp` path, but the
  // MCP transport there is dead (404). Detect must surface a `dead` verdict + the
  // canonical-root suggestion WITHOUT changing the OAuth `detected` block.
  it('Vercel /mcp: discovery ok but the transport probe reports dead + suggests the root → 200', async () => {
    mockDiscovery(vercelResult)
    const res = await request(makeApp(gatewayWithContext(), vercelProbe))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.vercel.com/mcp' })
    expect(res.status).toBe(200)
    // OAuth `detected` is unchanged: the path-suffixed PRM resource is what fooled Detect.
    expect(res.body.detected.resource).toBe('https://mcp.vercel.com/mcp')
    // The new sibling: transport probe verdict.
    expect(res.body.transport).toEqual({
      status: 'dead',
      probedUrl: 'https://mcp.vercel.com/mcp',
      httpStatus: 404,
      suggestedBaseUrl: 'https://mcp.vercel.com/',
    })
  })

  it('Notion /mcp: transport probe reports alive with a challenge → 200', async () => {
    mockDiscovery(notionResult)
    const res = await request(makeApp(gatewayWithContext()))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.notion.com/mcp' })
    expect(res.status).toBe(200)
    expect(res.body.transport.status).toBe('alive')
    expect(res.body.transport.challenge).toBe(true)
  })
})

describe('POST /admin/mcp-servers/remote (install saga)', () => {
  // CIMD now backfills `oauth.id` from the platform self-URL (DEC-23), which needs
  // a configured public callback base URL — same precondition DCR already has.
  let savedCallbackBaseUrl = ''
  beforeEach(() => {
    savedCallbackBaseUrl = config.oauthCallbackBaseUrl
    config.oauthCallbackBaseUrl = 'https://control.example.com'
  })
  afterEach(() => {
    config.oauthCallbackBaseUrl = savedCallbackBaseUrl
  })

  const CIMD_SELF_CLIENT_ID = 'https://control.example.com/api/v1/.well-known/evenfire-mcp-client'

  it('CIMD (public): creates the CR with the pinned spec.oauth shape + attaches to Context', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'notion-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'cimd',
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      serverName: 'notion-remote',
      namespace: NS,
      clientMode: 'public',
      registrationMode: 'cimd',
    })
    // No secret material echoed.
    expect(res.body.clientSecret).toBeUndefined()

    const cr = (await gw.getResource('mcpservers', 'notion-remote', NS)) as {
      spec: Record<string, unknown>
    }
    expect(cr.spec.auth).toEqual({ type: 'oauth' })
    expect(cr.spec.remote).toEqual({ baseUrl: 'https://mcp.notion.com/mcp' })
    expect(cr.spec.oauth).toEqual({
      source: 'remote',
      // DEC-23: CIMD-public backfills the platform self-URL client_id.
      id: CIMD_SELF_CLIENT_ID,
      clientMode: 'public',
      authorizationEndpoint: 'https://mcp.notion.com/authorize',
      tokenEndpoint: 'https://mcp.notion.com/token',
      registrationEndpoint: 'https://mcp.notion.com/register',
      issuer: 'https://mcp.notion.com',
      // RFC 9207 advertised (rfc9207Result) ⇒ pinned for the shared remote callback.
      issForCallback: 'https://mcp.notion.com',
      resource: 'https://mcp.notion.com',
      grantScope: 'user',
      scopes: ['default'],
      bearerInBody: false,
      supportsRefresh: true,
    })

    // Context now allowlists the server.
    const ctx = (await gw.getResource('contexts', 'ctx-a', NS)) as {
      spec: { mcpServers?: string[] }
    }
    expect(ctx.spec.mcpServers).toContain('notion-remote')
  })

  // R3F-H1 (regression of R3-H2): the shared remote callback fails closed without a
  // pinned issuer, so an install against an AS that does NOT advertise RFC 9207 would
  // create a server that can never complete OAuth (user hits 400 at consent). The
  // install must reject up front. `notionResult` is the REAL Notion discovery (no
  // `authorization_response_iss_parameter_supported`), derived from the real producer —
  // NOT hand-authored. Fails at parent a835d7130 (install proceeds, 201 + CR).
  it('rejects a remote install against an AS without RFC 9207 → 422, no CR, no Secret', async () => {
    // Self-check the T1 fixture: real Notion genuinely lacks the issuer pin.
    expect(notionResult.issForCallback).toBeUndefined()
    mockDiscovery(notionResult)
    const gw = gatewayWithContext('ctx-a')
    const createResourceSpy = vi.spyOn(gw, 'createResource')
    const createSecretSpy = vi.spyOn(gw, 'createSecret')

    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'no-rfc9207-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'client-abc',
      clientSecret: 'shhh-secret',
    })

    // Observable outcome (T4): rejected before any write.
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('issuer_binding_required')
    expect(createResourceSpy).not.toHaveBeenCalled()
    expect(createSecretSpy).not.toHaveBeenCalled()
    await expect(gw.getResource('mcpservers', 'no-rfc9207-remote', NS)).rejects.toThrow()
    const ctx = (await gw.getResource('contexts', 'ctx-a', NS)) as {
      spec: { mcpServers?: string[] }
    }
    expect(ctx.spec.mcpServers ?? []).not.toContain('no-rfc9207-remote')
  })

  it('body-bearer resource: rejects at admission and creates no CR (the runtime cannot honor bearerInBody)', async () => {
    // Self-check the T1 fixture: the real producer must have derived the body-bearer
    // quirk, or this test would pass vacuously against any server.
    expect(bodyBearerResult.quirks.bearerInBody).toBe(true)
    mockDiscovery(bodyBearerResult)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'notion-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'cimd',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bearer_in_body_unsupported')

    // No CR persisted, and the Context is not mutated: the install failed closed.
    await expect(gw.getResource('mcpservers', 'notion-remote', NS)).rejects.toBeDefined()
    const ctx = (await gw.getResource('contexts', 'ctx-a', NS)) as {
      spec: { mcpServers?: string[] }
    }
    expect(ctx.spec.mcpServers ?? []).not.toContain('notion-remote')
  })

  it('pre-registered confidential: creates the client Secret + references it in spec.oauth', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'slack-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'client-abc',
      clientSecret: 'shhh-secret',
    })
    expect(res.status).toBe(201)
    expect(res.body.clientMode).toBe('confidential')

    // getSecret returns the base64 `data` map (K8s materializes write-only
    // stringData into data on apply), so decode before comparing plaintext.
    const secret = (await gw.getSecret('slack-remote-oauth-client', NS)) as {
      data?: Record<string, string>
    }
    const decoded = Object.fromEntries(
      Object.entries(secret.data ?? {}).map(([k, v]) => [
        k,
        Buffer.from(v, 'base64').toString('utf8'),
      ])
    )
    expect(decoded).toEqual({ client_id: 'client-abc', client_secret: 'shhh-secret' })

    const cr = (await gw.getResource('mcpservers', 'slack-remote', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.clientMode).toBe('confidential')
    // DEC-23: pre-registered backfills `oauth.id` from the operator's plaintext client_id.
    expect(cr.spec.oauth.id).toBe('client-abc')
    expect(cr.spec.oauth.clientIdRef).toEqual({
      name: 'slack-remote-oauth-client',
      key: 'client_id',
    })
    expect(cr.spec.oauth.clientSecretRef).toEqual({
      name: 'slack-remote-oauth-client',
      key: 'client_secret',
    })
  })

  it('rejects mode "dcr" when server-side discovery resolves a non-DCR AS → 400 mode_unsupported', async () => {
    // The AS actually offers CIMD (not DCR); the operator's "dcr" request loses.
    mockDiscovery(notionResult)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'stripe-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'dcr',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('mode_unsupported')
    // No CR written.
    await expect(gw.getResource('mcpservers', 'stripe-remote', NS)).rejects.toThrow()
  })

  it('pre-registered without clientSecret → 400', async () => {
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'x-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'only-id',
    })
    expect(res.status).toBe(400)
  })

  it('CIMD requested but AS is DCR-only → 400 mode_unsupported (server-side discovery is authoritative)', async () => {
    mockDiscovery({ ...notionResult, registrationMode: 'dcr' })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'y-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.example.com/mcp',
      mode: 'cimd',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('mode_unsupported')
  })

  it('rolls back the Secret when the CR create fails', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const k8sErr = Object.assign(new Error('already exists'), { code: 409 })
    vi.spyOn(gw, 'createResource').mockRejectedValueOnce(k8sErr)
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'roll-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'cid',
      clientSecret: 'csecret',
    })
    expect(res.status).toBe(409)
    // The client Secret created before the CR must be rolled back.
    await expect(gw.getSecret('roll-remote-oauth-client', NS)).rejects.toThrow()
  })

  it('rolls back the CR AND Secret when the Context attach fails', async () => {
    mockDiscovery(rfc9207Result)
    // Context does NOT exist → getResource('contexts', …) throws K8sNotFoundError.
    const gw = new MockGateway(NS)
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'attach-remote',
      contextRef: 'missing-ctx',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'cid',
      clientSecret: 'csecret',
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    // Both the CR and the Secret are rolled back.
    await expect(gw.getResource('mcpservers', 'attach-remote', NS)).rejects.toThrow()
    await expect(gw.getSecret('attach-remote-oauth-client', NS)).rejects.toThrow()
  })

  it('fenced Secret rollback: a homonym recreated with a NEW uid survives the CR-create rollback (P1)', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const secretName = 'race-remote-oauth-client'

    // Force step-2 (CR create) to fail, but first simulate a concurrent
    // uninstall+reinstall of the same serverName: delete the just-created client
    // Secret and recreate a homonym carrying a DIFFERENT uid. `createSecret` is
    // the real producer (T1) — the mock's allocateUid is monotonic, so the
    // recreated Secret's uid necessarily differs from the one the saga captured.
    let recreatedUid: string | undefined
    vi.spyOn(gw, 'createResource').mockImplementationOnce(async () => {
      await gw.deleteSecret(secretName, NS)
      const recreated = await gw.createSecret({
        name: secretName,
        namespace: NS,
        type: 'Opaque',
        stringData: { client_id: 'other-tenant', client_secret: 'other-secret' },
      })
      recreatedUid = recreated.uid
      throw Object.assign(new Error('already exists'), { code: 409 })
    })

    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'race-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'cid',
      clientSecret: 'csecret',
    })

    expect(res.status).toBe(409)
    // The homonym belongs to the concurrent install: the fenced rollback's uid
    // precondition rejects the delete (409, swallowed best-effort), so the other
    // tenant's credentials survive intact. A by-name rollback would raze them.
    const survivor = await gw.getSecret(secretName, NS)
    expect(survivor.metadata.uid).toBe(recreatedUid)
  })

  it('fenced CR rollback: a homonym recreated with a NEW uid survives the Context-attach rollback (P1)', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const serverName = 'race2-remote'

    // Let the CR create succeed, then fail the Context attach (updateResource).
    // Between the two, simulate a concurrent uninstall+reinstall that replaces
    // the McpServer CR with a homonym carrying a NEW uid (createResource is the
    // real producer, T1). A by-name rollback would delete the wrong object.
    let recreatedCrUid: string | undefined
    vi.spyOn(gw, 'updateResource').mockImplementationOnce(async () => {
      await gw.deleteResource('mcpservers', serverName, NS)
      const recreated = (await gw.createResource(
        'mcpservers',
        { metadata: { name: serverName }, spec: { image: 'other' } },
        NS
      )) as { metadata: { uid: string } }
      recreatedCrUid = recreated.metadata.uid
      throw Object.assign(new Error('conflict'), { code: 409 })
    })

    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName,
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'pre-registered',
      clientId: 'cid',
      clientSecret: 'csecret',
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    // The recreated CR (a different uid) must survive: the fenced deleteResource
    // precondition rejects the compensating delete instead of razing it.
    const survivor = (await gw.getResource('mcpservers', serverName, NS)) as {
      metadata: { uid: string }
    }
    expect(survivor.metadata.uid).toBe(recreatedCrUid)
  })

  it('forces the namespace server-side (caller-supplied namespace is ignored)', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'ns-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'cimd',
      namespace: 'attacker-ns',
    })
    expect(res.status).toBe(201)
    expect(res.body.namespace).toBe(NS)
    // Created in the config namespace, nothing in the attacker-supplied one.
    await expect(gw.getResource('mcpservers', 'ns-remote', NS)).resolves.toBeTruthy()
    await expect(gw.getResource('mcpservers', 'ns-remote', 'attacker-ns')).rejects.toThrow()
  })

  it('rejects a metadata.namespace that disagrees with the server namespace → 400', async () => {
    mockDiscovery(notionResult)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw))
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'md-remote',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'cimd',
        metadata: { namespace: 'evil' },
      })
    expect(res.status).toBe(400)
  })

  // Repro (issue 26-09-25, T3+T4): a Vercel `/mcp` install passes OAuth discovery (mode
  // dcr) but the transport there is dead (404). The hard gate must return 400
  // `transport_unreachable` BEFORE minting any AS client or writing K8s — observable:
  // no DCR POST, no CR, Context allowlist untouched.
  it('Vercel /mcp install (dcr): transport probe dead → 400 transport_unreachable, nothing minted or written', async () => {
    mockDiscovery(vercelResult)
    const { db } = makeInMemoryDynamicClientsDb()
    const { transport: dcrTransport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const app = express()
    app.use(express.json())
    app.use(
      createAdminRemoteMcpRouter(gw as unknown as K8sGateway, {
        db,
        dcr: { transport: dcrTransport, resolveDns: PROBE_DNS },
        probe: vercelProbe,
      })
    )
    const res = await request(app).post('/admin/mcp-servers/remote').send({
      serverName: 'vercel-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.vercel.com/mcp',
      mode: 'dcr',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('transport_unreachable')
    expect(res.body.detail).toMatchObject({
      probedUrl: 'https://mcp.vercel.com/mcp',
      httpStatus: 404,
      suggestedBaseUrl: 'https://mcp.vercel.com/',
    })
    // No AS client minted (the DCR POST never fired).
    expect(calls).toHaveLength(0)
    // No CR written.
    await expect(gw.getResource('mcpservers', 'vercel-remote', NS)).rejects.toThrow()
    // Context allowlist untouched.
    const ctx = (await gw.getResource('contexts', 'ctx-a', NS)) as {
      spec: { mcpServers?: string[] }
    }
    expect(ctx.spec.mcpServers ?? []).not.toContain('vercel-remote')
  })

  // An inconclusive probe (5xx) must NOT block: the install proceeds to 201.
  it('install proceeds to 201 when the transport probe is inconclusive (5xx)', async () => {
    mockDiscovery(rfc9207Result)
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw, inconclusiveProbe))
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'inconclusive-remote',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'cimd',
      })
    expect(res.status).toBe(201)
    // The CR was written despite the inconclusive probe.
    await expect(gw.getResource('mcpservers', 'inconclusive-remote', NS)).resolves.toBeTruthy()
  })
})

// ─── C2: DCR install saga (spec 02 C2, DEC-18/DEC-19) ───────────────────────
describe('POST /admin/mcp-servers/remote — DCR install saga (C2)', () => {
  const ENC_KEY = deriveOAuthEncryptionKey(config.oauthEncryptionKey)
  const PUBLIC_IP = async () => ['93.184.216.34']
  // The DCR request needs a configured public callback origin for redirect_uris.
  let savedCallbackBaseUrl: string

  // Real DCR DiscoveryResults, DERIVED FROM THE REAL PRODUCER by documented
  // subtraction (DEC-19): the actual discovery client is run against the Notion
  // probe with CIMD support removed (→ DCR) and, for confidential, `none` dropped.
  let dcrPublicResult: DiscoveryResult
  let dcrConfidentialResult: DiscoveryResult
  // Real DCR DiscoveryResult WITHOUT RFC 9207 (pristine `dcrPilot`, no substitution):
  // the fixture the install must reject before any AS registration (R3F-H1).
  let dcrNoIssResult: DiscoveryResult

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/oauth/discovery.js')>(
      '../src/oauth/discovery.js'
    )
    const noIssPilot = dcrPilot('public')
    const noIssOutcome = await actual.discoverRemoteOAuth(noIssPilot.mcpUrl, {
      transport: makeDiscoveryTransport(noIssPilot),
      resolveDns: PUBLIC_IP,
    })
    if (!noIssOutcome.ok)
      throw new Error(`dcr no-iss fixture discovery failed: ${noIssOutcome.error.kind}`)
    expect(noIssOutcome.result.issForCallback).toBeUndefined()
    dcrNoIssResult = noIssOutcome.result

    for (const [mode, assign] of [
      ['public', (r: DiscoveryResult) => (dcrPublicResult = r)],
      ['confidential', (r: DiscoveryResult) => (dcrConfidentialResult = r)],
    ] as const) {
      // RFC 9207 is mandatory for a remote install (R3F-H1); a DCR AS that omits it
      // is rejected before registration. Add the advertisement via the same
      // producer-derived substitution so the DCR success paths exercise the saga.
      const pilot = withRfc9207(dcrPilot(mode))
      const outcome = await actual.discoverRemoteOAuth(pilot.mcpUrl, {
        transport: makeDiscoveryTransport(pilot),
        resolveDns: PUBLIC_IP,
      })
      if (!outcome.ok) throw new Error(`dcr fixture discovery failed: ${outcome.error.kind}`)
      expect(outcome.result.registrationMode).toBe('dcr')
      expect(outcome.result.issForCallback).toBeTruthy()
      assign(outcome.result)
    }
  })

  beforeEach(() => {
    vi.mocked(discoverRemoteOAuth).mockReset()
    savedCallbackBaseUrl = config.oauthCallbackBaseUrl
    config.oauthCallbackBaseUrl = 'https://control.example.com'
  })

  afterEach(() => {
    config.oauthCallbackBaseUrl = savedCallbackBaseUrl
  })

  function makeAppWithDeps(gateway: MockGateway, deps: AdminRemoteMcpDeps) {
    const app = express()
    app.use(express.json())
    // Inject the generic-alive probe by default (F1 collateral: DCR installs baseUrl
    // mcp.notion.com/mcp, which probes alive); a test may override via `deps.probe`.
    app.use(
      createAdminRemoteMcpRouter(gateway as unknown as K8sGateway, { probe: genericProbe, ...deps })
    )
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : 'unknown' })
      }
    )
    return app
  }

  // R3F-H1: a DCR AS without RFC 9207 must be rejected BEFORE the DCR registration
  // POST (saga step 0), so no throwaway client is minted at the AS, no dynamic_clients
  // row is written, and no CR is created. Fails at parent a835d7130 (install registers
  // + persists + creates the CR). `dcrNoIssResult` is producer-derived (no iss), T1.
  it('rejects a DCR install against an AS without RFC 9207 → 422, no DCR registration, no row, no CR', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrNoIssResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'no-rfc9207-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    // Observable outcome (T4): rejected before any AS registration or write.
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('issuer_binding_required')
    // No DCR POST to the AS, no persisted dynamic_clients row, no CR.
    expect(calls).toHaveLength(0)
    expect(rows.size).toBe(0)
    await expect(gw.getResource('mcpservers', 'no-rfc9207-dcr', NS)).rejects.toThrow()
  })

  // T3(a) — fails at parent 9e4677652: DCR install returns 400 dcr_not_available there.
  it('public DCR → 201, persists a dynamic_clients row, sets spec.oauth.id, no Secret refs', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrPublicResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'notion-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      serverName: 'notion-dcr',
      clientMode: 'public',
      registrationMode: 'dcr',
    })
    // A dynamic_clients row was persisted.
    expect(rows.size).toBe(1)
    const stored = [...rows.values()][0]
    expect(stored.client_id).toBe(DCR_PUBLIC_REGISTRATION_RESPONSE.client_id)
    // Public → no secret persisted.
    expect(stored.client_secret_encrypted).toBeNull()

    const cr = (await gw.getResource('mcpservers', 'notion-dcr', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.id).toBe(DCR_PUBLIC_REGISTRATION_RESPONSE.client_id)
    expect(cr.spec.oauth.clientMode).toBe('public')
    // The C4 discriminator: DCR omits the K8s Secret refs.
    expect(cr.spec.oauth.clientIdRef).toBeUndefined()
    expect(cr.spec.oauth.clientSecretRef).toBeUndefined()
  })

  // T3(a)+T3(c) — fails at parent: no row, no encrypted envelope.
  it('confidential DCR → 201, NO K8s Secret, secret persisted as an encrypted envelope', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'vercel-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(201)
    expect(res.body.clientMode).toBe('confidential')

    // DEC-8: a DCR-confidential client gets NO K8s Secret — the secret lives in the store.
    await expect(gw.getSecret('vercel-dcr-oauth-client', NS)).rejects.toThrow()

    // T3(c): the stored secret is an encrypted envelope, never plaintext, and it
    // decrypts back to the registration secret.
    const stored = [...rows.values()][0]
    const secretEnc = stored.client_secret_encrypted as string
    expect(secretEnc).not.toBe(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.client_secret)
    expect(secretEnc.startsWith('v1.')).toBe(true)
    expect(decryptOAuthSecret(ENC_KEY, secretEnc)).toBe(
      DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.client_secret
    )
    // The RFC 7592 registration_access_token is also stored encrypted.
    const regEnc = stored.registration_access_token_encrypted as string
    expect(regEnc.startsWith('v1.')).toBe(true)
    expect(decryptOAuthSecret(ENC_KEY, regEnc)).toBe(
      DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_access_token
    )

    const cr = (await gw.getResource('mcpservers', 'vercel-dcr', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.id).toBe(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.client_id)
    expect(cr.spec.oauth.clientMode).toBe('confidential')
    expect(cr.spec.oauth.clientSecretRef).toBeUndefined()
  })

  // Regression: the AS DOWNGRADES a confidential request to public (Vercel). The
  // effective auth method (`none`, no secret) must win end to end — persisted and
  // written to the CR as a PUBLIC client. Fails at parent 054c62c7: the DCR guard
  // anchored on the REQUESTED method, so this returned 400 dcr_registration_failed.
  it('confidential-requested DCR that the AS downgrades to public (Vercel) → 201 as PUBLIC, no secret persisted', async () => {
    // `dcrConfidentialResult` has no `none` in its AS auth methods, so the install
    // derives confidential a-priori and requests `client_secret_post` — exactly what
    // triggered the Vercel downgrade in production.
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      responseJson: DCR_VERCEL_DOWNGRADE_REGISTRATION_JSON,
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'vercel-downgrade-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(201)
    // The AS is authoritative: the client persists and reports as PUBLIC.
    expect(res.body.clientMode).toBe('public')

    // A public client stores NO secret envelope.
    const stored = [...rows.values()][0]
    expect(stored.client_mode).toBe('public')
    expect(stored.client_id).toBe(DCR_VERCEL_DOWNGRADE_REGISTRATION_RESPONSE.client_id)
    expect(stored.client_secret_encrypted).toBeNull()

    // No DCR-confidential K8s Secret exists (there is no Secret for DCR at all).
    await expect(gw.getSecret('vercel-downgrade-dcr-oauth-client', NS)).rejects.toThrow()

    const cr = (await gw.getResource('mcpservers', 'vercel-downgrade-dcr', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.clientMode).toBe('public')
    expect(cr.spec.oauth.id).toBe(DCR_VERCEL_DOWNGRADE_REGISTRATION_RESPONSE.client_id)
    // Public → resolves via PKCE + `oauth.id`, no Secret refs (mirrors ClickUp).
    expect(cr.spec.oauth.clientIdRef).toBeUndefined()
    expect(cr.spec.oauth.clientSecretRef).toBeUndefined()
  })

  // Security: a PUBLIC assignment (`none`) that ALSO echoes a client_secret must
  // classify public and DISCARD the secret — never persist it. Observable result:
  // the stored row is public with a NULL secret envelope.
  it('public DCR where the AS echoes a stray client_secret → 201 public, secret DISCARDED (not persisted)', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrPublicResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport } = makeDcrTransport({
      responseJson: DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_JSON,
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'echoed-secret-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(201)
    expect(res.body.clientMode).toBe('public')

    const stored = [...rows.values()][0]
    expect(stored.client_mode).toBe('public')
    expect(stored.client_id).toBe(DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_RESPONSE.client_id)
    // The echoed secret is discarded — no envelope persisted.
    expect(stored.client_secret_encrypted).toBeNull()

    const cr = (await gw.getResource('mcpservers', 'echoed-secret-dcr', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.clientMode).toBe('public')
    expect(cr.spec.oauth.clientSecretRef).toBeUndefined()
  })

  // T3(b) — fails at parent ffb2005: the minted-but-rejected auth_method_unsupported
  // error carried no RFC 7592 handle there, so NO cleanup DELETE was attempted.
  it('confidential DCR where the AS assigns client_secret_basic → 400 auth_method_unsupported, cleans up the minted client', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_BASIC_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'basic-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('auth_method_unsupported')
    // Fail-closed: no row persisted, no CR written.
    expect(rows.size).toBe(0)
    await expect(gw.getResource('mcpservers', 'basic-dcr', NS)).rejects.toThrow()
    // The AS DID mint a client (2xx + client_id) before we rejected the auth method —
    // a best-effort RFC 7592 DELETE against its management endpoint was attempted.
    const deleteCall = calls.find(c => c.method === 'DELETE')
    expect(deleteCall?.url).toBe(DCR_BASIC_REGISTRATION_RESPONSE.registration_client_uri)
    expect(deleteCall?.headers.authorization).toBe(
      `Bearer ${DCR_BASIC_REGISTRATION_RESPONSE.registration_access_token}`
    )
  })

  it('rolls back the dynamic client (local delete + best-effort RFC 7592 DELETE) when the CR create fails', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const k8sErr = Object.assign(new Error('already exists'), { code: 409 })
    vi.spyOn(gw, 'createResource').mockRejectedValueOnce(k8sErr)
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'rollback-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(409)
    // Local store row deleted.
    expect(rows.size).toBe(0)
    // Best-effort RFC 7592 DELETE against the management endpoint was attempted.
    const deleteCall = calls.find(c => c.method === 'DELETE')
    expect(deleteCall?.url).toBe(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_client_uri)
    expect(deleteCall?.headers.authorization).toBe(
      `Bearer ${DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_access_token}`
    )
  })

  // T3(a) — fails at parent ffb2005: the persist had no try/catch there, so the
  // upsert throw unwound to a 500 with NO cleanup of the just-minted AS client.
  it('cleans up the minted client and returns 503 when the local persist throws', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db: baseDb, rows } = makeInMemoryDynamicClientsDb()
    // Inject a store whose INSERT rejects (e.g. pool exhausted / encryption error).
    // DELETE still routes to the in-memory store so the idempotent local revocation
    // runs (the row never landed → 0 rows removed).
    const db = {
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes('INSERT INTO dynamic_clients')) throw new Error('pool exhausted')
        return baseDb.query(text, values)
      },
    } as unknown as typeof baseDb
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'persistfail-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    // Transient/server-side, not a client error.
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('dcr_persist_failed')
    // No dynamic_clients row remains (the INSERT rejected; nothing orphaned locally).
    expect(rows.size).toBe(0)
    // The AS client minted before the persist failed was cleaned up: a best-effort
    // RFC 7592 DELETE against its management endpoint was attempted.
    const deleteCall = calls.find(c => c.method === 'DELETE')
    expect(deleteCall?.url).toBe(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_client_uri)
    expect(deleteCall?.headers.authorization).toBe(
      `Bearer ${DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_access_token}`
    )
    // The CR was never created (we aborted before the saga's step-2).
    await expect(gw.getResource('mcpservers', 'persistfail-dcr', NS)).rejects.toThrow()
  })

  it('rolls back the dynamic client when the Context attach fails', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    // Context exists at the step-0 precheck, then the ATTACH update fails.
    const gw = gatewayWithContext('ctx-a')
    vi.spyOn(gw, 'updateResource').mockRejectedValueOnce(new Error('attach boom'))
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'attach-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(rows.size).toBe(0)
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
    // The CR minted before attach is rolled back too.
    await expect(gw.getResource('mcpservers', 'attach-dcr', NS)).rejects.toThrow()
  })

  it('DCR with an unconfigured public callback base URL → 503, nothing registered', async () => {
    config.oauthCallbackBaseUrl = ''
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrPublicResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'unconfigured-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('callback_base_url_unconfigured')
    // Fail-closed BEFORE any registration POST.
    expect(calls).toHaveLength(0)
    expect(rows.size).toBe(0)
  })

  it('DCR against a missing Context → 404 before minting a throwaway client', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrPublicResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_PUBLIC_REGISTRATION_RESPONSE),
    })
    const gw = new MockGateway(NS) // no Context seeded
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'noctx-dcr',
        contextRef: 'missing-ctx',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })
    expect(res.status).toBe(404)
    // No registration POST fired; no row persisted.
    expect(calls).toHaveLength(0)
    expect(rows.size).toBe(0)
  })

  // ── R3-H1: install identity fences the DCR row writes ──────────────────────
  // The install saga must NEVER clobber or delete a live server's dynamic_clients
  // row. Rows are seeded via the REAL producers (insertDynamicClientPending + bind),
  // read through the REAL getDynamicClient (T1).

  const LIVE_ROW = {
    ownerKind: 'mcpserver' as const,
    serverNamespace: NS,
    issuer: 'https://as.example.com',
    clientId: 'live-client-id',
    clientMode: 'confidential' as const,
    clientSecret: 'live-secret',
    registrationAccessToken: 'live-reg-token',
    registrationClientUri: 'https://as.example.com/register/live',
  }

  // T4/invariant-1 (R3-H1): installing a name already held by a LIVE McpServer must
  // leave that install's row byte-identical and mint NOTHING at the AS. Fails at
  // parent 6938afbd3: with no pre-check and the old clobbering upsert, the CR-create
  // 409 rolls back and DELETEs the (now overwritten) row → the row is gone and the
  // error is the create 409, not `server_name_in_use`.
  it('install over a live McpServer of the same name → 409 server_name_in_use, live row untouched, nothing minted', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const seededInstall = randomUUID()
    await insertDynamicClientPending(db, ENC_KEY, {
      ...LIVE_ROW,
      serverName: 'live-dcr',
      installId: seededInstall,
    })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: 'live-dcr' },
      seededInstall,
      'uid-live-cr'
    )
    const before = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'live-dcr',
    })

    const gw = gatewayWithContext('ctx-a')
    await gw.createResource('mcpservers', { metadata: { name: 'live-dcr' }, spec: {} }, NS)

    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'live-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('server_name_in_use')
    // Pre-check short-circuits BEFORE discovery/mint: no AS interaction at all.
    expect(calls).toHaveLength(0)
    // The live row is byte-identical — never clobbered, never deleted (R3-H1).
    const after = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'live-dcr',
    })
    expect(after).toEqual(before)
    expect(rows.size).toBe(1)
  })

  // The INSERT fence itself (not the pre-check): a live CR that appears AFTER the
  // pre-check but before the persist (TOCTOU) is caught by the ON CONFLICT + classify
  // `in-use`. The row stays byte-identical; the throwaway client we minted is revoked.
  it('TOCTOU: a live CR appears after the pre-check → 409 server_name_in_use via the INSERT fence, row untouched', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db } = makeInMemoryDynamicClientsDb()
    const seededInstall = randomUUID()
    await insertDynamicClientPending(db, ENC_KEY, {
      ...LIVE_ROW,
      serverName: 'toctou-dcr',
      installId: seededInstall,
    })
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: 'toctou-dcr' },
      seededInstall,
      'uid-toctou-cr'
    )
    const before = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'toctou-dcr',
    })

    const gw = gatewayWithContext('ctx-a')
    const realGet = gw.getResource.bind(gw)
    let mcpReads = 0
    vi.spyOn(gw, 'getResource').mockImplementation(async (plural, name, ns) => {
      if (plural === 'mcpservers' && name === 'toctou-dcr') {
        mcpReads += 1
        // First read is the pre-check (name still free); the CR appears by the time
        // the INSERT conflicts and we re-read the live uid for classification.
        if (mcpReads === 1) throw new K8sNotFoundError('mcpservers/toctou-dcr not found')
        return { metadata: { uid: 'uid-toctou-cr' } }
      }
      return realGet(plural, name, ns)
    })

    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'toctou-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('server_name_in_use')
    // The row we seeded is untouched (the INSERT never clobbered it).
    const after = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'toctou-dcr',
    })
    expect(after).toEqual(before)
    // The throwaway client minted before the conflict was revoked at the AS, and the
    // seeded live client's handle was NOT touched.
    const deleteCalls = calls.filter(c => c.method === 'DELETE')
    expect(deleteCalls.map(c => c.url)).toContain(
      DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_client_uri
    )
    expect(deleteCalls.map(c => c.url)).not.toContain(LIVE_ROW.registrationClientUri)
  })

  // Regression guard for the class fix: a transient throw in the conflict-resolution
  // block (here the live-uid re-read) must STILL revoke the client we just minted —
  // otherwise a confidential client is orphaned at the AS. Before the fix this path
  // propagated to a 500 with zero 7592 DELETEs (reproduced by review).
  it('a transient error while classifying a name conflict still revokes the minted client', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db } = makeInMemoryDynamicClientsDb()
    // Seed a fresh pending row so the install's INSERT conflicts and we enter the
    // classify path (which re-reads the live uid).
    await insertDynamicClientPending(db, ENC_KEY, {
      ...LIVE_ROW,
      serverName: 'throwrevoke-dcr',
      installId: randomUUID(),
    })

    const gw = gatewayWithContext('ctx-a')
    const realGet = gw.getResource.bind(gw)
    let mcpReads = 0
    vi.spyOn(gw, 'getResource').mockImplementation(async (plural, name, ns) => {
      if (plural === 'mcpservers' && name === 'throwrevoke-dcr') {
        mcpReads += 1
        // 1st read = pre-check (name free → proceed to mint + INSERT conflict);
        // 2nd read = the conflict re-read of the live uid → transient non-404 error.
        if (mcpReads === 1) throw new K8sNotFoundError('mcpservers/throwrevoke-dcr not found')
        throw Object.assign(new Error('apiserver unavailable'), { code: 500 })
      }
      return realGet(plural, name, ns)
    })

    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'throwrevoke-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    // The transient error surfaces (not swallowed), but the minted client is revoked.
    expect(res.status).toBe(500)
    const deleteCalls = calls.filter(c => c.method === 'DELETE')
    expect(deleteCalls.map(c => c.url)).toContain(
      DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.registration_client_uri
    )
  })

  // A fresh pending row (another saga of the same name in flight) → 409
  // install_in_progress; the in-flight row is untouched and our throwaway client is
  // revoked.
  it('install over a fresh pending row → 409 install_in_progress, in-flight row untouched', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const inflightInstall = randomUUID()
    await insertDynamicClientPending(db, ENC_KEY, {
      ...LIVE_ROW,
      serverName: 'inprogress-dcr',
      clientId: 'inflight-client-id',
      installId: inflightInstall,
    })
    const before = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'inprogress-dcr',
    })

    const gw = gatewayWithContext('ctx-a') // no McpServer seeded → pre-check passes
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeAppWithDeps(gw, { db, dcr: { transport, resolveDns: PUBLIC_IP } })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'inprogress-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('install_in_progress')
    // The in-flight row is untouched (its install still owns it).
    const after = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'inprogress-dcr',
    })
    expect(after).toEqual(before)
    expect(rows.size).toBe(1)
    // Our throwaway minted client was revoked at the AS.
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })

  // An orphan row (bound to a uid with no live CR) does NOT block a reinstall: it is
  // reclaimed (CAS in a tx), the OLD client is revoked, and the install proceeds to 201.
  it('install over a reclaimable orphan → reclaims the row, revokes the old client, 201', async () => {
    vi.mocked(discoverRemoteOAuth).mockResolvedValue({ ok: true, result: dcrConfidentialResult })
    const { db, rows } = makeInMemoryDynamicClientsDb()
    const orphanInstall = randomUUID()
    await insertDynamicClientPending(db, ENC_KEY, {
      ...LIVE_ROW,
      serverName: 'reclaim-dcr',
      clientId: 'orphan-client-id',
      installId: orphanInstall,
    })
    // Bound to a uid whose CR no longer exists → orphan (reclaimable, no live CR).
    await bindDynamicClientToResource(
      db,
      { serverNamespace: NS, serverName: 'reclaim-dcr' },
      orphanInstall,
      'uid-orphan-gone'
    )

    const gw = gatewayWithContext('ctx-a') // no live McpServer → orphan is reclaimable
    const { transport, calls } = makeDcrTransport({
      responseJson: JSON.stringify(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE),
    })
    const res = await request(
      makeAppWithDeps(gw, {
        db,
        dcr: { transport, resolveDns: PUBLIC_IP },
        // The reclaim opens a tx; bind it to the same in-memory db.
        runInTransaction: work => work(db as unknown as DbTransactionClient),
      })
    )
      .post('/admin/mcp-servers/remote')
      .send({
        serverName: 'reclaim-dcr',
        contextRef: 'ctx-a',
        baseUrl: 'https://mcp.notion.com/mcp',
        mode: 'dcr',
      })

    expect(res.status).toBe(201)
    // Still exactly one row, now owned by the new install (minted client_id).
    expect(rows.size).toBe(1)
    const owned = await getDynamicClient(db, ENC_KEY, {
      serverNamespace: NS,
      serverName: 'reclaim-dcr',
    })
    expect(owned?.clientId).toBe(DCR_CONFIDENTIAL_REGISTRATION_RESPONSE.client_id)
    // The OLD (orphan) client was revoked at the AS via its handle read under the lock.
    const deleteCalls = calls.filter(c => c.method === 'DELETE')
    expect(deleteCalls.map(c => c.url)).toContain(LIVE_ROW.registrationClientUri)
  })
})
