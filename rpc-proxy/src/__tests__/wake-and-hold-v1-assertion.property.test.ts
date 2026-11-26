import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import fc from 'fast-check'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import {
  type GateAnswer,
  emitGateAnswers,
  gateAnswer,
  responseFromGateAnswer,
} from '../../test/support/internalServiceGateAnswers.js'
import { producerBudgetMs } from '../../test/support/producerChild.js'
import { config } from '../config.js'
import { requestHostWakeFromControlApi } from '../services/controlApiRestService.js'
import { isHostResolveRefusal, respondHostResolveRefusal } from '../services/hostAccessDenial.js'
import {
  refreshV1HostConnection,
  resolveHostConnectionForUser,
} from '../services/mcpProxyService.js'
import {
  WakeAndHoldCoordinator,
  isWakeEligibleHostError,
  probeHostReadyViaHealth,
  respondWithWakeAndHold,
} from '../services/wakeAndHold.js'
import type { RpcAccessClaims } from '../types.js'

// Two V1 requests of one principal hold on the same Host wake. The real first
// resolve, wake-and-hold coordinator and re-resolve run; `fetch` is the only
// stub, and the scheduler decides the order in which every fetch settles. At
// rest, each request's last Host call carries the assertion of that request's
// most recent resolve, never an older one or the other request's.
//
// control-api issues signed assertions whose `exp` is within the re-resolve
// margin (`upstreamTimeoutMs` plus 2 s), so each retry re-resolves; `jti` makes
// every issued assertion distinct.

const USER_ID = 'user-uuid-123'
const HOST_URL = 'http://chatllm.mcp-host.svc.cluster.local:8080'
const REQUESTS = ['req-a', 'req-b'] as const
const EDGE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 })

function signNearExpAssertion(): string {
  const iat = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      sub: USER_ID,
      jti: randomUUID(),
      iat,
      exp: iat + Math.floor(config.upstreamTimeoutMs / 1000),
    },
    EDGE_KEYS.privateKey,
    { algorithm: 'RS256' }
  )
}

