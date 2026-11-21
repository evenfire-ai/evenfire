import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fc from 'fast-check'
import request from 'supertest'
import {
  HOST_EDGE_ASSERTION_HEADER,
  actionOperationScope,
  canonicalResourceIdentity,
  hashActionTarget,
  validateActionOperationTarget,
} from '@clerum/action-context-contracts'
import { ActionAuthorityCheckpointError, authorizeActionV2 } from '../actionAuthorityV2.js'
import { createRpcRouter } from '../routes/rpc.js'
import { resolveHostConnectionForUser } from '../services/mcpProxyService.js'
import type { UserDelegationV2Claims } from '../userDelegationV2.js'

// A V2 Host request carries two credentials from one allowed checkpoint: the
// action context and the Host edge assertion. These tests pin that rpc-proxy
// refuses a Host checkpoint without an assertion, forwards both on the first
// resolve, and rewrites both together when a wake-and-hold retry re-runs the
// checkpoint.

const delegationMock = vi.hoisted(() => ({
  tokenDeclaresV2: vi.fn(),
  verifyUserDelegationV2: vi.fn(),
}))
const legacyAuthMock = vi.hoisted(() => ({ verifyRpcToken: vi.fn() }))
vi.mock('../userDelegationV2.js', () => delegationMock)
vi.mock('../authToken.js', () => legacyAuthMock)

const CHECKPOINT_PATH = '/api/v1/internal/action-authority/checkpoint'
const HOST_URL = 'http://chatllm.mcp-host.svc.cluster.local:8080'
const ACTION_CONTEXT_HEADER = 'x-clerum-edge-action-context'

