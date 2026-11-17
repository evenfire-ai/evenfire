/**
 * The agent's provider failover over the official OpenAI endpoint
 * (Responses). The task executor's own failover wiring builds every fallback
 * through the real factory; only each driver's `responses.create` is doubled.
 * The real tool loop runs over the wrapped port, so retries, failover and the
 * replayed continuity are observed where they happen.
 */
import { describe, expect, it, vi } from 'vitest'
import { config as appConfig } from '../../config'
import { LlmPortAdapter } from '../../core/adapters/llmPortAdapter'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { ConversationManager } from '../../core/conversation/conversation'
import { LlmError, LlmErrorCode } from '../../core/errors'
import type { LlmPort } from '../../core/interfaces'
import { runLoop } from '../../core/orchestration/__tests__/loopHistory'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { createTokenCounter } from '../../core/tokenizer'
import { TaskLifecycle } from '../../lifecycle/taskLifecycle'
import { openaiApiError } from '../../llm/__tests__/sdkErrorFixtures'
import { ALL_FAILOVER_CLASSES } from '../../llm/failover/classify'
import { FailoverEngine } from '../../llm/failover/engine'
import type { FailoverSwitchEvent, LlmPolicy } from '../../llm/failover/types'
import {
  RESPONSES_MODEL,
  type RecordedItem,
  type RecordedResponse,
  recordedResponse,
} from '../../llm/openaiFamily/__tests__/responsesFixtures'
import { makeProvider } from '../../llm/registry'
import type { SingleTurnProvider } from '../../llm/types'
import type { Task } from '../../queue/types'
import { TaskExecutor } from '../taskExecutor'

type Answer = () => Promise<unknown>
const PAIR = { provider: 'openai', model: RESPONSES_MODEL }

/** An official driver built by the real factory, answering from its own queue. */
function officialDriver(apiKey: string, answers: Answer[]) {
  const driver = makeProvider('openai', { 'openai-api-key': apiKey }, RESPONSES_MODEL)
  const create = vi.fn(async (_payload: { input: RecordedItem[] }) => {
    const next = answers.shift()
    if (!next) throw new Error(`no more answers for ${apiKey}`)
    return next()
  })
  ;(driver as unknown as { client: unknown }).client = {
    baseURL: 'https://api.openai.com/v1',
    responses: { create },
    chat: { completions: { create: vi.fn() } },
  }
  return { driver, create }
}

const recorded =
  (name: string): Answer =>
  async () =>
    recordedResponse(name)

/** DEC-13: a recorded response with only `status` and `error` changed. */
function failed(code: string): Answer {
  return async () => {
    const raw = structuredClone(recordedResponse('v1-text-gpt-6.1-terra')) as RecordedResponse & {
      status: string
      error: unknown
    }
    raw.status = 'failed'
    raw.error = { code, message: 'The response failed.' }
    return raw
  }
}

const rateLimited: Answer = async () => {
  throw openaiApiError(429, {
    code: 'rate_limit_exceeded',
    type: 'requests',
    message: 'Rate limit reached.',
  })
}

/**
 * The primary port the executor builds per task, wrapped by the executor's
 * failover wiring with a same-provider fallback (another key) built per
 * attempt by `buildProvider`.
 */
function agentPort(primary: SingleTurnProvider, fallback: SingleTurnProvider) {
  const switches: FailoverSwitchEvent[] = []
  const policy: LlmPolicy = {
    cooldownSeconds: 300,
    triggerOn: [...ALL_FAILOVER_CLASSES],
    fallbacks: [{ provider: 'openai', model: 'gpt-4.1' }],
  }
  const engine = new FailoverEngine(policy, {
    metricInc: () => {},
    onSwitch: event => switches.push(event),
  })
  const buildProvider = vi.fn((_entry: { provider: string; model: string }) => fallback)
  const task: Task = {
    id: 'responses-failover-task',
    source: 'channel',
    status: 'pending',
    priority: 'normal',
    createdAt: new Date(),
    responseCallback: vi.fn(async () => {}),
    sourceMessage: {
      sender: 'unit-user',
      content: 'Which city, and its weather?',
      channelType: 'rpc',
      channelId: 'unit-channel',
      messageId: 'unit-message',
      hostRef: 'unit-host',
      timestamp: new Date().toISOString(),
    },
    conversationHistory: [],
  }
  const conversationManager = new ConversationManager()
  const executor = new TaskExecutor(task, {
    conversationManager,
    llmProvider: primary,
    modelName: RESPONSES_MODEL,
    mcpManager: null,
    workspaceService: undefined,
    approvalConfig: undefined,
    config: {
      maxTaskDuration: 300_000,
      maxToolCallsPerTask: 10,
      autoStart: true,
      taskDelay: 0,
      approvalTimeout: 300_000,
    },
    coreEvents: new SimpleEventEmitter(),
    cronScheduler: null,
    taskLifecycle: new TaskLifecycle(),
    onApprovalNeeded: vi.fn(),
    onComplete: vi.fn(),
    onFail: vi.fn(),
    failover: { engine, policy, buildProvider },
  })
  const primaryPort = new LlmPortAdapter(
    primary,
    RESPONSES_MODEL,
    'openai',
    undefined,
    undefined,
    undefined,
    createTokenCounter(primary, RESPONSES_MODEL, { offline: appConfig.tokenizerOffline })
  )
  const port = (
    executor as unknown as {
      wrapFailoverPort: (port: LlmPortAdapter, conversation: unknown) => LlmPort
    }
  ).wrapFailoverPort(primaryPort, makeFakeConversation())
  return { port, engine, switches, buildProvider }
}

