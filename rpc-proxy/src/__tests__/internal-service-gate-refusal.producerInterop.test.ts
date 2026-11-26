import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import { HOST_EDGE_ASSERTION_HEADER } from '@clerum/action-context-contracts'
import {
  type GateAnswer,
  type GateAnswerCase,
  emitGateAnswers,
  gateAnswer,
  responseFromGateAnswer,
} from '../../test/support/internalServiceGateAnswers.js'
import { producerBudgetMs } from '../../test/support/producerChild.js'
import { fetchHostConnectionFromControlApi } from '../services/controlApiRestService.js'
import {
  refreshV1HostConnection,
  resolveHostConnectionForUser,
} from '../services/mcpProxyService.js'

// J1 (R1-L7): control-api answers a refused service credential and a refused
// RPC access token with the same `401 {"error":"Unauthorized"}`; only the
// service gate's refusal carries its mark. The answers come from control-api's
// real gate and RPC access users router (the fixture below), and go through the
// real rpc-proxy client, resolver and re-resolve.

const USER_ID = 'user-uuid-123'
const HOST_REF = 'chatllm'
const RPC_TOKEN = 'rpc-token-fixture'
const BINDING = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat' as const,
}
const UNAUTHORIZED_TEXT = '{"error":"Unauthorized"}'
const REFUSAL_HEADER = 'x-internal-service-auth-refusal'
const UNAVAILABLE_LOG_PREFIX = '[RPC_PROXY] control-api host resolve unavailable'

const GATE_CASES: readonly GateAnswerCase[] = [
  'gate_bearer_missing',
  'gate_service_name_missing',
  'gate_token_wrong',
  'gate_other_service',
  'both_bad',
]
const CALLER_TOKEN_CASES: readonly GateAnswerCase[] = [
  'caller_token_missing',
  'caller_token_unverifiable',
]
const METHODS = ['GET', 'POST'] as const

// Setup, not behaviour under test: control-api's gate fixture runs once in a
// `tsx` child, bounded by PRODUCER_CHILD_TIMEOUT_MS. A failed child fails every
// test of this file with its own error.
let answers: GateAnswer[] | undefined

beforeAll(async () => {
  answers = await emitGateAnswers(
    'control-api/test/fixtures/emitInternalServiceGateRefusalsFixture.ts',
    { userId: USER_ID, hostRef: HOST_REF }
  )
}, producerBudgetMs(1))

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function fetchAnswering(answer: GateAnswer) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    responseFromGateAnswer(answer)
  )
}

function expectOneCall(fetchImpl: ReturnType<typeof fetchAnswering>, method: 'GET' | 'POST') {
  expect(fetchImpl).toHaveBeenCalledOnce()
  const [url, init] = fetchImpl.mock.calls[0]!
  expect(String(url)).toMatch(/\/rpc\/access\/users\/user-uuid-123\/mcp-hosts\/chatllm$/)
  expect(init).toMatchObject({ method })
}

async function resolveThroughClient(answer: GateAnswer, method: 'GET' | 'POST') {
  const fetchImpl = fetchAnswering(answer)
  const result = await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, RPC_TOKEN, {
    ...(method === 'POST' ? { directRunBinding: BINDING } : {}),
    fetchImpl: fetchImpl as typeof fetch,
  })
  return { result, fetchImpl }
}

