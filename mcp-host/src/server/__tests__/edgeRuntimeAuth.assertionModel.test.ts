import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express, { type Request, type Response } from 'express'
import fc from 'fast-check'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_ASSERTION_MAX_TTL_SECONDS,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
} from '@clerum/action-context-contracts'
import { signHostEdgeTestAssertion } from '../../__tests__/rpcProxyEdgeTestHeaders'

// Model-based check of the rpc-proxy edge assertion on the real runtime edge
// guard: random command sequences build a request (assertion, clear headers,
// clock), and after each command the Host verdict must equal the verdict of a
// reference model that accepts only a single V1 assertion bound to the clear
// user, the clear team and this Host, inside its lifetime.

const HOST_NAME = 'chatllm'
const NAMESPACE = 'mcp-host'
const THIS_HOST = `${NAMESPACE}/${HOST_NAME}`
const OTHER_HOST = `${NAMESPACE}/other-host`
const USERS = ['11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999']
const TEAMS: Array<string | null> = [null, 'team-a', 'team-b']
const MESSAGE_SCOPE = HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['POST /v1/runtime/messages']

type Issued = {
  token: string
  v: 1 | 2
  sub: string
  teamId: string | null
  host: string
  exp: number
}
type Model = {
  nowMs: number
  user: string
  teamId: string | null
  assertion: Issued | null
  duplicated: boolean
}
type Real = { baseUrl: string; handlerCalls: () => number }
type Verdict = { status: number; body: unknown }

const MISSING: Verdict = { status: 401, body: { error: 'Missing runtime edge assertion' } }
const INVALID: Verdict = { status: 401, body: { error: 'Invalid runtime edge assertion' } }

function expected(model: Model): Verdict {
  const a = model.assertion
  if (!a) return MISSING
  const accepted =
    !model.duplicated &&
    a.v === 1 &&
    a.sub === model.user &&
    a.teamId === model.teamId &&
    a.host === THIS_HOST &&
    Math.floor(model.nowMs / 1000) < a.exp
  return accepted ? { status: 200, body: { userId: model.user, teamId: model.teamId } } : INVALID
}

function issue(model: Model, v: 1 | 2, host: string): Issued {
  const iat = Math.floor(model.nowMs / 1000)
  const exp = iat + HOST_EDGE_ASSERTION_MAX_TTL_SECONDS
  const token = signHostEdgeTestAssertion({
    sub: model.user,
    host,
    teamId: model.teamId,
    scopes: [MESSAGE_SCOPE],
    v,
    iat,
    exp,
  })
  return { token, v, sub: model.user, teamId: model.teamId, host, exp }
}

function send(real: Real, model: Model): Promise<Verdict> {
  const { port } = new URL(real.baseUrl)
  const raw: string[] = [
    'host',
    `127.0.0.1:${port}`,
    'x-clerum-edge-caller',
    'rpc-proxy',
    'x-clerum-edge-host-ref',
    HOST_NAME,
    'x-clerum-edge-user-id',
    model.user,
  ]
  if (model.teamId !== null) raw.push('x-clerum-edge-team-id', model.teamId)
  if (model.assertion) {
    raw.push(HOST_EDGE_ASSERTION_HEADER, model.assertion.token)
    if (model.duplicated) raw.push(HOST_EDGE_ASSERTION_HEADER, model.assertion.token)
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), path: '/probe', method: 'GET', headers: raw },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

abstract class Step implements fc.AsyncCommand<Model, Real> {
  abstract apply(model: Model): void
  abstract toString(): string
  check(_model: Readonly<Model>): boolean {
    return true
  }
  async run(model: Model, real: Real): Promise<void> {
    this.apply(model)
    clockMs = model.nowMs
    const before = real.handlerCalls()
    const want = expected(model)
    const got = await send(real, model)
    expect(got).toEqual(want)
    verdictCounts[got.status === 200 ? 'accepted' : 'refused'] += 1
    // At rest the handler ran exactly when the model accepted.
    expect(real.handlerCalls() - before).toBe(want.status === 200 ? 1 : 0)
  }
}

