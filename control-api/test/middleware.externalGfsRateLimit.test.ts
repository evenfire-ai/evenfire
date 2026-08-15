import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import request from 'supertest'
import {
  externalGfsOperationFor,
  externalGfsPreResolutionRateLimit,
  externalGfsResolvedOperationRateLimit,
  externalGfsSourceIp,
} from '../src/middleware/externalGfsRateLimit.js'

const checkAndIncrement = vi.hoisted(() => vi.fn())
const metrics = vi.hoisted(() => ({
  externalGfsRateLimitRequestsTotal: { inc: vi.fn() },
  externalGfsRateLimitDurationSeconds: { observe: vi.fn() },
}))
const logger = vi.hoisted(() => ({
  rootLogger: { debug: vi.fn(), warn: vi.fn() },
}))

vi.mock('../src/config.js', () => ({
  config: {
    externalGfsIngressRlPerMin: 1800,
    externalGfsTokenUserRlPerMin: 10,
    externalGfsTokenIpRlPerMin: 600,
    externalGfsIpRlPerMin: 1200,
    externalGfsReadRlPerMin: 120,
    externalGfsOperationRlPerMin: 30,
  },
}))
vi.mock('../src/services/rateLimiterService.js', () => ({
  checkAndIncrement: (...args: unknown[]) => checkAndIncrement(...args),
}))
vi.mock('../src/observability/metrics.js', () => metrics)
vi.mock('../src/observability/logger.js', () => logger)

const DESKTOP_USER_ID = '11111111-aaaa-4aaa-8aaa-111111111111'
const CONTROL_ADMIN_ID = '22222222-bbbb-4bbb-8bbb-222222222222'
const RESOURCE_ID = '33333333-cccc-4ccc-8ccc-333333333333'

function allowed(limit = 30, remaining = limit - 1) {
  return {
    allowed: true,
    remaining,
    resetMs: Date.now() + 60_000,
    windowStartMs: Date.now(),
    count: limit - remaining,
  }
}

function denied(limit = 30) {
  return {
    allowed: false,
    remaining: 0,
    resetMs: Date.now() + 30_000,
    windowStartMs: Date.now(),
    count: limit + 1,
  }
}

function buildApp() {
  const resolver = vi.fn()
  const handler = vi.fn()
  const app = express()

  app.use('/external/gfs', (req, _res, next) => {
    ;(req as typeof req & { externalAuth?: { userId: string } }).externalAuth = {
      userId: DESKTOP_USER_ID,
    }
    next()
  })
  app.use('/external/gfs', externalGfsPreResolutionRateLimit)
  app.use('/external/gfs', (req, _res, next) => {
    resolver()
    ;(
      req as typeof req & {
        gfsAuthority?: {
          kind: 'linked-admin'
          tokenSubject: string
          desktopUserId: string
          controlAdminId: string
          authoritySource: 'initial_setup'
        }
      }
    ).gfsAuthority = {
      kind: 'linked-admin',
      tokenSubject: CONTROL_ADMIN_ID,
      desktopUserId: DESKTOP_USER_ID,
      controlAdminId: CONTROL_ADMIN_ID,
      authoritySource: 'initial_setup',
    }
    next()
  })
  app.use('/external/gfs', externalGfsResolvedOperationRateLimit)
  app.use('/external/gfs', (_req, res) => {
    handler()
    res.status(204).end()
  })

  return { app, resolver, handler }
}