async function loopError(port: LlmPort): Promise<LlmError> {
  const result = await runLoop(port)
  expect(result.type).toBe('error')
  const error = (result as { type: 'error'; error: Error }).error
  expect(error).toBeInstanceOf(LlmError)
  return error as LlmError
}

describe('T-E4 agent: a failed 2xx is not retried, failed over or cooled down', () => {
  it('one SDK call, the fallback is never called, and the primary stays first', async () => {
    const primary = officialDriver('sk-primary', [failed('invalid_prompt')])
    const fallback = officialDriver('sk-other', [recorded('v1-text-gpt-4.1')])
    const { port, engine, switches } = agentPort(primary.driver, fallback.driver)

    const error = await loopError(port)

    expect(primary.create).toHaveBeenCalledTimes(1)
    expect(fallback.create).not.toHaveBeenCalled()
    expect(switches).toEqual([])
    expect(engine.planTargets(PAIR)[0]).toMatchObject({ kind: 'primary' })
    expect(error).toMatchObject({
      code: LlmErrorCode.InvalidResponse,
      retryable: false,
      providerCode: 'invalid_prompt',
    })
  })
})

describe('T-E4c agent: transient failed codes behave like their HTTP status', () => {
  it('server_error on primary and fallback: exactly two SDK calls and ModelOverloaded reaches the loop', async () => {
    const primary = officialDriver('sk-primary', [failed('server_error')])
    const fallback = officialDriver('sk-other', [failed('server_error')])
    const { port, switches } = agentPort(primary.driver, fallback.driver)

    const error = await loopError(port)

    expect(primary.create).toHaveBeenCalledTimes(1)
    expect(fallback.create).toHaveBeenCalledTimes(1)
    expect(switches.map(s => s.reason)).toEqual(['provider_unavailable'])
    expect(error).toMatchObject({
      code: LlmErrorCode.ModelOverloaded,
      retryable: true,
      providerCode: 'server_error',
    })
  })

  it('rate_limit_exceeded on the primary switches to a responding fallback as rate_limited', async () => {
    const primary = officialDriver('sk-primary', [failed('rate_limit_exceeded')])
    const fallback = officialDriver('sk-other', [recorded('v1-text-gpt-4.1')])
    const { port, switches } = agentPort(primary.driver, fallback.driver)

    const result = await runLoop(port)

    expect(primary.create).toHaveBeenCalledTimes(1)
    expect(fallback.create).toHaveBeenCalledTimes(1)
    expect(switches.map(s => s.reason)).toEqual(['rate_limited'])
    expect(result.type).toBe('response')
  })
})

describe('T-C9 a same-provider fallback with another key never receives the continuity', () => {
  it('the request to the fallback carries no reasoning items and no item ids', async () => {
    const primary = officialDriver('sk-primary', [recorded('v1-rfc-gpt-6.1-terra'), rateLimited])
    const fallback = officialDriver('sk-other', [recorded('v1-text-gpt-6.1-terra')])
    const { port, buildProvider, switches } = agentPort(primary.driver, fallback.driver)

    const result = await runLoop(port)

    expect(result.type).toBe('response')
    // The executor built the fallback with the session model (same provider).
    expect(buildProvider).toHaveBeenCalledWith({ provider: 'openai', model: RESPONSES_MODEL })
    expect(switches.map(s => s.reason)).toEqual(['rate_limited'])
    expect(primary.create).toHaveBeenCalledTimes(2)
    expect(fallback.create).toHaveBeenCalledTimes(1)
    // Control: the same history did carry the continuity to the primary that made it.
    const toPrimary = primary.create.mock.calls[1]![0].input
    expect(toPrimary.some(item => item.type === 'reasoning')).toBe(true)

    const toFallback = fallback.create.mock.calls[0]![0].input
    expect(toFallback.some(item => item.type === 'reasoning')).toBe(false)
    expect(toFallback.some(item => item.id !== undefined)).toBe(false)
    expect(JSON.stringify(toFallback)).not.toMatch(/"fc_|"rs_/)
    expect(toFallback.filter(item => item.type === 'function_call')).toEqual([
      expect.objectContaining({ call_id: 'call_fixture0005', name: 'get_weather' }),
    ])
  })
})