class IssueAssertion extends Step {
  constructor(private readonly v: 1 | 2) {
    super()
  }
  apply(model: Model) {
    model.assertion = issue(model, this.v, THIS_HOST)
    model.duplicated = false
  }
  toString() {
    return `issue V${this.v}`
  }
}

class MutateClearUser extends Step {
  apply(model: Model) {
    model.user = USERS.find(user => user !== model.user)!
  }
  toString() {
    return 'mutate clear user header'
  }
}

class MutateTeam extends Step {
  constructor(private readonly teamId: string | null) {
    super()
  }
  apply(model: Model) {
    model.teamId = this.teamId
  }
  toString() {
    return `mutate team context to ${String(this.teamId)}`
  }
}

class SwapHostIdentity extends Step {
  check(model: Readonly<Model>) {
    return model.assertion !== null
  }
  apply(model: Model) {
    const current = model.assertion!
    model.assertion = issue(
      { ...model, user: current.sub, teamId: current.teamId },
      current.v,
      current.host === THIS_HOST ? OTHER_HOST : THIS_HOST
    )
  }
  toString() {
    return 'swap Host identity'
  }
}

class AdvancePastExpiry extends Step {
  apply(model: Model) {
    model.nowMs += (HOST_EDGE_ASSERTION_MAX_TTL_SECONDS + 1) * 1000
  }
  toString() {
    return 'advance clock past exp'
  }
}

class DropAssertion extends Step {
  apply(model: Model) {
    model.assertion = null
    model.duplicated = false
  }
  toString() {
    return 'drop the assertion header'
  }
}

class DuplicateAssertion extends Step {
  check(model: Readonly<Model>) {
    return model.assertion !== null
  }
  apply(model: Model) {
    model.duplicated = true
  }
  toString() {
    return 'duplicate the assertion header'
  }
}

const envKeys = ['CLERUM_HOST_NAME', 'CLERUM_NAMESPACE'] as const
const originalEnv = new Map<string, string | undefined>()
let server: http.Server
let real: Real
let clockMs = 0
const verdictCounts = { accepted: 0, refused: 0 }

beforeAll(async () => {
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.CLERUM_HOST_NAME = HOST_NAME
  process.env.CLERUM_NAMESPACE = NAMESPACE
  vi.resetModules()
  const guard = await import('../edgeRuntimeAuth')
  let calls = 0
  const app = express()
  app.get(
    '/probe',
    guard.runtimeEdgeGuard(['rpc-proxy'], ['chat.message.invoke'], MESSAGE_SCOPE),
    (req: Request, res: Response) => {
      calls += 1
      const caller = guard.getRuntimeCallerContext(req)!
      res.status(200).json({ userId: caller.userId, teamId: caller.teamId ?? null })
    }
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  real = { baseUrl: `http://127.0.0.1:${port}`, handlerCalls: () => calls }
  // The Host and the signer read one clock that only the model moves.
  vi.spyOn(Date, 'now').mockImplementation(() => clockMs)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

describe('rpc-proxy edge assertion model', () => {
  it('matches the reference model on every command sequence', async () => {
    const startMs = new Date('2026-11-21T12:00:00.000Z').getTime()
    const commands = [
      fc.constantFrom(1 as const, 2 as const).map(v => new IssueAssertion(v)),
      fc.constant(new MutateClearUser()),
      fc.constantFrom(...TEAMS).map(teamId => new MutateTeam(teamId)),
      fc.constant(new SwapHostIdentity()),
      fc.constant(new AdvancePastExpiry()),
      fc.constant(new DropAssertion()),
      fc.constant(new DuplicateAssertion()),
    ]
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 12 }), async cmds => {
        const model: Model = {
          nowMs: startMs,
          user: USERS[0]!,
          teamId: null,
          assertion: null,
          duplicated: false,
        }
        await fc.asyncModelRun(() => ({ model, real }), cmds)
      }),
      { numRuns: 60 }
    )
    // Witness: the requests reached both verdicts.
    expect(verdictCounts.accepted).toBeGreaterThan(0)
    expect(verdictCounts.refused).toBeGreaterThan(0)
  })
})
