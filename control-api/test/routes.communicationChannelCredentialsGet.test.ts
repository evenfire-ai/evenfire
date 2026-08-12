import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { ApiException } from '@kubernetes/client-node'
import request from 'supertest'
import { createApp } from '../src/app.js'
import type { K8sGateway } from '../src/k8s.js'
import { createAdminResourcesRouter } from '../src/routes/admin/resources.js'
import { MockGateway } from './mockGateway.js'

// Same hand-crafted gateway double as routes.adminCommunicationChannelCredentials.test.ts:
// only the K8sGateway methods this cascade touches.
const gatewayMock = {
  createResource: vi.fn(),
  deleteResource: vi.fn(),
  getResource: vi.fn(),
  updateResource: vi.fn(),
  createSecret: vi.fn(),
  mergeSecret: vi.fn(),
  removeSecretKey: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
}

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createAdminResourcesRouter(gatewayMock as unknown as K8sGateway))
  return app
}

// The wire form of a Secret value: base64. Planting the raw string instead
// would let a leak that ships `.data` verbatim slip past the sentinel checks.
const SENTINEL_RAW = 'hunter2'
const SENTINEL_B64 = Buffer.from(SENTINEL_RAW).toString('base64') // 'aHVudGVyMg=='

describe('GET /admin/communication-channels/:name/credentials — names only', () => {
  beforeEach(() => {
    Object.values(gatewayMock).forEach(fn => fn.mockReset())
  })

  it('returns exactly { name, secretName, namespace, keys } and nothing else', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gatewayMock.getSecret.mockResolvedValue({
      metadata: { name: 'cc-foo-credentials', namespace: 'channels' },
      data: {
        'telegram-bot-token': Buffer.from('tg-token').toString('base64'),
        'slack-signing-secret': SENTINEL_B64,
      },
    })

    const res = await request(makeApp()).get('/admin/communication-channels/foo/credentials')

    expect(res.status).toBe(200)
    // toEqual on the WHOLE body, never objectContaining: the panel only needs
    // presence, so any extra property is a leak surface and must fail here.
    expect(res.body).toEqual({
      name: 'foo',
      secretName: 'cc-foo-credentials',
      namespace: 'channels',
      keys: ['slack-signing-secret', 'telegram-bot-token'],
    })
  })

  it('reads the Secret the channel points at, not the conventional name', async () => {
    // Every other fixture sets credentialsSecretRef to `cc-<name>-credentials`,
    // which is byte-identical to the fallback — so the ref lookup, the whole
    // reason this route reads the CC at all, was never exercised. A channel
    // pointing at an operator-supplied Secret would report the keys of a
    // `cc-foo-credentials` that does not exist, which is the same lie about
    // what is configured that this endpoint was added to kill.
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'ops-shared-slack' } },
    })
    gatewayMock.getSecret.mockResolvedValue({
      metadata: { name: 'ops-shared-slack', namespace: 'channels' },
      data: { 'slack-bot-token': Buffer.from('xoxb-shared').toString('base64') },
    })

    const res = await request(makeApp()).get('/admin/communication-channels/foo/credentials')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      name: 'foo',
      secretName: 'ops-shared-slack',
      namespace: 'channels',
      keys: ['slack-bot-token'],
    })
    // The call ARGUMENTS are the point. Asserting only the body leaves a route
    // that never reads the CC, or reads the right Secret out of the wrong
    // namespace, passing: both can still produce a plausible-looking answer.
    expect(gatewayMock.getResource).toHaveBeenCalledWith('communicationchannels', 'foo', 'channels')
    expect(gatewayMock.getSecret).toHaveBeenCalledWith('ops-shared-slack', 'channels')
  })

  it('returns 200 with keys: [] when the channel has no Secret yet', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1' },
    })
    gatewayMock.getSecret.mockRejectedValue(
      new ApiException(404, 'Not Found', { message: 'secrets "cc-foo-credentials" not found' }, {})
    )

    const res = await request(makeApp()).get('/admin/communication-channels/foo/credentials')

    // "No credentials yet" is a normal state the panel renders, not an error.
    // A 404 here would force every caller to handle two shapes for one meaning.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      name: 'foo',
      secretName: 'cc-foo-credentials',
      namespace: 'channels',
      keys: [],
    })
  })

  it('never leaks a Secret value, raw or base64', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    gatewayMock.getSecret.mockResolvedValue({
      metadata: { name: 'cc-foo-credentials', namespace: 'channels' },
      data: { 'slack-signing-secret': SENTINEL_B64 },
    })

    const res = await request(makeApp()).get('/admin/communication-channels/foo/credentials')

    expect(res.status).toBe(200)
    const serialized = JSON.stringify(res.body)
    // Checking only the raw string is how the existing PUT's `result: merged`
    // leak survived a green suite: `.data` ships every value base64-INTACT,
    // so a raw-only assertion stays green while the whole Secret goes out.
    expect(serialized).not.toContain(SENTINEL_RAW)
    expect(serialized).not.toContain(SENTINEL_B64)
    expect(res.text).not.toContain(SENTINEL_RAW)
    expect(res.text).not.toContain(SENTINEL_B64)
  })

  it('fails closed on an unreadable Secret without echoing key names or values', async () => {
    gatewayMock.getResource.mockResolvedValue({
      metadata: { name: 'foo', namespace: 'channels' },
      spec: { hostRef: 'h1', credentialsSecretRef: { name: 'cc-foo-credentials' } },
    })
    // A REAL ApiException, not a hand-rolled { statusCode } object: the client
    // sets `.code`, and a fabricated shape would let a status check that can
    // never match in production pass here.
    gatewayMock.getSecret.mockRejectedValue(
      new ApiException(403, 'Forbidden', { message: 'secrets is forbidden' }, {})
    )

    const res = await request(makeApp()).get('/admin/communication-channels/foo/credentials')

    // A 403 must not be laundered into "no credentials": the panel would then
    // tell the operator a configured channel is empty.
    expect(res.status).toBeGreaterThanOrEqual(500)
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('slack-signing-secret')
    expect(serialized).not.toContain(SENTINEL_RAW)
    expect(serialized).not.toContain(SENTINEL_B64)
    expect(res.text).not.toContain(SENTINEL_RAW)
    expect(res.text).not.toContain(SENTINEL_B64)
  })

  it('rejects an unauthenticated caller exactly like the sibling PUT', async () => {
    const app = createApp(new MockGateway('channels') as never)

    const getRes = await request(app).get('/api/v1/admin/communication-channels/foo/credentials')
    const putRes = await request(app)
      .put('/api/v1/admin/communication-channels/foo/credentials')
      .send({ 'telegram-bot-token': 'tok' })

    // Same gate, same answer: the read is no more public than the write that
    // sets the values. The control-UI gate is app-level middleware over the
    // whole /admin prefix, so this pins the route to that prefix rather than
    // re-testing the middleware (middleware.controlUIAuth.test.ts owns that).
    expect(getRes.status).toBe(401)
    expect(getRes.status).toBe(putRes.status)
  })
})
