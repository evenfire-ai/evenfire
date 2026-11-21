import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_AUDIENCE,
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import {
  ALL_HOST_EDGE_ROUTE_SCOPES,
  signHostEdgeTestAssertion,
} from '../../__tests__/rpcProxyEdgeTestHeaders'
import type { RuntimeCallerContext } from '../types'

const HOST_NAME = 'chatllm'
const NAMESPACE = 'mcp-host'
const HOST = `${NAMESPACE}/${HOST_NAME}`
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '99999999-9999-4999-8999-999999999999'
const TEAM = 'team-a'
const MESSAGE_SCOPE = HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['POST /v1/runtime/messages']

const envKeys = ['CLERUM_HOST_NAME', 'CLERUM_NAMESPACE', 'CLERUM_ENABLE_AUTH'] as const
const originalEnv = new Map<string, string | undefined>()

type GuardModule = typeof import('../edgeRuntimeAuth')
type ConfigModule = typeof import('../../config')
let guard: GuardModule
let runtimeConfig: ConfigModule['config']

beforeAll(async () => {
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.CLERUM_HOST_NAME = HOST_NAME
  process.env.CLERUM_NAMESPACE = NAMESPACE
  vi.resetModules()
  guard = await import('../edgeRuntimeAuth')
  runtimeConfig = (await import('../../config')).config
})

