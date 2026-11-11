import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import { LlmErrorCode } from '../../core/errors'
import { classifyFailoverClass } from '../failover/classify'
import { UPSTREAM_REQUEST_REJECTED_MESSAGE } from '../upstreamRejected'
import { installLoopbackOnlyNetwork } from './loopbackOnlyNetwork'
import { type ArmId, type FixtureReply, arm, cleanupTransports } from './providerTransportFixtures'

// Issue #1433: a provider's own HTTP 400 refusal reads the same on every
// makeProvider arm — LLM_UPSTREAM_REJECTED, not retryable, never a failover
// trigger — while the provider-specific 400s (quota, retired model, credit)
// keep their codes. Each arm runs its real SDK or proxy client against a local
// endpoint (see providerTransportFixtures for what else is stubbed).

const OPENAI_400: FixtureReply = {
  status: 400,
  body: {
    error: {
      message: 'Invalid request: fixture rejection',
      type: 'invalid_request_error',
      code: null,
    },
  },
}

const PROXY_REJECTED: FixtureReply = {
  status: 422,
  body: { error: 'upstream_rejected', upstreamStatus: 400 },
}

type Row = {
  name: string
  arm: ArmId
  reply: FixtureReply
  expected: Record<string, unknown>
  /** A substring of the provider's own text the classified message keeps. */
  keeps?: string
}

const ROWS: Row[] = [
  {
    name: 'openai 400',
    arm: 'openai',
    reply: OPENAI_400,
    expected: { code: LlmErrorCode.UpstreamRejected, retryable: false, httpStatus: 400 },
    keeps: 'fixture rejection',
  },
  {
    name: 'azure 400',
    arm: 'azure',
    reply: OPENAI_400,
    expected: { code: LlmErrorCode.UpstreamRejected, retryable: false, httpStatus: 400 },
    keeps: 'fixture rejection',
  },
  {
    name: 'zai 400',
    arm: 'zai',
    reply: OPENAI_400,
    expected: { code: LlmErrorCode.UpstreamRejected, retryable: false, httpStatus: 400 },
    keeps: 'fixture rejection',
  },
  {
    name: 'zai 400 with code 1211 stays a retired model',
    arm: 'zai',
    reply: {
      status: 400,
      body: { error: { message: 'Unknown Model', type: 'invalid_request_error', code: '1211' } },
    },
    expected: { code: LlmErrorCode.ModelNotAvailable, retryable: false, httpStatus: 400 },
  },
  {
    name: 'claude 400',
    arm: 'claude',
    reply: {
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'fixture rejection' },
      },
    },
    expected: {
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      providerCode: 'invalid_request_error',
      // The provider's own text, not the SDK's `400 {json}` string.
      message: 'fixture rejection',
    },
  },
  {
    name: 'claude 400 for a low credit balance stays a quota error',
    arm: 'claude',
    reply: {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
    },
    expected: { code: LlmErrorCode.InsufficientQuota, retryable: false, httpStatus: 400 },
  },
  {
    name: 'codex proxy upstream_rejected',
    arm: 'codex-subscription',
    reply: PROXY_REJECTED,
    expected: {
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      message: UPSTREAM_REQUEST_REJECTED_MESSAGE,
    },
  },
  {
    name: 'grok proxy upstream_rejected',
    arm: 'grok-subscription',
    reply: PROXY_REJECTED,
    expected: {
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      message: UPSTREAM_REQUEST_REJECTED_MESSAGE,
    },
  },
  {
    name: 'vertex 400',
    arm: 'vertex',
    reply: {
      status: 400,
      body: { error: { code: 400, message: 'fixture rejection', status: 'INVALID_ARGUMENT' } },
    },
    expected: {
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      providerCode: undefined,
    },
    keeps: 'fixture rejection',
  },
  {
    name: 'bedrock ValidationException',
    arm: 'bedrock',
    reply: {
      status: 400,
      body: { message: 'fixture rejection' },
      headers: { 'x-amzn-errortype': 'ValidationException' },
    },
    expected: {
      code: LlmErrorCode.UpstreamRejected,
      retryable: false,
      httpStatus: 400,
      providerCode: 'ValidationException',
    },
    keeps: 'fixture rejection',
  },
  {
    name: 'bedrock ServiceQuotaExceededException stays a quota error',
    arm: 'bedrock',
    reply: {
      status: 400,
      body: { message: 'quota exceeded' },
      headers: { 'x-amzn-errortype': 'ServiceQuotaExceededException' },
    },
    expected: {
      code: LlmErrorCode.InsufficientQuota,
      retryable: false,
      providerCode: 'ServiceQuotaExceededException',
    },
  },
]

beforeEach(() => {
  installLoopbackOnlyNetwork()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupTransports()
})

it('the loopback-only guard refuses a non-loopback connection (witness)', () => {
  expect(() => net.connect({ host: '203.0.113.1', port: 9 })).toThrow(/loopback-only test network/)
})

describe("a provider's HTTP 400 on every makeProvider arm (#1433)", () => {
  it.each(ROWS)('$name', async row => {
    const fixture = await arm(row.arm).make(row.reply)

    const err = await fixture.provider
      .completeSingleTurnWithTools([{ role: 'user', content: 'hi' }], [])
      .then(
        () => undefined,
        (caught: unknown) => caught
      )

    // Witness: the request reached the arm's transport exactly once.
    expect(fixture.bodies).toHaveLength(1)
    expect(err).toBeDefined()
    const classified = fixture.provider.classifyError(err)
    expect(classified).toMatchObject(row.expected)
    if ('providerCode' in row.expected && row.expected.providerCode === undefined) {
      expect(classified.providerCode).toBeUndefined()
    }
    if (row.keeps) expect(classified.message).toContain(row.keeps)
    // A refused request never fails over; a quota error keeps its own class.
    expect(classifyFailoverClass(classified.code, classified.retryable)).toBe(
      classified.code === LlmErrorCode.InsufficientQuota ? 'insufficient_quota' : null
    )
  })
})
