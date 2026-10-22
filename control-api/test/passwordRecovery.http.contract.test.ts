import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { createExternalUsersRouter } from '../src/routes/external/users.js'
import { PasswordAdmissionError } from '../src/services/auth/passwordCredentialVerification.js'
import { signExternalSessionToken } from '../src/utils/auth/externalSessionAuthToken.js'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
import { responseDropProxyApp } from './helpers/passwordRecoveryResponseProxy.js'

// The edge publishes these bodies and profile-ui classifies them by `code`
// from the same document, so the producer mappings are pinned to it.
const invitationPasswordContract = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/invitation-password-public-errors.json', import.meta.url),
    'utf8'
  )
) as Record<
  'password_not_found' | 'password_not_pending' | 'password_expired',
  { status: number; body: Record<string, string> }
>
const {
  password_not_found: notFound,
  password_not_pending: notPending,
  password_expired: expired,
} = invitationPasswordContract

const externalConfig = {
  controlApiBaseUrl: '',
  controlApiServiceToken: '',
  controlApiServiceName: 'external-rest-api',
}
const children: ExternalRestHttpProcess[] = []
let sessionToken: string

const internalServiceToken = 'Synthetic-R6-Producer-Contract-Token'
const producerConfig = vi.hoisted(() => ({
  internalServiceTokens: { 'external-rest-api': 'Synthetic-R6-Producer-Contract-Token' },
  sessionJwtPrivateKey: process.env.CONTROL_API_SESSION_JWT_PRIVATE_KEY!,
  jwtIssuer: 'control-api',
  jwtAudience: 'profile-ui',
  approvalRlExternalClientIpPerMin: 100,
  approvalRlExternalEdgePerMin: 100,
}))
const flow = vi.hoisted(() => ({ validateInvitationFlowToken: vi.fn() }))
const directory = vi.hoisted(() => ({
  acceptInvitationForEmail: vi.fn(),
  getInvitationByToken: vi.fn(),
  listPendingInvitations: vi.fn(),
  setInvitationPasswordForEmail: vi.fn(),
  setInvitationPasswordForUser: vi.fn(),
  verifyUserPassword: vi.fn(),
  updateUserPassword: vi.fn(),
}))
const desktopFlow = vi.hoisted(() => ({ storeDesktopAuthorizationToken: vi.fn() }))

vi.mock('../src/config.js', () => ({ config: producerConfig }))
vi.mock('../src/services/directory/index.js', () => directory)
vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  ...flow,
  ...desktopFlow,
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/middleware/rateLimitMiddleware.js')>()
  return {
    ...real,
    rateLimitMiddleware:
      () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
        next(),
  }
})
vi.mock('../src/middleware/externalSessionAuth.js', () => ({
  requireExternalUserParamMatch: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  rejectBodyUserTeamMismatch: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  requireValidExternalSessionToken: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as express.Request & { externalAuth?: unknown }).externalAuth = {
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      teamId: null,
      role: 'member',
      authGeneration: 1,
    }
    next()
  },
}))
const preview = {
  id: 'r6-reset-row',
  email: 'r6-member@example.invalid',
  purpose: 'password_reset',
  status: 'pending',
  userId: 'r6-user',
  teamId: null,
  teamName: null,
}

let producerServer: Server
let responseDropProxyServer: Server
let responseDropProxyPort: number
let droppedResetResponsesForTest: () => number = () => 0
let previousControlApiBaseUrl: string
let previousControlApiServiceToken: string
let previousControlApiServiceName: string
let nextInvitationContractClientIp = 50

function invitationContractClientIp(): string {
  nextInvitationContractClientIp += 1
  return `198.51.100.${nextInvitationContractClientIp}`
}

interface RawLoopbackResponse {
  status: number
  body: string
  headers: IncomingHttpHeaders
}

function listenOnLoopback(app: express.Express): Promise<Server> {
  const server = app.listen(0, '127.0.0.1')
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => resolve(server))
  })
}

function listeningPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind TCP')
  return address.port
}

async function closeLoopbackServer(server: Server | undefined): Promise<void> {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
}