const CLAIMS = {
  sub: USER_ID,
  typ: 'user',
  accessScope: 'team',
  teamId: 'team-1',
  scopes: ['host:approval:write', 'host:wake:write'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
} as unknown as RpcAccessClaims

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fakeResponse() {
  const state = { headersSent: false, statusCode: 0, body: undefined as unknown, jsonCalls: 0 }
  const res = {
    get headersSent() {
      return state.headersSent
    },
    setHeader() {
      return res
    },
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(body: unknown) {
      state.jsonCalls++
      state.body = body
      state.headersSent = true
      return res
    },
  }
  return { res: res as unknown as ExpressResponse, state }
}

// Setup, not behaviour under test: control-api's internal service gate fixture
// runs once in a `tsx` child, bounded by PRODUCER_CHILD_TIMEOUT_MS. Its answer to
// a wrong rpc-proxy service credential is the `service_credential` re-resolve
// answer of the model-based test.
let gateAnswers: GateAnswer[] | undefined

beforeAll(async () => {
  gateAnswers = await emitGateAnswers(
    'control-api/test/fixtures/emitInternalServiceGateRefusalsFixture.ts',
    { userId: USER_ID, hostRef: 'chatllm' }
  )
}, producerBudgetMs(1))

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('V1 wake-and-hold keeps each request on its own latest assertion', () => {
  it('at rest, the last Host call of each request carries its most recent resolve', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async s => {
        // Assertions control-api issued, per RPC token, in order.
        const issued = new Map<string, string[]>()
        // Host calls per request id, with the assertion they carried.
        const hostCalls = new Map<string, string[]>()
        const firstForwardFailed = new Set<string>()

        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const headers = new Headers(init?.headers)
          let outcome: Response | Error
          if (url.startsWith(config.controlApiBaseUrl.replace(/\/+$/, ''))) {
            if (url.endsWith('/wake')) {
              outcome = jsonResponse(200, { status: 'active' })
            } else {
              const token = headers.get('x-rpc-access-token')!
              const list = issued.get(token) ?? []
              const assertion = signNearExpAssertion()
              list.push(assertion)
              issued.set(token, list)
              outcome = jsonResponse(200, {
                userId: USER_ID,
                hostRef: 'chatllm',
                url: HOST_URL,
                edgeAssertion: assertion,
              })
            }
          } else if (new URL(url).pathname === '/v1/runtime/health') {
            outcome = jsonResponse(200, { ok: true })
          } else {
            const requestId = headers.get('x-clerum-edge-request-id')!
            const calls = hostCalls.get(requestId) ?? []
            calls.push(headers.get(HOST_EDGE_ASSERTION_HEADER)!)
            hostCalls.set(requestId, calls)
            if (!firstForwardFailed.has(requestId)) {
              firstForwardFailed.add(requestId)
              outcome = new TypeError('fetch failed')
            } else {
              outcome = jsonResponse(200, { ok: true })
            }
          }
          return s.schedule(Promise.resolve(outcome), url).then(value => {
            if (value instanceof Error) throw value
            return value
          })
        }) as typeof fetch

        const coordinator = new WakeAndHoldCoordinator({
          requestWake: requestHostWakeFromControlApi,
          probeReady: probeHostReadyViaHealth,
          maxHoldMs: config.wakeMaxHoldMs,
          pollMs: config.wakePollMs,
          retriggerMs: config.wakeRetriggerMs,
          maxTrackedCoordinations: 16,
        })

        const runRequest = async (requestId: string) => {
          const token = `token-${requestId}`
          const { res, state } = fakeResponse()
          const host = await resolveHostConnectionForUser(USER_ID, 'chatllm', token, {
            requestId,
          })
          if (isHostResolveRefusal(host)) throw new Error('first resolve was refused')
          const attempt = async () => {
            await fetch(`${host.url}/v1/runtime/approvals/approve`, {
              method: 'POST',
              headers: { ...host.headers },
            })
            res.status(200).json({ ok: true })
          }
          try {
            await attempt()
          } catch (error) {
            if (!isWakeEligibleHostError(error)) throw error
            await respondWithWakeAndHold({
              res,
              hostRef: 'chatllm',
              host,
              claims: CLAIMS,
              rpcAccessToken: token,
              coordinator,
              refreshV1Host: {
                refresh: () => refreshV1HostConnection(host, USER_ID, 'chatllm', token),
                respondRefused: () => {
                  throw new Error('re-resolve was refused')
                },
              },
              attemptUpstream: attempt,
              respondLegacy: error => {
                throw error
              },
            })
          }
          return { token, state }
        }

        const results = await s.waitFor(Promise.all(REQUESTS.map(runRequest)))

        for (const [index, requestId] of REQUESTS.entries()) {
          const { token, state } = results[index]!
          const calls = hostCalls.get(requestId)!
          const tokenAssertions = issued.get(token)!
          expect(state.statusCode).toBe(200)
          // Witness: the first forward failed and the retry re-resolved.
          expect(calls).toHaveLength(2)
          expect(tokenAssertions).toHaveLength(2)
          expect(calls[0]).toBe(tokenAssertions[0])
          expect(calls.at(-1)).toBe(tokenAssertions.at(-1))
        }
      }),
      { numRuns: 30 }
    )
  })
})

// Model-based (S8): `fc.commands` queues, per request, what control-api
// answers the re-resolve and what the Host answers the single retry; the
// scheduler orders every fetch. Each request's first forward fails (the event
// that starts the hold), so every request re-resolves once before its retry.
// The real first resolve, coordinator, re-resolve and refusal writer run;
// `fetch` and `res` are the only stubs.

