import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { PinnedTransport } from '../src/http/pinnedFetch.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type DiscoveryOutcome,
  type DiscoveryResult,
  discoverRemoteOAuth,
} from '../src/oauth/discovery.js'
import { decryptOAuthSecret, deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import { probeMcpTransport } from '../src/oauth/mcpTransportProbe.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import {
  DCR_BASIC_REGISTRATION_RESPONSE,
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_JSON,
  DCR_PUBLIC_WITH_ECHOED_SECRET_REGISTRATION_RESPONSE,
  DCR_VERCEL_DOWNGRADE_REGISTRATION_JSON,
  DCR_VERCEL_DOWNGRADE_REGISTRATION_RESPONSE,
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

// Real DiscoveryResult, derived from the real Notion probe fixtures (T1).
let notionResult: DiscoveryResult

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

  const vercelOutcome = await actual.discoverRemoteOAuth(VERCEL_PILOT.mcpUrl, {
    transport: makeDiscoveryTransport(VERCEL_PILOT),
    resolveDns: async () => ['93.184.216.34'],
  })
  if (!vercelOutcome.ok)
    throw new Error(`vercel fixture discovery failed: ${vercelOutcome.error.kind}`)
  vercelResult = vercelOutcome.result
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
    mockDiscovery(notionResult)
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

  it('pre-registered confidential: creates the client Secret + references it in spec.oauth', async () => {
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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
    mockDiscovery(notionResult)
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

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/oauth/discovery.js')>(
      '../src/oauth/discovery.js'
    )
    for (const [mode, assign] of [
      ['public', (r: DiscoveryResult) => (dcrPublicResult = r)],
      ['confidential', (r: DiscoveryResult) => (dcrConfidentialResult = r)],
    ] as const) {
      const pilot = dcrPilot(mode)
      const outcome = await actual.discoverRemoteOAuth(pilot.mcpUrl, {
        transport: makeDiscoveryTransport(pilot),
        resolveDns: PUBLIC_IP,
      })
      if (!outcome.ok) throw new Error(`dcr fixture discovery failed: ${outcome.error.kind}`)
      expect(outcome.result.registrationMode).toBe('dcr')
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
})