const RESOURCE = canonicalResourceIdentity({
  environmentId: 'cluster.local/evenfire',
  type: 'runtime_session',
  logicalId: 'mcp-host/chatllm',
  displayName: 'chatllm',
})
const TARGET = validateActionOperationTarget({
  operationId: 'session.read',
  resource: RESOURCE,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const BOUND = {
  operationId: 'session.read' as const,
  target: TARGET,
  targetHash: hashActionTarget(TARGET),
}

function delegation(jti: string): UserDelegationV2Claims {
  const now = Math.floor(Date.now() / 1000)
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: '11111111-1111-4111-8111-111111111111',
    sid: '22222222-2222-4222-8222-222222222222',
    sv: 3,
    jti,
    iat: now,
    exp: now + 300,
    operationIds: ['session.read'],
    scopes: [actionOperationScope('session.read')],
    resource: RESOURCE,
    targets: { 'session.read': TARGET },
    targetHashes: { 'session.read': BOUND.targetHash },
    accessPathId: `ap1_${'b'.repeat(43)}`,
    authorizationRevision: `ar1_${'c'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'d'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
  }
}

/** A compact JWS whose payload names the checkpoint it came from. */
function assertionFor(label: string): string {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(label).toString('base64url')}.c2lnbmF0dXJl`
}

function allowedCheckpointBody(
  claims: UserDelegationV2Claims,
  checkedAt: Date,
  hostEdgeAssertion: string | undefined
) {
  return {
    version: 2,
    status: 'allowed',
    authorizationRevision: claims.authorizationRevision,
    behaviorBindingHash: claims.behaviorBindingHash,
    behavior: {
      budget: { state: 'unknown' },
      credentialPolicy: { state: 'unknown' },
      approvalPolicy: { state: 'unknown' },
      filesystemScope: { state: 'unknown' },
      runtime: { state: 'unknown' },
      providerModelPolicy: { state: 'unknown' },
      audit: { state: 'unknown' },
    },
    checkedAt: checkedAt.toISOString(),
    validUntil: new Date(checkedAt.getTime() + 60_000).toISOString(),
    attribution: {
      userId: claims.sub,
      sid: claims.sid,
      sessionVersion: claims.sv,
      accessPathId: claims.accessPathId,
      pathKind: claims.pathKind,
      effectiveTeamId: claims.effectiveTeamId,
    },
    destination: { kind: 'host', ref: 'mcp-host/chatllm', url: HOST_URL },
    ...(hostEdgeAssertion === undefined ? {} : { hostEdgeAssertion }),
  }
}

function checkpointFetch(body: unknown): typeof fetch {
  return (async () => Response.json(body)) as unknown as typeof fetch
}

function decodeContext(header: string): { checkedAt: string; delegationJti: string } {
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.clearAllMocks()
})

describe('V2 Host checkpoint edge assertion', () => {
  it('refuses an allowed Host checkpoint that carries no edge assertion', async () => {
    const claims = delegation('jti-1')
    const checkedAt = new Date()

    await expect(
      authorizeActionV2(claims, BOUND, {
        fetchImpl: checkpointFetch(allowedCheckpointBody(claims, checkedAt, undefined)),
      })
    ).rejects.toMatchObject({
      constructor: ActionAuthorityCheckpointError,
      status: 503,
      code: 'authority_unavailable',
    })

    // Witness: the same checkpoint with an assertion is authorized, and the
    // assertion is kept apart from the checkpoint body.
    const assertion = assertionFor('checkpoint-1')
    const authorized = await authorizeActionV2(claims, BOUND, {
      fetchImpl: checkpointFetch(allowedCheckpointBody(claims, checkedAt, assertion)),
    })
    expect(authorized.hostEdgeAssertion).toBe(assertion)
    expect(authorized.checkpoint).not.toHaveProperty('hostEdgeAssertion')
  })

  it('forwards the assertion and the action context of the same checkpoint on the first resolve', async () => {
    const claims = delegation('jti-1')
    const assertion = assertionFor('checkpoint-1')
    const authorized = await authorizeActionV2(claims, BOUND, {
      fetchImpl: checkpointFetch(allowedCheckpointBody(claims, new Date(), assertion)),
    })

    const host = await resolveHostConnectionForUser(claims.sub, 'chatllm', 'v2-token', {
      authorizedActionV2: authorized,
    })

    expect(host).toMatchObject({ url: HOST_URL })
    const headers = (host as { headers: Record<string, string> }).headers
    expect(headers[HOST_EDGE_ASSERTION_HEADER]).toBe(assertion)
    expect(headers[ACTION_CONTEXT_HEADER]).toBe(authorized.trustedEdgeHeader)
  })
})

describe('V2 wake-and-hold rewrites the action context and the assertion together', () => {
  // Two V2 requests of one principal, each with its own delegation, list the
  // Host's sessions while the Host is unreachable. The real route, checkpoint,
  // resolver and wake-and-hold run; `fetch` is the only stub, and the scheduler
  // decides the order in which every fetch settles. At rest, every Host call
  // carries an action context and an assertion from the same checkpoint
  // (matched by `checkedAt` and `delegationJti`), and the retry carries the
  // request's most recent checkpoint.
  it('at rest, each Host call pairs the context and the assertion of one checkpoint', async () => {
    const requests = [
      { token: 'v2-token-a', jti: 'jti-a', limit: '5' },
      { token: 'v2-token-b', jti: 'jti-b', limit: '6' },
    ]
    delegationMock.tokenDeclaresV2.mockReturnValue(true)
    delegationMock.verifyUserDelegationV2.mockImplementation((token: string) =>
      delegation(requests.find(entry => entry.token === token)!.jti)
    )

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async s => {
        const baseMs = Date.now()
        let checkpointCount = 0
        // Checkpoints control-api answered, per delegation, in order.
        const checkpoints = new Map<string, { checkedAt: string; assertion: string }[]>()
        // Host calls per request (by its `limit`), with both credentials.
        const hostCalls = new Map<string, { context: string; assertion: string }[]>()

        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input))
          const headers = new Headers(init?.headers)
          let outcome: Response | Error
          if (url.pathname.endsWith(CHECKPOINT_PATH.replace(/^\/api\/v1/, ''))) {
            const body = JSON.parse(String(init?.body)) as { delegationJti: string }
            const claims = delegation(body.delegationJti)
            checkpointCount += 1
            const checkedAt = new Date(baseMs + checkpointCount)
            const assertion = assertionFor(`${body.delegationJti}-${checkpointCount}`)
            const list = checkpoints.get(body.delegationJti) ?? []
            list.push({ checkedAt: checkedAt.toISOString(), assertion })
            checkpoints.set(body.delegationJti, list)
            outcome = Response.json(allowedCheckpointBody(claims, checkedAt, assertion))
          } else if (url.pathname.endsWith('/wake')) {
            outcome = Response.json({ status: 'active' })
          } else if (url.origin === HOST_URL && url.pathname === '/v1/runtime/health') {
            outcome = Response.json({ ok: true })
          } else if (url.origin === HOST_URL && url.pathname === '/v1/runtime/sessions') {
            const limit = url.searchParams.get('limit')!
            const calls = hostCalls.get(limit) ?? []
            calls.push({
              context: headers.get(ACTION_CONTEXT_HEADER)!,
              assertion: headers.get(HOST_EDGE_ASSERTION_HEADER)!,
            })
            hostCalls.set(limit, calls)
            outcome =
              calls.length === 1
                ? new TypeError('fetch failed')
                : Response.json({ sessions: [], nextCursor: null })
          } else {
            outcome = new Error(`unexpected request ${url.href}`)
          }
          return s.schedule(Promise.resolve(outcome), url.pathname).then(value => {
            if (value instanceof Error) throw value
            return value
          })
        }) as typeof fetch

        const app = express()
        app.use(express.json())
        app.use(createRpcRouter())

        const responses = await s.waitFor(
          Promise.all(
            requests.map(entry =>
              Promise.resolve(
                request(app)
                  .get(`/rpc/hosts/chatllm/sessions?limit=${entry.limit}`)
                  .set('authorization', `Bearer ${entry.token}`)
              )
            )
          )
        )

        for (const [index, entry] of requests.entries()) {
          expect(responses[index]!.status).toBe(200)
          const calls = hostCalls.get(entry.limit)!
          const issued = checkpoints.get(entry.jti)!
          // Witness: the first forward failed and the retry re-ran the checkpoint.
          expect(calls).toHaveLength(2)
          expect(issued).toHaveLength(2)
          for (const [attempt, call] of calls.entries()) {
            const context = decodeContext(call.context)
            expect(context.delegationJti).toBe(entry.jti)
            expect(context.checkedAt).toBe(issued[attempt]!.checkedAt)
            expect(call.assertion).toBe(issued[attempt]!.assertion)
          }
        }
      }),
      { numRuns: 20 }
    )
  })
})
