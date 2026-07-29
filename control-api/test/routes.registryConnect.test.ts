// test/routes.registryConnect.test.ts
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import express from 'express'
import { generateKeyPairSync } from 'node:crypto'
import request from 'supertest'
import { createRegistryConnectRouter } from '../src/routes/admin/registryConnect.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryUrl: 'https://example.com',
    registryAuthEnabled: true,
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

const uiAuth = vi.hoisted(() => ({
  requireAuthForControlUI: vi.fn(
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      ;(req as unknown as { adminAuth: unknown }).adminAuth = {
        sub: 'admin-uuid-123',
        role: 'admin',
        typ: 'user',
      }
      next()
    }
  ),
}))
vi.mock('../src/middleware/controlUIAuth.js', () => uiAuth)

const adminSvc = vi.hoisted(() => ({ findAdminById: vi.fn() }))
vi.mock('../src/services/adminAuthService.js', () => adminSvc)

const connDb = vi.hoisted(() => ({
  getRegistryConnection: vi.fn(),
  upsertPendingConnection: vi.fn(),
  markConnected: vi.fn(),
  deleteConnection: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => connDb)

function app(): express.Express {
  const a = express()
  a.use(express.json())
  a.use(createRegistryConnectRouter())
  return a
}

function pkForTest(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

/**
 * Route fetches by URL, constructing a FRESH Response per call. The existing
 * mockResolvedValue idiom cannot be reused here: it returns one Response
 * instance, and reading its body twice throws 'Body is unusable'.
 */
function routeFetch(handlers: Record<string, () => Response>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    for (const [fragment, make] of Object.entries(handlers)) {
      if (url.includes(fragment)) return make()
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as ReturnType<typeof vi.spyOn>
}

const json = (body: unknown, status: number, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers })

beforeEach(() => {
  vi.clearAllMocks()
  adminSvc.findAdminById.mockResolvedValue({
    id: 'admin-uuid-123',
    username: 'alice',
    status: 'active',
  })
  connDb.markConnected.mockResolvedValue(true)
  cfg.registryConnectionMode = 'self-hosted'
  cfg.registryAuthEnabled = true
})
afterEach(() => vi.restoreAllMocks())

describe('registry connect flow', () => {
  it('GET → disconnected when no row', async () => {
    cfg.registryAuthEnabled = true
    connDb.getRegistryConnection.mockResolvedValue(null)
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body.state).toBe('disconnected')
    expect(res.body.authEnabled).toBe(true)
  })

  it('GET connected → includes authEnabled reflecting config (true)', async () => {
    cfg.registryAuthEnabled = true
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'connected',
      deploymentId: 'dep-9',
      orgName: 'acme',
    })
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme', authEnabled: true })
  })

  it('GET connected → includes authEnabled reflecting config (false)', async () => {
    cfg.registryAuthEnabled = false
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'connected',
      deploymentId: 'dep-9',
      orgName: 'acme',
    })
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme', authEnabled: false })
  })

  it('409 not_self_hosted in managed mode', async () => {
    cfg.registryConnectionMode = 'managed'
    const res = await request(app()).get('/admin/registry/connect').expect(409)
    expect(res.body.error).toBe('not_self_hosted')
  })

  it('GET pending → polls the registry status endpoint and surfaces approval', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'approved', suspended: false, claimed: false }), {
        status: 200,
      })
    )
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'approved', deploymentId: 'dep-9', authEnabled: true })
    // it actually polled the registry status endpoint with a DPoP header
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/dep-9/status')
    expect((init as RequestInit).headers).toHaveProperty('DPoP')
  })

  it('GET pending → degrades to local pending when the status poll fails', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('registry unreachable'))
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({
      state: 'pending',
      deploymentId: 'dep-9',
      requestedOrgName: 'acme',
    })
  })

  it('POST request → registers, persists pending, returns 202', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ deployment_id: 'dep-9', key_id: 'kid-9', status: 'pending' }),
          { status: 202 }
        )
      )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body).toMatchObject({
      state: 'pending',
      deploymentId: 'dep-9',
      requestedOrgName: 'acme',
    })
    // registered against the registry register endpoint with a pop in the body
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/register')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.requested_org_name).toBe('acme')
    expect(typeof body.pop).toBe('string')
    expect(typeof body.public_key_pem).toBe('string')
    // persisted pending with the registry-assigned ids + the generated keypair
    expect(connDb.upsertPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'dep-9', keyId: 'kid-9', requestedOrgName: 'acme' })
    )
  })

  it('POST request → 409 already_connected when a connected row exists', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'connected',
      clientId: 'c',
      orgName: 'acme',
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(409)
    expect(res.body.error).toBe('already_connected')
  })

  it('POST request → 400 org_blocklisted surfaces the registry rejection (not opaque 502)', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'org_blocklisted' }), { status: 400 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'clerum', contact_email: 'a@x.io' })
      .expect(400)
    expect(res.body.error).toBe('org_blocklisted')
    expect(connDb.upsertPendingConnection).not.toHaveBeenCalled()
  })

  it('POST request → 502 registry_integration_error on an unexpected registry failure', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(502)
    expect(res.body.error).toBe('registry_integration_error')
  })

  it('POST claim → exchanges the token, persists creds, returns connected', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }), {
        status: 200,
      })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 'tok-abc' })
      .expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme' })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('/api/v1/deployments/claim')
    expect((init as RequestInit).headers).toHaveProperty('DPoP')
    expect(connDb.markConnected).toHaveBeenCalledWith({
      deploymentId: 'dep-9',
      clientId: 'cid',
      clientSecret: 'csecret',
      orgName: 'acme',
    })
  })

  it('POST claim → 410 claim_expired maps the registry 410', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(410)
    expect(res.body.error).toBe('claim_expired')
  })

  it('POST claim → 401 claim_rejected maps a registry 401 (bad PoP / bad token)', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_pop' }), { status: 401 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(401)
    expect(res.body.error).toBe('claim_rejected')
  })

  it('POST claim → 409 already_claimed maps the registry 409 (not opaque 502)', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'already_claimed' }), { status: 409 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('already_claimed')
    expect(connDb.markConnected).not.toHaveBeenCalled()
  })

  it('POST claim → 409 client_unavailable is surfaced distinctly', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-9',
      keyId: 'kid-9',
      privateKeyPem: pkForTest(),
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'client_unavailable' }), { status: 409 })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('client_unavailable')
  })

  it('POST claim → 409 not_pending when no pending row exists', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 't' })
      .expect(409)
    expect(res.body.error).toBe('not_pending')
  })

  it('claim → registry 500 → 502 registry_integration_error', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }))
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 'tok-abc' })
      .expect(502)
    expect(res.body.error).toBe('registry_integration_error')
    expect(connDb.markConnected).not.toHaveBeenCalled()
  })

  it('claim → markConnected matches no row → 409 connection_superseded', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    connDb.markConnected.mockResolvedValue(false)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }), {
        status: 200,
      })
    )
    const res = await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 'tok-abc' })
      .expect(409)
    expect(res.body.error).toBe('connection_superseded')
  })

  it('DELETE → 204 drops the row', async () => {
    connDb.getRegistryConnection.mockResolvedValue({ status: 'pending', deploymentId: 'dep-9' })
    await request(app()).delete('/admin/registry/connect').expect(204)
    expect(connDb.deleteConnection).toHaveBeenCalled()
  })

  // The redeemClaim extraction must NOT convert a registry-unreachable failure
  // into a 502. It escapes the handler and the Express error handler makes it a
  // 500, exactly as before the refactor. Collapsing it to 502 would be a silent
  // contract change for the manual paste route.
  it('manual claim → registry unreachable → 500, not 502', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await request(app())
      .post('/admin/registry/connect/claim')
      .send({ claim_token: 'tok-abc' })
      .expect(500)
  })
})