describe('control-api internal service gate answers through the host access client', () => {
  it('the fixture emits every gate and caller-token case on GET and POST, and authorized on GET', () => {
    if (!answers) throw new Error('the internal service gate answers were not set up in beforeAll')
    expect(answers).toHaveLength(15)
    expect(answers.map(answer => `${answer.case} ${answer.method}`).sort()).toEqual(
      [
        ...[...GATE_CASES, ...CALLER_TOKEN_CASES].flatMap(answerCase =>
          METHODS.map(method => `${answerCase} ${method}`)
        ),
        'authorized GET',
      ].sort()
    )
  })

  it.each(GATE_CASES.flatMap(answerCase => METHODS.map(method => ({ answerCase, method }))))(
    'a $answerCase refusal on $method is an unavailable authority',
    async ({ answerCase, method }) => {
      const answer = gateAnswer(answers, answerCase, method)
      expect(answer.status).toBe(401)
      expect(answer.body).toBe(UNAUTHORIZED_TEXT)

      const { result, fetchImpl } = await resolveThroughClient(answer, method)

      expect(result).toEqual({ unavailable: true, cause: 'service_credential_rejected' })
      expectOneCall(fetchImpl, method)
    }
  )

  it.each(
    CALLER_TOKEN_CASES.flatMap(answerCase => METHODS.map(method => ({ answerCase, method })))
  )('a $answerCase refusal on $method is a rejection', async ({ answerCase, method }) => {
    const answer = gateAnswer(answers, answerCase, method)
    expect(answer.status).toBe(401)
    expect(answer.body).toBe(UNAUTHORIZED_TEXT)
    expect(answer.headers[REFUSAL_HEADER]).toBeUndefined()

    const { result, fetchImpl } = await resolveThroughClient(answer, method)

    expect(result).toEqual({ rejected: true, status: 401 })
    expectOneCall(fetchImpl, method)
  })

  it('the authorized answer resolves a connection (the fixture credentials work)', async () => {
    const answer = gateAnswer(answers, 'authorized', 'GET')
    expect(answer.status).toBe(200)

    const { result, fetchImpl } = await resolveThroughClient(answer, 'GET')

    expect(result).toEqual({
      name: HOST_REF,
      url: expect.any(String),
      headers: {},
      edgeAssertion: expect.any(String),
    })
    expectOneCall(fetchImpl, 'GET')
  })
})

// An assertion whose `exp` is within the re-resolve margin, so
// refreshV1HostConnection calls control-api. Only `exp` is read (decoded
// without verification), so the signing key is random.
function nearExpiryAssertion(): string {
  return jwt.sign({ exp: Math.floor(Date.now() / 1000) + 1 }, randomBytes(32), {
    algorithm: 'HS256',
  })
}

function heldHost() {
  return {
    name: HOST_REF,
    url: 'http://chatllm.mcp-host.svc.cluster.local:8080',
    headers: { [HOST_EDGE_ASSERTION_HEADER]: nearExpiryAssertion() },
  }
}

const PHASES = [
  {
    phase: 'resolve',
    run: () => resolveHostConnectionForUser(USER_ID, HOST_REF, RPC_TOKEN),
  },
  {
    phase: 're-resolve',
    run: () => refreshV1HostConnection(heldHost(), USER_ID, HOST_REF, RPC_TOKEN),
  },
] as const

function unavailableLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map(args => String(args[0]))
    .filter(line => line.startsWith(UNAVAILABLE_LOG_PREFIX))
}

describe('the resolver logs a refused service credential and not a refused caller token', () => {
  it.each(PHASES)(
    'phase $phase: a gate refusal writes exactly one unavailable line',
    async ({ phase, run }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fetchImpl = fetchAnswering(gateAnswer(answers, 'gate_token_wrong', 'GET'))
      globalThis.fetch = fetchImpl as typeof fetch

      await expect(run()).resolves.toEqual({
        unavailable: true,
        cause: 'service_credential_rejected',
      })

      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(unavailableLines(warn)).toEqual([
        `${UNAVAILABLE_LOG_PREFIX} phase=${phase} host=${HOST_REF} cause=service_credential_rejected`,
      ])
    }
  )

  it.each(PHASES)(
    'phase $phase: a caller-token refusal writes no unavailable line',
    async ({ run }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const fetchImpl = fetchAnswering(gateAnswer(answers, 'caller_token_unverifiable', 'GET'))
      globalThis.fetch = fetchImpl as typeof fetch

      // Witness: the resolve reached control-api once and returned its rejection.
      await expect(run()).resolves.toEqual({ rejected: true, status: 401 })
      expect(fetchImpl).toHaveBeenCalledOnce()

      expect(unavailableLines(warn)).toEqual([])
    }
  )
})
