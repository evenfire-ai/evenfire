import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { createRpcRouter } from '../routes/rpc.js'
import {
  type HostRuntimeMessageBodyInput,
  buildHostRuntimeMessageRequest,
} from '../services/hostMessageBody.js'

// R2-L7 (#1047): the rpc-proxy → mcp-host message envelope is a hand-typed seam
// no more. The proxy's builder and the Host's ingress suite consume the SAME
// committed vector, so a field added or dropped on either side turns one of the
// two suites red instead of producing a 500 on the first Retry after deploy
// (exactly how `6c60bca3b`'s missing timestamp behaved).

const authTokenMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VECTOR_DIR = path.join(__dirname, '../../../tests/fixtures/model-step-checkpoint')

type HostMessageVector = {
  input: HostRuntimeMessageBodyInput
  body: Record<string, unknown>
}

function readVector(name: string): HostMessageVector {
  return JSON.parse(readFileSync(path.join(VECTOR_DIR, name), 'utf8')) as HostMessageVector
}

const VECTOR = readVector('host-message-request.json')

const VALID_CLAIMS = {
  sub: VECTOR.input.sender,
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: VECTOR.input.metadata.teamId,
  scopes: ['host:message:invoke'],
  hostRefs: [VECTOR.input.hostRef],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: VECTOR.input.hostRef,
  url: 'http://chatllm:8080',
  headers: { 'x-clerum-edge-caller': 'rpc-proxy' },
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createRpcRouter())
  return app
}

beforeEach(() => {
  authTokenMock.verifyRpcToken.mockReturnValue({ ...VALID_CLAIMS })
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({ ...HOST_CONNECTION })
  serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rpc-proxy → mcp-host message envelope vector (R2-L7)', () => {
  it('builds exactly the committed vector', () => {
    // `toEqual` ignores the undefined-valued allow-list slots (`attachments`)
    // that JSON cannot carry, and compares every key the wire body does carry.
    expect(buildHostRuntimeMessageRequest(VECTOR.input)).toEqual(VECTOR.body)
  })

  it('forwards the vector body from the real route', async () => {
    await request(makeApp())
      .post(`/rpc/hosts/${VECTOR.input.hostRef}/messages`)
      .set('authorization', 'Bearer token')
      .set('idempotency-key', VECTOR.input.deliveryMessageId)
      .send(VECTOR.input.body)
      .expect(200)

    // Witness: the route reached the Host once.
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    const forwarded = serviceMock.forwardHostMessageToHost.mock.calls[0][1] as Record<
      string,
      unknown
    >
    // The trace context is minted by the proxy, so it has its own suite; every
    // other wire field is the vector, byte for byte.
    const { traceContext: forwardedTrace, ...forwardedRest } = forwarded
    const { traceContext: vectorTrace, ...vectorRest } = VECTOR.body
    expect(forwardedRest).toEqual(vectorRest)
    expect(forwardedTrace).toMatchObject({
      version: 1,
      origin: 'direct_chat',
      sessionId: VECTOR.input.desktopSessionId,
    })
    // The vector is what the Host persists as the checkpoint source message, so
    // the wire body must not claim a timestamp: the Host forces its receive time.
    expect(vectorTrace).toEqual(VECTOR.input.traceContext)
    expect(VECTOR.body).not.toHaveProperty('timestamp')
  })
})