describe('register — auto-claim (201)', () => {
  it('claims immediately and reports connected', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    connDb.markConnected.mockResolvedValue(true)
    const spy = routeFetch({
      '/register': () =>
        json(
          {
            deployment_id: 'dep-1',
            key_id: 'kid-1',
            status: 'approved',
            claim_token: 'tok-abc',
            claim_expires_at: '2026-07-30T00:00:00Z',
          },
          201
        ),
      '/claim': () => json({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }, 200),
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme' })
    expect(res.body.authEnabled).toBe(true)
    // The claim call must actually carry the token the registry minted, and
    // be PoP-authenticated — otherwise every auto-approved self-hoster gets a
    // registry-side 401 and silently falls back to 202 connecting.
    const [claimUrl, claimInit] = spy.mock.calls[1]!
    expect(String(claimUrl)).toContain('/claim')
    expect((claimInit as RequestInit).headers).toHaveProperty('DPoP')
    const claimBody = JSON.parse(String((claimInit as RequestInit).body))
    expect(claimBody.claim_token).toBe('tok-abc')
  })

  // The mocks return undefined, so `await x` and `void x` produce IDENTICAL
  // invocationCallOrder — an ordering assertion built on call order is green
  // against the exact mutation it exists to catch. Assert on an event log
  // driven by a real async implementation instead.
  it('persists the row BEFORE burning the one-time token', { retry: 0 }, async () => {
    const events: string[] = []
    connDb.getRegistryConnection.mockResolvedValue(null)
    connDb.markConnected.mockResolvedValue(true)
    connDb.upsertPendingConnection.mockImplementation(async () => {
      await new Promise(r => setImmediate(r))
      events.push('persisted')
    })
    // vitest's restoreAllMocks() only restores vi.spyOn registrations and
    // clearAllMocks() only calls mockClear — neither undoes mockImplementation.
    // If the assertion below FAILS (the exact mutation this test exists to
    // catch), a bare mockReset() on the next line never runs and this
    // implementation leaks into every later test in the file. onTestFinished
    // runs regardless of pass/fail.
    onTestFinished(() => connDb.upsertPendingConnection.mockReset())
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/register')) {
        events.push('register')
        return json(
          { deployment_id: 'dep-1', key_id: 'kid-1', status: 'approved', claim_token: 'tok-abc' },
          201
        )
      }
      events.push('claim')
      return json({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }, 200)
    })
    await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(200)
    expect(events).toEqual(['register', 'persisted', 'claim'])
  })

  it("persists status 'approved' and reports connecting when the claim fails", async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    routeFetch({
      '/register': () =>
        json(
          { deployment_id: 'dep-1', key_id: 'kid-1', status: 'approved', claim_token: 'tok-abc' },
          201
        ),
      '/claim': () => json({ error: 'boom' }, 500),
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body).toMatchObject({ state: 'connecting', deploymentId: 'dep-1' })
    expect(connDb.upsertPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' })
    )
  })

  it('reports connecting when the claim fetch throws', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('/register')) {
        return json(
          { deployment_id: 'dep-1', key_id: 'kid-1', status: 'approved', claim_token: 'tok-abc' },
          201
        )
      }
      throw new Error('ECONNREFUSED')
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body.state).toBe('connecting')
  })

  it('declares the auto_claim capability in deployment_info', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    const spy = routeFetch({
      '/register': () => json({ deployment_id: 'dep-1', key_id: 'kid-1', status: 'pending' }, 202),
    })
    await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    const init = spy.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body.deployment_info).toMatchObject({ auto_claim: true })
    // A hung registry must not pin this request indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  // Registry truth (201 = approved, one-time token burned) must win over the
  // response body's shape. A partial rollout or a response-rewriting proxy
  // could return 201 without a usable claim_token; if that persisted
  // 'pending', Task 5's recovery endpoint would refuse the row forever and
  // the org name would be squatted permanently.
  it('201 without a usable claim_token still persists approved and reports connecting', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    routeFetch({
      '/register': () => json({ deployment_id: 'dep-1', key_id: 'kid-1', status: 'approved' }, 201),
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body).toMatchObject({ state: 'connecting', deploymentId: 'dep-1' })
    expect(connDb.upsertPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' })
    )
  })
})

