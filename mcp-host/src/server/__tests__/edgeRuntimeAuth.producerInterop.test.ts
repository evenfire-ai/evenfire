import { type MockInstance, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Request, type Response } from 'express'
import jwt from 'jsonwebtoken'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_ASSERTION_JWT_TYPE,
  HOST_EDGE_ASSERTION_V1_CLAIM_KEYS,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
  type HostEdgeRpcProxyScope,
} from '@clerum/action-context-contracts'
import type { RuntimeCallerContext } from '../types'

/**
 * The Host edge guard verifies assertions that control-api's V1 Host access route issued.
 * The producer is not copied: a `tsx` child mounts control-api's real router, signs a real
 * RPC access token, and prints the route's response. Hand-signed assertions stay in
 * `edgeRuntimeAuth.assertion.test.ts` for the invalid cases.
 */

const HOST_NAME = 'chatllm'
const OTHER_HOST_NAME = 'other-host'
const NAMESPACE = 'mcp-host'
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '99999999-9999-4999-8999-999999999999'
const TEAM = '22222222-2222-4222-8222-222222222222'
const OTHER_TEAM = '33333333-3333-4333-8333-333333333333'
const MESSAGE_SCOPE = HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['POST /v1/runtime/messages']
const STATUS_SCOPE = HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/status']
// The issued token lists the messages scope and not the status scope, so a status route refuses it.
const TOKEN_SCOPES = [MESSAGE_SCOPE, HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/sessions']]

type GuardModule = typeof import('../edgeRuntimeAuth')
type ConfigModule = typeof import('../../config')
type LoggerModule = typeof import('../../logger')
type LoadedHost = {
  guard: GuardModule
  config: ConfigModule['config']
  logger: LoggerModule['logger']
}

type ProducerInput = {
  accessScope: 'user' | 'team'
  teamId: string | null
}
type IssuedHostAccess = {
  userId: string
  hostRef: string
  url: string
  edgeAssertion: string
}
type SetupOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Setup, not behaviour under test: the control-api producer runs in a `tsx` child process.
// `beforeAll` runs it once per input and records its output or the error it failed with; a
// recorded error is rethrown by the test that needs that input.
const PRODUCER_CHILD_TIMEOUT_MS = 240_000
const userTokenInput: ProducerInput = { accessScope: 'user', teamId: null }
const teamTokenInput: ProducerInput = { accessScope: 'team', teamId: TEAM }
const producerInputs: readonly ProducerInput[] = [userTokenInput, teamTokenInput]
// One child limit per input, plus 120 s for the Host modules the hook imports.
const PRODUCER_SETUP_TIMEOUT_MS = producerInputs.length * PRODUCER_CHILD_TIMEOUT_MS + 120_000
const producerOutput = new Map<ProducerInput, SetupOutcome<IssuedHostAccess>>()
let host: LoadedHost

async function recordSetup<T>(run: () => T | Promise<T>): Promise<SetupOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error }
  }
}

function issued(input: ProducerInput): IssuedHostAccess {
  const outcome = producerOutput.get(input)
  if (!outcome) throw new Error('producer input was not set up in beforeAll')
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

function produceHostAccess(input: ProducerInput): IssuedHostAccess {
  const repositoryRoot = resolve(process.cwd(), '..')
  const stdout = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(repositoryRoot, 'control-api/test/fixtures/emitRpcHostAccessEdgeAssertionFixture.ts'),
      JSON.stringify({
        userId: USER,
        hostRef: HOST_NAME,
        accessScope: input.accessScope,
        teamId: input.teamId,
        scopes: TOKEN_SCOPES,
      }),
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: PRODUCER_CHILD_TIMEOUT_MS,
      env: { ...process.env, CONTROL_API_HOSTS_NAMESPACE: NAMESPACE },
    }
  )
  return JSON.parse(stdout) as IssuedHostAccess
}