describe('external GFS rate boundary', () => {
  beforeEach(() => {
    checkAndIncrement.mockReset()
    checkAndIncrement.mockResolvedValue(allowed())
    metrics.externalGfsRateLimitRequestsTotal.inc.mockReset()
    metrics.externalGfsRateLimitDurationSeconds.observe.mockReset()
    logger.rootLogger.debug.mockReset()
    logger.rootLogger.warn.mockReset()
  })

  it.each([
    ['POST', '/token', 'token', '/external/gfs/token'],
    ['GET', '/resolve', 'resource', '/external/gfs/resolve'],
    ['GET', '/resources', 'resource', '/external/gfs/resources'],
    [
      'GET',
      `/resources/${RESOURCE_ID}/children`,
      'resource',
      '/external/gfs/resources/:id/children',
    ],
    [
      'GET',
      `/resources/${RESOURCE_ID}/affordances`,
      'resource',
      '/external/gfs/resources/:id/affordances',
    ],
    ['GET', `/proxy/${RESOURCE_ID}`, 'proxy-read', '/external/gfs/proxy/:rid'],
    ['PATCH', `/resources/${RESOURCE_ID}`, 'resource-mutation', '/external/gfs/resources/:id'],
    [
      'POST',
      `/resources/${RESOURCE_ID}/children`,
      'resource-mutation',
      '/external/gfs/resources/:id/children',
    ],
    [
      'PUT',
      `/resources/${RESOURCE_ID}/content`,
      'resource-mutation',
      '/external/gfs/resources/:id/content',
    ],
    ['DELETE', `/resources/${RESOURCE_ID}`, 'resource-mutation', '/external/gfs/resources/:id'],
    ['GET', '/grants', 'grants-read', '/external/gfs/grants'],
    ['PUT', '/grants', 'grants-mutation', '/external/gfs/grants'],
    ['DELETE', `/grants/${RESOURCE_ID}`, 'grants-mutation', '/external/gfs/grants/:id'],
    ['GET', '/shares', 'shares-read', '/external/gfs/shares'],
    ['POST', '/shares', 'shares-mutation', '/external/gfs/shares'],
    ['DELETE', `/shares/${RESOURCE_ID}`, 'shares-mutation', '/external/gfs/shares/:id'],
  ] as const)('classifies %s /external/gfs%s as %s', (method, path, operationClass, route) => {
    expect(
      externalGfsOperationFor({
        method,
        baseUrl: '/external/gfs',
        path,
        originalUrl: `/external/gfs${path}`,
      })
    ).toEqual({ operationClass, route })
  })

  it('keeps unclassified paths outside the authority resolver', async () => {
    const { app, resolver, handler } = buildApp()

    const response = await request(app)
      .post('/external/gfs/unclassified')
      .set('x-user-session-token', 'session-one')

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Not Found' })
    expect(checkAndIncrement).not.toHaveBeenCalled()
    expect(resolver).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects before resolution and handler work when the pre-resolution session bucket is exhausted', async () => {
    checkAndIncrement.mockResolvedValueOnce(denied(120))
    const { app, resolver, handler } = buildApp()

    const response = await request(app)
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'session-one')

    expect(response.status).toBe(429)
    expect(response.headers['x-ratelimit-limit']).toBe('120')
    expect(checkAndIncrement).toHaveBeenCalledWith(
      expect.stringMatching(/^gfs-ext:pre:resource:session:[0-9a-f]{64}$/),
      120
    )
    expect(resolver).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(metrics.externalGfsRateLimitRequestsTotal.inc).toHaveBeenCalledWith(
      expect.objectContaining({
        operation_class: 'resource',
        route: '/external/gfs/resources',
        outcome: 'denied',
        phase: 'pre-resolution',
        authority_resolution_avoided: 'true',
      })
    )
    expect(metrics.externalGfsRateLimitDurationSeconds.observe).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-resolution', outcome: 'denied' }),
      expect.any(Number)
    )
    expect(logger.rootLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operationClass: 'resource',
        route: '/external/gfs/resources',
        outcome: 'denied',
        phase: 'pre-resolution',
        hashedKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        latencyMs: expect.any(Number),
        authorityResolutionAvoided: true,
      }),
      'external GFS rate limit denied'
    )
  })

  it('enforces the fixed 10/min user ceiling before minting a GFS token', async () => {
    checkAndIncrement.mockResolvedValueOnce(denied(10))
    const { app, resolver, handler } = buildApp()

    const response = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'session-one')

    expect(response.status).toBe(429)
    expect(response.headers['x-ratelimit-limit']).toBe('10')
    expect(checkAndIncrement).toHaveBeenCalledWith(`gfs-ext:pre:token:user:${DESKTOP_USER_ID}`, 10)
    expect(resolver).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('enforces the fixed 600/min token source-IP ceiling after an allowed token user bucket', async () => {
    checkAndIncrement.mockResolvedValueOnce(allowed(600, 599)).mockResolvedValueOnce(denied(600))
    const { app, resolver, handler } = buildApp()

    const response = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'session-one')

    expect(response.status).toBe(429)
    expect(response.headers['x-ratelimit-limit']).toBe('600')
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      1,
      `gfs-ext:pre:token:user:${DESKTOP_USER_ID}`,
      10
    )
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^gfs-ext:pre:token:ip:[0-9a-f]{64}$/),
      600
    )
    expect(resolver).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('uses the authenticated external-rest client IP before the funnel-appended peer address', async () => {
    checkAndIncrement.mockResolvedValueOnce(allowed(9)).mockResolvedValueOnce(denied())
    const { app } = buildApp()
    const clientIp = '203.0.113.42'
    const clientIpDigest = createHash('sha256').update(clientIp).digest('hex')

    const response = await request(app)
      .post('/external/gfs/token')
      .set('x-user-session-token', 'session-one')
      .set('x-forwarded-for', `${clientIp}, 10.42.0.18`)

    expect(response.status).toBe(429)
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      `gfs-ext:pre:token:ip:${clientIpDigest}`,
      600
    )
  })

  it('uses only a valid first forwarded IP and rejects a spoofed first fragment', () => {
    const requestWithSpoofedForwarding = {
      header: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? 'not-an-ip, 198.51.100.99' : undefined,
      ip: '203.0.113.41',
      socket: { remoteAddress: '10.42.0.18' },
    } as unknown as import('express').Request

    expect(externalGfsSourceIp(requestWithSpoofedForwarding)).toBe('203.0.113.41')
  })

  it('uses distinct session, source-IP, and effective-actor buckets for each operation class', async () => {
    const { app } = buildApp()

    await request(app).get('/external/gfs/resources').set('x-user-session-token', 'session-one')
    await request(app)
      .get(`/external/gfs/proxy/${RESOURCE_ID}`)
      .set('x-user-session-token', 'session-two')

    const keys = checkAndIncrement.mock.calls.map(call => String(call[0]))
    const limits = checkAndIncrement.mock.calls.map(call => Number(call[1]))
    expect(keys).toContainEqual(
      expect.stringMatching(/^gfs-ext:pre:resource:session:[0-9a-f]{64}$/)
    )
    expect(keys).toContainEqual(expect.stringMatching(/^gfs-ext:pre:resource:ip:[0-9a-f]{64}$/))
    expect(keys).toContainEqual(expect.stringMatching(/^gfs-ext:pre:ip:[0-9a-f]{64}$/))
    expect(keys).toContain(`gfs-ext:resolved:resource:actor:linked-admin:${CONTROL_ADMIN_ID}`)
    expect(keys).toContainEqual(
      expect.stringMatching(/^gfs-ext:pre:proxy-read:session:[0-9a-f]{64}$/)
    )
    expect(keys).toContainEqual(expect.stringMatching(/^gfs-ext:pre:proxy-read:ip:[0-9a-f]{64}$/))
    expect(keys).toContain(`gfs-ext:resolved:proxy-read:actor:linked-admin:${CONTROL_ADMIN_ID}`)
    expect(limits.filter(limit => limit === 120).length).toBe(6)
    expect(limits.filter(limit => limit === 1200).length).toBe(2)
    expect(limits.filter(limit => limit === 30).length).toBe(0)
  })

  it('keeps read and mutation budgets independent at every limiter phase', async () => {
    const { app } = buildApp()

    await request(app).get('/external/gfs/resources').set('x-user-session-token', 'session-read')
    await request(app)
      .patch(`/external/gfs/resources/${RESOURCE_ID}`)
      .set('x-user-session-token', 'session-mutation')

    const calls = checkAndIncrement.mock.calls.map(call => [String(call[0]), Number(call[1])])
    expect(calls).toContainEqual([expect.stringMatching(/^gfs-ext:pre:resource:session:/), 120])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:pre:resource-mutation:session:/),
      30,
    ])
    expect(calls).toContainEqual([expect.stringMatching(/^gfs-ext:resolved:resource:actor:/), 120])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:resolved:resource-mutation:actor:/),
      30,
    ])
    expect(calls.filter(([, limit]) => limit === 1200)).toHaveLength(2)
  })

  it('assigns ACL listing to the read budget and ACL writes to the mutation budget', async () => {
    const { app } = buildApp()

    await request(app).get('/external/gfs/grants').set('x-user-session-token', 'session-acl-read')
    await request(app).put('/external/gfs/grants').set('x-user-session-token', 'session-acl-write')
    await request(app).get('/external/gfs/shares').set('x-user-session-token', 'session-acl-read')
    await request(app).post('/external/gfs/shares').set('x-user-session-token', 'session-acl-write')

    const calls = checkAndIncrement.mock.calls.map(call => [String(call[0]), Number(call[1])])
    expect(calls).toContainEqual([expect.stringMatching(/^gfs-ext:pre:grants-read:session:/), 120])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:resolved:grants-read:actor:/),
      120,
    ])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:pre:grants-mutation:session:/),
      30,
    ])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:resolved:grants-mutation:actor:/),
      30,
    ])
    expect(calls).toContainEqual([expect.stringMatching(/^gfs-ext:pre:shares-read:session:/), 120])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:resolved:shares-read:actor:/),
      120,
    ])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:pre:shares-mutation:session:/),
      30,
    ])
    expect(calls).toContainEqual([
      expect.stringMatching(/^gfs-ext:resolved:shares-mutation:actor:/),
      30,
    ])
  })

  it('enforces the 1200/min aggregate IP ceiling after the 120/min read buckets', async () => {
    checkAndIncrement.mockImplementation((key: string, limit: number) => {
      if (key.startsWith('gfs-ext:pre:ip:')) return denied(1200)
      return allowed(limit, limit - 1)
    })
    const { app, resolver, handler } = buildApp()

    const response = await request(app)
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'session-one')

    expect(response.status).toBe(429)
    expect(response.headers['x-ratelimit-limit']).toBe('1200')
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^gfs-ext:pre:resource:session:[0-9a-f]{64}$/),
      120
    )
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^gfs-ext:pre:resource:ip:[0-9a-f]{64}$/),
      120
    )
    expect(checkAndIncrement).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(/^gfs-ext:pre:ip:[0-9a-f]{64}$/),
      1200
    )
    expect(resolver).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('keeps the resolved actor bucket stable when a Desktop session is renewed', async () => {
    checkAndIncrement.mockImplementation((key: string) =>
      key.startsWith('gfs-ext:resolved:resource:actor:') ? denied() : allowed()
    )
    const { app, resolver, handler } = buildApp()

    const first = await request(app)
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'session-before-renewal')
    const second = await request(app)
      .get('/external/gfs/resources')
      .set('x-user-session-token', 'session-after-renewal')

    expect(first.status).toBe(429)
    expect(second.status).toBe(429)
    const resolvedKeys = checkAndIncrement.mock.calls
      .map(call => String(call[0]))
      .filter(key => key.startsWith('gfs-ext:resolved:resource:actor:'))
    expect(resolvedKeys).toEqual([
      `gfs-ext:resolved:resource:actor:linked-admin:${CONTROL_ADMIN_ID}`,
      `gfs-ext:resolved:resource:actor:linked-admin:${CONTROL_ADMIN_ID}`,
    ])
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(handler).not.toHaveBeenCalled()
  })
})