describe('register — 202 pending path is unchanged', () => {
  // Asserting only the response body lets a mutation that pastes
  // status:'approved' into the 202 branch survive: the body is identical, and
  // the never-rotate test below uses a synthetic row so it never observes the
  // real write. Assert the persisted status too.
  it("replies pending AND persists status 'pending'", { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    routeFetch({
      '/register': () => json({ deployment_id: 'dep-1', key_id: 'kid-1', status: 'pending' }, 202),
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(202)
    expect(res.body).toMatchObject({ state: 'pending', deploymentId: 'dep-1' })
    expect(connDb.upsertPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' })
    )
  })
})

describe('register — new registry rejections map to distinct codes', () => {
  const cases: Array<[string, number, unknown, number, string]> = [
    ['org_name_taken', 409, { error: 'org_name_taken' }, 409, 'org_name_taken'],
    ['jti_replayed', 409, { error: 'jti_replayed' }, 409, 'jti_replayed'],
    ['capacity', 429, { error: 'registration_capacity' }, 429, 'registration_capacity'],
    ['per-IP', 429, { error: 'RATE_LIMITED' }, 429, 'rate_limited'],
    ['bad email', 400, { error: 'invalid_contact_email' }, 400, 'invalid_contact_email'],
    ['blocklist', 400, { error: 'org_blocklisted' }, 400, 'org_blocklisted'],
    ['unknown 400', 400, { error: 'who_knows' }, 400, 'invalid_request'],
    // deployment_info is non-empty as of this task (auto_claim capability
    // declaration), so this registry rejection is newly reachable.
    [
      'info too large',
      400,
      { error: 'deployment_info_too_large' },
      400,
      'deployment_info_too_large',
    ],
    ['bad pop', 401, { error: 'invalid_pop' }, 502, 'registry_integration_error'],
    ['unknown 409', 409, { error: 'who_knows' }, 502, 'registry_integration_error'],
    ['unparseable 429', 429, 'not json', 429, 'rate_limited'],
    // Pins the ordering fix: the status check must run BEFORE the body is
    // parsed, or a non-JSON body on an unexpected 2xx throws out of the
    // handler and surfaces as a bare 500 instead of the intended 502.
    ['unexpected 200', 200, 'not json', 502, 'registry_integration_error'],
  ]
  for (const [name, regStatus, regBody, want, code] of cases) {
    it(`${name} → ${want} ${code}`, async () => {
      connDb.getRegistryConnection.mockResolvedValue(null)
      routeFetch({
        '/register': () =>
          typeof regBody === 'string'
            ? new Response(regBody, { status: regStatus })
            : json(regBody, regStatus),
      })
      const res = await request(app())
        .post('/admin/registry/connect/request')
        .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
        .expect(want)
      expect(res.body.error).toBe(code)
      expect(connDb.upsertPendingConnection).not.toHaveBeenCalled()
    })
  }

  it('forwards Retry-After on a per-IP rate limit', async () => {
    connDb.getRegistryConnection.mockResolvedValue(null)
    routeFetch({
      '/register': () => json({ error: 'RATE_LIMITED' }, 429, { 'Retry-After': '86400' }),
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(429)
    expect(res.headers['retry-after']).toBe('86400')
  })
})

describe('register — guarded while a recovery is outstanding', () => {
  it('rejects a re-request when the local row is approved', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const res = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'acme', contact_email: 'a@x.io' })
      .expect(409)
    expect(res.body.error).toBe('recovery_in_progress')
    // upsertPendingConnection DELETEs the row and regenerates the keypair.
    // Doing that here would destroy the only artifact that can recover an
    // already-approved deployment and permanently squat its org name.
    expect(connDb.upsertPendingConnection).not.toHaveBeenCalled()
  })
})

describe('GET — local approved row', () => {
  it('reports connecting and never rotates', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const spy = routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
    })
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body.state).toBe('connecting')
    expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
  })

  it('surfaces a terminal recoveryError when already claimed', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: true }, 200),
    })
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'connecting', recoveryError: 'already_claimed' })
  })

  // Deleting the `poll?.suspended ? 'deployment_suspended'` arm of the
  // recoveryError ternary fails no other test. Without it, an operator who
  // suspends an auto-approved-but-unclaimed deployment leaves the panel
  // offering "Finish connecting" with no terminal message.
  it('surfaces a terminal recoveryError when suspended', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    routeFetch({
      '/status': () => json({ status: 'approved', suspended: true, claimed: false }, 200),
    })
    const res = await request(app()).get('/admin/registry/connect').expect(200)
    expect(res.body).toMatchObject({ state: 'connecting', recoveryError: 'deployment_suspended' })
  })
})