/** Loads the guard, config and logger of a Host named `hostName`, in a fresh module graph. */
async function loadHost(hostName: string): Promise<LoadedHost> {
  const previous = {
    CLERUM_HOST_NAME: process.env.CLERUM_HOST_NAME,
    CLERUM_NAMESPACE: process.env.CLERUM_NAMESPACE,
  }
  process.env.CLERUM_HOST_NAME = hostName
  process.env.CLERUM_NAMESPACE = NAMESPACE
  try {
    vi.resetModules()
    const guard = await import('../edgeRuntimeAuth')
    const { logger } = await import('../../logger')
    const { config } = await import('../../config')
    return { guard, config, logger }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

beforeAll(async () => {
  for (const input of producerInputs) {
    producerOutput.set(input, await recordSetup(() => produceHostAccess(input)))
  }
  host = await loadHost(HOST_NAME)
}, PRODUCER_SETUP_TIMEOUT_MS)

const warnSpies: Array<MockInstance<LoggerModule['logger']['warn']>> = []
function spyOnWarn(target: LoadedHost) {
  const spy = vi.spyOn(target.logger, 'warn')
  warnSpies.push(spy)
  return spy
}

afterEach(() => {
  for (const spy of warnSpies.splice(0)) spy.mockRestore()
})

function refusalReasons(warn: MockInstance<LoggerModule['logger']['warn']>): unknown[] {
  return warn.mock.calls
    .map(([fields]) => fields as unknown as Record<string, unknown>)
    .filter(fields => fields?.event === 'runtime_edge_assertion_refused')
    .map(fields => fields.reason)
}

/** Sends one request through the real guard of `target`, registered with `scope`. */
async function probe(
  target: LoadedHost,
  headers: Record<string, string>,
  scope: HostEdgeRpcProxyScope = MESSAGE_SCOPE
) {
  const seen: RuntimeCallerContext[] = []
  const app = express()
  app.get(
    '/probe',
    target.guard.runtimeEdgeGuard(['rpc-proxy'], undefined, scope),
    (req: Request, res: Response) => {
      const caller = target.guard.getRuntimeCallerContext(req)!
      seen.push(caller)
      res.status(200).json({ userId: caller.userId ?? null, teamId: caller.teamId ?? null })
    }
  )
  const response = await request(app).get('/probe').set(headers)
  return { status: response.status, body: response.body, handlerCalls: seen.length }
}

function clearHeaders(
  assertion: string,
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': HOST_NAME,
    'x-clerum-edge-user-id': USER,
    [HOST_EDGE_ASSERTION_HEADER]: assertion,
    ...overrides,
  }
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

const INVALID = { error: 'Invalid runtime edge assertion' }

describe('Host edge guard and control-api issued assertions', () => {
  it('accepts the assertion issued for a user token with matching clear headers', async () => {
    const warn = spyOnWarn(host)
    const { edgeAssertion } = issued(userTokenInput)

    const accepted = await probe(host, clearHeaders(edgeAssertion))

    expect(accepted).toEqual({ status: 200, body: { userId: USER, teamId: null }, handlerCalls: 1 })
    expect(refusalReasons(warn)).toEqual([])
  })

  it('accepts the assertion issued for a team token with the team header', async () => {
    const warn = spyOnWarn(host)
    const { edgeAssertion } = issued(teamTokenInput)

    const accepted = await probe(
      host,
      clearHeaders(edgeAssertion, { 'x-clerum-edge-team-id': TEAM })
    )

    expect(accepted).toEqual({ status: 200, body: { userId: USER, teamId: TEAM }, handlerCalls: 1 })
    expect(refusalReasons(warn)).toEqual([])
  })

  it('issues the token in the form the Host verifies', () => {
    const { edgeAssertion, userId, hostRef } = issued(userTokenInput)
    expect({ userId, hostRef }).toEqual({ userId: USER, hostRef: HOST_NAME })

    const decoded = jwt.decode(edgeAssertion, { complete: true })
    expect(decoded?.header).toEqual({ alg: 'RS256', typ: HOST_EDGE_ASSERTION_JWT_TYPE })
    const payload = decoded?.payload as jwt.JwtPayload
    expect(Object.keys(payload).sort()).toEqual([...HOST_EDGE_ASSERTION_V1_CLAIM_KEYS].sort())
    expect(payload.host).toBe(`${host.config.namespace}/${host.config.hostName}`)
    expect(payload.iss).toBe(host.config.authJwtIssuer)
    expect(payload).toMatchObject({ v: 1, sub: USER, teamId: null, scopes: TOKEN_SCOPES })
  })

  it('refuses the issued assertion for another user, a mismatching team or a scope it does not list', async () => {
    const warn = spyOnWarn(host)
    const userAssertion = issued(userTokenInput).edgeAssertion
    const teamAssertion = issued(teamTokenInput).edgeAssertion

    // Witnesses: the same assertions reach the handler when the request matches them.
    expect((await probe(host, clearHeaders(userAssertion))).status).toBe(200)
    expect(
      (await probe(host, clearHeaders(teamAssertion, { 'x-clerum-edge-team-id': TEAM }))).status
    ).toBe(200)
    expect(refusalReasons(warn)).toEqual([])

    const refusals: Record<string, Awaited<ReturnType<typeof probe>>> = {
      'another user header': await probe(
        host,
        clearHeaders(userAssertion, { 'x-clerum-edge-user-id': OTHER_USER })
      ),
      'a team header on a user token': await probe(
        host,
        clearHeaders(userAssertion, { 'x-clerum-edge-team-id': TEAM })
      ),
      'another team header on a team token': await probe(
        host,
        clearHeaders(teamAssertion, { 'x-clerum-edge-team-id': OTHER_TEAM })
      ),
      'a route scope the token does not list': await probe(
        host,
        clearHeaders(userAssertion),
        STATUS_SCOPE
      ),
    }
    for (const [name, refused] of Object.entries(refusals)) {
      expect(refused, name).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    }
    expect(refusalReasons(warn)).toEqual(Object.keys(refusals).map(() => 'claims-rejected'))
  })

  it('refuses the issued assertion on a Host with another name', async () => {
    const { edgeAssertion } = issued(userTokenInput)
    // Witness: the Host the assertion was issued for accepts it.
    expect(await probe(host, clearHeaders(edgeAssertion))).toEqual({
      status: 200,
      body: { userId: USER, teamId: null },
      handlerCalls: 1,
    })

    const otherHost = await loadHost(OTHER_HOST_NAME)
    expect(otherHost.config.hostName).toBe(OTHER_HOST_NAME)
    const warn = spyOnWarn(otherHost)
    const refused = await probe(
      otherHost,
      clearHeaders(edgeAssertion, { 'x-clerum-edge-host-ref': OTHER_HOST_NAME })
    )

    expect(refused).toEqual({ status: 401, body: INVALID, handlerCalls: 0 })
    expect(refusalReasons(warn)).toEqual(['claims-rejected'])
  })
})