function requestRawLoopback(
  port: number,
  method: string,
  path: string,
  body: unknown = {}
): Promise<RawLoopbackResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${internalServiceToken}`,
          'x-service-token': 'external-rest-api',
          'content-type': 'application/json',
        },
      },
      incoming => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        )
        incoming.once('error', reject)
        incoming.once('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
          })
        )
      }
    )
    outgoing.once('error', reject)
    if (method === 'GET' || method === 'HEAD') outgoing.end()
    else outgoing.end(JSON.stringify(body))
  })
}

describe('response-drop proxy outbound boundary', () => {
  it('rejects request-target and method variants without dispatching to loopback services', async () => {
    let producerServer: Server | undefined
    let proxyServer: Server | undefined
    let redirectSinkServer: Server | undefined
    const producerRequests: string[] = []
    let redirectSinkRequests = 0

    try {
      const redirectSink = express()
      redirectSink.all('*', (_req, res) => {
        redirectSinkRequests += 1
        res.status(200).json({ sink: 'r7-local-canary' })
      })
      redirectSinkServer = await listenOnLoopback(redirectSink)

      const producer = express()
      producer.use((req, _res, next) => {
        producerRequests.push(`${req.method} ${req.originalUrl}`)
        next()
      })
      producer.post('/ssrf-canary', (_req, res) => res.sendStatus(202))
      producer.post('/api/v1/external/invitations/password-token', (_req, res) =>
        res.sendStatus(204)
      )
      producer.all('/api/v1/external/invitations/password-token', (_req, res) =>
        res.sendStatus(405)
      )
      producerServer = await listenOnLoopback(producer)
      const producerBaseUrl = `http://127.0.0.1:${listeningPort(producerServer)}/api/v1`
      proxyServer = await listenOnLoopback(responseDropProxyApp(producerBaseUrl, () => undefined))

      const targets: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/api/v1/../../ssrf-canary' },
        { method: 'POST', path: '/api/v1/%2e%2e/%2e%2e/ssrf-canary' },
        { method: 'GET', path: '/api/v1/external/invitations/token/../ssrf-canary' },
        { method: 'GET', path: '/api/v1/external/invitations/token/%2e%2e/ssrf-canary' },
        {
          method: 'POST',
          path: '/api/v1/external/invitations/password-token/../../ssrf-canary',
        },
        {
          method: 'POST',
          path: `/api/v1//127.0.0.1:${listeningPort(redirectSinkServer)}/ssrf-canary`,
        },
        {
          method: 'POST',
          path: `/api/v1/external/invitations/password-token/extra?next=//127.0.0.1:${listeningPort(redirectSinkServer)}/ssrf-canary`,
        },
        { method: 'GET', path: '/api/v1/external/invitations/password-token' },
        { method: 'PUT', path: '/api/v1/external/invitations/password-token' },
        { method: 'DELETE', path: '/api/v1/external/invitations/password-token' },
        {
          method: 'HEAD',
          path: '/api/v1/external/invitations/token/r6-synthetic-reset-proof',
        },
        {
          method: 'POST',
          path: `http://127.0.0.1:${listeningPort(redirectSinkServer)}/api/v1/external/invitations/password-token`,
        },
        {
          method: 'POST',
          path: 'http://example.invalid/api/v1/external/invitations/password-token',
        },
      ]
      const responses: RawLoopbackResponse[] = []
      for (const target of targets) {
        responses.push(
          await requestRawLoopback(listeningPort(proxyServer), target.method, target.path, {
            password: 'synthetic-test-value',
          }).catch(() => ({ status: 0, body: '', headers: {} }))
        )
      }

      expect(producerRequests).toEqual([])
      expect(responses.slice(0, 10).map(response => response.status)).toEqual(
        targets.slice(0, 10).map(() => 404)
      )
      expect([0, 400, 404]).toContain(responses[10].status)
      expect([0, 400, 404]).toContain(responses[11].status)
      expect([0, 400, 404]).toContain(responses[12].status)
      expect(redirectSinkRequests).toBe(0)
    } finally {
      await closeLoopbackServer(proxyServer)
      await closeLoopbackServer(producerServer)
      await closeLoopbackServer(redirectSinkServer)
    }
  })

  it('does not follow a producer redirect to a second task-owned loopback server', async () => {
    let producerServer: Server | undefined
    let proxyServer: Server | undefined
    let redirectSinkServer: Server | undefined
    let producerRequests = 0
    let redirectSinkRequests = 0
    let droppedResetResponses = 0
    let notifyDropped: () => void = () => undefined
    const dropped = new Promise<void>(resolve => {
      notifyDropped = resolve
    })

    try {
      const redirectSink = express()
      redirectSink.all('*', (_req, res) => {
        redirectSinkRequests += 1
        res.status(200).json({ sink: 'r7-local-canary' })
      })
      redirectSinkServer = await listenOnLoopback(redirectSink)
      const redirectProducer = express()
      redirectProducer.post('/api/v1/external/invitations/password-token', (_req, res) => {
        producerRequests += 1
        res.redirect(302, `http://127.0.0.1:${listeningPort(redirectSinkServer!)}/redirect-target`)
      })
      producerServer = await listenOnLoopback(redirectProducer)
      const producerBaseUrl = `http://127.0.0.1:${listeningPort(producerServer)}/api/v1`
      proxyServer = await listenOnLoopback(
        responseDropProxyApp(producerBaseUrl, () => {
          droppedResetResponses += 1
          notifyDropped()
        })
      )

      await requestRawLoopback(
        listeningPort(proxyServer),
        'POST',
        '/api/v1/external/invitations/password-token',
        { token: 'synthetic-test-value' }
      ).catch(() => undefined)
      await dropped

      expect(producerRequests).toBe(1)
      expect(droppedResetResponses).toBe(1)
      expect(redirectSinkRequests).toBe(0)
    } finally {
      await closeLoopbackServer(proxyServer)
      await closeLoopbackServer(producerServer)
      await closeLoopbackServer(redirectSinkServer)
    }
  })

  it('forwards the real producer status and JSON body with controlled headers when not dropping', async () => {
    let producerServer: Server | undefined
    let proxyServer: Server | undefined
    try {
      producerServer = await listenOnLoopback(producerResponseApp())
      const producerBaseUrl = `http://127.0.0.1:${listeningPort(producerServer)}/api/v1`
      proxyServer = await listenOnLoopback(
        responseDropProxyApp(producerBaseUrl, () => undefined, { dropResetResponse: false })
      )

      const result = await requestRawLoopback(
        listeningPort(proxyServer),
        'POST',
        '/api/v1/external/invitations/password-token',
        {
          token: 'r6-synthetic-reset-proof',
          email: preview.email,
          invitationId: preview.id,
          password: '',
        }
      ).then(
        response => ({ response }),
        () => ({ response: undefined })
      )

      expect(result.response?.status).toBe(400)
      expect(result.response && JSON.parse(result.response.body)).toEqual({
        error: 'invalid_password',
      })
      expect(result.response?.headers['content-type']).toMatch(/^application\/json/)
      expect(result.response?.headers['retry-after']).toBeUndefined()
      expect(result.response?.headers['set-cookie']).toBeUndefined()
      expect(result.response?.headers.location).toBeUndefined()
      expect(JSON.stringify(result)).not.toMatch(/sql|stack|r6-reset-proof/i)
    } finally {
      await closeLoopbackServer(proxyServer)
      await closeLoopbackServer(producerServer)
    }
  })

  it('rejects producer origins and base paths outside the task-owned loopback API', () => {
    for (const producerBaseUrl of [
      'https://127.0.0.1:43121/api/v1',
      'http://example.invalid:43121/api/v1',
      'http://localhost:43121/api/v1',
      'http://127.0.0.1:43121/api/v1/../../admin',
      'http://127.0.0.1:43121/api/v1?next=/admin',
      'http://user:password@127.0.0.1:43121/api/v1',
    ]) {
      expect(() => responseDropProxyApp(producerBaseUrl, () => undefined)).toThrow()
    }
  })
})

