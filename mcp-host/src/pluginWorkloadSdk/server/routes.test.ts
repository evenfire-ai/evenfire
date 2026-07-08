import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type http from 'http'
import type { AddressInfo } from 'net'
import type { ClientNotificationsHandler } from '../clientNotifications/handler'
import type { PromptBridgeHandler } from '../promptBridge/handler'
import { registerSdkRoutes } from './routes'

const API_TOKEN = 'recipe-scoped-api-token'
const WORKER_TOKEN = 'recipe-scoped-worker-token'
const workloadTokens = new Map<string, string>([
  [API_TOKEN, 'api'],
  [WORKER_TOKEN, 'worker'],
])

describe('SDK routes — workload auth + rate limiting', () => {
  let server: http.Server
  let baseUrl: string
  const promptHandle = vi.fn()
  const notifyHandle = vi.fn()
  const listRecipients = vi.fn()

  beforeEach(async () => {
    promptHandle.mockReset().mockResolvedValue({ invocationId: 'inv-1' })
    notifyHandle.mockReset().mockResolvedValue({ notificationId: 'not-1' })
    listRecipients.mockReset().mockResolvedValue([{ userRef: 'user-1' }])
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    registerSdkRoutes(app, {
      workloadTokens,
      promptBridgeHandler: { handle: promptHandle } as unknown as PromptBridgeHandler,
      clientNotificationsHandler: {
        handle: notifyHandle,
        listRecipients,
      } as unknown as ClientNotificationsHandler,
      maxRequestsPerMinutePerWorkload: 3,
      maxConcurrentPerWorkload: 10,
    })
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ any: 'payload' }),
    })

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { headers })

  it('GET /healthz responds without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
  })

  it('rejects requests without a workload token', async () => {
    const res = await post('/sdk/v1/prompt-bridge', { 'x-clerum-caller-ref': 'api' })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized')
    expect(promptHandle).not.toHaveBeenCalled()
  })

  it('rejects a wrong workload token', async () => {
    const res = await post('/sdk/v1/prompt-bridge', {
      Authorization: 'Bearer wrong-token',
      'x-clerum-caller-ref': 'api',
    })
    expect(res.status).toBe(401)
  })

  it('derives callerRef from the bearer token, not the client header', async () => {
    const res = await post('/sdk/v1/prompt-bridge', {
      Authorization: `Bearer ${API_TOKEN}`,
      'x-clerum-caller-ref': 'spoofed-caller',
    })
    expect(res.status).toBe(200)
    expect(promptHandle).toHaveBeenCalledWith({ any: 'payload' }, 'api')
  })

  it('dispatches to the promptBridge handler with the token-bound caller ref', async () => {
    const res = await post('/sdk/v1/prompt-bridge', {
      Authorization: `Bearer ${API_TOKEN}`,
    })
    expect(res.status).toBe(200)
    expect(promptHandle).toHaveBeenCalledWith({ any: 'payload' }, 'api')
  })

  it('dispatches to the clientNotifications handler', async () => {
    const res = await post('/sdk/v1/client-notifications', {
      Authorization: `Bearer ${WORKER_TOKEN}`,
    })
    expect(res.status).toBe(200)
    expect(notifyHandle).toHaveBeenCalledWith({ any: 'payload' }, 'worker')
  })

  it('dispatches recipient listing with the token-bound caller ref', async () => {
    const res = await get('/sdk/v1/client-notifications/recipients', {
      Authorization: `Bearer ${WORKER_TOKEN}`,
      'x-clerum-caller-ref': 'spoofed-caller',
    })
    expect(res.status).toBe(200)
    expect(listRecipients).toHaveBeenCalledWith('worker')
    expect(await res.json()).toEqual({ recipients: [{ userRef: 'user-1' }] })
  })

  it('rejects recipient listing without a workload token', async () => {
    const res = await get('/sdk/v1/client-notifications/recipients')
    expect(res.status).toBe(401)
    expect(listRecipients).not.toHaveBeenCalled()
  })

  it('enforces the per-workload requests-per-minute limit', async () => {
    const headers = {
      Authorization: `Bearer ${API_TOKEN}`,
    }
    for (let i = 0; i < 3; i++) {
      const ok = await post('/sdk/v1/prompt-bridge', headers)
      expect(ok.status).toBe(200)
    }
    const limited = await post('/sdk/v1/prompt-bridge', headers)
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: string }).error).toBe('quota_exceeded')
  })

  it('tracks rate limits per caller independently', async () => {
    for (let i = 0; i < 3; i++) {
      await post('/sdk/v1/prompt-bridge', {
        Authorization: `Bearer ${API_TOKEN}`,
      })
    }
    const other = await post('/sdk/v1/prompt-bridge', {
      Authorization: `Bearer ${WORKER_TOKEN}`,
    })
    expect(other.status).toBe(200)
  })

  it('applies the SDK server rate limit to recipient listing requests', async () => {
    const headers = {
      Authorization: `Bearer ${WORKER_TOKEN}`,
    }
    for (let i = 0; i < 3; i++) {
      const ok = await get('/sdk/v1/client-notifications/recipients', headers)
      expect(ok.status).toBe(200)
    }
    const limited = await get('/sdk/v1/client-notifications/recipients', headers)
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { error: string }).error).toBe('quota_exceeded')
  })
})
