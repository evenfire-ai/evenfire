import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Response as SuperagentResponse } from 'superagent'
import request from 'supertest'
import { createRpcHostProgressStreamRouter } from '../routes/rpcHostProgressStream.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  // Re-exported by mcpProxyService for the host-status stream's
  // consecutive-401 detection. Tests in this file don't exercise that
  // path, but vi.mock must mirror every named export the production
  // module surfaces or sibling routers fail to load.
  UpstreamHostError: class UpstreamHostError extends Error {
    constructor(
      public readonly status: number,
      public readonly bodySnippet: string
    ) {
      super(`Upstream host returned ${status}: ${bodySnippet}`)
      this.name = 'UpstreamHostError'
    }
  },
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-123',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:activity:read'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-123',
  },
}

function makeApp() {
  const app = express()
  app.use(createRpcHostProgressStreamRouter())
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' })
    }
  )
  return app
}

function makeSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const item of events) {
        controller.enqueue(
          encoder.encode(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
        )
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function collectText(
  res: SuperagentResponse,
  callback: (error: Error | null, body: string) => void
) {
  let body = ''
  res.on('data', chunk => {
    body += chunk.toString()
  })
  res.on('end', () => callback(null, body))
  res.on('error', error => callback(error as Error, body))
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReset()
  serviceMock.resolveHostConnectionForUser.mockReset()
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('GET /rpc/hosts/:hostRef/tasks/:taskId/progress/stream', () => {
  it('forwards upstream waiting/open handshake without injecting a proxy open', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        {
          event: 'waiting',
          data: { taskId: 'task-1', ts: '2026-04-17T19:00:00.000Z' },
        },
        {
          event: 'open',
          data: { taskId: 'task-1', ts: '2026-04-17T19:00:01.000Z' },
        },
        {
          event: 'done',
          data: { taskId: 'task-1' },
        },
      ])
    )

    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/chatllm/tasks/task-1/progress/stream')
      .set('authorization', 'Bearer token')
      .buffer(true)
      .parse(collectText)
      .expect(200)

    const text = response.body as string
    const eventNames = Array.from(text.matchAll(/^event: ([^\n]+)$/gm), match => match[1])

    expect(eventNames).toEqual(['waiting', 'open', 'done', 'closed'])
    expect(eventNames.filter(name => name === 'open')).toHaveLength(1)
  })

  it('BUG-13: forwards Phase D terminal event and closes the stream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeSseResponse([
        { event: 'open', data: { taskId: 'task-2' } },
        {
          event: 'terminal',
          data: { taskId: 'task-2', status: 'completed', reason: 'natural' },
        },
      ])
    )

    const app = makeApp()
    const response = await request(app)
      .get('/rpc/hosts/chatllm/tasks/task-2/progress/stream')
      .set('authorization', 'Bearer token')
      .buffer(true)
      .parse(collectText)
      .expect(200)

    const text = response.body as string
    const eventNames = Array.from(text.matchAll(/^event: ([^\n]+)$/gm), match => match[1])

    expect(eventNames).toEqual(['open', 'terminal', 'closed'])
    // Terminal event payload must be forwarded verbatim
    expect(text).toContain('"status":"completed"')
    expect(text).toContain('"reason":"natural"')
  })
})
