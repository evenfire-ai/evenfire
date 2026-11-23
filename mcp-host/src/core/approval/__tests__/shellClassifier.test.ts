import { afterEach, describe, expect, it, vi } from 'vitest'
import { openaiApiError } from '../../../llm/__tests__/sdkErrorFixtures'
import {
  clerumPromptCacheInputTokens,
  clerumPromptCacheReadTokens,
  clerumPromptCacheWriteTokens,
} from '../../../llm/promptCacheMetrics'
import type { SingleTurnProvider } from '../../../llm/types'
import { logger } from '../../../logger'
import { buildLlmUsageEvent } from '../../../usage/buildLlmUsageEvent'
import type { UsageReporter } from '../../../usage/usageReporter'
import { ConversationManager } from '../../conversation/conversation'
import { type ChatMessage, ConversationState, FinishReason, type UsageContext } from '../../types'
import { approvalLogId } from '../grantMemory'
import {
  type ShellVerdict,
  classifierAvailable,
  classifierServingPair,
  classifyToolCall,
  configuredShellClassifierModel,
  shellClassifierCallOptions,
} from '../shellClassifier'

const SENDER = 'sender-sentinel@example.test'
const THREAD = 'thread-sentinel@example.test'
const COMMAND = 'command-sentinel'
const PARAM = 'parameter-sentinel'
const DESCRIPTION = 'description-sentinel'
const FAKE_CONTENT = 'fake-content-sentinel'
const THROWN = 'thrown-message-sentinel'

const STATIC_CONTEXT = {
  host_ref: 'host-a',
  context_ref: 'context-a' as string | null,
  llm_secret_name: 'secret-a' as string | null,
}

const USAGE_CONTEXT: UsageContext = {
  source_kind: 'desktop',
  traceContext: {
    version: 1,
    runId: '00000000-0000-4000-8000-0000000000aa',
    origin: 'direct_chat',
    correlationRefs: [],
  },
  team_id: 'team-1',
  user_id: 'user-1',
  sender: 'desk-user',
  channel_type: 'rpc',
  recipe_name: null,
  cron_job_id: null,
  task_id: 'task-1',
  iteration: 2,
}

const MODEL_USAGE = {
  input_tokens: 9,
  output_tokens: 1,
  total_tokens: 10,
  cache_read_tokens: 2,
  cache_write_tokens: 3,
}

type Provider = Pick<SingleTurnProvider, 'completeSingleTurn'>
type CallOptions = {
  max_tokens?: number
  temperature?: number
  signal?: AbortSignal
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function modelResponse(content: string) {
  return {
    content,
    usage: MODEL_USAGE,
    finish_reason: FinishReason.Stop,
  }
}

function baseInput(overrides?: {
  toolName?: string
  description?: string
  args?: Record<string, unknown>
  provider?: Provider
  providerType?: string
  modelName?: string
  taskSignal?: AbortSignal
  reporter?: UsageReporter
  context?: UsageContext
  sessionLogId?: string
}) {
  return {
    toolName: overrides?.toolName ?? 'shell_exec',
    description: overrides?.description ?? 'Run a command',
    args: overrides?.args ?? { command: 'ls' },
    provider: overrides?.provider ?? {
      completeSingleTurn: async () => modelResponse('APPROVE'),
    },
    providerType: overrides?.providerType ?? 'claude',
    modelName: overrides?.modelName ?? 'claude-sonnet',
    taskSignal: overrides?.taskSignal ?? new AbortController().signal,
    usage: overrides?.reporter
      ? {
          reporter: overrides.reporter,
          context: overrides.context ?? USAGE_CONTEXT,
          staticContext: STATIC_CONTEXT,
        }
      : undefined,
    sessionLogId: overrides?.sessionLogId ?? 'session-log-id',
  }
}

async function run(behavior: { content: string } | (() => never)): Promise<ShellVerdict> {
  const provider: Provider = {
    completeSingleTurn: async () => {
      if (typeof behavior === 'function') behavior()
      return modelResponse(typeof behavior === 'function' ? '' : behavior.content)
    },
  }
  return classifyToolCall(baseInput({ provider }))
}

async function runTimingOut(): Promise<ShellVerdict> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    let aborted = false
    const pending = classifyToolCall(
      baseInput({
        provider: {
          completeSingleTurn: (_messages, options) =>
            new Promise((_resolve, reject) => {
              const signal = options?.signal
              if (!signal) {
                reject(new Error('missing signal'))
                return
              }
              const fail = () => {
                aborted = true
                reject(new DOMException('The operation was aborted', 'AbortError'))
              }
              if (signal.aborted) fail()
              else signal.addEventListener('abort', fail, { once: true })
            }),
        },
      })
    )
    const tooEarly = await Promise.race([
      pending.then(verdict => verdict),
      vi.advanceTimersByTimeAsync(9_999).then(() => 'PENDING' as const),
    ])
    expect(tooEarly).toBe('PENDING')
    await vi.advanceTimersByTimeAsync(1)
    const verdict = await pending
    expect(aborted).toBe(true)
    return verdict
  } finally {
    vi.useRealTimers()
  }
}