type ReResolveAnswer =
  | 'valid'
  | 'denied'
  | 'rejected'
  | 'http_503'
  | 'missing_assertion'
  | 'network'
  | 'timeout'
  | 'service_credential'
type RetryHostAnswer = 'down' | 'ok'
type AnswerQueues = { reResolve: ReResolveAnswer[][]; host: RetryHostAnswer[][] }

const RE_RESOLVE_ANSWERS: readonly ReResolveAnswer[] = [
  'valid',
  'denied',
  'rejected',
  'http_503',
  'missing_assertion',
  'network',
  'timeout',
  'service_credential',
]

// Table M with the route's denialAnswer 'forbidden', for each refusal.
const REFUSAL_ANSWER: Record<
  Exclude<ReResolveAnswer, 'valid'>,
  { status: number; body: unknown }
> = {
  denied: {
    status: 403,
    body: { error: 'Forbidden: user cannot access this host', code: 'host_access_denied' },
  },
  rejected: { status: 401, body: { error: 'Unauthorized' } },
  http_503: { status: 503, body: { error: 'authority_unavailable' } },
  missing_assertion: { status: 503, body: { error: 'authority_unavailable' } },
  network: { status: 503, body: { error: 'authority_unavailable' } },
  timeout: { status: 504, body: { error: 'Gateway Timeout' } },
  service_credential: { status: 503, body: { error: 'authority_unavailable' } },
}

function emptyQueues(): AnswerQueues {
  return { reResolve: REQUESTS.map(() => []), host: REQUESTS.map(() => []) }
}

// Each request has one re-resolve and one retry Host call, so each queue takes
// at most one answer.
class QueueReResolveAnswer implements fc.Command<AnswerQueues, AnswerQueues> {
  constructor(
    readonly request: number,
    readonly answer: ReResolveAnswer
  ) {}
  check(model: Readonly<AnswerQueues>): boolean {
    return model.reResolve[this.request]!.length === 0
  }
  run(model: AnswerQueues, real: AnswerQueues): void {
    model.reResolve[this.request]!.push(this.answer)
    real.reResolve[this.request]!.push(this.answer)
  }
  toString(): string {
    return `ReResolveAnswer(${REQUESTS[this.request]}, ${this.answer})`
  }
}

class QueueRetryHostAnswer implements fc.Command<AnswerQueues, AnswerQueues> {
  constructor(
    readonly request: number,
    readonly answer: RetryHostAnswer
  ) {}
  check(model: Readonly<AnswerQueues>): boolean {
    return model.host[this.request]!.length === 0
  }
  run(model: AnswerQueues, real: AnswerQueues): void {
    model.host[this.request]!.push(this.answer)
    real.host[this.request]!.push(this.answer)
  }
  toString(): string {
    return `HostAnswer(${REQUESTS[this.request]}, ${this.answer})`
  }
}

const REQUEST_INDEX = fc.integer({ min: 0, max: REQUESTS.length - 1 })
const ANSWER_COMMANDS = fc.commands(
  [
    fc
      .tuple(REQUEST_INDEX, fc.constantFrom(...RE_RESOLVE_ANSWERS))
      .map(([request, answer]) => new QueueReResolveAnswer(request, answer)),
    fc
      .tuple(REQUEST_INDEX, fc.constantFrom<RetryHostAnswer>('down', 'ok'))
      .map(([request, answer]) => new QueueRetryHostAnswer(request, answer)),
  ],
  { maxCommands: 6 }
)

// The reference walk of one request: the first forward fails, the retry
// re-resolves (a dry queue answers valid), a refusal ends the request with
// table M, otherwise the retry's Host answer (a dry queue answers 200) ends it
// with 200 or, Host still down on a single-retry route, 503 host_waking.
function expectedOutcome(model: AnswerQueues, request: number) {
  const reResolve = model.reResolve[request]![0] ?? 'valid'
  if (reResolve !== 'valid') {
    return { ...REFUSAL_ANSWER[reResolve], hostCalls: 1, issuedAssertions: 1, refused: true }
  }
  const retry = model.host[request]![0] ?? 'ok'
  return retry === 'ok'
    ? { status: 200, body: { ok: true }, hostCalls: 2, issuedAssertions: 2, refused: false }
    : {
        status: 503,
        body: expect.objectContaining({ code: 'host_waking' }),
        hostCalls: 2,
        issuedAssertions: 2,
        refused: false,
      }
}