async function publicApp() {
  const child = await startExternalRestHttpProcess({
    controlApiBaseUrl: externalConfig.controlApiBaseUrl,
    controlApiServiceToken: externalConfig.controlApiServiceToken,
    jwtPrivateKey: producerConfig.sessionJwtPrivateKey,
  })
  children.push(child)
  return child.baseUrl
}

function producerResponseApp() {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/v1',
    requireInternalToken,
    createExternalInvitationsRouter(),
    createExternalUsersRouter({} as never)
  )
  return app
}

describe('invitation/password producer response mappings', () => {
  beforeAll(async () => {
    sessionToken = signExternalSessionToken({
      userId: preview.userId,
      email: preview.email,
      teamId: null,
      role: 'member',
      authGeneration: 1,
    })
    previousControlApiBaseUrl = externalConfig.controlApiBaseUrl
    previousControlApiServiceToken = externalConfig.controlApiServiceToken
    previousControlApiServiceName = externalConfig.controlApiServiceName
    producerServer = producerResponseApp().listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      producerServer.once('error', reject)
      producerServer.once('listening', resolve)
    })
    const address = producerServer.address()
    if (!address || typeof address === 'string') throw new Error('producer did not bind TCP')
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${address.port}/api/v1`
    externalConfig.controlApiServiceToken = internalServiceToken
    externalConfig.controlApiServiceName = 'external-rest-api'

    const producerBaseUrl = externalConfig.controlApiBaseUrl
    let droppedResetResponses = 0
    responseDropProxyServer = responseDropProxyApp(producerBaseUrl, () => {
      droppedResetResponses += 1
    }).listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      responseDropProxyServer.once('error', reject)
      responseDropProxyServer.once('listening', resolve)
    })
    const proxyAddress = responseDropProxyServer.address()
    if (!proxyAddress || typeof proxyAddress === 'string') {
      throw new Error('response-drop proxy did not bind TCP')
    }
    responseDropProxyPort = proxyAddress.port
    droppedResetResponsesForTest = () => droppedResetResponses
  })

  afterEach(async () => {
    const results = await Promise.allSettled(children.splice(0).map(child => child.stop()))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })

  afterAll(async () => {
    externalConfig.controlApiBaseUrl = previousControlApiBaseUrl
    externalConfig.controlApiServiceToken = previousControlApiServiceToken
    externalConfig.controlApiServiceName = previousControlApiServiceName
    if (producerServer) {
      producerServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        producerServer.close(error => (error ? reject(error) : resolve()))
      )
    }
    if (responseDropProxyServer) {
      responseDropProxyServer.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        responseDropProxyServer.close(error => (error ? reject(error) : resolve()))
      )
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    flow.validateInvitationFlowToken.mockImplementation(
      async (token: string, claimedEmail?: string) => {
        if (token !== 'r6-synthetic-reset-proof') throw new Error('invalid proof')
        if (claimedEmail && claimedEmail.toLowerCase() !== preview.email) {
          throw new Error('wrong email')
        }
        return { email: preview.email, invitationUuid: 'r6-producer-invitation-token' }
      }
    )
    directory.getInvitationByToken.mockResolvedValue(preview)
  })

  it.each([
    [
      'invalid password',
      { error: 'invalid_password' },
      400,
      { error: 'Password must be between 8 and 256 characters' },
    ],
    ['invalid proof', { error: 'invalid_invitation' }, 400, { error: 'invalid_invitation' }],
    ['retired member', { error: 'user_retired' }, 400, { error: 'invalid_invitation' }],
    [
      'wrong invitation binding',
      { error: 'forbidden' },
      403,
      { error: 'Invitation is invalid or unavailable' },
    ],
    ['missing invitation', { error: 'not_found' }, notFound.status, notFound.body],
    ['redeemed invitation', { error: 'not_pending' }, notPending.status, notPending.body],
    ['expired invitation', { error: 'expired' }, expired.status, expired.body],
  ])(
    'maps the producer %s domain response to the public contract',
    async (label, result, status, body) => {
      if (label === 'invalid proof') {
        flow.validateInvitationFlowToken.mockRejectedValue(new Error('invalid proof'))
      } else {
        directory.setInvitationPasswordForEmail.mockResolvedValue(result)
      }

      const response = await request(await publicApp())
        .post('/api/v1/invitations/password')
        .send({
          token: 'r6-synthetic-reset-proof',
          email: preview.email,
          invitationId: preview.id,
          password: 'R6-synthetic-valid-password',
        })

      expect(response.status).toBe(status)
      expect(response.body).toEqual(body)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toMatch(
        /r6-reset-proof|producer-invitation|sql|stack/i
      )
      if (label !== 'invalid proof') {
        expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
      } else {
        expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
      }
    }
  )

  it('preserves bounded admission responses from the real Control API route', async () => {
    directory.setInvitationPasswordForEmail.mockRejectedValueOnce(
      new PasswordAdmissionError(429, 17, 'verification_busy')
    )

    const response = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: 'R6-synthetic-valid-password',
      })

    expect(response.status).toBe(429)
    expect(response.body).toEqual({ error: 'rate_limited', retryAfterSeconds: 17 })
    expect(response.headers['retry-after']).toBe('17')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/verification_busy|r6-|sql|stack/i)
  })

  it('maps the exact producer empty-password payload rejection to sanitized public 400', async () => {
    const producerResponse = await request(producerServer)
      .post('/api/v1/external/invitations/password-token')
      .set('authorization', `Bearer ${internalServiceToken}`)
      .set('x-service-token', 'external-rest-api')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: '',
      })

    expect(producerResponse.status).toBe(400)
    expect(producerResponse.body).toEqual({ error: 'invalid_password' })
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()

    const missingInvitationId = await request(producerServer)
      .post('/api/v1/external/invitations/password-token')
      .set('authorization', `Bearer ${internalServiceToken}`)
      .set('x-service-token', 'external-rest-api')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        password: 'R6-synthetic-valid-password',
      })
    expect(missingInvitationId.status).toBe(400)
    expect(missingInvitationId.body).toEqual({ error: 'invalid payload' })

    const response = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .set('x-forwarded-for', '198.51.100.41')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: '',
      })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      error: 'Password must be between 8 and 256 characters',
    })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(
      /invalid payload|r6-|producer-invitation|sql|stack|password-token/i
    )
    expect(directory.getInvitationByToken).toHaveBeenCalledWith('r6-producer-invitation-token')
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'invalid password',
      invitationId: 'r6-accepted-member-row',
      password: 'short',
      serviceResult: { error: 'invalid_password' },
      producerStatus: 400,
      producerBody: { error: 'invalid_password' },
      publicStatus: 400,
      publicBody: { error: 'Password must be between 8 and 256 characters' },
    },
    {
      label: 'retired member',
      invitationId: 'r6-accepted-member-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'user_retired' },
      producerStatus: 401,
      producerBody: { error: 'user_retired' },
      publicStatus: notFound.status,
      publicBody: notFound.body,
    },
    {
      label: 'wrong member binding',
      invitationId: 'r6-accepted-member-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'forbidden' },
      producerStatus: 403,
      producerBody: { error: 'forbidden' },
      publicStatus: 403,
      publicBody: { error: 'Invitation is invalid or unavailable' },
    },
    {
      label: 'missing member invitation',
      invitationId: 'r6-accepted-member-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'not_found' },
      producerStatus: 404,
      producerBody: { error: 'not_found' },
      publicStatus: notFound.status,
      publicBody: notFound.body,
    },
    {
      label: 'invitation no longer accepted',
      invitationId: 'r6-accepted-member-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'not_accepted' },
      producerStatus: 409,
      producerBody: { error: 'invitation_not_accepted' },
      publicStatus: 409,
      publicBody: { error: 'Invitation must be accepted before setting a password' },
    },
    {
      label: 'reset invitation already used through authenticated setup',
      invitationId: 'r6-authenticated-reset-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'not_pending' },
      producerStatus: 409,
      producerBody: { error: 'invitation_not_pending' },
      publicStatus: notPending.status,
      publicBody: notPending.body,
    },
    {
      label: 'reset invitation expired through authenticated setup',
      invitationId: 'r6-authenticated-reset-row',
      password: 'R6-synthetic-valid-password',
      serviceResult: { error: 'expired' },
      producerStatus: 410,
      producerBody: { error: 'expired' },
      publicStatus: expired.status,
      publicBody: expired.body,
    },
  ])('maps the authenticated password-setup producer outcome: $label', async scenario => {
    directory.setInvitationPasswordForUser.mockResolvedValue(scenario.serviceResult)
    const producerPayload = {
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      invitationId: scenario.invitationId,
      password: scenario.password,
    }

    const producerResponse = await request(producerServer)
      .post('/api/v1/external/invitations/password')
      .set('authorization', `Bearer ${internalServiceToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', 'r6-synthetic-session')
      .send(producerPayload)

    expect(producerResponse.status).toBe(scenario.producerStatus)
    expect(producerResponse.body).toEqual(scenario.producerBody)
    expect(producerResponse.headers['retry-after']).toBeUndefined()
    expect(producerResponse.headers['set-cookie']).toBeUndefined()

    const response = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .set('authorization', `Bearer ${sessionToken}`)
      .set('x-forwarded-for', invitationContractClientIp())
      .send({ invitationId: scenario.invitationId, password: scenario.password })

    expect(response.status).toBe(scenario.publicStatus)
    expect(response.body).toEqual(scenario.publicBody)
    expect(response.headers['retry-after']).toBeUndefined()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(
      /r6-|example\.invalid|producer|sql|stack|password_hash|token/i
    )
    expect(directory.setInvitationPasswordForUser).toHaveBeenCalledWith(
      'r6-user',
      'r6-member@example.invalid',
      scenario.invitationId,
      scenario.password,
      undefined,
      { rejectIfPasswordAlreadySet: true }
    )
    expect(directory.setInvitationPasswordForUser).toHaveBeenCalledTimes(2)
    expect(directory.acceptInvitationForEmail).not.toHaveBeenCalled()
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
    expect(flow.validateInvitationFlowToken).not.toHaveBeenCalled()
    expect(desktopFlow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'busy password-work owner',
      error: new PasswordAdmissionError(429, 17, 'verification_busy'),
      producerStatus: 429,
      producerBody: { error: 'rate_limited', retryAfterSeconds: 17 },
      publicStatus: 429,
      publicBody: { error: 'rate_limited', retryAfterSeconds: 17 },
    },
    {
      label: 'unavailable password authority',
      error: new PasswordAdmissionError(503, 23, 'authority_failure'),
      producerStatus: 503,
      producerBody: { error: 'authority_unavailable', retryAfterSeconds: 23 },
      publicStatus: 503,
      publicBody: { error: 'authority_unavailable', retryAfterSeconds: 23 },
    },
  ])('preserves bounded $label responses for accepted-invitation setup', async scenario => {
    directory.setInvitationPasswordForUser.mockRejectedValue(scenario.error)
    const payload = {
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      invitationId: 'r6-accepted-member-row',
      password: 'R6-synthetic-valid-password',
    }

    const producerResponse = await request(producerServer)
      .post('/api/v1/external/invitations/password')
      .set('authorization', `Bearer ${internalServiceToken}`)
      .set('x-service-token', 'external-rest-api')
      .set('x-user-session-token', 'r6-synthetic-session')
      .send(payload)

    expect(producerResponse.status).toBe(scenario.producerStatus)
    expect(producerResponse.body).toEqual(scenario.producerBody)
    expect(producerResponse.headers['retry-after']).toBe(String(scenario.error.retryAfterSeconds))

    const response = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .set('authorization', `Bearer ${sessionToken}`)
      .set('x-forwarded-for', invitationContractClientIp())
      .send({ invitationId: payload.invitationId, password: payload.password })

    expect(response.status).toBe(scenario.publicStatus)
    expect(response.body).toEqual(scenario.publicBody)
    expect(response.headers['retry-after']).toBe(String(scenario.error.retryAfterSeconds))
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.stringify(response.body)).not.toMatch(
      /verification_busy|authority_failure|r6-|sql|stack/i
    )
    expect(directory.setInvitationPasswordForUser).toHaveBeenCalledTimes(2)
    expect(directory.acceptInvitationForEmail).not.toHaveBeenCalled()
    expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
  })

  it('completes a valid public reset through the real Control API producer route', async () => {
    directory.setInvitationPasswordForEmail.mockResolvedValueOnce({
      data: {
        id: preview.id,
        userId: preview.userId,
        email: preview.email,
        teamId: null,
        role: 'member',
        purpose: 'password_reset',
        status: 'accepted',
        lifecycleState: 'active',
        authGeneration: 7,
        passwordUpdated: true,
      },
    })

    const response = await request(await publicApp())
      .post('/api/v1/invitations/password-reset')
      .set('x-forwarded-for', '198.51.100.42')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: 'R6-synthetic-valid-password',
      })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      id: preview.id,
      userId: preview.userId,
      email: preview.email,
      purpose: 'password_reset',
      status: 'accepted',
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(response.body).not.toHaveProperty('token')
    expect(response.body).not.toHaveProperty('sessionContext')
    expect(String(response.headers['set-cookie'])).toContain('profile_session=;')
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly')

    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledWith(
      preview.email,
      preview.id,
      'R6-synthetic-valid-password'
    )
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
    expect(directory.getInvitationByToken).toHaveBeenCalledWith('r6-producer-invitation-token')
    expect(directory.getInvitationByToken).toHaveBeenCalledOnce()
    expect(directory.acceptInvitationForEmail).not.toHaveBeenCalled()
  })

  it('returns no session and sets no cookie from the reset producer', async () => {
    directory.setInvitationPasswordForEmail.mockResolvedValueOnce({
      data: {
        id: preview.id,
        userId: preview.userId,
        email: preview.email,
        teamId: null,
        role: 'member',
        purpose: 'password_reset',
        status: 'accepted',
        lifecycleState: 'active',
        authGeneration: 7,
        passwordUpdated: true,
        token: 'synthetic-producer-session-token',
        sessionContext: {
          userId: preview.userId,
          email: preview.email,
          teamId: null,
          role: 'member',
          authGeneration: 7,
        },
      },
    })

    const response = await request(producerServer)
      .post('/api/v1/external/invitations/password-token')
      .set('authorization', `Bearer ${internalServiceToken}`)
      .set('x-service-token', 'external-rest-api')
      .send({
        token: 'r6-synthetic-reset-proof',
        email: preview.email,
        invitationId: preview.id,
        password: 'R6-synthetic-valid-password',
      })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      userId: preview.userId,
      passwordUpdated: true,
      reauthenticationRequired: true,
    })
    expect(response.body).not.toHaveProperty('token')
    expect(response.body).not.toHaveProperty('sessionContext')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
  })

  it('keeps a dropped post-dispatch reset acknowledgement unknown and never retries it', async () => {
    const originalControlApiBaseUrl = externalConfig.controlApiBaseUrl
    externalConfig.controlApiBaseUrl = `http://127.0.0.1:${responseDropProxyPort}/api/v1`
    directory.setInvitationPasswordForEmail.mockResolvedValueOnce({
      data: {
        id: preview.id,
        userId: preview.userId,
        email: preview.email,
        teamId: null,
        role: 'member',
        purpose: 'password_reset',
        status: 'accepted',
        lifecycleState: 'active',
        authGeneration: 7,
        passwordUpdated: true,
      },
    })

    const response = await (async () => {
      try {
        return await request(await publicApp())
          .post('/api/v1/invitations/password-reset')
          .set('x-forwarded-for', '198.51.100.43')
          .send({
            token: 'r6-synthetic-reset-proof',
            email: preview.email,
            invitationId: preview.id,
            password: 'R6-synthetic-valid-password',
          })
      } finally {
        externalConfig.controlApiBaseUrl = originalControlApiBaseUrl
      }
    })()

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(response.headers['retry-after']).toBe('2')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/r6-|sql|stack|invalid_password/i)
    expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
    expect(directory.getInvitationByToken).toHaveBeenCalledWith('r6-producer-invitation-token')
    expect(directory.getInvitationByToken).toHaveBeenCalledOnce()
    expect(droppedResetResponsesForTest()).toBe(1)
  })

  it('maps a real producer password mismatch for desktop authorization', async () => {
    directory.verifyUserPassword.mockResolvedValueOnce(false)

    const response = await request(await publicApp())
      .post('/api/v1/invitations/desktop-authorization')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Invalid password' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/invalid_password|r6-|sql|stack/i)
    expect(directory.verifyUserPassword).toHaveBeenCalledWith({
      userId: 'r6-user',
      email: 'r6-member@example.invalid',
      password: 'R6-synthetic-current-password',
    })
    expect(desktopFlow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })

  it('maps an unavailable desktop-authorization producer to bounded public retry guidance', async () => {
    directory.verifyUserPassword.mockRejectedValueOnce(
      new PasswordAdmissionError(503, 23, 'authority_failure')
    )

    const response = await request(await publicApp())
      .post('/api/v1/invitations/desktop-authorization')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 23 })
    expect(response.headers['retry-after']).toBe('23')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(/authority_failure|r6-|sql|stack/i)
    expect(desktopFlow.storeDesktopAuthorizationToken).not.toHaveBeenCalled()
  })

  it('maps the producer desktop-registration not-found code without leaking details', async () => {
    directory.verifyUserPassword.mockResolvedValueOnce(true)
    desktopFlow.storeDesktopAuthorizationToken.mockRejectedValueOnce(
      new Error(
        'Member registration service POST /invitations-flow/desktop-authorizations failed (404): private'
      )
    )

    const response = await request(await publicApp())
      .post('/api/v1/invitations/desktop-authorization')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ password: 'R6-synthetic-current-password' })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Invitation setup not found' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toMatch(
      /desktop-authorization|private|r6-|sql|stack/i
    )
    expect(desktopFlow.storeDesktopAuthorizationToken).toHaveBeenCalledOnce()
  })
  it.each(['reset', 'accepted', 'desktop'] as const)(
    'maps actual internal-service authentication rejection for %s to sanitized outage',
    async operation => {
      const saved = producerConfig.internalServiceTokens['external-rest-api']
      if (operation === 'reset') {
        directory.getInvitationByToken.mockImplementationOnce(async () => {
          delete producerConfig.internalServiceTokens['external-rest-api']
          return preview
        })
      } else delete producerConfig.internalServiceTokens['external-rest-api']
      try {
        const endpoint = operation === 'desktop' ? 'desktop-authorization' : 'password'
        const payload =
          operation === 'reset'
            ? {
                token: 'r6-synthetic-reset-proof',
                email: preview.email,
                invitationId: preview.id,
                password: 'R6-synthetic-valid-password',
              }
            : operation === 'accepted'
              ? {
                  invitationId: 'r6-accepted-member-row',
                  password: 'R6-synthetic-valid-password',
                }
              : { password: 'R6-synthetic-valid-password' }
        const response = await request(await publicApp())
          .post(`/api/v1/invitations/${endpoint}`)
          .set('authorization', `Bearer ${sessionToken}`)
          .send(payload)
        expect(response.status).toBe(503)
        expect(response.body).toEqual({ error: 'authority_unavailable', retryAfterSeconds: 2 })
        expect(response.headers['retry-after']).toBe('2')
        expect(response.headers['set-cookie']).toBeUndefined()
        expect(JSON.stringify(response.body)).not.toMatch(
          /Unauthorized|api\/v1|r6-|example\.invalid/i
        )
        expect(directory.setInvitationPasswordForEmail).not.toHaveBeenCalled()
        expect(directory.setInvitationPasswordForUser).not.toHaveBeenCalled()
        expect(directory.verifyUserPassword).not.toHaveBeenCalled()
      } finally {
        producerConfig.internalServiceTokens['external-rest-api'] = saved
      }
    }
  )

  it.each([
    [
      'credential_changed',
      'Your password changed during this request. Sign in again with your new password.',
    ],
    ['password_not_set', 'Password is not set'],
  ])('preserves the real producer %s password-change guidance', async (error, message) => {
    directory.updateUserPassword.mockResolvedValue({ error })
    const response = await request(await publicApp())
      .put('/api/v1/me/password')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: message })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(directory.updateUserPassword).toHaveBeenCalledOnce()
  })

  it.each([
    [429, 9, 'rate_limited', 9],
    [503, 1200, 'authority_unavailable', 900],
  ])(
    'preserves producer authority %s retry bounds after real preview',
    async (status, retry, code, bounded) => {
      directory.setInvitationPasswordForEmail.mockRejectedValue(
        new PasswordAdmissionError(
          status as 429 | 503,
          retry,
          status === 429 ? 'verification_busy' : 'authority_failure'
        )
      )
      const response = await request(await publicApp())
        .post('/api/v1/invitations/password')
        .send({
          token: 'r6-synthetic-reset-proof',
          email: preview.email,
          invitationId: preview.id,
          password: 'R6-synthetic-valid-password',
        })
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code, retryAfterSeconds: bounded })
      expect(response.headers['retry-after']).toBe(String(bounded))
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toMatch(
        /diagnostic|verification_busy|authority_failure/i
      )
      expect(directory.getInvitationByToken).toHaveBeenCalledTimes(2)
      expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
    }
  )

  it.each(['html', 'invalid_payload', 'legacy_busy', 'legacy_unavailable'] as const)(
    'alters only %s after real preview and serialized successful producer completion',
    async resetFault => {
      directory.setInvitationPasswordForEmail.mockResolvedValue({
        data: {
          ...preview,
          status: 'accepted',
          role: 'member',
          passwordUpdated: true,
        },
      })
      let writes = 0
      const producerBaseUrl = externalConfig.controlApiBaseUrl
      const proxy = await listenOnLoopback(
        responseDropProxyApp(
          producerBaseUrl,
          () => {
            writes++
          },
          { resetFault }
        )
      )
      try {
        externalConfig.controlApiBaseUrl = `http://127.0.0.1:${listeningPort(proxy)}/api/v1`
        const response = await request(await publicApp())
          .post('/api/v1/invitations/password')
          .send({
            token: 'r6-synthetic-reset-proof',
            email: preview.email,
            invitationId: preview.id,
            password: 'R6-synthetic-valid-password',
          })
        if (resetFault === 'missing_session' || resetFault === 'empty_session') {
          expect(response.status).toBe(502)
          expect(response.body).toEqual({ error: 'Failed to restore account session' })
        } else if (resetFault === 'legacy_busy' || resetFault === 'legacy_unavailable') {
          const busy = resetFault === 'legacy_busy'
          expect(response.status).toBe(busy ? 429 : 503)
          expect(response.body).toEqual({
            error: busy ? 'rate_limited' : 'recovery_outcome_unknown',
            retryAfterSeconds: busy ? 9 : 2,
          })
          expect(response.headers['retry-after']).toBe(busy ? '9' : '2')
          expect(response.headers['x-ratelimit-remaining']).toBeUndefined()
          expect(JSON.stringify(response.body)).not.toMatch(
            /diagnostic|private Control API detail|verification_busy|authority_failure/i
          )
        } else {
          if (resetFault === 'html') {
            expect(response.status).toBe(503)
            expect(response.body).toEqual({
              error: 'recovery_outcome_unknown',
              retryAfterSeconds: 2,
            })
            expect(response.headers['retry-after']).toBe('2')
          } else {
            expect(response.status).toBe(502)
            expect(response.body).toEqual({
              error: 'Password recovery service returned an invalid response',
            })
            expect(response.headers['retry-after']).toBeUndefined()
          }
        }
        expect(response.headers['set-cookie']).toBeUndefined()
        expect(JSON.stringify(response.body)).not.toMatch(/r6-|gateway|sql|stack|connection reset/i)
        expect(writes).toBe(1)
        expect(directory.getInvitationByToken).toHaveBeenCalledTimes(2)
        expect(directory.setInvitationPasswordForEmail).toHaveBeenCalledOnce()
      } finally {
        externalConfig.controlApiBaseUrl = producerBaseUrl
        await closeLoopbackServer(proxy)
      }
    }
  )
})