// THE operator-flow regression proof. A flag-off registration stays locally
// 'pending' until a human pastes a token; rotating would silently invalidate
// the token an operator delivered out of band.
describe('GET — local pending row is never rotated', () => {
  it(
    'reports approved from the registry poll without touching claim-token',
    { retry: 0 },
    async () => {
      connDb.getRegistryConnection.mockResolvedValue({
        status: 'pending',
        deploymentId: 'dep-1',
        keyId: 'kid-1',
        privateKeyPem: pkForTest(),
        requestedOrgName: 'acme',
      })
      const spy = routeFetch({
        '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
      })
      const res = await request(app()).get('/admin/registry/connect').expect(200)
      expect(res.body.state).toBe('approved')
      expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
      expect(connDb.markConnected).not.toHaveBeenCalled()
    }
  )
})

describe('POST recover', () => {
  it('rotates then claims and reports connected', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    connDb.markConnected.mockResolvedValue(true)
    const spy = routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
      'claim-token': () => json({ claim_token: 'tok-new' }, 200),
      '/claim': () => json({ client_id: 'cid', client_secret: 'csecret', org: 'acme' }, 200),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(200)
    expect(res.body).toMatchObject({ state: 'connected', org: 'acme', authEnabled: true })
    // The rotate call itself must be a real, authenticated, bounded POST — not
    // just a URL the mock happens to match. Each of these mutates production
    // 100% of the time while leaving a body-only assertion green.
    const rot = spy.mock.calls.find(c => String(c[0]).includes('claim-token'))!
    expect((rot[1] as RequestInit).method).toBe('POST')
    expect((rot[1] as RequestInit).headers).toMatchObject({ DPoP: expect.any(String) })
    expect((rot[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    // And the token redeemed against /claim must be the ROTATED one, not the
    // stale row/deploymentId — otherwise a bad rotate silently redeems garbage.
    const claim = spy.mock.calls.find(c => String(c[0]).endsWith('/claim'))!
    expect(JSON.parse(String((claim[1] as RequestInit).body)).claim_token).toBe('tok-new')
  })

  it('refuses when the local row is pending', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'pending',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    // afterEach's restoreAllMocks() leaves globalThis.fetch REAL; if the
    // row.status !== 'approved' gate is ever widened, this proves it loudly
    // (a thrown "unexpected fetch") instead of emitting a real outbound
    // request to example.com.
    const spy = routeFetch({})
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('not_recoverable')
    expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
  })

  it('reports already_claimed WITHOUT spending a rotate', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const spy = routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: true }, 200),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('already_claimed')
    expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
  })

  it('reports deployment_suspended without rotating', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const spy = routeFetch({
      '/status': () => json({ status: 'approved', suspended: true, claimed: false }, 200),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('deployment_suspended')
    expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
  })

  // Deleting the `poll?.status === 'rejected'` guard fails no other test: it
  // would fall through to a rotate against a rejected deployment, the claim
  // 401s, and the user sees a "still connecting" spinner instead of a
  // terminal error.
  it('reports rejected without rotating', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    const spy = routeFetch({
      '/status': () => json({ status: 'rejected', suspended: false, claimed: false }, 200),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('rejected')
    expect(spy.mock.calls.map(c => String(c[0])).some(u => u.includes('claim-token'))).toBe(false)
  })

  // client_unavailable means the registry client is disabled (operator
  // suspension). Retrying rotates forever against a deployment an operator
  // deliberately killed, so it must be terminal.
  it('treats client_unavailable as terminal', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
      'claim-token': () => json({ claim_token: 'tok-new' }, 200),
      '/claim': () => json({ error: 'client_unavailable' }, 409),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('client_unavailable')
  })

  // The rotate call ITSELF can 409 (a second recover after the deployment was
  // claimed elsewhere in between the status poll and the rotate). Falling
  // through to !rotRes.ok -> 202 would tell the user to keep retrying a
  // permanently-claimed deployment instead of a terminal 409.
  it('rotate 409 reports already_claimed', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
      'claim-token': () => json({ error: 'already_claimed' }, 409),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(409)
    expect(res.body.error).toBe('already_claimed')
  })

  // A non-OK, non-409 rotate (e.g. registry 503) must degrade to 202
  // connecting, never a 500 — the never-500 guarantee applies to the rotate
  // response, not just to a thrown fetch.
  it('rotate 503 degrades to 202 connecting', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    routeFetch({
      '/status': () => json({ status: 'approved', suspended: false, claimed: false }, 200),
      'claim-token': () => json({ error: 'boom' }, 503),
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(202)
    expect(res.body.state).toBe('connecting')
  })

  // A rotate response with a 200 status but a non-JSON body (an ingress or
  // proxy splash page) must not let `await rotRes.json()` throw OUTSIDE the
  // try/catch that guards the rest of this block — the register route
  // already guards the equivalent hazard (registryConnect.ts:352-363).
  it('rotate 200 with a non-JSON body degrades to 202 connecting', async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/status')) {
        return json({ status: 'approved', suspended: false, claimed: false }, 200)
      }
      if (url.includes('claim-token')) {
        return new Response('<html>', { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(202)
    expect(res.body.state).toBe('connecting')
  })

  // GET never 500s on a registry hiccup (registryConnect.ts:50-52); recovery
  // must honour the same guarantee.
  it('degrades to 202 connecting when the rotate fetch throws', { retry: 0 }, async () => {
    connDb.getRegistryConnection.mockResolvedValue({
      status: 'approved',
      deploymentId: 'dep-1',
      keyId: 'kid-1',
      privateKeyPem: pkForTest(),
      requestedOrgName: 'acme',
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).includes('/status')) {
        return json({ status: 'approved', suspended: false, claimed: false }, 200)
      }
      throw new Error('ECONNREFUSED')
    })
    const res = await request(app()).post('/admin/registry/connect/recover').expect(202)
    expect(res.body.state).toBe('connecting')
  })
})