type FetchEvent =
  | { kind: 'resolve'; token: string; refused: boolean }
  | { kind: 'wake'; token: string }
  | { kind: 'host'; requestId: string }

describe('V1 wake-and-hold re-resolve outcomes (model-based)', () => {
  it('at rest, each request answers what the model walks to, and nothing follows a refusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    let runs = 0
    // Requests per terminal kind across runs (refused, hostWaking, ok, exclusive):
    // the generated sequences reach a refusal and a Host still down after the
    // retry, not only 200. serviceCredential counts the refusals that are
    // control-api's gate refusing rpc-proxy's service credential.
    const reached = { refused: 0, hostWaking: 0, ok: 0, serviceCredential: 0 }

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), ANSWER_COMMANDS, async (s, commands) => {
        runs++
        const model = emptyQueues()
        const real = emptyQueues()
        fc.modelRun(() => ({ model, real }), commands)

        const issued = new Map<string, string[]>()
        const resolveCalls = new Map<string, number>()
        const hostCalls = new Map<string, string[]>()
        const events: FetchEvent[] = []

        const answerResolve = (token: string, request: number): Response | Error => {
          const count = (resolveCalls.get(token) ?? 0) + 1
          resolveCalls.set(token, count)
          // The first resolve is always valid (its refusals are S1's).
          const answer = count === 1 ? 'valid' : (real.reResolve[request]!.shift() ?? 'valid')
          events.push({ kind: 'resolve', token, refused: answer !== 'valid' })
          const connection = { userId: USER_ID, hostRef: 'chatllm', url: HOST_URL }
          switch (answer) {
            case 'valid': {
              const assertion = signNearExpAssertion()
              issued.set(token, [...(issued.get(token) ?? []), assertion])
              return jsonResponse(200, { ...connection, edgeAssertion: assertion })
            }
            case 'denied':
              return jsonResponse(403, { error: 'forbidden' })
            case 'rejected':
              return jsonResponse(401, { error: 'unauthorized' })
            case 'http_503':
              return jsonResponse(503, { error: 'unavailable' })
            case 'missing_assertion':
              return jsonResponse(200, connection)
            case 'network':
              return new TypeError('fetch failed')
            case 'timeout':
              return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
            case 'service_credential':
              // control-api's gate refusing rpc-proxy's own service credential.
              return responseFromGateAnswer(gateAnswer(gateAnswers, 'gate_token_wrong', 'GET'))
          }
        }

        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          const headers = new Headers(init?.headers)
          let outcome: Response | Error
          if (url.startsWith(config.controlApiBaseUrl.replace(/\/+$/, ''))) {
            const token = headers.get('x-rpc-access-token')!
            if (url.endsWith('/wake')) {
              events.push({ kind: 'wake', token })
              outcome = jsonResponse(200, { status: 'active' })
            } else {
              const request = REQUESTS.findIndex(id => `token-${id}` === token)
              outcome = answerResolve(token, request)
            }
          } else if (new URL(url).pathname === '/v1/runtime/health') {
            outcome = jsonResponse(200, { ok: true })
          } else {
            const requestId = headers.get('x-clerum-edge-request-id')!
            events.push({ kind: 'host', requestId })
            const calls = hostCalls.get(requestId) ?? []
            calls.push(headers.get(HOST_EDGE_ASSERTION_HEADER)!)
            hostCalls.set(requestId, calls)
            const request = REQUESTS.indexOf(requestId as (typeof REQUESTS)[number])
            const answer = calls.length === 1 ? 'down' : (real.host[request]!.shift() ?? 'ok')
            outcome =
              answer === 'down' ? new TypeError('fetch failed') : jsonResponse(200, { ok: true })
          }
          return s.schedule(Promise.resolve(outcome), url).then(value => {
            if (value instanceof Error) throw value
            return value
          })
        }) as typeof fetch

        const coordinator = new WakeAndHoldCoordinator({
          requestWake: requestHostWakeFromControlApi,
          probeReady: probeHostReadyViaHealth,
          maxHoldMs: config.wakeMaxHoldMs,
          pollMs: config.wakePollMs,
          retriggerMs: config.wakeRetriggerMs,
          maxTrackedCoordinations: 16,
        })

        const runRequest = async (requestId: string) => {
          const token = `token-${requestId}`
          const { res, state } = fakeResponse()
          const host = await resolveHostConnectionForUser(USER_ID, 'chatllm', token, {
            requestId,
          })
          if (isHostResolveRefusal(host)) throw new Error('first resolve was refused')
          const attempt = async () => {
            await fetch(`${host.url}/v1/runtime/approvals/approve`, {
              method: 'POST',
              headers: { ...host.headers },
            })
            res.status(200).json({ ok: true })
          }
          try {
            await attempt()
          } catch (error) {
            if (!isWakeEligibleHostError(error)) throw error
            await respondWithWakeAndHold({
              res,
              hostRef: 'chatllm',
              host,
              claims: CLAIMS,
              rpcAccessToken: token,
              coordinator,
              refreshV1Host: {
                refresh: () => refreshV1HostConnection(host, USER_ID, 'chatllm', token),
                respondRefused: refusal => respondHostResolveRefusal(res, refusal, 'forbidden'),
              },
              attemptUpstream: attempt,
              respondLegacy: error => {
                throw error
              },
            })
          }
          return { token, state }
        }

        const results = await s.waitFor(Promise.all(REQUESTS.map(runRequest)))

        for (const [index, requestId] of REQUESTS.entries()) {
          const { token, state } = results[index]!
          const expected = expectedOutcome(model, index)
          if (expected.refused) reached.refused++
          else if (expected.status === 200) reached.ok++
          else reached.hostWaking++
          // A subset of `refused`: control-api's gate refusing rpc-proxy's own service credential.
          if (model.reResolve[index]![0] === 'service_credential') reached.serviceCredential++
          const calls = hostCalls.get(requestId)!
          const tokenAssertions = issued.get(token)!
          // Witness: the first forward failed and the retry re-resolved.
          expect(resolveCalls.get(token)).toBe(2)
          expect(state.statusCode).toBe(expected.status)
          expect(state.body).toEqual(expected.body)
          expect(state.jsonCalls).toBe(1)
          expect(calls).toHaveLength(expected.hostCalls)
          expect(tokenAssertions).toHaveLength(expected.issuedAssertions)
          expect(calls.at(-1)).toBe(tokenAssertions.at(-1))
          const refusalAt = events.findIndex(
            event => event.kind === 'resolve' && event.token === token && event.refused
          )
          expect(refusalAt >= 0).toBe(expected.refused)
          if (refusalAt >= 0) {
            const after = events.slice(refusalAt + 1)
            expect(after.filter(e => e.kind === 'host' && e.requestId === requestId)).toEqual([])
            expect(after.filter(e => e.kind === 'wake' && e.token === token)).toEqual([])
          }
        }
      }),
      { numRuns: 60 }
    )

    expect(runs).toBeGreaterThan(0)
    expect(reached.refused).toBeGreaterThan(0)
    expect(reached.hostWaking).toBeGreaterThan(0)
    expect(reached.ok).toBeGreaterThan(0)
    expect(reached.serviceCredential).toBeGreaterThan(0)
  })
})
