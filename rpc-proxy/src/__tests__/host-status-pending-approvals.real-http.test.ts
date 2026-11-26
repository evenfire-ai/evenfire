import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { apiErrorHandler } from '../errorHandler.js'
import { createRpcRouter } from '../routes/rpc.js'
import { forwardHostStatus } from '../services/mcpHostRestService.js'

// The Host status route now projects each pending approval to `{ since }` only.
// rpc-proxy's `/status` answer exposes the count, never the entries, so the
// count must still equal the number of Host entries in that new shape. The test
// talks to a REAL http server through the real `fetch` and the real status
// forwarder; the request the upstream records is the liveness witness.

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  listAllowedServersForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  resolveHostConnectionForUser: vi.fn(),
  refreshV1HostConnection: vi.fn(),
  validateRpcRequest: vi.fn(),
  forwardRpcToServer: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  forwardHostActivity: vi.fn(),
  forwardHostStatus: vi.fn(),
  forwardHostHealth: vi.fn(),
  forwardTaskResultFromHost: vi.fn(),
  forwardCancelToHost: vi.fn(),
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
const controlApiMock = vi.hoisted(() => ({
  ControlApiHostAccessRejectedError: class extends Error {
    constructor(
      readonly status: number,
      readonly denialCode: string | null = null
    ) {
      super(`Control API rejected host access (${status})`)
      this.name = 'ControlApiHostAccessRejectedError'
    }
  },
  fetchUserAllowedServersFromControlApi: vi.fn(),
  fetchHostConnectionFromControlApi: vi.fn(),
  requestHostWakeFromControlApi: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)
vi.mock('../services/controlApiRestService.js', () => controlApiMock)

const HOST_STATUS_BODY = {
  agent: {
    state: 'busy',
    currentTaskId: 'task-1',
    tasksProcessed: 3,
    tasksSucceeded: 2,
    tasksFailed: 0,
    uptime: 600,
  },
  queue: { pending: 1, processing: 1, completed: 2, failed: 0 },
  cronJobs: 0,
  pendingApprovals: [{ since: '2026-11-23T10:00:00.000Z' }, { since: '2026-11-23T10:01:00.000Z' }],
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  app.use(apiErrorHandler)
  return app
}

let server: Server | undefined
let seen: Array<{ method: string; url: string }> = []

beforeEach(async () => {
  seen = []
  authTokenMock.verifyRpcToken.mockReturnValue({
    sub: 'user-uuid-123',
    typ: 'user',
    accessScope: 'team',
    teamId: 'team-1',
    scopes: ['host:status:read'],
    hostRefs: ['chatllm'],
    jti: 'j1',
    iat: 1,
    exp: 9999999999,
  })
  serviceMock.forwardHostStatus.mockImplementation(forwardHostStatus)
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(HOST_STATUS_BODY))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({
    name: 'chatllm',
    url: `http://127.0.0.1:${port}`,
    headers: {},
  })
  serviceMock.refreshV1HostConnection.mockResolvedValue(null)
})

afterEach(async () => {
  vi.clearAllMocks()
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})

describe('GET /rpc/hosts/:hostRef/status with since-only pending approvals', () => {
  it('counts every Host entry and exposes no entry', async () => {
    const res = await request(makeApp())
      .get('/rpc/hosts/chatllm/status')
      .set('authorization', 'Bearer token')

    expect(res.status).toBe(200)
    expect(seen).toEqual([{ method: 'GET', url: '/v1/runtime/status' }])
    expect(res.body.hostRef).toBe('chatllm')
    expect(res.body.pendingApprovalsCount).toBe(HOST_STATUS_BODY.pendingApprovals.length)
    expect(res.body).not.toHaveProperty('pendingApprovals')
  })
})
