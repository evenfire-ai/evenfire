import { afterEach, describe, expect, it } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import fc from 'fast-check'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import { config } from '../config.js'
import { requestHostWakeFromControlApi } from '../services/controlApiRestService.js'
import { isHostAccessDenied } from '../services/hostAccessDenial.js'
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
  const state = { headersSent: false, statusCode: 0, body: undefined as unknown }
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
      state.body = body
      state.headersSent = true
      return res
    },
  }
  return { res: res as unknown as ExpressResponse, state }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
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
          if (!host || isHostAccessDenied(host)) throw new Error('first resolve was denied')
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
                respondDenied: () => {
                  throw new Error('re-resolve was denied')
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
