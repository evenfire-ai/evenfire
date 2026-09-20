import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  type DiscoveryOutcome,
  type DiscoveryResult,
  discoverRemoteOAuth,
} from '../src/oauth/discovery.js'
import { createAdminRemoteMcpRouter } from '../src/routes/admin/remoteMcp.js'
import { PILOTS, makeDiscoveryTransport } from './fixtures/remoteOAuthDiscovery.js'
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

  it('marks DCR mode unavailable (not failed) → 200 with dcr.available=false', async () => {
    mockDiscovery({ ...notionResult, registrationMode: 'dcr' })
    const res = await request(makeApp(gatewayWithContext()))
      .post('/admin/mcp-servers/remote/discover')
      .send({ baseUrl: 'https://mcp.example.com/mcp' })
    expect(res.status).toBe(200)
    expect(res.body.detected.registrationMode).toBe('dcr')
    expect(res.body.detected.dcr).toEqual({
      available: false,
      message: 'requires DCR (not available until C2)',
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

  it('rejects DCR mode → 400 dcr_not_available', async () => {
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'stripe-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.example.com/mcp',
      mode: 'dcr',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('dcr_not_available')
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

  it('CIMD requested but AS is DCR-only → 400 (server-side discovery is authoritative)', async () => {
    mockDiscovery({ ...notionResult, registrationMode: 'dcr' })
    const gw = gatewayWithContext('ctx-a')
    const res = await request(makeApp(gw)).post('/admin/mcp-servers/remote').send({
      serverName: 'y-remote',
      contextRef: 'ctx-a',
      baseUrl: 'https://mcp.example.com/mcp',
      mode: 'cimd',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('dcr_not_available')
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
