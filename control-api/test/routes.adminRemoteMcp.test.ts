import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type DiscoveryOutcome,
  type DiscoveryResult,
  discoverRemoteOAuth,
} from '../src/oauth/discovery.js'
import { decryptOAuthSecret, deriveOAuthEncryptionKey } from '../src/oauth/encryption.js'
import {
  type AdminRemoteMcpDeps,
  createAdminRemoteMcpRouter,
} from '../src/routes/admin/remoteMcp.js'
import {
  DCR_BASIC_REGISTRATION_RESPONSE,
  DCR_CONFIDENTIAL_REGISTRATION_RESPONSE,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  DCR_REGISTRATION_ENDPOINT,
  PILOTS,
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

function makeApp(gateway: MockGateway) {
  const app = express()
  app.use(express.json())
  app.use(createAdminRemoteMcpRouter(gateway as unknown as K8sGateway))
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
})

describe('POST /admin/mcp-servers/remote (install saga)', () => {
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

    const secret = (await gw.getSecret('slack-remote-oauth-client', NS)) as {
      stringData?: Record<string, string>
    }
    expect(secret.stringData).toEqual({ client_id: 'client-abc', client_secret: 'shhh-secret' })

    const cr = (await gw.getResource('mcpservers', 'slack-remote', NS)) as {
      spec: { oauth: Record<string, unknown> }
    }
    expect(cr.spec.oauth.clientMode).toBe('confidential')
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
    app.use(createAdminRemoteMcpRouter(gateway as unknown as K8sGateway, deps))
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
