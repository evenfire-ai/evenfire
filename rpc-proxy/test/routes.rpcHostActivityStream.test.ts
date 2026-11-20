import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  createRpcHostActivityStreamRouter,
  resetHostActivityStreamRuntimeForTests,
} from '../src/routes/rpcHostActivityStream.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
}))
vi.mock('../src/authToken.js', () => authTokenMock)
vi.mock('../src/services/mcpProxyService.js', () => serviceMock)

const defaultConfig = {
  activityStreamMaxConcurrent: config.activityStreamMaxConcurrent,
  activityStreamMaxPerUser: config.activityStreamMaxPerUser,
  activityStreamMaxPerUserHost: config.activityStreamMaxPerUserHost,
  activityStreamMaxLifetimeMs: config.activityStreamMaxLifetimeMs,
  activityStreamKeepaliveMs: config.activityStreamKeepaliveMs,
  activityStreamIdleTimeoutMs: config.activityStreamIdleTimeoutMs,
}

function makeApp() {
  const app = express()
  app.use(createRpcHostActivityStreamRouter())
  return app
}

describe('routes/rpcHostActivityStream', () => {
  beforeEach(() => {
    resetHostActivityStreamRuntimeForTests()
    authTokenMock.verifyRpcToken.mockReset()
    serviceMock.resolveHostConnectionForUser.mockReset()
    Object.assign(config, defaultConfig)
    vi.restoreAllMocks()
  })

  it('returns 401 without token', async () => {
    const app = makeApp()
    await request(app).get('/rpc/hosts/agent2/activity/stream').expect(401)
  })

  it('returns 403 without host:activity:read scope', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('returns 403 for unauthorized host', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      denied: true,
      code: 'host_access_denied',
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/nope/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(403)
  })

  it('returns 429 when stream limits are exceeded', async () => {
    config.activityStreamMaxConcurrent = 0
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    const app = makeApp()
    await request(app)
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(429)
  })

  it('emits only allowed event names and sanitizes upstream errors', async () => {
    config.activityStreamMaxLifetimeMs = 25
    config.activityStreamKeepaliveMs = 5
    config.activityStreamIdleTimeoutMs = 100
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    const streamPayload = [
      'event: open',
      `data: ${JSON.stringify({ hostRef: 'agent2', observedAt: new Date().toISOString() })}`,
      '',
      'event: activity',
      `data: ${JSON.stringify({
        version: '1.0',
        eventId: 'evt_1',
        hostRef: 'agent2',
        ts: new Date().toISOString(),
        type: 'task.started',
        title: 'started',
        severity: 'info',
        meta: {},
        redactions: [],
      })}`,
      '',
      'event: message',
      `data: ${JSON.stringify({ should: 'be ignored' })}`,
      '',
      'event: error',
      `data: ${JSON.stringify({ message: 'http://internal.local/secret-token' })}`,
      '',
      'event: closed',
      `data: ${JSON.stringify({ reason: 'done' })}`,
      '',
    ].join('\n')

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamPayload))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }
      )
    )

    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(200)
    expect(response.text).toContain('event: open')
    expect(response.text).toContain('event: activity')
    expect(response.text).toContain('event: error')
    expect(response.text).toContain('Activity temporarily unavailable')
    expect(response.text).toContain('event: closed')
    expect(response.text).not.toContain('event: message')
    expect(response.text).not.toContain('internal.local')
    expect(response.text).not.toContain('secret-token')
  })

  it('closes and cancels upstream after a downstream write returns false', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    config.activityStreamMaxConcurrent = 1
    config.activityStreamKeepaliveMs = 30_000
    let cancelled = false
    const payload = Array.from({ length: 100 }, (_, index) =>
      [
        'event: activity',
        `data: ${JSON.stringify({
          version: '1.0',
          eventId: `evt_${index + 1}`,
          hostRef: 'agent2',
          ts: new Date().toISOString(),
          type: 'task.started',
          title: `event-${index + 1}`,
          severity: 'info',
          meta: {},
          redactions: [],
        })}`,
        '',
      ].join('\n')
    ).join('\n')
    let upstreamCloseTimer: ReturnType<typeof setTimeout> | undefined
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload))
            upstreamCloseTimer = setTimeout(() => controller.close(), 100)
          },
          cancel() {
            cancelled = true
            if (upstreamCloseTimer) clearTimeout(upstreamCloseTimer)
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )

    const writes: string[] = []
    const app = express()
    app.use((req, res, next) => {
      const originalWrite = res.write.bind(res)
      vi.spyOn(res, 'write').mockImplementation((chunk: string | Uint8Array, ...args) => {
        const value = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
        writes.push(value)
        if (value.includes('event: activity')) return false
        return originalWrite(chunk, ...args)
      })
      next()
    })
    app.use(createRpcHostActivityStreamRouter())

    const response = await request(app)
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(writes.filter(value => value.includes('event: activity'))).toHaveLength(1)
    await vi.waitFor(() => expect(cancelled).toBe(true))
    expect(writes.some(value => value.includes('event: closed'))).toBe(false)
    expect(response.text).toContain('event: open')
    expect(response.text).not.toContain('event: activity')
  })

  it('cancels upstream immediately when the open frame is backpressured', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    config.activityStreamMaxConcurrent = 1
    config.activityStreamMaxLifetimeMs = 100
    config.activityStreamKeepaliveMs = 30_000
    let cancelled = 0
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'event: activity',
                  `data: ${JSON.stringify({
                    version: '1.0',
                    eventId: 'evt_1',
                    hostRef: 'agent2',
                    ts: new Date().toISOString(),
                    type: 'task.started',
                    title: 'started',
                    severity: 'info',
                    meta: {},
                    redactions: [],
                  })}`,
                  '',
                  '',
                ].join('\n')
              )
            )
          },
          cancel() {
            cancelled += 1
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )

    const writes: string[] = []
    const app = express()
    app.use((req, res, next) => {
      const originalWrite = res.write.bind(res)
      vi.spyOn(res, 'write').mockImplementation((chunk: string | Uint8Array, ...args) => {
        const value = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
        writes.push(value)
        if (value.includes('event: open')) return false
        return originalWrite(chunk, ...args)
      })
      next()
    })
    app.use(createRpcHostActivityStreamRouter())

    const response = await request(app)
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(writes.filter(value => value.includes('event: open'))).toHaveLength(1)
    expect(writes.some(value => value.includes('event: activity'))).toBe(false)
    await vi.waitFor(() => expect(cancelled).toBe(1))
    expect(response.text).not.toContain('event: activity')
  })

  it('aborts an upstream request when the client disconnects before it resolves', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    let upstreamSignal: AbortSignal | undefined
    const upstreamFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal as AbortSignal | undefined
          upstreamSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          )
        })
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstreamFetch as typeof fetch)

    const pending = request(makeApp())
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
    void pending.then(
      () => undefined,
      () => undefined
    )
    await vi.waitFor(() => expect(upstreamFetch).toHaveBeenCalledOnce())
    pending.abort()
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true))
  })

  it('cancels upstream when an incomplete SSE frame exceeds Host event bounds', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue({
      sub: 'user-1',
      typ: 'user',
      teamId: 'team-1',
      scopes: ['host:activity:read'],
      hostRefs: ['agent2'],
      jti: 'j1',
      iat: 1,
      exp: 9999999999,
    })
    serviceMock.resolveHostConnectionForUser.mockResolvedValue({
      name: 'agent2',
      url: 'http://host.local',
      headers: {},
    })
    config.activityStreamMaxConcurrent = 1
    let cancelled = 0
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('x'.repeat(4_096)))
          },
          cancel() {
            cancelled += 1
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )

    const response = await request(makeApp())
      .get('/rpc/hosts/agent2/activity/stream')
      .set('authorization', 'Bearer token')
      .expect(200)

    expect(response.text).toContain('event: open')
    expect(response.text).not.toContain('event: activity')
    await vi.waitFor(() => expect(cancelled).toBe(1))
  })
})
