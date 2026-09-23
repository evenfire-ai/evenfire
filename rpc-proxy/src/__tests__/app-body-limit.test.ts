import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { type Server, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { createApp } from '../app.js'
import { config } from '../config.js'
import { createSandboxUiSession } from '../services/sandboxUiSession.js'

const { declaredHeaderPngOfSize } = createRequire(import.meta.url)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
}

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

// Chat messages use chatJsonBody: 24 MiB envelope + 16 MiB hop credit.
const MIB = 1024 * 1024
const IMAGE_BUDGET_BYTES = 8 * MIB
const BODY_LIMIT_BYTES = 25 * MIB
const MESSAGES_PATH = '/api/v1/rpc/hosts/chatllm/messages'

const VALID_CLAIMS = {
  sub: 'user-uuid-abc',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const HOST_CONNECTION = {
  name: 'chatllm',
  url: 'http://chatllm:8080',
  headers: {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-uuid-abc',
  },
}

function messageBody(dataBase64Length: number): string {
  return JSON.stringify({
    content: 'describe these images',
    attachments: [{ kind: 'image', dataBase64: 'A'.repeat(dataBase64Length) }],
  })
}

function creditedPngMessage(sizeBytes: number): string {
  return JSON.stringify({
    content: 'describe these images',
    attachments: [
      {
        kind: 'image',
        encoding: 'base64',
        mimeType: 'image/png',
        dataBase64: declaredHeaderPngOfSize(sizeBytes).toString('base64'),
      },
    ],
  })
}

// ~1 MB of bytes that are not valid JSON: the parser must read all of it
// before it can fail, which is exactly the work anonymous callers must not
// be able to trigger.
const MALFORMED_JSON_BODY = `{"content": "${'x'.repeat(MIB)}`

// How long a partially uploaded request may wait for its response. A route
// that parses before authenticating never answers here: body-parser keeps
// waiting for the bytes that were announced but not sent.
const EARLY_RESPONSE_TIMEOUT_MS = 2000

/**
 * Announces MALFORMED_JSON_BODY via Content-Length but uploads only its first
 * 16 KB, then waits for the response. A response can only arrive if the route
 * answered without reading the body, which proves the body was never parsed.
 * The upload is aborted once the response (or the timeout) is observed.
 */
function respondsBeforeBodyIsSent(
  server: Server,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const { port } = server.address() as AddressInfo
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        ...headers,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(MALFORMED_JSON_BODY)),
      },
    })
    const timer = setTimeout(() => {
      req.destroy()
      reject(
        new Error(
          `no response within ${EARLY_RESPONSE_TIMEOUT_MS} ms of a partial upload: the route waits for the body before authenticating`
        )
      )
    }, EARLY_RESPONSE_TIMEOUT_MS)
    req.on('response', res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        req.destroy()
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
      })
    })
    req.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    req.write(MALFORMED_JSON_BODY.slice(0, 16 * 1024))
  })
}

function forwardedAttachmentLength(): number {
  expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
  const forwarded = serviceMock.forwardHostMessageToHost.mock.calls[0][1] as {
    attachments: Array<{ dataBase64: string }>
  }
  return forwarded.attachments[0].dataBase64.length
}

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
  serviceMock.resolveHostConnectionForUser.mockResolvedValue(HOST_CONNECTION)
  serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
})

describe('rpc-proxy JSON body limit on POST /rpc/hosts/:hostRef/messages', () => {
  it('accepts a body carrying an 8 MiB credited PNG and forwards it', async () => {
    const res = await request(createApp())
      .post(MESSAGES_PATH)
      .set('authorization', 'Bearer token')
      .set('content-type', 'application/json')
      .send(creditedPngMessage(IMAGE_BUDGET_BYTES))

    expect(res.status).toBe(200)
    expect(forwardedAttachmentLength()).toBeGreaterThan(IMAGE_BUDGET_BYTES)
  })

  it('accepts a 12 MiB credited PNG under the 24 MiB envelope', async () => {
    const body = creditedPngMessage(12 * MIB)
    expect(body.length).toBeGreaterThan(16 * MIB)
    expect(body.length).toBeLessThan(24 * MIB)

    const res = await request(createApp())
      .post(MESSAGES_PATH)
      .set('authorization', 'Bearer token')
      .set('content-type', 'application/json')
      .send(body)

    expect(res.status).toBe(200)
    expect(forwardedAttachmentLength()).toBeGreaterThan(12 * MIB)
  })

  it('refuses a body over the 24 MiB envelope', async () => {
    const body = messageBody(BODY_LIMIT_BYTES)
    expect(body.length).toBeGreaterThan(24 * MIB)

    const res = await request(createApp())
      .post(MESSAGES_PATH)
      .set('authorization', 'Bearer token')
      .set('content-type', 'application/json')
      .send(body)

    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: 'Payload Too Large' })
    // Liveness witness for the negative below: the token was checked.
    expect(authTokenMock.verifyRpcToken).toHaveBeenCalledTimes(1)
    expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
  })
})

describe('rpc-proxy parses request bodies only after authentication (M4)', () => {
  // A real listening server so the unauthenticated cases can upload a body
  // partially and observe the response while the rest is still unsent.
  let server: Server

  beforeAll(async () => {
    // Same binding as supertest's own ephemeral servers (all interfaces).
    server = createApp().listen(0)
    await once(server, 'listening')
  })

  afterAll(async () => {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  })

  it('rejects an unauthenticated malformed body with 401 before receiving it', async () => {
    authTokenMock.verifyRpcToken.mockReturnValue(null)

    const res = await respondsBeforeBodyIsSent(server, MESSAGES_PATH, {
      authorization: 'Bearer forged',
    })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    // Liveness witness: the auth middleware ran and saw the token.
    expect(authTokenMock.verifyRpcToken).toHaveBeenCalledWith('forged')
  })

  it('still parses the same malformed body once the caller is authenticated', async () => {
    const res = await request(server)
      .post(MESSAGES_PATH)
      .set('authorization', 'Bearer token')
      .set('content-type', 'application/json')
      .send(MALFORMED_JSON_BODY)

    // The parser is mounted on the route: its SyntaxError reaches the app's
    // error handler (mapped to 500), and the handler never runs.
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
    expect(res.body.message).toMatch(/JSON/)
    expect(authTokenMock.verifyRpcToken).toHaveBeenCalledWith('token')
    expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
  })

  it('rejects the cookie-authenticated sandbox-ui oauth/token route without a cookie before receiving the body', async () => {
    const res = await respondsBeforeBodyIsSent(
      server,
      '/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token',
      {}
    )

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'sandbox_ui_session_required' })
  })

  it('parses the sandbox-ui oauth/token body once the session cookie is valid', async () => {
    const cookie = createSandboxUiSession('user-uuid-abc', 'sandbox-recipes', 'r1')

    const res = await request(server)
      .post('/api/v1/sandbox-ui/sandbox-recipes/r1/oauth/token')
      .set('Cookie', `${config.sandboxUiCookieName}=${cookie}`)
      .set('content-type', 'application/json')
      .send(MALFORMED_JSON_BODY)

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
    expect(res.body.message).toMatch(/JSON/)
  })
})