afterAll(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

function clearHeaders(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': HOST_NAME,
    'x-clerum-edge-user-id': USER,
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function assertion(overrides: Partial<Parameters<typeof signHostEdgeTestAssertion>[0]> = {}) {
  return signHostEdgeTestAssertion({ sub: USER, host: HOST, teamId: null, ...overrides })
}

/** A V2 action context built the way rpc-proxy builds it from an allowed checkpoint. */
function v2ActionContext(): string {
  const resource = canonicalResourceIdentity({
    environmentId: 'cluster.local/evenfire',
    type: 'host',
    logicalId: HOST,
    displayName: HOST_NAME,
  })
  const target = validateActionOperationTarget({
    operationId: 'chat.message.invoke',
    resource,
    operationTarget: {
      hostRef: HOST,
      channelType: 'rpc',
      channelId: HOST_NAME,
      messageId: '44444444-4444-4444-8444-444444444444',
    },
  })
  const unknown = { state: 'unknown' }
  const now = Date.now()
  const context = {
    version: 2,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    sessionVersion: 7,
    delegationJti: '33333333-3333-4333-8333-333333333333',
    operationId: 'chat.message.invoke',
    resource,
    target,
    targetHash: hashActionTarget(target),
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    behavior: {
      budget: unknown,
      credentialPolicy: unknown,
      approvalPolicy: unknown,
      filesystemScope: unknown,
      runtime: unknown,
      providerModelPolicy: unknown,
      audit: unknown,
    },
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
  }
  return Buffer.from(JSON.stringify(context), 'utf8').toString('base64url')
}

/** The V2 claims bound to `v2ActionContext()`, signed as control-api issues them. */
function v2Assertion(overrides: Record<string, unknown> = {}): string {
  const decoded = JSON.parse(Buffer.from(v2ActionContext(), 'base64url').toString('utf8'))
  return signHostEdgeTestAssertion({
    sub: USER,
    host: HOST,
    v: 2,
    claims: {
      teamId: undefined,
      scopes: undefined,
      operationId: decoded.operationId,
      delegationJti: decoded.delegationJti,
      sid: decoded.sid,
      sessionVersion: decoded.sessionVersion,
      accessPathId: decoded.accessPathId,
      pathKind: decoded.pathKind,
      effectiveTeamId: decoded.effectiveTeamId,
      resource: decoded.resource,
      targetHash: decoded.targetHash,
      authorizationRevision: decoded.authorizationRevision,
      behaviorBindingHash: decoded.behaviorBindingHash,
      checkedAt: decoded.checkedAt,
      ...overrides,
    },
  })
}

function probeApp() {
  const seen: RuntimeCallerContext[] = []
  const app = express()
  app.get(
    '/probe',
    guard.runtimeEdgeGuard(['rpc-proxy', 'channel-reader'], ['chat.message.invoke'], MESSAGE_SCOPE),
    (req: Request, res: Response) => {
      const caller = guard.getRuntimeCallerContext(req)!
      seen.push(caller)
      res.status(200).json({ userId: caller.userId ?? null, teamId: caller.teamId ?? null })
    }
  )
  return { app, seen }
}

async function probe(headers: Record<string, string>) {
  const { app, seen } = probeApp()
  const response = await request(app).get('/probe').set(headers)
  return { status: response.status, body: response.body, handlerCalls: seen.length }
}

/** Witness for a refusal row: the same clear request with a valid assertion reaches the handler. */
async function expectWitness(headers: Record<string, string>, teamId: string | null = null) {
  const accepted = await probe({
    ...headers,
    [HOST_EDGE_ASSERTION_HEADER]: assertion({
      sub: headers['x-clerum-edge-user-id'],
      teamId,
    }),
  })
  expect(accepted.status).toBe(200)
  expect(accepted.handlerCalls).toBe(1)
}

const MISSING = { error: 'Missing runtime edge assertion' }
const INVALID = { error: 'Invalid runtime edge assertion' }

describe('runtimeEdgeGuard rpc-proxy edge assertion', () => {
  it('accepts a valid V1 assertion bound to the user, team, Host and route scope', async () => {
    const userOnly = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion(),
    })
    expect(userOnly).toEqual({
      status: 200,
      body: { userId: USER, teamId: null },
      handlerCalls: 1,
    })

    const team = await probe({
      ...clearHeaders({ 'x-clerum-edge-team-id': TEAM }),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ teamId: TEAM }),
    })
    expect(team).toEqual({ status: 200, body: { userId: USER, teamId: TEAM }, handlerCalls: 1 })
  })

  it('refuses a request without an assertion before the handler runs', async () => {
    const refused = await probe(clearHeaders())
    expect(refused).toEqual({ status: 401, body: MISSING, handlerCalls: 0 })
    const blank = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: ' ' })
    expect(blank).toEqual({ status: 401, body: MISSING, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('refuses an assertion for another user than the clear header', async () => {
    const refused = await probe({
      ...clearHeaders({ 'x-clerum-edge-user-id': OTHER_USER }),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ sub: USER }),
    })
    expect(refused).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    await expectWitness(clearHeaders({ 'x-clerum-edge-user-id': OTHER_USER }))
  })

  it('refuses an assertion issued for another Host', async () => {
    for (const host of [`${NAMESPACE}/other-host`, `other-namespace/${HOST_NAME}`, HOST_NAME]) {
      const refused = await probe({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ host }),
      })
      expect(refused, host).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    }
    await expectWitness(clearHeaders())
  })

  it('refuses a team claim that differs from the team header', async () => {
    const cases: Array<{ claim: string | null; header?: string }> = [
      { claim: TEAM, header: 'team-b' },
      { claim: null, header: TEAM },
      { claim: TEAM },
    ]
    for (const { claim, header } of cases) {
      const refused = await probe({
        ...clearHeaders({ 'x-clerum-edge-team-id': header }),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ teamId: claim }),
      })
      expect(refused, JSON.stringify({ claim, header })).toEqual({
        status: 401,
        body: INVALID,
        handlerCalls: 0,
      })
    }
    await expectWitness(clearHeaders({ 'x-clerum-edge-team-id': TEAM }), TEAM)
  })

  it('refuses an expired assertion', async () => {
    const now = Math.floor(Date.now() / 1000)
    const refused = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ iat: now - 400, exp: now - 100 }),
    })
    expect(refused).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('refuses tokens of other families, foreign algorithms and foreign keys', async () => {
    const rpcPrivateKey = process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY!
    const foreignKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey
    const rpcAccessToken = jwt.sign(
      { sub: USER, typ: 'user', scopes: ALL_HOST_EDGE_ROUTE_SCOPES, accessScope: 'user' },
      rpcPrivateKey,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'rpc-proxy', expiresIn: 300 }
    )
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'host-edge-assertion+jwt' })).toString(
        'base64url'
      ),
      assertion().split('.')[1],
      '',
    ].join('.')
    const hs256 = jwt.sign(
      {
        typ: 'host_edge_assertion',
        v: 1,
        sub: USER,
        host: HOST,
        teamId: null,
        scopes: [MESSAGE_SCOPE],
      },
      // The classic confusion attack: the Host's public key used as an HMAC secret.
      Buffer.from(runtimeConfig.authJwtPublicKey),
      {
        algorithm: 'HS256',
        header: { alg: 'HS256', typ: 'host-edge-assertion+jwt' },
        audience: HOST_EDGE_ASSERTION_AUDIENCE,
        issuer: 'control-api',
        jwtid: randomUUID(),
        expiresIn: 300,
      }
    )
    const tokens: Record<string, string> = {
      'RPC access token': rpcAccessToken,
      'admission receipt type header': assertion({ headerType: 'host-message-admission+jwt' }),
      'no type header': assertion({ headerType: 'JWT' }),
      'foreign audience': assertion({ audience: 'rpc-proxy' }),
      'foreign key': assertion({ privateKey: foreignKey }),
      'alg none': unsigned,
      HS256: hs256,
      'not a JWT': 'not-a-jwt',
    }
    for (const [name, token] of Object.entries(tokens)) {
      const refused = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: token })
      expect(refused, name).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    }
    await expectWitness(clearHeaders())
  })

  it('refuses malformed claim sets the contract validator rejects', async () => {
    const now = Math.floor(Date.now() / 1000)
    const tokens: Record<string, string> = {
      'extra claim': assertion({ claims: { role: 'admin' } }),
      'missing scopes': assertion({ claims: { scopes: undefined } }),
      'lifetime above 300 s': assertion({ iat: now, exp: now + 301 }),
      'empty scopes': assertion({ scopes: [] }),
    }
    for (const [name, token] of Object.entries(tokens)) {
      const refused = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: token })
      expect(refused, name).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    }
    await expectWitness(clearHeaders())
  })

  it('refuses an issuer other than the Host verifier issuer', async () => {
    const refused = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ issuer: 'another-issuer' }),
    })
    expect(refused).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('accepts an iat ahead of the Host clock while the lifetime bound holds', async () => {
    const ahead = Math.floor(Date.now() / 1000) + 60
    const accepted = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ iat: ahead, exp: ahead + 300 }),
    })
    expect(accepted).toEqual({ status: 200, body: { userId: USER, teamId: null }, handlerCalls: 1 })
  })

  it('refuses duplicated assertion headers joined by Node', async () => {
    const { app, seen } = probeApp()
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const { port } = server.address() as AddressInfo
    const send = (assertions: string[]) =>
      new Promise<number>((resolve, reject) => {
        // A raw header list replaces the defaults, so it names Host itself:
        // the Node server refuses an HTTP/1.1 request without one.
        const raw: string[] = ['host', `127.0.0.1:${port}`]
        for (const [name, value] of Object.entries(clearHeaders())) raw.push(name, value)
        for (const value of assertions) raw.push(HOST_EDGE_ASSERTION_HEADER, value)
        const req = http.request(
          { host: '127.0.0.1', port, path: '/probe', method: 'GET', headers: raw },
          res => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          }
        )
        req.on('error', reject)
        req.end()
      })
    try {
      const valid = assertion()
      expect(await send([valid, valid])).toBe(401)
      expect(seen).toHaveLength(0)
      expect(await send([valid])).toBe(200)
      expect(seen).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('refuses a V2 action context without an assertion as a missing assertion', async () => {
    const refused = await probe({
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': HOST_NAME,
      'x-clerum-edge-action-context': v2ActionContext(),
    })
    expect(refused).toEqual({ status: 401, body: MISSING, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('refuses every V2 request, with a matching or a mismatching V2 assertion', async () => {
    const v2Headers = {
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': HOST_NAME,
      'x-clerum-edge-action-context': v2ActionContext(),
    }
    const matching = await probe({ ...v2Headers, [HOST_EDGE_ASSERTION_HEADER]: v2Assertion() })
    expect(matching).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    const mismatching = await probe({
      ...v2Headers,
      [HOST_EDGE_ASSERTION_HEADER]: v2Assertion({ sessionVersion: 8 }),
    })
    expect(mismatching).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('refuses an assertion whose version does not match the request path', async () => {
    const v2OnV1 = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: v2Assertion() })
    expect(v2OnV1).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    const v1WithV2Context = await probe({
      'x-clerum-edge-caller': 'rpc-proxy',
      'x-clerum-edge-host-ref': HOST_NAME,
      'x-clerum-edge-action-context': v2ActionContext(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion(),
    })
    expect(v1WithV2Context).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    await expectWitness(clearHeaders())
  })

  it('refuses every assertion on a Host without a verification key', async () => {
    const configuredKey = runtimeConfig.authJwtPublicKey
    const configuredAuth = runtimeConfig.enableAuth
    try {
      runtimeConfig.authJwtPublicKey = ''
      const noKey = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: assertion() })
      expect(noKey).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
      runtimeConfig.enableAuth = false
      const authOff = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: assertion() })
      expect(authOff).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    } finally {
      runtimeConfig.authJwtPublicKey = configuredKey
      runtimeConfig.enableAuth = configuredAuth
    }
    await expectWitness(clearHeaders())
  })

  it('keeps the channel-reader caller path without an assertion', async () => {
    const reader = await probe({
      'x-clerum-edge-caller': 'channel-reader',
      'x-clerum-edge-host-ref': HOST_NAME,
      'x-clerum-edge-channel-type': 'telegram',
      'x-clerum-edge-channel-id': 'chat-1',
      'x-clerum-edge-sender': 'telegram-user',
    })
    expect(reader.status).toBe(200)
    expect(reader.handlerCalls).toBe(1)
  })

  it('keeps the Authorization refusal ahead of the assertion check', async () => {
    const refused = await probe({
      ...clearHeaders(),
      authorization: 'Bearer anything',
      [HOST_EDGE_ASSERTION_HEADER]: assertion(),
    })
    expect(refused).toEqual({
      status: 401,
      body: { error: 'Authorization is not accepted on this direct mcp-host runtime route' },
      handlerCalls: 0,
    })
    await expectWitness(clearHeaders())
  })

  it('refuses an assertion without the route scope through the real guard', async () => {
    const refused = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({
        scopes: [HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/status']],
      }),
    })
    expect(refused).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    const accepted = await probe({
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ scopes: [MESSAGE_SCOPE] }),
    })
    expect(accepted.status).toBe(200)
    expect(accepted.handlerCalls).toBe(1)
  })
})

