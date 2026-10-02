import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { verifyRpcToken } from '../src/authToken.js'
import { createRpcRouter } from '../src/routes/rpc.js'

// Synthetic signing material stays in this closure and is never serialized.
const fixture = await vi.hoisted(async () => {
  const crypto = await import('node:crypto')
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const config = {
    jwtPublicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    jwtIssuer: 'issue-944-test',
    jwtAudience: 'rpc-proxy',
    maxTokenLength: 16384,
    upstreamTimeoutMs: 2000,
    wakeMaxHoldMs: 2000,
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    config,
    sign(overrides: Record<string, unknown> = {}, invalidSignature = false) {
      const now = Math.floor(Date.now() / 1000)
      const payload = {
        sub: 'diagnostic-user',
        typ: 'user',
        accessScope: 'team',
        teamId: 'diagnostic-team',
        scopes: ['host:approval:write'],
        hostRefs: ['diagnostic-host'],
        jti: 'diagnostic-session',
        iss: config.jwtIssuer,
        aud: config.jwtAudience,
        iat: now,
        exp: now + 300,
        ...overrides,
      }
      const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}`
      const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey)
      if (invalidSignature) signature[0] ^= 1
      return `${unsigned}.${signature.toString('base64url')}`
    },
  }
})

const edges = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  requestHostWakeFromControlApi: vi.fn(),
}))
vi.mock('../src/config.js', () => ({ config: fixture.config }))
vi.mock('../src/services/mcpProxyService.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, resolveHostConnectionForUser: edges.resolveHostConnectionForUser }
})
vi.mock('../src/services/controlApiRestService.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, requestHostWakeFromControlApi: edges.requestHostWakeFromControlApi }
})

const invalidSubjects = [
  { label: 'empty', sub: '' },
  { label: 'spaces', sub: '   ' },
  { label: 'tab and line breaks', sub: '\t\r\n' },
  { label: 'non-breaking space', sub: '\u00a0' },
  { label: 'byte-order-mark whitespace', sub: '\ufeff' },
  { label: 'missing', sub: undefined },
  { label: 'null', sub: null },
  { label: 'number', sub: 42 },
]
const invalidSessionIds = invalidSubjects.map(({ label, sub }) => ({ label, jti: sub }))
const scopes = [
  { label: 'team', accessScope: 'team', teamId: 'diagnostic-team' },
  { label: 'user', accessScope: 'user', teamId: null },
]
// Matches issueRpcServiceAccessToken's default subject and team binding.
const serviceClaims = {
  sub: 'diagnostic-workload/diagnostic-host',
  typ: 'service',
  accessScope: 'service',
  teamId: 'system',
  service: 'diagnostic-workload',
}
const upstream = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))

function makeApp() {
  const app = express()
  app.use(createRpcRouter())
  return app
}

beforeEach(() => {
  upstream.mockClear()
  vi.stubGlobal('fetch', upstream)
  edges.resolveHostConnectionForUser.mockReset().mockResolvedValue({
    name: 'diagnostic-host',
    url: 'http://diagnostic-host.invalid',
    headers: {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': 'diagnostic-host',
      'x-clerum-edge-user-id': 'diagnostic-user',
    },
  })
  edges.requestHostWakeFromControlApi.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('signed RPC subject validation', () => {
  it.each(invalidSubjects)('rejects $label subject', ({ sub }) => {
    expect(verifyRpcToken(fixture.sign({ sub }))).toBeNull()
  })
  it.each(scopes)('accepts a valid $label-scoped user', ({ accessScope, teamId }) => {
    expect(verifyRpcToken(fixture.sign({ accessScope, teamId }))).toMatchObject({
      sub: 'diagnostic-user',
      accessScope,
      teamId,
    })
  })
  it('preserves a non-blank subject verbatim', () => {
    expect(verifyRpcToken(fixture.sign({ sub: ' diagnostic-user ' }))?.sub).toBe(
      ' diagnostic-user '
    )
  })
  it.each([
    { label: 'issuer', claims: { iss: 'different-issuer' } },
    { label: 'audience', claims: { aud: 'different-audience' } },
    { label: 'expiry', claims: { exp: 1 } },
  ])('still rejects invalid $label', ({ claims }) => {
    expect(verifyRpcToken(fixture.sign(claims))).toBeNull()
  })
  it('still rejects an invalid signature', () => {
    expect(verifyRpcToken(fixture.sign({}, true))).toBeNull()
  })
})

describe('shared verifier token-type compatibility', () => {
  it('rejects an unknown signed token type', () => {
    expect(verifyRpcToken(fixture.sign({ typ: 'unknown' }))).toBeNull()
  })
})

describe('signed RPC service subject validation', () => {
  it('accepts the issuer-supported service identity', () => {
    expect(verifyRpcToken(fixture.sign(serviceClaims))).toMatchObject(serviceClaims)
  })
  it.each(invalidSubjects)('rejects $label service subject', ({ sub }) => {
    expect(verifyRpcToken(fixture.sign({ ...serviceClaims, sub }))).toBeNull()
  })
})

describe.each([
  { label: 'user', claims: {} },
  { label: 'service', claims: serviceClaims },
])('$label RPC session identifier validation', ({ claims }) => {
  it.each(invalidSessionIds)('rejects $label session identifier', ({ jti }) => {
    expect(verifyRpcToken(fixture.sign({ ...claims, jti }))).toBeNull()
  })
  it('preserves a non-blank session identifier verbatim', () => {
    expect(verifyRpcToken(fixture.sign({ ...claims, jti: ' diagnostic-session ' }))?.jti).toBe(
      ' diagnostic-session '
    )
  })
  describe.each(['approve', 'deny'])('%s session identifier authentication', action => {
    it.each(invalidSessionIds)(
      'rejects $label session identifier before any Host side effect',
      async ({ jti }) => {
        const response = await request(makeApp())
          .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
          .set('authorization', `Bearer ${fixture.sign({ ...claims, jti })}`)
          .send({ toolCallId: 'diagnostic-approval' })
        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: 'Unauthorized' })
        expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
        expect(upstream.mock.calls.length).toBe(0)
        expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
      }
    )
  })
})

describe.each(['approve', 'deny'])('%s service authentication contract', action => {
  it('denies an authenticated service identity before any Host side effect', async () => {
    const response = await request(makeApp())
      .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
      .set('authorization', `Bearer ${fixture.sign(serviceClaims)}`)
      .send({ toolCallId: 'diagnostic-approval' })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'Forbidden: user token required' })
    expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
    expect(upstream.mock.calls.length).toBe(0)
    expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
  })
  it.each(invalidSubjects)(
    'rejects $label service subject without Host side effects',
    async ({ sub }) => {
      const response = await request(makeApp())
        .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
        .set('authorization', `Bearer ${fixture.sign({ ...serviceClaims, sub })}`)
        .send({ toolCallId: 'diagnostic-approval' })
      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'Unauthorized' })
      expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
      expect(upstream.mock.calls.length).toBe(0)
      expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
    }
  )
})

describe.each(['approve', 'deny'])('%s approval subject authentication', action => {
  it('rejects an unknown token type before any Host side effect', async () => {
    const response = await request(makeApp())
      .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
      .set('authorization', `Bearer ${fixture.sign({ typ: 'unknown' })}`)
      .send({ toolCallId: 'diagnostic-approval' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
    expect(upstream.mock.calls.length).toBe(0)
    expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
  })
  it.each(invalidSubjects)('rejects $label before any Host side effect', async ({ sub }) => {
    const response = await request(makeApp())
      .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
      .set('authorization', `Bearer ${fixture.sign({ sub })}`)
      .send({ toolCallId: 'diagnostic-approval', userId: 'body-user' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
    expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
    expect(upstream.mock.calls.length).toBe(0)
    expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
  })
  it.each(scopes)('forwards a valid $label-scoped identity', async ({ accessScope, teamId }) => {
    await request(makeApp())
      .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
      .set('authorization', `Bearer ${fixture.sign({ accessScope, teamId })}`)
      .send({ toolCallId: 'diagnostic-approval', userId: 'body-user', alwaysApprove: true })
      .expect(200)
    expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(1)
    const [userId, hostRef] = edges.resolveHostConnectionForUser.mock.calls[0]
    expect([userId, hostRef]).toEqual(['diagnostic-user', 'diagnostic-host'])
    expect(upstream.mock.calls.length).toBe(1)
    const [url, init] = upstream.mock.calls[0]
    expect(String(url)).toBe(`http://diagnostic-host.invalid/v1/runtime/approvals/${action}`)
    const expected = { userId: 'diagnostic-user', requestId: 'diagnostic-approval' }
    expect(JSON.parse(String(init?.body))).toEqual(
      action === 'approve' ? { ...expected, alwaysApprove: true } : expected
    )
    expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
  })
  it('preserves scope denial for an authenticated user', async () => {
    await request(makeApp())
      .post(`/rpc/hosts/diagnostic-host/approvals/${action}`)
      .set('authorization', `Bearer ${fixture.sign({ scopes: ['host:status:read'] })}`)
      .send({ toolCallId: 'diagnostic-approval' })
      .expect(403)
    expect(edges.resolveHostConnectionForUser.mock.calls.length).toBe(0)
    expect(upstream.mock.calls.length).toBe(0)
    expect(edges.requestHostWakeFromControlApi.mock.calls.length).toBe(0)
  })
})