async function runWithAbortedTaskSignal(): Promise<ShellVerdict> {
  const task = new AbortController()
  let providerAborted = false
  const verdict = await classifyToolCall(
    baseInput({
      taskSignal: task.signal,
      provider: {
        completeSingleTurn: async (_messages, options) => {
          task.abort()
          await Promise.resolve()
          providerAborted = options?.signal?.aborted === true
          return modelResponse('APPROVE')
        },
      },
    })
  )
  expect(providerAborted).toBe(true)
  return verdict
}

function userText(messages: ChatMessage[]): string {
  return messages.find(message => message.role === 'user')?.content ?? ''
}

function systemText(messages: ChatMessage[]): string {
  return messages.find(message => message.role === 'system')?.content ?? ''
}

/** Delimiter that wraps the argument JSON on its own lines. */
function delimiterWrapping(content: string, json: string): string {
  const marker = `\n${json}\n`
  const at = content.indexOf(marker)
  expect(at).toBeGreaterThan(0)
  const before = content.slice(0, at)
  const id = before.slice(before.lastIndexOf('\n') + 1)
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(content.slice(at + marker.length).startsWith(id)).toBe(true)
  return id
}

async function histogramCounts(): Promise<[number, number, number]> {
  const count = async (
    histogram: {
      get(): Promise<{ values: Array<{ metricName?: string; value: number }> }>
    },
    name: string
  ) => (await histogram.get()).values.find(value => value.metricName === name)?.value ?? 0
  return [
    await count(clerumPromptCacheInputTokens, 'clerum_prompt_cache_input_tokens_count'),
    await count(clerumPromptCacheReadTokens, 'clerum_prompt_cache_read_tokens_count'),
    await count(clerumPromptCacheWriteTokens, 'clerum_prompt_cache_creation_tokens_count'),
  ]
}

describe('configuredShellClassifierModel', () => {
  it('uses gpt-5.5 when the Host sets nothing or a blank string', () => {
    expect(configuredShellClassifierModel(undefined)).toBe('gpt-5.5')
    expect(configuredShellClassifierModel(null)).toBe('gpt-5.5')
    expect(configuredShellClassifierModel('')).toBe('gpt-5.5')
    expect(configuredShellClassifierModel('   ')).toBe('gpt-5.5')
    expect(configuredShellClassifierModel(12)).toBe('gpt-5.5')
  })

  it('keeps a configured model name', () => {
    expect(configuredShellClassifierModel(' gpt-4.1-mini ')).toBe('gpt-4.1-mini')
  })
})

describe('classifierServingPair', () => {
  it('uses the Host primary when failover is not serving a fallback', () => {
    expect(
      classifierServingPair({
        primaryProvider: 'openai',
        primaryModel: 'gpt-4o',
        served: { provider: 'openai', model: 'gpt-4o', fallback: false },
      })
    ).toEqual({ providerType: 'openai', modelName: 'gpt-4o' })
    expect(
      classifierServingPair({
        primaryProvider: 'openai',
        primaryModel: 'gpt-4o',
        served: null,
      })
    ).toEqual({ providerType: 'openai', modelName: 'gpt-4o' })
  })

  it('uses the fallback pair when failover is serving it', () => {
    expect(
      classifierServingPair({
        primaryProvider: 'openai',
        primaryModel: 'gpt-4o',
        served: { provider: 'azure', model: 'my-deployment', fallback: true },
      })
    ).toEqual({ providerType: 'azure', modelName: 'my-deployment' })
    expect(classifierAvailable('azure', 'my-deployment', {})).toBe(false)
  })
})