describe('mounted Host routes behind the edge assertion', () => {
  type Mounted = { baseUrl: string; stop: () => Promise<void> }
  async function mount(
    configure: (server: InstanceType<typeof import('../../server').RPCServer>) => void
  ): Promise<Mounted> {
    process.env.CLERUM_ENABLE_AUTH = 'true'
    vi.resetModules()
    const { RPCServer } = await import('../../server')
    const server = new RPCServer(0)
    configure(server)
    await server.start()
    const address = (
      server as unknown as { server: { address: () => AddressInfo } }
    ).server.address()
    return { baseUrl: `http://127.0.0.1:${address.port}`, stop: () => server.stop() }
  }

  it('rebuilds V1 message metadata from the verified caller, discarding body keys', async () => {
    const messageHandler = vi.fn().mockResolvedValue({ success: true, taskId: 'task-1' })
    const mounted = await mount(server => server.onMessage(messageHandler))
    const send = (headers: Record<string, string>) =>
      fetch(`${mounted.baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          sender: USER,
          channelType: 'rpc',
          channelId: HOST_NAME,
          threadId: 'chat-1',
          content: 'hello',
          timestamp: new Date().toISOString(),
          messageId: 'm1',
          hostRef: HOST_NAME,
          metadata: {
            teamId: 'other-team',
            budget: { limit: 1_000_000 },
            credentialPolicy: 'shared',
          },
        }),
      })
    try {
      const userScoped = await send({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion(),
      })
      expect(userScoped.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(1)
      expect(messageHandler.mock.calls[0][0].metadata).toEqual({ accessScope: 'user' })

      const teamScoped = await send({
        ...clearHeaders({ 'x-clerum-edge-team-id': TEAM }),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ teamId: TEAM }),
      })
      expect(teamScoped.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(2)
      expect(messageHandler.mock.calls[1][0].metadata).toEqual({
        accessScope: 'team',
        teamId: TEAM,
      })
    } finally {
      await mounted.stop()
    }
  })
})
