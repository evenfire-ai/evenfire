/**
 * Observable-behavior regression tests for the G2 gap (spec 02, Pieza A):
 * a provider 404 (retired / inaccessible model) MUST classify as
 * `ModelNotAvailable` (non-retryable) so that, observably:
 *
 *   1. the failover engine does NOT silently divert traffic to another
 *      provider (ModelNotAvailable → no failover class), and
 *   2. the tool-use loop does NOT retry it as a transient transport error.
 *
 * These assert the OBSERVABLE outcome (T4) — did we failover? did we retry?
 * what code surfaces? — not `classifyByHttpStatus` in isolation. The
 * `ClassifiedError` / `LlmError` are DERIVED from the real provider classifiers
 * (T1), never hand-built.
 *
 * Coverage spans all four classifier arms: OpenAI-compatible, Claude, Vertex
 * (google driver), and Bedrock.
 */
import { describe, expect, it, vi } from 'vitest'
import { LlmError, LlmErrorCode } from '../../core/errors'
import {
  buildTestConfig,
  createMockReasoning,
} from '../../core/orchestration/__tests__/toolUseLoopRetryableTestUtils'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { ClaudeProvider } from '../claude'
import { classifyBedrockError } from '../drivers/bedrockConverse'
import { classifyGoogleError } from '../drivers/googleGenerative'
import { FailoverEngine } from '../failover/engine'
import type { LlmPolicy, ModelPair } from '../failover/types'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import type { ClassifiedError } from '../types'
import { anthropicApiError, openaiApiError } from './sdkErrorFixtures'

const PRIMARY: ModelPair = { provider: 'claude', model: 'claude-sonnet-4-6' }

function policy(): LlmPolicy {
  return {
    cooldownSeconds: 300,
    triggerOn: ['insufficient_quota', 'auth', 'provider_unavailable', 'rate_limited'],
    fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
  }
}

type Classifier = (err: unknown) => ClassifiedError

const zai = new OpenAICompatibleProvider(
  { id: 'zai', baseURL: 'https://example.invalid', defaultModel: 'glm-4' },
  'fake-key'
)
const claude = new ClaudeProvider('fake-key', 'claude-sonnet-4-6')

// Real SDK-shaped 404 payloads (the boundary these classifiers consume), one
// per arm. The OpenAI/Anthropic arms derive from their SDK error constructors
// (T1); Vertex/Bedrock use plain GCP/AWS-shaped errors (their producers are not
// exposed SDK error classes). The ClassifiedError/LlmError below are produced
// by the real classifiers, not hand-written.
const CASES: ReadonlyArray<[string, Classifier, string, unknown]> = [
  [
    'openai-compat (zai)',
    (e: unknown) => zai.classifyError(e),
    'zai',
    openaiApiError(404, { code: '1211', message: 'The model does not exist' }),
  ],
  [
    'claude',
    (e: unknown) => claude.classifyError(e),
    'claude',
    anthropicApiError(404, 'not_found_error', 'model: claude-x not found'),
  ],
  [
    'vertex (google)',
    classifyGoogleError,
    'vertex',
    { status: 404, message: 'Publisher Model `x` was not found' },
  ],
  [
    'bedrock',
    classifyBedrockError,
    'bedrock',
    {
      name: 'ResourceNotFoundException',
      message: 'The provided model identifier is invalid',
      $metadata: { httpStatusCode: 404 },
    },
  ],
]

function toLlmError(classify: Classifier, provider: string, err: unknown): LlmError {
  // Mirrors LlmPortAdapter.handleProviderError construction.
  const c = classify(err)
  return new LlmError(
    c.message,
    provider,
    c.code,
    c.retryable,
    err as Error,
    c.httpStatus,
    c.providerCode
  )
}

describe('404 → ModelNotAvailable: does NOT trigger cross-provider failover', () => {
  it.each(CASES)('%s', async (_label, classify, _provider, err404) => {
    // Sanity: the real classifier produces the ambiguous, non-retryable class.
    expect(classify(err404).code).toBe(LlmErrorCode.ModelNotAvailable)
    expect(classify(err404).retryable).toBe(false)

    const engine = new FailoverEngine(policy())
    const fallbackRun = vi.fn()
    const run = engine.run(
      PRIMARY,
      target =>
        target.kind === 'primary'
          ? () => Promise.reject(err404)
          : () => {
              fallbackRun()
              return Promise.resolve('fallback-served')
            },
      classify
    )

    // Propagates the original error — never masked by a fallback.
    await expect(run).rejects.toBe(err404)
    // The observable proof of "no silent failover": the fallback never ran.
    expect(fallbackRun).not.toHaveBeenCalled()
  })
})

describe('404 → ModelNotAvailable: is NOT retried by the tool-use loop', () => {
  it.each(CASES)('%s', async (_label, classify, provider, err404) => {
    const reasoning = createMockReasoning([
      { type: 'error', error: toLlmError(classify, provider, err404) },
    ])

    const result = await runToolUseLoop(buildTestConfig(reasoning, []), [
      { role: 'user', content: 'hi' },
    ])

    expect(result.type).toBe('error')
    if (result.type === 'error') {
      expect((result.error as LlmError).code).toBe(LlmErrorCode.ModelNotAvailable)
    }
    // A retryable transport error would call respondWithTools twice; a
    // non-retryable ModelNotAvailable must be surfaced after a single call.
    expect(reasoning.respondWithTools).toHaveBeenCalledTimes(1)
  })
})