describe('shell classifier', () => {
  it('maps model text, a throw, a 10s timeout and a task abort', async () => {
    for (const c of [' APPROVE ', 'approve', 'APPROVE'])
      expect(await run({ content: c })).toBe('APPROVE')
    for (const c of ['APPROVED', 'APPROVE.', 'APPROVE ESCALATE', ''])
      expect(await run({ content: c })).toBe('ESCALATE')
    expect(
      await run(() => {
        throw new Error('boom')
      })
    ).toBe('ESCALATE')
    expect(await runTimingOut()).toBe('ESCALATE') // fake timers, 10_000 ms
    expect(await runWithAbortedTaskSignal()).toBe('CANCELLED')
  })

  it('logs one warn line for a provider error with its class and status, and no content', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const providerError = openaiApiError(404, {
      code: 'model_not_found',
      message: THROWN,
      type: 'invalid_request_error',
    })
    let called = 0

    const verdict = await classifyToolCall(
      baseInput({
        description: DESCRIPTION,
        args: { command: COMMAND, parameters: PARAM },
        providerType: 'openai',
        modelName: 'gpt-5.5',
        provider: {
          completeSingleTurn: async () => {
            called += 1
            throw providerError
          },
        },
      })
    )

    expect(verdict).toBe('ESCALATE')
    expect(called).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields).toEqual({
      event: 'shell_classifier_failed',
      session: 'session-log-id',
      providerType: 'openai',
      modelName: 'gpt-5.5',
      errorClass: 'NotFoundError',
      httpStatus: 404,
      reason: 'error',
    })
    const line = JSON.stringify([fields, message])
    for (const secret of [COMMAND, PARAM, DESCRIPTION, THROWN, 'model_not_found']) {
      expect(line).not.toContain(secret)
    }
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('logs a timeout as reason timeout and a task abort not at all', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)

    expect(await runTimingOut()).toBe('ESCALATE')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'shell_classifier_failed',
      session: 'session-log-id',
      providerType: 'claude',
      modelName: 'claude-sonnet',
      errorClass: 'DOMException',
      reason: 'timeout',
    })

    warn.mockClear()
    const task = new AbortController()
    let called = 0
    const cancelled = await classifyToolCall(
      baseInput({
        taskSignal: task.signal,
        provider: {
          completeSingleTurn: async () => {
            called += 1
            task.abort()
            throw new DOMException('The operation was aborted', 'AbortError')
          },
        },
      })
    )
    expect(cancelled).toBe('CANCELLED')
    expect(called).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('escalates and warns as a timeout when the reply arrives after the 10s timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    let resolvedAfterAbort = false

    const pending = classifyToolCall(
      baseInput({
        description: DESCRIPTION,
        args: { command: COMMAND, parameters: PARAM },
        provider: {
          // Resolves, does not reject, once the timeout aborts its signal.
          completeSingleTurn: (_messages, options) =>
            new Promise(resolve => {
              options?.signal?.addEventListener(
                'abort',
                () => {
                  resolvedAfterAbort = true
                  resolve(modelResponse('APPROVE'))
                },
                { once: true }
              )
            }),
        },
      })
    )
    await vi.advanceTimersByTimeAsync(10_000)
    const verdict = await pending

    expect(resolvedAfterAbort).toBe(true)
    expect(verdict).toBe('ESCALATE')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields).toEqual({
      event: 'shell_classifier_failed',
      session: 'session-log-id',
      providerType: 'claude',
      modelName: 'claude-sonnet',
      errorClass: 'DOMException',
      reason: 'timeout',
    })
    const line = JSON.stringify([fields, message])
    for (const secret of [COMMAND, PARAM, DESCRIPTION, 'APPROVE', 'You review one shell command']) {
      expect(line).not.toContain(secret)
    }
  })

  it('logs a throw before the provider call once, as an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const completeSingleTurn = vi.fn(async () => modelResponse('APPROVE'))
    // A signal without addEventListener makes judge throw before its call.
    const brokenSignal = { aborted: false } as AbortSignal

    const verdict = await classifyToolCall(
      baseInput({ taskSignal: brokenSignal, provider: { completeSingleTurn } })
    )

    expect(verdict).toBe('ESCALATE')
    expect(completeSingleTurn).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'shell_classifier_failed',
      session: 'session-log-id',
      providerType: 'claude',
      modelName: 'claude-sonnet',
      errorClass: 'TypeError',
      reason: 'error',
    })
  })

  it('applies the provider table and the 8192 character argument limit', () => {
    expect(classifierAvailable('claude', 'any', {})).toBe(true)
    expect(classifierAvailable('bedrock', 'anthropic.claude-x', {})).toBe(true)
    expect(classifierAvailable('bedrock', 'us.anthropic.claude-x', {})).toBe(true)
    expect(
      classifierAvailable(
        'bedrock',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x',
        {}
      )
    ).toBe(false)
    expect(classifierAvailable('openai', 'gpt-5.5', {})).toBe(true)
    expect(classifierAvailable('openai', 'gpt-4o', {})).toBe(false)
    expect(classifierAvailable('openai', 'gpt-4.1', {})).toBe(false)
    expect(classifierAvailable('openai', 'gpt-4.1-mini', {})).toBe(false)
    expect(classifierAvailable('openai', 'gpt-5.4-mini', {})).toBe(false)
    expect(classifierAvailable('openai', 'gpt-5.5-mini', {})).toBe(false)
    expect(classifierAvailable('azure', 'my-deployment', {})).toBe(false)
    for (const provider of [
      'codex-subscription',
      'grok-subscription',
      'xai',
      'vertex',
      'gemini',
      'other',
    ])
      expect(classifierAvailable(provider, 'any', {})).toBe(false)
    const atLimit = { command: 'x'.repeat(8192 - '{"command":""}'.length) }
    const overLimit = { command: atLimit.command + 'x' }
    expect(JSON.stringify(atLimit)).toHaveLength(8192)
    expect(JSON.stringify(overLimit)).toHaveLength(8193)
    expect(classifierAvailable('claude', 'any', atLimit)).toBe(true)
    expect(classifierAvailable('claude', 'any', overLimit)).toBe(false)
  })

  it('asks for 16 tokens with no temperature, a fresh delimiter and no arguments in the system message', async () => {
    const args = { command: COMMAND, parameters: PARAM }
    const json = JSON.stringify(args)
    const seen: Array<{ messages: ChatMessage[]; options?: CallOptions }> = []
    const provider: Provider = {
      completeSingleTurn: async (messages, options) => {
        seen.push({ messages, options })
        return modelResponse('APPROVE')
      },
    }
    await classifyToolCall(baseInput({ provider, args, description: DESCRIPTION }))
    await classifyToolCall(baseInput({ provider, args, description: DESCRIPTION }))

    expect(seen).toHaveLength(2)
    const delimiters = seen.map(call => delimiterWrapping(userText(call.messages), json))
    expect(delimiters[0]).not.toBe(delimiters[1])
    for (const call of seen) {
      expect(call.options?.max_tokens).toBe(16)
      expect(call.options).not.toHaveProperty('temperature')
      expect(call.options).not.toHaveProperty('reasoning_effort')
      const system = systemText(call.messages)
      const user = userText(call.messages)
      expect(system).not.toContain(COMMAND)
      expect(system).not.toContain(PARAM)
      expect(system).not.toContain(json)
      expect(system).not.toContain(DESCRIPTION)
      expect(system).toContain('starts and ends with the same random UUID line')
      expect(system).toContain('asks for approval')
      expect(system).toContain('answer ESCALATE')
      for (const heading of [
        'reads secrets',
        'opens a network connection',
        'installs software',
        'deletes, moves, truncates or overwrites',
        'edits IDENTITY.md',
        'schedules or keeps something running',
        'changes privileges',
        'hides what it does',
      ]) {
        expect(system).toContain(heading)
      }
      expect(user).toContain(COMMAND)
      expect(user).toContain(PARAM)
      expect(user).toContain(DESCRIPTION)
      expect(user).toContain('shell_exec')
    }
    expect(systemText(seen[0].messages)).toBe(systemText(seen[1].messages))
  })

  it('asks an OpenAI reasoning-family model for effort none and leaves other pairs alone', () => {
    const signal = new AbortController().signal
    const reasoning = shellClassifierCallOptions('openai', 'gpt-5.5', signal)
    expect(reasoning.max_tokens).toBe(16)
    expect(reasoning.signal).toBe(signal)
    expect(reasoning.reasoning_effort).toBe('none')

    const established = shellClassifierCallOptions('openai', 'gpt-4o', signal)
    expect(established.max_tokens).toBe(16)
    expect(established.signal).toBe(signal)
    expect(established).not.toHaveProperty('reasoning_effort')

    const claude = shellClassifierCallOptions('claude', 'claude-sonnet', signal)
    expect(claude.max_tokens).toBe(16)
    expect(claude).not.toHaveProperty('reasoning_effort')
  })

  it('calls gpt-5.5 with effort none and does not call other OpenAI models', async () => {
    async function callsFor(model: string) {
      const seen: CallOptions[] = []
      const verdict = await classifyToolCall(
        baseInput({
          providerType: 'openai',
          modelName: model,
          provider: {
            completeSingleTurn: async (_messages, options) => {
              seen.push(options ?? {})
              return modelResponse('APPROVE')
            },
          },
        })
      )
      return { verdict, seen }
    }

    const allowed = await callsFor('gpt-5.5')
    expect(allowed.seen).toHaveLength(1)
    expect(allowed.seen[0]?.max_tokens).toBe(16)
    expect(allowed.seen[0]?.reasoning_effort).toBe('none')
    expect(allowed.verdict).toBe('APPROVE')

    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4-mini']) {
      const refused = await callsFor(model)
      expect(refused.seen).toHaveLength(0)
      expect(refused.verdict).toBe('ESCALATE')
    }
  })

  it('calls the model at the argument limit and skips the call over it', async () => {
    const atLimit = { command: 'x'.repeat(8192 - '{"command":""}'.length) }
    const overLimit = { command: atLimit.command + 'x' }
    let atCalls = 0
    const atVerdict = await classifyToolCall(
      baseInput({
        args: atLimit,
        provider: {
          completeSingleTurn: async () => {
            atCalls += 1
            return modelResponse('APPROVE')
          },
        },
      })
    )
    expect(atCalls).toBe(1)
    expect(atVerdict).toBe('APPROVE')

    let overCalls = 0
    const overVerdict = await classifyToolCall(
      baseInput({
        args: overLimit,
        provider: {
          completeSingleTurn: async () => {
            overCalls += 1
            return modelResponse('APPROVE')
          },
        },
      })
    )
    expect(overCalls).toBe(0)
    expect(overVerdict).toBe('ESCALATE')
  })

  it('enqueues one usage event and leaves session counters unchanged', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate('classifier-usage')
    conversation.state = ConversationState.Processing
    conversation.input_tokens = 41
    conversation.output_tokens = 42
    conversation.cache_read_tokens = 43
    conversation.cache_write_tokens = 44
    conversation.turns.push({
      number: 1,
      user_input: 'hi',
      tool_calls: [],
      started_at: new Date(),
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 7,
      cache_write_tokens: 8,
    })
    const recordSessionUsage = vi.spyOn(ConversationManager.prototype, 'recordSessionUsage')
    const enqueue = vi.fn()
    const reporter = { enqueue } as unknown as UsageReporter
    const before = await histogramCounts()

    const verdict = await classifyToolCall(
      baseInput({
        reporter,
        provider: { completeSingleTurn: async () => modelResponse('APPROVE') },
      })
    )

    expect(verdict).toBe('APPROVE')
    expect(enqueue).toHaveBeenCalledTimes(1)
    const event = enqueue.mock.calls[0][0]
    expect(event).toMatchObject({
      host_ref: STATIC_CONTEXT.host_ref,
      context_ref: STATIC_CONTEXT.context_ref,
      llm_secret_name: STATIC_CONTEXT.llm_secret_name,
      provider: 'claude',
      model: 'claude-sonnet',
      source_kind: 'desktop',
      run_id: USAGE_CONTEXT.traceContext?.runId,
      team_id: 'team-1',
      user_id: 'user-1',
      sender: 'desk-user',
      channel_type: 'rpc',
      recipe_name: null,
      cron_job_id: null,
      task_id: 'task-1',
      iteration: 2,
      input_tokens: 9,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 3,
    })
    expect(event.request_id).toEqual(expect.any(String))
    expect(event.request_id).not.toBe('')
    expect(event.ts).toEqual(expect.any(String))
    expect(conversation.input_tokens).toBe(41)
    expect(conversation.output_tokens).toBe(42)
    expect(conversation.cache_read_tokens).toBe(43)
    expect(conversation.cache_write_tokens).toBe(44)
    expect(conversation.turns[0]).toMatchObject({
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 7,
      cache_write_tokens: 8,
    })
    expect(recordSessionUsage).not.toHaveBeenCalled()
    expect(await histogramCounts()).toEqual(before)

    enqueue.mockClear()
    let codexCalls = 0
    const codexVerdict = await classifyToolCall(
      baseInput({
        reporter,
        providerType: 'codex-subscription',
        modelName: 'any',
        provider: {
          completeSingleTurn: async () => {
            codexCalls += 1
            return modelResponse('APPROVE')
          },
        },
      })
    )
    expect(codexVerdict).toBe('ESCALATE')
    expect(codexCalls).toBe(0)
    expect(enqueue).not.toHaveBeenCalled()
    expect(conversation.input_tokens).toBe(41)
    expect(conversation.output_tokens).toBe(42)
    expect(conversation.cache_read_tokens).toBe(43)
    expect(conversation.cache_write_tokens).toBe(44)
    expect(recordSessionUsage).not.toHaveBeenCalled()
    expect(await histogramCounts()).toEqual(before)

    expect(
      buildLlmUsageEvent({
        requestId: 'request-codex',
        staticContext: STATIC_CONTEXT,
        providerName: 'codex-subscription',
        model: 'any',
        usageContext: USAGE_CONTEXT,
        usage: MODEL_USAGE,
      })
    ).toBeNull()
    const built = buildLlmUsageEvent({
      requestId: 'request-claude',
      staticContext: STATIC_CONTEXT,
      providerName: 'claude',
      model: 'claude-sonnet',
      usageContext: USAGE_CONTEXT,
      usage: MODEL_USAGE,
    })
    expect(built).toMatchObject({
      request_id: 'request-claude',
      provider: 'claude',
      model: 'claude-sonnet',
      input_tokens: 9,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 3,
    })
    expect(conversation.input_tokens).toBe(41)
    expect(recordSessionUsage).not.toHaveBeenCalled()
    expect(await histogramCounts()).toEqual(before)
  })

  it('keeps the verdict and warns with the error class when the usage reporter throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    class ReporterFailure extends Error {}
    const enqueue = vi.fn(() => {
      throw new ReporterFailure(THROWN)
    })
    const reporter = { enqueue } as unknown as UsageReporter

    const verdict = await classifyToolCall(
      baseInput({
        reporter,
        description: DESCRIPTION,
        args: { command: COMMAND, parameters: PARAM },
        provider: { completeSingleTurn: async () => modelResponse('APPROVE') },
      })
    )

    expect(verdict).toBe('APPROVE')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields).toEqual({
      event: 'shell_classifier_usage_failed',
      errorClass: 'ReporterFailure',
    })
    const line = JSON.stringify([fields, message])
    for (const secret of [
      COMMAND,
      PARAM,
      DESCRIPTION,
      THROWN,
      'session-log-id',
      'user-1',
      'task-1',
    ]) {
      expect(line).not.toContain(secret)
    }
  })

  it('logs one L3 line with the normalized verdict and no sensitive text', async () => {
    const manager = new ConversationManager()
    const conversation = await manager.getOrCreate(`${SENDER}:email:INBOX:${THREAD}`, {
      userId: SENDER,
    })
    expect(conversation.id).toContain(SENDER)
    expect(conversation.id).toContain(THREAD)
    expect(conversation.user_id).toBe(SENDER)
    const sessionLogId = approvalLogId(conversation.id)
    expect(sessionLogId).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionLogId).not.toBe(conversation.id)

    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined)
    const raw = ' approve '
    const secrets = [
      SENDER,
      THREAD,
      COMMAND,
      PARAM,
      DESCRIPTION,
      FAKE_CONTENT,
      THROWN,
      raw,
      conversation.id,
      `${SENDER}:email:INBOX:${THREAD}`,
    ]
    try {
      const verdict = await classifyToolCall(
        baseInput({
          description: DESCRIPTION,
          args: { command: COMMAND, parameters: PARAM },
          sessionLogId,
          provider: { completeSingleTurn: async () => modelResponse(raw) },
        })
      )
      expect(verdict).toBe('APPROVE')
      const l3 = info.mock.calls.filter(call => (call[0] as { event?: string }).event === 'L3')
      expect(l3).toHaveLength(1)
      expect(info).toHaveBeenCalledTimes(1)
      const [fields, message] = l3[0] as [Record<string, unknown>, string]
      expect(fields).toMatchObject({
        event: 'L3',
        session: sessionLogId,
        tool: 'shell_exec',
        verdict: 'APPROVE',
      })
      expect(fields.session).toMatch(/^[0-9a-f]{64}$/)
      expect(fields.session).toBe(approvalLogId(conversation.id))
      expect(fields.duration).toEqual(expect.any(Number))
      expect(fields.duration as number).toBeGreaterThanOrEqual(0)
      expect(fields.verdict).toBe('APPROVE')
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()
      const line = JSON.stringify([fields, message])
      expect(line).toContain('APPROVE')
      expect(line).toContain('shell_exec')
      for (const secret of secrets) expect(line).not.toContain(secret)

      info.mockClear()
      expect(
        await classifyToolCall(
          baseInput({
            description: DESCRIPTION,
            args: { command: COMMAND, parameters: PARAM },
            sessionLogId,
            provider: {
              completeSingleTurn: async () => {
                throw new Error(THROWN)
              },
            },
          })
        )
      ).toBe('ESCALATE')
      expect(info).toHaveBeenCalledTimes(1)
      const thrownLine = JSON.stringify(info.mock.calls[0])
      expect((info.mock.calls[0][0] as { verdict?: string }).verdict).toBe('ESCALATE')
      for (const secret of secrets) expect(thrownLine).not.toContain(secret)
      // The throw is also logged once at warn, without its message.
      expect(warn).toHaveBeenCalledTimes(1)
      const warnLine = JSON.stringify(warn.mock.calls[0])
      expect((warn.mock.calls[0][0] as { errorClass?: string }).errorClass).toBe('Error')
      for (const secret of secrets) expect(warnLine).not.toContain(secret)
      warn.mockClear()

      info.mockClear()
      expect(
        await classifyToolCall(
          baseInput({
            description: DESCRIPTION,
            args: { command: COMMAND, parameters: PARAM },
            sessionLogId,
            provider: { completeSingleTurn: async () => modelResponse(FAKE_CONTENT) },
          })
        )
      ).toBe('ESCALATE')
      expect(info).toHaveBeenCalledTimes(1)
      const fakeLine = JSON.stringify(info.mock.calls[0])
      expect((info.mock.calls[0][0] as { verdict?: string }).verdict).toBe('ESCALATE')
      for (const secret of secrets) expect(fakeLine).not.toContain(secret)
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(debug).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      warn.mockRestore()
      error.mockRestore()
      debug.mockRestore()
    }
  })
})
