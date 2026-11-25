import {
  type MockInstance,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
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
type LoggerModule = typeof import('../../logger')
let guard: GuardModule
let runtimeConfig: ConfigModule['config']
// Bound to the module graph `guard` was loaded from, so a spy on it sees the guard's calls.
let loggerModule: LoggerModule

beforeAll(async () => {
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.CLERUM_HOST_NAME = HOST_NAME
  process.env.CLERUM_NAMESPACE = NAMESPACE
  vi.resetModules()
  guard = await import('../edgeRuntimeAuth')
  loggerModule = await import('../../logger')
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

  it('refuses an iat more than the allowed skew ahead of the Host clock', async () => {
    const now = Math.floor(Date.now() / 1000)
    for (const [name, ahead] of [
      ['60 seconds ahead', now + 60],
      ['one year ahead', now + 31_536_000],
    ] as const) {
      const refused = await probe({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ iat: ahead, exp: ahead + 300 }),
      })
      expect(refused, name).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    }
    await expectWitness(clearHeaders())
  })

  it('accepts an iat up to 5 seconds ahead of the Host clock', async () => {
    // The Host reads its clock after this one, so the skew it sees is 5 seconds or less.
    const ahead = Math.floor(Date.now() / 1000) + 5
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

describe('runtimeEdgeGuard logs each refused edge assertion', () => {
  const REFUSAL_MESSAGE = '[Server] Refused rpc-proxy edge assertion'
  // Captured from the environment the Host config reads, never from `runtimeConfig`,
  // which the blank-key row empties.
  const pem = process.env.CLERUM_AUTH_JWT_PUBLIC_KEY ?? ''
  let warn: MockInstance<LoggerModule['logger']['warn']>

  beforeEach(() => {
    warn = vi.spyOn(loggerModule.logger, 'warn')
  })

  afterEach(() => {
    warn.mockRestore()
  })

  const v2Headers = () => ({
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': HOST_NAME,
    'x-clerum-edge-action-context': v2ActionContext(),
  })
  const expired = () => {
    const now = Math.floor(Date.now() / 1000)
    return assertion({ iat: now - 400, exp: now - 100 })
  }
  const foreignKey = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey

  const rows: Array<{
    name: string
    headers: () => Record<string, string>
    body: typeof MISSING
    fields: Record<string, string>
    withoutVerificationKey?: true
  }> = [
    {
      name: 'no header',
      headers: () => clearHeaders(),
      body: MISSING,
      fields: { reason: 'missing' },
    },
    {
      name: 'blank header',
      headers: () => ({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: ' ' }),
      body: MISSING,
      fields: { reason: 'missing' },
    },
    {
      name: 'V2 context without an assertion',
      headers: v2Headers,
      body: MISSING,
      fields: { reason: 'missing' },
    },
    {
      name: 'V2 context with an assertion',
      headers: () => ({ ...v2Headers(), [HOST_EDGE_ASSERTION_HEADER]: v2Assertion() }),
      body: INVALID,
      fields: { reason: 'v2-refused' },
    },
    {
      name: 'Host without a verification key',
      headers: () => ({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: assertion() }),
      body: INVALID,
      fields: { reason: 'no-verification-key' },
      withoutVerificationKey: true,
    },
    {
      name: 'foreign key',
      headers: () => ({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ privateKey: foreignKey() }),
      }),
      body: INVALID,
      fields: { reason: 'verify-failed', errorName: 'JsonWebTokenError' },
    },
    {
      name: 'expired assertion',
      headers: () => ({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: expired() }),
      body: INVALID,
      fields: { reason: 'verify-failed', errorName: 'TokenExpiredError' },
    },
    {
      name: 'other issuer',
      headers: () => ({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ issuer: 'another-issuer' }),
      }),
      body: INVALID,
      fields: { reason: 'verify-failed', errorName: 'JsonWebTokenError' },
    },
    {
      name: 'wrong JWT typ header',
      headers: () => ({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ headerType: 'JWT' }),
      }),
      body: INVALID,
      fields: { reason: 'typ-mismatch' },
    },
    {
      name: 'other user',
      headers: () => ({
        ...clearHeaders({ 'x-clerum-edge-user-id': OTHER_USER }),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ sub: USER }),
      }),
      body: INVALID,
      fields: { reason: 'claims-rejected', claimError: 'sub mismatch' },
    },
    {
      name: 'other Host',
      headers: () => ({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ host: `${NAMESPACE}/other-host` }),
      }),
      body: INVALID,
      fields: { reason: 'claims-rejected', claimError: 'host mismatch' },
    },
    {
      name: 'other team',
      headers: () => ({
        ...clearHeaders({ 'x-clerum-edge-team-id': 'team-b' }),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({ teamId: TEAM }),
      }),
      body: INVALID,
      fields: { reason: 'claims-rejected', claimError: 'teamId mismatch' },
    },
    {
      name: 'route scope absent',
      headers: () => ({
        ...clearHeaders(),
        [HOST_EDGE_ASSERTION_HEADER]: assertion({
          scopes: [HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/status']],
        }),
      }),
      body: INVALID,
      fields: { reason: 'claims-rejected', claimError: 'route scope missing' },
    },
    {
      name: 'iat in the future',
      headers: () => {
        const ahead = Math.floor(Date.now() / 1000) + 60
        return {
          ...clearHeaders(),
          [HOST_EDGE_ASSERTION_HEADER]: assertion({ iat: ahead, exp: ahead + 300 }),
        }
      },
      body: INVALID,
      fields: { reason: 'claims-rejected', claimError: 'iat is in the future' },
    },
  ]

  for (const row of rows) {
    it(`logs one refusal with its reason: ${row.name}`, async () => {
      const headers = row.headers()
      const configuredKey = runtimeConfig.authJwtPublicKey
      let refused: Awaited<ReturnType<typeof probe>>
      try {
        if (row.withoutVerificationKey) runtimeConfig.authJwtPublicKey = ''
        refused = await probe(headers)
      } finally {
        runtimeConfig.authJwtPublicKey = configuredKey
      }
      expect(refused).toEqual({ status: 401, body: row.body, handlerCalls: 0 })

      const expected = {
        event: 'runtime_edge_assertion_refused',
        scope: MESSAGE_SCOPE,
        ...row.fields,
      }
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]).toEqual([expected, REFUSAL_MESSAGE])
      // The logger redacts by key: every logged key must survive it.
      expect(loggerModule.redactUnknown(warn.mock.calls[0][0])).toEqual(expected)

      // Liveness witness for the absence checks below: the call asserted above.
      const logged = JSON.stringify(warn.mock.calls)
      const token = headers[HOST_EDGE_ASSERTION_HEADER]
      if (token !== undefined && token.trim() !== '') expect(logged).not.toContain(token)
      expect(logged).not.toContain(USER)
      expect(logged).not.toContain(OTHER_USER)
      expect(pem).toContain('BEGIN PUBLIC KEY')
      expect(logged).not.toContain(JSON.stringify(pem).slice(1, -1))
    })
  }

  it('logs nothing for an accepted assertion', async () => {
    const accepted = await probe({ ...clearHeaders(), [HOST_EDGE_ASSERTION_HEADER]: assertion() })
    expect(accepted).toEqual({ status: 200, body: { userId: USER, teamId: null }, handlerCalls: 1 })
    expect(warn).not.toHaveBeenCalled()
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

  it('refuses a first-message approvalMode without host:approval:write in the verified assertion', async () => {
    const APPROVAL_SCOPE =
      HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['PATCH /v1/runtime/sessions/:agent/:chatId/approval-mode']
    expect(APPROVAL_SCOPE).toBe('host:approval:write')
    const messageHandler = vi.fn().mockResolvedValue({ success: true, taskId: 'task-1' })
    const mounted = await mount(server => server.onMessage(messageHandler))
    const send = (scopes: readonly string[], approvalMode?: string) =>
      fetch(`${mounted.baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...clearHeaders(),
          [HOST_EDGE_ASSERTION_HEADER]: assertion({ scopes }),
        },
        body: JSON.stringify({
          sender: USER,
          channelType: 'rpc',
          channelId: HOST_NAME,
          threadId: 'chat-1',
          content: 'hello',
          timestamp: new Date().toISOString(),
          messageId: randomUUID(),
          hostRef: HOST_NAME,
          ...(approvalMode === undefined ? {} : { approvalMode }),
        }),
      })
    try {
      const allowAll = await send([MESSAGE_SCOPE], 'allow_all')
      expect(allowAll.status).toBe(403)
      expect(await allowAll.json()).toEqual({ error: 'Forbidden: missing scope' })
      expect(messageHandler).toHaveBeenCalledTimes(0)

      // The scope is checked on the key, before the value.
      const invalidMode = await send([MESSAGE_SCOPE], 'not-a-mode')
      expect(invalidMode.status).toBe(403)
      expect(await invalidMode.json()).toEqual({ error: 'Forbidden: missing scope' })
      expect(messageHandler).toHaveBeenCalledTimes(0)

      // Witness: the same route, guard and handler reach the message handler without the key.
      const noMode = await send([MESSAGE_SCOPE])
      expect(noMode.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(1)
      expect(
        Object.prototype.hasOwnProperty.call(messageHandler.mock.calls[0][0], 'approvalMode')
      ).toBe(false)

      // Witness: with the approval-mode scope in the assertion the mode is forwarded.
      const granted = await send([MESSAGE_SCOPE, APPROVAL_SCOPE], 'allow_all')
      expect(granted.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(2)
      expect(messageHandler.mock.calls.at(-1)?.[0].approvalMode).toBe('allow_all')
    } finally {
      await mounted.stop()
    }
  })

  it('refuses direct session search without declared V2 authority', async () => {
    const search = vi.fn().mockResolvedValue({ results: [], total: 0 })
    const sessionsList = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null })
    const mounted = await mount(server => {
      server.onSessionSearch(search)
      server.onSessionsList(sessionsList)
    })
    const rpcToken = jwt.sign(
      { sub: USER, typ: 'user', scopes: ['host:session:read'], hostRefs: [HOST_NAME] },
      process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY!,
      { algorithm: 'RS256', issuer: 'control-api', audience: 'rpc-proxy', expiresIn: 300 }
    )
    const v1Headers = {
      ...clearHeaders(),
      [HOST_EDGE_ASSERTION_HEADER]: assertion({ scopes: ['host:session:read'] }),
    }
    try {
      const bearer = await fetch(`${mounted.baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: { authorization: `Bearer ${rpcToken}` },
      })
      expect(bearer.status).toBe(401)
      expect(await bearer.json()).toEqual({ error: 'V2 runtime authority required' })

      const v1 = await fetch(`${mounted.baseUrl}/v1/runtime/sessions/search?q=budget`, {
        headers: v1Headers,
      })
      expect(v1.status).toBe(401)
      expect(await v1.json()).toEqual({ error: 'V2 runtime authority required' })
      expect(search).not.toHaveBeenCalled()

      const list = await fetch(`${mounted.baseUrl}/v1/runtime/sessions`, { headers: v1Headers })
      expect(list.status).toBe(200)
      expect(sessionsList).toHaveBeenCalledTimes(1)
    } finally {
      await mounted.stop()
    }
  })

  it('lists pending approvals of every user in status only by their start time', async () => {
    const { pendingApprovalsForStatus } = await import('../statusProjection')
    const since = ['2026-11-21T10:00:00.000Z', '2026-11-21T10:05:00.000Z']
    const agent = {
      getPendingApprovals: vi.fn(() => [
        {
          requestId: 'request-of-user',
          userId: USER,
          toolName: 'shell',
          parameters: { command: 'ls' },
          description: 'List files',
          since: since[0],
        },
        {
          requestId: 'request-of-other-user',
          userId: OTHER_USER,
          toolName: 'send_email',
          parameters: { to: 'someone' },
          description: 'Send an email',
          since: since[1],
          reason: 'connect_required' as const,
          mcpServerName: 'mail',
        },
      ]),
    }
    const mounted = await mount(server =>
      server.onStatus(async () => ({
        agent: {
          state: 'waiting_approval',
          currentTaskId: null,
          tasksProcessed: 0,
          tasksSucceeded: 0,
          tasksFailed: 0,
          uptime: 1,
        },
        queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
        cronJobs: 0,
        pendingApprovals: pendingApprovalsForStatus(agent),
      }))
    )
    try {
      const response = await fetch(`${mounted.baseUrl}/v1/runtime/status`, {
        headers: {
          ...clearHeaders(),
          [HOST_EDGE_ASSERTION_HEADER]: assertion({ scopes: ['host:status:read'] }),
        },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        agent: { state: string }
        pendingApprovals: Array<Record<string, unknown>>
      }
      expect(body.agent.state).toBe('waiting_approval')
      expect(agent.getPendingApprovals).toHaveBeenCalledTimes(1)
      expect(body.pendingApprovals).toHaveLength(2)
      expect(body.pendingApprovals).toEqual(since.map(value => ({ since: value })))
    } finally {
      await mounted.stop()
    }
  })
})
